import type { Server, Socket } from "socket.io";
import {
  type GameCard,
  findCardById,
  findCardDefinition,
  getDeckById as getThemeDeckById,
  decks as themeDeckList,
} from "@gonzaloaguila/game-core";
import type { GameState } from "@gonzaloaguila/game-core";
import { GameRoomManager, OwnTableTakenError, PrivateTableError, RoomNotFoundError, SeatedSpectatorError, isPublicTable, type ActionResult, type GameRoom, type PlayerKey } from "./rooms.js";
import { SPECTATE_RATE_LIMITED, allowSpectate, forgetSpectateSocket } from "./spectate-limit.js";
import { maskRoomState } from "./room-state.js";
import { cosmeticsPayload, getRoomCosmetics, snapshotRoomCosmetics } from "./room-cosmetics.js";
import type { Viewer } from "./state-masking.js";
import { maxBetForTitle, titleIdFromStats } from "../modules/users/titles.js";
import { checkDeckPlayable } from "../modules/decks/decks.service.js";
import { describeDeck } from "../modules/decks/deck-rank.js";
import {
  registerDraftEvents,
  draftRoomManager,
  announceDraftResult,
} from "./draft-handlers.js";
import { registerTradeEvents } from "./trade-handlers.js";
import { draftGameWasPlayed } from "./draft-rewards.js";
import { InsufficientStakeError, betIneligibilityReason } from "../modules/matches/matches.service.js";
import { ECONOMY } from "../modules/economy/config.js";
import { openRoomMatch, roomMatchMode, settleRoomResult } from "./match-settlement.js";
import { socketSchemas, parsePayload } from "./schemas.js";
import { setIo, userRoom } from "./io-registry.js";
import { authenticateHandshake, checkSocketSession, kickBlockedUser, requireSocketUser } from "./session-guard.js";
import * as chatService from "../modules/chat/chat.service.js";
import { allowChatMessage, buildRoomChatMessage, rememberChatMessage } from "./room-chat.js";
import { EMOTE_ERRORS, allowEmote, seatHasEmote } from "./room-emotes.js";
import { getChatPresence, joinChatPresence, leaveChatPresence, trackOnline, untrackOnline } from "./presence.js";
import { prisma } from "../lib/prisma.js";
import type { DeckCardEntry } from "../modules/decks/decks.service.js";


/** UUID pattern used to distinguish user DB deck IDs from theme deck IDs */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a deck ID into an array of GameCard instances ready for play.
 *
 * - If `deckId` is a UUID it is treated as a user-created deck stored in the
 *   database.  The deck's `cards` JSON column (DeckCardEntry[]) is read and
 *   each entry's `cardDefId` is looked up in the combined card catalog.
 *
 * - Otherwise it is treated as a built-in theme deck ID and resolved via the
 *   game-core helper.
 *
 * Returns `null` only when the deck cannot be found at all (the caller should
 * fall back to a sensible default).
 */
async function resolveDeckCards(deckId: string | null): Promise<GameCard[] | null> {
  if (!deckId) return null;

  // ── User database deck ──────────────────────────────────────────────
  if (UUID_RE.test(deckId)) {
    const deck = await prisma.deck.findUnique({
      where: { id: deckId },
      select: { cards: true },
    });
    if (!deck || !deck.cards) return null;

    const entries = deck.cards as unknown as DeckCardEntry[];
    const cards: GameCard[] = [];

    for (const entry of entries) {
      const template = findCardById(entry.cardDefId);
      if (!template) {
        console.warn(`[resolveDeckCards] Card definition not found: ${entry.cardDefId}`);
        continue;
      }
      for (let i = 0; i < entry.quantity; i++) {
        cards.push({
          ...template,
          id: `${template.name}-${i}-${Date.now()}-${Math.random()}`,
        });
      }
    }

    return cards.length > 0 ? cards : null;
  }

  // ── Built-in theme deck ─────────────────────────────────────────────
  const themeDeck = getThemeDeckById(deckId);
  if (!themeDeck) return null;

  // Build card instances the same way game-core's buildDeckFromEntries does (set registry
  // lookup by set + number; no set = Base Set).
  const cards: GameCard[] = [];
  for (const entry of themeDeck.cards) {
    // Theme deck entries use {cardNumber, quantity, set?}
    const template = findCardDefinition(entry.set, entry.cardNumber);
    if (!template) {
      console.warn(`[resolveDeckCards] Theme deck card #${entry.cardNumber} not found`);
      continue;
    }
    for (let i = 0; i < entry.quantity; i++) {
      cards.push({
        ...template,
        id: `${template.name}-${i}-${Date.now()}-${Math.random()}`,
      });
    }
  }
  return cards.length > 0 ? cards : null;
}

/**
 * Resolve both players' decks and start the game in the given room.
 *
 * When either (or both) players have selected a user-created database deck
 * we resolve the card entries into GameCard[] arrays and pass them to
 * startGame() as pre-resolved decks.  This ensures the prize-count
 * adjustment and event neutralization still take place.
 *
 * When BOTH decks are theme-deck IDs (or missing), startGame() falls back
 * to the built-in theme deck path internally.
 */
async function resolveAndStartGame(roomManager: GameRoomManager, roomId: string) {
  const room = roomManager.getRoom(roomId);
  if (!room) throw new Error("Room not found");

  // Lucky Duel: no decks to resolve, the server draws both (random Basic + deck around it)
  if (room.config.mode === "lucky-duel") return roomManager.startLuckyDuelGame(roomId);

  const p1Cards = await resolveDeckCards(room.player1DeckId);
  const p2Cards = await resolveDeckCards(room.player2DeckId);

  // If at least one player has a resolved custom deck, use the raw-cards path
  if (p1Cards || p2Cards) {
    // Fallback for any player that couldn't be resolved
    const fallback1 = await resolveDeckCards(themeDeckList[0]?.id ?? "brushfire");
    const fallback2 = await resolveDeckCards(themeDeckList[1]?.id ?? "overgrowth");

    const deck1 = p1Cards ?? fallback1 ?? [];
    const deck2 = p2Cards ?? fallback2 ?? [];

    return roomManager.startGame(roomId, {
      player1Cards: deck1,
      player2Cards: deck2,
    });
  }

  // Both are theme decks (or missing) — use the standard theme deck path
  return roomManager.startGame(roomId);
}

/** Short reason stored on the match row: the game's last event ("Jugador 2 se ha rendido", ...). */
function describeGameEnd(state: GameState | undefined): string {
  return state?.events?.at(-1)?.message ?? "Fin de la partida";
}

