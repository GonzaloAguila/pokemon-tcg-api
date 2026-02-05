# Game Server Skill

Use this skill when working on Socket.io handlers, room management, or real-time game logic.

## Architecture

```
Client A  ←─ Socket.io ─→  Server  ←─ Socket.io ─→  Client B
                              │
                    ┌─────────┴─────────┐
                    │   GameState       │ (Player 1 perspective)
                    │   RoomManager     │ (In-memory)
                    │   Perspective Swap │ (For Player 2)
                    └───────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `socket/handlers.ts` | Event handlers (entry point) |
| `socket/rooms.ts` | GameRoomManager class |
| `socket/state-masking.ts` | `swapPerspective()` function |

## Event Handler Pattern

```typescript
socket.on('eventName', async (payload) => {
  try {
    // 1. Validate
    const room = roomManager.getRoom(payload.roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // 2. Execute
    const result = await roomManager.doSomething(payload);

    // 3. Broadcast
    io.to(payload.roomId).emit('result', result);

  } catch (error) {
    socket.emit('error', { message: (error as Error).message });
  }
});
```

## Room Lifecycle

```
createRoom → joinRoom (P1) → joinRoom (P2) → gameStart
                                    │
                                    ↓
                              action loop
                              ↓        ↑
                           gameState ──┘
                                    │
                                    ↓ (KO all or 6 prizes)
                                gameOver
```

## Player 2 Perspective

Server stores state from **Player 1's perspective**. For Player 2:

```typescript
// In rooms.ts executeAction
const executeForPlayer = (fn: (state: GameState) => GameState): GameState => {
  if (isPlayer1) {
    return fn(room.gameState!);
  } else {
    // Swap → Execute → Swap back
    const swapped = swapPerspective(room.gameState!);
    const result = fn(swapped);
    return swapPerspective(result);
  }
};
```

The `swapPerspective` function swaps:
- `playerHand` ↔ `opponentHand`
- `playerDeck` ↔ `opponentDeck`
- `playerBench` ↔ `opponentBench`
- `playerActivePokemon` ↔ `opponentActivePokemon`
- `isPlayerTurn` → inverted

## Action Execution Flow

```
1. Client sends: { roomId, action: { type, payload } }
                              ↓
2. Validate:
   - Is player in room?
   - Is it their turn? (bypass for MULLIGAN/SETUP)
   - Is action valid?
                              ↓
3. Execute:
   - For P1: fn(state)
   - For P2: swap → fn → swap
                              ↓
4. Check game over:
   - 6 prizes taken?
   - All opponent Pokemon KO'd?
                              ↓
5. Broadcast:
   - io.to(roomId).emit('gameState', state)
   - For coin flips: emit('showCoinFlip', results) first
```

## Adding New Actions

### 1. Add case in `executeAction` (rooms.ts)

```typescript
case "newAction": {
  const { param1, param2 } = action.payload;

  // Validate
  if (!someCondition) {
    return { success: false, error: "Invalid action" };
  }

  // Execute (use executeForPlayer for game-core functions)
  newState = executeForPlayer((state) =>
    someGameCoreFunction(state, param1, param2)
  );
  break;
}
```

### 2. Add handler in `handlers.ts` (if needed)

Only needed if action requires special handling beyond standard flow.

### 3. Document in CLAUDE.md

Add to PlayerAction types section.

## Coin Flip Handling

Coin flips are generated server-side to prevent cheating:

```typescript
case "attack": {
  const activePokemon = getActive();
  const attack = activePokemon.pokemon.attacks[attackIndex];

  // Check for coin flip effect
  const coinEffect = attack.effects?.find(e => e.coinFlip);
  if (coinEffect?.coinFlip) {
    const results = Array.from(
      { length: coinEffect.coinFlip.count },
      () => Math.random() < 0.5 ? "heads" : "tails"
    );

    // Broadcast for animation BEFORE state update
    io.to(roomId).emit('showCoinFlip', {
      attackName: attack.name,
      results,
      count: results.length,
    });
  }

  newState = executeForPlayer((state) => executeAttack(state, attackIndex));
  break;
}
```

## Game Phases

```typescript
type GamePhase = "MULLIGAN" | "SETUP" | "PLAYING" | "GAME_OVER";
```

| Phase | Turn Validation | Allowed Actions |
|-------|-----------------|-----------------|
| MULLIGAN | Bypassed | mulligan, playerReady, playBasicToActive |
| SETUP | Bypassed | playBasicToActive, playBasicToBench, playerReady |
| PLAYING | Enforced | All actions |
| GAME_OVER | N/A | None |

## Using Game Core Functions

```typescript
import {
  // Initialization
  initializeMultiplayerGame,
  startGame,
  startPlayingPhase,

  // Turn actions
  executeAttack,
  endTurn,
  executeRetreat,
  doMulligan,
  setPlayerReady,
  promoteActivePokemon,

  // Trainers
  playBill,
  playSwitch,
  playGustOfWind,
  // ... 20+ trainer functions

  // Powers
  attachEnergyWithRainDance,
  moveEnergyWithEnergyTrans,
  moveDamageWithDamageSwap,
  activateEnergyBurn,
  executeBuzzap,

  // Validation
  canUseRainDance,
  canAttachWithPower,
  canEvolveInto,
} from "@poke-tcg/game-core";
```

## Testing

```typescript
describe('GameRoomManager', () => {
  let manager: GameRoomManager;

  beforeEach(() => {
    manager = new GameRoomManager();
  });

  it('rejects action when not player turn', async () => {
    const room = await setupTwoPlayerGame(manager);

    // Player 2 tries to act on Player 1's turn
    const result = await manager.executeAction(
      room.id,
      room.player2SocketId,
      { type: 'attack', payload: { attackIndex: 0 } }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not your turn');
  });
});
```

## Common Issues

### "Not your turn" during setup
Setup actions bypass turn validation. Check `gamePhase`.

### State not updating for Player 2
Ensure `swapPerspective` is called before AND after game-core function.

### Coin flip not animating
Emit `showCoinFlip` BEFORE updating state. Client needs time to animate.

### Room not found after disconnect
Rooms are in-memory. Server restart clears all rooms.
