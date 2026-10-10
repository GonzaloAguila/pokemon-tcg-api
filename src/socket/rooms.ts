/**
 * Game Room Manager
 *
 * Manages in-memory game rooms for real-time multiplayer.
 * TODO: Persist to database for reconnection support.
 */

import { randomInt } from "crypto";
import {
  resolveConfusionFlip,
  type GameState,
  type GameCard,
  type Attack,
  type CoinFlipRequirement,
  GamePhase,
  IllegalActionError,
  initializeMultiplayerGame,
  startGame,
  shuffle,
  // Attacks and turn flow
  executeAttack,
  executeMetronome,
  canExecuteAttack,
  canExecuteMetronome,
  getAttackCoinFlipCount,
  endTurn,
  executeRetreat,
  doMulligan,
  setPlayerReady,
  startPlayingPhase,
  promoteActivePokemon,
  takePrize,
  getDeckById,
  decks,
  isPokemonCard,
  createGameEvent,
  AttackEffectType,
  // Perspective + board actions (engine-owned, throw IllegalActionError when illegal)
  swapSides,
  findInPlay,
  playBasicPokemon,
  attachEnergyCard,
  evolvePokemonCard,
  // Pending state handlers
  executeDeckSearch,
  executeBenchDamage,
  applyForceSwitch,
  applySelfSwitch,
  skipPendingSwitch,
  clearPendingPeek,
  // Effect registry: every Trainer and activated Pokémon Power
  canPlayTrainerCard,
  getTrainerCoinFlips,
  playTrainerCard,
  canUsePokemonPower,
  getPowerCoinFlips,
  usePokemonPower,
} from "@gonzaloaguila/game-core";
import { parseGameAction } from "./schemas.js";

interface RoomConfig {
  prizeCount: number;           // 4, 5, or 6
  betAmount: number;            // 0 = no bet
  reservedUserId: string | null; // null = open to all
  friendly: boolean;            // true = no stats recorded
}

interface CreatorInfo {
  username: string | null;
  avatarId: string | null;
  titleId: string | null;
}

interface GameRoom {
  id: string;
  status: "waiting" | "ready" | "playing" | "finished";

  // Players
  player1Id: string | null;
  player1SocketId: string | null;
  player1Ready: boolean;
  player1DeckId: string | null;

  player2Id: string | null;
  player2SocketId: string | null;
  player2Ready: boolean;
  player2DeckId: string | null;

  // Game state
  gameState: GameState | null;

  // Turn timer (server-side)
  turnStartedAt: number | null;       // Date.now() when current turn started
  turnTimerDuration: number;          // seconds, default 180

  // Spectators
  spectators: Set<string>;            // socket IDs watching the game

  // Room config
  config: RoomConfig;
  creator: CreatorInfo;
  joiner: CreatorInfo;

  // Metadata
  players: string[];
  createdAt: Date;

  // Coins rolled for a Trainer / power before it resolved (requestCoinFlip, or a failed
  // attempt), by effectCoinKey. The action uses these, never coins sent by the client.
  effectCoins?: Record<string, { results: Coin[]; turnNumber: number | null }>;
}

type PlayerKey = "player1" | "player2";
type Coin = "heads" | "tails";
interface CoinFlipInfo {
  attackName: string;
  results: Coin[];
}

/** What a client asks coins for before choosing (requestCoinFlip). */
export type CoinFlipRequest = { purpose: "trainer"; cardId: string } | { purpose: "power"; pokemonId: string };

/** A coin flip rolled by the server (CSPRNG). Every multiplayer coin comes from here. */
export type CoinSource = () => "heads" | "tails";

function serverCoin(): "heads" | "tails" {
  return randomInt(2) === 0 ? "heads" : "tails";
}

/** Cap for "flip until tails" (odds 2^-63 of reaching it); the last coin is then tails. */
const MAX_UNTIL_TAILS = 64;

/** Exactly the coins an engine requirement asks for. */
function rollCoins(requirement: CoinFlipRequirement, flip: CoinSource): Coin[] {
  if (requirement === "untilTails") {
    const coins: Coin[] = [];
    while (coins.length < MAX_UNTIL_TAILS - 1) {
      const coin = flip();
      coins.push(coin);
      if (coin === "tails") return coins;
    }
    coins.push("tails");
    return coins;
  }
  return Array.from({ length: requirement }, () => flip());
}

function coinsSatisfy(requirement: CoinFlipRequirement, coins: Coin[]): boolean {
  if (requirement === "untilTails") return coins.length > 0 && coins.indexOf("tails") === coins.length - 1;
  return coins.length === requirement;
}

/** Trainer coins stay with the card instance; power coins with the Pokémon for one turn. */
function effectCoinKey(player: PlayerKey, kind: "trainer" | "power", sourceId: string, turnNumber?: number): string {
  return kind === "trainer" ? `${player}:trainer:${sourceId}` : `${player}:power:${sourceId}:${turnNumber}`;
}

/** Legacy evolve target: -1 = Active, 0-4 = Bench slot (in the actor's perspective). */
function pokemonIdAt(state: GameState, targetIndex: number | undefined): string | undefined {
  if (targetIndex === undefined) return undefined;
  const pokemon = targetIndex === -1 ? state.playerActivePokemon : state.playerBench[targetIndex];
  return pokemon?.pokemon.id;
}

/** The Spanish reason of a game-core IllegalActionError (illegal move), else null. */
function illegalReason(error: unknown): string | null {
  if (error instanceof IllegalActionError) return error.reason;
  if (error instanceof Error && error.name === "IllegalActionError") return (error as IllegalActionError).reason ?? error.message;
  return null;
}

interface ActionResult {
  success: boolean;
  error?: string;
  gameState?: GameState;
  gameOver?: boolean;
  winner?: "player1" | "player2";
  /** Coins every client animates (attacks, confusion): showCoinFlip to the room */
  coinFlipInfo?: CoinFlipInfo;
  /** Trainer/power coins: showCoinFlip to everyone but the actor (it showed them from requestCoinFlip) */
  opponentCoinFlipInfo?: CoinFlipInfo;
  winReason?: string;
  setupTimerStarted?: number; // timestamp when setup timer started (ms)
}

/**
 * Neutralize perspective-specific event messages for multiplayer.
 * Replaces "Tú"/"tu"/"Rival" with "Jugador 1"/"Jugador 2" so both
 * players see the same neutral logs.
 *
 * @param events - Full events array
 * @param fromIndex - Only process events from this index onward
 * @param self - Name for the "Tú/tu" perspective (the acting player)
 * @param opponent - Name for the "Rival" perspective
 */
