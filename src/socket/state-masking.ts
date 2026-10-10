/**
 * State Perspective Swap + Hidden-Information Masking
 *
 * Swaps the game state perspective for player 2 so they see themselves as "player"
 * (so the frontend reuses the same UI), and replaces cards a viewer must not see
 * with placeholders: the opponent's hand, deck and prizes keep their length (the UI
 * only renders counts/card backs) but carry no card data. Spectators get both
 * sides masked.
 *
 * Still visible to the owner: their own deck order and prizes (the client needs the
 * deck contents for search effects); hiding those needs search UIs to get a sorted
 * copy instead — tracked as a follow-up.
 */

// Use Record for now - will properly type when game-core types are integrated
type GameState = Record<string, unknown>;

export type MaskedGameState = GameState;

/**
 * Swap game state perspective for player 2.
 * Player 1 receives the state as-is.
 * Player 2 receives the state with player/opponent swapped.
 */
export function getGameStateForPlayer(
  state: GameState,
  forPlayer: "player1" | "player2"
): GameState {
  // Player 1 sees the state as-is
  if (forPlayer === "player1") {
    return state;
  }

  // Player 2 sees swapped perspective
  // Swap event names so "Jugador 1" always means "self" from the receiver's POV
  const events = state.events as Array<{ message: string; type: string; timestamp: number }> | undefined;
  const swappedEvents = events?.map(e => ({
    ...e,
    message: e.message
      .replace(/Jugador 1/g, "@@P1@@")
      .replace(/Jugador 2/g, "Jugador 1")
      .replace(/@@P1@@/g, "Jugador 2"),
  }));

  return {
    ...state,
    // Swap player/opponent fields
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

    // Swap events with swapped names
    ...(swappedEvents ? { events: swappedEvents } : {}),

    // Swap turn perspective
    isPlayerTurn: !state.isPlayerTurn,

    // PlusPower/Defender owner ("player"/"opponent"), so P2's UI shows them on the right side
    ...(Array.isArray(state.activeModifiers)
      ? {
          activeModifiers: (state.activeModifiers as Array<{ playerId?: string }>).map((m) => ({
            ...m,
            playerId: m.playerId === "player" ? "opponent" : m.playerId === "opponent" ? "player" : m.playerId,
          })),
        }
      : {}),

    // Swap starting player perspective
    startingPlayer: state.startingPlayer === "player"
      ? "opponent"
      : state.startingPlayer === "opponent"
        ? "player"
        : state.startingPlayer,

    // Swap game result perspective
    gameResult: state.gameResult === "victory"
      ? "defeat"
      : state.gameResult === "defeat"
        ? "victory"
        : state.gameResult,
  };
}

type HiddenZoneSide = "player" | "opponent";

const HIDDEN_ZONES = ["Hand", "Deck", "Prizes"] as const;

/** Same length, no card data: { id: "hidden-opponent-hand-3", hidden: true } */
function hideZones(state: GameState, sides: HiddenZoneSide[]): GameState {
  const masked: GameState = { ...state };
  for (const side of sides) {
    for (const zone of HIDDEN_ZONES) {
      const key = `${side}${zone}`;
      const cards = state[key];
      if (Array.isArray(cards)) {
        masked[key] = cards.map((_, i) => ({ id: `hidden-${side}-${zone.toLowerCase()}-${i}`, hidden: true }));
      }
    }
  }
  return masked;
}

/**
 * The state a given viewer may receive: perspective-swapped for player 2, with the
 * opponent's hidden zones masked. Spectators see player 1's perspective with both
 * sides masked.
 */
export function maskGameStateForPlayer(
  state: GameState,
  forPlayer: "player1" | "player2" | "spectator"
): GameState {
  if (forPlayer === "spectator") {
    return hideZones(state, ["player", "opponent"]);
  }
  return hideZones(getGameStateForPlayer(state, forPlayer), ["opponent"]);
}
