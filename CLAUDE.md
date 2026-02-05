# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Pokemon TCG API** - Backend service for Pokemon Trading Card Game with real-time multiplayer.

| Aspect | Details |
|--------|---------|
| Stack | Express.js + Socket.io + PostgreSQL + Prisma |
| Game Logic | `@poke-tcg/game-core` (local package at `../pokemon-tcg-game-core`) |
| Auth | OAuth (Google/Discord) - planned |
| Deploy | Railway |
| Scale | <100 CCU initially |

## Commands

```bash
npm run dev           # Development with hot reload
npm run build         # Compile TypeScript
npm run start         # Production server
npm run db:push       # Push Prisma schema
npm run db:migrate    # Create migration
npm run db:studio     # Prisma GUI
npm run lint          # ESLint
npm run test          # Vitest (all tests)
npm run test <file>   # Run single test file
npx tsc --noEmit      # Type check only
```

## Project Structure

```
src/
├── index.ts                 # Express + Socket.io entry
├── modules/                 # REST API feature modules
│   ├── catalog/             # Cards, sets, theme decks
│   └── boosters/            # Pack opening + daily limits
├── socket/                  # Real-time game logic
│   ├── index.ts             # Socket exports
│   ├── handlers.ts          # Socket event handlers
│   ├── rooms.ts             # GameRoomManager (in-memory)
│   └── state-masking.ts     # Perspective swap + state masking
└── middleware/
    └── error-handler.ts     # AppError class

.claude/
├── skills/                  # Claude Code skills
│   ├── add-module.md        # How to add new modules
│   ├── game-server.md       # Socket.io patterns
│   └── deployment.md        # Railway deployment
└── settings.local.json      # Allowed commands
```

## REST API Reference

Base: `http://localhost:3001/api`

### Catalog Module

```
GET  /sets                    → { sets: SetInfo[] }
GET  /sets/:setId             → SetInfo
GET  /sets/:setId/cards       → { setId, total, cards: Card[] }
     ?kind=pokemon|trainer|energy
     ?type=fire|water|grass|lightning|psychic|fighting|colorless
     ?rarity=common|uncommon|rare|rare-holo
     ?stage=basic|stage-1|stage-2
     ?search=<name>
GET  /cards/:cardId           → Card
GET  /cards/:cardId/image     → { cardId, imageUrl }
GET  /decks                   → { decks: DeckListItem[] }
GET  /decks/:deckId           → Deck
GET  /decks/:deckId/resolved  → ResolvedDeck
```

### Boosters Module

```
GET  /packs                      → { packs: BoosterPackListItem[] }
GET  /packs/:packId              → BoosterPackType
POST /packs                      → Create pack (admin)
PUT  /packs/:packId              → Update pack (admin)
DELETE /packs/:packId            → Delete pack (admin)
POST /packs/:packId/open         → Open pack {userId} → PackOpeningResult
POST /packs/:packId/preview      → Preview (no limit)
GET  /packs/daily-limit/:userId  → DailyLimitStatus
```

**Pack IDs:** `base-set-booster`, `base-set-theme-pack`
**Daily limit:** 5 packs per user (resets at midnight)

## Socket.io Events

Connection: `http://localhost:3001`

### Client → Server

| Event | Payload | Response Event |
|-------|---------|----------------|
| `getRooms` | `{}` | `roomList` |
| `createRoom` | `{userId, deckId?}` | `roomCreated` |
| `deleteRoom` | `{roomId}` | `roomDeleted` |
| `joinRoom` | `{roomId, userId, deckId?}` | `roomJoined`, `gameStart` |
| `leaveRoom` | `{roomId}` | `playerLeft` |
| `ready` | `{roomId}` | `gameStart` |
| `action` | `{roomId, action: PlayerAction}` | `gameState`, `actionResult` |

### Server → Client

| Event | Payload | When |
|-------|---------|------|
| `roomList` | `{rooms: Room[]}` | After `getRooms` |
| `roomCreated` | `{roomId}` | Room created |
| `roomJoined` | `{roomId, isPlayer1}` | Joined room |
| `gameStart` | `{roomId, gameState, isPlayer1}` | Both players ready |
| `gameState` | `{gameState}` | After any action |
| `showCoinFlip` | `{attackName, results, count}` | Attack with coin flip |
| `gameOver` | `{winner, reason}` | Game ended |
| `error` | `{message}` | Any error |

