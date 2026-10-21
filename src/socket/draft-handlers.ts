/**
 * Draft Socket Event Handlers
 *
 * Registers all draft-related socket events on each connected socket.
 * Called from the main setupSocketHandlers to keep draft logic isolated.
 */

import type { Server, Socket } from "socket.io";
import type { z } from "zod";
import { DraftMemberError, DraftRoomManager, catalogIdOf, type DraftClosedInfo, type DraftPlayer, type DraftRoom } from "./draft-rooms.js";
import { allowChatMessage, buildRoomChatMessage, rememberChatMessage } from "./room-chat.js";
import { SPECTATE_RATE_LIMITED, allowSpectate } from "./spectate-limit.js";
import { GameRoomManager } from "./rooms.js";
import { maskRoomState } from "./room-state.js";
import { snapshotRoomCosmetics } from "./room-cosmetics.js";
import { prisma } from "../lib/prisma.js";
import * as usersService from "../modules/users/users.service.js";
import { recordCardChange } from "../modules/users/card-ledger.js";
import { refreshProgressInBackground } from "../modules/achievements/achievements.service.js";
import { lockUsers } from "../modules/users/xp.service.js";
import { draftSchemas, parsePayload } from "./schemas.js";
import { requireSocketUser } from "./session-guard.js";
import { openRoomMatch, settleRoomResult } from "./match-settlement.js";
import { canGrantDraftRewards, canManageDraftRooms } from "../modules/admin/permissions.js";
import { ECONOMY } from "../modules/economy/config.js";
import { titleIdFromStats } from "../modules/users/titles.js";
import type { TournamentProgress } from "./draft-rooms.js";
import { logDraftRewards, payDraftPrizes } from "./draft-payout.js";
import { draftGameWasPlayed } from "./draft-rewards.js";

/**
 * Time a player has to show up in a draft game created for them. The next round's games are
 * created while the players of the last game are still on its game-over screen: the usual 2
 * minutes made them lose games they never saw.
 */
const DRAFT_CHECKIN_MS = 5 * 60_000;

// Singleton draft room manager (exported for game-over reporting)
export const draftRoomManager = new DraftRoomManager();

/** What a spectator is told when it tries to act in a draft (pick, build, start...). */
const SPECTATOR_ONLY_ERROR = "Los espectadores solo pueden mirar y chatear";

/**
 * Broadcast masked draft state to all connected players in a room, to the admin when it
 * doesn't play (not in the players array), and to every spectator (their own masking: no
 * pack or pool while picking). Then the lobbies' "En curso" list, when it changed.
 */
function broadcastDraftState(io: Server, roomId: string): void {
  const room = draftRoomManager.getRoom(roomId);
  if (!room) {
    broadcastLiveDrafts(io);
    return;
  }

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
    sentSocketIds.add(room.adminSocketId);
  }

  for (const spectatorSocketId of room.spectators.keys()) {
    if (sentSocketIds.has(spectatorSocketId)) continue;
    io.to(spectatorSocketId).emit("draft:state", draftRoomManager.getMaskedState(roomId, spectatorSocketId));
  }

  broadcastLiveDrafts(io);
}

/** The last "En curso" draft list sent to the lobbies (only re-sent when it changes). */
let lastLiveDrafts = "";
let pendingLiveDrafts: ReturnType<typeof setTimeout> | null = null;
/** Picks and spectators change it often: the lobbies get it at most once per this (trailing). */
const LIVE_DRAFTS_DELAY_MS = 1000;

/** draft:liveRooms: the drafts being played, to every client, when the list changed (throttled). */
function broadcastLiveDrafts(io: Server): void {
  if (pendingLiveDrafts) return;
  pendingLiveDrafts = setTimeout(() => {
    pendingLiveDrafts = null;
    const live = draftRoomManager.getLiveRooms();
    const signature = JSON.stringify(live);
    if (signature === lastLiveDrafts) return;
    lastLiveDrafts = signature;
    io.emit("draft:liveRooms", live);
  }, LIVE_DRAFTS_DELAY_MS);
  pendingLiveDrafts.unref?.();
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
    // Already decided (a player left the tournament): no game
    if (draftRoomManager.isMatchDecided(draftRoomId, roundNumber, pairing.matchNumber)) continue;
    const p1 = draftRoom.players.find((p) => p.id === pairing.player1.id);
    const p2 = draftRoom.players.find((p) => p.id === pairing.player2.id);
    if (!p1 || !p2) continue;
    // One failed game must not keep the other pairings from being created
    await createMatchGame(io, draftRoomId, roundNumber, pairing.matchNumber, p1, p2, gameRoomManager).catch((err) =>
      console.error(`[draft] Could not create the game R${roundNumber}-M${pairing.matchNumber} of room ${draftRoomId}:`, err),
    );
  }
  // The round's games can be watched now (state.liveGames)
  broadcastDraftState(io, draftRoomId);
}

