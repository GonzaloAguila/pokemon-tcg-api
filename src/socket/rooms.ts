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
  GamePhase,
  initializeMultiplayerGame,
  startGame,
  shuffle,
  executeAttack,
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
  // Powers
  attachEnergyWithRainDance,
  moveEnergyWithEnergyTrans,
  moveDamageWithDamageSwap,
  activateEnergyBurn,
  executeBuzzap,
  canUseRainDance,
  canAttachWithPower,
} from "@poke-tcg/game-core";

interface PlayerAction {
  type: string;
  payload: Record<string, unknown>;
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
}

/**
 * Apply coin flip effects that executeAttack skips.
 * executeAttack skips all effects with coinFlip property, expecting the caller to handle them.
 */
function applyCoinFlipEffects(
  state: GameState,
  results: Array<"heads" | "tails">,
  effects: AttackEffect[],
  isPlayer1: boolean
): GameState {
  let newState = state;
  const headsCount = results.filter(r => r === "heads").length;
  const tailsCount = results.filter(r => r === "tails").length;

  for (const effect of effects) {
    if (!effect.coinFlip) continue;

    // ApplyStatus on heads (e.g., Magnemite's Thundershock -> Paralyze)
    if (effect.type === AttackEffectType.ApplyStatus && effect.status && effect.coinFlip.onHeads && headsCount > 0) {
      // Status conditions from attacks apply to the defender
      const defender = isPlayer1 ? newState.opponentActivePokemon : newState.playerActivePokemon;
      if (defender) {
        const updatedDefender = applyStatusCondition(defender, effect.status, newState.turnNumber);
        if (isPlayer1) {
          newState = { ...newState, opponentActivePokemon: updatedDefender };
        } else {
          newState = { ...newState, playerActivePokemon: updatedDefender };
        }
        console.log(`[coinFlip] Applied ${effect.status} to defender`);
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
        console.log(`[coinFlip] Applied ${selfDamage} self-damage (${tailsCount} tails)`);
      }
    }

    // Protection on heads (e.g., Chansey's Scrunch)
    if (effect.type === AttackEffectType.Protection && effect.coinFlip.onHeads === "protection" && headsCount > 0) {
      const attacker = isPlayer1 ? newState.playerActivePokemon : newState.opponentActivePokemon;
      if (attacker) {
        const protType = effect.protectionType || "damageAndEffects";
        const updatedAttacker: PokemonInPlay = {
          ...attacker,
          protection: {
            type: protType as "damageOnly" | "damageAndEffects",
            expiresAfterTurn: newState.turnNumber + 1,
          },
        };
        if (isPlayer1) { newState = { ...newState, playerActivePokemon: updatedAttacker }; }
        else { newState = { ...newState, opponentActivePokemon: updatedAttacker }; }
        console.log(`[coinFlip] Applied protection (${protType})`);
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

type ForfeitCallback = (
  roomId: string,
  winner: "player1" | "player2",
  gameState: GameState,
) => void;

export class GameRoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  private socketToRoom: Map<string, string> = new Map();
  private forfeitTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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
  createRoom(roomId?: string): GameRoom {
    const id = roomId || this.generateRoomId();
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
      players: [],
      createdAt: new Date(),
    };

    this.rooms.set(id, room);
    return room;
  }

  /**
   * Join an existing room or create if doesn't exist
   */
  async joinRoom(roomId: string, userId: string, socketId: string): Promise<GameRoom> {
    let room = this.rooms.get(roomId);

    if (!room) {
      room = this.createRoom(roomId);
    }

    // Check if room is full
    if (room.player1Id && room.player2Id) {
      // Check if reconnecting
      if (room.player1Id === userId) {
        room.player1SocketId = socketId;
        this.socketToRoom.set(socketId, roomId);
        this.cancelForfeitTimer(roomId, "player1");
        return room;
      }
      if (room.player2Id === userId) {
        room.player2SocketId = socketId;
        this.socketToRoom.set(socketId, roomId);
        this.cancelForfeitTimer(roomId, "player2");
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
   * Start the game
   */
  async startGame(roomId: string): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");

    if (!room.player1Id || !room.player2Id) {
      throw new Error("Need two players to start");
    }

    room.status = "playing";

    // Get decks - use default if not selected
    const player1Deck = getDeckById(room.player1DeckId || "brushfire") || decks[0];
    const player2Deck = getDeckById(room.player2DeckId || "overgrowth") || decks[1];

    // Initialize multiplayer game with both decks
    // Player 1 = "player" side, Player 2 = "opponent" side
    let gameState = initializeMultiplayerGame(player1Deck, player2Deck);

    // Start the game (deals cards, sets up prizes)
    gameState = startGame(gameState);

    // Neutralize initial events (always canonical: Tú=P1, Rival=P2)
    gameState = {
      ...gameState,
      events: neutralizeEvents(gameState.events, 0, "Jugador 1", "Jugador 2"),
    };

    room.gameState = gameState;
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
    const turnFreeActions = ["ready", "mulligan", "playerReady", "takePrize", "promote"];
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

          // Check if attack has coin flip effects and generate results
          const activePokemon = isPlayer1 ? room.gameState!.playerActivePokemon : room.gameState!.opponentActivePokemon;
          let coinFlipInfo: { attackName: string; results: Array<"heads" | "tails"> } | null = null;
          let coinFlipEffects: AttackEffect[] = [];

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

          usedExecuteForPlayer = true;
          newState = executeForPlayer((state) => executeAttack(state, attackIndex));

          // Apply coin flip effects that executeAttack skipped
          if (coinFlipInfo && coinFlipEffects.length > 0) {
            newState = applyCoinFlipEffects(newState, coinFlipInfo.results, coinFlipEffects, isPlayer1);
            console.log(`[attack] Applied coin flip effects for ${coinFlipInfo.attackName}`);
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
          newState = executeForPlayer((state) => endTurn(state));
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
          const eventMsg = useRainDance
            ? `Rain Dance: Energía ${energyCard.energyType} adjuntada a ${targetPokemon.pokemon.name}`
            : `Energía ${energyCard.energyType} adjuntada`;

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
            // Both players ready - do coin flip and start playing phase
            const coinFlipResult = Math.random() < 0.5 ? "heads" : "tails";
            console.log(`[playerReady] Both players ready! Coin flip: ${coinFlipResult}`);
            newState = startPlayingPhase(newState, coinFlipResult);
            console.log(`[playerReady] Game started! New phase: ${newState.gamePhase}`);
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
                return activateEnergyBurn(state, side);
              }
              case "buzzap": {
                const electrodePokemonId = action.payload.electrodePokemonId as string;
                const chosenEnergyType = action.payload.chosenEnergyType as EnergyType;
                const targetPokemonId = action.payload.targetPokemonId as string;
                return executeBuzzap(state, side, electrodePokemonId, chosenEnergyType, targetPokemonId);
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

      return {
        success: true,
        gameState: room.gameState,
        gameOver,
        winner,
        winReason,
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
