/**
 * Draft Socket Event Handlers
 *
 * Registers all draft-related socket events on each connected socket.
 * Called from the main setupSocketHandlers to keep draft logic isolated.
 */

import type { Server, Socket } from "socket.io";
import { DraftRoomManager } from "./draft-rooms.js";
import { GameRoomManager } from "./rooms.js";
import { maskGameStateForPlayer } from "./state-masking.js";
import type { DraftConfig } from "./draft-rooms.js";

// Singleton draft room manager (exported for game-over reporting)
export const draftRoomManager = new DraftRoomManager();

/**
 * Broadcast masked draft state to all connected players in a room.
 */
function broadcastDraftState(io: Server, roomId: string): void {
  const room = draftRoomManager.getRoom(roomId);
  if (!room) return;

  for (const player of room.players) {
    if (player.socketId) {
      const masked = draftRoomManager.getMaskedState(roomId, player.socketId);
      io.to(player.socketId).emit("draft:state", masked);
    }
  }
}

/**
 * Broadcast the updated draft room list to all connected clients.
 */
function broadcastRoomList(io: Server): void {
  io.emit("draft:roomList", draftRoomManager.getAvailableRooms());
}

/**
 * Create game rooms for a specific tournament round and notify players.
 */
export async function createMatchGames(
  io: Server,
  draftRoomId: string,
  roundNumber: number,
  gameRoomManager: GameRoomManager,
): Promise<void> {
  const draftRoom = draftRoomManager.getRoom(draftRoomId);
  if (!draftRoom || !draftRoom.tournament) return;

  const round = draftRoom.tournament.rounds.find(
    (r) => r.roundNumber === roundNumber,
  );
  if (!round) return;

  for (const pairing of round.pairings) {
    const p1 = draftRoom.players.find((p) => p.id === pairing.player1.id);
    const p2 = draftRoom.players.find((p) => p.id === pairing.player2.id);
    if (!p1 || !p2 || !p1.deck || !p2.deck) continue;

    // Create a game room and add both players
    const gameRoom = gameRoomManager.createRoom();
    const gameRoomId = gameRoom.id;

    await gameRoomManager.joinRoom(gameRoomId, p1.id, p1.socketId || "");
    await gameRoomManager.joinRoom(gameRoomId, p2.id, p2.socketId || "");

    // Register mapping so game-over can report back to draft
    draftRoomManager.registerGameRoom(
      gameRoomId,
      draftRoomId,
      roundNumber,
      pairing.matchNumber,
      p1.id,
      p2.id,
    );

    // Start the game with their drafted decks
    const gameState = await gameRoomManager.startGameWithRawDecks(
      gameRoomId,
      [...p1.deck],
      [...p2.deck],
    );

    console.log(
      `🎮 Draft match R${roundNumber}-M${pairing.matchNumber}: ${p1.name} vs ${p2.name} → room ${gameRoomId}`,
    );

    // Notify each player with their match info
    if (p1.socketId) {
      io.to(p1.socketId).emit("draft:matchReady", {
        matchNumber: pairing.matchNumber,
        roundNumber,
        draftRoomId,
        gameRoomId,
        userId: p1.id,
        isPlayer1: true,
        opponentName: p2.name,
        gameState: maskGameStateForPlayer(gameState, "player1"),
      });
    }

    if (p2.socketId) {
      io.to(p2.socketId).emit("draft:matchReady", {
        matchNumber: pairing.matchNumber,
        roundNumber,
        draftRoomId,
        gameRoomId,
        userId: p2.id,
        isPlayer1: false,
        opponentName: p1.name,
        gameState: maskGameStateForPlayer(gameState, "player2"),
      });
    }
  }
}

/**
 * Register draft socket events on a connected socket.
 */