### PlayerAction Types

```typescript
| attack          | { attackIndex: number }
| endTurn         | {}
| retreat         | { energyIdsToDiscard: string[], benchIndex: number }
| playBasicToActive | { cardId: string }
| playBasicToBench  | { cardId: string, benchIndex: number }
| attachEnergy    | { cardId, pokemonId, isBench, benchIndex? }
| evolve          | { cardId: string, targetIndex: number }
| promote         | { benchIndex: number }
| mulligan        | {}
| playerReady     | {}
| usePower        | { powerType, pokemonId, ...params }
| playTrainer     | { cardId, trainerName, selections: string[][] }
```

## Core Patterns

### Module Structure

Each module follows:
```
modules/feature/
├── feature.controller.ts   # Router with endpoints
├── feature.service.ts      # Business logic (pure)
├── feature.types.ts        # TypeScript interfaces
└── index.ts                # Exports { featureRouter }
```

Register in `src/index.ts`:
```typescript
import { featureRouter } from './modules/feature/index.js';
app.use('/api', featureRouter);
```

### Error Handling

```typescript
import { AppError, Errors } from './middleware/error-handler';

throw new AppError('Custom message', 404);
throw Errors.NotFound('Resource');
throw Errors.BadRequest('Validation failed');
throw Errors.Unauthorized();
throw Errors.Forbidden();
```

### Perspective Swap (Multiplayer)

Server stores GameState from Player 1's view. For Player 2:
```typescript
const executeForPlayer2 = (fn) => {
  const swapped = swapPerspective(state);
  const result = fn(swapped);
  return swapPerspective(result);
};
```

### Game Phases

```typescript
type GamePhase = "MULLIGAN" | "SETUP" | "PLAYING" | "GAME_OVER";
```

| Phase | Turn Validation | Allowed Actions |
|-------|-----------------|-----------------|
| MULLIGAN | Bypassed | `mulligan`, `playerReady`, `playBasicToActive` |
| SETUP | Bypassed | `playBasicToActive`, `playBasicToBench`, `playerReady` |
| PLAYING | Enforced | All actions |
| GAME_OVER | N/A | None |

### Using Game Core

```typescript
import {
  // Game initialization
  initializeMultiplayerGame, startGame, buildDeckFromEntries,

  // Turn actions
  executeAttack, endTurn, executeRetreat, doMulligan,

  // Validation
  canUseAttack, canRetreat, canEvolveInto,

  // Trainers & Powers
  playBill, playSwitch, attachEnergyWithRainDance, // etc.

  // Catalog
  baseSetCards, decks, getDeckById, resolveDeck,

  // Type guards
  isPokemonCard, isEnergyCard, isTrainerCard,
} from '@poke-tcg/game-core';
```

## Environment Variables

```env
# Required
DATABASE_URL=postgresql://user:pass@host:5432/db
PORT=3001
CORS_ORIGIN=http://localhost:3000

# Future (OAuth)
JWT_SECRET=random-secret-min-32-chars
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
```

## Skills

Use `/skill <name>` for detailed guides:

| Skill | Purpose |
|-------|---------|
| `add-module` | Create new feature module |
| `game-server` | Socket.io and real-time patterns |
| `deployment` | Deploy to Railway |

## Key Notes

1. **Server = Source of Truth** - Clients send actions, server validates and executes
2. **Coin Flips Server-Side** - Prevents cheating, broadcast via `showCoinFlip`
3. **In-Memory State** - Rooms/limits reset on restart (acceptable for MVP)
4. **No Auth Yet** - Uses anonymous `userId` from client sessionStorage
5. **Card ID Format** - `base-set-001-alakazam` (set-number-name, zero-padded)

## TODO

- [x] ~~Implement state masking (hide opponent hand/deck)~~ - Done via `maskGameStateForPlayer`
- [ ] Add OAuth authentication
- [ ] Persist game state for reconnection
- [ ] Add rate limiting
- [ ] Add request logging