/** Current coin balance (0 for a missing account). */
async function getCoins(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } });
  return user?.coins ?? 0;
}

/**
 * Open the room's match (deducting the table bet from both players in one transaction) and start
 * the game. Returns null when the room can't start (already starting/started, a seat is empty)
 * or a player can't cover the bet (handled here: the joiner is sent back, or the creator's room
 * is closed). If the game fails to start after the escrow, the stakes are refunded.
 */
async function startRoomGame(io: Server, roomId: string): Promise<GameState | null> {
  const room = roomManager.getRoom(roomId);
  if (!room || room.status !== "waiting" || room.startPending || !room.player1Id || !room.player2Id) return null;
  room.startPending = true;
  // Both players play this game: their other waiting tables close now (before any await, so a
  // second table of the creator can't start meanwhile; one already starting fails and refunds)
  closeOtherWaitingRooms(io, [room.player1Id, room.player2Id], roomId);
  try {
    try {
      await openRoomMatch(room, roomMatchMode(room, false));
    } catch (err) {
      if (err instanceof InsufficientStakeError) {
        await handleUnpaidBet(io, room, err.userId);
        return null;
      }
      // Without a bet the game can still be played; the result then only updates the stats
      if (room.config.betAmount > 0 || room.matchId) throw err;
      console.error(`[startRoomGame] Could not open the match of room ${roomId}:`, err);
    }
    if (roomManager.getRoom(roomId) !== room || room.status !== "waiting" || !room.player1Id || !room.player2Id) {
      throw new Error("La mesa se cerró antes de empezar la partida");
    }
    const state = await resolveAndStartGame(roomManager, roomId);
    // Both players' cosmetics (owned only) as they are now: rejoins and spectators get the same
    await snapshotRoomCosmetics(room);
    return state;
  } catch (err) {
    // Nothing was played: refund the stakes, and let the room take a fresh match if it starts later
    settleRoomResult(io, room, null, "La partida no pudo comenzar");
    room.matchId = undefined;
    room.resultSettled = false;
    throw err;
  } finally {
    room.startPending = false;
    emitMyRooms(io, room.player1Id, room.player2Id);
  }
}

/**
 * The user's own waiting tables with their deck (`myRooms`, only to that user: the public room
 * list is anonymous). Also the ones whose creator left the lobby (rejoin them to keep them).
 */
function myRoomsPayload(userId: string) {
  return {
    rooms: roomManager.findWaitingRoomsByUser(userId).map((r) => ({
      id: r.id,
      mode: r.config.mode,
      deckId: r.config.mode === "lucky-duel" ? null : r.player1DeckId,
      deckName: r.config.mode === "lucky-duel" ? null : (r.creatorDeck?.name ?? null),
      prizeCount: r.config.prizeCount,
      betAmount: r.config.betAmount,
      deckRank: r.config.mode === "lucky-duel" ? null : (r.creatorDeck?.rank ?? null),
    })),
  };
}

/** `myRooms` to every socket of these users (after their tables changed). */
function emitMyRooms(io: Server, ...userIds: (string | null | undefined)[]): void {
  for (const userId of new Set(userIds)) {
    if (userId) io.to(userRoom(userId)).emit("myRooms", myRoomsPayload(userId));
  }
}

/**
 * Close these users' waiting tables but `keepRoomId` (GameRoomManager.closeWaitingRoomsOf):
 * everyone in each closed room and its creator's sockets get `roomDeleted`, the lobbies the new
 * room list.
 */
function closeOtherWaitingRooms(io: Server, userIds: (string | null)[], keepRoomId: string): void {
  const closed = roomManager.closeWaitingRoomsOf(userIds, keepRoomId);
  for (const room of closed) {
    io.to([room.id, ...(room.player1Id ? [userRoom(room.player1Id)] : [])]).emit("roomDeleted", { roomId: room.id });
    io.in(room.id).socketsLeave(room.id);
    console.log(`🗑️ Waiting room ${room.id} closed (its creator plays in ${keepRoomId})`);
  }
  if (closed.length > 0) broadcastRoomList(io);
  emitMyRooms(io, ...closed.map((r) => r.player1Id));
}

/** A player couldn't cover the bet when the game was about to start (nobody was charged). */
async function handleUnpaidBet(io: Server, room: GameRoom, userId: string): Promise<void> {
  const bet = room.config.betAmount;
  const creatorSocket = room.player1SocketId;
  const joinerSocket = room.player2SocketId;
  if (userId === room.player2Id) {
    // The joiner can't pay: send them back to the lobby, the table stays open
    if (joinerSocket) {
      await roomManager.leaveRoom(room.id, joinerSocket);
      io.in(joinerSocket).socketsLeave(room.id);
      io.to(joinerSocket).emit("error", { message: `No tienes suficientes monedas para la apuesta de esta mesa (${bet} monedas)` });
      if (creatorSocket) io.to(creatorSocket).emit("playerLeft", { socketId: joinerSocket });
    }
  } else {
    // The creator spent their coins after opening the table: close it
    roomManager.forceDeleteRoom(room.id);
    if (creatorSocket) {
      io.in(creatorSocket).socketsLeave(room.id);
      io.to(creatorSocket).emit("error", { message: `No tienes suficientes monedas para la apuesta de tu mesa (${bet} monedas). La mesa se cerró.` });
      io.to(creatorSocket).emit("roomDeleted", { roomId: room.id });
    }
    emitMyRooms(io, userId);
    if (joinerSocket) {
      io.in(joinerSocket).socketsLeave(room.id);
      io.to(joinerSocket).emit("error", { message: "El creador de la mesa ya no tiene monedas para la apuesta. La mesa se cerró." });
    }
  }
  broadcastRoomList(io);
}

// Socket payloads are validated with the zod schemas in ./schemas.ts.

// Room manager instance (exported for admin panel access)
export const roomManager = new GameRoomManager();
roomManager.startPeriodicCleanup();

/** The state `viewer` receives for this room: masked, plus `awaitingUserId` (room-state.ts). */
function stateFor(room: GameRoom, state: GameState, viewer: Viewer) {
  return maskRoomState(roomManager, room, state, viewer);
}

/**
 * A game ended (game over, kick, disconnect forfeit, setup timeout, leaving a game in progress):
 * tell the room, settle the result once (match-settlement.ts: stats, XP, match coins, missions,
 * the table bet; `winner` null refunds it) and, for a draft match, report it to the draft (once:
 * the draft forgets the game room when its result is reported) and start the next round.
 * `"draw"` (Lucky Duel: both Actives Knocked Out at once): `gameOver { winner: null, reason }`
 * and a settled draw (no winner, no loser).
 * `settlementReason` is what the match row stores (defaults to the reason shown to players).
 */
