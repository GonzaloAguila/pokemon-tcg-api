/**
 * Game Room Manager
 *
 * Manages in-memory game rooms for real-time multiplayer.
 * TODO: Persist to database for reconnection support.
 */

import {
  type GameState,
  type GameCard,
  type PokemonInPlay,
  type EnergyType,
  type AttackEffect,
  type Attack,
  GamePhase,
  initializeMultiplayerGame,
  startGame,
  shuffle,
  executeAttack,
  executeMetronome,
  endTurn,
  executeRetreat,
  doMulligan,
  setPlayerReady,
  startPlayingPhase,
  getDeckById,
  decks,
  isPokemonCard,
  isEnergyCard,
  canEvolveInto,
  promoteActivePokemon,
  takePrize,
  createGameEvent,
  AttackEffectType,
  applyStatusCondition,
  // Pending state handlers
  executeDeckSearch,
  executeBenchDamage,
  applyForceSwitch,
  applySelfSwitch,
  skipPendingSwitch,
  // Trainers
  playBill,
  playSwitch,
  playGustOfWind,
  playPlusPower,
  playDefender,
  playPotion,
  playSuperPotion,
  playFullHeal,
  playEnergyRemoval,
  playSuperEnergyRemoval,
  playProfessorOak,
  playImposterProfessorOak,
  playLass,
  playPokemonCenter,
  playEnergyRetrieval,
  playMaintenance,
  playComputerSearch,
  playItemFinder,
  playPokemonBreeder,
  playPokemonTrader,
  playScoopUp,
  playPokeBall,
  // Powers
  attachEnergyWithRainDance,
  moveEnergyWithEnergyTrans,
  moveDamageWithDamageSwap,
  activateEnergyBurn,
  executeBuzzap,
  executeHealFlip,
  initiateShift,
  executeShift,
  executePeek,
  clearPendingPeek,
  canUseRainDance,
  canAttachWithPower,
  getEnergyTypeInSpanish,
  // Additional trainers
  playDevolutionSpray,
  playPokedex,
} from "@gonzaloaguila/game-core";

interface PlayerAction {
  type: string;
  payload: Record<string, unknown>;
}

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
}

interface ActionResult {
  success: boolean;
  error?: string;
  gameState?: GameState;
  gameOver?: boolean;
  winner?: "player1" | "player2";
  coinFlipInfo?: { attackName: string; results: Array<"heads" | "tails"> };
  winReason?: string;
  setupTimerStarted?: number; // timestamp when setup timer started (ms)
}

/**
 * Apply coin flip effects that executeAttack skips.
 * executeAttack skips all effects with coinFlip property, expecting the caller to handle them.
 */
