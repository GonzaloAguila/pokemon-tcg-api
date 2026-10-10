/**
 * Draft Socket Event Handlers
 *
 * Registers all draft-related socket events on each connected socket.
 * Called from the main setupSocketHandlers to keep draft logic isolated.
 */

import type { Server, Socket } from "socket.io";
import type { z } from "zod";
import { DraftRoomManager } from "./draft-rooms.js";
import { GameRoomManager } from "./rooms.js";
import { maskGameStateForPlayer } from "./state-masking.js";
import { prisma } from "../lib/prisma.js";
import * as usersService from "../modules/users/users.service.js";
import { draftSchemas, parsePayload } from "./schemas.js";
import { requireSocketUser } from "./session-guard.js";

// Singleton draft room manager (exported for game-over reporting)
export const draftRoomManager = new DraftRoomManager();

/**
 * Broadcast masked draft state to all connected players in a room,
 * and to the spectating admin if they are not in the players array.
 */
function broadcastDraftState(io: Server, roomId: string): void {
  const room = draftRoomManager.getRoom(roomId);
  if (!room) return;

  const sentSocketIds = new Set<string>();

  for (const player of room.players) {
    if (player.socketId) {
      const masked = draftRoomManager.getMaskedState(roomId, player.socketId);
      io.to(player.socketId).emit("draft:state", masked);
      sentSocketIds.add(player.socketId);
    }
  }

  // Also send to spectating admin (when adminPlays is false)
  if (room.adminSocketId && !sentSocketIds.has(room.adminSocketId)) {
    const masked = draftRoomManager.getMaskedState(roomId, room.adminSocketId);
    io.to(room.adminSocketId).emit("draft:state", masked);
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

    // Store pending match info for reconnection
    draftRoomManager.setPendingMatchInfo(draftRoomId, p1.id, {
      gameRoomId,
      matchNumber: pairing.matchNumber,
      roundNumber,
      isPlayer1: true,
      opponentName: p2.name,
    });
    draftRoomManager.setPendingMatchInfo(draftRoomId, p2.id, {
      gameRoomId,
      matchNumber: pairing.matchNumber,
      roundNumber,
      isPlayer1: false,
      opponentName: p1.name,
    });

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

/** Rooms whose start (and entry-fee charging) is in flight, to ignore duplicate start requests. */
const startingRooms = new Set<string>();

/** Refunds and removes each id from `playerIds` as it goes, so a retry never refunds anyone twice. */
async function refundDraftEntry(playerIds: string[], entryFee: number) {
  while (playerIds.length > 0) {
    await usersService.addCoins(playerIds[0], entryFee, "draft_refund", "Reintegro de inscripcion a draft");
    playerIds.shift();
  }
}

/**
 * Authenticated, active (not banned/suspended/deleted) user for a draft event, or null after
 * emitting draft:error (blocked users are disconnected).
 */
function requireDraftUser(socket: Socket): Promise<string | null> {
  return requireSocketUser(socket, "draft:error");
}

/** Validate a draft payload; emits draft:error and returns null when invalid. */
function parseDraft<S extends z.ZodTypeAny>(socket: Socket, schema: S, payload: unknown): z.output<S> | null {
  const parsed = parsePayload(schema, payload);
  if (!parsed.ok) {
    socket.emit("draft:error", { message: parsed.error });
    return null;
  }
  return parsed.data;
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
    async (payload: unknown) => {
      try {
        // Identity comes from the verified handshake JWT, never from the payload
        const userId = await requireDraftUser(socket);
        if (!userId) return;
        const data = parseDraft(socket, draftSchemas.create, payload);
        if (!data) return;
        const config = data.config;

        // Only admins and superadmins can create draft rooms
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, username: true },
        });
        if (!user || (user.role !== "admin" && user.role !== "superadmin")) {
          socket.emit("draft:error", {
            message: "Solo los administradores pueden crear salas de draft",
          });
          return;
        }

        const name = user.username;
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
    async (payload: unknown) => {
      try {
        const userId = await requireDraftUser(socket);
        if (!userId) return;
        const data = parseDraft(socket, draftSchemas.roomRef, payload);
        if (!data) return;
        const roomId = data.roomId;
        const account = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true },
        });
        if (!account) {
          socket.emit("draft:error", { message: "Solicitud invalida" });
          return;
        }
        const name = account.username;

        // Check if the player has enough coins for the entry fee (new players only)
        const existingRoom = draftRoomManager.getRoom(roomId);
        if (existingRoom && existingRoom.phase === "lobby") {
          const isReconnect = existingRoom.players.some((p) => p.id === userId);
          const isSpectatingAdmin = existingRoom.adminId === userId && !existingRoom.config.adminPlays;
          if (!isReconnect && !isSpectatingAdmin && existingRoom.config.entryFee > 0) {
            const user = await prisma.user.findUnique({
              where: { id: userId },
              select: { coins: true },
            });
            if (!user || user.coins < existingRoom.config.entryFee) {
              socket.emit("draft:error", {
                message: `No tienes suficientes monedas para unirte (necesitas ${existingRoom.config.entryFee})`,
              });
              return;
            }
          }
        }

        const room = draftRoomManager.joinRoom(roomId, userId, socket.id, name);

        socket.join(room.id);
        broadcastDraftState(io, roomId);
        broadcastRoomList(io);

        // Re-send pending match info if player reconnected during matching phase
        const pendingMatch = draftRoomManager.getPendingMatchInfo(roomId, userId);
        if (pendingMatch && room.phase === "matching") {
          const gameRoom = gameRoomManager.getRoom(pendingMatch.gameRoomId);
          if (gameRoom?.gameState) {
            socket.emit("draft:matchReady", {
              matchNumber: pendingMatch.matchNumber,
              roundNumber: pendingMatch.roundNumber,
              draftRoomId: roomId,
              gameRoomId: pendingMatch.gameRoomId,
              userId,
              isPlayer1: pendingMatch.isPlayer1,
              opponentName: pendingMatch.opponentName,
              gameState: maskGameStateForPlayer(
                gameRoom.gameState,
                pendingMatch.isPlayer1 ? "player1" : "player2",
              ),
            });
          }
        }

        console.log(`🎴 ${name} joined draft room ${roomId}`);
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  socket.on("draft:leave", async (payload: unknown) => {
    try {
      if (!(await requireDraftUser(socket))) return;
      const data = parseDraft(socket, draftSchemas.roomRef, payload);
      if (!data) return;
      const { roomId } = data;
      const room = draftRoomManager.leaveRoom(roomId, socket.id);

      socket.leave(roomId);
      if (room) broadcastDraftState(io, roomId);
      broadcastRoomList(io);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  socket.on("draft:delete", async (payload: unknown) => {
    try {
      if (!(await requireDraftUser(socket))) return;
      const data = parseDraft(socket, draftSchemas.roomRef, payload);
      if (!data) return;
      const { roomId } = data;
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

  socket.on("draft:start", async (payload: unknown) => {
    if (!(await requireDraftUser(socket))) return;
    const data = parseDraft(socket, draftSchemas.roomRef, payload);
    if (!data) return;
    const roomId = data.roomId;
    if (startingRooms.has(roomId)) return; // a start (and its charging) is already in progress
    const charged: string[] = [];
    let entryFee = 0;
    try {
      // Authorize and validate BEFORE charging anyone (throws -> draft:error)
      const room = draftRoomManager.assertCanStart(roomId, socket.id);
      startingRooms.add(roomId);
      entryFee = room.config.entryFee;

      if (entryFee > 0) {
        // Charge each non-admin player atomically; anyone who can't pay is removed
        for (const player of [...room.players]) {
          if (player.isAdmin) continue; // admin doesn't pay
          const paid = await usersService
            .spendCoins(player.id, entryFee, "draft_entry", `Inscripcion a draft (${entryFee} monedas)`)
            .then(() => true, () => false);
          if (paid) {
            charged.push(player.id);
            continue;
          }
          const removedPlayer = draftRoomManager.removePlayer(roomId, player.id);
          const kickedSocket = removedPlayer?.socketId ? io.sockets.sockets.get(removedPlayer.socketId) : undefined;
          if (kickedSocket) {
            kickedSocket.emit("draft:error", {
              message: "No tienes suficientes monedas. Fuiste removido del draft.",
            });
            kickedSocket.leave(roomId);
          }
        }

        const remainingRoom = draftRoomManager.getRoom(roomId);
        if (!remainingRoom || remainingRoom.players.length < 2) {
          await refundDraftEntry(charged, entryFee);
          socket.emit("draft:error", {
            message: "No hay suficientes jugadores con fondos para iniciar.",
          });
          // Broadcast updated state so clients see the kicked players removed
          broadcastDraftState(io, roomId);
          return;
        }
      }

      draftRoomManager.startDraft(roomId, socket.id);
      broadcastDraftState(io, roomId);
      broadcastRoomList(io); // room no longer visible in lobby

      console.log(`🎴 Draft started in room ${roomId}`);
    } catch (error) {
      // If anything failed after charging, give the entry fees back
      await refundDraftEntry(charged, entryFee).catch((e) => console.error("Draft refund failed:", e));
      socket.emit("draft:error", { message: (error as Error).message });
    } finally {
      startingRooms.delete(roomId);
    }
  });

  socket.on("draft:pick", async (payload: unknown) => {
    try {
      if (!(await requireDraftUser(socket))) return;
      const data = parseDraft(socket, draftSchemas.pick, payload);
      if (!data) return;
      const { roomId, cardId } = data;
      draftRoomManager.pickCard(roomId, socket.id, cardId);
      broadcastDraftState(io, roomId);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  socket.on(
    "draft:bonusPick",
    async (payload: unknown) => {
      try {
        if (!(await requireDraftUser(socket))) return;
        const data = parseDraft(socket, draftSchemas.bonusPick, payload);
        if (!data) return;
        const { roomId, cardDefIds } = data;
        draftRoomManager.bonusPick(roomId, socket.id, cardDefIds);
        broadcastDraftState(io, roomId);
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  socket.on(
    "draft:submitDeck",
    async (payload: unknown) => {
      try {
        if (!(await requireDraftUser(socket))) return;
        const data = parseDraft(socket, draftSchemas.submitDeck, payload);
        if (!data) return;
        const { roomId, deckCardIds, energyCards } = data;
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
    async (payload: unknown) => {
      try {
        if (!(await requireDraftUser(socket))) return;
        const data = parseDraft(socket, draftSchemas.forfeit, payload);
        if (!data) return;
        const { draftRoomId, gameRoomId } = data;
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

        // Clear pending match info
        draftRoomManager.clearPendingMatchInfo(draftRoomId, winnerId);
        draftRoomManager.clearPendingMatchInfo(draftRoomId, loserId);

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