/** bo3: the next game of a series still undecided (same two players, same seats). */
export async function createSeriesGame(
  io: Server,
  draftRoomId: string,
  roundNumber: number,
  matchNumber: number,
  gameRoomManager: GameRoomManager,
): Promise<void> {
  const draftRoom = draftRoomManager.getRoom(draftRoomId);
  if (!draftRoom || draftRoom.phase !== "matching") return;
  if (draftRoomManager.isMatchDecided(draftRoomId, roundNumber, matchNumber)) return;
  const pairing = draftRoom.tournament?.rounds
    .find((r) => r.roundNumber === roundNumber)
    ?.pairings.find((p) => p.matchNumber === matchNumber);
  const p1 = draftRoom.players.find((p) => p.id === pairing?.player1.id);
  const p2 = draftRoom.players.find((p) => p.id === pairing?.player2.id);
  if (!p1 || !p2) return;
  await createMatchGame(io, draftRoomId, roundNumber, matchNumber, p1, p2, gameRoomManager);
  broadcastDraftState(io, draftRoomId);
}

/** One draft match: a game room with both drafted decks, and each player told. */
async function createMatchGame(
  io: Server,
  draftRoomId: string,
  roundNumber: number,
  matchNumber: number,
  p1: DraftPlayer,
  p2: DraftPlayer,
  gameRoomManager: GameRoomManager,
): Promise<void> {
  if (!p1.deck || !p2.deck) return;
  const [p1Identity, p2Identity] = await Promise.all([draftGameIdentity(p1), draftGameIdentity(p2)]);
  // The draft may have been closed (or the match decided: a player left) while the games were being created
  if (!draftRoomManager.getRoom(draftRoomId) || draftRoomManager.isMatchDecided(draftRoomId, roundNumber, matchNumber)) return;

  // Create a game room (names and avatars for the game screen; not listed in the lobby) and add
  // both players. Their seats wait for them (no socket): each one's check-in clock runs until
  // they open the game, so a player who never shows up can't hold the round forever.
  const gameRoom = gameRoomManager.createRoom(undefined, undefined, p1Identity);
  gameRoom.isDraft = true;
  const gameRoomId = gameRoom.id;

  await gameRoomManager.joinRoom(gameRoomId, p1.id, "");
  await gameRoomManager.joinRoom(gameRoomId, p2.id, "", p2Identity);

  // Register mapping so game-over can report back to draft
  draftRoomManager.registerGameRoom(gameRoomId, draftRoomId, roundNumber, matchNumber, p1.id, p2.id);

  // Match row for the result (stats + XP); no bets in drafts
  await openRoomMatch(gameRoom, "draft").catch((err) =>
    console.error(`[draft] Could not open the match of room ${gameRoomId}:`, err),
  );

  // Start the game with their drafted decks
  const draftPrizeCount = draftRoomManager.getRoom(draftRoomId)?.config.prizeCount ?? 6;
  const gameState = await gameRoomManager.startGameWithRawDecks(gameRoomId, [...p1.deck], [...p2.deck], draftPrizeCount);
  // Both players' playmat, coin and card back (owned only) for the game screen; drafted decks have no variants
  await snapshotRoomCosmetics(gameRoom);

  const gameNumber = draftRoomManager.currentGameNumber(draftRoomId, roundNumber, matchNumber);
  const draftRoom = draftRoomManager.getRoom(draftRoomId);
  const matchFormat = draftRoom?.config.matchFormat ?? "bo1";
  const pairing = draftRoom?.tournament?.rounds
    .find((r) => r.roundNumber === roundNumber)
    ?.pairings.find((p) => p.matchNumber === matchNumber);
  const wins = { ...(pairing?.wins ?? {}) };
  console.log(`🎮 Draft match R${roundNumber}-M${matchNumber} G${gameNumber}: ${p1.name} vs ${p2.name} → room ${gameRoomId}`);
  // A player who isn't connected right now (e.g. still on the last game's screen) has
  // DRAFT_CHECKIN_MS to show up
  gameRoomManager.ensureForfeitTimers(gameRoomId, DRAFT_CHECKIN_MS);

  // Store pending match info for reconnection, and tell each player
  for (const [player, opponent, isPlayer1] of [
    [p1, p2, true],
    [p2, p1, false],
  ] as const) {
    draftRoomManager.setPendingMatchInfo(draftRoomId, player.id, {
      gameRoomId,
      matchNumber,
      roundNumber,
      isPlayer1,
      opponentName: opponent.name,
      gameNumber,
    });
    if (player.socketId) {
      io.to(player.socketId).emit("draft:matchReady", {
        matchNumber,
        roundNumber,
        draftRoomId,
        gameRoomId,
        userId: player.id,
        isPlayer1,
        opponentName: opponent.name,
        matchFormat,
        gameNumber,
        wins,
        gameState: maskRoomState(gameRoomManager, gameRoom, gameState, isPlayer1 ? "player1" : "player2"),
      });
    }
  }
}

