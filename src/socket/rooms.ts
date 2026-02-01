/**
 * Game Room Manager
 *
 * Manages in-memory game rooms for real-time multiplayer.
 * TODO: Persist to database for reconnection support.
 */

import {
  type GameState,
  type Deck,
  initializeGame,
  startGame,
  executeAttack,
  endTurn,
  executeRetreat,
  getDeckById,
  decks,
  buildDeckFromEntries,
} from "@poke-tcg/game-core";

interface PlayerAction {
  type: string;
  payload: Record<string, unknown>;
}

interface GameRoom {
  id: string;
  status: "waiting" | "ready" | "playing" | "finished";

  // Players
  player1Id: string | null;
  player1SocketId: string | null;
  player1Ready: boolean;
  player1DeckId: string | null;

  player2Id: string | null;
  player2SocketId: string | null;
  player2Ready: boolean;
  player2DeckId: string | null;

  // Game state
  gameState: GameState | null;

  // Metadata
  players: string[];
  createdAt: Date;
}

interface ActionResult {
  success: boolean;
  error?: string;
  gameState?: GameState;
  gameOver?: boolean;
  winner?: "player1" | "player2";
  winReason?: string;
}

export class GameRoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  private socketToRoom: Map<string, string> = new Map();

  /**
   * Create a new room
   */
  createRoom(roomId?: string): GameRoom {
    const id = roomId || this.generateRoomId();
    const room: GameRoom = {
      id,
      status: "waiting",
      player1Id: null,
      player1SocketId: null,
      player1Ready: false,
      player1DeckId: null,
      player2Id: null,
      player2SocketId: null,
      player2Ready: false,
      player2DeckId: null,
      gameState: null,
      players: [],
      createdAt: new Date(),
    };

    this.rooms.set(id, room);
    return room;
  }

  /**
   * Join an existing room or create if doesn't exist
   */
  async joinRoom(roomId: string, userId: string, socketId: string): Promise<GameRoom> {
    let room = this.rooms.get(roomId);

    if (!room) {
      room = this.createRoom(roomId);
    }

    // Check if room is full
    if (room.player1Id && room.player2Id) {
      // Check if reconnecting
      if (room.player1Id === userId) {
        room.player1SocketId = socketId;
        this.socketToRoom.set(socketId, roomId);
        return room;
      }
      if (room.player2Id === userId) {
        room.player2SocketId = socketId;
        this.socketToRoom.set(socketId, roomId);
        return room;
      }
      throw new Error("Room is full");
    }

    // Add player to room
    if (!room.player1Id) {
      room.player1Id = userId;
      room.player1SocketId = socketId;
      room.players.push(userId);
    } else if (!room.player2Id) {
      room.player2Id = userId;
      room.player2SocketId = socketId;
      room.players.push(userId);
    }

    this.socketToRoom.set(socketId, roomId);
    return room;
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string, socketId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.player1SocketId === socketId) {
      room.player1Id = null;
      room.player1SocketId = null;
      room.player1Ready = false;
    } else if (room.player2SocketId === socketId) {
      room.player2Id = null;
      room.player2SocketId = null;
      room.player2Ready = false;
    }

    this.socketToRoom.delete(socketId);

    // Remove room if empty
    if (!room.player1Id && !room.player2Id) {
      this.rooms.delete(roomId);
    }
  }

  /**
   * Set player as ready
   */
  async setPlayerReady(roomId: string, socketId: string): Promise<GameRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (room.player1SocketId === socketId) {
      room.player1Ready = true;
    } else if (room.player2SocketId === socketId) {
      room.player2Ready = true;
    } else {
      throw new Error("Player not in room");
    }

    return room;
  }

  /**
   * Set player's deck selection
   */
  setPlayerDeck(roomId: string, socketId: string, deckId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (room.player1SocketId === socketId) {
      room.player1DeckId = deckId;
    } else if (room.player2SocketId === socketId) {
      room.player2DeckId = deckId;
    }
  }

  /**
   * Start the game
   */
  async startGame(roomId: string): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (!room.player1Id || !room.player2Id) {
      throw new Error("Need two players to start");
    }

    room.status = "playing";

    // Get decks - use default if not selected
    const player1Deck = getDeckById(room.player1DeckId || "brushfire") || decks[0];
    const player2Deck = getDeckById(room.player2DeckId || "overgrowth") || decks[1];

    // Initialize game with player's deck (player1 perspective)
    let gameState = initializeGame(player1Deck);

    // For multiplayer, we need to set up both sides
    // The opponent's deck becomes player2's deck
    // We'll need to reinitialize with proper perspective handling
    // For now, use a simplified initialization
    gameState = startGame(gameState);

    room.gameState = gameState;
    return room.gameState;
  }

  /**
   * Execute a player action
   */
  async executeAction(
    roomId: string,
    socketId: string,
    action: PlayerAction
  ): Promise<ActionResult> {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: "Room not found" };
    if (!room.gameState) return { success: false, error: "Game not started" };

    // Determine which player is acting
    const isPlayer1 = room.player1SocketId === socketId;
    const isPlayer2 = room.player2SocketId === socketId;

    if (!isPlayer1 && !isPlayer2) {
      return { success: false, error: "Not a player in this room" };
    }

    // Validate turn - player1 plays when isPlayerTurn is true
    const isMyTurn = isPlayer1 ? room.gameState.isPlayerTurn : !room.gameState.isPlayerTurn;
    if (!isMyTurn && action.type !== "ready") {
      return { success: false, error: "Not your turn" };
    }

    console.log(`[Room ${roomId}] Action from ${isPlayer1 ? "P1" : "P2"}: ${action.type}`, action.payload);

    try {
      let newState = room.gameState;

      switch (action.type) {
        case "attack":
          const attackIndex = action.payload.attackIndex as number;
          newState = executeAttack(room.gameState, attackIndex);
          break;

        case "endTurn":
          newState = endTurn(room.gameState);
          break;

        case "retreat":
          const energyIds = action.payload.energyIdsToDiscard as string[];
          const benchIndex = action.payload.benchIndex as number;
          newState = executeRetreat(room.gameState, energyIds, benchIndex);
          break;

        // TODO: Add more actions (playBasic, attachEnergy, evolve, playTrainer, usePower)

        default:
          return { success: false, error: `Unknown action type: ${action.type}` };
      }

      room.gameState = newState;

      // Check for game over
      const gameOver = newState.gamePhase === "GAME_OVER";
      let winner: "player1" | "player2" | undefined;
      let winReason: string | undefined;

      if (gameOver) {
        room.status = "finished";
        // From player1's perspective: victory = player1 wins
        winner = newState.gameResult === "victory" ? "player1" : "player2";
        winReason = newState.gameResult === "victory"
          ? "Player 1 wins!"
          : "Player 2 wins!";
      }

      return {
        success: true,
        gameState: room.gameState,
        gameOver,
        winner,
        winReason,
      };
    } catch (error) {
      console.error(`[Room ${roomId}] Action error:`, error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Handle player disconnect
   */
  async handleDisconnect(socketId: string): Promise<string | null> {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Mark player as disconnected but don't remove yet (allow reconnect)
    if (room.player1SocketId === socketId) {
      room.player1SocketId = null;
    } else if (room.player2SocketId === socketId) {
      room.player2SocketId = null;
    }

    this.socketToRoom.delete(socketId);

    // TODO: Start disconnect timer for forfeit

    return roomId;
  }

  /**
   * Get a room by ID
   */
  getRoom(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Get all available rooms (waiting for players)
   */
  getAvailableRooms(): GameRoom[] {
    const rooms: GameRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.status === "waiting" && !room.player2Id) {
        rooms.push(room);
      }
    }
    return rooms;
  }

  /**
   * Delete a room (only creator can delete)
   */
  deleteRoom(roomId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // Only player 1 (creator) can delete the room
    if (room.player1SocketId !== socketId) {
      return false;
    }

    // Can only delete if game hasn't started
    if (room.status === "playing") {
      return false;
    }

    this.rooms.delete(roomId);
    this.socketToRoom.delete(socketId);
    return true;
  }

  /**
   * Check if both players are ready to start
   */
  isRoomReady(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.player1Id !== null && room.player2Id !== null;
  }

  /**
   * Generate a unique room ID
   */
  private generateRoomId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