function finishRoomGame(
  io: Server,
  roomId: string,
  winner: PlayerKey | "draw" | null,
  reason: string,
  forfeit: boolean,
  settlementReason: string = reason,
): void {
  const room = roomManager.getRoom(roomId);
  if (!room || room.resultSettled) return;

  const winnerSide = winner === "draw" ? null : winner;
  io.to(roomId).emit("gameOver", { winner: winnerSide, reason });

  const draftInfo = draftRoomManager.getDraftInfoForGameRoom(roomId);
  settleRoomResult(io, room, winner, settlementReason, { isDraft: !!draftInfo });
  reportDraftGame(io, roomId, winnerSide, forfeit);
}

/**
 * A draft game ended (winner null: no winner, both players lose it): its result goes to the
 * draft once (the draft forgets the game room when its result is reported).
 */
function reportDraftGame(io: Server, roomId: string, winner: PlayerKey | null, forfeit: boolean): void {
  const draftInfo = draftRoomManager.getDraftInfoForGameRoom(roomId);
  if (!draftInfo) return;

  const winnerId = winner === "player1" ? draftInfo.player1Id : winner === "player2" ? draftInfo.player2Id : null;
  const loserId = winner === "player1" ? draftInfo.player2Id : winner === "player2" ? draftInfo.player1Id : null;
  const progress = draftRoomManager.reportMatchResult(
    draftInfo.draftRoomId,
    draftInfo.roundNumber,
    draftInfo.matchNumber,
    winnerId,
    loserId,
    roomId,
    draftGameWasPlayed(roomManager.getRoom(roomId)?.gameState),
  );
  announceDraftResult(io, draftInfo.draftRoomId, { gameRoomId: roomId, winnerId, loserId, forfeit }, progress, roomManager);
}

/** Serialize a room for the lobby room list. A table waiting for a rival is anonymous (who created it is never sent). */
function serializeRoom(r: ReturnType<typeof roomManager.getRoom>) {
  if (!r) return null;
  const isWaiting = r.status === "waiting";
  return {
    id: r.id,
    status: r.status,
    /** Table type: "standard" or "lucky-duel" (no deck, no Prizes: prizeCount 0). */
    mode: r.config.mode,
    createdAt: r.createdAt,
    playerCount: r.players.length,
    prizeCount: r.config.prizeCount,
    betAmount: r.config.betAmount,
    reservedUserId: r.config.reservedUserId,
    friendly: r.config.friendly,
    /** The creator's deck rank F–S (deck-rank.ts); null at Lucky Duel (no deck). */
    deckRank: r.config.mode === "lucky-duel" ? null : (r.creatorDeck?.rank ?? null),
    creatorUsername: isWaiting ? null : r.creator.username,
    creatorAvatarId: isWaiting ? null : r.creator.avatarId,
    creatorTitleId: isWaiting ? null : r.creator.titleId,
    joinerUsername: r.joiner.username,
    joinerAvatarId: r.joiner.avatarId,
    joinerTitleId: r.joiner.titleId,
    spectatorCount: roomManager.spectatorCount(r),
    /** Anyone may watch it (not friendly, not reserved): only these are in "En curso". */
    watchable: isPublicTable(r),
  };
}

/** A spectator-count change waiting to go out with the next room list. */
let pendingRoomList: ReturnType<typeof setTimeout> | null = null;
/** Spectators come and go often: their counts reach the lobbies at most once per this. */
const SPECTATOR_LIST_DELAY_MS = 1000;

function broadcastRoomList(io: Server) {
  if (pendingRoomList) {
    clearTimeout(pendingRoomList);
    pendingRoomList = null;
  }
  io.emit("roomList", {
    rooms: roomManager.getActiveRooms().map(serializeRoom).filter(Boolean),
  });
}

/** The room list after spectators changed: one trailing broadcast per SPECTATOR_LIST_DELAY_MS. */
function scheduleRoomList(io: Server) {
  if (pendingRoomList) return;
  pendingRoomList = setTimeout(() => {
    pendingRoomList = null;
    broadcastRoomList(io);
  }, SPECTATOR_LIST_DELAY_MS);
  pendingRoomList.unref?.();
}

/** What a spectator is told when it tries to act (play, ready, kick, coins). */
const SPECTATOR_ONLY_ERROR = "Los espectadores solo pueden mirar y chatear";

/**
 * Everyone in the room (players and spectators) hears how many people watch it
 * (`spectatorUpdate { roomId, count }`, users not tabs); the lobbies' table lists carry it too.
 */
function announceSpectators(io: Server, room: GameRoom): void {
  io.to(room.id).emit("spectatorUpdate", { roomId: room.id, count: roomManager.spectatorCount(room) });
  if (!room.isDraft) scheduleRoomList(io);
}

/**
 * Backoffice: close a game room now (a game in progress has no result: forceDeleteRoom refunds
 * its bet). Everyone in the socket room — both players and every spectator — gets `gameClosed`
 * and `roomDeleted`, leaves the socket room, and the lobbies get the new room list.
 * Returns false when the room doesn't exist.
 */
export function closeRoomByAdmin(io: Server | null, roomId: string, reason = "Mesa cerrada por un administrador"): boolean {
  const creatorId = roomManager.getRoom(roomId)?.player1Id;
  if (!roomManager.forceDeleteRoom(roomId)) return false;
  if (io) {
    emitMyRooms(io, creatorId);
    io.to(roomId).emit("gameClosed", { roomId, reason });
    io.to(roomId).emit("roomDeleted", { roomId });
    io.in(roomId).socketsLeave(roomId);
    broadcastRoomList(io);
  }
  return true;
}

/**
 * Send a broadcast system message to all connected users.
 */
export function notifyBroadcast(io: Server, message: { id: string; title: string; content: string; category: string }) {
  io.emit("systemMessage", message);
}

/**
 * Send a personal system message to a specific user.
 */
export function notifyUser(io: Server, userId: string, message: { id: string; title: string; content: string; category: string }) {
  io.to(`user:${userId}`).emit("systemMessage", message);
}

/** Returns the authenticated userId from socket, or null if not authenticated. */
function getAuthUserId(socket: Socket): string | null {
  return socket.data.user?.userId ?? null;
}

interface PublicIdentity {
  username: string;
  avatarId: string | null;
  titleId: string;
}

/**
 * Display identity for game rooms, read from the DB (never from the client payload,
 * which let players show any name/avatar/title, e.g. "superadmin").
 * Returns an error message instead when the account can't play.
 */