/** Name, avatar and title shown to the rival in a draft game (from the DB). */
async function draftGameIdentity(player: DraftPlayer): Promise<{ username: string; avatarId: string | null; titleId: string }> {
  const user = await prisma.user.findUnique({
    where: { id: player.id },
    select: {
      activeAvatarId: true,
      role: true,
      stats: {
        select: {
          normalWins: true, normalLosses: true, rankedWins: true, rankedLosses: true,
          draftWins: true, draftLosses: true, bestStreak: true,
        },
      },
    },
  });
  return {
    username: player.name,
    avatarId: user?.activeAvatarId ?? null,
    titleId: titleIdFromStats(user?.stats, user?.role),
  };
}

/**
 * A draft match was decided (game over, forfeit, a player left): tell the draft's players
 * (`gameRoomId` lets each client tell whether it was its match) and create the next round's
 * games when one started.
 */
export function announceDraftResult(
  io: Server,
  draftRoomId: string,
  result: { gameRoomId: string; winnerId: string | null; loserId: string | null; forfeit: boolean },
  progress: TournamentProgress,
  gameRoomManager: GameRoomManager,
): void {
  const draftRoom = draftRoomManager.getRoom(draftRoomId);
  if (!draftRoom) return;
  for (const p of draftRoom.players) {
    if (p.socketId) {
      io.to(p.socketId).emit("draft:matchEnded", {
        draftRoomId,
        ...result,
        tournamentFinished: draftRoom.phase === "finished",
        // bo3: false while the series goes on (its next game comes as draft:matchReady)
        seriesFinished: !progress.nextGame,
      });
    }
  }
  // Results and the games still being played (spectators follow the bracket from the state)
  broadcastDraftState(io, draftRoomId);
  if (progress.nextGame) {
    createSeriesGame(io, draftRoomId, progress.nextGame.roundNumber, progress.nextGame.matchNumber, gameRoomManager).catch(
      (err) => console.error("Error creating the next game of a series:", err),
    );
  }
  if (progress.newRoundStarted && draftRoom.tournament) {
    createMatchGames(io, draftRoomId, draftRoom.tournament.currentRoundNumber, gameRoomManager).catch((err) => {
      console.error("Error creating next round games:", err);
    });
  }
}

/**
 * The penalty for leaving a tournament early: ECONOMY.draft.withdrawPenalty, or every coin the
 * player has when they have less. Returns what was charged.
 */
async function chargeWithdrawPenalty(userId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await lockUsers(tx, [userId]);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
    const amount = Math.min(ECONOMY.draft.withdrawPenalty, Math.max(0, user?.coins ?? 0));
    if (amount > 0) {
      await usersService.spendCoins(userId, amount, "draft_withdraw", "Penalización por abandonar un draft", tx);
    }
    return amount;
  });
}

/** End a draft game in progress (the other player forfeited it): `winnerId` wins it (stats + XP settled once). */
function endDraftGame(io: Server, gameRoomManager: GameRoomManager, gameRoomId: string, winnerId: string, reason: string): void {
  const gameRoom = gameRoomManager.getRoom(gameRoomId);
  if (!gameRoom || gameRoom.resultSettled) return;
  gameRoom.status = "finished";
  const winnerSide = winnerId === gameRoom.player1Id ? "player1" : "player2";
  settleRoomResult(io, gameRoom, winnerSide, reason, { isDraft: true, forfeit: true });
  io.to(gameRoomId).emit("gameOver", { winner: winnerSide, reason });
}

/** Rooms whose start (and entry-fee charging) is in flight, to ignore duplicate start requests. */
const startingRooms = new Set<string>();
/** Players whose withdrawal (and penalty) is in flight, to ignore a double click. */
const withdrawingUsers = new Set<string>();

