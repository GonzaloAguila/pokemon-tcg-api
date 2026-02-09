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
  baseSetCards,
  jungleCards,
  isBasicEnergy,
  isEnergyCard,
} from "@gonzaloaguila/game-core";
import type { Card, GameCard } from "@gonzaloaguila/game-core";

// ============================================================================
// Types
// ============================================================================

export type DraftConfig = {
  maxPlayers: number; // 2-8
  packsPerPlayer: number; // default 3
  cardsPerPack: number; // default 11
  pickTimeSeconds: number; // default 45
  keepInCollection: boolean;
  minDeckSize: number; // default 40
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
};

/** Masked player visible to other players (hides pack & specific cards) */
export type ClientDraftPlayer = {
  id: string;
  name: string;
  seatIndex: number;
  isReady: boolean;
  isAdmin: boolean;
  isYou: boolean;
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
  gameRoomId: string | null;
};

export type PlayerStanding = {
  playerId: string;
  playerName: string;
  wins: number;
  losses: number;
  byes: number;
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
};

/** Room info for the lobby list */
export type DraftRoomInfo = {
  id: string;
  config: DraftConfig;
  phase: DraftPhase;
  playerCount: number;
  maxPlayers: number;
  adminName: string;
};

export type BroadcastFn = (roomId: string) => void;

// ============================================================================
// Pack Generation
// ============================================================================

const draftPool = [...baseSetCards, ...jungleCards].filter((card) => !isBasicEnergy(card));

const poolByRarity = {
  common: draftPool.filter((c) => c.rarity === "common"),
  uncommon: draftPool.filter((c) => c.rarity === "uncommon"),
  rare: draftPool.filter((c) => c.rarity === "rare"),
  rareHolo: draftPool.filter((c) => c.rarity === "rare-holo"),
};

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

function generatePack(cardsPerPack: number): GameCard[] {
  const usedIds = new Set<string>();

  const rareSlotCount = cardsPerPack >= 10 ? 2 : 1;
  const remaining = cardsPerPack - rareSlotCount;
  const uncommonCount = Math.max(1, Math.round(remaining * 0.3));
  const commonCount = remaining - uncommonCount;

  // Guaranteed non-holo rare
  const rares = pickUnique(poolByRarity.rare, 1, usedIds);

  // Second rare slot: 33% chance holo
  if (rareSlotCount >= 2) {
    const isHolo = Math.random() < 0.33;
    const pool = isHolo ? poolByRarity.rareHolo : poolByRarity.rare;
    rares.push(...pickUnique(pool, 1, usedIds));
  }

  const uncommons = pickUnique(poolByRarity.uncommon, uncommonCount, usedIds);
  const commons = pickUnique(poolByRarity.common, commonCount, usedIds);

  return shuffle([...commons, ...uncommons, ...rares]).map(toGameCard);
}

// ============================================================================
// DraftRoomManager
// ============================================================================

export class DraftRoomManager {
  private rooms = new Map<string, DraftRoom>();
  private socketToRoom = new Map<string, string>();
  private gameRoomToDraft = new Map<string, GameRoomDraftInfo>();
  private broadcastFn: BroadcastFn | null = null;

  setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn;
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
    const fullConfig: DraftConfig = {
      maxPlayers: config.maxPlayers ?? 8,
      packsPerPlayer: config.packsPerPlayer ?? 3,
      cardsPerPack: config.cardsPerPack ?? 11,
      pickTimeSeconds: config.pickTimeSeconds ?? 45,
      keepInCollection: config.keepInCollection ?? false,
      minDeckSize: config.minDeckSize ?? 40,
    };