function neutralizeEvents(
  events: GameState["events"],
  fromIndex: number,
  self: string,
  opponent: string
): GameState["events"] {
  if (fromIndex >= events.length) return events;

  // Exact string replacements [search, replacement] - order matters (longer first)
  const replacements: [string, string][] = [
    // Victory/Defeat
    ["¡Victoria! Has tomado todos tus premios", `Victoria de ${self}: tomó todos sus premios`],
    ["¡Derrota! El rival tomó todos sus premios", `Victoria de ${opponent}: tomó todos sus premios`],
    ["¡Victoria! El rival no tiene más Pokémon", `Victoria de ${self}. ${opponent} no tiene más Pokémon`],
    ["¡Derrota! No tienes más Pokémon", `Victoria de ${opponent}. ${self} no tiene más Pokémon`],
    ["¡Victoria! El rival no tiene cartas para robar", `Victoria de ${self}. ${opponent} no tiene cartas para robar`],
    ["¡Derrota! No tienes cartas para robar", `Victoria de ${opponent}. ${self} no tiene cartas para robar`],
    // Exit
    ["Ya puedes salir de la mesa", "Partida finalizada"],
    // Deck out
    ["¡No puedes robar! Tu mazo está vacío", `¡${self} no puede robar! Mazo vacío`],
    ["El rival no puede robar! Su mazo está vacío", `¡${opponent} no puede robar! Mazo vacío`],
    // Prize (specific first)
    ["El rival tomó un premio por el contraataque", `${opponent} tomó un premio por el contraataque`],
    ["El rival puede tomar un premio", `${opponent} puede tomar un premio`],
    ["El rival tomó un premio", `${opponent} tomó un premio`],
    ["¡Puedes tomar un premio!", `${self} puede tomar un premio`],
    // Turn end
    ["Fin de tu turno", `Fin del turno de ${self}`],
    ["Fin del turno del rival", `Fin del turno de ${opponent}`],
    // Card draw
    ["Robaste una carta", `${self} robó una carta`],
    ["El rival robó una carta", `${opponent} robó una carta`],
    // Setup
    ["Tú robas 7 cartas y colocas 6 premios", `${self} roba 7 cartas y coloca 6 premios`],
    ["Rival roba 7 cartas y coloca 6 premios", `${opponent} roba 7 cartas y coloca 6 premios`],
    // Mulligan
    ["Tú hiciste mulligan", `${self} hizo mulligan`],
    ["Rival hizo mulligan", `${opponent} hizo mulligan`],
    // Ready
    ["Tú estás listo", `${self} está listo`],
    ["Rival está listo", `${opponent} está listo`],
    // Game start
    ["Tú empiezas", `${self} empieza`],
    ["Rival empieza", `${opponent} empieza`],
  ];

  // Regex replacements for partial/contextual matches
  const regexReplacements: [RegExp, string][] = [
    [/^Tu turno$/, `Turno de ${self}`],
    [/^Turno del rival$/, `Turno de ${opponent}`],
    [/es ahora tu Pokémon activo/g, `es ahora el Pokémon activo de ${self}`],
    [/pasa a ser tu Pokémon activo/g, `pasa a ser el Pokémon activo de ${self}`],
    [/Pokémon activo del rival/g, `Pokémon activo de ${opponent}`],
    [/coloca tus Pokémon básicos/g, `coloca sus Pokémon básicos`],
    [/tu banca/g, `la banca de ${self}`],
    [/tu Pokémon activo/g, `el Pokémon activo de ${self}`],
    [/ \(rival\)/g, ""],
    // Privacy: strip card names from deck search results (Poké Ball, etc.)
    [/Salió cara — encontraste .+ en tu mazo/, `Moneda: [coin:heads]`],
    [/Salió cruz — no se encontró ninguna carta/, `Moneda: [coin:tails]`],
    // Also neutralize remaining "Encontraste X" patterns
    [/Encontraste (.+?) en tu mazo/g, `${self} encontró una carta en su mazo`],
    // Adjuntar energy — "Tú adjuntaste" / "Rival adjuntó"
    [/Tú adjuntaste/g, `${self} adjuntó`],
    [/Rival adjuntó/g, `${opponent} adjuntó`],
    // game-core board actions, Trainers and powers (second person, acting side)
    [/^Colocaste /, `${self} colocó `],
    [/^Adjuntaste /, `${self} adjuntó `],
    [/^Jugaste /, `${self} jugó `],
    [/^Robaste (\d+) carta/, `${self} robó $1 carta`],
    [/^Descartaste /, `${self} descartó `],
    [/^Barajaste /, `${self} barajó `],
    [/^Reordenaste /, `${self} reordenó `],
    [/^El rival barajó /, `${opponent} barajó `],
    [/ de tu mano/g, " de su mano"],
    [/ tu mazo/g, " su mazo"],
    [/^Turno de Jugador$/, `Turno de ${self}`],
    [/^Turno de Rival$/, `Turno de ${opponent}`],
  ];

  const newEvents = [...events];
  for (let i = fromIndex; i < newEvents.length; i++) {
    let msg = newEvents[i].message;

    for (const [search, replace] of replacements) {
      if (msg.includes(search)) {
        msg = msg.replace(search, replace);
      }
    }

    for (const [regex, replace] of regexReplacements) {
      msg = msg.replace(regex, replace);
    }

    if (msg !== newEvents[i].message) {
      newEvents[i] = { ...newEvents[i], message: msg };
    }
  }

  return newEvents;
}

const FORFEIT_TIMEOUT_MS = 120_000; // 2 minutes
const SETUP_TIMEOUT_MS = 90_000; // 90 seconds for opponent to finish setup

type ForfeitCallback = (
  roomId: string,
  winner: "player1" | "player2",
  gameState: GameState,
  reason?: string,
) => void;

