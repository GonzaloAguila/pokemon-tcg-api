# CLAUDE.md — pokemon-tcg-api

Backend for **Nostalgic TCG** (browser Pokémon TCG, Base Set + Jungle). Express + Socket.io + Prisma/PostgreSQL. Serves REST for accounts/economy/collection and runs authoritative multiplayer games and drafts over Socket.io.

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
- `src/socket/` — `handlers.ts` (socket auth + event wiring), `rooms.ts` (`GameRoomManager`, in-memory games, `executeAction` switch), `draft-handlers.ts` / `draft-rooms.ts`, `state-masking.ts` (perspective swap for player 2), `schemas.ts` (zod schemas for every socket payload and game action), `session-guard.ts` (handshake auth + per-event account check), `io-registry.ts` (Socket.io server handle for HTTP code, e.g. kicking banned users).
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

## Multiplayer model

- Game and draft rooms live in memory (Maps). A restart/PM2 reload drops every live game; reconnection only works within the same process. Single process only (no Redis adapter).
- Server keeps state from player 1's perspective; player 2's actions run on a swapped copy and are swapped back. There are two swap implementations (`swapPerspective` in `rooms.ts` for running the engine, `getGameStateForPlayer` in `state-masking.ts` for emitting) and they differ: both swap zones, prize/promotion flags, turn, `gameResult` and `activeModifiers[].playerId` (PlusPower/Defender owner); only the emitting one swaps `startingPlayer` and event names; neither swaps the pending flags.
- Every emitted state goes through `maskGameStateForPlayer(state, "player1" | "player2" | "spectator")`, which hides the opponent's hand/deck/prizes (same-length `{ id, hidden: true }` placeholders). Never emit `room.gameState` raw.
- Coin flips are rolled server-side (`GameRoomManager`'s coin source: `crypto.randomInt` by default, injectable in tests via `new GameRoomManager(flipCoin)`) and sent via `showCoinFlip` (`{ attackName, results, count }`); the client animates predetermined results. Coins the client must show BEFORE acting (Poké Ball, Heal) come from `requestCoinFlip` (ack); the action consumes the stored result and ignores any client `coinResult`. Same-turn repeat requests return the same result (no re-rolls).
- Attack coins are engine-owned: the `attack` action rolls exactly `getAttackCoinFlipCount(state, attackIndex | copiedAttack)` coins and calls `executeAttack(state, i, { coinResults, skipDefenderPromotion: true })` / `executeMetronome(state, copiedAttack, { … })`; the engine resolves every coin effect (coin damage before weakness/resistance, statuses incl. Thick Skinned, self-damage, protection, Pay Day…), logs the coins, handles KOs and ends the turn (or leaves it open for a prize/promotion/pending choice). Never add coin-effect logic to `rooms.ts`. After a KO the defender promotes (`promote` then calls `endTurn` for the attacker); the attacker's `takePrize` ends the turn once both actives are back. Metronome is only accepted on an attack with a `CopyAttack` effect.
- Confusion is resolved in the `attack` action: server flips, `resolveConfusionFlip` (game-core) applies tails.
- Decks used in rooms must pass `checkDeckPlayable` (owned by the player, rules + collection ownership; basic energy is unlimited).
- Conversion 1/2 (Porygon) is still resolved in `rooms.ts`, and Sand-attack/Smokescreen (`mustFlipToAttack`) isn't enforced in multiplayer at all. Prefer moving logic into game-core over adding more here.

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

Still open:
- **Attack legality isn't checked anywhere in multiplayer**: neither `executeAttack` nor the `attack` action verifies the Energy cost (`canUseAttack`), Paralyzed/Asleep, `cannotAttack` (Leer) or the starting player's first turn — a modified client can attack with a Paralyzed Pokémon with no Energy (verified). Needs an engine guard (e.g. `canExecuteAttack(state, i)` used by `executeAttack`/`executeMetronome`, which also covers Metronome's own cost) rather than rules in `rooms.ts`.
- Own deck order and prizes are sent to their owner (search UIs read `playerDeck`).
- Pending flags aren't swapped for player 2; turn checks cover ownership for now.
- Deck saves don't reject cards the user doesn't own: the deck is saved with `isValid: false` and `checkDeckPlayable` blocks it from rooms.
- game-core gaps worked around in `rooms.ts` (should move into the engine): `canPlayTrainer` doesn't check the card's name matches the trainer being executed; `executeHealFlip` trusts its `sourcePokemonId`, and `canUseHealFlip` calls `canUsePower` without `usedPowersThisTurn`. Other powers (`rainDance`, `energyTrans`, ...) check themselves but return the unchanged state + an info event instead of an error.
- Bets aren't validated against the creator's title tier on the server (schema caps `betAmount` at 1000; it's never charged anyway). `attack.selectedEnergyIds` is accepted but ignored: the engine auto-picks the energy to discard, so the player’s choice isn’t honored in multiplayer. Don’t just pass it to `executeAttack`, which discards whatever ids it gets without checking count/type (a client could under-pay). Validate it in game-core first.
- Discord/Google accounts with the same email both log into one account (by design, verified emails only).
- Migrations baseline exists in the repo but prod still runs `db push` until someone follows `docs/migrations.md` (prod has `_prisma_migrations` with `0001_init` and an untracked `prisma/migrations/` on the VPS). `Match` never persisted, `betAmount` never charged, `console.*` logging only, `executeAction` in `rooms.ts` is ~970 lines.
- Daily free wheel/slot spin endpoints (`/users/me/claim-wheel-spin`, `claim-slot-spin`) only stamp a date; not wired to `freeWheelSpins` or the UI.
