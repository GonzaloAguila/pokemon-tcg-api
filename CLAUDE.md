# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Backend API for Pokemon TCG multiplayer game. Handles real-time game sessions, user authentication, matchmaking, and persistence.

**Stack:**
- Express.js + Socket.io for HTTP/WebSocket
- PostgreSQL + Prisma for database
- JWT for authentication
- `@poke-tcg/game-core` for shared game logic

## Commands

```bash
npm run dev           # Start dev server with hot reload (tsx watch)
npm run build         # Compile TypeScript
npm run start         # Start production server
npm run db:push       # Push Prisma schema to database
npm run db:migrate    # Create and run migrations
npm run db:studio     # Open Prisma Studio (DB GUI)
npm run db:generate   # Generate Prisma client
npm run lint          # Run ESLint
npm run test          # Run tests
```

## Architecture

### Directory Structure

```
src/
├── index.ts              # Express + Socket.io entry point
├── config/
│   └── env.ts            # Environment variables
├── socket/
│   ├── index.ts          # Socket.io setup
│   ├── handlers.ts       # Event handlers (joinRoom, action, etc.)
│   ├── rooms.ts          # Room/session management
│   └── state-masking.ts  # Hide private info from clients
├── modules/
│   ├── auth/
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── auth.middleware.ts
│   │   └── auth.types.ts
│   ├── game/
│   │   ├── game.service.ts      # Uses @poke-tcg/game-core
│   │   ├── game.executor.ts     # Executes actions on GameState
│   │   └── game.types.ts
│   ├── matchmaking/
│   │   ├── matchmaking.controller.ts
│   │   ├── matchmaking.service.ts
│   │   └── matchmaking.types.ts
│   └── users/
│       ├── users.controller.ts
│       ├── users.service.ts
│       └── users.types.ts
├── middleware/
│   ├── error-handler.ts
│   └── cors.ts
└── utils/
    └── logger.ts

prisma/
└── schema.prisma         # Database schema
```

### Socket.io Events

**Client → Server:**
```typescript
'joinRoom'        // { roomId: string } - Join a game room
'leaveRoom'       // { roomId: string } - Leave current room
'ready'           // {} - Signal ready to start
'action'          // PlayerAction - Execute game action
'chatMessage'     // { content: string } - Send chat message
```

**Server → Client:**
```typescript
'roomJoined'      // { roomId, players } - Confirmed room join
'gameStart'       // { gameState } - Game starting
'gameState'       // MaskedGameState - Updated state (hidden info masked)
'actionResult'    // { success, error? } - Action result
'opponentAction'  // { type, ... } - For opponent action animations
'chatMessage'     // { sender, content, timestamp }
'playerDisconnected' // { playerId }
'gameOver'        // { winner, reason }
```

### Game State Masking

The server maintains the canonical GameState but sends masked versions to clients:

```typescript
// Server has full state
const canonicalState: GameState = { ... };

// Player A receives:
const maskedForA: MaskedGameState = {
  myHand: canonicalState.playerHand,      // Full hand
  myDeckCount: canonicalState.playerDeck.length,
  opponentHandCount: canonicalState.opponentHand.length,  // Only count!
  opponentDeckCount: canonicalState.opponentDeck.length,
  // ... public info (actives, benches, damage, etc.)
};
```

### Action Validation Flow

```
Client sends action
       ↓
Server validates (canX functions from game-core)
       ↓
If valid: Execute action, update state
       ↓
Mask state for each player
       ↓
Broadcast to room
```

## Database Schema (Prisma)

```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  username     String   @unique
  createdAt    DateTime @default(now())
  decks        Deck[]
  matches      Match[]  @relation("PlayerMatches")
}

model Deck {
  id        String   @id @default(uuid())
  name      String
  cards     Json     // Array of card IDs
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now())
}

model Match {
  id          String   @id @default(uuid())
  player1Id   String
  player2Id   String?
  winnerId    String?
  status      String   // 'waiting', 'playing', 'finished'
  gameState   Json?    // Current GameState (for reconnection)
  replayData  Json?    // Event log for replay
  createdAt   DateTime @default(now())
  finishedAt  DateTime?
  players     User[]   @relation("PlayerMatches")
}

model GameRoom {
  id          String   @id @default(uuid())
  type        String   // 'casual', 'ranked', 'event'
  status      String   // 'waiting', 'playing'
  player1Id   String?
  player2Id   String?
  matchId     String?
  createdAt   DateTime @default(now())
}
```

## Code Conventions

### Module Pattern

Each module follows this structure:
- `*.controller.ts` - HTTP route handlers
- `*.service.ts` - Business logic (pure when possible)
- `*.types.ts` - TypeScript types for the module

### Error Handling

Use custom error classes:

```typescript
import { AppError } from '../middleware/error-handler';

throw new AppError('Room not found', 404);
throw new AppError('Not your turn', 400);
throw new AppError('Invalid action', 400);
```

### Environment Variables

Required in `.env`:
```
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-key
PORT=3001
CORS_ORIGIN=http://localhost:3000
```

### Using Game Core

Import game logic from the shared package:

```typescript
import {
  executeAttack,
  canUseAttack,
  GameState,
  isPokemonCard
} from '@poke-tcg/game-core';

// Execute action
if (canUseAttack(state, pokemon, attackIndex)) {
  const newState = executeAttack(state, attackIndex);
  await this.broadcastState(roomId, newState);
}
```

## Security Considerations

1. **Never trust client GameState** - Server is source of truth
2. **Validate all actions** - Use `canX()` functions before executing
3. **Mask private info** - Opponent's hand/deck should never be sent
4. **Rate limit** - Prevent action spam
5. **JWT validation** - Verify tokens on every Socket connection

## Coin Flip Synchronization

Coin flips must be generated server-side:

```typescript
// In game.executor.ts
function executeAttackWithCoinFlip(state: GameState, attack: Attack): {
  newState: GameState;
  coinResults: CoinFlipResult[];
} {
  const coinResults = generateCoinFlips(attack.coinFlipCount);
  // Apply results to state...
  return { newState, coinResults };
}

// Broadcast results to both clients for animation
socket.to(roomId).emit('coinFlipResults', coinResults);
```

## Reconnection Handling

1. Store GameState in database on each action
2. On reconnect, restore from database
3. Re-mask state for reconnecting player
4. Resume from last known state

## Testing

```typescript
describe('GameExecutor', () => {
  it('should reject actions when not player turn', async () => {
    const room = createTestRoom();
    const result = await executor.handleAction(room, 'player2', attackAction);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not your turn');
  });
});
```

## Deployment (Railway)

1. Connect GitHub repo to Railway
2. Set environment variables
3. Add PostgreSQL addon
4. Deploy automatically on push to main

Required Railway settings:
- Build command: `npm run build`
- Start command: `npm run start`
- Health check path: `/health`