    const room: DraftRoom = {
      id: roomId,
      config: fullConfig,
      phase: "lobby",
      players: [
        {
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
        },
      ],
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

    // Reconnection: existing player updates their socket (allowed in any phase)
    const existing = room.players.find((p) => p.id === userId);
    if (existing) {
      existing.socketId = socketId;
      this.socketToRoom.set(socketId, roomId);
      return room;
    }

    // New players can only join during lobby phase
    if (room.phase !== "lobby") throw new Error("El draft ya comenzó");
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
      return room;
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

    // Promote new admin or close empty room
    if (player.isAdmin && room.players.length > 0) {
      room.players[0].isAdmin = true;
      room.events.push(
        this.createEvent(
          "system",
          `${room.players[0].name} es el nuevo admin`,
        ),
      );
    } else if (room.players.length === 0) {
      this.rooms.delete(roomId);
      return null;
    }

    return room;
  }

  deleteRoom(roomId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const admin = room.players.find((p) => p.socketId === socketId);
    if (!admin?.isAdmin) return false;

    if (room.pickTimer) clearTimeout(room.pickTimer);
    for (const p of room.players) {
      if (p.socketId) this.socketToRoom.delete(p.socketId);
    }
    this.rooms.delete(roomId);
    return true;
  }

  // --------------------------------------------------------------------------
  // Draft Flow
  // --------------------------------------------------------------------------

  startDraft(roomId: string, socketId: string): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");

    const admin = room.players.find((p) => p.socketId === socketId);
    if (!admin?.isAdmin)
      throw new Error("Solo el admin puede iniciar el draft");
    if (room.players.length < 2)
      throw new Error("Se necesitan al menos 2 jugadores");
    if (room.phase !== "lobby") throw new Error("El draft ya comenzó");

    room.phase = "drafting";
    room.currentRound = 1;
    room.currentPick = 1;
    room.direction = "clockwise";

    // Defensive: ensure clean state before starting
    for (const p of room.players) {
      p.draftedCards = [];
      p.isReady = false;
    }

    this.generatePacksForRound(room);
    room.events.push(
      this.createEvent("system", "¡Comienza la Ronda 1! Dirección: →"),
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

    // Advance when all connected players have picked
    if (this.allPlayersPicked(room)) {
      this.advancePick(room);
    }

    return room;
  }