/** Refunds and removes each id from `playerIds` as it goes, so a retry never refunds anyone twice. */
async function refundDraftEntry(playerIds: string[], entryFee: number) {
  while (playerIds.length > 0) {
    await usersService.addCoins(playerIds[0], entryFee, "draft_refund", "Reintegro de inscripción a draft");
    playerIds.shift();
  }
}

/**
 * keepInCollection: every player still in the draft gets their drafted cards (packs + bonus
 * picks; not the basic Energy added while building) in ONE transaction, once per room.
 */
export async function creditDraftedCards(room: DraftRoom): Promise<void> {
  if (!room.config.keepInCollection || room.cardsCredited) return;
  room.cardsCredited = true;

  const grants: { userId: string; cardDefId: string; quantity: number }[] = [];
  for (const player of room.players) {
    const counts = new Map<string, number>();
    for (const card of player.draftedCards) {
      const cardDefId = catalogIdOf(card);
      if (cardDefId) counts.set(cardDefId, (counts.get(cardDefId) ?? 0) + 1);
    }
    for (const [cardDefId, quantity] of counts) grants.push({ userId: player.id, cardDefId, quantity });
  }
  if (grants.length === 0) return;

  try {
    // Accounts deleted meanwhile are skipped (their rows would fail the whole transaction)
    const existing = await prisma.user.findMany({
      where: { id: { in: [...new Set(grants.map((g) => g.userId))] } },
      select: { id: true },
    });
    const alive = new Set(existing.map((u) => u.id));
    await prisma.$transaction(async (tx) => {
      // The tournament's last game is usually being settled at this very moment, and the
      // settlement (match-settlement.ts) locks both players' rows in id order. Take the same
      // ordered locks first: otherwise the user_cards upserts (FK locks on the users, in grant
      // order) deadlock with it and the settlement is lost.
      await lockUsers(tx, [...alive]);
      for (const g of grants) {
        if (!alive.has(g.userId)) continue;
        await tx.userCard.upsert({
          where: { userId_cardDefId: { userId: g.userId, cardDefId: g.cardDefId } },
          create: { userId: g.userId, cardDefId: g.cardDefId, quantity: g.quantity },
          update: { quantity: { increment: g.quantity } },
        });
      }
      for (const userId of alive) {
        const cards = grants.filter((g) => g.userId === userId);
        await recordCardChange(tx, userId, "draft", "Draft: cartas elegidas", cards, room.id);
      }
    }, { timeout: 15_000, maxWait: 10_000 });
    console.log(`🎴 Draft ${room.id}: drafted cards credited to ${alive.size} players`);
    // The drafted cards can complete a collection achievement ("Holo Completo")
    for (const userId of alive) refreshProgressInBackground(userId, "drafted cards");
  } catch (err) {
    console.error(`[draft] Could not credit the drafted cards of room ${room.id}:`, err);
  }
}

/**
 * A draft room closed: tell its clients, refund the entry fees when no tournament was played
 * (unplayed), or credit the drafted cards when the draft itself was completed.
 */
async function onDraftRoomClosed(
  io: Server,
  room: DraftRoom,
  info: DraftClosedInfo,
  gameRoomManager: GameRoomManager,
): Promise<void> {
  io.to(room.id).emit("draft:roomClosed", { roomId: room.id, reason: info.reason });
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit("draft:roomClosed", { roomId: room.id, reason: info.reason });
  }
  io.in(room.id).socketsLeave(room.id);
  broadcastRoomList(io);
  broadcastLiveDrafts(io);

  // Games of a cancelled tournament end without a result
  for (const gameRoomId of info.gameRoomIds) {
    io.to(gameRoomId).emit("gameOver", { winner: null, reason: info.reason });
    gameRoomManager.forceDeleteRoom(gameRoomId);
  }

  // No tournament played to the end: the entry fees come back
  if ((info.unplayed || info.cancelled) && room.entryPaidIds.length > 0) {
    await refundDraftEntry(room.entryPaidIds, room.config.entryFee).catch((err) =>
      console.error(`[draft] Refund of room ${room.id} failed:`, err),
    );
  }
  if (!info.unplayed) await creditDraftedCards(room);
}

