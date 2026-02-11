import type { Server, Socket } from "socket.io";
import { GameRoomManager } from "./rooms.js";
import { maskGameStateForPlayer } from "./state-masking.js";
import {
  registerDraftEvents,
  draftRoomManager,
  createMatchGames,
} from "./draft-handlers.js";
import { recordMatchResult } from "../modules/users/users.service.js";
import { checkAndUpdateProgress } from "../modules/achievements/achievements.service.js";

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
      console.log(`[deleteRoom] Received:`, payload, `from socket ${socket.id}`);
      try {
        const { roomId } = payload;
        const room = roomManager.getRoom(roomId);
        console.log(`[deleteRoom] Room state:`, room ? { player1SocketId: room.player1SocketId, status: room.status } : 'not found');
        const deleted = roomManager.deleteRoom(roomId, socket.id);
        console.log(`[deleteRoom] Delete result: ${deleted}`);

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
      console.log(`[joinRoom] Received:`, payload);
      try {
        const { roomId, userId, deckId } = payload;
        console.log(`[joinRoom] Attempting to join room ${roomId} as ${userId}`);
        const room = await roomManager.joinRoom(roomId, userId, socket.id);
        console.log(`[joinRoom] Room state after join:`, {
          player1Id: room.player1Id,
          player2Id: room.player2Id,
          status: room.status,
        });

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

        // Check if game is already playing (reconnection case)
        if (room.status === "playing" && room.gameState) {
          console.log(`[joinRoom] Reconnecting to existing game, sending current state to socket ${socket.id}`);
          console.log(`[joinRoom] Room socket IDs: P1=${room.player1SocketId}, P2=${room.player2SocketId}`);
          // Send current game state to the reconnecting player
          socket.emit("gameStart", {
            roomId,
            gameState: maskGameStateForPlayer(room.gameState, isPlayer1 ? "player1" : "player2"),
            isPlayer1,
          });
          return;
        }

        // Auto-start game when second player joins (only if not already playing)
        console.log(`[joinRoom] Checking if room is ready: ${roomManager.isRoomReady(roomId)}`);
        if (roomManager.isRoomReady(roomId) && room.status === "waiting") {
          console.log(`[joinRoom] Room is ready, starting game...`);
          const gameState = await roomManager.startGame(roomId);
          console.log(`[joinRoom] Game started, phase: ${gameState.gamePhase}`);

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

        // Get room and state before action
        const roomBefore = roomManager.getRoom(roomId);
        const eventCountBefore = roomBefore?.gameState?.events?.length ?? 0;

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
          console.log(`[action] Sending state update. P1 socket: ${room.player1SocketId}, P2 socket: ${room.player2SocketId}`);
          console.log(`[action] State: P1 active=${!!result.gameState.playerActivePokemon}, P2 active=${!!result.gameState.opponentActivePokemon}`);

          // Broadcast coin flip results to both players if present
          if (result.coinFlipInfo) {
            console.log(`[action] Broadcasting coin flip results: ${result.coinFlipInfo.attackName} - ${result.coinFlipInfo.results.join(", ")}`);
            io.to(roomId).emit("showCoinFlip", {
              attackName: result.coinFlipInfo.attackName,
              results: result.coinFlipInfo.results,
              count: result.coinFlipInfo.results.length,
            });
          }

          if (room.player1SocketId) {
            io.to(room.player1SocketId).emit("gameState", {
              gameState: maskGameStateForPlayer(result.gameState, "player1"),
            });
          }
          if (room.player2SocketId) {
            io.to(room.player2SocketId).emit("gameState", {
              gameState: maskGameStateForPlayer(result.gameState, "player2"),
            });
          }
        }

        // Check for game over
        if (result.gameOver) {
          io.to(roomId).emit("gameOver", {
            winner: result.winner,
            reason: result.winReason,
          });

          // Persist win/loss stats to database
          const draftInfo =
            draftRoomManager.getDraftInfoForGameRoom(roomId);
          const room = roomManager.getRoom(roomId);
          if (room?.player1Id && room?.player2Id && result.winner) {
            const mode = draftInfo ? "draft" as const : "normal" as const;
            const winnerId = result.winner === "player1" ? room.player1Id : room.player2Id;
            const loserId = result.winner === "player1" ? room.player2Id : room.player1Id;
            recordMatchResult(winnerId, mode, true).then(() => checkAndUpdateProgress(winnerId)).catch(console.error);
            recordMatchResult(loserId, mode, false).then(() => checkAndUpdateProgress(loserId)).catch(console.error);
          }

          // Report result to draft system if this was a draft match
          if (draftInfo && result.winner) {
            const winnerId =
              result.winner === "player1"
                ? draftInfo.player1Id
                : draftInfo.player2Id;
            const loserId =
              result.winner === "player1"
                ? draftInfo.player2Id
                : draftInfo.player1Id;

            const { newRoundStarted } =
              draftRoomManager.reportMatchResult(
                draftInfo.draftRoomId,
                draftInfo.roundNumber,
                draftInfo.matchNumber,
                winnerId,
                loserId,
                roomId,
              );

            const draftRoom = draftRoomManager.getRoom(
              draftInfo.draftRoomId,
            );

            // Clear pending match info
            draftRoomManager.clearPendingMatchInfo(
              draftInfo.draftRoomId,
              winnerId,
            );
            draftRoomManager.clearPendingMatchInfo(
              draftInfo.draftRoomId,
              loserId,
            );

            // Notify players about the draft match ending
            if (draftRoom) {
              for (const p of draftRoom.players) {
                if (p.socketId) {
                  io.to(p.socketId).emit("draft:matchEnded", {
                    draftRoomId: draftInfo.draftRoomId,
                    winnerId,
                    loserId,
                    forfeit: false,
                    tournamentFinished: draftRoom.phase === "finished",
                  });
                }
              }
            }

            // Create games for next round if needed
            if (newRoundStarted && draftRoom?.tournament) {
              createMatchGames(
                io,
                draftInfo.draftRoomId,
                draftRoom.tournament.currentRoundNumber,
                roomManager,
              ).catch((err) => {
                console.error("Error creating next round games:", err);
              });
            }
          }
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

    // Register draft events on this socket (pass roomManager for match creation)
    registerDraftEvents(io, socket, roomManager);
  });

  // Set up forfeit callback for disconnect timeout
  roomManager.setOnForfeit((roomId, winner, gameState) => {
    io.to(roomId).emit("gameOver", {
      winner,
      reason: "Oponente desconectado (tiempo de espera agotado)",
    });

    // Persist win/loss stats to database
    const room = roomManager.getRoom(roomId);
    const draftInfo = draftRoomManager.getDraftInfoForGameRoom(roomId);
    if (room?.player1Id && room?.player2Id) {
      const mode = draftInfo ? "draft" as const : "normal" as const;
      const winnerId = winner === "player1" ? room.player1Id : room.player2Id;
      const loserId = winner === "player1" ? room.player2Id : room.player1Id;
      recordMatchResult(winnerId, mode, true).then(() => checkAndUpdateProgress(winnerId)).catch(console.error);
      recordMatchResult(loserId, mode, false).then(() => checkAndUpdateProgress(loserId)).catch(console.error);
    }

    // Report to draft system if this was a draft match
    if (draftInfo) {
      const winnerId =
        winner === "player1" ? draftInfo.player1Id : draftInfo.player2Id;
      const loserId =
        winner === "player1" ? draftInfo.player2Id : draftInfo.player1Id;

      const { newRoundStarted } = draftRoomManager.reportMatchResult(
        draftInfo.draftRoomId,
        draftInfo.roundNumber,
        draftInfo.matchNumber,
        winnerId,
        loserId,
        roomId,
      );

      // Clear pending match info
      draftRoomManager.clearPendingMatchInfo(draftInfo.draftRoomId, winnerId);
      draftRoomManager.clearPendingMatchInfo(draftInfo.draftRoomId, loserId);

      const draftRoom = draftRoomManager.getRoom(draftInfo.draftRoomId);

      // Notify draft players about the match ending
      if (draftRoom) {
        for (const p of draftRoom.players) {
          if (p.socketId) {
            io.to(p.socketId).emit("draft:matchEnded", {
              draftRoomId: draftInfo.draftRoomId,
              winnerId,
              loserId,
              forfeit: true,
              tournamentFinished: draftRoom.phase === "finished",
            });
          }
        }
      }

      // Create games for next round if needed
      if (newRoundStarted && draftRoom?.tournament) {
        createMatchGames(
          io,
          draftInfo.draftRoomId,
          draftRoom.tournament.currentRoundNumber,
          roomManager,
        ).catch((err) => {
          console.error("Error creating next round games:", err);
        });
      }
    }
  });
}
