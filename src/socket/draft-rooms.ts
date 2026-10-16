/**
 * Draft Room Manager
 *
 * Manages multiplayer booster draft rooms: lobby, drafting (pick & rotate),
 * deck building, and match pairing phases.
 *
 * Draft packs include Pokemon + Trainers + Double Colorless Energy.
 * Basic energy is excluded (players add unlimited basic energy during deck building).
 */

import {
  ALL_CARDS,
  CARD_SETS,
  findCardDefinition,
  isBasicEnergy,
  isEnergyCard,
  isPlayableAsBasic,
  isPokemonCard,
} from "@gonzaloaguila/game-core";
import type { Card, CardSetId, GameCard } from "@gonzaloaguila/game-core";
import { ECONOMY } from "../modules/economy/config.js";

// ============================================================================
// Types
// ============================================================================

/** What a draft pack is opened from: one set, every set mixed together, or only Trainers (every set). */
export const MIXED_PACK = "mixed";
export const TRAINERS_PACK = "trainers";
export type DraftPackSet = CardSetId | typeof MIXED_PACK | typeof TRAINERS_PACK;
export const DRAFT_PACK_SETS: readonly [DraftPackSet, ...DraftPackSet[]] = [
  MIXED_PACK,
  TRAINERS_PACK,
  ...CARD_SETS.map((set) => set.id),
];

export type DraftConfig = {
  maxPlayers: number; // 2-8
  packsPerPlayer: number; // default 3
  /** One entry per pack (round), always packsPerPlayer long; default all mixed */
  packSets: DraftPackSet[];
  cardsPerPack: number; // default 11
  pickTimeSeconds: number; // default 45
  keepInCollection: boolean;
  minDeckSize: number; // default 40
  entryFee: number; // 0 = free, default 2000
  adminPlays: boolean; // if true, admin takes seat 0 and plays (doesn't pay)
};

export type DraftPhase =
  | "lobby"
  | "drafting"
  | "bonus-pick"
  | "building"
  | "matching"
  | "finished";

export type PendingMatchInfo = {
  gameRoomId: string;
  matchNumber: number;
  roundNumber: number;
  isPlayer1: boolean;
  opponentName: string;
};

export type DraftPlayer = {
  id: string;
  socketId: string | null;
  name: string;
  seatIndex: number;
  currentPack: GameCard[];
  draftedCards: GameCard[];
  deck: GameCard[] | null;
  isReady: boolean;
  isAdmin: boolean;
  pendingMatchInfo: PendingMatchInfo | null;
  /** Left the tournament (withdrawPlayer): every match of theirs not played yet is lost. */
  withdrawn: boolean;
};

export type DraftEvent = {
  id: string;
  timestamp: number;
  message: string;
  type: "info" | "pick" | "system";
};

export type DraftRoom = {
  id: string;
  config: DraftConfig;
  phase: DraftPhase;
  players: DraftPlayer[];
  currentRound: number;
  currentPick: number;
  direction: "clockwise" | "counterclockwise";
  pickDeadline: number;
  events: DraftEvent[];
  createdAt: Date;
  pickTimer: ReturnType<typeof setTimeout> | null;
  matchPairings: MatchPairing[] | null;
  tournament: Tournament | null;
  bonusPickPool: GameCard[];
  /** Admin user ID (always set, even when admin is also a player) */
  adminId: string;
  /** Admin socket ID for sending state updates when admin is spectating */
  adminSocketId: string | null;
  /** Admin display name (for room list when admin is not a player) */
  adminName: string;
  /**
   * Pending advance once only disconnected players are left to act (a pick, the bonus picks,
   * a deck): they get DISCONNECT_GRACE to come back (e.g. lobby -> table navigation) before
   * the server acts for them.
   */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Players charged the entry fee (draft:start), refunded if the room closes unplayed. */
  entryPaidIds: string[];
  /** keepInCollection: the drafted cards were credited (once). */
  cardsCredited: boolean;
  /** Coins for the prizes: entry fees paid + withdraw penalties. */
  prizePool: number;
  /** Set when the tournament ends: each final position and its coins (paid once: prizesPaid). */
  prizes: DraftPrize[] | null;
  prizesPaid: boolean;
  /** Removes a finished room after FINISHED_ROOM_TTL_MS, or a lobby nobody is in after EMPTY_LOBBY_TTL_MS. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** draft:start is charging the entry fees: nobody new may sit down meanwhile. */
  starting: boolean;
};

/** A player's final position and the coins it won. */
export type DraftPrize = {
  playerId: string;
  playerName: string;
  position: number;
  coins: number;
  withdrawn: boolean;
};

/** Masked player visible to other players (hides pack & specific cards) */
export type ClientDraftPlayer = {
  id: string;
  name: string;
  seatIndex: number;
  isReady: boolean;
  isAdmin: boolean;
  isYou: boolean;
  withdrawn: boolean;
  currentPack: GameCard[] | null; // only when isYou
  draftedCards: GameCard[] | null; // only when isYou
  deck: GameCard[] | null; // only when isYou (building phase)
  currentPackSize: number;
  draftedCardsCount: number;
};

export type MatchPairing = {
  matchNumber: number;
  player1: { id: string; name: string };
  player2: { id: string; name: string };
};

export type MatchResult = {
  matchNumber: number;
  roundNumber: number;
  player1Id: string;
  player2Id: string;
  winnerId: string | null;
  loserId: string | null;
  isBye: boolean;
  /** Not played: a player had left the tournament (both of them when winnerId is null). */
  walkover: boolean;
  gameRoomId: string | null;
};

export type PlayerStanding = {
  playerId: string;
  playerName: string;
  wins: number;
  losses: number;
  /** Rounds without an opponent (odd number of players); a bye is not a win. */
  byes: number;
  withdrawn: boolean;
};

export type TournamentRound = {
  roundNumber: number;
  pairings: MatchPairing[];
  byePlayerId: string | null;
  status: "pending" | "in_progress" | "completed";
  results: MatchResult[];
};

export type Tournament = {
  rounds: TournamentRound[];
  standings: PlayerStanding[];
  currentRoundNumber: number;
  totalRounds: number;
};

/** Maps a game room back to its parent draft context */
export type GameRoomDraftInfo = {
  draftRoomId: string;
  roundNumber: number;
  matchNumber: number;
  player1Id: string;
  player2Id: string;
};

/** State sent to each client (masked per player) */
export type ClientDraftState = {
  roomId: string;
  config: DraftConfig;
  phase: DraftPhase;
  players: ClientDraftPlayer[];
  currentRound: number;
  currentPick: number;
  direction: "clockwise" | "counterclockwise";
  pickDeadline: number;
  events: DraftEvent[];
  matchPairings: MatchPairing[] | null;
  tournament: Tournament | null;
  bonusPickPool: GameCard[];
  /** The viewer is this draft's admin (creator, or the admin seat): show Start / Close. */
  isAdminViewer: boolean;
  prizePool: number;
  /** Final positions and prizes, once the tournament is over. */
  prizes: DraftPrize[] | null;
};

/** Room info for the lobby list */
export type DraftRoomInfo = {
  id: string;
  config: DraftConfig;
  phase: DraftPhase;
  playerCount: number;
  maxPlayers: number;
  adminName: string;
  /** The creator: they rejoin their own room without paying */
  adminId: string;
  entryFee: number;
  adminPlays: boolean;
};

export type BroadcastFn = (roomId: string) => void;

/**
 * Why a room closed. unplayed: before the tournament started; cancelled: during it (an admin
 * closed it). Both refund the entry fees; a played or cancelled tournament keeps the drafted
 * cards (keepInCollection). `gameRoomIds`: draft games still being played, to be closed.
 */
export type DraftClosedInfo = { unplayed: boolean; cancelled: boolean; reason: string; gameRoomIds: string[] };

