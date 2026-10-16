import type { Server, Socket } from "socket.io";
import {
  type GameCard,
  findCardById,
  findCardDefinition,
  isPokemonCard,
  getDeckById as getThemeDeckById,
  decks as themeDeckList,
} from "@gonzaloaguila/game-core";
import type { GameState } from "@gonzaloaguila/game-core";
import { GameRoomManager, RoomNotFoundError, type ActionResult, type GameRoom, type PlayerKey } from "./rooms.js";
import { maskRoomState } from "./room-state.js";
import type { Viewer } from "./state-masking.js";
import { maxBetForTitle, titleIdFromStats } from "../modules/users/titles.js";
import { checkDeckPlayable } from "../modules/decks/decks.service.js";
import {
  registerDraftEvents,
  draftRoomManager,
  announceDraftResult,
} from "./draft-handlers.js";
import { registerTradeEvents } from "./trade-handlers.js";
import { InsufficientStakeError, betIneligibilityReason } from "../modules/matches/matches.service.js";
import { ECONOMY } from "../modules/economy/config.js";
import { openRoomMatch, roomMatchMode, settleRoomResult } from "./match-settlement.js";
import { socketSchemas, parsePayload } from "./schemas.js";
import { setIo, userRoom } from "./io-registry.js";
import { authenticateHandshake, checkSocketSession, kickBlockedUser, requireSocketUser } from "./session-guard.js";
import * as chatService from "../modules/chat/chat.service.js";
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
 * Build a variant map from deck entries: card name -> overlay ID.
 * Only includes entries that have a variantId set.
 */
function buildVariantMap(entries: DeckCardEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.variantId) continue;
    const card = findCardById(entry.cardDefId);
    if (!card) continue;
    const name = isPokemonCard(card) ? card.name : card.name;
    map[name] = entry.variantId;
  }
  return map;
}

/**
 * Fetch deck entries from the database and build a variant map.
 * Returns an empty map if the deck is not found or is a theme deck ID.
 */
async function getVariantMapForDeck(deckId: string | null): Promise<Record<string, string>> {
  if (!deckId) return {};
  // Theme deck IDs (from game-core) won't be UUIDs — skip DB lookup
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deckId);
  if (!isUuid) return {};

  const deck = await prisma.deck.findUnique({
    where: { id: deckId },
    select: { cards: true },
  });
  if (!deck || !deck.cards) return {};

  const entries = deck.cards as unknown as DeckCardEntry[];
  return buildVariantMap(entries);
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
    return await resolveAndStartGame(roomManager, roomId);
  } catch (err) {
    // Nothing was played: refund the stakes, and let the room take a fresh match if it starts later
    settleRoomResult(io, room, null, "La partida no pudo comenzar");
    room.matchId = undefined;
    room.resultSettled = false;
    throw err;
  } finally {
    room.startPending = false;
  }
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
 * `settlementReason` is what the match row stores (defaults to the reason shown to players).
 */
function finishRoomGame(
  io: Server,
  roomId: string,
  winner: PlayerKey | null,
  reason: string,
  forfeit: boolean,
  settlementReason: string = reason,
): void {
  const room = roomManager.getRoom(roomId);
  if (!room || room.resultSettled) return;

  io.to(roomId).emit("gameOver", { winner, reason });

  const draftInfo = draftRoomManager.getDraftInfoForGameRoom(roomId);
  settleRoomResult(io, room, winner, settlementReason, { isDraft: !!draftInfo });
  reportDraftGame(io, roomId, winner, forfeit);
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
  );
  announceDraftResult(io, draftInfo.draftRoomId, { gameRoomId: roomId, winnerId, loserId, forfeit }, progress, roomManager);
}

/** Serialize a room for the lobby room list */
function serializeRoom(r: ReturnType<typeof roomManager.getRoom>) {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    playerCount: r.players.length,
    prizeCount: r.config.prizeCount,
    betAmount: r.config.betAmount,
    reservedUserId: r.config.reservedUserId,
    friendly: r.config.friendly,
    creatorUsername: r.creator.username,
    creatorAvatarId: r.creator.avatarId,
    creatorTitleId: r.creator.titleId,
    joinerUsername: r.joiner.username,
    joinerAvatarId: r.joiner.avatarId,
    joinerTitleId: r.joiner.titleId,
  };
}

function broadcastRoomList(io: Server) {
  io.emit("roomList", {
    rooms: roomManager.getActiveRooms().map(serializeRoom).filter(Boolean),
  });
}

/**
 * Backoffice: close a game room now (a game in progress has no result: forceDeleteRoom refunds
 * its bet). Everyone in the socket room — both players and every spectator — gets `gameClosed`
 * and `roomDeleted`, leaves the socket room, and the lobbies get the new room list.
 * Returns false when the room doesn't exist.
 */
