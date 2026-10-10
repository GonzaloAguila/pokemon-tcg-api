# CLAUDE.md — pokemon-tcg-api

Backend for **Nostalgic TCG** (browser Pokémon TCG, Base Set + Jungle; Fossil / Team Rocket in progress on `feature/fossil-team-rocket`). Express + Socket.io + Prisma/PostgreSQL. Serves REST for accounts/economy/collection and runs authoritative multiplayer games and drafts over Socket.io.

## Related repos (all siblings under `D:/Proyectos/`)

| Repo | Role |
|------|------|
| `pokemon-tcg-game-core` | Game engine, consumed from GitHub Packages at an **exact** version. The frontend must pin the same version so single-player and multiplayer run identical rules. Auth: repo `.npmrc` only sets the `@gonzaloaguila` registry; the token lives in each machine's `~/.npmrc` (`//npm.pkg.github.com/:_authToken=...`). |
| `pokemon-tcg` | Next.js frontend (Vercel). Talks to this API via `NEXT_PUBLIC_API_URL`. Holds the cross-repo orchestration notes and the VPS deploy skill (`.claude/skills/api-deploy/`). |
| `pokemon-tcg-landing` | Astro landing; only uses `POST /api/waitlist`. |

Change order when work spans repos: game-core (build, bump, publish) → API and frontend (bump to the same exact version).

## Commands

```bash
npm run dev          # tsx watch; PORT from .env (5001 on the dev machine, 3001 in prod/.env.example)
npm run build        # tsc → dist/
npx tsc --noEmit     # type check (the only working static check today)
npm run db:push      # apply prisma/schema.prisma to a throwaway DB (prod still uses db push until the baseline is adopted, see docs/migrations.md)
npm run db:migrate   # prisma migrate dev: new migration from schema edits (local ptcg-dev-db only)
npm run db:generate  # regenerate Prisma client after schema edits
SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... npx tsx prisma/seed.ts   # create/promote superadmin
npm test             # vitest integration suite (needs the ptcg-test-db container, see test/README.md)
```

`npm run lint` is declared but doesn't work (eslint isn't installed/configured). CI (`.github/workflows/ci.yml`) runs `npm ci`, `prisma generate`, `tsc --noEmit` and `build`; it needs the `NPM_TOKEN` repo secret.

**Local database:** local dev uses the Docker container `ptcg-dev-db` (`postgresql://ptcg:ptcg@127.0.0.1:55433/pokemontcg_dev`). Never point local `.env` at production — prod Postgres only listens on localhost on the VPS.

## Layout

- `src/index.ts` — Express app, router registration, Socket.io server, chat cleanup interval.
- `src/modules/<feature>/` — `*.controller.ts` (Router) + `*.service.ts` (+ `*.types.ts`, `index.ts` barrel). Modules: achievements, admin, auth (local + Google + Discord OAuth), battle-pass, boosters, bug-report, catalog, chat, decks, market, messaging, users (+ rewards), waitlist, wheel. `game/` and `matchmaking/` are empty.
- `src/socket/` — `handlers.ts` (socket auth + event wiring), `rooms.ts` (`GameRoomManager`, in-memory games, `executeAction` switch), `draft-handlers.ts` / `draft-rooms.ts`, `state-masking.ts` (perspective swap for player 2, hidden zones, `REVEAL_RULES`), `schemas.ts` (zod schemas for every socket payload and game action), `session-guard.ts` (handshake auth + per-event account check), `io-registry.ts` (Socket.io server handle for HTTP code, e.g. kicking banned users).
- `src/middleware/` — `auth.ts` (`requireAuth`, `requireRole`, `requirePermission`, `optionalAuth`, `checkUserStatus`), `error-handler.ts` (`AppError`, `Errors.*`), `rate-limit.ts` (auth routes only).
- `src/lib/` — `prisma.ts`, `jwt.ts`, `oauth.ts`, `password.ts`, `email.ts` (Resend), `account-state.ts` (15s cache of tokenVersion/role/status used by HTTP auth and sockets; admin moderation invalidates it).
- `prisma/schema.prisma` — 22 models. `Match` / `GameRoom` exist but nothing writes to them. `prisma/migrations/` holds a baseline that is NOT yet applied in prod (`docs/migrations.md`); `test/migrations.test.ts` fails if the schema changes without a migration.

