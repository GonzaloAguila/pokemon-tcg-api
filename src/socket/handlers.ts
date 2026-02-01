import type { Server, Socket } from "socket.io";
import { GameRoomManager } from "./rooms.js";
import { maskGameStateForPlayer } from "./state-masking.js";

// Types for Socket.io events
interface JoinRoomPayload {
  roomId: string;
  userId: string;
  deckId?: string;
}

interface PlayerAction {
  type: "attack" | "playTrainer" | "playEnergy" | "retreat" | "usePower" | "endTurn" | "playBasic" | "evolve";
  payload: {
    cardId?: string;
    targetId?: string;
    attackIndex?: number;
    benchIndex?: number;
    selections?: string[][];
  };
}

interface ChatMessage {
  content: string;
}

// Room manager instance
const roomManager = new GameRoomManager();

export function setupSocketHandlers(io: Server): void {
  io.on("connection", (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // ==========================================================================
    // Lobby - Room Listing
    // ==========================================================================

    socket.on("getRooms", () => {
      const rooms = roomManager.getAvailableRooms();
      socket.emit("roomList", {
        rooms: rooms.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          playerCount: r.players.length,
        })),
      });
    });

    socket.on("createRoom", async (payload: { userId: string; deckId?: string }) => {
      try {
        const { userId, deckId } = payload;
        const room = roomManager.createRoom();
        await roomManager.joinRoom(room.id, userId, socket.id);

        // Set deck if provided
        if (deckId) {
          roomManager.setPlayerDeck(room.id, socket.id, deckId);
        }

        socket.join(room.id);

        socket.emit("roomCreated", {
          roomId: room.id,
          playerId: userId,
          isPlayer1: true,
        });

        // Broadcast updated room list to all clients in lobby
        io.emit("roomList", {
          rooms: roomManager.getAvailableRooms().map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            playerCount: r.players.length,
          })),
        });

        console.log(`🏠 Room ${room.id} created by ${userId}`);
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    socket.on("deleteRoom", async (payload: { roomId: string }) => {
      try {
        const { roomId } = payload;
        const deleted = roomManager.deleteRoom(roomId, socket.id);

        if (deleted) {
          socket.leave(roomId);
          socket.emit("roomDeleted", { roomId });

          // Broadcast updated room list
          io.emit("roomList", {
            rooms: roomManager.getAvailableRooms().map((r) => ({
              id: r.id,
              createdAt: r.createdAt,
              playerCount: r.players.length,
            })),
          });

          console.log(`🗑️ Room ${roomId} deleted`);
        } else {
          socket.emit("error", { message: "Cannot delete room" });
        }
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    // ==========================================================================
    // Room Management
    // ==========================================================================

    socket.on("joinRoom", async (payload: JoinRoomPayload) => {
      try {
        const { roomId, userId, deckId } = payload;
        const room = await roomManager.joinRoom(roomId, userId, socket.id);

        // Set deck if provided
        if (deckId) {
          roomManager.setPlayerDeck(roomId, socket.id, deckId);
        }

        socket.join(roomId);

        const isPlayer1 = room.player1Id === userId;

        socket.emit("roomJoined", {
          roomId,
          playerId: userId,
          players: room.players,
          isPlayer1,
        });

        // Notify other player
        socket.to(roomId).emit("playerJoined", {
          playerId: userId,
        });

        console.log(`👤 User ${userId} joined room ${roomId}`);

        // Auto-start game when second player joins
        if (roomManager.isRoomReady(roomId)) {
          const gameState = await roomManager.startGame(roomId);

          // Update room list (room no longer available)
          io.emit("roomList", {
            rooms: roomManager.getAvailableRooms().map((r) => ({
              id: r.id,
              createdAt: r.createdAt,
              playerCount: r.players.length,
            })),
          });

          // Send masked state to each player
          io.to(room.player1SocketId!).emit("gameStart", {
            roomId,
            gameState: maskGameStateForPlayer(gameState, "player1"),
            isPlayer1: true,
          });
          io.to(room.player2SocketId!).emit("gameStart", {
            roomId,
            gameState: maskGameStateForPlayer(gameState, "player2"),
            isPlayer1: false,
          });

          console.log(`🎮 Game auto-started in room ${roomId}`);
        }
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    socket.on("leaveRoom", async (payload: { roomId: string }) => {
      try {
        const { roomId } = payload;
        await roomManager.leaveRoom(roomId, socket.id);

        socket.leave(roomId);
        socket.to(roomId).emit("playerLeft", { socketId: socket.id });

        console.log(`👤 Socket ${socket.id} left room ${roomId}`);
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    // ==========================================================================
    // Game Ready
    // ==========================================================================

    socket.on("ready", async (payload: { roomId: string }) => {
      try {
        const { roomId } = payload;
        const room = await roomManager.setPlayerReady(roomId, socket.id);

        socket.to(roomId).emit("playerReady", { socketId: socket.id });

        // Check if both players ready
        if (room.player1Ready && room.player2Ready) {
          const gameState = await roomManager.startGame(roomId);

          // Send masked state to each player
          io.to(room.player1SocketId!).emit("gameStart", {
            gameState: maskGameStateForPlayer(gameState, "player1"),
          });
          io.to(room.player2SocketId!).emit("gameStart", {
            gameState: maskGameStateForPlayer(gameState, "player2"),
          });

          console.log(`🎮 Game started in room ${roomId}`);
        }
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    // ==========================================================================
    // Game Actions
    // ==========================================================================

    socket.on("action", async (payload: { roomId: string; action: PlayerAction }) => {
      try {
        const { roomId, action } = payload;
        const result = await roomManager.executeAction(roomId, socket.id, action);

        if (!result.success) {
          socket.emit("actionResult", { success: false, error: result.error });
          return;
        }

        // Broadcast action to opponent for animation
        socket.to(roomId).emit("opponentAction", {
          type: action.type,
          // Include minimal info for animation (no private data)
        });

        // Send updated state to both players
        const room = roomManager.getRoom(roomId);
        if (room && result.gameState) {
          io.to(room.player1SocketId!).emit("gameState", {
            gameState: maskGameStateForPlayer(result.gameState, "player1"),
          });
          io.to(room.player2SocketId!).emit("gameState", {
            gameState: maskGameStateForPlayer(result.gameState, "player2"),
          });
        }

        // Check for game over
        if (result.gameOver) {
          io.to(roomId).emit("gameOver", {
            winner: result.winner,
            reason: result.winReason,
          });
        }

        socket.emit("actionResult", { success: true });
      } catch (error) {
        socket.emit("actionResult", {
          success: false,
          error: (error as Error).message,
        });
      }
    });

    // ==========================================================================
    // Chat
    // ==========================================================================

    socket.on("chatMessage", (payload: { roomId: string; message: ChatMessage }) => {
      const { roomId, message } = payload;

      // Broadcast to room (including sender)
      io.to(roomId).emit("chatMessage", {
        senderId: socket.id,
        content: message.content,
        timestamp: Date.now(),
      });
    });

    // ==========================================================================
    // Disconnect
    // ==========================================================================

    socket.on("disconnect", async () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);

      // Find and handle room disconnect
      const roomId = await roomManager.handleDisconnect(socket.id);
      if (roomId) {
        socket.to(roomId).emit("playerDisconnected", {
          socketId: socket.id,
        });
      }
    });
  });
}