async function getPlayableIdentity(userId: string): Promise<PublicIdentity | { error: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      activeAvatarId: true,
      role: true,
      status: true,
      suspendedUntil: true,
      stats: {
        select: {
          normalWins: true, normalLosses: true, rankedWins: true, rankedLosses: true,
          draftWins: true, draftLosses: true, bestStreak: true,
        },
      },
    },
  });
  if (!user) return { error: "Usuario no encontrado" };
  if (user.status === "banned") return { error: "Tu cuenta ha sido deshabilitada" };
  if (user.status === "suspended" && user.suspendedUntil && user.suspendedUntil > new Date()) {
    return { error: "Tu cuenta está suspendida" };
  }
  return {
    username: user.username,
    avatarId: user.activeAvatarId ?? null,
    titleId: titleIdFromStats(user.stats, user.role),
  };
}

const GLOBAL_CHAT_ROOM = "global-chat";

/** Send the global chat's "Conectados" list to everyone in it. */
function broadcastChatPresence(io: Server): void {
  io.to(GLOBAL_CHAT_ROOM).emit("chat:presence", getChatPresence());
}


/**
 * Tell the room what an action did: the opponent's animation hint, coins (showCoinFlip), the
 * setup timer, every viewer's masked state and the game over. Used for players' actions and for
 * the default answers the server gives when an answer clock runs out (no actor socket).
 */
function broadcastActionResult(io: Server, roomId: string, actionType: string, result: ActionResult, actor: string | string[] | null): void {
  // Broadcast action to opponent for animation (no private data). `paused`: an attack that
  // stopped at a mid-attack question (Flee, Sabrina's ESP...) and hasn't happened yet.
  const opponentAction = { type: actionType, ...(result.attackPaused ? { paused: true } : {}) };
  // `actor`: the acting socket, or the rooms of a player the server answered for (never told
  // about their own action as if the opponent did it)
  if (actor && actor.length > 0) io.to(roomId).except(actor).emit("opponentAction", opponentAction);
  else io.to(roomId).emit("opponentAction", opponentAction);

  // Send updated state to both players
  const room = roomManager.getRoom(roomId);
  if (room && result.gameState) {
    console.log(`[action] Sending state update. P1 socket: ${room.player1SocketId}, P2 socket: ${room.player2SocketId}`);
    console.log(`[action] State: P1 active=${!!result.gameState.playerActivePokemon}, P2 active=${!!result.gameState.opponentActivePokemon}`);

    // Broadcast coin flip results to both players if present
    if (result.coinFlipInfo) {
      console.log(`[action] Broadcasting coin flip results: ${result.coinFlipInfo.attackName} - ${result.coinFlipInfo.results.join(", ")}`);
      // results: the acting player's coins (flippedBy: who flipped each, when not all the
      // acting player — Knock Down); defenderResults: Transparency / Final Beam coin
      io.to(roomId).emit("showCoinFlip", {
        attackName: result.coinFlipInfo.attackName,
        results: result.coinFlipInfo.results,
        count: result.coinFlipInfo.results.length,
        ...(result.coinFlipInfo.flippedBy ? { flippedBy: result.coinFlipInfo.flippedBy } : {}),
        ...(result.coinFlipInfo.defenderResults ? { defenderResults: result.coinFlipInfo.defenderResults } : {}),
        // Who flipped the defender coin when not the defending player (Shadow Images)
        ...(result.coinFlipInfo.defenderFlippedBy ? { defenderFlippedBy: result.coinFlipInfo.defenderFlippedBy } : {}),
      });
    }

    // Trainer/power coins: the Trainer's / power's player already showed them (requestCoinFlip ack)
    if (result.opponentCoinFlipInfo) {
      const shownSocket = result.coinsShownTo === "player2" ? room.player2SocketId : room.player1SocketId;
      const payload = {
        attackName: result.opponentCoinFlipInfo.attackName,
        results: result.opponentCoinFlipInfo.results,
        count: result.opponentCoinFlipInfo.results.length,
        ...(result.opponentCoinFlipInfo.flippedBy ? { flippedBy: result.opponentCoinFlipInfo.flippedBy } : {}),
      };
      if (shownSocket) io.to(roomId).except(shownSocket).emit("showCoinFlip", payload);
      else io.to(roomId).emit("showCoinFlip", payload);
    }

    // Broadcast setup timer start to both players if present
    if (result.setupTimerStarted) {
      io.to(roomId).emit("setupTimer", {
        startedAt: result.setupTimerStarted,
        duration: 90, // seconds
      });
    }

    if (room.player1SocketId) {
      io.to(room.player1SocketId).emit("gameState", {
        gameState: stateFor(room, result.gameState, "player1"),
        turnStartedAt: room.turnStartedAt,
        turnTimerDuration: room.turnTimerDuration,
      });
    }
    if (room.player2SocketId) {
      io.to(room.player2SocketId).emit("gameState", {
        gameState: stateFor(room, result.gameState, "player2"),
        turnStartedAt: room.turnStartedAt,
        turnTimerDuration: room.turnTimerDuration,
      });
    }

    // Send state to spectators (player1 perspective)
    if (room.spectators && room.spectators.size > 0) {
      const spectatorState = stateFor(room, result.gameState, "spectator");
      for (const specSocketId of room.spectators.keys()) {
        io.to(specSocketId).emit("gameState", {
          gameState: spectatorState,
          turnStartedAt: room.turnStartedAt,
          turnTimerDuration: room.turnTimerDuration,
        });
      }
    }
  }

  // Game over: executeAction reports it once (a finished room takes no more actions);
  // finishRoomGame settles the result (stats, XP, bet) and the draft standing once
  if (result.gameOver) {
    if (result.draw) finishRoomGame(io, roomId, "draw", result.winReason ?? "Empate", false, "Empate");
    else finishRoomGame(io, roomId, result.winner ?? null, result.winReason ?? "Fin de la partida", false, describeGameEnd(result.gameState));
  }
}