## Conventions

- Validate request bodies with zod in the controller; throw `Errors.BadRequest/NotFound/Forbidden/...` (instances of `AppError`) so `errorHandler` maps the status. Plain `Error` objects become 500s.
- Protect routes with `requireAuth` then `requireRole(...)` / `requirePermission(...)`. Superadmin bypasses permission checks.
- Socket identity: always derive the user from the verified handshake JWT via `getAuthUserId(socket)` (`handlers.ts`); never trust a `userId` in the payload. New socket events: parse the payload with a schema from `schemas.ts` (`parsePayload`) and, if it acts on games/rooms/chat/drafts, gate it with `requireSocketUser`/`checkSocketSession` (`session-guard.ts`). New game actions: add them to `gameActionSchema`; `executeAction` rejects anything the schema doesn't know.
- HTTP identity: `requireAuth` checks the token against `account-state` (tokenVersion, ban/suspension, current role). To revoke sessions, bump `tokenVersion` and call `invalidateAccountState(userId)` (+ `disconnectUserSockets`).
- Any balance change must go through `users.service` (`creditBalance`/`debitBalance` or the `addCoins`/`spendCoins`/… wrappers): they do one atomic UPDATE (debits guarded by `balance >= amount`), reject non-positive amounts and log a `Transaction` row with its `currency`. Pass the transaction client (`db`/`tx` arg) so a purchase charges and grants in ONE `prisma.$transaction`. One-time claims use conditional `updateMany` (e.g. `unlockedAt: null`) and check `count`.
- Prize games (wheel, slots) roll and grant server-side (`src/modules/prizes/`, CSPRNG); never accept a prize or outcome from the client.
- User-facing strings (errors, event log messages) are Spanish; code and comments English.
- Card IDs: `{set-slug}-{3-digit-number}-{slug-name}`, e.g. `base-set-025-pikachu`, `jungle-002-electrode` (`Nidoran♀` → `nidoranf`, `Mr. Mime` → `mr-mime`).
- Card sets come from game-core's registry: `CARD_SETS`, `ALL_CARDS`, `findCardById`, `findCardDefinition(set, number)`, `getSetById`. Never write `[...baseSetCards, ...jungleCards]`. Catalog sets, draft pools and market/prize pools follow the registry automatically; a set's booster is one entry in `SET_BOOSTERS` (`boosters.service.ts`; prizes/battle pass pick from `STANDARD_BOOSTER_IDS`).

## Multiplayer model

