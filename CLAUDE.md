# CLAUDE.md — pokemon-tcg-api

Backend for **Nostalgic TCG** (browser Pokémon TCG, Base Set + Jungle). Express + Socket.io + Prisma/PostgreSQL. Serves REST for accounts/economy/collection and runs authoritative multiplayer games and drafts over Socket.io.

## Related repos (all siblings under `D:/Proyectos/`)

| Repo | Role |
|------|------|
| `pokemon-tcg-game-core` | Game engine. Consumed here via `"file:../pokemon-tcg-game-core"` — this API runs whatever is checked out/built there, NOT a published version. |
| `pokemon-tcg` | Next.js frontend (Vercel). Talks to this API via `NEXT_PUBLIC_API_URL`. Holds the cross-repo orchestration notes and the VPS deploy skill (`.claude/skills/api-deploy/`). |
| `pokemon-tcg-landing` | Astro landing; only uses `POST /api/waitlist`. |

Change order when work spans repos: game-core (build) → API → frontend.

## Commands

```bash
npm run dev          # tsx watch, port 3001
npm run build        # tsc → dist/
npx tsc --noEmit     # type check (the only working static check today)
npm run db:push      # apply prisma/schema.prisma (no migrations folder exists)
npm run db:generate  # regenerate Prisma client after schema edits
npx tsx prisma/seed.ts   # superadmin seed
```

`npm run lint` and `npm run test` are declared but **do not work**: eslint isn't installed/configured and there are no test files.

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
- Any balance change must go through `users.service` (`addCoins`, `spendCoins`, …) so a `Transaction` row is written. Amounts must be validated positive integers before reaching it.
- User-facing strings (errors, event log messages) are Spanish; code and comments English.
- Card IDs: `{set-slug}-{3-digit-number}-{slug-name}`, e.g. `base-set-025-pikachu`, `jungle-002-electrode` (`Nidoran♀` → `nidoranf`, `Mr. Mime` → `mr-mime`).

## Multiplayer model

- Game and draft rooms live in memory (Maps). A restart/PM2 reload drops every live game; reconnection only works within the same process. Single process only (no Redis adapter).
- Server keeps state from player 1's perspective; player 2's actions run on a swapped copy and are swapped back. There are two swap implementations (`state-masking.ts` and a local one in `rooms.ts`) and they differ.
- Coin flips are rolled server-side and sent via `showCoinFlip`; the client animates predetermined results.
- Many rules (coin-flip effects, confusion, Metronome/Conversion flows) are re-implemented in `rooms.ts` instead of living in game-core. Prefer moving logic into game-core over adding more here.

## Environment

See `.env.example`. Also used: `COOKIE_DOMAIN` (prod: `.nostalgic-tcg.online`, needed so Chrome sends the refresh cookie across subdomains). `CORS_ORIGIN` is comma-separated and must include the frontend and landing origins. `JWT_SECRET` is required in production (falls back to a dev secret otherwise).

## Deploy

Production: Hostinger VPS, `api.nostalgic-tcg.online`, Nginx (TLS via Certbot) → `127.0.0.1:3001`, PM2 process `pokemon-tcg-api`, Postgres on the same box. Code at `/var/www/pokemon-tcg-api`, engine at `/var/www/pokemon-tcg-game-core`. Claude has no SSH access; give the user commands to run. Full pipeline: frontend repo `.claude/skills/api-deploy/SKILL.md`.

`file:` deps are copied at install time: after rebuilding game-core run `rm -rf node_modules/@gonzaloaguila && npm install`.

## Admin data fixes

For one-off grants (cards, currency) write a temporary `npx tsx` Prisma script, run it, then delete it. `userCard.upsert` with `update: { quantity }` *sets* the value; use `{ increment: n }` to add.

## Known issues (as of 2026-10 review — verify before assuming fixed)

Security / economy:
- `POST /market/buy-energy` does not validate `quantity`; a negative value increases the user's coins. Market endpoints have no zod.
- `POST /wheel/claim` persists whatever prize the client sends (wheel and slots resolve prizes client-side).
- `state-masking.ts` hides nothing: both clients (and spectators) receive the full hand, deck and prizes of both players.
- Draft socket events trust `payload.userId` (admin check on `draft:create`, entry fee and identity on `draft:join`).
- Discord OAuth ignores the `verified` flag and accounts are linked by email → account takeover risk. No OAuth `state` param.
- `PATCH /users/:userId/permissions` only requires admin and has no self-check (privilege escalation).
- Balance operations are read-then-write without atomic conditional updates; purchases aren't atomic with their grants.
- No `app.set("trust proxy", 1)`: behind Nginx all clients share one IP for rate limiting. No limits on economy, chat or socket events.
- Socket payloads are unvalidated casts; pending-choice actions (`deckSearch`, `forceSwitch`, …) don't check which player owns the pending state.
- `prisma/seed.ts` (tracked) contains a plaintext superadmin password.

Other: no migrations (db push only), `Match` never persisted, `betAmount` never charged, `console.*` logging only, `executeAction` in `rooms.ts` is ~970 lines.
