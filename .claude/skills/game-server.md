# Game Server Skill

Use this skill when working on the real-time game server, Socket.io handlers, room management, or game state synchronization.

## Architecture Overview

```
Client A  ←──Socket.io──→  Server  ←──Socket.io──→  Client B
                            │
                     ┌──────┴──────┐
                     │ GameState   │  (Canonical)
                     │ RoomManager │
                     │ StateMasker │
                     └─────────────┘
```

## Key Components

### 1. Socket Handlers (`src/socket/handlers.ts`)

Entry point for all real-time events. Pattern:

```typescript
socket.on('eventName', async (payload) => {
  try {
    // 1. Validate payload
    // 2. Execute business logic
    // 3. Update game state
    // 4. Broadcast to clients
    socket.emit('result', { success: true });
  } catch (error) {
    socket.emit('error', { message: error.message });
  }
});
```

### 2. Room Manager (`src/socket/rooms.ts`)

Manages game rooms in memory. Key methods:

| Method | Purpose |
|--------|---------|
| `createRoom()` | Create new room with unique ID |
| `joinRoom()` | Add player to room |
| `leaveRoom()` | Remove player from room |
| `setPlayerReady()` | Mark player ready |
| `startGame()` | Initialize game state |
| `executeAction()` | Validate and execute player action |
| `handleDisconnect()` | Handle player disconnect |

### 3. State Masking (`src/socket/state-masking.ts`)

**Critical for security** - Never send opponent's hand/deck to client.

```typescript
// Full state on server
const canonicalState = {
  playerHand: [...],
  opponentHand: [...] // SECRET
};

// Masked for Player 1
const maskedForP1 = {
  myHand: canonicalState.playerHand,      // Visible
  opponentHandCount: 5,                    // Only count!
};

// Masked for Player 2
const maskedForP2 = {
  myHand: canonicalState.opponentHand,    // Their hand
  opponentHandCount: 7,                    // Only count!
};
```

## Adding New Socket Events

1. Define the event in `handlers.ts`:

```typescript
socket.on('newEvent', async (payload: NewEventPayload) => {
  const { roomId, data } = payload;

  // Validate
  const room = roomManager.getRoom(roomId);
  if (!room) {
    socket.emit('error', { message: 'Room not found' });
    return;
  }

  // Execute
  const result = await someService.doSomething(data);

  // Broadcast
  io.to(roomId).emit('newEventResult', result);
});
```

2. Add corresponding client handler in frontend.

## Integrating Game Core

When `@poke-tcg/game-core` is published:

```typescript
import {
  initializeGame,
  executeAttack,
  canUseAttack,
  endTurn,
  type GameState,
} from '@poke-tcg/game-core';

// In rooms.ts
async startGame(roomId: string): Promise<GameState> {
  const room = this.rooms.get(roomId);

  // Get player decks from database
  const deck1 = await this.getDeck(room.player1Id);
  const deck2 = await this.getDeck(room.player2Id);

  // Initialize game
  let gameState = initializeGame(deck1, deck2);
  gameState = startGame(gameState);

  room.gameState = gameState;
  return gameState;
}

// In executeAction
case 'attack':
  if (!canUseAttack(state, pokemon, action.payload.attackIndex)) {
    return { success: false, error: 'Cannot use this attack' };
  }
  room.gameState = executeAttack(state, action.payload.attackIndex);
  break;
```

## Action Validation Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Receive action from client                               │
├─────────────────────────────────────────────────────────────┤
│ 2. Validate:                                                │
│    - Is player in this room?                                │
│    - Is it this player's turn?                              │
│    - Is the action valid? (canX functions)                  │
├─────────────────────────────────────────────────────────────┤
│ 3. Execute action (game-core pure functions)                │
├─────────────────────────────────────────────────────────────┤
│ 4. Check for game over conditions                           │
├─────────────────────────────────────────────────────────────┤
│ 5. Mask state for each player                               │
├─────────────────────────────────────────────────────────────┤
│ 6. Broadcast to room                                        │
└─────────────────────────────────────────────────────────────┘
```

## Coin Flip Handling

Coin flips MUST be generated server-side to prevent cheating:

```typescript
function executeAttackWithCoinFlip(
  state: GameState,
  attackIndex: number
): { newState: GameState; coinResults: CoinFlipResult[] } {
  const attack = getAttack(state, attackIndex);

  if (attack.coinFlipCount) {
    // Generate results on server
    const coinResults = Array.from(
      { length: attack.coinFlipCount },
      () => Math.random() < 0.5 ? 'heads' : 'tails'
    );

    // Apply to game state
    const newState = applyAttackWithCoinResults(state, attackIndex, coinResults);

    return { newState, coinResults };
  }

  return { newState: executeAttack(state, attackIndex), coinResults: [] };
}

// Broadcast coin results for animation
io.to(roomId).emit('coinFlipAnimation', { results: coinResults });
// Then broadcast updated state
io.to(roomId).emit('gameState', maskedState);
```

## Database Persistence

For reconnection support, persist game state:

```typescript
// After each action
await prisma.match.update({
  where: { id: room.matchId },
  data: {
    gameState: room.gameState,
    replayData: room.gameState.events, // For replay feature
  },
});

// On reconnect
const match = await prisma.match.findUnique({ where: { id: matchId } });
room.gameState = match.gameState;
```

## Error Handling Patterns

```typescript
// Custom game errors
class GameError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

// Common errors
const NotYourTurn = new GameError('Not your turn', 'NOT_YOUR_TURN');
const InvalidAction = new GameError('Invalid action', 'INVALID_ACTION');
const RoomFull = new GameError('Room is full', 'ROOM_FULL');

// In handlers
try {
  // ... action logic
} catch (error) {
  if (error instanceof GameError) {
    socket.emit('actionResult', {
      success: false,
      error: error.message,
      code: error.code
    });
  } else {
    socket.emit('error', { message: 'Internal server error' });
    console.error(error);
  }
}
```

## Testing

```typescript
describe('GameRoomManager', () => {
  let manager: GameRoomManager;

  beforeEach(() => {
    manager = new GameRoomManager();
  });

  it('should create a room', () => {
    const room = manager.createRoom();
    expect(room.id).toBeDefined();
    expect(room.status).toBe('waiting');
  });

  it('should reject action when not player turn', async () => {
    // Setup room with two players
    const room = manager.createRoom('test-room');
    await manager.joinRoom('test-room', 'player1', 'socket1');
    await manager.joinRoom('test-room', 'player2', 'socket2');
    await manager.startGame('test-room');

    // Player 2 tries to act on Player 1's turn
    const result = await manager.executeAction(
      'test-room',
      'socket2',
      { type: 'attack', payload: { attackIndex: 0 } }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not your turn');
  });
});
```

## Deployment Checklist

- [ ] Set `DATABASE_URL` in Railway
- [ ] Set `JWT_SECRET` (strong random string)
- [ ] Set `CORS_ORIGIN` to frontend URL
- [ ] Run `prisma db push` for initial schema
- [ ] Test WebSocket connection from frontend
