/**
 * State Masking
 *
 * Converts full GameState into player-specific views that hide private information.
 * This is critical for multiplayer - opponent's hand and deck must never be visible.
 */

// TODO: Import from game-core when available
// import type { GameState, GameCard, PokemonInPlay } from '@poke-tcg/game-core';

type GameState = Record<string, unknown>;
type GameCard = Record<string, unknown>;
type PokemonInPlay = Record<string, unknown>;

/**
 * Masked game state sent to clients.
 * Contains all public information plus the player's private information.
 */
export interface MaskedGameState {
  // Game phase
  gamePhase: string;
  turnNumber: number;
  isMyTurn: boolean;

  // My information (full visibility)
  myHand: GameCard[];
  myDeckCount: number;
  myPrizesCount: number;
  myPrizes?: GameCard[]; // Only visible when taking prizes
  myActive: PokemonInPlay | null;
  myBench: (PokemonInPlay | null)[];
  myDiscard: GameCard[];

  // Opponent information (limited visibility)
  opponentHandCount: number;
  opponentDeckCount: number;
  opponentPrizesCount: number;
  opponentActive: PokemonInPlay | null;
  opponentBench: (PokemonInPlay | null)[];
  opponentDiscard: GameCard[];

  // Public game state
  activeModifiers: unknown[];
  events: unknown[];

  // Turn flags
  energyAttachedThisTurn: boolean;
  retreatedThisTurn: boolean;
}

/**
 * Mask the full game state for a specific player.
 *
 * @param state - Full canonical game state
 * @param forPlayer - Which player to mask for ("player1" or "player2")
 * @returns Masked state safe to send to the player
 */
export function maskGameStateForPlayer(
  state: GameState,
  forPlayer: "player1" | "player2"
): MaskedGameState {
  const isPlayer1 = forPlayer === "player1";

  // Determine which side is "mine" vs "opponent"
  const myHand = isPlayer1 ? state.playerHand : state.opponentHand;
  const myDeck = isPlayer1 ? state.playerDeck : state.opponentDeck;
  const myPrizes = isPlayer1 ? state.playerPrizes : state.opponentPrizes;
  const myActive = isPlayer1 ? state.playerActivePokemon : state.opponentActivePokemon;
  const myBench = isPlayer1 ? state.playerBench : state.opponentBench;
  const myDiscard = isPlayer1 ? state.playerDiscard : state.opponentDiscard;

  const oppHand = isPlayer1 ? state.opponentHand : state.playerHand;
  const oppDeck = isPlayer1 ? state.opponentDeck : state.playerDeck;
  const oppPrizes = isPlayer1 ? state.opponentPrizes : state.playerPrizes;
  const oppActive = isPlayer1 ? state.opponentActivePokemon : state.playerActivePokemon;
  const oppBench = isPlayer1 ? state.opponentBench : state.playerBench;
  const oppDiscard = isPlayer1 ? state.opponentDiscard : state.playerDiscard;

  // Determine if it's my turn
  // In the original state, isPlayerTurn refers to player1
  const isMyTurn = isPlayer1
    ? (state.isPlayerTurn as boolean)
    : !(state.isPlayerTurn as boolean);

  return {
    // Game phase
    gamePhase: state.gamePhase as string,
    turnNumber: state.turnNumber as number,
    isMyTurn,

    // My information (full)
    myHand: myHand as GameCard[],
    myDeckCount: (myDeck as GameCard[])?.length ?? 0,
    myPrizesCount: (myPrizes as GameCard[])?.length ?? 0,
    myActive: myActive as PokemonInPlay | null,
    myBench: myBench as (PokemonInPlay | null)[],
    myDiscard: myDiscard as GameCard[],

    // Opponent information (masked)
    opponentHandCount: (oppHand as GameCard[])?.length ?? 0,
    opponentDeckCount: (oppDeck as GameCard[])?.length ?? 0,
    opponentPrizesCount: (oppPrizes as GameCard[])?.length ?? 0,
    opponentActive: maskPokemonInPlay(oppActive as PokemonInPlay | null),
    opponentBench: (oppBench as (PokemonInPlay | null)[])?.map(maskPokemonInPlay) ?? [],
    opponentDiscard: oppDiscard as GameCard[], // Discard is public

    // Public state
    activeModifiers: state.activeModifiers as unknown[],
    events: state.events as unknown[],

    // Turn flags
    energyAttachedThisTurn: state.energyAttachedThisTurn as boolean,
    retreatedThisTurn: state.retreatedThisTurn as boolean,
  };
}

/**
 * Mask a PokemonInPlay for opponent view.
 * Pokemon on the field are visible, but we might want to hide some metadata.
 */
function maskPokemonInPlay(pokemon: PokemonInPlay | null): PokemonInPlay | null {
  if (!pokemon) return null;

  // Pokemon in play are mostly public - their cards, damage, status, etc.
  // The main thing that's private is the opponent's hand, not their Pokemon
  return pokemon;
}

/**
 * Create a hidden card representation (for opponent's hand preview if needed)
 */
export function createHiddenCard(): { hidden: true } {
  return { hidden: true };
}

/**
 * Mask an array of cards (e.g., for showing opponent's hand count with hidden cards)
 */
export function maskCards(cards: GameCard[]): { hidden: true }[] {
  return cards.map(() => createHiddenCard());
}