/** What the socket layer does when the draft moves on by itself (timers, grace periods). */
export type DraftHooks = {
  /** Round 1 is paired (all decks in): create the game rooms. */
  onTournamentStart?: (room: DraftRoom) => void;
  /** The room is gone (admin close, too few players left): refunds, credits, notify clients. */
  onRoomClosed?: (room: DraftRoom, info: DraftClosedInfo) => void;
  /** The tournament ended. */
  onFinished?: (room: DraftRoom) => void;
  /**
   * A player left the draft without a playable deck (deck-building deadline): tell them and
   * give back `refund` coins (their entry fee, already taken out of the prize pool).
   */
  onPlayerRemoved?: (room: DraftRoom, player: DraftPlayer, info: { reason: string; refund: number }) => void;
};

export type DraftTimings = {
  /** Time a disconnected player has to come back before the server acts for them. */
  disconnectGraceMs: number;
  /** Bonus-pick phase deadline (then 3 random bonus cards for whoever didn't pick). */
  bonusPickSeconds: number;
  /** Deck-building deadline (then an automatic deck, or removal without a Basic Pokémon). */
  buildingSeconds: number;
};

export const DEFAULT_DRAFT_TIMINGS: DraftTimings = {
  disconnectGraceMs: 10_000,
  bonusPickSeconds: 120,
  buildingSeconds: 600,
};

const BONUS_PICKS = 3;
/** Most drafted cards an automatic deck uses; the rest of the deck is basic Energy. */
const AUTO_DECK_MAX_CARDS = 36;
const AUTO_DECK_MIN_ENERGY = 24;
const BASIC_ENERGY_TYPES = ["grass", "fire", "water", "lightning", "psychic", "fighting"] as const;

/** Catalog id of a drafted card (draft instances have their own ids), or null. */
export function catalogIdOf(card: GameCard): string | null {
  return findCardDefinition(card.set, card.number)?.id ?? null;
}

// ============================================================================
// Pack Generation
// ============================================================================

// Every set in game-core's registry
export const draftPool: readonly Card[] = ALL_CARDS.filter((card) => !isBasicEnergy(card));

function rarityPools(cards: readonly Card[]) {
  return {
    common: cards.filter((c) => c.rarity === "common"),
    uncommon: cards.filter((c) => c.rarity === "uncommon"),
    rare: cards.filter((c) => c.rarity === "rare"),
    rareHolo: cards.filter((c) => c.rarity === "rare-holo"),
  };
}

const poolsByPackSet = new Map<DraftPackSet, ReturnType<typeof rarityPools>>([
  [MIXED_PACK, rarityPools(draftPool)],
  [TRAINERS_PACK, rarityPools(draftPool.filter((c) => c.kind === "trainer"))],
  ...CARD_SETS.map((set) => [set.id, rarityPools(draftPool.filter((c) => c.set === set.name))] as const),
]);

/** Pack sets for every round: the admin's choice per pack, mixed where none was given. */
export function normalizePackSets(packSets: readonly DraftPackSet[] | undefined, packsPerPlayer: number): DraftPackSet[] {
  return Array.from({ length: packsPerPlayer }, (_, i) => packSets?.[i] ?? MIXED_PACK);
}

/**
 * Bonus picks come from what the draft was played with: every card if any pack was mixed,
 * else the cards of the chosen sets plus every Trainer if a Trainers pack was opened.
 */
export function bonusPoolFor(packSets: readonly DraftPackSet[]): readonly Card[] {
  if (packSets.length === 0 || packSets.includes(MIXED_PACK)) return draftPool;
  const names = new Set(CARD_SETS.filter((set) => packSets.includes(set.id)).map((set) => set.name));
  const withTrainers = packSets.includes(TRAINERS_PACK);
  return draftPool.filter((card) => names.has(card.set) || (withTrainers && card.kind === "trainer"));
}

/** "Jungle", "todas las expansiones" or "Entrenadores" (round announcements). */
export function packSetLabel(packSet: DraftPackSet): string {
  if (packSet === MIXED_PACK) return "todas las expansiones";
  if (packSet === TRAINERS_PACK) return "Entrenadores";
  return CARD_SETS.find((set) => set.id === packSet)?.name ?? packSet;
}

let cardIdCounter = 0;