export function setupSocketHandlers(io: Server): void {
  setIo(io);

  // Attach user data if the token is valid, not revoked (tokenVersion) and the account can play,
  // but always allow the connection (unauthenticated sockets can only view rooms / spectate).
  io.use((socket, next) => {
    authenticateHandshake(socket.handshake.auth?.token)
      .then((payload) => {
        if (payload) socket.data.user = payload;
      })
      .finally(() => next());
  });

  io.on("connection", (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Join user-specific room for targeted notifications; count the user as online
    if (socket.data.user?.userId) {
      socket.join(userRoom(socket.data.user.userId));
      trackOnline(socket.data.user.userId, socket.id);
    }

    // ==========================================================================
    // Lobby - Room Listing
    // ==========================================================================

    // The user's own waiting tables (a reloaded lobby restores them)
    if (socket.data.user?.userId) socket.emit("myRooms", myRoomsPayload(socket.data.user.userId));
    socket.on("getMyRooms", () => {
      const userId = getAuthUserId(socket);
      if (userId) socket.emit("myRooms", myRoomsPayload(userId));
    });

    socket.on("getRooms", () => {
      socket.emit("roomList", {
        rooms: roomManager.getActiveRooms().map(serializeRoom).filter(Boolean),
      });
    });

    socket.on("createRoom", async (payload: unknown) => {
      try {
        const userId = await requireSocketUser(socket, "error");
        if (!userId) return;
        const parsed = parsePayload(socketSchemas.createRoom, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { mode, prizeCount, reservedUserId, friendly } = parsed.data;
        const luckyDuel = mode === "lucky-duel";
        // Lucky Duel: the server builds both decks, so a deck sent anyway is ignored
        const deckId = luckyDuel ? undefined : parsed.data.deckId;
        const identity = await getPlayableIdentity(userId);
        if ("error" in identity) { socket.emit("error", { message: identity.error }); return; }
        // A seat requires a deck (checkDeckPlayable rejects a missing one), except at Lucky Duel
        if (!luckyDuel) {
          const deckError = await checkDeckPlayable(userId, deckId);
          if (deckError) { socket.emit("error", { message: deckError }); return; }
        }
        // The lobby shows the deck's rank F–S, never the deck
        const creatorDeck = deckId ? await describeDeck(userId, deckId) : undefined;
        // Table bets are off unless ECONOMY.tableBets.enabled (the bet is forced to 0). When on:
        // friendly tables carry no bet; otherwise the bet is capped by the creator's title (lobby
        // slider), the creator must be eligible and cover it now (it's charged to both players
        // when the game starts). Lucky Duel tables bet the same way (a draw refunds both stakes).
        const betAmount = friendly || !ECONOMY.tableBets.enabled ? 0 : (parsed.data.betAmount ?? 0);
        if (betAmount > 0) {
          const notEligible = await betIneligibilityReason(userId);
          if (notEligible) {
            socket.emit("error", { message: notEligible });
            return;
          }
          const maxBet = maxBetForTitle(identity.titleId);
          if (betAmount > maxBet) {
            socket.emit("error", { message: `Tu título permite apostar hasta ${maxBet} monedas` });
            return;
          }
          if ((await getCoins(userId)) < betAmount) {
            socket.emit("error", { message: `No tienes suficientes monedas para apostar ${betAmount}` });
            return;
          }
        }
        // One waiting table per mode (checked after the awaits: nothing runs between it and the seat)
        if (roomManager.findWaitingRoomsByUser(userId).some((r) => r.config.mode === mode)) {
          socket.emit("error", {
            message: luckyDuel ? "Ya tienes una mesa de Lucky Duel esperando rival" : "Ya tienes una mesa esperando rival",
          });
          return;
        }
        const room = roomManager.createRoom(
          undefined,
          { mode, prizeCount, betAmount, reservedUserId: reservedUserId || null, friendly: friendly ?? false },
          identity,
        );
        await roomManager.joinRoom(room.id, userId, socket.id);

        // Set deck if provided
        if (deckId) {
          roomManager.setPlayerDeck(room.id, socket.id, deckId);
          room.creatorDeck = creatorDeck;
        }

        socket.join(room.id);

        socket.emit("roomCreated", {
          roomId: room.id,
          playerId: userId,
          isPlayer1: true,
          mode: room.config.mode,
        });

        broadcastRoomList(io);
        emitMyRooms(io, userId);

        console.log(`🏠 Room ${room.id} created by ${userId} (mode:${room.config.mode}, prizes:${room.config.prizeCount}, bet:${room.config.betAmount})`);
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    socket.on("deleteRoom", async (payload: unknown) => {
      try {
        const userId = getAuthUserId(socket);
        if (!userId) { socket.emit("error", { message: "Autenticación requerida" }); return; }
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        const room = roomManager.getRoom(roomId);
        console.log(`[deleteRoom] Room state:`, room ? { player1Id: room.player1Id, status: room.status } : 'not found');
        // By user id: the creator may come back from another socket (a reloaded lobby)
        const deleted = roomManager.deleteRoom(roomId, userId);
        console.log(`[deleteRoom] Delete result: ${deleted}`);

        if (deleted) {
          socket.leave(roomId);
          socket.emit("roomDeleted", { roomId });
          if (room?.player1SocketId && room.player1SocketId !== socket.id) {
            io.in(room.player1SocketId).socketsLeave(roomId);
            io.to(room.player1SocketId).emit("roomDeleted", { roomId });
          }

          broadcastRoomList(io);
          emitMyRooms(io, userId);

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

    socket.on("joinRoom", async (payload: unknown) => {
      try {
        const userId = await requireSocketUser(socket, "error");
        if (!userId) return;
        const parsed = parsePayload(socketSchemas.joinRoom, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        // Never create a room here: the client is rejoining a game that is gone (finished,
        // deleted, or lost in an API restart). The frontend goes back to the lobby.
        const target = roomManager.getRoom(roomId);
        if (!target) {
          socket.emit("error", { code: "ROOM_NOT_FOUND", message: new RoomNotFoundError().message });
          return;
        }
        // Lucky Duel: no deck (the server builds both), a deck sent anyway is ignored
        const luckyDuel = target.config.mode === "lucky-duel";
        const deckId = luckyDuel ? undefined : parsed.data.deckId;
        const identity = await getPlayableIdentity(userId);
        if ("error" in identity) { socket.emit("error", { message: identity.error }); return; }
        // Taking a seat requires a playable deck (not at Lucky Duel); reconnecting to your own seat doesn't
        const seated = roomManager.seatOf(target, userId) !== null;
        if (!luckyDuel && (!seated || deckId)) {
          const deckError = await checkDeckPlayable(userId, deckId);
          if (deckError) { socket.emit("error", { message: deckError }); return; }
        }

        // Taking the free seat of a table with a bet: the joiner must be able to cover it
        // (charged when the game starts, in the same transaction as the creator's stake)
        if (target.config.betAmount > 0 && !seated) {
          const notEligible = await betIneligibilityReason(userId);
          if (notEligible) {
            socket.emit("error", { message: notEligible });
            return;
          }
          if ((await getCoins(userId)) < target.config.betAmount) {
            socket.emit("error", { message: `No tienes suficientes monedas para la apuesta de esta mesa (${target.config.betAmount} monedas)` });
            return;
          }
        }

        console.log(`[joinRoom] Attempting to join room ${roomId} as ${userId}`);
        const room = await roomManager.joinRoom(roomId, userId, socket.id, identity);
        console.log(`[joinRoom] Room state after join:`, {
          player1Id: room.player1Id,
          player2Id: room.player2Id,
          status: room.status,
        });

        // Taking a seat at another table closes the user's own waiting tables
        if (!seated) closeOtherWaitingRooms(io, [userId], roomId);

        // Set deck if provided (only before the game starts)
        if (deckId && room.status === "waiting") {
          roomManager.setPlayerDeck(roomId, socket.id, deckId);
          // The creator coming back with another deck: the table shows that one's rank
          if (room.player1Id === userId) {
            room.creatorDeck = await describeDeck(userId, deckId);
            broadcastRoomList(io);
            emitMyRooms(io, userId);
          }
        }

        socket.join(roomId);

        const isPlayer1 = room.player1Id === userId;

        socket.emit("roomJoined", {
          roomId,
          playerId: userId,
          players: room.players,
          isPlayer1,
          mode: room.config.mode,
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

          // Both players' cosmetics, taken when the game started
          const cosmetics = await getRoomCosmetics(room);

          // Send current game state to the reconnecting player
          socket.emit("gameStart", {
            roomId,
            mode: room.config.mode,
            gameState: stateFor(room, room.gameState, isPlayer1 ? "player1" : "player2"),
            isPlayer1,
            opponentInfo: isPlayer1 ? room.joiner : room.creator,
            ...cosmeticsPayload(cosmetics, isPlayer1 ? "player1" : "player2"),
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
            spectatorCount: roomManager.spectatorCount(room),
          });
          socket.emit("chatHistory", { roomId, messages: room.chat });
          return;
        }

        // Auto-start game when second player joins (only if not already playing)
        console.log(`[joinRoom] Checking if room is ready: ${roomManager.isRoomReady(roomId)}`);
        if (roomManager.isRoomReady(roomId) && room.status === "waiting") {
          console.log(`[joinRoom] Room is ready, starting game...`);
          const gameState = await startRoomGame(io, roomId);
          if (!gameState) return;
          console.log(`[joinRoom] Game started, phase: ${gameState.gamePhase}`);

          // Update room list (room now playing)
          broadcastRoomList(io);

          // Both players' cosmetics (read when the game started)
          const cosmetics = await getRoomCosmetics(room);

          // Send masked state to each player
          io.to(room.player1SocketId!).emit("gameStart", {
            roomId,
            mode: room.config.mode,
            gameState: stateFor(room, gameState, "player1"),
            isPlayer1: true,
            opponentInfo: room.joiner,
            ...cosmeticsPayload(cosmetics, "player1"),
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });
          io.to(room.player2SocketId!).emit("gameStart", {
            roomId,
            mode: room.config.mode,
            gameState: stateFor(room, gameState, "player2"),
            isPlayer1: false,
            opponentInfo: room.creator,
            ...cosmeticsPayload(cosmetics, "player2"),
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });

          console.log(`🎮 Game auto-started in room ${roomId}`);
        }
      } catch (error) {
        if (error instanceof RoomNotFoundError) {
          socket.emit("error", { code: error.code, message: error.message });
          return;
        }
        if (error instanceof OwnTableTakenError) {
          socket.emit("error", { code: error.code, message: error.message, roomId: error.roomId });
          return;
        }
        socket.emit("error", { message: (error as Error).message });
      }
    });

    socket.on("leaveRoom", async (payload: unknown) => {
      try {
        if (!getAuthUserId(socket)) { socket.emit("error", { message: "Autenticación requerida" }); return; }
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        // A spectator leaving only stops watching (never a seat, never a forfeit)
        const watched = roomManager.removeSpectator(roomId, socket.id);
        if (watched) {
          socket.leave(roomId);
          announceSpectators(io, watched);
          return;
        }
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

    socket.on("ready", async (payload: unknown) => {
      try {
        if (!(await requireSocketUser(socket, "error"))) return;
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        if (roomManager.isSpectator(roomId, socket.id)) { socket.emit("error", { message: SPECTATOR_ONLY_ERROR }); return; }
        // Legacy lobby "ready": only before the game starts (it would restart a running or
        // finished game otherwise)
        if (roomManager.getRoom(roomId)?.status !== "waiting") {
          socket.emit("error", { message: "La partida ya comenzó" });
          return;
        }
        const room = await roomManager.setPlayerReady(roomId, socket.id);

        socket.to(roomId).emit("playerReady", { socketId: socket.id });

        // Check if both players ready
        if (room.player1Ready && room.player2Ready && room.status === "waiting") {
          const gameState = await startRoomGame(io, roomId);
          if (!gameState) return;

          // Both players' cosmetics (read when the game started)
          const cosmetics = await getRoomCosmetics(room);

          // Send masked state to each player
          io.to(room.player1SocketId!).emit("gameStart", {
            roomId,
            mode: room.config.mode,
            gameState: stateFor(room, gameState, "player1"),
            opponentInfo: room.joiner,
            ...cosmeticsPayload(cosmetics, "player1"),
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });
          io.to(room.player2SocketId!).emit("gameStart", {
            roomId,
            mode: room.config.mode,
            gameState: stateFor(room, gameState, "player2"),
            opponentInfo: room.creator,
            ...cosmeticsPayload(cosmetics, "player2"),
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
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

    // Coins a Trainer / power flips before its steps (Poké Ball, Heal): { roomId, purpose:
    // "trainer", cardId } | { roomId, purpose: "power", pokemonId }. Rolled and stored
    // server-side; the playTrainer / usePower action uses the stored coins.
    socket.on("requestCoinFlip", async (payload: unknown, ack?: (res: unknown) => void) => {
      if (typeof ack !== "function") return;
      const session = await checkSocketSession(socket);
      if (!session.ok) {
        ack({ success: false, error: session.error });
        if (session.blocked) kickBlockedUser(socket);
        return;
      }
      const parsed = parsePayload(socketSchemas.requestCoinFlip, payload);
      if (!parsed.ok) return ack({ success: false, error: parsed.error });
      if (roomManager.isSpectator(parsed.data.roomId, socket.id)) return ack({ success: false, error: SPECTATOR_ONLY_ERROR });
      ack(roomManager.requestCoinFlip(parsed.data.roomId, socket.id, parsed.data));
    });

    socket.on("action", async (payload: unknown) => {
      try {
        const session = await checkSocketSession(socket);
        if (!session.ok) {
          socket.emit("actionResult", { success: false, error: session.error });
          if (session.blocked) kickBlockedUser(socket);
          return;
        }
        const parsed = parsePayload(socketSchemas.actionEnvelope, payload);
        if (!parsed.ok) { socket.emit("actionResult", { success: false, error: parsed.error }); return; }
        // The action body is validated by executeAction (parseGameAction)
        const { roomId, action } = parsed.data;
        if (roomManager.isSpectator(roomId, socket.id)) {
          socket.emit("actionResult", { success: false, error: SPECTATOR_ONLY_ERROR });
          return;
        }

        const result = await roomManager.executeAction(roomId, socket.id, action);

        if (!result.success) {
          socket.emit("actionResult", { success: false, error: result.error });
          return;
        }

        broadcastActionResult(io, roomId, action.type, result, socket.id);

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

    socket.on("chatMessage", async (payload: unknown) => {
      const tokenUser = socket.data.user;
      if (!tokenUser) return;
      if (!(await requireSocketUser(socket, "error"))) return;
      const parsed = parsePayload(socketSchemas.chatMessage, payload);
      if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
      const { roomId } = parsed.data;
      const content = parsed.data.message.content;

      // Only game rooms this socket is actually in (as player or spectator); otherwise a client
      // could emit into any socket.io room, e.g. another user's private "user:<id>" room.
      const room = roomManager.getRoom(roomId);
      if (!socket.rooms.has(roomId) || !room) return;
      if (!allowChatMessage(tokenUser.userId)) return;

      // Name and role from the DB (not in the JWT); spectators' messages say so ("Espectador")
      const isSpectator = room.spectators.has(socket.id) || !roomManager.seatOf(room, tokenUser.userId);
      const message = await buildRoomChatMessage(tokenUser.userId, socket.id, content, isSpectator);
      rememberChatMessage(room.chat, message);
      io.to(roomId).emit("chatMessage", { roomId, ...message });
    });

    // ==========================================================================
    // Battle emotes (room-emotes.ts)
    // ==========================================================================

    // sendEmote { roomId, emoteId } (ack { success, error?, code? }): only a seated player of a
    // started game, rate limited, an emote of their loadout. Everyone in the room (both players
    // and the spectators) gets emote { roomId, side, userId, emoteId, sentAt }. Also after the
    // game over ("gg"): a finished room keeps its seats and lives FINISHED_ROOM_TTL_MS more.
    socket.on("sendEmote", async (payload: unknown, ack?: (res: unknown) => void) => {
      const reply = (res: { success: boolean; error?: string; code?: string }) => {
        if (typeof ack === "function") ack(res);
      };
      try {
        const session = await checkSocketSession(socket);
        if (!session.ok) {
          reply({ success: false, error: session.error });
          if (session.blocked) kickBlockedUser(socket);
          return;
        }
        const parsed = parsePayload(socketSchemas.sendEmote, payload);
        if (!parsed.ok) return reply({ success: false, error: parsed.error });
        const { roomId, emoteId } = parsed.data;
        const room = roomManager.getRoom(roomId);
        if (!room || !room.gameState || !socket.rooms.has(roomId)) return reply({ success: false, ...EMOTE_ERRORS.notInGame });
        if (room.spectators.has(socket.id)) return reply({ success: false, error: SPECTATOR_ONLY_ERROR });
        const seat = roomManager.seatOf(room, session.userId);
        if (!seat) return reply({ success: false, ...EMOTE_ERRORS.notInGame });
        if (!allowEmote(session.userId)) return reply({ success: false, ...EMOTE_ERRORS.rateLimited });
        if (!(await seatHasEmote(room, seat, emoteId))) return reply({ success: false, ...EMOTE_ERRORS.notInLoadout });
        io.to(roomId).emit("emote", { roomId, side: seat, userId: session.userId, emoteId, sentAt: Date.now() });
        reply({ success: true });
      } catch (error) {
        console.error("[sendEmote]", error);
        reply({ success: false, error: "No se pudo enviar el emote" });
      }
    });

    // ==========================================================================
    // Global Chat
    // ==========================================================================

    // Anyone may read the chat; authenticated accounts that can play are listed in
    // "Conectados" (chat:presence), with their public identity read from the DB.
    socket.on("globalChat:join", async () => {
      socket.join(GLOBAL_CHAT_ROOM);
      try {
        if (socket.data.user?.userId) {
          const userId = await requireSocketUser(socket, "error");
          if (!userId) return;
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, activeAvatarId: true, role: true },
          });
          // It may have left or disconnected during the lookups
          if (!user || !socket.connected || !socket.rooms.has(GLOBAL_CHAT_ROOM)) return;
          if (joinChatPresence(socket.id, user)) {
            broadcastChatPresence(io);
            return;
          }
        }
        socket.emit("chat:presence", getChatPresence());
      } catch (err) {
        console.error("Error joining the global chat:", err);
      }
    });

    socket.on("globalChat:leave", () => {
      socket.leave(GLOBAL_CHAT_ROOM);
      const userId = getAuthUserId(socket);
      if (userId && leaveChatPresence(userId, socket.id)) broadcastChatPresence(io);
    });

    socket.on("globalChat:message", async (payload: unknown) => {
      const user = socket.data.user;
      if (!user) return;
      if (!(await requireSocketUser(socket, "error"))) return;
      const parsed = parsePayload(socketSchemas.globalChatMessage, payload);
      if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
      const { content, type } = parsed.data;
      if (!allowChatMessage(user.userId)) return;

      try {
        const saved = await chatService.saveMessage(user.userId, content, type);
        io.to(GLOBAL_CHAT_ROOM).emit("globalChat:message", saved);
      } catch (err) {
        console.error("Error saving chat message:", err);
      }
    });

    // ==========================================================================
    // Kick (Turn Timer Expiry)
    // ==========================================================================

    socket.on("requestKick", async (payload: unknown) => {
      try {
        if (!(await requireSocketUser(socket, "error"))) return;
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        if (roomManager.isSpectator(roomId, socket.id)) { socket.emit("error", { message: SPECTATOR_ONLY_ERROR }); return; }
        const result = roomManager.requestKick(roomId, socket.id);

        if (!result.success || !result.winner) {
          socket.emit("error", { message: result.error || "Cannot kick" });
          return;
        }

        // gameOver to the room; result (stats, XP, bet) and draft standing settled once
        finishRoomGame(io, roomId, result.winner, "Tiempo agotado", true);

        broadcastRoomList(io);
        console.log(`⏱️ Player kicked from room ${roomId} — winner: ${result.winner}`);
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
    });

    // ==========================================================================
    // Spectator Mode
    // ==========================================================================

    // spectateRoom { roomId }: any signed-in user watches a game in progress. They get the
    // neutral masked state (player 1's side at the bottom, both hands/decks/prizes hidden) in
    // `gameStart { isSpectator: true, creatorInfo, opponentInfo, draftRoomId? ... }`, the room
    // chat (`chatHistory`), and every later `gameState`; they may only chat. A player of the
    // room gets `error { code: "SEATED_IN_ROOM" }` (rejoin instead); a missing / not started
    // room `error { code: "ROOM_NOT_FOUND" }`.
    socket.on("spectateRoom", async (payload: unknown) => {
      try {
        const userId = await requireSocketUser(socket, "error");
        if (!userId) return;
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        if (!allowSpectate(socket.id)) {
          socket.emit("error", SPECTATE_RATE_LIMITED);
          return;
        }
        const room = roomManager.addSpectator(roomId, socket.id, userId);

        if (!room?.gameState) {
          if (room) roomManager.removeSpectator(roomId, socket.id);
          socket.emit("error", { code: "ROOM_NOT_FOUND", message: "La partida ya no está en curso" });
          return;
        }

        socket.join(roomId);

        const cosmetics = await getRoomCosmetics(room);
        // It may have stopped watching (or the room closed) during the lookups
        if (!room.spectators.has(socket.id) || !room.gameState) return;

        // Player 1's side at the bottom (neutral view): creatorInfo = bottom, opponentInfo = top
        socket.emit("gameStart", {
          roomId,
          mode: room.config.mode,
          gameState: stateFor(room, room.gameState, "spectator"),
          isPlayer1: true,
          isSpectator: true,
          opponentInfo: room.joiner,
          creatorInfo: room.creator,
          // Player 1's cosmetics are the bottom side's ("player"), player 2's the top side's
          ...cosmeticsPayload(cosmetics, "spectator"),
          turnStartedAt: room.turnStartedAt,
          turnTimerDuration: room.turnTimerDuration,
          spectatorCount: roomManager.spectatorCount(room),
          draftRoomId: draftRoomManager.getDraftInfoForGameRoom(roomId)?.draftRoomId ?? null,
        });
        socket.emit("chatHistory", { roomId, messages: room.chat });

        announceSpectators(io, room);
        console.log(`👁️ Spectator ${userId} watches room ${roomId} (${roomManager.spectatorCount(room)} watching)`);
      } catch (error) {
        if (error instanceof SeatedSpectatorError || error instanceof PrivateTableError) {
          socket.emit("error", { code: error.code, message: error.message });
          return;
        }
        socket.emit("error", { message: (error as Error).message });
      }
    });

    // stopSpectating { roomId }: back to the lobby (also on leaveRoom / disconnect)
    socket.on("stopSpectating", (payload: unknown) => {
      const parsed = parsePayload(socketSchemas.roomRef, payload);
      if (!parsed.ok) return;
      const room = roomManager.removeSpectator(parsed.data.roomId, socket.id);
      if (!room) return;
      socket.leave(room.id);
      announceSpectators(io, room);
    });

    // ==========================================================================
    // Active Game Check (for reconnection)
    // ==========================================================================

    // Payload ({ userId }) is ignored: identity comes from the handshake token.
    socket.on("checkActiveGame", () => {
      const userId = getAuthUserId(socket);
      if (!userId) { socket.emit("activeGame", { roomId: null }); return; }
      const room = roomManager.getActiveRoomForUser(userId);
      socket.emit("activeGame", { roomId: room?.id ?? null });
    });

    // ==========================================================================
    // Disconnect
    // ==========================================================================

    socket.on("disconnect", async () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);

      const presenceUserId = getAuthUserId(socket);
      if (presenceUserId) {
        untrackOnline(presenceUserId, socket.id);
        if (leaveChatPresence(presenceUserId, socket.id)) broadcastChatPresence(io);
      }

      // Rooms it watched: one spectator less
      forgetSpectateSocket(socket.id);
      for (const watchedId of roomManager.removeSpectatorSocket(socket.id)) {
        const watched = roomManager.getRoom(watchedId);
        if (watched) announceSpectators(io, watched);
      }

      // Find and handle room disconnect
      const roomId = await roomManager.handleDisconnect(socket.id);
      if (roomId) {
        socket.to(roomId).emit("playerDisconnected", {
          socketId: socket.id,
        });

        // Broadcast updated room list (room may have been cleaned up)
        broadcastRoomList(io);
      }
    });

    // Register draft events on this socket (pass roomManager for match creation)
    registerDraftEvents(io, socket, roomManager);
    // Trade tables (card trades between players)
    registerTradeEvents(io, socket);
  });

  // A game dropped without a result (admin close, both players gone): refund the table bet
  roomManager.setOnAbandon((room, reason) => {
    settleRoomResult(io, room, null, reason);
    // A draft game must still decide its match, or the round never ends
    reportDraftGame(io, room.id, null, false);
  });

  // Set up forfeit callback for disconnect timeout, the setup timeout and leaving a game in
  // progress: gameOver to the room; result (stats, XP, bet: the forfeiter loses it) and draft
  // standing settled once
  roomManager.setOnForfeit((roomId, winner, _gameState, reason) => {
    finishRoomGame(
      io,
      roomId,
      winner,
      reason || "Oponente desconectado (tiempo de espera agotado)",
      true,
      reason || "Abandono por desconexión",
    );
  });

  // An off-turn answer's clock ran out (Challenge!, Erika, Flee...): the server answered for that
  // player by default; everyone gets the result like an action, plus `answerTimedOut`
  roomManager.setOnAutoAnswer((roomId, side, action, result) => {
    const room = roomManager.getRoom(roomId);
    const userId = (side === "player1" ? room?.player1Id : room?.player2Id) ?? null;
    const socketId = side === "player1" ? room?.player1SocketId : room?.player2SocketId;
    io.to(roomId).emit("answerTimedOut", { userId, actionType: action.type });
    // opponentAction to everyone but the player answered for (any of their sockets)
    const answerer = [...(socketId ? [socketId] : []), ...(userId ? [userRoom(userId)] : [])];
    broadcastActionResult(io, roomId, action.type, result, answerer);
  });

  // A waiting room deleted by the manager (its creator left the lobby): refresh the lobbies
  roomManager.setOnRoomClosed((roomId, room) => {
    io.to(roomId).emit("roomDeleted", { roomId });
    io.in(roomId).socketsLeave(roomId);
    broadcastRoomList(io);
    emitMyRooms(io, room.player1Id);
  });
}