export function registerDraftEvents(
  io: Server,
  socket: Socket,
  gameRoomManager: GameRoomManager,
): void {
  // Set up the broadcast callback (idempotent)
  draftRoomManager.setBroadcast((roomId) => broadcastDraftState(io, roomId));

  // --------------------------------------------------------------------------
  // Lobby
  // --------------------------------------------------------------------------

  socket.on("draft:getRooms", () => {
    socket.emit("draft:roomList", draftRoomManager.getAvailableRooms());
  });

  socket.on(
    "draft:create",
    (payload: { userId: string; name: string; config?: Partial<DraftConfig> }) => {
      try {
        const { userId, name, config } = payload;
        const room = draftRoomManager.createRoom(
          config ?? {},
          userId,
          socket.id,
          name,
        );

        socket.join(room.id);
        socket.emit("draft:created", { roomId: room.id });
        broadcastDraftState(io, room.id);
        broadcastRoomList(io);

        console.log(`🎴 Draft room ${room.id} created by ${name}`);
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  socket.on(
    "draft:join",
    (payload: { roomId: string; userId: string; name: string }) => {
      try {
        const { roomId, userId, name } = payload;
        const room = draftRoomManager.joinRoom(roomId, userId, socket.id, name);

        socket.join(room.id);
        broadcastDraftState(io, roomId);
        broadcastRoomList(io);

        console.log(`🎴 ${name} joined draft room ${roomId}`);
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  socket.on("draft:leave", (payload: { roomId: string }) => {
    try {
      const { roomId } = payload;
      const room = draftRoomManager.leaveRoom(roomId, socket.id);

      socket.leave(roomId);
      if (room) broadcastDraftState(io, roomId);
      broadcastRoomList(io);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  socket.on("draft:delete", (payload: { roomId: string }) => {
    try {
      const { roomId } = payload;
      const deleted = draftRoomManager.deleteRoom(roomId, socket.id);

      if (deleted) {
        io.to(roomId).emit("draft:roomClosed");
        broadcastRoomList(io);
        console.log(`🗑️ Draft room ${roomId} deleted`);
      }
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  // --------------------------------------------------------------------------
  // Draft Actions
  // --------------------------------------------------------------------------

  socket.on("draft:start", (payload: { roomId: string }) => {
    try {
      const { roomId } = payload;
      draftRoomManager.startDraft(roomId, socket.id);
      broadcastDraftState(io, roomId);
      broadcastRoomList(io); // room no longer visible in lobby

      console.log(`🎴 Draft started in room ${roomId}`);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  socket.on("draft:pick", (payload: { roomId: string; cardId: string }) => {
    try {
      const { roomId, cardId } = payload;
      draftRoomManager.pickCard(roomId, socket.id, cardId);
      broadcastDraftState(io, roomId);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  socket.on(
    "draft:submitDeck",
    (payload: {
      roomId: string;
      deckCardIds: string[];
      energyCards: { type: string; count: number }[];
    }) => {
      try {
        const { roomId, deckCardIds, energyCards } = payload;
        const room = draftRoomManager.submitDeck(roomId, socket.id, deckCardIds, energyCards);
        broadcastDraftState(io, roomId);

        // If phase just changed to matching, create game rooms for round 1
        if (room.phase === "matching" && room.tournament) {
          createMatchGames(
            io,
            roomId,
            room.tournament.currentRoundNumber,
            gameRoomManager,
          ).catch((err) => {
            console.error("Error creating draft match games:", err);
          });
        }
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  // --------------------------------------------------------------------------
  // Forfeit (voluntary disconnect from draft match)
  // --------------------------------------------------------------------------

  socket.on(
    "draft:forfeit",
    (payload: { draftRoomId: string; gameRoomId: string }) => {
      try {
        const { draftRoomId, gameRoomId } = payload;
        const draftInfo = draftRoomManager.getDraftInfoForGameRoom(gameRoomId);
        if (!draftInfo) return;

        // Determine who is forfeiting (the socket caller) and who wins
        const draftRoom = draftRoomManager.getRoom(draftRoomId);
        if (!draftRoom) return;

        const forfeitingPlayer = draftRoom.players.find(
          (p) => p.socketId === socket.id,
        );
        if (!forfeitingPlayer) return;

        const winnerId =
          draftInfo.player1Id === forfeitingPlayer.id
            ? draftInfo.player2Id
            : draftInfo.player1Id;
        const loserId = forfeitingPlayer.id;

        // Report result
        const { newRoundStarted } = draftRoomManager.reportMatchResult(
          draftRoomId,
          draftInfo.roundNumber,
          draftInfo.matchNumber,
          winnerId,
          loserId,
          gameRoomId,
        );

        // Notify both players in the game room
        const winnerPlayer = draftRoom.players.find(
          (p) => p.id === winnerId,
        );

        // End the game room
        const gameRoom = gameRoomManager.getRoom(gameRoomId);
        if (gameRoom) {
          io.to(gameRoomId).emit("gameOver", {
            winner: winnerId === draftInfo.player1Id ? "player1" : "player2",
            reason: `${forfeitingPlayer.name} abandonó la partida`,
          });
        }

        // Notify both players about the draft match ending
        for (const p of draftRoom.players) {
          if (p.socketId) {
            io.to(p.socketId).emit("draft:matchEnded", {
              draftRoomId,
              winnerId,
              loserId,
              forfeit: true,
              tournamentFinished: draftRoom.phase === "finished",
            });
          }
        }

        // Create games for next round if needed
        if (newRoundStarted && draftRoom.tournament) {
          createMatchGames(
            io,
            draftRoomId,
            draftRoom.tournament.currentRoundNumber,
            gameRoomManager,
          ).catch((err) => {
            console.error("Error creating next round games:", err);
          });
        }

        console.log(
          `🏳️ ${forfeitingPlayer.name} forfeited draft match in room ${draftRoomId}`,
        );
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  // --------------------------------------------------------------------------
  // Disconnect
  // --------------------------------------------------------------------------

  socket.on("disconnect", () => {
    const room = draftRoomManager.handleDisconnect(socket.id);
    if (room) {
      broadcastDraftState(io, room.id);
      if (room.phase === "lobby") broadcastRoomList(io);
    }
  });
}