export class GameRoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  private socketToRoom: Map<string, string> = new Map();
  private forfeitTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private setupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private setupTimerStartTimes: Map<string, number> = new Map(); // roomId → Date.now()
  private onForfeitCallback: ForfeitCallback | null = null;

  /** @param flipCoin - where every coin of this manager's games comes from (tests pass a scripted one) */
  constructor(private readonly flipCoin: CoinSource = serverCoin) {}

  /**
   * Set the callback for when a player forfeits due to disconnect timeout.
   */
  setOnForfeit(callback: ForfeitCallback): void {
    this.onForfeitCallback = callback;
  }

  /**
   * Create a new room
   */
  createRoom(roomId?: string, config?: Partial<RoomConfig>, creator?: Partial<CreatorInfo>): GameRoom {
    const id = roomId || this.generateRoomId();
    const prizeCount = config?.prizeCount ?? 6;
    const room: GameRoom = {
      id,
      status: "waiting",
      player1Id: null,
      player1SocketId: null,
      player1Ready: false,
      player1DeckId: null,
      player2Id: null,
      player2SocketId: null,
      player2Ready: false,
      player2DeckId: null,
      gameState: null,
      turnStartedAt: null,
      turnTimerDuration: 180,
      spectators: new Set(),
      config: {
        prizeCount: prizeCount >= 4 && prizeCount <= 6 ? prizeCount : 6,
        betAmount: config?.betAmount ?? 0,
        reservedUserId: config?.reservedUserId ?? null,
        friendly: config?.friendly ?? false,
      },
      creator: {
        username: creator?.username ?? null,
        avatarId: creator?.avatarId ?? null,
        titleId: creator?.titleId ?? null,
      },
      joiner: {
        username: null,
        avatarId: null,
        titleId: null,
      },
      players: [],
      createdAt: new Date(),
    };

    this.rooms.set(id, room);
    return room;
  }

  /**
   * Join an existing room or create if doesn't exist
   */
  async joinRoom(roomId: string, userId: string, socketId: string, displayInfo?: Partial<CreatorInfo>): Promise<GameRoom> {
    let room = this.rooms.get(roomId);

    if (!room) {
      room = this.createRoom(roomId);
    }

    // Check reservation (only for new player2 joins, not reconnects)
    if (room.config.reservedUserId && room.player1Id && !room.player2Id && room.config.reservedUserId !== userId && room.player1Id !== userId) {
      throw new Error("Esta mesa está reservada para otro jugador");
    }

    // Check if room is full
    if (room.player1Id && room.player2Id) {
      // Check if reconnecting
      if (room.player1Id === userId) {
        room.player1SocketId = socketId;
        this.socketToRoom.set(socketId, roomId);
        this.cancelForfeitTimer(roomId, "player1");
        this.cancelCleanupTimer(roomId);
        return room;
      }
      if (room.player2Id === userId) {
        room.player2SocketId = socketId;
        this.socketToRoom.set(socketId, roomId);
        this.cancelForfeitTimer(roomId, "player2");
        this.cancelCleanupTimer(roomId);
        return room;
      }
      throw new Error("Room is full");
    }

    // Add player to room
    if (!room.player1Id) {
      room.player1Id = userId;
      room.player1SocketId = socketId;
      room.players.push(userId);
    } else if (!room.player2Id) {
      room.player2Id = userId;
      room.player2SocketId = socketId;
      room.players.push(userId);
      // Store joiner display info
      if (displayInfo) {
        room.joiner = {
          username: displayInfo.username ?? null,
          avatarId: displayInfo.avatarId ?? null,
          titleId: displayInfo.titleId ?? null,
        };
      }
    }

    this.socketToRoom.set(socketId, roomId);
    return room;
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string, socketId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.player1SocketId === socketId) {
      room.player1Id = null;
      room.player1SocketId = null;
      room.player1Ready = false;
    } else if (room.player2SocketId === socketId) {
      room.player2Id = null;
      room.player2SocketId = null;
      room.player2Ready = false;
    }

    this.socketToRoom.delete(socketId);

    // Remove room if empty
    if (!room.player1Id && !room.player2Id) {
      this.rooms.delete(roomId);
    }

    // Clean up playing rooms where both players have left
    if (room.status === "playing" && !room.player1Id && !room.player2Id) {
      room.status = "finished";
      this.rooms.delete(roomId);
    }
  }

  /**
   * Set player as ready
   */
  async setPlayerReady(roomId: string, socketId: string): Promise<GameRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (room.player1SocketId === socketId) {
      room.player1Ready = true;
    } else if (room.player2SocketId === socketId) {
      room.player2Ready = true;
    } else {
      throw new Error("Player not in room");
    }

    return room;
  }

  /**
   * Set player's deck selection
   */
  setPlayerDeck(roomId: string, socketId: string, deckId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (room.player1SocketId === socketId) {
      room.player1DeckId = deckId;
    } else if (room.player2SocketId === socketId) {
      room.player2DeckId = deckId;
    }
  }

  /**
   * Start the game.
   *
   * When `resolvedDecks` is provided (pre-resolved GameCard arrays from
   * user database decks) those cards are used directly.  Otherwise the
   * room's deckId values are treated as built-in theme deck IDs.
   */
  async startGame(
    roomId: string,
    resolvedDecks?: { player1Cards: GameCard[]; player2Cards: GameCard[] },
  ): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (!room.player1Id || !room.player2Id) {
      throw new Error("Need two players to start");
    }

    room.status = "playing";

    let gameState: GameState;

    if (resolvedDecks) {
      // Use pre-resolved card arrays (user database decks)
      gameState = {
        playerDeck: shuffle(resolvedDecks.player1Cards),
        playerHand: [],
        playerPrizes: [],
        playerDiscard: [],
        playerActivePokemon: null,
        playerBench: [],
        opponentDeck: shuffle(resolvedDecks.player2Cards),
        opponentHand: [],
        opponentPrizes: [],
        opponentDiscard: [],
        opponentActivePokemon: null,
        opponentBench: [],
        selectedDeckId: "custom",
        turnNumber: 0,
        startingPlayer: null,
        isPlayerTurn: false,
        gameStarted: false,
        gamePhase: GamePhase.Mulligan,
        playerReady: false,
        opponentReady: false,
        energyAttachedThisTurn: false,
        retreatedThisTurn: false,
        playerCanTakePrize: false,
        opponentCanTakePrize: false,
        playerNeedsToPromote: false,
        opponentNeedsToPromote: false,
        activeModifiers: [],
        gameResult: null,
        events: [createGameEvent("Partida inicializada", "system")],
      };
      gameState = startGame(gameState);
    } else {
      // Fall back to built-in theme decks
      const player1Deck = getDeckById(room.player1DeckId || "brushfire") || decks[0];
      const player2Deck = getDeckById(room.player2DeckId || "overgrowth") || decks[1];
      gameState = initializeMultiplayerGame(player1Deck, player2Deck);
      gameState = startGame(gameState);
    }

    // Adjust prize count if room is configured for fewer prizes
    const trimCount = 6 - room.config.prizeCount;
    if (trimCount > 0) {
      const excessPlayer = gameState.playerPrizes.splice(-trimCount);
      gameState.playerDeck.push(...excessPlayer);
      const excessOpponent = gameState.opponentPrizes.splice(-trimCount);
      gameState.opponentDeck.push(...excessOpponent);
    }

    // Neutralize initial events (always canonical: Tú=P1, Rival=P2)
    gameState = {
      ...gameState,
      events: neutralizeEvents(gameState.events, 0, "Jugador 1", "Jugador 2"),
    };

    room.gameState = gameState;
    room.turnStartedAt = Date.now();
    return room.gameState;
  }

  /**
   * Start a game using raw card arrays (for draft matches).
   * Creates a GameState directly from pre-built decks instead of DeckEntry definitions.
   */
  async startGameWithRawDecks(
    roomId: string,
    player1Cards: GameCard[],
    player2Cards: GameCard[],
  ): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");
    if (!room.player1Id || !room.player2Id) {
      throw new Error("Need two players to start");
    }

    room.status = "playing";

    let gameState: GameState = {
      playerDeck: shuffle(player1Cards),
      playerHand: [],
      playerPrizes: [],
      playerDiscard: [],
      playerActivePokemon: null,
      playerBench: [],
      opponentDeck: shuffle(player2Cards),
      opponentHand: [],
      opponentPrizes: [],
      opponentDiscard: [],
      opponentActivePokemon: null,
      opponentBench: [],
      selectedDeckId: "draft",
      turnNumber: 0,
      startingPlayer: null,
      isPlayerTurn: false,
      gameStarted: false,
      gamePhase: GamePhase.Mulligan,
      playerReady: false,
      opponentReady: false,
      energyAttachedThisTurn: false,
      retreatedThisTurn: false,
      playerCanTakePrize: false,
      opponentCanTakePrize: false,
      playerNeedsToPromote: false,
      opponentNeedsToPromote: false,
      activeModifiers: [],
      gameResult: null,
      events: [createGameEvent("Partida de draft inicializada", "system")],
    };

    gameState = startGame(gameState);

    gameState = {
      ...gameState,
      events: neutralizeEvents(gameState.events, 0, "Jugador 1", "Jugador 2"),
    };

    room.gameState = gameState;
    room.turnStartedAt = Date.now();
    return room.gameState;
  }

  /**
   * Roll the coins a Trainer (Poké Ball) or activated power (Heal) needs BEFORE the client
   * asks its questions (heads → pick a card...). The coins are game-core's
   * getTrainerCoinFlips / getPowerCoinFlips for that card / Pokémon, and are kept until the
   * action succeeds: asking again returns the same coins (no re-rolls), for a Trainer card
   * for the rest of the game and for a power for the rest of the turn.
   */
  requestCoinFlip(
    roomId: string,
    socketId: string,
    request: CoinFlipRequest,
  ): { success: true; results: Coin[]; result: Coin } | { success: false; error: string } {
    const room = this.rooms.get(roomId);
    if (!room?.gameState) return { success: false, error: "Game not started" };
    const key = room.player1SocketId === socketId ? "player1" : room.player2SocketId === socketId ? "player2" : null;
    if (!key) return { success: false, error: "Not a player in this room" };
    const isMyTurn = key === "player1" ? room.gameState.isPlayerTurn : !room.gameState.isPlayerTurn;
    if (!isMyTurn) return { success: false, error: "Not your turn" };

    const view = key === "player1" ? room.gameState : swapSides(room.gameState);
    let coinKey: string;
    let requirement: CoinFlipRequirement;
    try {
      if (request.purpose === "trainer") {
        const reason = canPlayTrainerCard(view, request.cardId);
        if (reason) return { success: false, error: reason };
        requirement = getTrainerCoinFlips(view, request.cardId);
        coinKey = effectCoinKey(key, "trainer", request.cardId);
      } else {
        const reason = canUsePokemonPower(view, request.pokemonId);
        if (reason) return { success: false, error: reason };
        requirement = getPowerCoinFlips(view, request.pokemonId);
        coinKey = effectCoinKey(key, "power", request.pokemonId, view.turnNumber);
      }
    } catch (error) {
      return { success: false, error: illegalReason(error) ?? "No se pudo lanzar la moneda" };
    }
    if (requirement === 0) return { success: false, error: "Esta carta no lanza monedas" };

    const results = this.effectCoins(room, coinKey, requirement);
    return { success: true, results, result: results[0] };
  }

  /**
   * Coins for one effect: the ones already rolled for `coinKey` (requestCoinFlip, or an
   * earlier attempt that failed) when they still fit the requirement, else a fresh roll that
   * is stored. Removed by executeAction once the effect resolved.
   */
  private effectCoins(room: GameRoom, coinKey: string, requirement: CoinFlipRequirement): Coin[] {
    if (requirement === 0) return [];
    const store = (room.effectCoins ??= {});
    const turnNumber = room.gameState?.turnNumber ?? 0;
    // Power coins are per turn: forget older ones
    for (const [k, entry] of Object.entries(store)) {
      if (entry.turnNumber !== null && entry.turnNumber !== turnNumber) delete store[k];
    }
    const stored = store[coinKey];
    if (stored && coinsSatisfy(requirement, stored.results)) return stored.results;
    const results = rollCoins(requirement, this.flipCoin);
    store[coinKey] = { results, turnNumber: coinKey.includes(":power:") ? turnNumber : null };
    return results;
  }

  /**
   * Execute a player action. `rawAction` comes straight from the client and is validated
   * against gameActionSchema (schemas.ts) before anything else runs.
   */
  async executeAction(
    roomId: string,
    socketId: string,
    rawAction: unknown
  ): Promise<ActionResult> {
    const parsed = parseGameAction(rawAction);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const action = parsed.action;

    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: "Room not found" };
    if (!room.gameState) return { success: false, error: "Game not started" };

    // Determine which player is acting
    const isPlayer1 = room.player1SocketId === socketId;
    const isPlayer2 = room.player2SocketId === socketId;

    if (!isPlayer1 && !isPlayer2) {
      return { success: false, error: "Not a player in this room" };
    }

    // Validate turn - player1 plays when isPlayerTurn is true
    // During MULLIGAN/SETUP, both players can place Pokemon regardless of turn
    // Pending attack choices (deckSearch, forceSwitch, selfSwitch, skipSwitch, benchDamage) are NOT here:
    // they belong to the attacker, and endTurn() doesn't advance while one is pending, so they
    // require it to be the acting player's turn. Otherwise the opponent could resolve your choice.
    const turnFreeActions = ["ready", "mulligan", "playerReady", "takePrize", "promote", "surrender"];
    const setupActions = ["playBasicToActive", "playBasicToBench"];
    const isSetupPhase = room.gameState.gamePhase === "MULLIGAN" || room.gameState.gamePhase === "SETUP";
    const isMyTurn = isPlayer1 ? room.gameState.isPlayerTurn : !room.gameState.isPlayerTurn;

    if (!isMyTurn && !turnFreeActions.includes(action.type)) {
      // Allow setup actions during MULLIGAN/SETUP phase regardless of turn
      if (!isSetupPhase || !setupActions.includes(action.type)) {
        return { success: false, error: "Not your turn" };
      }
    }

    console.log(`[Room ${roomId}] Action from ${isPlayer1 ? "P1" : "P2"}: ${action.type}`, action.payload);

    // Track event count for neutralization
    const eventCountBefore = room.gameState.events.length;
    // mulligan/playerReady/surrender work on player 1's perspective; everything else as the actor
    const actsAsActor = action.type !== "mulligan" && action.type !== "playerReady" && action.type !== "surrender";
    let eventsNeutralizedTo = eventCountBefore;

    // The game state is stored in player 1's perspective and game-core always acts for
    // "player": player 2's actions run on a swapped copy (game-core's swapSides, which also
    // swaps the starting player, PlusPower/Defender owner and result) that is swapped back.
    // Pending choices are not swapped: they belong to the side whose turn it is.
    const toActor = (state: GameState): GameState => (isPlayer1 ? state : swapSides(state));
    const fromActor = toActor; // the swap is its own inverse
    const actorView = toActor(room.gameState);
    const actorKey: PlayerKey = isPlayer1 ? "player1" : "player2";

    // For game-core functions: swap perspective for player2, call function, swap back
    const executeForPlayer = (fn: (state: GameState) => GameState, from: GameState = room.gameState!): GameState =>
      fromActor(fn(toActor(from)));

    // Coins shown to both players (attacks, confusion) / only to the opponent and spectators
    // (trainer and power coins: the acting client already showed them from requestCoinFlip)
    let actionCoinFlipInfo: CoinFlipInfo | undefined;
    let opponentCoinFlipInfo: CoinFlipInfo | undefined;
    // Effect coins to forget once the action succeeded
    let consumedCoinKey: string | undefined;

    try {
      let newState = room.gameState;

      switch (action.type) {
        case "attack": {
          const attackIndex = action.payload.attackIndex;
          const metronomePayload = action.payload.metronomeAttack;
          const conversionType = action.payload.conversionType;
          const conversionEffect = action.payload.conversionEffect;
          const attacker = actorView.playerActivePokemon;
          const ownAttack = attacker && isPokemonCard(attacker.pokemon) ? attacker.pokemon.attacks[attackIndex] : undefined;

          // ── Which attack, and is it legal? Checked BEFORE any coin (confusion included):
          // energy cost, Asleep/Paralyzed, Leer, one attack per turn, nothing pending...
          let attackToUse: number | Attack = attackIndex;
          let attackName = ownAttack?.name ?? "";
          if (metronomePayload) {
            if (!ownAttack?.effects?.some((e) => e.type === AttackEffectType.CopyAttack)) {
              return { success: false, error: "Ese ataque no puede copiar ataques" };
            }
            const opponentActive = actorView.opponentActivePokemon;
            const copiedAttack = opponentActive && isPokemonCard(opponentActive.pokemon)
              ? opponentActive.pokemon.attacks[metronomePayload.index]
              : undefined;
            if (!copiedAttack) return { success: false, error: "El Pokémon defensor no tiene ese ataque" };
            const reason = canExecuteMetronome(actorView, copiedAttack);
            if (reason) return { success: false, error: reason };
            attackToUse = copiedAttack;
            attackName = copiedAttack.name;
          } else {
            const reason = canExecuteAttack(actorView, attackIndex);
            if (reason) return { success: false, error: reason };
          }

          // Porygon's Conversion 1/2: only with the attack that has that effect
          const conversion = conversionType && conversionEffect ? { type: conversionType, effect: conversionEffect } : null;
          if (conversion) {
            const effectType = conversion.effect === "changeWeakness" ? AttackEffectType.ChangeWeakness : AttackEffectType.ChangeResistance;
            if (metronomePayload || !ownAttack?.effects?.some((e) => e.type === effectType)) {
              return { success: false, error: "Ese ataque no cambia debilidad ni resistencia" };
            }
          }

          // ── Confusion: the server flips (never the client). Tails: the attack fails, the
          // engine applies the self-damage / KO / end of turn. Heads: the attack proceeds.
          let beforeAttack = room.gameState;
          if (attacker?.statusConditions?.includes("confused")) {
            const confusionCoin = this.flipCoin();
            let canAttack = true as boolean;
            const afterFlip = executeForPlayer((state) => {
              const resolved = resolveConfusionFlip(state, confusionCoin === "heads");
              canAttack = resolved.canAttack;
              return resolved.state;
            });
            if (!canAttack) {
              newState = afterFlip;
              actionCoinFlipInfo = { attackName: "Confusión", results: [confusionCoin] };
              break;
            }
            beforeAttack = afterFlip; // heads: continue the attack from the flipped state
          }

          // ── Porygon Conversion 1 / Conversion 2 (still resolved here, no engine resolver) ──
          if (conversion && ownAttack) {
            newState = executeForPlayer((state) => {
              const user = state.playerActivePokemon!;
              const events = [...state.events, createGameEvent(`${user.pokemon.name} usó ${ownAttack.name}`, "action")];
              if (conversion.effect === "changeWeakness") {
                const defender = state.opponentActivePokemon!;
                events.push(createGameEvent(`La debilidad de ${defender.pokemon.name} cambió a ${conversion.type}`, "action"));
                return endTurn({ ...state, opponentActivePokemon: { ...defender, modifiedWeakness: conversion.type }, events }, true);
              }
              events.push(createGameEvent(`La resistencia de ${user.pokemon.name} cambió a ${conversion.type}`, "action"));
              return endTurn({ ...state, playerActivePokemon: { ...user, modifiedResistance: conversion.type }, events }, true);
            }, beforeAttack);
            break;
          }

          // ── Attack (or Metronome copying the Defending Pokémon's attack) ──
          // The server flips exactly the coins the engine asks for (getAttackCoinFlipCount,
          // Sand-attack's coin included) and passes them in; the engine resolves every coin
          // effect, the KO/prize flow and the end of the turn. skipDefenderPromotion: the
          // defender picks its new active (`promote`), which then ends the attacker's turn.
          const coinResults = rollCoins(getAttackCoinFlipCount(toActor(beforeAttack), attackToUse), this.flipCoin);
          const attackOptions = { coinResults, skipDefenderPromotion: true };
          newState = executeForPlayer((state) =>
            typeof attackToUse === "number"
              ? executeAttack(state, attackToUse, attackOptions)
              : executeMetronome(state, attackToUse, attackOptions),
          beforeAttack);

          // Both clients animate the real coins (showCoinFlip)
          if (coinResults.length > 0) {
            actionCoinFlipInfo = { attackName, results: coinResults };
          }
          break;
        }

        case "endTurn":
          newState = executeForPlayer((state) => endTurn(state, true));
          break;

        case "retreat": {
          const energyIds = action.payload.energyIdsToDiscard;
          const benchIdx = action.payload.benchIndex;
          newState = executeForPlayer((state) => executeRetreat(state, energyIds, benchIdx));
          break;
        }

        // ── Board actions: game-core validates and applies them (IllegalActionError otherwise) ──
        case "playBasicToActive": {
          const cardId = action.payload.cardId;
          newState = executeForPlayer((state) => playBasicPokemon(state, cardId, "active"));
          break;
        }

        case "playBasicToBench": {
          const cardId = action.payload.cardId;
          newState = executeForPlayer((state) => playBasicPokemon(state, cardId, "bench"));
          break;
        }

        case "attachEnergy": {
          // Rain Dance (and any future attach power) is applied by the engine when it applies
          const { cardId, pokemonId } = action.payload;
          newState = executeForPlayer((state) => attachEnergyCard(state, cardId, pokemonId));
          break;
        }

        case "evolve": {
          const { cardId } = action.payload;
          const targetPokemonId = action.payload.targetPokemonId ?? pokemonIdAt(actorView, action.payload.targetIndex);
          if (!targetPokemonId) return { success: false, error: "Debes elegir uno de tus Pokémon en juego" };
          newState = executeForPlayer((state) => evolvePokemonCard(state, cardId, targetPokemonId));
          break;
        }

        case "takePrize": {
          const prizeIndex = action.payload.prizeIndex;
          if (!actorView.playerCanTakePrize) {
            return { success: false, error: "Cannot take a prize now" };
          }
          newState = executeForPlayer((state) => takePrize(state, prizeIndex, true));
          break;
        }

        case "promote": {
          const benchIndex = action.payload.benchIndex;
          if (!actorView.playerNeedsToPromote) {
            return { success: false, error: "No promotion needed" };
          }
          newState = executeForPlayer((state) => promoteActivePokemon(state, benchIndex));

          // After the defender promotes its new active Pokémon, end the attacker's turn.
          // The attacker is the OTHER player (the one who KO'd the defender): endTurn was
          // skipped inside executeAttack because the promotion was pending.
          // Only proceed if both actives are present and game can continue.
          if (
            newState.gamePhase !== "GAME_OVER" &&
            newState.playerActivePokemon !== null &&
            newState.opponentActivePokemon !== null &&
            !newState.playerCanTakePrize &&
            !newState.opponentCanTakePrize
          ) {
            // The promotion's events speak for the promoter; endTurn's for the attacker
            const promoter = isPlayer1 ? "Jugador 1" : "Jugador 2";
            const attackerName = isPlayer1 ? "Jugador 2" : "Jugador 1";
            newState = { ...newState, events: neutralizeEvents(newState.events, eventsNeutralizedTo, promoter, attackerName) };
            eventsNeutralizedTo = newState.events.length;
            const attackerIsPlayer1 = !isPlayer1;
            newState = attackerIsPlayer1 ? endTurn(newState) : swapSides(endTurn(swapSides(newState)));
            newState = { ...newState, events: neutralizeEvents(newState.events, eventsNeutralizedTo, attackerName, promoter) };
            eventsNeutralizedTo = newState.events.length;
          }
          break;
        }

        case "deckSearch": {
          const selectedCardId = action.payload.cardId;
          newState = executeForPlayer((state) => executeDeckSearch(state, selectedCardId));
          break;
        }

        case "forceSwitch": {
          const benchIndex = action.payload.benchIndex;
          newState = executeForPlayer((state) => applyForceSwitch(state, benchIndex));
          break;
        }

        case "selfSwitch": {
          const benchIndex = action.payload.benchIndex;
          newState = executeForPlayer((state) => applySelfSwitch(state, benchIndex));
          break;
        }

        case "skipSwitch": {
          newState = executeForPlayer((state) => skipPendingSwitch(state));
          break;
        }

        case "benchDamage": {
          const selectedPokemonIds = action.payload.selectedPokemonIds;
          newState = executeForPlayer((state) => executeBenchDamage(state, selectedPokemonIds));
          break;
        }

        case "clearPeek": {
          // Only the side that peeked (whose turn it is) owns pendingPeek
          if (!actorView.isPlayerTurn) return { success: false, error: "Not your turn" };
          newState = executeForPlayer((state) => clearPendingPeek(state));
          break;
        }

        case "mulligan": {
          // Mulligan: shuffle hand back into deck and draw 7 new cards
          // isPlayer1 = true means player1's perspective, so isPlayer = true
          newState = doMulligan(room.gameState, isPlayer1);
          break;
        }

        case "playerReady": {
          // Mark player as ready (after mulligan check or setup)
          newState = setPlayerReady(room.gameState, isPlayer1);

          // Check if both players are ready to start the game
          const p1Ready = isPlayer1 ? true : newState.playerReady;
          const p2Ready = isPlayer1 ? newState.opponentReady : true;

          if (p1Ready && p2Ready && newState.gamePhase === "MULLIGAN") {
            // Both players ready - cancel setup timer and start the game. The engine draws the
            // starting player's first card (classic rule): nothing to draw here.
            this.cancelSetupTimer(roomId);
            const coinFlipResult = this.flipCoin();
            newState = startPlayingPhase(newState, coinFlipResult);
          } else if ((p1Ready || p2Ready) && !(p1Ready && p2Ready)) {
            // Only one player is ready — start setup timer for the opponent
            this.startSetupTimer(roomId, isPlayer1 ? "player1" : "player2");
          }
          break;
        }

        // ── Activated Pokémon Powers through game-core's effect registry ──
        // { pokemonId, selections }: the engine checks the power (owner, status, once per turn,
        // Toxic Gas...) and every selection against its own steps. Coins (Heal) are rolled here.
        case "usePower": {
          const { pokemonId, selections } = action.payload;
          const reason = canUsePokemonPower(actorView, pokemonId);
          if (reason) return { success: false, error: reason };
          const requirement = getPowerCoinFlips(actorView, pokemonId);
          const coinKey = effectCoinKey(actorKey, "power", pokemonId, actorView.turnNumber);
          const coinResults = this.effectCoins(room, coinKey, requirement);
          newState = executeForPlayer((state) => usePokemonPower(state, pokemonId, selections, { coinResults }));
          if (coinResults.length > 0) {
            consumedCoinKey = coinKey;
            const source = findInPlay(actorView, "player", pokemonId)?.pokemon.pokemon;
            const powerName = source && isPokemonCard(source) ? source.power?.name : undefined;
            opponentCoinFlipInfo = { attackName: powerName ?? "Poder Pokémon", results: coinResults };
          }
          break;
        }

        // ── Trainers through game-core's effect registry ──
        // { cardId, selections }: the card that runs is the one in the hand with that id; the
        // engine validates the selections against the card's steps. Coins (Poké Ball) are rolled
        // here, never taken from the client.
        case "playTrainer": {
          const { cardId, selections, trainerName } = action.payload;
          const card = actorView.playerHand.find((c) => c.id === cardId);
          if (card && trainerName !== undefined && card.name !== trainerName) {
            return { success: false, error: "La carta no coincide con el entrenador indicado" };
          }
          const reason = canPlayTrainerCard(actorView, cardId);
          if (reason) return { success: false, error: reason };
          const requirement = getTrainerCoinFlips(actorView, cardId);
          const coinKey = effectCoinKey(actorKey, "trainer", cardId);
          const coinResults = this.effectCoins(room, coinKey, requirement);
          newState = executeForPlayer((state) => playTrainerCard(state, cardId, selections, { coinResults }));
          if (coinResults.length > 0) {
            consumedCoinKey = coinKey;
            opponentCoinFlipInfo = { attackName: card?.name ?? "Entrenador", results: coinResults };
          }
          break;
        }

        case "surrender": {
          // Player surrenders — opponent wins
          const surrendererName = isPlayer1
            ? (room.creator.username || "Jugador 1")
            : (room.joiner.username || "Jugador 2");
          newState = {
            ...room.gameState!,
            gamePhase: GamePhase.GameOver,
            gameResult: isPlayer1 ? "defeat" : "victory", // From player1 perspective
            events: [
              ...room.gameState!.events,
              createGameEvent(`${surrendererName} se ha rendido`, "system"),
            ],
          };
          break;
        }

        default: {
          // Unreachable: parseGameAction only lets known action types through.
          const unknownType: never = action;
          return { success: false, error: `Unknown action type: ${(unknownType as { type: string }).type}` };
        }
      }

      // Neutralize perspective-specific events for multiplayer
      {
        const selfName = actsAsActor && !isPlayer1 ? "Jugador 2" : "Jugador 1";
        const opponentName = selfName === "Jugador 1" ? "Jugador 2" : "Jugador 1";
        newState = {
          ...newState,
          events: neutralizeEvents(newState.events, eventsNeutralizedTo, selfName, opponentName),
        };
      }

      room.gameState = newState;
      if (consumedCoinKey && room.effectCoins) delete room.effectCoins[consumedCoinKey];

      // Update turn timer when turn changes
      room.turnStartedAt = Date.now();

      // Check for game over
      const gameOver = newState.gamePhase === "GAME_OVER";
      let winner: "player1" | "player2" | undefined;
      let winReason: string | undefined;

      if (gameOver) {
        room.status = "finished";
        // From player1's perspective: victory = player1 wins
        winner = newState.gameResult === "victory" ? "player1" : "player2";
        winReason = newState.gameResult === "victory"
          ? "Player 1 wins!"
          : "Player 2 wins!";
      }

      // Include setup timer info if timer is active
      const setupTimerStarted = this.setupTimerStartTimes.get(roomId);

      return {
        success: true,
        gameState: room.gameState,
        gameOver,
        winner,
        winReason,
        ...(actionCoinFlipInfo ? { coinFlipInfo: actionCoinFlipInfo } : {}),
        ...(opponentCoinFlipInfo ? { opponentCoinFlipInfo } : {}),
        ...(setupTimerStarted ? { setupTimerStarted } : {}),
      };
    } catch (error) {
      // An illegal move (game-core's canX said no): reject it, the stored state is untouched
      const reason = illegalReason(error);
      if (reason) {
        console.log(`[Room ${roomId}] Rejected ${action.type}: ${reason}`);
        return { success: false, error: reason };
      }
      console.error(`[Room ${roomId}] Action error:`, error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Handle player disconnect
   */
  async handleDisconnect(socketId: string): Promise<string | null> {
    // Remove from spectators if applicable
    for (const [, r] of this.rooms.entries()) {
      if (r.spectators.has(socketId)) {
        r.spectators.delete(socketId);
      }
    }

    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Mark player as disconnected but don't remove yet (allow reconnect)
    let disconnectedSide: "player1" | "player2" | null = null;
    if (room.player1SocketId === socketId) {
      room.player1SocketId = null;
      disconnectedSide = "player1";
    } else if (room.player2SocketId === socketId) {
      room.player2SocketId = null;
      disconnectedSide = "player2";
    }

    this.socketToRoom.delete(socketId);

    // Start forfeit timer if game is in progress
    if (disconnectedSide && room.status === "playing" && room.gameState) {
      this.startForfeitTimer(roomId, disconnectedSide);
    }

    // If both players are disconnected from a playing room, start cleanup timer
    if (room.status === "playing" && !room.player1SocketId && !room.player2SocketId) {
      this.startCleanupTimer(roomId);
    }

    return roomId;
  }

  /**
   * Start a forfeit timer for a disconnected player.
   */
  private startForfeitTimer(
    roomId: string,
    disconnectedSide: "player1" | "player2",
  ): void {
    const timerKey = `${roomId}:${disconnectedSide}`;

    // Don't start if already running
    if (this.forfeitTimers.has(timerKey)) return;

    console.log(
      `⏱️ Forfeit timer started for ${disconnectedSide} in room ${roomId} (${FORFEIT_TIMEOUT_MS / 1000}s)`,
    );

    const timer = setTimeout(() => {
      this.handleForfeitTimeout(roomId, disconnectedSide);
    }, FORFEIT_TIMEOUT_MS);

    this.forfeitTimers.set(timerKey, timer);
  }

  /**
   * Cancel a forfeit timer (player reconnected).
   */
  private cancelForfeitTimer(
    roomId: string,
    side: "player1" | "player2",
  ): void {
    const timerKey = `${roomId}:${side}`;
    const timer = this.forfeitTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.forfeitTimers.delete(timerKey);
      console.log(
        `⏱️ Forfeit timer cancelled for ${side} in room ${roomId} (reconnected)`,
      );
    }
  }

  /**
   * Handle forfeit timeout — player didn't reconnect in time.
   */
  private handleForfeitTimeout(
    roomId: string,
    disconnectedSide: "player1" | "player2",
  ): void {
    const timerKey = `${roomId}:${disconnectedSide}`;
    this.forfeitTimers.delete(timerKey);

    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.status !== "playing") return;

    // Check if still disconnected
    const isStillDisconnected =
      disconnectedSide === "player1"
        ? room.player1SocketId === null
        : room.player2SocketId === null;

    if (!isStillDisconnected) return;

    console.log(
      `⏱️ Forfeit timeout for ${disconnectedSide} in room ${roomId}`,
    );

    room.status = "finished";
    const winner = disconnectedSide === "player1" ? "player2" : "player1";

    if (this.onForfeitCallback) {
      this.onForfeitCallback(roomId, winner, room.gameState);
    }
  }

  /**
   * Start a setup timer when the first player clicks ready.
   * If the opponent doesn't click ready within SETUP_TIMEOUT_MS, the ready player wins.
   */
  startSetupTimer(roomId: string, readySide: "player1" | "player2"): void {
    // Don't start if already running
    if (this.setupTimers.has(roomId)) return;

    const startTime = Date.now();
    console.log(
      `⏱️ Setup timer started in room ${roomId} — ${readySide} is ready (${SETUP_TIMEOUT_MS / 1000}s)`,
    );

    const timer = setTimeout(() => {
      this.handleSetupTimeout(roomId, readySide);
    }, SETUP_TIMEOUT_MS);

    this.setupTimers.set(roomId, timer);
    this.setupTimerStartTimes.set(roomId, startTime);
  }

  /**
   * Get the setup timer start time for a room (if active).
   */
  getSetupTimerStart(roomId: string): number | null {
    return this.setupTimerStartTimes.get(roomId) ?? null;
  }

  /**
   * Cancel the setup timer (both players are ready).
   */
  private cancelSetupTimer(roomId: string): void {
    const timer = this.setupTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.setupTimers.delete(roomId);
      this.setupTimerStartTimes.delete(roomId);
      console.log(`⏱️ Setup timer cancelled for room ${roomId} (both ready)`);
    }
  }

  /**
   * Handle setup timeout — opponent didn't click ready in time.
   */
  private handleSetupTimeout(
    roomId: string,
    readySide: "player1" | "player2",
  ): void {
    this.setupTimers.delete(roomId);

    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.status !== "playing") return;

    // Check that only one player is ready (the other isn't)
    const p1Ready = room.gameState.playerReady;
    const p2Ready = room.gameState.opponentReady;
    if (p1Ready && p2Ready) return; // Both ready, game should have started

    console.log(
      `⏱️ Setup timeout in room ${roomId} — ${readySide} wins (opponent not ready)`,
    );

    room.status = "finished";
    const winner = readySide;

    if (this.onForfeitCallback) {
      this.onForfeitCallback(roomId, winner, room.gameState, "Rival no completó la preparación a tiempo");
    }
  }

  /**
   * Start a cleanup timer for rooms where both players disconnected.
   */
  private startCleanupTimer(roomId: string): void {
    if (this.cleanupTimers.has(roomId)) return;

    console.log(`🧹 Cleanup timer started for room ${roomId} (5 min)`);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(roomId);
      const room = this.rooms.get(roomId);
      if (!room) return;
      // Only clean up if still both disconnected
      if (!room.player1SocketId && !room.player2SocketId) {
        console.log(`🧹 Cleaning up abandoned room ${roomId}`);
        room.status = "finished";
        this.rooms.delete(roomId);
      }
    }, 300_000); // 5 minutes

    this.cleanupTimers.set(roomId, timer);
  }

  /**
   * Cancel cleanup timer (a player reconnected).
   */
  private cancelCleanupTimer(roomId: string): void {
    const timer = this.cleanupTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(roomId);
      console.log(`🧹 Cleanup timer cancelled for room ${roomId} (player reconnected)`);
    }
  }

  /**
   * Start periodic cleanup of stale rooms (call once at server start).
   */
  startPeriodicCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [id, room] of this.rooms.entries()) {
        // Delete finished rooms older than 5 minutes
        if (room.status === "finished" && now - room.createdAt.getTime() > 300_000) {
          this.rooms.delete(id);
        }
        // Delete waiting rooms older than 30 minutes with no player 2
        if (room.status === "waiting" && !room.player2Id && now - room.createdAt.getTime() > 1_800_000) {
          this.rooms.delete(id);
          console.log(`🧹 Deleted stale waiting room ${id}`);
        }
      }
    }, 60_000); // Run every minute
  }

  /**
   * Get all rooms (for admin panel).
   */
  getAllRooms(): Map<string, GameRoom> {
    return this.rooms;
  }

  /**
   * Get a room by ID
   */
  getRoom(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Get all available rooms (waiting for players)
   */
  getAvailableRooms(): GameRoom[] {
    const rooms: GameRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.status === "waiting" && !room.player2Id) {
        rooms.push(room);
      }
    }
    return rooms;
  }

  /**
   * Get all active rooms (waiting or playing)
   */
  getActiveRooms(): GameRoom[] {
    const rooms: GameRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.status === "waiting" || room.status === "playing") {
        rooms.push(room);
      }
    }
    return rooms;
  }

  /**
   * Delete a room (only creator can delete)
   */
  deleteRoom(roomId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // Only player 1 (creator) can delete the room
    if (room.player1SocketId !== socketId) {
      return false;
    }

    // Can only delete if game hasn't started
    if (room.status === "playing") {
      return false;
    }

    this.rooms.delete(roomId);
    this.socketToRoom.delete(socketId);
    return true;
  }

  /**
   * Force-delete a room (used by system for auto-cleanup, bypasses creator check).
   */
  forceDeleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    // Clean up timers and socket mappings
    this.cancelSetupTimer(roomId);
    if (room.player1SocketId) this.socketToRoom.delete(room.player1SocketId);
    if (room.player2SocketId) this.socketToRoom.delete(room.player2SocketId);
    this.rooms.delete(roomId);
    return true;
  }

  /**
   * Request to kick a player whose turn has timed out.
   * Returns the winner side if successful.
   */
  requestKick(roomId: string, socketId: string): { success: boolean; winner?: "player1" | "player2"; error?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: "Room not found" };
    if (room.status !== "playing" || !room.gameState) {
      return { success: false, error: "Game is not in progress" };
    }

    // Determine which player is requesting the kick
    const isPlayer1 = room.player1SocketId === socketId;
    const isPlayer2 = room.player2SocketId === socketId;
    if (!isPlayer1 && !isPlayer2) {
      return { success: false, error: "Not a player in this room" };
    }

    // Check that it's the OPPONENT's turn (you can only kick when opponent's time is up)
    const isOpponentsTurn = isPlayer1 ? !room.gameState.isPlayerTurn : room.gameState.isPlayerTurn;
    if (!isOpponentsTurn) {
      return { success: false, error: "Solo puedes expulsar cuando es el turno del rival" };
    }

    // Check if turn timer has expired
    if (!room.turnStartedAt) {
      return { success: false, error: "Timer not initialized" };
    }
    const elapsed = (Date.now() - room.turnStartedAt) / 1000;
    if (elapsed < room.turnTimerDuration) {
      return { success: false, error: "El rival aún tiene tiempo" };
    }

    // Kick is valid — the requesting player wins
    room.status = "finished";
    const winner: "player1" | "player2" = isPlayer1 ? "player1" : "player2";
    console.log(`⏱️ Kick: ${winner} wins in room ${roomId} (opponent turn timed out after ${Math.floor(elapsed)}s)`);

    return { success: true, winner };
  }

  /**
   * Add a spectator to a room
   */
  addSpectator(roomId: string, socketId: string): GameRoom | null {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "playing") return null;
    room.spectators.add(socketId);
    return room;
  }

  /**
   * Remove a spectator from a room
   */
  removeSpectator(roomId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.spectators.delete(socketId);
    }
  }

  /**
   * Check if a socket is a spectator in a room
   */
  isSpectator(roomId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.spectators.has(socketId) ?? false;
  }

  /**
   * Find an active ("playing") room where the given user is a player.
   */
  getActiveRoomForUser(userId: string): GameRoom | null {
    for (const room of this.rooms.values()) {
      if (room.status === "playing" && (room.player1Id === userId || room.player2Id === userId)) {
        return room;
      }
    }
    return null;
  }

  /**
   * Find a "waiting" room created by the given user (as player1).
   */
  findWaitingRoomByUser(userId: string): GameRoom | null {
    for (const room of this.rooms.values()) {
      if (room.status === "waiting" && room.player1Id === userId) {
        return room;
      }
    }
    return null;
  }

  /**
   * Check if both players are ready to start
   */
  isRoomReady(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.player1Id !== null && room.player2Id !== null;
  }

  /**
   * Generate a unique room ID
   */
  private generateRoomId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