export function closeRoomByAdmin(io: Server | null, roomId: string, reason = "Mesa cerrada por un administrador"): boolean {
  if (!roomManager.forceDeleteRoom(roomId)) return false;
  if (io) {
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

// Chat flood control: at most CHAT_MAX_PER_WINDOW messages per user per window (room + global chat)
const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX_PER_WINDOW = 8;
const chatTimestamps = new Map<string, number[]>();

function allowChatMessage(userId: string): boolean {
  const now = Date.now();
  const recent = (chatTimestamps.get(userId) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
  if (recent.length >= CHAT_MAX_PER_WINDOW) {
    chatTimestamps.set(userId, recent);
    return false;
  }
  recent.push(now);
  chatTimestamps.set(userId, recent);
  return true;
}

/**
 * Tell the room what an action did: the opponent's animation hint, coins (showCoinFlip), the
 * setup timer, every viewer's masked state and the game over. Used for players' actions and for
 * the default answers the server gives when an answer clock runs out (no actor socket).
 */
function broadcastActionResult(io: Server, roomId: string, actionType: string, result: ActionResult, actorSocketId: string | null): void {
  // Broadcast action to opponent for animation (no private data). `paused`: an attack that
  // stopped at a mid-attack question (Flee, Sabrina's ESP...) and hasn't happened yet.
  const opponentAction = { type: actionType, ...(result.attackPaused ? { paused: true } : {}) };
  if (actorSocketId) io.to(roomId).except(actorSocketId).emit("opponentAction", opponentAction);
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
      for (const specSocketId of room.spectators) {
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
    finishRoomGame(io, roomId, result.winner ?? null, result.winReason ?? "Fin de la partida", false, describeGameEnd(result.gameState));
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
        const { deckId, prizeCount, reservedUserId, friendly } = parsed.data;
        const identity = await getPlayableIdentity(userId);
        if ("error" in identity) { socket.emit("error", { message: identity.error }); return; }
        // A seat requires a deck (checkDeckPlayable rejects a missing one)
        const deckError = await checkDeckPlayable(userId, deckId);
        if (deckError) { socket.emit("error", { message: deckError }); return; }
        // Table bets are off unless ECONOMY.tableBets.enabled (the bet is forced to 0). When on:
        // friendly tables carry no bet; otherwise the bet is capped by the creator's title (lobby
        // slider), the creator must be eligible and cover it now (it's charged to both players
        // when the game starts)
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
        const room = roomManager.createRoom(
          undefined,
          { prizeCount, betAmount, reservedUserId: reservedUserId || null, friendly: friendly ?? false },
          identity,
        );
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

        broadcastRoomList(io);

        console.log(`🏠 Room ${room.id} created by ${userId} (prizes:${room.config.prizeCount}, bet:${room.config.betAmount})`);
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
        const { roomId, deckId } = parsed.data;
        // Never create a room here: the client is rejoining a game that is gone (finished,
        // deleted, or lost in an API restart). The frontend goes back to the lobby.
        const target = roomManager.getRoom(roomId);
        if (!target) {
          socket.emit("error", { code: "ROOM_NOT_FOUND", message: new RoomNotFoundError().message });
          return;
        }
        const identity = await getPlayableIdentity(userId);
        if ("error" in identity) { socket.emit("error", { message: identity.error }); return; }
        // Taking a seat requires a playable deck; reconnecting to your own seat doesn't
        const seated = roomManager.seatOf(target, userId) !== null;
        if (!seated || deckId) {
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

        // Auto-close any waiting room the user owns before joining another
        const existingWaitingRoom = roomManager.findWaitingRoomByUser(userId);
        if (existingWaitingRoom && existingWaitingRoom.id !== roomId) {
          // Force-close waiting room since user is joining another
          roomManager.forceDeleteRoom(existingWaitingRoom.id);
          broadcastRoomList(io);
          console.log(`🗑️ Auto-deleted waiting room ${existingWaitingRoom.id} (user ${userId} joining ${roomId})`);
        }

        console.log(`[joinRoom] Attempting to join room ${roomId} as ${userId}`);
        const room = await roomManager.joinRoom(roomId, userId, socket.id, identity);
        console.log(`[joinRoom] Room state after join:`, {
          player1Id: room.player1Id,
          player2Id: room.player2Id,
          status: room.status,
        });

        // Set deck if provided (only before the game starts)
        if (deckId && room.status === "waiting") {
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

          // Build variant maps for reconnection
          const [p1Variants, p2Variants] = await Promise.all([
            getVariantMapForDeck(room.player1DeckId),
            getVariantMapForDeck(room.player2DeckId),
          ]);

          // Send current game state to the reconnecting player
          socket.emit("gameStart", {
            roomId,
            gameState: stateFor(room, room.gameState, isPlayer1 ? "player1" : "player2"),
            isPlayer1,
            opponentInfo: isPlayer1 ? room.joiner : room.creator,
            playerVariantMap: isPlayer1 ? p1Variants : p2Variants,
            opponentVariantMap: isPlayer1 ? p2Variants : p1Variants,
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });
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

          // Build variant maps from deck entries
          const [p1Variants, p2Variants] = await Promise.all([
            getVariantMapForDeck(room.player1DeckId),
            getVariantMapForDeck(room.player2DeckId),
          ]);

          // Send masked state to each player
          io.to(room.player1SocketId!).emit("gameStart", {
            roomId,
            gameState: stateFor(room, gameState, "player1"),
            isPlayer1: true,
            opponentInfo: room.joiner,
            playerVariantMap: p1Variants,
            opponentVariantMap: p2Variants,
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });
          io.to(room.player2SocketId!).emit("gameStart", {
            roomId,
            gameState: stateFor(room, gameState, "player2"),
            isPlayer1: false,
            opponentInfo: room.creator,
            playerVariantMap: p2Variants,
            opponentVariantMap: p1Variants,
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
        socket.emit("error", { message: (error as Error).message });
      }
    });

    socket.on("leaveRoom", async (payload: unknown) => {
      try {
        if (!getAuthUserId(socket)) { socket.emit("error", { message: "Autenticación requerida" }); return; }
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
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

          // Build variant maps from deck entries
          const [p1Variants, p2Variants] = await Promise.all([
            getVariantMapForDeck(room.player1DeckId),
            getVariantMapForDeck(room.player2DeckId),
          ]);

          // Send masked state to each player
          io.to(room.player1SocketId!).emit("gameStart", {
            gameState: stateFor(room, gameState, "player1"),
            opponentInfo: room.joiner,
            playerVariantMap: p1Variants,
            opponentVariantMap: p2Variants,
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });
          io.to(room.player2SocketId!).emit("gameStart", {
            gameState: stateFor(room, gameState, "player2"),
            opponentInfo: room.creator,
            playerVariantMap: p2Variants,
            opponentVariantMap: p1Variants,
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

        // Get room and state before action
        const roomBefore = roomManager.getRoom(roomId);
        const eventCountBefore = roomBefore?.gameState?.events?.length ?? 0;

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
      if (!socket.rooms.has(roomId) || !roomManager.getRoom(roomId)) return;
      if (!allowChatMessage(tokenUser.userId)) return;

      // Fetch username from DB (not in JWT)
      const dbUser = await prisma.user.findUnique({
        where: { id: tokenUser.userId },
        select: { username: true, role: true },
      });

      io.to(roomId).emit("chatMessage", {
        senderId: socket.id,
        userId: tokenUser.userId,
        username: dbUser?.username ?? "Anónimo",
        role: dbUser?.role ?? "user",
        content,
        timestamp: Date.now(),
      });
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

    socket.on("spectateRoom", async (payload: unknown) => {
      try {
        const parsed = parsePayload(socketSchemas.roomRef, payload);
        if (!parsed.ok) { socket.emit("error", { message: parsed.error }); return; }
        const { roomId } = parsed.data;
        const room = roomManager.addSpectator(roomId, socket.id);

        if (!room) {
          socket.emit("error", { message: "Room not found or not playing" });
          return;
        }

        socket.join(roomId);

        // Send current game state from player1 perspective (neutral view)
        if (room.gameState) {
          socket.emit("gameStart", {
            roomId,
            gameState: stateFor(room, room.gameState, "spectator"),
            isPlayer1: true, // spectator sees from P1 perspective
            isSpectator: true,
            opponentInfo: room.joiner,
            creatorInfo: room.creator,
            turnStartedAt: room.turnStartedAt,
            turnTimerDuration: room.turnTimerDuration,
          });
        }

        // Notify room about spectator
        io.to(roomId).emit("spectatorUpdate", { count: room.spectators.size });

        console.log(`👁️ Spectator ${socket.id} joined room ${roomId} (total: ${room.spectators.size})`);
      } catch (error) {
        socket.emit("error", { message: (error as Error).message });
      }
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
    io.to(roomId).emit("answerTimedOut", {
      userId: (side === "player1" ? room?.player1Id : room?.player2Id) ?? null,
      actionType: action.type,
    });
    broadcastActionResult(io, roomId, action.type, result, null);
  });

  // A waiting room deleted by the manager (its creator left the lobby): refresh the lobbies
  roomManager.setOnRoomClosed((roomId) => {
    io.to(roomId).emit("roomDeleted", { roomId });
    io.in(roomId).socketsLeave(roomId);
    broadcastRoomList(io);
  });
}
