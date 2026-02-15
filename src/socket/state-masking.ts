/**
 * State Perspective Swap
 *
 * Swaps the game state perspective for player 2 so they see themselves as "player".
 * This allows reusing the same UI components on the frontend.
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

// Legacy export for backwards compatibility
export function maskGameStateForPlayer(
  state: GameState,
  forPlayer: "player1" | "player2"
): GameState {
  return getGameStateForPlayer(state, forPlayer);
}