- Game and draft rooms live in memory (Maps). A restart/PM2 reload drops every live game; reconnection only works within the same process. Single process only (no Redis adapter).
- Server keeps state from player 1's perspective; player 2's actions run on a game-core `swapSides` copy that is swapped back (`executeForPlayer` / `toActor` in `executeAction`), and `getGameStateForPlayer` (state-masking) uses the same `swapSides` plus "Jugador 1/2" swapped in the log. Pending choices (`pendingForceSwitch`, `pendingSelfSwitch`, `pendingDeckSearch`, `pendingBenchDamageSelection`, `pendingTypeShift`, `pendingPeek`) are NOT swapped: they belong to the side whose turn it is (engine convention), only that side may resolve them (turn gate in `executeAction`), and masking strips them for the other player and spectators.
- Every emitted state goes through `maskGameStateForPlayer(state, "player1" | "player2" | "spectator")`, which hides the opponent's hand/deck/prizes (same-length `{ id, hidden: true }` placeholders) unless a `REVEAL_RULES` entry shows them (hook for Clairvoyance / face-up prizes; rules must ask game-core, never re-implement the card). Never emit `room.gameState` raw.
- Rules live in game-core; `rooms.ts` only dispatches. Board actions: `playBasicPokemon` (`playBasicToActive` / `playBasicToBench { cardId }`), `attachEnergyCard` (`attachEnergy { cardId, pokemonId }`, Rain Dance included), `evolvePokemonCard` (`evolve { cardId, targetPokemonId }`, legacy `targetIndex` still accepted). Trainers: `playTrainerCard` (`playTrainer { cardId, selections }`); activated powers: `usePokemonPower` (`usePower { pokemonId, selections }`). `selections: string[][]` answers the steps of `getTrainerSteps` / `getPowerSteps`; zod only bounds the shape, the engine checks every answer. Illegal moves throw `IllegalActionError`; `executeAction` returns `{ success: false, error: reason }` (Spanish) and leaves the stored state untouched. Check `canX` first when the error must not be thrown (e.g. before rolling coins).
- Coins are rolled server-side (`GameRoomManager`'s coin source: `crypto.randomInt` by default, injectable in tests via `new GameRoomManager(flipCoin)`). Attack and confusion coins go to the room via `showCoinFlip` (`{ attackName, results, count }`). Trainer/power coins (`getTrainerCoinFlips` / `getPowerCoinFlips`: Poké Ball, Heal) are requested BEFORE the steps with `requestCoinFlip { roomId, purpose: "trainer", cardId } | { roomId, purpose: "power", pokemonId }` (ack `{ success, results, result }`), stored in `room.effectCoins` until the effect resolves (Trainer: per card instance, power: per turn) so they can't be re-rolled, then sent to the opponent/spectators as `showCoinFlip`. A client coin value is always ignored.
- Attacks: `canExecuteAttack` / `canExecuteMetronome` are checked BEFORE any coin (confusion included); then the server rolls exactly `getAttackCoinFlipCount(state, attackIndex | copiedAttack)` coins (Sand-attack's coin first) and calls `executeAttack(state, i, { coinResults, skipDefenderPromotion: true })` / `executeMetronome(state, copiedAttack, { … })`; the engine resolves every coin effect, KOs and the end of the turn. Never add coin-effect logic to `rooms.ts`. After a KO the defender promotes (`promote` then calls `endTurn` for the attacker); the attacker's `takePrize` ends the turn once both actives are back. Metronome is only accepted on an attack with a `CopyAttack` effect.
- Confusion is resolved in the `attack` action: server flips, `resolveConfusionFlip` (game-core) applies tails.
- The starting player draws on turn 1 inside game-core's `startPlayingPhase` (`playerReady` when both are ready); the API draws nothing itself.
- Decks used in rooms must pass `checkDeckPlayable` (owned by the player, rules + collection ownership; basic energy is unlimited).
- Conversion 1/2 (Porygon) is still resolved in `rooms.ts` (only with the attack that has `ChangeWeakness` / `ChangeResistance`, non-Colorless type). Prefer moving logic into game-core over adding more here.

## Environment

See `.env.example`. Also used: `COOKIE_DOMAIN` (prod: `.nostalgic-tcg.online`, needed so Chrome sends the refresh cookie across subdomains). `CORS_ORIGIN` is comma-separated and must include the frontend and landing origins. `JWT_SECRET` is required in production (falls back to a dev secret otherwise).

## Deploy

Production: Hostinger VPS, `api.nostalgic-tcg.online`, Nginx (TLS via Certbot) → `127.0.0.1:3001`, PM2 process `pokemon-tcg-api`, Postgres on the same box. Code at `/var/www/pokemon-tcg-api`. The VPS installs game-core from GitHub Packages, so root's `~/.npmrc` needs a valid token. Claude has no SSH access; give the user commands to run. Full pipeline: frontend repo `.claude/skills/api-deploy/SKILL.md`.

## Admin data fixes

For one-off grants (cards, currency) write a temporary `npx tsx` Prisma script, run it **on the VPS** from `/var/www/pokemon-tcg-api` (prod Postgres is localhost-only), then delete it. Prefer the atomic balance helpers so a Transaction row is logged. `userCard.upsert` with `update: { quantity }` *sets* the value; use `{ increment: n }` to add.

## Known issues (as of 2026-10 review — verify before assuming fixed)

Fixed on 2026-10-10 (branch hardening/socket-validation, not deployed yet): zod validation for every socket event, draft event and `executeAction` action type (invalid payloads return errors instead of throwing); per-event account check on sockets (deleted/banned/suspended users are rejected and disconnected; admin ban/suspend/delete kick them at once; token expiry alone doesn't kick); HTTP access tokens honor `tokenVersion`, status and the DB role; admin endpoint bodies validated with zod; `playTrainer` runs the card actually in hand (a Potion could be played as "Computer Search"); Heal (`usePower healFlip`) checks the source really has an unused Heal; Prisma migrations baseline in the repo.

Fixed on 2026-10-10 (branch feature/fossil-team-rocket, needs the game-core build with engine-owned coin flips; not deployed): attack coin effects resolved by the engine (before: coin damage skipped weakness/resistance/PlusPower/Defender/protection, no KO check on coin damage, Pay Day damaged Meowth, Thick Skinned ignored, Big Eggsplosion flipped 1 coin, attack coins used `Math.random`); P2's PlusPower/Defender ownership swapped; Metronome only on a `CopyAttack` attack.

Fixed earlier on 2026-10-10 (branches security/economy-hardening, security/socket-hardening): room identity (name/avatar/title) from DB + banned/suspended can't create/join, deck ownership check, chat limited to rooms the socket is in + flood limit; atomic economy + market validation, server-side wheel/slots, hidden-information masking, OAuth verified-email + state, draft socket identity, pending-choice turn checks, permissions route removal, trust proxy + rate limits, seed password from env. Prod infra: Postgres no longer public, DB password rotated, ufw allows only 22/80/443.

Fixed on 2026-10-10 (branch feature/fossil-team-rocket, needs the Stage A game-core build; not deployed): attack legality (`canExecuteAttack` before any coin), Sand-attack enforced, board actions / Trainers / powers through game-core (the per-name `switch`es, the `canPlayTrainer` name gap and the trusted Heal source are gone), pending choices stripped for the non-owner (Peek leaked the peeked card), player 2's starting player swapped, set registry everywhere, trainer/power coins can't be re-rolled by alternating requests.

Still open:
- Own deck order and prizes are sent to their owner (search UIs read `playerDeck`).
- Effect steps with `chooser: "opponent"` ("he or she chooses", none in Base Set / Jungle) have no socket flow yet: they will need a pending state answered by the other player.
- Deck saves don't reject cards the user doesn't own: the deck is saved with `isValid: false` and `checkDeckPlayable` blocks it from rooms.
- Bets aren't validated against the creator's title tier on the server (schema caps `betAmount` at 1000; it's never charged anyway). `attack.selectedEnergyIds` is accepted but ignored: the engine auto-picks the energy to discard, so the player’s choice isn’t honored in multiplayer. Don’t just pass it to `executeAttack`, which discards whatever ids it gets without checking count/type (a client could under-pay). Validate it in game-core first.
- Discord/Google accounts with the same email both log into one account (by design, verified emails only).
- Migrations baseline exists in the repo but prod still runs `db push` until someone follows `docs/migrations.md` (prod has `_prisma_migrations` with `0001_init` and an untracked `prisma/migrations/` on the VPS). `Match` never persisted, `betAmount` never charged, `console.*` logging only.
- `test/prize-games.test.ts` "never overspends under concurrency" is flaky: a spin can win coins that pay for a second concurrent spin (test assumption, not an overspend).
- Daily free wheel/slot spin endpoints (`/users/me/claim-wheel-spin`, `claim-slot-spin`) only stamp a date; not wired to `freeWheelSpins` or the UI.
