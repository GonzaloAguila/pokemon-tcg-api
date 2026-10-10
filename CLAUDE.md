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
npm run db:push      # apply prisma/schema.prisma (no migrations folder exists)
npm run db:generate  # regenerate Prisma client after schema edits
SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... npx tsx prisma/seed.ts   # create/promote superadmin
npm test             # vitest integration suite (needs the ptcg-test-db container, see test/README.md)
```

`npm run lint` is declared but doesn't work (eslint isn't installed/configured). CI (`.github/workflows/ci.yml`) runs `npm ci`, `prisma generate`, `tsc --noEmit` and `build`; it needs the `NPM_TOKEN` repo secret.

**Local database:** local dev uses the Docker container `ptcg-dev-db` (`postgresql://ptcg:ptcg@127.0.0.1:55433/pokemontcg_dev`). Never point local `.env` at production — prod Postgres only listens on localhost on the VPS.

## Layout

- `src/index.ts` — Express app, router registration, Socket.io server, chat cleanup interval.
- `src/modules/<feature>/` — `*.controller.ts` (Router) + `*.service.ts` (+ `*.types.ts`, `index.ts` barrel). Modules: achievements, admin, auth (local + Google + Discord OAuth), battle-pass, boosters, bug-report, catalog, chat, decks, market, messaging, users (+ rewards), waitlist, wheel. `game/` and `matchmaking/` are empty.
- `src/socket/` — `handlers.ts` (socket auth + event wiring), `rooms.ts` (`GameRoomManager`, in-memory games, `executeAction` switch), `draft-handlers.ts` / `draft-rooms.ts`, `state-masking.ts` (perspective swap for player 2).
- `src/middleware/` — `auth.ts` (`requireAuth`, `requireRole`, `requirePermission`, `optionalAuth`, `checkUserStatus`), `error-handler.ts` (`AppError`, `Errors.*`), `rate-limit.ts` (auth routes only).
- `src/lib/` — `prisma.ts`, `jwt.ts`, `oauth.ts`, `password.ts`, `email.ts` (Resend).
- `prisma/schema.prisma` — 24 models. `Match` / `GameRoom` exist but nothing writes to them.

## Conventions

- Validate request bodies with zod in the controller; throw `Errors.BadRequest/NotFound/Forbidden/...` (instances of `AppError`) so `errorHandler` maps the status. Plain `Error` objects become 500s.
- Protect routes with `requireAuth` then `requireRole(...)` / `requirePermission(...)`. Superadmin bypasses permission checks.
- Socket identity: always derive the user from the verified handshake JWT via `getAuthUserId(socket)` (`handlers.ts`); never trust a `userId` in the payload.
- Any balance change must go through `users.service` (`creditBalance`/`debitBalance` or the `addCoins`/`spendCoins`/… wrappers): they do one atomic UPDATE (debits guarded by `balance >= amount`), reject non-positive amounts and log a `Transaction` row with its `currency`. Pass the transaction client (`db`/`tx` arg) so a purchase charges and grants in ONE `prisma.$transaction`. One-time claims use conditional `updateMany` (e.g. `unlockedAt: null`) and check `count`.
- Prize games (wheel, slots) roll and grant server-side (`src/modules/prizes/`, CSPRNG); never accept a prize or outcome from the client.
- User-facing strings (errors, event log messages) are Spanish; code and comments English.
- Card IDs: `{set-slug}-{3-digit-number}-{slug-name}`, e.g. `base-set-025-pikachu`, `jungle-002-electrode` (`Nidoran♀` → `nidoranf`, `Mr. Mime` → `mr-mime`).

## Multiplayer model

- Game and draft rooms live in memory (Maps). A restart/PM2 reload drops every live game; reconnection only works within the same process. Single process only (no Redis adapter).
- Server keeps state from player 1's perspective; player 2's actions run on a swapped copy and are swapped back. There are two swap implementations (`state-masking.ts` and a local one in `rooms.ts`) and they differ.
- Every emitted state goes through `maskGameStateForPlayer(state, "player1" | "player2" | "spectator")`, which hides the opponent's hand/deck/prizes (same-length `{ id, hidden: true }` placeholders). Never emit `room.gameState` raw.
- Coin flips are rolled server-side and sent via `showCoinFlip`; the client animates predetermined results.
- Many rules (coin-flip effects, confusion, Metronome/Conversion flows) are re-implemented in `rooms.ts` instead of living in game-core. Prefer moving logic into game-core over adding more here.

## Environment

See `.env.example`. Also used: `COOKIE_DOMAIN` (prod: `.nostalgic-tcg.online`, needed so Chrome sends the refresh cookie across subdomains). `CORS_ORIGIN` is comma-separated and must include the frontend and landing origins. `JWT_SECRET` is required in production (falls back to a dev secret otherwise).

## Deploy

Production: Hostinger VPS, `api.nostalgic-tcg.online`, Nginx (TLS via Certbot) → `127.0.0.1:3001`, PM2 process `pokemon-tcg-api`, Postgres on the same box. Code at `/var/www/pokemon-tcg-api`. The VPS installs game-core from GitHub Packages, so root's `~/.npmrc` needs a valid token. Claude has no SSH access; give the user commands to run. Full pipeline: frontend repo `.claude/skills/api-deploy/SKILL.md`.

## Admin data fixes

For one-off grants (cards, currency) write a temporary `npx tsx` Prisma script, run it **on the VPS** from `/var/www/pokemon-tcg-api` (prod Postgres is localhost-only), then delete it. Prefer the atomic balance helpers so a Transaction row is logged. `userCard.upsert` with `update: { quantity }` *sets* the value; use `{ increment: n }` to add.

## Known issues (as of 2026-10 review — verify before assuming fixed)

Fixed on 2026-10-10 (branches security/economy-hardening, security/socket-hardening): room identity (name/avatar/title) from DB + banned/suspended can't create/join, deck ownership check, chat limited to rooms the socket is in + flood limit; atomic economy + market validation, server-side wheel/slots, hidden-information masking, OAuth verified-email + state, draft socket identity, pending-choice turn checks, permissions route removal, trust proxy + rate limits, seed password from env. Prod infra: Postgres no longer public, DB password rotated, ufw allows only 22/80/443.

Still open:
- Own deck order and prizes are sent to their owner (search UIs read `playerDeck`).
- Pending flags aren't swapped for player 2; turn checks cover ownership for now.
- Sockets are authenticated only at handshake: a banned user / expired token keeps the socket. Access tokens don't check `tokenVersion`; bans apply when the 15-min token expires.
- Deck saves don't check the user's collection (anyone can build a deck with cards they don't own). Game action payloads are unvalidated casts.
- Discord/Google accounts with the same email both log into one account (by design, verified emails only).
- No migrations (db push only; prod has `_prisma_migrations` with `0001_init` and an untracked `prisma/migrations/` on the VPS), `Match` never persisted, `betAmount` never charged, `console.*` logging only, `executeAction` in `rooms.ts` is ~970 lines.
- Daily free wheel/slot spin endpoints (`/users/me/claim-wheel-spin`, `claim-slot-spin`) only stamp a date; not wired to `freeWheelSpins` or the UI.