/** The user id of the verified handshake token, or null. */
function getSocketUserId(socket: Socket): string | null {
  return socket.data.user?.userId ?? null;
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
  // Set up the broadcast callback and the hooks for steps the draft takes by itself
  // (timers, grace periods) — idempotent
  draftRoomManager.setBroadcast((roomId) => broadcastDraftState(io, roomId));
  draftRoomManager.setHooks({
    onTournamentStart: (room) => {
      createMatchGames(io, room.id, room.tournament?.currentRoundNumber ?? 1, gameRoomManager).catch((err) => {
        console.error("Error creating draft match games:", err);
      });
    },
    onRoomClosed: (room, info) => {
      onDraftRoomClosed(io, room, info, gameRoomManager).catch((err) => console.error("[draft] close failed:", err));
    },
    onPlayerRemoved: (room, player, { reason, refund }) => {
      if (player.socketId) {
        io.to(player.socketId).emit("draft:error", { message: reason });
        io.to(player.socketId).emit("draft:roomClosed", { roomId: room.id, reason });
        io.in(player.socketId).socketsLeave(room.id);
      }
      if (refund > 0) {
        refundDraftEntry([player.id], refund).catch((err) => console.error(`[draft] Refund of ${player.id} failed:`, err));
      }
    },
    onFinished: (room) => {
      creditDraftedCards(room).catch((err) => console.error("[draft] credit failed:", err));
      payDraftPrizes(room, { isAlive: () => draftRoomManager.getRoom(room.id) === room }).catch((err) =>
        console.error("[draft] prizes failed:", err),
      );
    },
  });

  /** A spectator can't act in the draft it watches: draft:error and true. */
  const rejectSpectator = (roomId: string): boolean => {
    if (!draftRoomManager.isSpectator(roomId, socket.id)) return false;
    socket.emit("draft:error", { message: SPECTATOR_ONLY_ERROR });
    return true;
  };

  // --------------------------------------------------------------------------
  // Lobby
  // --------------------------------------------------------------------------

  socket.on("draft:getRooms", () => {
    socket.emit("draft:roomList", draftRoomManager.getAvailableRooms());
  });

  // draft:getLiveRooms -> draft:liveRooms LiveDraftInfo[]: drafts being played, to watch them
  socket.on("draft:getLiveRooms", () => {
    socket.emit("draft:liveRooms", draftRoomManager.getLiveRooms());
  });

  // --------------------------------------------------------------------------
  // Spectators and chat
  // --------------------------------------------------------------------------

  // draft:spectate { roomId }: any signed-in user watches a draft already started. They get
  // draft:state (isSpectator: true; no card of anyone's pack or pool while picking) and
  // draft:chatHistory, and may only chat. A player or the admin of that draft gets
  // draft:error { code: "DRAFT_MEMBER" } (they draft:join).
  socket.on("draft:spectate", async (payload: unknown) => {
    try {
      const userId = await requireDraftUser(socket);
      if (!userId) return;
      const data = parseDraft(socket, draftSchemas.roomRef, payload);
      if (!data) return;
      if (!allowSpectate(socket.id)) {
        socket.emit("draft:error", SPECTATE_RATE_LIMITED);
        return;
      }
      const account = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
      if (!account) {
        socket.emit("draft:error", { message: "Solicitud inválida" });
        return;
      }
      const room = draftRoomManager.addSpectator(data.roomId, socket.id, userId, account.username);
      socket.join(room.id);
      socket.emit("draft:chatHistory", { roomId: room.id, messages: room.chat });
      broadcastDraftState(io, room.id);
      console.log(`👁️ ${account.username} watches draft ${room.id}`);
    } catch (error) {
      const code = error instanceof DraftMemberError ? error.code : undefined;
      socket.emit("draft:error", { message: (error as Error).message, ...(code ? { code } : {}) });
    }
  });

  // draft:stopSpectating { roomId }: back to the lobby (also on draft:leave / disconnect)
  socket.on("draft:stopSpectating", (payload: unknown) => {
    const parsed = parsePayload(draftSchemas.roomRef, payload);
    if (!parsed.ok) return;
    const room = draftRoomManager.removeSpectator(parsed.data.roomId, socket.id);
    if (!room) return;
    socket.leave(room.id);
    broadcastDraftState(io, room.id);
  });

  // draft:chat { roomId, content }: players, the admin and spectators of that draft write in
  // its chat -> draft:chatMessage RoomChatMessage (isSpectator: "Espectador") to the whole room
  socket.on("draft:chat", async (payload: unknown) => {
    const userId = await requireDraftUser(socket);
    if (!userId) return;
    const data = parseDraft(socket, draftSchemas.chat, payload);
    if (!data) return;
    const room = draftRoomManager.getRoom(data.roomId);
    if (!room || !draftRoomManager.canChat(room, socket.id)) return;
    if (!allowChatMessage(userId)) return;
    const message = await buildRoomChatMessage(userId, socket.id, data.content, room.spectators.has(socket.id));
    if (draftRoomManager.getRoom(room.id) !== room) return;
    rememberChatMessage(room.chat, message);
    io.to(room.id).emit("draft:chatMessage", { roomId: room.id, ...message });
  });

  // draft:getMyRoom: the draft this player is in the middle of → draft:myRoom { roomId, phase } | null
  socket.on("draft:getMyRoom", async () => {
    const userId = await requireDraftUser(socket);
    if (!userId) return;
    socket.emit("draft:myRoom", draftRoomManager.getActiveRoomOf(userId));
  });

  // draft:adminRooms (ack): every room in any phase, for admins who manage draft rooms
  socket.on("draft:adminRooms", async (_payload: unknown, ack?: (res: unknown) => void) => {
    if (typeof ack !== "function") return;
    const userId = await requireDraftUser(socket);
    if (!userId) return ack({ success: false, error: "Autenticación requerida" });
    const account = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, permissions: true } });
    if (!canManageDraftRooms(account)) return ack({ success: false, error: "No autorizado" });
    ack({ success: true, rooms: draftRoomManager.getAllRooms() });
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

        // Only admins who can manage rooms (not news-only moderators) create draft rooms
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, permissions: true, username: true },
        });
        if (!user || !canManageDraftRooms(user)) {
          socket.emit("draft:error", {
            message: "Solo los administradores pueden crear salas de draft",
          });
          return;
        }

        // Prizes are economy grants: only admins who may change balances set them
        if (config?.rewards?.length && !canGrantDraftRewards(user)) {
          socket.emit("draft:error", { message: "No tienes permiso para dar premios" });
          return;
        }

        const name = user.username;
        const room = draftRoomManager.createRoom(
          config ?? {},
          userId,
          socket.id,
          name,
        );
        if (room.config.rewards.length > 0) {
          // The admin log of these prizes comes first: a room whose prizes can't be logged isn't opened
          try {
            room.rewardsLogId = await logDraftRewards(room);
          } catch (err) {
            console.error(`[draft] Could not log the prizes of room ${room.id}:`, err);
            draftRoomManager.deleteRoom(room.id, userId, true);
            throw new Error("No se pudieron registrar los premios del draft");
          }
        }

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
          socket.emit("draft:error", { message: "Solicitud inválida" });
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

        const previousSocketId = existingRoom?.players.find((p) => p.id === userId)?.socketId ?? null;
        const room = draftRoomManager.joinRoom(roomId, userId, socket.id, name);
        // The draft was open in another tab / device: that one stops receiving it, say so
        if (previousSocketId && previousSocketId !== socket.id) {
          io.to(previousSocketId).emit("draft:replaced", { roomId });
        }

        socket.join(room.id);
        socket.emit("draft:chatHistory", { roomId: room.id, messages: room.chat });
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
              matchFormat: room.config.matchFormat,
              gameNumber: pendingMatch.gameNumber,
              wins: {
                ...room.tournament?.rounds
                  .find((r) => r.roundNumber === pendingMatch.roundNumber)
                  ?.pairings.find((p) => p.matchNumber === pendingMatch.matchNumber)?.wins,
              },
              gameState: maskRoomState(
                gameRoomManager,
                gameRoom,
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
      // A spectator leaving only stops watching
      if (draftRoomManager.removeSpectator(roomId, socket.id)) {
        socket.leave(roomId);
        broadcastDraftState(io, roomId);
        return;
      }
      const room = draftRoomManager.leaveRoom(roomId, socket.id);

      socket.leave(roomId);
      if (room) broadcastDraftState(io, roomId);
      broadcastRoomList(io);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  // draft:delete { roomId } (ack optional): the draft's admin from any socket, or a site
  // admin from the backoffice. Success: draft:roomDeleted { roomId } to the requester (+ ack
  // { success: true }); failure: draft:error { message } (+ ack { success: false, error }).
  socket.on("draft:delete", async (payload: unknown, ack?: (res: unknown) => void) => {
    const reply = typeof ack === "function" ? ack : () => {};
    try {
      const userId = await requireDraftUser(socket);
      if (!userId) {
        reply({ success: false, error: "Autenticación requerida" });
        return;
      }
      const data = parseDraft(socket, draftSchemas.roomRef, payload);
      if (!data) {
        reply({ success: false, error: "Datos inválidos" });
        return;
      }
      const { roomId } = data;
      const account = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, permissions: true } });
      const isSiteAdmin = canManageDraftRooms(account);
      draftRoomManager.deleteRoom(roomId, userId, isSiteAdmin);
      socket.emit("draft:roomDeleted", { roomId });
      reply({ success: true });
      console.log(`🗑️ Draft room ${roomId} deleted by ${userId}`);
    } catch (error) {
      const message = (error as Error).message;
      socket.emit("draft:error", { message });
      reply({ success: false, error: message });
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
    if (rejectSpectator(roomId)) return;
    if (startingRooms.has(roomId)) return; // a start (and its charging) is already in progress
    const charged: string[] = [];
    let entryFee = 0;
    try {
      // Authorize and validate BEFORE charging anyone (throws -> draft:error)
      const userId = getSocketUserId(socket);
      const room = draftRoomManager.assertCanStart(roomId, userId ?? "");
      startingRooms.add(roomId);
      draftRoomManager.setStarting(roomId, true);
      entryFee = room.config.entryFee;

      if (entryFee > 0) {
        // Charge each non-admin player atomically; anyone who can't pay is removed
        for (const player of [...room.players]) {
          // The draft's creator doesn't pay (a player who inherited the admin seat does)
          if (player.id === room.adminId) continue;
          const paid = await usersService
            .spendCoins(player.id, entryFee, "draft_entry", `Inscripción a draft (${entryFee} monedas)`)
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

        // Whoever was charged and left the lobby meanwhile gets the fee back
        const remainingRoom = draftRoomManager.getRoom(roomId);
        const leftAfterPaying = charged.filter((id) => !remainingRoom?.players.some((p) => p.id === id));
        if (leftAfterPaying.length > 0) {
          await refundDraftEntry(leftAfterPaying, entryFee);
          charged.splice(0, charged.length, ...charged.filter((id) => !leftAfterPaying.includes(id)));
        }
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

      draftRoomManager.startDraft(roomId, userId ?? "", charged);
      broadcastDraftState(io, roomId);
      broadcastRoomList(io); // room no longer visible in lobby

      console.log(`🎴 Draft started in room ${roomId}`);
    } catch (error) {
      // If anything failed after charging, give the entry fees back
      await refundDraftEntry(charged, entryFee).catch((e) => console.error("Draft refund failed:", e));
      socket.emit("draft:error", { message: (error as Error).message });
    } finally {
      startingRooms.delete(roomId);
      draftRoomManager.setStarting(roomId, false);
    }
  });

  socket.on("draft:pick", async (payload: unknown) => {
    try {
      if (!(await requireDraftUser(socket))) return;
      const data = parseDraft(socket, draftSchemas.pick, payload);
      if (!data) return;
      const { roomId, cardId } = data;
      if (rejectSpectator(roomId)) return;
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
        if (rejectSpectator(roomId)) return;
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
        if (rejectSpectator(roomId)) return;
        // When this was the last deck, the tournament starts (onTournamentStart creates the games)
        draftRoomManager.submitDeck(roomId, socket.id, deckCardIds, energyCards);
        broadcastDraftState(io, roomId);
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  // draft:editDeck { roomId }: a player who sent their deck goes back to editing it (isReady
  // false), only while the room is still building (once every deck is in the tournament starts
  // and decks are final). Everyone gets the new draft:state; refusals are a draft:error.
  socket.on("draft:editDeck", async (payload: unknown) => {
    try {
      if (!(await requireDraftUser(socket))) return;
      const data = parseDraft(socket, draftSchemas.roomRef, payload);
      if (!data) return;
      if (rejectSpectator(data.roomId)) return;
      draftRoomManager.unreadyDeck(data.roomId, socket.id);
      broadcastDraftState(io, data.roomId);
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  // --------------------------------------------------------------------------
  // Forfeit (voluntary disconnect from draft match)
  // --------------------------------------------------------------------------

  socket.on(
    "draft:forfeit",
    async (payload: unknown) => {
      try {
        const userId = await requireDraftUser(socket);
        if (!userId) return;
        const data = parseDraft(socket, draftSchemas.forfeit, payload);
        if (!data) return;
        const { draftRoomId, gameRoomId } = data;
        if (rejectSpectator(draftRoomId)) return;
        const draftInfo = draftRoomManager.getDraftInfoForGameRoom(gameRoomId);
        if (!draftInfo || draftInfo.draftRoomId !== draftRoomId) {
          socket.emit("draft:error", { message: "Partida de draft no encontrada" });
          return;
        }

        // Only one of that game's two players can forfeit it (by user id, never the socket's
        // seat in the draft: anyone in the draft could otherwise end someone else's game)
        if (userId !== draftInfo.player1Id && userId !== draftInfo.player2Id) {
          socket.emit("draft:error", { message: "No juegas esta partida" });
          return;
        }

        const draftRoom = draftRoomManager.getRoom(draftRoomId);
        if (!draftRoom) return;

        const gameRoomBefore = gameRoomManager.getRoom(gameRoomId);
        if (gameRoomBefore && (gameRoomBefore.status !== "playing" || gameRoomBefore.resultSettled)) {
          socket.emit("draft:error", { message: "La partida ya terminó" });
          return;
        }

        const forfeitingPlayer = draftRoom.players.find((p) => p.id === userId);
        if (!forfeitingPlayer) return;

        const winnerId =
          draftInfo.player1Id === forfeitingPlayer.id
            ? draftInfo.player2Id
            : draftInfo.player1Id;
        const loserId = forfeitingPlayer.id;

        const progress = draftRoomManager.reportMatchResult(
          draftRoomId,
          draftInfo.roundNumber,
          draftInfo.matchNumber,
          winnerId,
          loserId,
          gameRoomId,
          draftGameWasPlayed(gameRoomManager.getRoom(gameRoomId)?.gameState),
        );
        // The forfeiter loses the game (the room was checked to be still playing above)
        endDraftGame(io, gameRoomManager, gameRoomId, winnerId, `${forfeitingPlayer.name} abandonó la partida`);
        announceDraftResult(io, draftRoomId, { gameRoomId, winnerId, loserId, forfeit: true }, progress, gameRoomManager);

        console.log(
          `🏳️ ${forfeitingPlayer.name} forfeited draft match in room ${draftRoomId}`,
        );
      } catch (error) {
        socket.emit("draft:error", { message: (error as Error).message });
      }
    },
  );

  // --------------------------------------------------------------------------
  // Withdraw (leave the tournament early)
  // --------------------------------------------------------------------------

  // draft:withdraw { roomId }: the player leaves the tournament (only while it is being played):
  // ECONOMY.draft.withdrawPenalty coins (to the prize pool), every match of theirs not played yet
  // is won by the rival (the game in progress too), no prize. Answer: draft:withdrawn { penalty }.
  socket.on("draft:withdraw", async (payload: unknown) => {
    try {
      const userId = await requireDraftUser(socket);
      if (!userId) return;
      const data = parseDraft(socket, draftSchemas.roomRef, payload);
      if (!data) return;
      const { roomId } = data;
      if (rejectSpectator(roomId)) return;
      if (withdrawingUsers.has(userId)) return;
      withdrawingUsers.add(userId);
      try {
        draftRoomManager.assertCanWithdraw(roomId, userId);
        const penalty = await chargeWithdrawPenalty(userId);
        let result: ReturnType<typeof draftRoomManager.withdrawPlayer>;
        try {
          result = draftRoomManager.withdrawPlayer(roomId, userId, penalty);
        } catch (error) {
          // The tournament ended meanwhile: give the penalty back
          if (penalty > 0) {
            await usersService.addCoins(userId, penalty, "draft_refund", "Reintegro de penalización de draft").catch((e) =>
              console.error("[draft] Penalty refund failed:", e),
            );
          }
          throw error;
        }

        const room = draftRoomManager.getRoom(roomId);
        const name = room?.players.find((p) => p.id === userId)?.name ?? "Un jugador";
        for (const gameRoomId of result.gameRoomIds) {
          const gameRoom = gameRoomManager.getRoom(gameRoomId);
          const winnerId = gameRoom?.player1Id === userId ? gameRoom.player2Id : gameRoom?.player1Id;
          if (winnerId) endDraftGame(io, gameRoomManager, gameRoomId, winnerId, `${name} abandonó el draft`);
        }
        socket.emit("draft:withdrawn", { roomId, penalty });
        socket.leave(roomId);
        announceDraftResult(
          io,
          roomId,
          { gameRoomId: result.gameRoomIds[0] ?? "", winnerId: null, loserId: userId, forfeit: true },
          result,
          gameRoomManager,
        );
        console.log(`🏳️ ${name} withdrew from draft ${roomId} (penalty ${penalty})`);
      } finally {
        withdrawingUsers.delete(userId);
      }
    } catch (error) {
      socket.emit("draft:error", { message: (error as Error).message });
    }
  });

  // --------------------------------------------------------------------------
  // Disconnect
  // --------------------------------------------------------------------------

  socket.on("disconnect", () => {
    // Drafts it watched: one spectator less
    for (const watched of draftRoomManager.removeSpectatorSocket(socket.id)) broadcastDraftState(io, watched.id);
    const room = draftRoomManager.handleDisconnect(socket.id);
    if (room) {
      broadcastDraftState(io, room.id);
      if (room.phase === "lobby") broadcastRoomList(io);
    }
  });
}