function generateCardId(): string {
  return `draft-${Date.now()}-${++cardIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function toGameCard(card: Card): GameCard {
  return { ...card, id: generateCardId() };
}

function shuffle<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pickUnique(
  pool: readonly Card[],
  count: number,
  usedIds: Set<string>,
): Card[] {
  const available = pool.filter((c) => !usedIds.has(c.id));
  const picked = shuffle(available).slice(0, count);
  for (const c of picked) usedIds.add(c.id);
  return picked;
}

export function generatePack(cardsPerPack: number, packSet: DraftPackSet = MIXED_PACK): GameCard[] {
  const usedIds = new Set<string>();
  const pools = poolsByPackSet.get(packSet) ?? poolsByPackSet.get(MIXED_PACK)!;

  // Jungle, Fossil and Team Rocket only list holo rares: their one rare slot is a holo and
  // the second rare slot becomes an uncommon.
  const hasPlainRares = pools.rare.length > 0;
  const rareSlotCount = cardsPerPack >= 10 && hasPlainRares ? 2 : 1;
  const remaining = cardsPerPack - rareSlotCount;
  const uncommonCount = Math.max(1, Math.round(remaining * 0.3));
  const commonCount = remaining - uncommonCount;

  // Guaranteed non-holo rare (a holo in sets without them)
  const rares = pickUnique(hasPlainRares ? pools.rare : pools.rareHolo, 1, usedIds);

  // Second rare slot: 33% chance holo
  if (rareSlotCount >= 2) {
    const isHolo = Math.random() < 0.33;
    const pool = isHolo ? pools.rareHolo : pools.rare;
    rares.push(...pickUnique(pool, 1, usedIds));
  }

  const uncommons = pickUnique(pools.uncommon, uncommonCount, usedIds);
  const commons = pickUnique(pools.common, commonCount, usedIds);

  return shuffle([...commons, ...uncommons, ...rares]).map(toGameCard);
}

/**
 * A playable deck from a player's drafted cards, for whoever didn't build one in time: up to
 * AUTO_DECK_MAX_CARDS drafted cards (Basic Pokémon first, then the other Pokémon, Trainers and
 * special Energy) plus basic Energy of the Pokémon's types, at least AUTO_DECK_MIN_ENERGY and
 * enough to reach `minDeckSize`. Null without a card playable as a Basic Pokémon.
 */
export function buildAutoDeck(
  drafted: GameCard[],
  minDeckSize: number,
  createEnergy: (type: string) => GameCard,
): GameCard[] | null {
  if (!drafted.some((card) => isPlayableAsBasic(card))) return null;
  const rank = (card: GameCard): number => {
    if (isPlayableAsBasic(card)) return 0;
    if (isPokemonCard(card)) return 1;
    return 2;
  };
  const chosen = [...drafted]
    .filter((card) => !isBasicEnergy(card))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, AUTO_DECK_MAX_CARDS);

  const typeCounts = new Map<string, number>();
  for (const card of chosen) {
    if (!isPokemonCard(card)) continue;
    for (const type of card.types) {
      if ((BASIC_ENERGY_TYPES as readonly string[]).includes(type)) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
  }
  const types = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  if (types.length === 0) types.push("fighting");

  const energyCount = Math.max(minDeckSize - chosen.length, AUTO_DECK_MIN_ENERGY);
  const total = types.reduce((sum, type) => sum + (typeCounts.get(type) ?? 1), 0);
  const deck: GameCard[] = [...chosen];
  let added = 0;
  types.forEach((type, i) => {
    const share = i === types.length - 1
      ? energyCount - added
      : Math.floor((energyCount * (typeCounts.get(type) ?? 1)) / total);
    for (let n = 0; n < share; n++) deck.push(createEnergy(type));
    added += share;
  });
  return deck;
}

// ============================================================================
// DraftRoomManager
// ============================================================================

export class DraftRoomManager {
  private rooms = new Map<string, DraftRoom>();
  private socketToRoom = new Map<string, string>();
  private gameRoomToDraft = new Map<string, GameRoomDraftInfo>();
  private broadcastFn: BroadcastFn | null = null;
  private hooks: DraftHooks = {};
  private timings: DraftTimings;

  constructor(timings: Partial<DraftTimings> = {}) {
    this.timings = { ...DEFAULT_DRAFT_TIMINGS, ...timings };
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn;
  }

  /** What to do when the draft moves on by itself (see DraftHooks). Idempotent. */
  setHooks(hooks: DraftHooks): void {
    this.hooks = hooks;
  }

  /** Tests shorten the timers. */
  setTimings(timings: Partial<DraftTimings>): void {
    this.timings = { ...this.timings, ...timings };
  }

  private broadcast(roomId: string): void {
    this.broadcastFn?.(roomId);
  }

  // --------------------------------------------------------------------------
  // Room Lifecycle
  // --------------------------------------------------------------------------

  createRoom(
    config: Partial<DraftConfig>,
    adminId: string,
    adminSocketId: string,
    adminName: string,
  ): DraftRoom {
    const roomId = this.generateRoomId();
    const packsPerPlayer = config.packsPerPlayer ?? 3;
    const fullConfig: DraftConfig = {
      maxPlayers: config.maxPlayers ?? 8,
      packsPerPlayer,
      packSets: normalizePackSets(config.packSets, packsPerPlayer),
      cardsPerPack: config.cardsPerPack ?? 11,
      pickTimeSeconds: config.pickTimeSeconds ?? 45,
      keepInCollection: config.keepInCollection ?? false,
      minDeckSize: config.minDeckSize ?? 40,
      entryFee: config.entryFee ?? 2000,
      adminPlays: config.adminPlays ?? false,
    };

    const players: DraftPlayer[] = [];

    // If adminPlays, admin takes seat 0 as a participating player
    if (fullConfig.adminPlays) {
      players.push({
        id: adminId,
        socketId: adminSocketId,
        name: adminName,
        seatIndex: 0,
        currentPack: [],
        draftedCards: [],
        deck: null,
        isReady: false,
        isAdmin: true,
        pendingMatchInfo: null,
        withdrawn: false,
      });
    }

    const room: DraftRoom = {
      id: roomId,
      config: fullConfig,
      phase: "lobby",
      players,
      currentRound: 0,
      currentPick: 0,
      direction: "clockwise",
      pickDeadline: 0,
      events: [this.createEvent("system", `${adminName} creó la sala de draft`)],
      createdAt: new Date(),
      pickTimer: null,
      matchPairings: null,
      tournament: null,
      bonusPickPool: [],
      adminId,
      adminSocketId,
      adminName,
      graceTimer: null,
      entryPaidIds: [],
      cardsCredited: false,
      prizePool: 0,
      prizes: null,
      prizesPaid: false,
      expiryTimer: null,
      starting: false,
    };

    this.rooms.set(roomId, room);
    this.socketToRoom.set(adminSocketId, roomId);
    return room;
  }

  joinRoom(
    roomId: string,
    userId: string,
    socketId: string,
    name: string,
  ): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    // Somebody is back in an empty lobby: it stays
    if (room.phase === "lobby") this.cancelExpiry(room);

    // The creator of a room they play in (adminPlays) left the lobby: they take a seat again
    // (the seat, admin included, may have been passed on meanwhile)
    if (
      room.adminId === userId &&
      room.config.adminPlays &&
      room.phase === "lobby" &&
      !room.starting &&
      !room.players.some((p) => p.id === userId) &&
      room.players.length < room.config.maxPlayers
    ) {
      for (const p of room.players) p.isAdmin = false;
      room.players.unshift({
        id: userId,
        socketId,
        name,
        seatIndex: 0,
        currentPack: [],
        draftedCards: [],
        deck: null,
        isReady: false,
        isAdmin: true,
        pendingMatchInfo: null,
        withdrawn: false,
      });
      room.players.forEach((p, i) => {
        p.seatIndex = i;
      });
      room.adminSocketId = socketId;
      room.events.push(this.createEvent("info", `${name} volvió al draft`));
      this.socketToRoom.set(socketId, roomId);
      return room;
    }

    // Reconnection: spectating admin reconnects (not in players array)
    if (room.adminId === userId && !room.players.find((p) => p.id === userId)) {
      room.adminSocketId = socketId;
      this.socketToRoom.set(socketId, roomId);
      return room;
    }

    // Reconnection: existing player updates their socket (allowed in any phase). Any pending
    // grace advance re-checks on expiry, so a returning player acts for themselves.
    const existing = room.players.find((p) => p.id === userId);
    if (existing) {
      if (existing.socketId && existing.socketId !== socketId) this.socketToRoom.delete(existing.socketId);
      existing.socketId = socketId;
      this.socketToRoom.set(socketId, roomId);
      return room;
    }

    // New players can only join during lobby phase
    if (room.phase !== "lobby") throw new Error("El draft ya comenzó");
    if (room.starting) throw new Error("El draft está comenzando");
    if (room.players.length >= room.config.maxPlayers)
      throw new Error("Sala llena");

    room.players.push({
      id: userId,
      socketId,
      name,
      seatIndex: room.players.length,
      currentPack: [],
      draftedCards: [],
      deck: null,
      isReady: false,
      isAdmin: false,
      pendingMatchInfo: null,
      withdrawn: false,
    });

    room.events.push(this.createEvent("info", `${name} se unió al draft`));
    this.socketToRoom.set(socketId, roomId);
    return room;
  }

  leaveRoom(roomId: string, socketId: string): DraftRoom | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const idx = room.players.findIndex((p) => p.socketId === socketId);
    if (idx === -1) return null;
    const player = room.players[idx];

    // During active draft, mark as disconnected (don't remove)
    if (room.phase !== "lobby") {
      player.socketId = null;
      room.events.push(
        this.createEvent("system", `${player.name} se desconectó`),
      );
      this.socketToRoom.delete(socketId);
      this.evaluateProgress(room);
      return this.rooms.has(roomId) ? room : null;
    }

    // In lobby, fully remove the player
    room.players.splice(idx, 1);
    room.players.forEach((p, i) => {
      p.seatIndex = i;
    });
    room.events.push(
      this.createEvent("info", `${player.name} salió del draft`),
    );
    this.socketToRoom.delete(socketId);
    // The playing admin left their seat: nobody watches as admin from that socket anymore
    if (room.adminSocketId === socketId) room.adminSocketId = null;

    // Promote new admin or close empty room
    if (player.isAdmin && room.players.length > 0) {
      room.players[0].isAdmin = true;
      room.events.push(
        this.createEvent(
          "system",
          `${room.players[0].name} es el nuevo admin`,
        ),
      );
    } else if (room.players.length === 0 && !room.adminSocketId) {
      // Nobody left, not even the admin watching: removed unless someone comes back
      this.scheduleEmptyLobbyExpiry(room);
    }

    return room;
  }

  /** An empty lobby waits EMPTY_LOBBY_TTL_MS for its admin or a player, then it is closed. */
  private scheduleEmptyLobbyExpiry(room: DraftRoom): void {
    this.cancelExpiry(room);
    room.expiryTimer = setTimeout(() => {
      room.expiryTimer = null;
      if (room.phase === "lobby" && room.players.length === 0 && !room.adminSocketId) {
        this.closeRoom(room, "La mesa se cerró: no quedó nadie");
      }
    }, EMPTY_LOBBY_TTL_MS);
    room.expiryTimer.unref?.();
  }

  private cancelExpiry(room: DraftRoom): void {
    if (room.expiryTimer) clearTimeout(room.expiryTimer);
    room.expiryTimer = null;
  }

  /**
   * Remove a player by userId (used for kicking players who can't pay entry fee).
   * Only works during lobby phase.
   */
  removePlayer(roomId: string, userId: string): DraftPlayer | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const idx = room.players.findIndex((p) => p.id === userId);
    if (idx === -1) return null;

    const player = room.players[idx];
    if (player.socketId) this.socketToRoom.delete(player.socketId);

    room.players.splice(idx, 1);
    // Re-index seat positions
    room.players.forEach((p, i) => {
      p.seatIndex = i;
    });

    room.events.push(
      this.createEvent("system", `${player.name} fue removido del draft`),
    );

    return player;
  }

  /**
   * Whether `userId` runs this draft: its creator (room.adminId, playing or spectating, from
   * any socket) or the player holding the admin seat (passed on when the admin left the lobby).
   */
  isRoomAdmin(room: DraftRoom, userId: string): boolean {
    return room.adminId === userId || room.players.some((p) => p.id === userId && p.isAdmin);
  }

  /**
   * Close a room on request: its admin (by user id, from any socket) or a site admin
   * (backoffice). Throws a Spanish reason otherwise. Entry fees of a room closed before its
   * tournament are refunded (onRoomClosed).
   */
  deleteRoom(roomId: string, userId: string, isSiteAdmin = false): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    if (!isSiteAdmin && !this.isRoomAdmin(room, userId)) {
      throw new Error("Solo el admin puede cerrar el draft");
    }
    this.closeRoom(room, "La sala fue cerrada por el admin");
    return room;
  }

  /** Remove the room, its timers and mappings; refunds / credits go through onRoomClosed. */
  private closeRoom(room: DraftRoom, reason: string): void {
    if (!this.rooms.has(room.id)) return;
    this.clearTimers(room);
    for (const p of room.players) {
      if (p.socketId) this.socketToRoom.delete(p.socketId);
    }
    if (room.adminSocketId) this.socketToRoom.delete(room.adminSocketId);
    const gameRoomIds: string[] = [];
    for (const [gameRoomId, info] of this.gameRoomToDraft) {
      if (info.draftRoomId === room.id) {
        gameRoomIds.push(gameRoomId);
        this.gameRoomToDraft.delete(gameRoomId);
      }
    }
    this.rooms.delete(room.id);
    const unplayed = room.phase !== "matching" && room.phase !== "finished";
    const cancelled = room.phase === "matching";
    this.hooks.onRoomClosed?.(room, { unplayed, cancelled, reason, gameRoomIds });
  }

  /** Mark the room as charging its entry fees (draft:start): no new player sits down meanwhile. */
  setStarting(roomId: string, starting: boolean): void {
    const room = this.rooms.get(roomId);
    if (room) room.starting = starting;
  }

  private clearTimers(room: DraftRoom): void {
    if (room.pickTimer) clearTimeout(room.pickTimer);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    if (room.expiryTimer) clearTimeout(room.expiryTimer);
    room.pickTimer = null;
    room.graceTimer = null;
    room.expiryTimer = null;
  }

  // --------------------------------------------------------------------------
  // Draft Flow
  // --------------------------------------------------------------------------

  /** Throws unless `userId` is the room admin and the room can start. Does not mutate. */
  assertCanStart(roomId: string, userId: string): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");

    // Admin can be in players array (adminPlays) or spectating, from any socket
    if (!this.isRoomAdmin(room, userId))
      throw new Error("Solo el admin puede iniciar el draft");
    if (room.players.length < 2)
      throw new Error("Se necesitan al menos 2 jugadores");
    if (room.phase !== "lobby") throw new Error("El draft ya comenzó");
    return room;
  }

  startDraft(roomId: string, userId: string, entryPaidIds: string[] = []): DraftRoom {
    const room = this.assertCanStart(roomId, userId);

    room.phase = "drafting";
    room.currentRound = 1;
    room.currentPick = 1;
    room.direction = "clockwise";
    room.entryPaidIds = [...entryPaidIds];
    room.prizePool = room.config.entryFee * entryPaidIds.length;

    // Defensive: ensure clean state before starting
    for (const p of room.players) {
      p.draftedCards = [];
      p.isReady = false;
    }

    this.generatePacksForRound(room);
    room.events.push(
      this.createEvent("system", `¡Comienza la Ronda 1! Dirección: → · Sobres de ${packSetLabel(room.config.packSets[0])}`),
    );
    this.startPickTimer(room);
    return room;
  }

  pickCard(roomId: string, socketId: string, cardId: string): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    if (room.phase !== "drafting") throw new Error("No es fase de draft");

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) throw new Error("Jugador no encontrado");
    if (player.isReady) throw new Error("Ya elegiste una carta");

    const cardIdx = player.currentPack.findIndex((c) => c.id === cardId);
    if (cardIdx === -1)
      throw new Error("Carta no encontrada en tu sobre");

    const [pickedCard] = player.currentPack.splice(cardIdx, 1);
    player.draftedCards.push(pickedCard);
    player.isReady = true;

    room.events.push(
      this.createEvent("pick", `${player.name} eligió una carta`),
    );

    this.evaluateProgress(room);
    return room;
  }

  bonusPick(roomId: string, socketId: string, cardDefIds: string[]): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    if (room.phase !== "bonus-pick") throw new Error("No es fase de bonus pick");

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) throw new Error("Jugador no encontrado");
    if (player.isReady) throw new Error("Ya elegiste tus cartas bonus");
    if (cardDefIds.length !== BONUS_PICKS) throw new Error("Debes elegir exactamente 3 cartas");
    if (new Set(cardDefIds).size !== cardDefIds.length) throw new Error("Elige 3 cartas distintas");

    // Find cards from the bonus pool by their draft ID (all of them before adding any)
    const templates = cardDefIds.map((defId) => {
      const template = room.bonusPickPool.find((c) => c.id === defId);
      if (!template) throw new Error(`Carta ${defId} no encontrada en el pool`);
      return template;
    });
    // Create a new GameCard instance with unique draft ID
    for (const template of templates) player.draftedCards.push({ ...template, id: generateCardId() });

    player.isReady = true;
    room.events.push(this.createEvent("pick", `${player.name} eligió sus 3 cartas bonus`));

    this.evaluateProgress(room);
    return room;
  }

  submitDeck(
    roomId: string,
    socketId: string,
    deckCardIds: string[],
    energyCards: { type: string; count: number }[],
  ): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    if (room.phase !== "building")
      throw new Error("No es fase de construcción");

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) throw new Error("Jugador no encontrado");

    // Validate drafted card IDs (each drafted card at most once)
    if (new Set(deckCardIds).size !== deckCardIds.length) throw new Error("Carta repetida en el mazo");
    const draftedIdSet = new Set(player.draftedCards.map((c) => c.id));
    for (const id of deckCardIds) {
      if (!draftedIdSet.has(id))
        throw new Error("Carta inválida en el mazo");
    }

    // Build deck: drafted cards + basic energy
    const deckCards: GameCard[] = deckCardIds.map((id) => {
      const card = player.draftedCards.find((c) => c.id === id);
      if (!card) throw new Error(`Carta ${id} no encontrada`);
      return card;
    });

    for (const { type, count } of energyCards) {
      for (let i = 0; i < count; i++) {
        deckCards.push(this.createBasicEnergyCard(type));
      }
    }

    if (deckCards.length < room.config.minDeckSize) {
      throw new Error(
        `El mazo necesita al menos ${room.config.minDeckSize} cartas (tiene ${deckCards.length})`,
      );
    }
    if (deckCards.length > MAX_DRAFT_DECK_SIZE) {
      throw new Error(`El mazo puede tener hasta ${MAX_DRAFT_DECK_SIZE} cartas (tiene ${deckCards.length})`);
    }
    // Without a card playable as a Basic Pokémon the game's opening mulligans forever
    if (!deckCards.some((card) => isPlayableAsBasic(card))) {
      throw new Error("El mazo necesita al menos un Pokémon básico");
    }

    player.deck = deckCards;
    player.isReady = true;
    room.events.push(
      this.createEvent("info", `${player.name} terminó su mazo`),
    );

    // All decks submitted → generate round-robin schedule and start tournament
    this.evaluateProgress(room);
    return room;
  }

  // --------------------------------------------------------------------------
  // Progress: who is the room waiting on?
  // --------------------------------------------------------------------------

  /**
   * After a pick / bonus pick / deck, or a disconnect: when every player is done, move on at
   * once; when only disconnected players are missing, give them the grace period to come back
   * (lobby -> table navigation drops every socket for a moment) and then act for them.
   * Disconnected players never block the room.
   */
  private evaluateProgress(room: DraftRoom): void {
    if (!["drafting", "bonus-pick", "building"].includes(room.phase)) return;
    if (room.players.every((p) => p.isReady)) {
      this.advancePhase(room);
      return;
    }
    const onlyDisconnectedLeft = room.players.every((p) => p.isReady || p.socketId === null);
    if (onlyDisconnectedLeft && !room.graceTimer) {
      const phase = room.phase;
      const pick = room.currentPick;
      const round = room.currentRound;
      room.graceTimer = setTimeout(() => {
        room.graceTimer = null;
        if (!this.rooms.has(room.id) || room.phase !== phase || room.currentPick !== pick || room.currentRound !== round) return;
        // Someone came back and hasn't acted yet: the phase timer handles them
        if (!room.players.every((p) => p.isReady || p.socketId === null)) return;
        this.advancePhase(room);
      }, this.timings.disconnectGraceMs);
    }
  }

  /** Move on from the current step, acting for whoever didn't (timeout or grace expired). */
  private advancePhase(room: DraftRoom): void {
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    if (room.phase === "drafting") this.advancePick(room);
    else if (room.phase === "bonus-pick") this.finishBonusPick(room);
    else if (room.phase === "building") this.finishBuilding(room);
  }

  // --------------------------------------------------------------------------
  // State Queries
  // --------------------------------------------------------------------------

  getMaskedState(roomId: string, forSocketId: string): ClientDraftState | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const players: ClientDraftPlayer[] = room.players.map((p) => {
      const isYou = p.socketId === forSocketId;
      return {
        id: p.id,
        name: p.name,
        seatIndex: p.seatIndex,
        isReady: p.isReady,
        isAdmin: p.isAdmin,
        isYou,
        withdrawn: p.withdrawn,
        currentPack: isYou ? p.currentPack : null,
        draftedCards: isYou ? p.draftedCards : null,
        deck: isYou && room.phase === "building" ? p.deck : null,
        currentPackSize: p.currentPack.length,
        draftedCardsCount: p.draftedCards.length,
      };
    });

    const viewerId =
      room.players.find((p) => p.socketId === forSocketId)?.id ??
      (room.adminSocketId === forSocketId ? room.adminId : null);

    return {
      roomId: room.id,
      config: room.config,
      phase: room.phase,
      players,
      currentRound: room.currentRound,
      currentPick: room.currentPick,
      direction: room.direction,
      pickDeadline: room.pickDeadline,
      events: room.events,
      matchPairings: room.matchPairings,
      tournament: room.tournament,
      bonusPickPool: room.phase === "bonus-pick" ? room.bonusPickPool : [],
      isAdminViewer: viewerId !== null && this.isRoomAdmin(room, viewerId),
      prizePool: room.prizePool,
      prizes: room.prizes,
    };
  }

  /** Rooms players can join (lobby phase). */
  getAvailableRooms(): DraftRoomInfo[] {
    return this.getAllRooms().filter((room) => room.phase === "lobby");
  }

  /** Every room, in any phase (backoffice). */
  getAllRooms(): DraftRoomInfo[] {
    return [...this.rooms.values()].map((room) => ({
      id: room.id,
      config: room.config,
      phase: room.phase,
      playerCount: room.players.length,
      maxPlayers: room.config.maxPlayers,
      adminName: room.adminName,
      adminId: room.adminId,
      entryFee: room.config.entryFee,
      adminPlays: room.config.adminPlays,
    }));
  }

  /** Whether `userId` is a player (not withdrawn) of a draft that isn't over, lobby included. */
  hasActivePlayer(userId: string): boolean {
    for (const room of this.rooms.values()) {
      if (room.phase === "finished") continue;
      if (room.players.some((p) => p.id === userId && !p.withdrawn)) return true;
    }
    return false;
  }

  /** The draft `userId` is playing (started, not over, not left), to find the way back to it. */
  getActiveRoomOf(userId: string): { roomId: string; phase: DraftPhase } | null {
    for (const room of this.rooms.values()) {
      if (room.phase === "lobby" || room.phase === "finished") continue;
      if (room.players.some((p) => p.id === userId && !p.withdrawn)) return { roomId: room.id, phase: room.phase };
    }
    return null;
  }

  getRoom(roomId: string): DraftRoom | undefined {
    return this.rooms.get(roomId);
  }

  getRoomBySocket(socketId: string): string | undefined {
    return this.socketToRoom.get(socketId);
  }

  setPendingMatchInfo(
    roomId: string,
    playerId: string,
    info: PendingMatchInfo,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) player.pendingMatchInfo = info;
  }

  getPendingMatchInfo(
    roomId: string,
    playerId: string,
  ): PendingMatchInfo | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const player = room.players.find((p) => p.id === playerId);
    return player?.pendingMatchInfo ?? null;
  }

  clearPendingMatchInfo(roomId: string, playerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) player.pendingMatchInfo = null;
  }

  handleDisconnect(socketId: string): DraftRoom | null {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    this.socketToRoom.delete(socketId);

    // Check if the disconnecting socket is the spectating admin (not in players)
    if (room.adminSocketId === socketId && !room.players.find((p) => p.socketId === socketId)) {
      room.adminSocketId = null;
      room.events.push(
        this.createEvent("system", `${room.adminName} (admin) se desconectó`),
      );
      // An empty lobby whose admin left (e.g. the backoffice tab that created it) waits for them
      if (room.phase === "lobby" && room.players.length === 0) this.scheduleEmptyLobbyExpiry(room);
      return room;
    }

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) return null;

    if (room.phase === "lobby") {
      this.leaveRoom(roomId, socketId);
      return this.rooms.has(roomId) ? room : null;
    }

    // During active draft: mark disconnected. They don't block the room: once only
    // disconnected players are missing, the grace period starts (evaluateProgress), and
    // their pick / bonus picks / deck are made for them if they don't come back.
    player.socketId = null;
    room.events.push(
      this.createEvent("system", `${player.name} se desconectó`),
    );

    this.evaluateProgress(room);
    return this.rooms.has(roomId) ? room : null;
  }

  // --------------------------------------------------------------------------
  // Internal: Draft Logic
  // --------------------------------------------------------------------------

  private advancePick(room: DraftRoom): void {
    if (room.pickTimer) {
      clearTimeout(room.pickTimer);
      room.pickTimer = null;
    }

    // Auto-pick for players who haven't picked (disconnected past the grace period)
    for (const player of room.players) {
      if (!player.isReady && player.currentPack.length > 0) {
        const randomIdx = Math.floor(
          Math.random() * player.currentPack.length,
        );
        const [card] = player.currentPack.splice(randomIdx, 1);
        player.draftedCards.push(card);
        player.isReady = true;
        room.events.push(
          this.createEvent(
            "system",
            `Auto-pick para ${player.name} (desconectado)`,
          ),
        );
      }
    }

    // Rotate packs to next player
    this.rotatePacks(room);

    // Reset ready status
    for (const p of room.players) p.isReady = false;

    room.currentPick++;

    // Check if round is complete (all packs emptied)
    if (room.players[0].currentPack.length === 0) {
      room.currentRound++;

      if (room.currentRound > room.config.packsPerPlayer) {
        // All rounds done → bonus-pick phase (with its own deadline)
        room.phase = "bonus-pick";
        room.bonusPickPool = bonusPoolFor(room.config.packSets).map(toGameCard);
        for (const p of room.players) p.isReady = false;
        room.events.push(
          this.createEvent(
            "system",
            "¡Draft completado! Elige 3 cartas bonus del catálogo.",
          ),
        );
        this.startPhaseTimer(room, this.timings.bonusPickSeconds);
        this.broadcast(room.id);
        this.evaluateProgress(room); // everyone may already be gone
        return;
      }

      // New round: flip direction, generate new packs
      room.currentPick = 1;
      room.direction =
        room.direction === "clockwise" ? "counterclockwise" : "clockwise";
      this.generatePacksForRound(room);
      const arrow = room.direction === "clockwise" ? "→" : "←";
      room.events.push(
        this.createEvent(
          "system",
          `¡Ronda ${room.currentRound}! Dirección: ${arrow} · Sobres de ${packSetLabel(room.config.packSets[room.currentRound - 1] ?? MIXED_PACK)}`,
        ),
      );
    }

    this.startPickTimer(room);
    this.broadcast(room.id);
    this.evaluateProgress(room);
  }

  /** Bonus-pick over (all picked, deadline, or grace): 3 random bonus cards for whoever didn't. */
  private finishBonusPick(room: DraftRoom): void {
    if (room.phase !== "bonus-pick") return;
    this.clearTimers(room);
    for (const player of room.players) {
      if (player.isReady) continue;
      const picks = shuffle(room.bonusPickPool).slice(0, BONUS_PICKS);
      for (const template of picks) player.draftedCards.push({ ...template, id: generateCardId() });
      player.isReady = true;
      room.events.push(this.createEvent("system", `Cartas bonus al azar para ${player.name}`));
    }
    room.phase = "building";
    for (const p of room.players) p.isReady = false;
    room.bonusPickPool = []; // Free memory
    room.events.push(this.createEvent("system", "Hora de construir tu mazo."));
    this.startPhaseTimer(room, this.timings.buildingSeconds);
    this.broadcast(room.id);
    this.evaluateProgress(room);
  }

  /**
   * Deck building over (all decks in, deadline, or grace): whoever has no deck gets an
   * automatic one from their drafted cards, or leaves the tournament when none can be built
   * (no card playable as a Basic Pokémon). With fewer than 2 players left the room closes
   * unplayed (entry fees refunded).
   */
  private finishBuilding(room: DraftRoom): void {
    if (room.phase !== "building") return;
    this.clearTimers(room);
    for (const player of [...room.players]) {
      if (player.isReady && player.deck) continue;
      const deck = buildAutoDeck(player.draftedCards, room.config.minDeckSize, (type) => this.createBasicEnergyCard(type));
      if (deck) {
        player.deck = deck;
        player.isReady = true;
        room.events.push(this.createEvent("system", `Mazo automático para ${player.name}`));
      } else {
        this.removePlayer(room.id, player.id);
        room.events.push(this.createEvent("system", `${player.name} no tiene un mazo jugable y queda fuera del torneo`));
        // Their entry fee comes back (out of the prize pool)
        const paid = room.entryPaidIds.indexOf(player.id);
        let refund = 0;
        if (paid !== -1) {
          room.entryPaidIds.splice(paid, 1);
          refund = room.config.entryFee;
          room.prizePool = Math.max(0, room.prizePool - refund);
        }
        this.hooks.onPlayerRemoved?.(room, player, {
          reason: "Quedaste fuera del draft: tus cartas no permiten armar un mazo con un Pokémon básico",
          refund,
        });
      }
    }
    if (room.players.length < 2) {
      this.closeRoom(room, "No quedan jugadores suficientes para el torneo");
      return;
    }
    this.startTournament(room);
  }

  /** Every deck is in: round-robin schedule, round 1, and the game rooms (onTournamentStart). */
  private startTournament(room: DraftRoom): void {
    this.clearTimers(room);
    room.pickDeadline = 0;
    room.tournament = this.generateRoundRobinSchedule(room);
    this.startTournamentRound(room, 1);
    room.phase = "matching";
    this.broadcast(room.id);
    this.hooks.onTournamentStart?.(room);
  }

  private rotatePacks(room: DraftRoom): void {
    const n = room.players.length;
    const isClockwise = room.direction === "clockwise";

    // Save all current packs before reassignment
    const packs = room.players.map((p) => p.currentPack);

    for (let i = 0; i < n; i++) {
      // Clockwise: player i receives from player (i-1)
      // Counter: player i receives from player (i+1)
      const from = isClockwise ? (i - 1 + n) % n : (i + 1) % n;
      room.players[i].currentPack = packs[from];
    }
  }

  private generatePacksForRound(room: DraftRoom): void {
    const packSet = room.config.packSets[room.currentRound - 1] ?? MIXED_PACK;
    for (const player of room.players) {
      player.currentPack = generatePack(room.config.cardsPerPack, packSet);
    }
  }

  private startPickTimer(room: DraftRoom): void {
    if (room.pickTimer) clearTimeout(room.pickTimer);
    room.pickDeadline =
      Date.now() + room.config.pickTimeSeconds * 1000;

    room.pickTimer = setTimeout(() => {
      this.handlePickTimeout(room);
    }, room.config.pickTimeSeconds * 1000);
  }

  /** Deadline of the bonus-pick / building phase (pickDeadline: the clients' countdown). */
  private startPhaseTimer(room: DraftRoom, seconds: number): void {
    if (room.pickTimer) clearTimeout(room.pickTimer);
    room.pickDeadline = Date.now() + seconds * 1000;
    room.pickTimer = setTimeout(() => {
      room.pickTimer = null;
      if (!this.rooms.has(room.id)) return;
      this.advancePhase(room);
    }, seconds * 1000);
  }

  private handlePickTimeout(room: DraftRoom): void {
    if (!this.rooms.has(room.id) || room.phase !== "drafting") return;
    for (const player of room.players) {
      if (!player.isReady && player.currentPack.length > 0) {
        const randomIdx = Math.floor(
          Math.random() * player.currentPack.length,
        );
        const [card] = player.currentPack.splice(randomIdx, 1);
        player.draftedCards.push(card);
        player.isReady = true;
        room.events.push(
          this.createEvent(
            "system",
            `Auto-pick para ${player.name} (tiempo agotado)`,
          ),
        );
      }
    }

    this.advancePhase(room);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private generateRoomId(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id = "";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return this.rooms.has(id) ? this.generateRoomId() : id;
  }

  private createEvent(
    type: DraftEvent["type"],
    message: string,
  ): DraftEvent {
    return {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      message,
      type,
    };
  }

  private createBasicEnergyCard(energyType: string): GameCard {
    const template = ALL_CARDS.find(
      (c) => isEnergyCard(c) && c.isBasic && c.energyType === energyType,
    );
    if (!template) throw new Error(`Energía no encontrada: ${energyType}`);
    return { ...template, id: generateCardId() };
  }

  // --------------------------------------------------------------------------
  // Tournament: Round-Robin
  // --------------------------------------------------------------------------

  /**
   * Generate a full round-robin schedule using the circle (polygon) method.
   * For N players: N-1 rounds (or N rounds if odd, with a bye each round).
   * Fix player[0], rotate the rest to generate unique pairings each round.
   */
  private generateRoundRobinSchedule(room: DraftRoom): Tournament {
    const playerIds = room.players.map((p) => ({
      id: p.id,
      name: p.name,
    }));

    // For odd player count, add a virtual BYE player
    const hasOddPlayers = playerIds.length % 2 !== 0;
    const slots = hasOddPlayers
      ? [...playerIds, { id: "__BYE__", name: "BYE" }]
      : [...playerIds];

    const n = slots.length;
    const totalRounds = n - 1;
    const rounds: TournamentRound[] = [];
    let globalMatchNumber = 1;

    // Circle method: fix slots[0], rotate slots[1..n-1]
    const rotating = slots.slice(1);

    for (let r = 0; r < totalRounds; r++) {
      const current = [slots[0], ...rotating];
      const pairings: MatchPairing[] = [];
      let byePlayerId: string | null = null;

      for (let i = 0; i < n / 2; i++) {
        const p1 = current[i];
        const p2 = current[n - 1 - i];

        if (p1.id === "__BYE__") {
          byePlayerId = p2.id;
          continue;
        }
        if (p2.id === "__BYE__") {
          byePlayerId = p1.id;
          continue;
        }

        pairings.push({
          matchNumber: globalMatchNumber++,
          player1: { id: p1.id, name: p1.name },
          player2: { id: p2.id, name: p2.name },
        });
      }

      rounds.push({
        roundNumber: r + 1,
        pairings,
        byePlayerId,
        status: "pending",
        results: [],
      });

      // Rotate: move last element to front of rotating array
      rotating.unshift(rotating.pop()!);
    }

    // Initialize standings
    const standings: PlayerStanding[] = room.players.map((p) => ({
      playerId: p.id,
      playerName: p.name,
      wins: 0,
      losses: 0,
      byes: 0,
      withdrawn: false,
    }));

    return {
      rounds,
      standings,
      currentRoundNumber: 0, // will be set by startTournamentRound
      totalRounds,
    };
  }

  /**
   * Start a tournament round: its pairings become the current ones, the bye player rests (a bye
   * is not a win: with an odd number of players everyone gets one), and every pairing with a
   * player who left the tournament is decided at once. Doesn't move on when that decides the
   * whole round (advanceTournament does).
   */
  private startTournamentRound(room: DraftRoom, roundNumber: number): void {
    if (!room.tournament) return;

    const round = room.tournament.rounds.find(
      (r) => r.roundNumber === roundNumber,
    );
    if (!round) return;

    round.status = "in_progress";
    room.tournament.currentRoundNumber = roundNumber;

    // Set current matchPairings for backward compat with bracket display
    room.matchPairings = round.pairings;

    if (round.byePlayerId) {
      const standing = room.tournament.standings.find(
        (s) => s.playerId === round.byePlayerId,
      );
      if (standing) standing.byes++;

      round.results.push({
        matchNumber: 0,
        roundNumber,
        player1Id: round.byePlayerId,
        player2Id: "__BYE__",
        winnerId: null,
        loserId: null,
        isBye: true,
        walkover: false,
        gameRoomId: null,
      });
    }

    const pairingText = round.pairings
      .map(
        (p) =>
          `Partida ${p.matchNumber}: ${p.player1.name} vs ${p.player2.name}`,
      )
      .join(" | ");
    const byeName = room.players.find((p) => p.id === round.byePlayerId)?.name;

    room.events.push(
      this.createEvent(
        "system",
        `¡Ronda ${roundNumber} de ${room.tournament.totalRounds}! ${pairingText}${byeName ? ` · Descansa: ${byeName}` : ""}`,
      ),
    );

    for (const pairing of round.pairings) this.decideWalkover(room, round, pairing);
  }

  /**
   * Register a game room → draft mapping so we can report results back.
   */
  registerGameRoom(
    gameRoomId: string,
    draftRoomId: string,
    roundNumber: number,
    matchNumber: number,
    player1Id: string,
    player2Id: string,
  ): void {
    this.gameRoomToDraft.set(gameRoomId, {
      draftRoomId,
      roundNumber,
      matchNumber,
      player1Id,
      player2Id,
    });
  }

  /**
   * Look up draft info for a game room (used when a game ends).
   */
  getDraftInfoForGameRoom(gameRoomId: string): GameRoomDraftInfo | undefined {
    return this.gameRoomToDraft.get(gameRoomId);
  }

  /** The game room of a draft match still being played, if any. */
  private gameRoomIdFor(draftRoomId: string, roundNumber: number, matchNumber: number): string | null {
    for (const [gameRoomId, info] of this.gameRoomToDraft) {
      if (info.draftRoomId === draftRoomId && info.roundNumber === roundNumber && info.matchNumber === matchNumber) {
        return gameRoomId;
      }
    }
    return null;
  }

  /** Whether this match of the round already has a result. */
  isMatchDecided(draftRoomId: string, roundNumber: number, matchNumber: number): boolean {
    const round = this.rooms.get(draftRoomId)?.tournament?.rounds.find((r) => r.roundNumber === roundNumber);
    return !!round?.results.some((r) => !r.isBye && r.matchNumber === matchNumber);
  }

  /**
   * Report a match result. Called when a game room finishes (winnerId null: no winner, both
   * players lose it). A match already decided (e.g. a player left the tournament meanwhile)
   * is ignored. `newRoundStarted`: the caller creates the next round's game rooms.
   */
  reportMatchResult(
    draftRoomId: string,
    roundNumber: number,
    matchNumber: number,
    winnerId: string | null,
    loserId: string | null,
    gameRoomId: string,
  ): TournamentProgress {
    const room = this.rooms.get(draftRoomId);
    const round = room?.tournament?.rounds.find((r) => r.roundNumber === roundNumber);
    const pairing = round?.pairings.find((p) => p.matchNumber === matchNumber);
    if (!room || !round || !pairing || room.phase !== "matching" || this.isMatchDecided(draftRoomId, roundNumber, matchNumber)) {
      this.gameRoomToDraft.delete(gameRoomId);
      return { newRoundStarted: false, tournamentFinished: false };
    }

    this.recordResult(room, round, pairing, winnerId, false, gameRoomId);

    const nameOf = (id: string | null) => room.players.find((p) => p.id === id)?.name ?? "?";
    room.events.push(
      this.createEvent(
        "info",
        winnerId
          ? `${nameOf(winnerId)} venció a ${nameOf(loserId)} (Ronda ${roundNumber})`
          : `La Partida ${matchNumber} terminó sin ganador (Ronda ${roundNumber})`,
      ),
    );

    return this.advanceTournament(room);
  }

  /** Throws a Spanish reason unless `userId` can leave this draft's tournament now. */
  assertCanWithdraw(roomId: string, userId: string): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    if (room.phase !== "matching" || !room.tournament) {
      throw new Error("Solo puedes abandonar el draft durante el torneo");
    }
    const player = room.players.find((p) => p.id === userId);
    if (!player) throw new Error("No juegas este draft");
    if (player.withdrawn) throw new Error("Ya abandonaste este draft");
    return room;
  }

  /**
   * `userId` leaves the tournament: each of their matches not played yet is won by the rival
   * (also the one of this round, whose game room the caller closes: `gameRoomIds`), they end
   * last with no prize, and `penalty` (already charged) goes to the prize pool.
   */
  withdrawPlayer(roomId: string, userId: string, penalty: number): TournamentProgress & { gameRoomIds: string[] } {
    const room = this.assertCanWithdraw(roomId, userId);
    const tournament = room.tournament!;
    const player = room.players.find((p) => p.id === userId)!;

    player.withdrawn = true;
    player.pendingMatchInfo = null;
    const standing = tournament.standings.find((s) => s.playerId === userId);
    if (standing) standing.withdrawn = true;
    room.prizePool += penalty;
    room.events.push(this.createEvent("system", `${player.name} abandonó el draft`));

    const round = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
    const gameRoomIds: string[] = [];
    for (const pairing of round?.pairings ?? []) {
      const gameRoomId = this.gameRoomIdFor(room.id, round!.roundNumber, pairing.matchNumber);
      if (this.decideWalkover(room, round!, pairing) && gameRoomId) gameRoomIds.push(gameRoomId);
    }
    this.sortStandings(tournament);

    return { ...this.advanceTournament(room), gameRoomIds };
  }

  /** A pairing with a player who left is won by the other one (lost by both if both left). */
  private decideWalkover(room: DraftRoom, round: TournamentRound, pairing: MatchPairing): boolean {
    if (round.results.some((r) => !r.isBye && r.matchNumber === pairing.matchNumber)) return false;
    const isWithdrawn = (id: string) => room.players.find((p) => p.id === id)?.withdrawn ?? true;
    const p1Left = isWithdrawn(pairing.player1.id);
    const p2Left = isWithdrawn(pairing.player2.id);
    if (!p1Left && !p2Left) return false;

    const winner = p1Left && p2Left ? null : p1Left ? pairing.player2 : pairing.player1;
    const gameRoomId = this.gameRoomIdFor(room.id, round.roundNumber, pairing.matchNumber);
    this.recordResult(room, round, pairing, winner?.id ?? null, true, gameRoomId);
    room.events.push(
      this.createEvent(
        "info",
        winner
          ? `${winner.name} gana la Partida ${pairing.matchNumber}: su rival abandonó el draft`
          : `Partida ${pairing.matchNumber} sin jugar: ambos abandonaron el draft`,
      ),
    );
    return true;
  }

  /** Store a match result and update the standings (no winner: both players lose it). */
  private recordResult(
    room: DraftRoom,
    round: TournamentRound,
    pairing: MatchPairing,
    winnerId: string | null,
    walkover: boolean,
    gameRoomId: string | null,
  ): void {
    const tournament = room.tournament!;
    const loserIds = [pairing.player1.id, pairing.player2.id].filter((id) => id !== winnerId);
    round.results.push({
      matchNumber: pairing.matchNumber,
      roundNumber: round.roundNumber,
      player1Id: pairing.player1.id,
      player2Id: pairing.player2.id,
      winnerId,
      loserId: winnerId ? loserIds[0] : null,
      isBye: false,
      walkover,
      gameRoomId,
    });

    for (const standing of tournament.standings) {
      if (standing.playerId === winnerId) standing.wins++;
      else if (loserIds.includes(standing.playerId)) standing.losses++;
    }
    this.sortStandings(tournament);

    for (const id of [pairing.player1.id, pairing.player2.id]) {
      const player = room.players.find((p) => p.id === id);
      if (player?.pendingMatchInfo?.matchNumber === pairing.matchNumber) player.pendingMatchInfo = null;
    }
    if (gameRoomId) this.gameRoomToDraft.delete(gameRoomId);
  }

  /**
   * Move on while the current round has every match decided: next round (whose walkovers may
   * decide it too) or the end of the tournament. Broadcasts the state.
   */
  private advanceTournament(room: DraftRoom): TournamentProgress {
    const tournament = room.tournament!;
    let newRoundStarted = false;
    for (;;) {
      const round = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
      if (!round || round.results.filter((r) => !r.isBye).length < round.pairings.length) break;

      round.status = "completed";
      if (round.roundNumber >= tournament.totalRounds) {
        this.finishTournament(room);
        return { newRoundStarted: false, tournamentFinished: true };
      }
      this.startTournamentRound(room, round.roundNumber + 1);
      newRoundStarted = true;
    }
    this.broadcast(room.id);
    return { newRoundStarted, tournamentFinished: false };
  }

  /** Final standings and prizes (paid by onFinished); the room stays FINISHED_ROOM_TTL_MS. */
  private finishTournament(room: DraftRoom): void {
    const tournament = room.tournament!;
    this.sortStandings(tournament);
    room.phase = "finished";
    room.prizes = computeDraftPrizes(tournament.standings, room.prizePool);
    const champion = tournament.standings[0];
    room.events.push(
      this.createEvent("system", champion ? `¡Torneo finalizado! Campeón: ${champion.playerName}` : "¡Torneo finalizado!"),
    );
    room.expiryTimer = setTimeout(() => {
      room.expiryTimer = null;
      this.closeRoom(room, "El draft terminó");
    }, FINISHED_ROOM_TTL_MS);
    room.expiryTimer.unref?.();
    this.broadcast(room.id);
    this.hooks.onFinished?.(room);
  }

  /**
   * Sort standings: players who left last; then more wins; between exactly two tied players the
   * game they played; then fewer losses, then name (a three-way tie can be a cycle, A > B > C > A,
   * where head-to-head would make the order depend on the input).
   */
  private sortStandings(tournament: Tournament): void {
    const allResults = tournament.rounds.flatMap((r) => r.results);
    const tiedCount = (s: PlayerStanding) =>
      tournament.standings.filter((o) => o.withdrawn === s.withdrawn && o.wins === s.wins).length;

    tournament.standings.sort((a, b) => {
      if (a.withdrawn !== b.withdrawn) return a.withdrawn ? 1 : -1;

      // Primary: more wins is better
      if (b.wins !== a.wins) return b.wins - a.wins;

      // Tiebreaker: head-to-head (a game actually played), only between two tied players
      const h2h = tiedCount(a) === 2 && allResults.find(
        (r) =>
          !r.isBye &&
          !r.walkover &&
          ((r.player1Id === a.playerId && r.player2Id === b.playerId) ||
            (r.player1Id === b.playerId && r.player2Id === a.playerId)),
      );
      if (h2h && h2h.winnerId === a.playerId) return -1;
      if (h2h && h2h.winnerId === b.playerId) return 1;

      // Further: fewer losses
      if (a.losses !== b.losses) return a.losses - b.losses;
      return a.playerName.localeCompare(b.playerName);
    });
  }
}

export type TournamentProgress = { newRoundStarted: boolean; tournamentFinished: boolean };

/** A finished draft room stays this long (final standings and prizes), then it is removed. */
const FINISHED_ROOM_TTL_MS = 30 * 60_000;
/** A lobby with nobody in it (no player, no admin connected) is closed after this long. */
const EMPTY_LOBBY_TTL_MS = 10 * 60_000;
/** Most cards a draft deck can have (a deck that can't run out of cards would never lose). */
export const MAX_DRAFT_DECK_SIZE = 60;

/**
 * Coins for each final position (standings already sorted): the prize pool split by
 * ECONOMY.draft.prizeSplit for this many players. Players who left get nothing; the shares of
 * paid positions without a player are spread over the others; rounding goes to the champion.
 */
export function computeDraftPrizes(
  standings: readonly PlayerStanding[],
  pool: number,
  splits: readonly { minPlayers: number; percents: readonly number[] }[] = ECONOMY.draft.prizeSplit,
): DraftPrize[] {
  const percents = splits.find((s) => standings.length >= s.minPlayers)?.percents ?? [];
  const shares = percents.slice(0, standings.filter((s) => !s.withdrawn).length);
  const totalShare = shares.reduce((sum, share) => sum + share, 0);
  const coins = shares.map((share) => (pool > 0 && totalShare > 0 ? Math.floor((pool * share) / totalShare) : 0));
  if (coins.length > 0) coins[0] += Math.max(0, pool) - coins.reduce((sum, c) => sum + c, 0);

  let paid = 0;
  return standings.map((standing, index) => ({
    playerId: standing.playerId,
    playerName: standing.playerName,
    position: index + 1,
    coins: standing.withdrawn ? 0 : (coins[paid++] ?? 0),
    withdrawn: standing.withdrawn,
  }));
}
