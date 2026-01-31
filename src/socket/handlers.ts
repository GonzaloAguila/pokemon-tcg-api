import type { Server, Socket } from "socket.io";
import { GameRoomManager } from "./rooms.js";
import { maskGameStateForPlayer } from "./state-masking.js";

// Types for Socket.io events
interface JoinRoomPayload {
  roomId: string;
  userId: string;
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
    // Room Management
    // ==========================================================================

    socket.on("joinRoom", async (payload: JoinRoomPayload) => {
      try {
        const { roomId, userId } = payload;
        const room = await roomManager.joinRoom(roomId, userId, socket.id);

        socket.join(roomId);

        socket.emit("roomJoined", {
          roomId,
          playerId: userId,
          players: room.players,
          isPlayer1: room.player1Id === userId,
        });

        // Notify other player
        socket.to(roomId).emit("playerJoined", {
          playerId: userId,
        });

        console.log(`👤 User ${userId} joined room ${roomId}`);
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