function applyCoinFlipEffects(
  state: GameState,
  results: Array<"heads" | "tails">,
  effects: AttackEffect[],
  isPlayer1: boolean,
  skipCoinLog = false
): GameState {
  let newState = state;
  const headsCount = results.filter(r => r === "heads").length;
  const tailsCount = results.filter(r => r === "tails").length;

  const statusMessages: Record<string, string> = {
    paralyzed: "paralizado",
    asleep: "dormido",
    confused: "confundido",
    poisoned: "envenenado",
    cannotAttack: "bloqueado para atacar",
  };

  // Log coin flip results (skip if already logged before executeAttack)
  if (!skipCoinLog) {
    const coinTokens = results.map(r => `[coin:${r}]`).join(" ");
    const coinResultText = results.length === 1 ? `Moneda: ${coinTokens}` : `Monedas: ${coinTokens}`;
    newState = {
      ...newState,
      events: [...newState.events, createGameEvent(coinResultText, "info")],
    };
  }

  for (const effect of effects) {
    if (!effect.coinFlip) continue;

    // ApplyStatus on heads (e.g., Magnemite's Thundershock -> Paralyze, Venomoth Venom Powder -> Confused+Poisoned)
    if (effect.type === AttackEffectType.ApplyStatus) {
      // Status can be in effect.status (no-coinFlip attacks handled by engine) or in coinFlip.onHeads/onTails
      let statusToApply: string | null = null;
      if (headsCount > 0 && effect.coinFlip.onHeads && effect.coinFlip.onHeads !== "damage" && effect.coinFlip.onHeads !== "protection") {
        statusToApply = effect.coinFlip.onHeads;
      } else if (tailsCount > 0 && headsCount === 0 && effect.coinFlip.onTails && effect.coinFlip.onTails !== "damage" && effect.coinFlip.onTails !== "protection") {
        statusToApply = effect.coinFlip.onTails;
      }
      // Fallback: if effect.status is set and we got heads, use it
      if (!statusToApply && effect.status && headsCount > 0) {
        statusToApply = effect.status;
      }

      if (statusToApply) {
        const isSelfTarget = effect.target === "self";
        const defenderKey = isSelfTarget
          ? (isPlayer1 ? "playerActivePokemon" : "opponentActivePokemon")
          : (isPlayer1 ? "opponentActivePokemon" : "playerActivePokemon");
        const target = newState[defenderKey as keyof GameState] as PokemonInPlay | null;

        if (target) {
          // Apply primary status + any additional statuses (e.g. Venom Powder: confused + poisoned)
          const allStatuses = [statusToApply, ...((effect as { additionalStatuses?: string[] }).additionalStatuses || [])];
          for (const st of allStatuses) {
            const currentTarget = newState[defenderKey as keyof GameState] as PokemonInPlay | null;
            if (!currentTarget) break;
            const updated = applyStatusCondition(currentTarget, st as "paralyzed" | "poisoned" | "confused" | "asleep" | "cannotAttack", newState.turnNumber);
            if (updated !== currentTarget) {
              newState = {
                ...newState,
                [defenderKey]: updated,
                events: [
                  ...newState.events,
                  createGameEvent(`¡${currentTarget.pokemon.name} está ${statusMessages[st] || st}!`, "action"),
                ],
              };
              console.log(`[coinFlip] Applied ${st} to ${isSelfTarget ? "attacker" : "defender"}`);
            }
          }
        }
      }
    }

    // Extra damage on heads (e.g., Electabuzz Thunder Punch +10 on heads)
    if (effect.coinFlip.onHeads === "damage" && effect.amount && headsCount > 0) {
      const extraDamage = effect.amount * headsCount;
      const target = effect.target === "self"
        ? (isPlayer1 ? newState.playerActivePokemon : newState.opponentActivePokemon)
        : (isPlayer1 ? newState.opponentActivePokemon : newState.playerActivePokemon);
      if (target) {
        const updatedTarget = { ...target, currentDamage: (target.currentDamage || 0) + extraDamage };
        if (effect.target === "self") {
          if (isPlayer1) { newState = { ...newState, playerActivePokemon: updatedTarget }; }
          else { newState = { ...newState, opponentActivePokemon: updatedTarget }; }
        } else {
          if (isPlayer1) { newState = { ...newState, opponentActivePokemon: updatedTarget }; }
          else { newState = { ...newState, playerActivePokemon: updatedTarget }; }
        }
        newState = {
          ...newState,
          events: [...newState.events, createGameEvent(`${target.pokemon.name} recibió +${extraDamage} de daño bonus`, "action")],
        };
        console.log(`[coinFlip] Applied ${extraDamage} extra damage (${headsCount} heads)`);
      }
    }

    // Self-damage on tails (e.g., Electabuzz Thunder Punch 10 self-damage on tails)
    if (effect.coinFlip.onTails === "damage" && effect.amount && tailsCount > 0) {
      const selfDamage = effect.amount * tailsCount;
      const attacker = isPlayer1 ? newState.playerActivePokemon : newState.opponentActivePokemon;
      if (attacker) {
        const updatedAttacker = { ...attacker, currentDamage: (attacker.currentDamage || 0) + selfDamage };
        if (isPlayer1) { newState = { ...newState, playerActivePokemon: updatedAttacker }; }
        else { newState = { ...newState, opponentActivePokemon: updatedAttacker }; }
        newState = {
          ...newState,
          events: [...newState.events, createGameEvent(`${attacker.pokemon.name} se hizo ${selfDamage} de daño a sí mismo`, "action")],
        };
        console.log(`[coinFlip] Applied ${selfDamage} self-damage (${tailsCount} tails)`);
      }
    }

    // Protection on heads (e.g., Chansey's Scrunch, threshold protection)
    if (effect.type === AttackEffectType.Protection && effect.coinFlip.onHeads === "protection" && headsCount > 0) {
      const attacker = isPlayer1 ? newState.playerActivePokemon : newState.opponentActivePokemon;
      if (attacker) {
        const protType = effect.protectionType || "damageAndEffects";
        const updatedAttacker: PokemonInPlay = {
          ...attacker,
          protection: {
            type: protType as "damageOnly" | "damageAndEffects",
            expiresAfterTurn: newState.turnNumber + 1,
            ...(effect.amount !== undefined && { threshold: effect.amount }),
          },
        };
        if (isPlayer1) { newState = { ...newState, playerActivePokemon: updatedAttacker }; }
        else { newState = { ...newState, opponentActivePokemon: updatedAttacker }; }
        newState = {
          ...newState,
          events: [...newState.events, createGameEvent(`¡${attacker.pokemon.name} se protegió! El daño será prevenido durante el próximo turno del rival.`, "action")],
        };
        console.log(`[coinFlip] Applied protection (${protType}${effect.amount ? `, threshold: ${effect.amount}` : ""})`);
      }
    }

    // Prevent Retreat on heads (e.g., Victreebel's Acid)
    if (effect.coinFlip.onHeads === "preventRetreat" && headsCount > 0) {
      const defender = isPlayer1 ? newState.opponentActivePokemon : newState.playerActivePokemon;
      if (defender) {
        const updatedDefender = { ...defender, retreatPrevented: true, retreatPreventedOnTurn: newState.turnNumber };
        if (isPlayer1) { newState = { ...newState, opponentActivePokemon: updatedDefender }; }
        else { newState = { ...newState, playerActivePokemon: updatedDefender }; }
        newState = {
          ...newState,
          events: [...newState.events, createGameEvent(`¡${defender.pokemon.name} no puede retirarse durante el próximo turno!`, "action")],
        };
        console.log(`[coinFlip] Applied preventRetreat to defender`);
      }
    }
  }

  return newState;
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
   * Execute a player action
   */
  async executeAction(
    roomId: string,
    socketId: string,
    action: PlayerAction
  ): Promise<ActionResult> {
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
    const turnFreeActions = ["ready", "mulligan", "playerReady", "takePrize", "promote", "deckSearch", "forceSwitch", "selfSwitch", "skipSwitch", "benchDamage", "clearPeek", "surrender"];
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
    let usedExecuteForPlayer = false;

    // Helper to get the correct fields based on which player is acting
    // The game state is stored in player1's perspective
    // For player1: "player" fields, for player2: "opponent" fields
    const getHand = () => isPlayer1 ? room.gameState!.playerHand : room.gameState!.opponentHand;
    const getActive = () => isPlayer1 ? room.gameState!.playerActivePokemon : room.gameState!.opponentActivePokemon;
    const getBench = () => isPlayer1 ? room.gameState!.playerBench : room.gameState!.opponentBench;

    // Helper to swap state perspective for player2
    // Game-core functions always operate on "player" side, so for player2 we swap before and after
    const swapPerspective = (state: GameState): GameState => ({
      ...state,
      playerActivePokemon: state.opponentActivePokemon,
      playerBench: state.opponentBench,
      playerHand: state.opponentHand,
      playerDeck: state.opponentDeck,
      playerDiscard: state.opponentDiscard,
      playerPrizes: state.opponentPrizes,
      playerReady: state.opponentReady,
      playerCanTakePrize: state.opponentCanTakePrize,
      playerNeedsToPromote: state.opponentNeedsToPromote,
      opponentActivePokemon: state.playerActivePokemon,
      opponentBench: state.playerBench,
      opponentHand: state.playerHand,
      opponentDeck: state.playerDeck,
      opponentDiscard: state.playerDiscard,
      opponentPrizes: state.playerPrizes,
      opponentReady: state.playerReady,
      opponentCanTakePrize: state.playerCanTakePrize,
      opponentNeedsToPromote: state.playerNeedsToPromote,
      isPlayerTurn: !state.isPlayerTurn,
      // Swap game result perspective so it stays correct after double-swap
      gameResult: state.gameResult === "victory" ? "defeat"
        : state.gameResult === "defeat" ? "victory"
        : state.gameResult,
    });

    // For game-core functions: swap perspective for player2, call function, swap back
    const executeForPlayer = (fn: (state: GameState) => GameState): GameState => {
      if (isPlayer1) {
        return fn(room.gameState!);
      } else {
        const swapped = swapPerspective(room.gameState!);
        const result = fn(swapped);
        return swapPerspective(result);
      }
    };

    try {
      let newState = room.gameState;

      switch (action.type) {
        case "attack": {
          const attackIndex = action.payload.attackIndex as number;

          // ── Porygon Conversion 1 / Conversion 2 ──
          const conversionType = action.payload.conversionType as EnergyType | undefined;
          const conversionEffect = action.payload.conversionEffect as "changeWeakness" | "changeResistance" | undefined;

          if (conversionType && conversionEffect) {
            usedExecuteForPlayer = true;
            newState = executeForPlayer((state) => {
              const attacker = state.playerActivePokemon;
              if (!attacker || !isPokemonCard(attacker.pokemon)) return state;
              const attack = attacker.pokemon.attacks[attackIndex];
              if (!attack) return state;

              let updatedState = { ...state };

              if (conversionEffect === "changeWeakness") {
                const defender = updatedState.opponentActivePokemon;
                if (defender) {
                  updatedState = {
                    ...updatedState,
                    opponentActivePokemon: { ...defender, modifiedWeakness: conversionType },
                    events: [
                      ...updatedState.events,
                      createGameEvent(`${attacker.pokemon.name} usó ${attack.name}`, "action"),
                      createGameEvent(`La debilidad de ${defender.pokemon.name} cambió a ${conversionType}`, "action"),
                    ],
                  };
                }
              } else {
                updatedState = {
                  ...updatedState,
                  playerActivePokemon: { ...attacker, modifiedResistance: conversionType },
                  events: [
                    ...updatedState.events,
                    createGameEvent(`${attacker.pokemon.name} usó ${attack.name}`, "action"),
                    createGameEvent(`La resistencia de ${attacker.pokemon.name} cambió a ${conversionType}`, "action"),
                  ],
                };
              }

              return endTurn(updatedState, true);
            });
            break;
          }

          const metronomePayload = action.payload.metronomeAttack as { name: string; index: number } | undefined;

          // Determine which attack to check for coin flips
          const activePokemon = isPlayer1 ? room.gameState!.playerActivePokemon : room.gameState!.opponentActivePokemon;
          let coinFlipInfo: { attackName: string; results: Array<"heads" | "tails"> } | null = null;
          let coinFlipEffects: AttackEffect[] = [];

          if (metronomePayload) {
            // ── Metronome: find the copied attack from opponent's active Pokemon ──
            const opponentActive = isPlayer1 ? room.gameState!.opponentActivePokemon : room.gameState!.playerActivePokemon;
            if (!opponentActive || !isPokemonCard(opponentActive.pokemon)) {
              return { success: false, error: "Opponent has no active Pokemon to copy attack from" };
            }
            const copiedAttack: Attack | undefined = opponentActive.pokemon.attacks[metronomePayload.index];
            if (!copiedAttack) {
              return { success: false, error: "Copied attack not found on opponent's active Pokemon" };
            }

            console.log(`[attack] Metronome copying ${copiedAttack.name} from opponent's ${opponentActive.pokemon.name}`);

            // Check coin flip effects on the COPIED attack (not the original Metronome)
            coinFlipEffects = (copiedAttack.effects || []).filter(e => e.coinFlip);
            if (coinFlipEffects.length > 0) {
              const count = coinFlipEffects[0].coinFlip!.count;
              const results: Array<"heads" | "tails"> = [];
              for (let i = 0; i < count; i++) {
                results.push(Math.random() < 0.5 ? "heads" : "tails");
              }
              coinFlipInfo = { attackName: copiedAttack.name, results };
              console.log(`[attack] Metronome coin flip for ${copiedAttack.name}: ${results.join(", ")}`);
            }

            // Insert coin result event BEFORE executeMetronome
            if (coinFlipInfo) {
              const coinTokens = coinFlipInfo.results.map(r => `[coin:${r}]`).join(" ");
              const coinResultText = coinFlipInfo.results.length === 1 ? `Moneda: ${coinTokens}` : `Monedas: ${coinTokens}`;
              room.gameState = {
                ...room.gameState,
                events: [...room.gameState.events, createGameEvent(coinResultText, "info")],
              };
            }

            // Execute Metronome via game-core
            // If the copied attack has coin flip effects, skip endTurn so we can apply them first
            const metronomeHasCoinEffects = coinFlipInfo && coinFlipEffects.length > 0;
            usedExecuteForPlayer = true;
            newState = executeForPlayer((state) => executeMetronome(state, copiedAttack, !!metronomeHasCoinEffects, true));
          } else {
            // ── Normal attack ──
            if (activePokemon && isPokemonCard(activePokemon.pokemon)) {
              const attack = activePokemon.pokemon.attacks[attackIndex];
              if (attack) {
                coinFlipEffects = (attack.effects || []).filter(e => e.coinFlip);
                if (coinFlipEffects.length > 0) {
                  const count = coinFlipEffects[0].coinFlip!.count;
                  const results: Array<"heads" | "tails"> = [];
                  for (let i = 0; i < count; i++) {
                    results.push(Math.random() < 0.5 ? "heads" : "tails");
                  }
                  coinFlipInfo = { attackName: attack.name, results };
                  console.log(`[attack] Coin flip for ${attack.name}: ${results.join(", ")}`);
                }
              }
            }

            // Insert coin result event BEFORE executeAttack so it appears before damage/KO events
            if (coinFlipInfo) {
              const coinTokens = coinFlipInfo.results.map(r => `[coin:${r}]`).join(" ");
              const coinResultText = coinFlipInfo.results.length === 1 ? `Moneda: ${coinTokens}` : `Monedas: ${coinTokens}`;
              room.gameState = {
                ...room.gameState,
                events: [...room.gameState.events, createGameEvent(coinResultText, "info")],
              };
            }

            // If there are coin flip effects, skip endTurn so we can apply effects first
            // (e.g., Venomoth's Venom Powder applies Poisoned via coin flip — poison damage
            //  must be dealt during endTurn AFTER the status is applied)
            const hasCoinEffects = coinFlipInfo && coinFlipEffects.length > 0;
            usedExecuteForPlayer = true;
            newState = executeForPlayer((state) => executeAttack(state, attackIndex, !!hasCoinEffects, true));
          }

          // Apply coin flip effects (status, extra damage, protection) — skip re-logging coin result
          if (coinFlipInfo && coinFlipEffects.length > 0) {
            newState = applyCoinFlipEffects(newState, coinFlipInfo.results, coinFlipEffects, isPlayer1, true);
            console.log(`[attack] Applied coin flip effects for ${coinFlipInfo.attackName}`);

            // Now call endTurn since we skipped it during executeAttack.
            // Only if the game isn't already over (e.g., the attack KO'd the last opponent Pokemon).
            // NOTE: We can't use executeForPlayer() here because it reads from room.gameState
            // which hasn't been updated yet. We swap perspective manually using newState.
            if (newState.gamePhase !== "GAME_OVER") {
              if (isPlayer1) {
                newState = endTurn(newState);
              } else {
                newState = swapPerspective(endTurn(swapPerspective(newState)));
              }
            }
          }

          // Return coin flip info for handlers to broadcast to both players
          if (coinFlipInfo) {
            // Neutralize events before early return
            const selfName = isPlayer1 ? "Jugador 1" : "Jugador 2";
            const opponentName = isPlayer1 ? "Jugador 2" : "Jugador 1";
            newState = { ...newState, events: neutralizeEvents(newState.events, eventCountBefore, selfName, opponentName) };
            room.gameState = newState;

            // Check for game over
            const gameOver = newState.gamePhase === "GAME_OVER";
            let winner: "player1" | "player2" | undefined;
            let winReason: string | undefined;

            if (gameOver) {
              room.status = "finished";
              winner = newState.gameResult === "victory" ? "player1" : "player2";
              winReason = newState.gameResult === "victory" ? "Player 1 wins!" : "Player 2 wins!";
            }

            return {
              success: true,
              gameState: room.gameState,
              gameOver,
              winner,
              winReason,
              coinFlipInfo,
            };
          }
          break;
        }

        case "endTurn":
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => endTurn(state, true));
          break;

        case "retreat": {
          const energyIds = action.payload.energyIdsToDiscard as string[];
          const benchIdx = action.payload.benchIndex as number;
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => executeRetreat(state, energyIds, benchIdx));
          break;
        }

        case "playBasicToActive": {
          const cardId = action.payload.cardId as string;
          const hand = getHand();
          const active = getActive();
          console.log(`[playBasicToActive] Looking for card ${cardId} in hand (${hand.length} cards)`);
          console.log(`[playBasicToActive] Hand card IDs:`, hand.map(c => c.id));
          const card = hand.find((c) => c.id === cardId);
          if (!card) {
            console.log(`[playBasicToActive] Card not found in hand!`);
            return { success: false, error: "Card not found in hand" };
          }
          if (!isPokemonCard(card) || card.stage !== "basic") {
            console.log(`[playBasicToActive] Card is not a basic Pokemon: kind=${card.kind}, stage=${(card as any).stage}`);
            return { success: false, error: "Invalid card for active slot" };
          }
          if (active) {
            console.log(`[playBasicToActive] Active slot already occupied`);
            return { success: false, error: "Active slot already occupied" };
          }
          console.log(`[playBasicToActive] Placing ${card.name} as active for ${isPlayer1 ? 'P1' : 'P2'}`);
          const effectiveTurn = room.gameState.turnNumber <= 0 ? 0 : room.gameState.turnNumber;
          const newPokemon: PokemonInPlay = {
            pokemon: card,
            attachedEnergy: [],
            attachedTrainers: [],
            previousEvolutions: [],
            currentDamage: 0,
            playedOnTurn: effectiveTurn,
          };
          const newHand = hand.filter((c) => c.id !== cardId);

          if (isPlayer1) {
            newState = {
              ...room.gameState,
              playerHand: newHand,
              playerActivePokemon: newPokemon,
              events: [...room.gameState.events, createGameEvent(`${card.name} entra como activo`, "action")],
            };
          } else {
            newState = {
              ...room.gameState,
              opponentHand: newHand,
              opponentActivePokemon: newPokemon,
              events: [...room.gameState.events, createGameEvent(`${card.name} entra como activo (rival)`, "action")],
            };
          }
          break;
        }

        case "playBasicToBench": {
          const cardId = action.payload.cardId as string;
          const benchIndex = action.payload.benchIndex as number;
          if (benchIndex < 0 || benchIndex >= 5) {
            return { success: false, error: "Invalid bench index" };
          }
          const hand = getHand();
          const bench = getBench();
          const active = getActive();
          // Cannot place on bench without an active Pokemon
          if (!active) {
            return { success: false, error: "Must place active Pokemon first" };
          }
          if (bench[benchIndex]) {
            return { success: false, error: "Bench slot already occupied" };
          }
          const card = hand.find((c) => c.id === cardId);
          if (!card || !isPokemonCard(card) || card.stage !== "basic") {
            return { success: false, error: "Invalid card for bench" };
          }
          const effectiveTurn = room.gameState.turnNumber <= 0 ? 0 : room.gameState.turnNumber;
          const newBench = [...bench];
          newBench[benchIndex] = {
            pokemon: card,
            attachedEnergy: [],
            attachedTrainers: [],
            previousEvolutions: [],
            currentDamage: 0,
            playedOnTurn: effectiveTurn,
          };
          const newHand = hand.filter((c) => c.id !== cardId);

          if (isPlayer1) {
            newState = {
              ...room.gameState,
              playerHand: newHand,
              playerBench: newBench,
              events: [...room.gameState.events, createGameEvent(`${card.name} va a la banca`, "action")],
            };
          } else {
            newState = {
              ...room.gameState,
              opponentHand: newHand,
              opponentBench: newBench,
              events: [...room.gameState.events, createGameEvent(`${card.name} va a la banca (rival)`, "action")],
            };
          }
          break;
        }

        case "attachEnergy": {
          const cardId = action.payload.cardId as string;
          const pokemonId = action.payload.pokemonId as string;
          const isBench = action.payload.isBench as boolean;
          const benchIndex = action.payload.benchIndex as number | undefined;

          if (room.gameState.gamePhase !== "PLAYING") {
            return { success: false, error: "Cannot attach energy during setup" };
          }

          const hand = getHand();
          const bench = getBench();
          const active = getActive();
          const energyCard = hand.find((c) => c.id === cardId);
          if (!energyCard || !isEnergyCard(energyCard)) {
            return { success: false, error: "Invalid energy card" };
          }

          // Find target Pokemon
          let targetPokemon: PokemonInPlay | null = null;
          if (isBench && benchIndex !== undefined) {
            targetPokemon = bench[benchIndex];
            if (!targetPokemon || targetPokemon.pokemon.id !== pokemonId) {
              return { success: false, error: "Target pokemon not found" };
            }
          } else {
            if (!active || active.pokemon.id !== pokemonId) {
              return { success: false, error: "Target pokemon not found" };
            }
            targetPokemon = active;
          }

          // Check if Rain Dance applies (Water energy to Water Pokemon with Blastoise available)
          // Use swapped perspective for player2
          const stateForCheck = isPlayer1 ? room.gameState : swapPerspective(room.gameState);
          const { canUse: hasRainDance, pokemonWithPower } = canUseRainDance(stateForCheck, "player");

          let useRainDance = false;
          if (hasRainDance && pokemonWithPower.length > 0) {
            const power = isPokemonCard(pokemonWithPower[0].pokemon)
              ? pokemonWithPower[0].pokemon.power
              : null;
            if (power) {
              const attachError = canAttachWithPower(power, targetPokemon, energyCard);
              if (!attachError) {
                useRainDance = true;
                console.log(`[attachEnergy] Using Rain Dance for ${energyCard.energyType} energy to ${targetPokemon.pokemon.name}`);
              }
            }
          }

          // If not using Rain Dance, check normal energy limit
          if (!useRainDance && room.gameState.energyAttachedThisTurn) {
            return { success: false, error: "Already attached energy this turn" };
          }

          const newHand = hand.filter((c) => c.id !== cardId);
          const energyName = getEnergyTypeInSpanish(energyCard.energyType);
          const selfName = isPlayer1 ? "Jugador 1" : "Jugador 2";
          const eventMsg = useRainDance
            ? `Rain Dance: ${selfName} adjuntó energía ${energyName} a ${targetPokemon.pokemon.name}`
            : `${selfName} adjuntó energía ${energyName} a ${targetPokemon.pokemon.name}`;

          // Only set energyAttachedThisTurn if NOT using Rain Dance
          const shouldSetEnergyFlag = !useRainDance;

          if (isBench && benchIndex !== undefined) {
            const newBench = [...bench];
            newBench[benchIndex] = {
              ...targetPokemon,
              attachedEnergy: [...targetPokemon.attachedEnergy, energyCard],
            };
            if (isPlayer1) {
              newState = {
                ...room.gameState,
                playerHand: newHand,
                playerBench: newBench,
                energyAttachedThisTurn: shouldSetEnergyFlag ? true : room.gameState.energyAttachedThisTurn,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            } else {
              newState = {
                ...room.gameState,
                opponentHand: newHand,
                opponentBench: newBench,
                energyAttachedThisTurn: shouldSetEnergyFlag ? true : room.gameState.energyAttachedThisTurn,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            }
          } else {
            const updatedActive = {
              ...targetPokemon,
              attachedEnergy: [...targetPokemon.attachedEnergy, energyCard],
            };
            if (isPlayer1) {
              newState = {
                ...room.gameState,
                playerHand: newHand,
                playerActivePokemon: updatedActive,
                energyAttachedThisTurn: shouldSetEnergyFlag ? true : room.gameState.energyAttachedThisTurn,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            } else {
              newState = {
                ...room.gameState,
                opponentHand: newHand,
                opponentActivePokemon: updatedActive,
                energyAttachedThisTurn: shouldSetEnergyFlag ? true : room.gameState.energyAttachedThisTurn,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            }
          }
          break;
        }

        case "evolve": {
          const cardId = action.payload.cardId as string;
          const targetIndex = action.payload.targetIndex as number;
          const hand = getHand();
          const bench = getBench();
          const active = getActive();
          const evolutionCard = hand.find((c) => c.id === cardId);
          if (!evolutionCard || !isPokemonCard(evolutionCard)) {
            return { success: false, error: "Invalid evolution card" };
          }
          if (evolutionCard.stage !== "stage-1" && evolutionCard.stage !== "stage-2") {
            return { success: false, error: "Card is not an evolution" };
          }

          let targetPokemon: PokemonInPlay | null = null;
          if (targetIndex === -1) {
            targetPokemon = active;
          } else if (targetIndex >= 0 && targetIndex < bench.length) {
            targetPokemon = bench[targetIndex];
          }

          if (!targetPokemon) {
            return { success: false, error: "Target pokemon not found" };
          }
          if (!canEvolveInto(evolutionCard, targetPokemon.pokemon)) {
            return { success: false, error: "Invalid evolution target" };
          }
          // Cannot evolve on turn 1 or same turn Pokemon was played
          if (room.gameState.turnNumber === 1 || targetPokemon.playedOnTurn === room.gameState.turnNumber) {
            return { success: false, error: "Cannot evolve this turn" };
          }

          const evolvedPokemon: PokemonInPlay = {
            ...targetPokemon,
            pokemon: evolutionCard,
            previousEvolutions: [...(targetPokemon.previousEvolutions || []), targetPokemon.pokemon],
            statusConditions: [], // Clear status on evolution
            playedOnTurn: room.gameState.turnNumber,
          };
          const newHand = hand.filter((c) => c.id !== cardId);
          const eventMsg = `${targetPokemon.pokemon.name} evolucionó a ${evolutionCard.name}`;

          if (targetIndex === -1) {
            if (isPlayer1) {
              newState = {
                ...room.gameState,
                playerHand: newHand,
                playerActivePokemon: evolvedPokemon,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            } else {
              newState = {
                ...room.gameState,
                opponentHand: newHand,
                opponentActivePokemon: evolvedPokemon,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            }
          } else {
            const newBench = [...bench];
            newBench[targetIndex] = evolvedPokemon;
            if (isPlayer1) {
              newState = {
                ...room.gameState,
                playerHand: newHand,
                playerBench: newBench,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            } else {
              newState = {
                ...room.gameState,
                opponentHand: newHand,
                opponentBench: newBench,
                events: [...room.gameState.events, createGameEvent(eventMsg, "action")],
              };
            }
          }
          break;
        }

        case "takePrize": {
          const prizeIndex = action.payload.prizeIndex as number;
          const canTake = isPlayer1 ? room.gameState.playerCanTakePrize : room.gameState.opponentCanTakePrize;
          if (!canTake) {
            return { success: false, error: "Cannot take a prize now" };
          }
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => takePrize(state, prizeIndex, true));
          break;
        }

        case "promote": {
          const benchIndex = action.payload.benchIndex as number;
          const needsPromote = isPlayer1 ? room.gameState.playerNeedsToPromote : room.gameState.opponentNeedsToPromote;
          if (!needsPromote) {
            return { success: false, error: "No promotion needed" };
          }
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => promoteActivePokemon(state, benchIndex));

          // After opponent promotes their new active Pokemon, end the attacker's turn.
          // The attacker is the OTHER player (the one who KO'd the defender).
          // endTurn was skipped inside executeAttack because opponentNeedsToPromote was set,
          // so we must call it now that the promotion is complete.
          // Only proceed if both actives are present and game can continue.
          if (
            newState.gamePhase !== "GAME_OVER" &&
            newState.playerActivePokemon !== null &&
            newState.opponentActivePokemon !== null &&
            !newState.playerCanTakePrize &&
            !newState.opponentCanTakePrize
          ) {
            // The promoter is `isPlayer1`. The attacker is the opposite player.
            // We need endTurn from the ATTACKER's perspective.
            const attackerIsPlayer1 = !isPlayer1;
            if (attackerIsPlayer1) {
              // Attacker is player1: state is already in player1 perspective
              newState = endTurn(newState);
            } else {
              // Attacker is player2: swap → endTurn → swap back
              newState = swapPerspective(endTurn(swapPerspective(newState)));
            }
          }
          break;
        }

        case "deckSearch": {
          const selectedCardId = action.payload.cardId as string | null;
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => executeDeckSearch(state, selectedCardId));
          break;
        }

        case "forceSwitch": {
          const benchIndex = action.payload.benchIndex as number;
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => applyForceSwitch(state, benchIndex));
          break;
        }

        case "selfSwitch": {
          const benchIndex = action.payload.benchIndex as number;
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => applySelfSwitch(state, benchIndex));
          break;
        }

        case "skipSwitch": {
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => skipPendingSwitch(state));
          break;
        }

        case "benchDamage": {
          const selectedPokemonIds = action.payload.selectedPokemonIds as string[];
          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => executeBenchDamage(state, selectedPokemonIds));
          break;
        }

        case "clearPeek": {
          usedExecuteForPlayer = true;
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
          console.log(`[playerReady] ${isPlayer1 ? 'P1' : 'P2'} clicked ready`);
          console.log(`[playerReady] Before: playerReady=${room.gameState.playerReady}, opponentReady=${room.gameState.opponentReady}, phase=${room.gameState.gamePhase}`);

          newState = setPlayerReady(room.gameState, isPlayer1);

          console.log(`[playerReady] After setPlayerReady: playerReady=${newState.playerReady}, opponentReady=${newState.opponentReady}`);

          // Check if both players are ready to start the game
          const p1Ready = isPlayer1 ? true : newState.playerReady;
          const p2Ready = isPlayer1 ? newState.opponentReady : true;

          console.log(`[playerReady] Check: p1Ready=${p1Ready}, p2Ready=${p2Ready}, phase=${newState.gamePhase}`);

          if (p1Ready && p2Ready && newState.gamePhase === "MULLIGAN") {
            // Both players ready - cancel setup timer and start game
            this.cancelSetupTimer(roomId);
            const coinFlipResult = Math.random() < 0.5 ? "heads" : "tails";
            console.log(`[playerReady] Both players ready! Coin flip: ${coinFlipResult}`);
            newState = startPlayingPhase(newState, coinFlipResult);
            console.log(`[playerReady] Game started! New phase: ${newState.gamePhase}`);
          } else if ((p1Ready || p2Ready) && !(p1Ready && p2Ready)) {
            // Only one player is ready — start setup timer for the opponent
            this.startSetupTimer(roomId, isPlayer1 ? "player1" : "player2");
          }
          break;
        }

        case "usePower": {
          const powerType = action.payload.powerType as string;
          const pokemonId = action.payload.pokemonId as string;

          console.log(`[usePower] ${isPlayer1 ? 'P1' : 'P2'} using ${powerType}`);

          const executePower = (state: GameState): GameState => {
            const side: "player" | "opponent" = "player";

            switch (powerType) {
              case "rainDance": {
                const energyCardId = action.payload.energyCardId as string;
                const targetPokemonId = action.payload.targetPokemonId as string;
                return attachEnergyWithRainDance(state, side, energyCardId, targetPokemonId);
              }
              case "energyTrans": {
                const sourcePokemonId = action.payload.sourcePokemonId as string;
                const targetPokemonId = action.payload.targetPokemonId as string;
                const energyCardId = action.payload.energyCardId as string;
                return moveEnergyWithEnergyTrans(state, side, sourcePokemonId, targetPokemonId, energyCardId);
              }
              case "damageSwap": {
                const sourcePokemonId = action.payload.sourcePokemonId as string;
                const targetPokemonId = action.payload.targetPokemonId as string;
                const amount = action.payload.amount as number;
                return moveDamageWithDamageSwap(state, side, sourcePokemonId, targetPokemonId, amount);
              }
              case "energyBurn": {
                const ebPokemonId = action.payload.pokemonId as string | undefined;
                return activateEnergyBurn(state, side, ebPokemonId);
              }
              case "buzzap": {
                const electrodePokemonId = action.payload.electrodePokemonId as string;
                const chosenEnergyType = action.payload.chosenEnergyType as EnergyType;
                const targetPokemonId = action.payload.targetPokemonId as string;
                return executeBuzzap(state, side, electrodePokemonId, chosenEnergyType, targetPokemonId);
              }
              case "healFlip": {
                const targetPokemonId = action.payload.targetPokemonId as string;
                const coinResult = action.payload.coinResult as string | undefined;
                if (coinResult === "tails" || targetPokemonId === "__none__") {
                  // Tails: mark power as used without healing
                  const usedPowersThisTurn = [...(state.usedPowersThisTurn || []), pokemonId];
                  return {
                    ...state,
                    usedPowersThisTurn,
                    events: [...state.events, createGameEvent("Moneda: [coin:tails] — Heal falló", "info")],
                  };
                }
                return executeHealFlip(state, targetPokemonId, side, pokemonId);
              }
              case "typeShift": {
                const chosenType = action.payload.chosenType as EnergyType;
                const initiated = initiateShift(state, side, pokemonId);
                return executeShift(initiated, side, chosenType);
              }
              case "peek": {
                const peekType = action.payload.peekType as "playerDeck" | "opponentDeck" | "opponentHand" | "playerPrize" | "opponentPrize";
                return executePeek(state, side, pokemonId, peekType);
              }
              case "clearPeek": {
                return clearPendingPeek(state);
              }
              default:
                console.log(`[usePower] Unknown power type: ${powerType}`);
                return {
                  ...state,
                  events: [...state.events, createGameEvent(`Poder ${powerType} no implementado`, "info")]
                };
            }
          };

          usedExecuteForPlayer = true;
          newState = executeForPlayer(executePower);
          break;
        }

        case "playTrainer": {
          const cardId = action.payload.cardId as string;
          const trainerName = action.payload.trainerName as string;
          const selections = action.payload.selections as string[][] || [];
          const coinResult = action.payload.coinResult as string | undefined;

          console.log(`[playTrainer] ${isPlayer1 ? 'P1' : 'P2'} playing ${trainerName}`);

          // Helper to find bench index by Pokemon ID
          const findBenchIndex = (pokemonId: string, bench: (PokemonInPlay | null)[]): number => {
            return bench.findIndex(p => p?.pokemon.id === pokemonId);
          };

          // Helper to find target index (active = -1, bench = 0+)
          const findTargetIndex = (pokemonId: string, active: PokemonInPlay | null, bench: (PokemonInPlay | null)[]): number => {
            if (active?.pokemon.id === pokemonId) return -1;
            const benchIdx = findBenchIndex(pokemonId, bench);
            return benchIdx !== -1 ? benchIdx : -1;
          };

          // Execute trainer based on name, using selections for parameters
          const executeTrainer = (state: GameState): GameState => {
            switch (trainerName) {
              case "Bill":
                return playBill(state, cardId);
              case "Professor Oak":
                return playProfessorOak(state, cardId);
              case "PlusPower":
                return playPlusPower(state, cardId);
              case "Lass":
                return playLass(state, cardId);
              case "Full Heal":
                return playFullHeal(state, cardId);
              case "Imposter Professor Oak":
                return playImposterProfessorOak(state, cardId);
              case "Pokémon Center":
                return playPokemonCenter(state, cardId);
              case "Switch": {
                // selections[0][0] = pokemon id from bench
                const pokemonId = selections[0]?.[0] || "";
                const benchIndex = findBenchIndex(pokemonId, state.playerBench);
                return playSwitch(state, cardId, benchIndex);
              }
              case "Gust of Wind": {
                // selections[0][0] = pokemon id from opponent bench
                const pokemonId = selections[0]?.[0] || "";
                const benchIndex = findBenchIndex(pokemonId, state.opponentBench);
                return playGustOfWind(state, cardId, benchIndex);
              }
              case "Potion":
                // selections[0][0] = target pokemon id
                return playPotion(state, cardId, selections[0]?.[0] || "");
              case "Defender":
                // selections[0][0] = target pokemon id
                return playDefender(state, cardId, selections[0]?.[0] || "");
              case "Super Potion":
                // selections[0][0] = target pokemon id, selections[1][0] = energy id
                return playSuperPotion(state, cardId, selections[0]?.[0] || "", selections[1]?.[0] || "");
              case "Energy Removal":
                // selections[0][0] = energy id from opponent active
                return playEnergyRemoval(state, cardId, selections[0]?.[0] || "");
              case "Super Energy Removal":
                // selections[0][0] = own pokemon id, selections[1][0] = own energy id
                // selections[2][0] = opponent pokemon id, selections[3] = opponent energy ids
                return playSuperEnergyRemoval(
                  state, cardId,
                  selections[0]?.[0] || "", selections[1]?.[0] || "",
                  selections[2]?.[0] || "", selections[3] || []
                );
              case "Energy Retrieval":
                // selections[0][0] = card to discard, selections[1] = energy ids from discard
                return playEnergyRetrieval(state, cardId, selections[0]?.[0] || "", selections[1] || []);
              case "Maintenance":
                // selections[0] = 2 card ids to return to deck
                return playMaintenance(state, cardId, selections[0] || []);
              case "Computer Search":
                // selections[0] = 2 card ids to discard, selections[1][0] = deck card id
                return playComputerSearch(state, cardId, selections[0] || [], selections[1]?.[0] || "");
              case "Item Finder":
                // selections[0] = 2 card ids to discard, selections[1][0] = trainer id from discard
                return playItemFinder(state, cardId, selections[0] || [], selections[1]?.[0] || "");
              case "Pokémon Breeder": {
                // selections[0][0] = stage 2 card id, selections[1][0] = target pokemon id
                const stage2Id = selections[0]?.[0] || "";
                const targetPokemonId = selections[1]?.[0] || "";
                const targetIndex = findTargetIndex(targetPokemonId, state.playerActivePokemon, state.playerBench);
                console.log(`[Breeder] stage2Id=${stage2Id}, targetPokemonId=${targetPokemonId}, targetIndex=${targetIndex}`);
                return playPokemonBreeder(state, cardId, stage2Id, targetIndex);
              }
              case "Pokémon Trader":
                // selections[0][0] = hand pokemon id, selections[1][0] = deck pokemon id
                return playPokemonTrader(state, cardId, selections[0]?.[0] || "", selections[1]?.[0] || "");
              case "Scoop Up": {
                // selections[0][0] = target pokemon id
                const targetPokemonId = selections[0]?.[0] || "";
                const targetIndex = findTargetIndex(targetPokemonId, state.playerActivePokemon, state.playerBench);
                return playScoopUp(state, cardId, targetIndex);
              }
              case "Poké Ball": {
                const isHeads = coinResult === "heads";
                const selectedCardId = selections[0]?.[0] ?? null;
                return playPokeBall(state, cardId, selectedCardId, isHeads);
              }
              case "Devolution Spray": {
                const pokemonId = selections[0]?.[0] || "";
                const targetIndex = findTargetIndex(pokemonId, state.playerActivePokemon, state.playerBench);
                return playDevolutionSpray(state, cardId, targetIndex);
              }
              case "Pokédex": {
                // selections[0] contains the new order as string indices
                const newOrder = (selections[0] || []).map(s => parseInt(s, 10));
                return playPokedex(state, cardId, newOrder);
              }
              default:
                console.log(`[playTrainer] Unknown trainer: ${trainerName}`);
                return {
                  ...state,
                  events: [...state.events, createGameEvent(`${trainerName} no implementado`, "info")]
                };
            }
          };

          usedExecuteForPlayer = true;
          newState = executeForPlayer(executeTrainer);
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

        default:
          return { success: false, error: `Unknown action type: ${action.type}` };
      }

      // Neutralize perspective-specific events for multiplayer
      {
        const selfName = usedExecuteForPlayer
          ? (isPlayer1 ? "Jugador 1" : "Jugador 2")
          : "Jugador 1";
        const opponentName = usedExecuteForPlayer
          ? (isPlayer1 ? "Jugador 2" : "Jugador 1")
          : "Jugador 2";
        newState = {
          ...newState,
          events: neutralizeEvents(newState.events, eventCountBefore, selfName, opponentName),
        };
      }

      room.gameState = newState;

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
        ...(setupTimerStarted ? { setupTimerStarted } : {}),
      };
    } catch (error) {
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