  bonusPick(roomId: string, socketId: string, cardDefIds: string[]): DraftRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Sala no encontrada");
    if (room.phase !== "bonus-pick") throw new Error("No es fase de bonus pick");

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) throw new Error("Jugador no encontrado");
    if (player.isReady) throw new Error("Ya elegiste tus cartas bonus");
    if (cardDefIds.length !== 3) throw new Error("Debes elegir exactamente 3 cartas");

    // Find cards from the bonus pool by their draft ID
    for (const defId of cardDefIds) {
      const template = room.bonusPickPool.find((c) => c.id === defId);
      if (!template) throw new Error(`Carta ${defId} no encontrada en el pool`);
      // Create a new GameCard instance with unique draft ID
      player.draftedCards.push({ ...template, id: generateCardId() });
    }

    player.isReady = true;
    room.events.push(this.createEvent("pick", `${player.name} eligió sus 3 cartas bonus`));

    // When all players have picked, transition to building
    if (room.players.every((p) => p.isReady || p.socketId === null)) {
      room.phase = "building";
      for (const p of room.players) p.isReady = false;
      room.bonusPickPool = []; // Free memory
      room.events.push(this.createEvent("system", "Hora de construir tu mazo."));
    }

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

    // Validate drafted card IDs
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

    player.deck = deckCards;
    player.isReady = true;
    room.events.push(
      this.createEvent("info", `${player.name} terminó su mazo`),
    );

    // All decks submitted → generate round-robin schedule and start tournament
    if (room.players.every((p) => p.isReady)) {
      room.tournament = this.generateRoundRobinSchedule(room);
      this.startTournamentRound(room, 1);
      room.phase = "matching";
    }

    return room;
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
        currentPack: isYou ? p.currentPack : null,
        draftedCards: isYou ? p.draftedCards : null,
        deck: isYou && room.phase === "building" ? p.deck : null,
        currentPackSize: p.currentPack.length,
        draftedCardsCount: p.draftedCards.length,
      };
    });

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
    };
  }

  getAvailableRooms(): DraftRoomInfo[] {
    const list: DraftRoomInfo[] = [];
    for (const room of this.rooms.values()) {
      if (room.phase === "lobby") {
        const admin = room.players.find((p) => p.isAdmin);
        list.push({
          id: room.id,
          config: room.config,
          phase: room.phase,
          playerCount: room.players.length,
          maxPlayers: room.config.maxPlayers,
          adminName: admin?.name ?? "Admin",
        });
      }
    }
    return list;
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

    const player = room.players.find((p) => p.socketId === socketId);
    if (!player) return null;

    this.socketToRoom.delete(socketId);

    if (room.phase === "lobby") {
      this.leaveRoom(roomId, socketId);
      return room.players.length > 0 ? room : null;
    }

    // During active draft: mark disconnected, auto-pick will handle them
    player.socketId = null;
    room.events.push(
      this.createEvent("system", `${player.name} se desconectó`),
    );

    // If all players were waiting on this player, advance
    if (room.phase === "drafting" && this.allPlayersPicked(room)) {
      this.advancePick(room);
    }

    return room;
  }

  // --------------------------------------------------------------------------
  // Internal: Draft Logic
  // --------------------------------------------------------------------------

  private allPlayersPicked(room: DraftRoom): boolean {
    return room.players.every((p) => p.isReady || p.socketId === null);
  }

  private advancePick(room: DraftRoom): void {
    if (room.pickTimer) {
      clearTimeout(room.pickTimer);
      room.pickTimer = null;
    }

    // Auto-pick for disconnected players who haven't picked
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
        // All rounds done → bonus-pick phase
        room.phase = "bonus-pick";
        room.bonusPickPool = [...baseSetCards, ...jungleCards]
          .filter((card) => !isBasicEnergy(card))
          .map(toGameCard);
        for (const p of room.players) p.isReady = false;
        room.events.push(
          this.createEvent(
            "system",
            "¡Draft completado! Elige 3 cartas bonus del catálogo.",
          ),
        );
        this.broadcast(room.id);
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
          `¡Ronda ${room.currentRound}! Dirección: ${arrow}`,
        ),
      );
    }

    this.startPickTimer(room);
    this.broadcast(room.id);
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
    for (const player of room.players) {
      player.currentPack = generatePack(room.config.cardsPerPack);
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

  private handlePickTimeout(room: DraftRoom): void {
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

    this.advancePick(room);
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
    const template = baseSetCards.find(
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
    }));

    return {
      rounds,
      standings,
      currentRoundNumber: 0, // will be set by startTournamentRound
      totalRounds,
    };
  }

  /**
   * Start a specific tournament round: set its status, handle bye, update matchPairings.
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

    // Handle bye: auto-win for the bye player
    if (round.byePlayerId) {
      const byePlayer = room.players.find(
        (p) => p.id === round.byePlayerId,
      );
      const standing = room.tournament.standings.find(
        (s) => s.playerId === round.byePlayerId,
      );

      if (standing) {
        standing.byes++;
        standing.wins++;
      }

      round.results.push({
        matchNumber: 0,
        roundNumber,
        player1Id: round.byePlayerId,
        player2Id: "__BYE__",
        winnerId: round.byePlayerId,
        loserId: null,
        isBye: true,
        gameRoomId: null,
      });

      if (byePlayer) {
        room.events.push(
          this.createEvent(
            "system",
            `${byePlayer.name} tiene bye en la Ronda ${roundNumber} (victoria automática)`,
          ),
        );
      }
    }

    const pairingText = round.pairings
      .map(
        (p) =>
          `Partida ${p.matchNumber}: ${p.player1.name} vs ${p.player2.name}`,
      )
      .join(" | ");

    room.events.push(
      this.createEvent(
        "system",
        `¡Ronda ${roundNumber} de ${room.tournament.totalRounds}! ${pairingText}`,
      ),
    );
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

  /**
   * Report a match result. Called when a game room finishes.
   * Returns true if a new round was started (caller should create game rooms).
   */
  reportMatchResult(
    draftRoomId: string,
    roundNumber: number,
    matchNumber: number,
    winnerId: string,
    loserId: string,
    gameRoomId: string,
  ): { newRoundStarted: boolean; tournamentFinished: boolean } {
    const room = this.rooms.get(draftRoomId);
    if (!room || !room.tournament) {
      return { newRoundStarted: false, tournamentFinished: false };
    }

    const round = room.tournament.rounds.find(
      (r) => r.roundNumber === roundNumber,
    );
    if (!round) {
      return { newRoundStarted: false, tournamentFinished: false };
    }

    // Find the pairing
    const pairing = round.pairings.find(
      (p) => p.matchNumber === matchNumber,
    );
    if (!pairing) {
      return { newRoundStarted: false, tournamentFinished: false };
    }

    // Record the result
    round.results.push({
      matchNumber,
      roundNumber,
      player1Id: pairing.player1.id,
      player2Id: pairing.player2.id,
      winnerId,
      loserId,
      isBye: false,
      gameRoomId,
    });

    // Update standings
    const winnerStanding = room.tournament.standings.find(
      (s) => s.playerId === winnerId,
    );
    const loserStanding = room.tournament.standings.find(
      (s) => s.playerId === loserId,
    );
    if (winnerStanding) winnerStanding.wins++;
    if (loserStanding) loserStanding.losses++;

    const winnerName =
      room.players.find((p) => p.id === winnerId)?.name ?? "?";
    const loserName =
      room.players.find((p) => p.id === loserId)?.name ?? "?";
    room.events.push(
      this.createEvent(
        "info",
        `${winnerName} venció a ${loserName} (Ronda ${roundNumber})`,
      ),
    );

    // Clean up game room mapping
    this.gameRoomToDraft.delete(gameRoomId);

    // Check if round is complete (all non-bye matches have results)
    const expectedMatches = round.pairings.length;
    const completedMatches = round.results.filter((r) => !r.isBye).length;

    if (completedMatches >= expectedMatches) {
      round.status = "completed";

      // Sort standings
      this.sortStandings(room.tournament);

      // Check if tournament is over
      if (roundNumber >= room.tournament.totalRounds) {
        room.phase = "finished";
        room.events.push(
          this.createEvent("system", "¡Torneo finalizado!"),
        );
        this.broadcast(room.id);
        return { newRoundStarted: false, tournamentFinished: true };
      }

      // Start next round
      this.startTournamentRound(room, roundNumber + 1);
      this.broadcast(room.id);
      return { newRoundStarted: true, tournamentFinished: false };
    }

    // Not all matches done yet, just broadcast updated state
    this.broadcast(room.id);
    return { newRoundStarted: false, tournamentFinished: false };
  }

  /**
   * Sort standings: primary by wins desc, tiebreaker by head-to-head, then fewer losses.
   */
  private sortStandings(tournament: Tournament): void {
    const allResults = tournament.rounds.flatMap((r) => r.results);

    tournament.standings.sort((a, b) => {
      // Primary: more wins is better
      if (b.wins !== a.wins) return b.wins - a.wins;

      // Tiebreaker: head-to-head
      const h2h = allResults.find(
        (r) =>
          !r.isBye &&
          ((r.player1Id === a.playerId && r.player2Id === b.playerId) ||
            (r.player1Id === b.playerId && r.player2Id === a.playerId)),
      );
      if (h2h && h2h.winnerId === a.playerId) return -1;
      if (h2h && h2h.winnerId === b.playerId) return 1;

      // Further: fewer losses
      return a.losses - b.losses;
    });
  }
}
