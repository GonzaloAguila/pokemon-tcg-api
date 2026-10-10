/**
 * State Perspective Swap + Hidden-Information Masking
 *
 * Swaps the game state perspective for player 2 so they see themselves as "player"
 * (so the frontend reuses the same UI), and replaces cards a viewer must not see
 * with placeholders: the opponent's hand, deck and prizes keep their length (the UI
 * only renders counts/card backs) but carry no card data. Spectators get both
 * sides masked.
 *
 * Pending choices (pendingForceSwitch, pendingDeckSearch, pendingPeek, ...) belong to the
 * side whose turn it is (game-core convention: swapSides leaves them untouched and the
 * acting side resolves them in its own perspective). They are only sent to that side:
 * the other player and spectators never get them (pendingPeek holds the cards the acting
 * player looked at, e.g. the top card of their own deck).
 *
 * pendingAttackChoice is different: it is answered by its step's chooser (the attacker, or
 * the defending player for "opponent" steps such as Terror Strike). The chooser gets it in
 * full (Prophecy's top cards included, even of the opponent's deck); everyone else gets a
 * "waiting" stub with the question but no options, cards, deck or context.
 *
 * Still visible to the owner: their own deck order and prizes (the client needs the
 * deck contents for search effects); hiding those needs search UIs to get a sorted
 * copy instead — tracked as a follow-up.
 */

import {
  isHandRevealed,
  swapSides,
  type GameState as EngineState,
  type PendingAttackChoice,
} from "@gonzaloaguila/game-core";

// Loose record: emitted states are plain JSON and tests pass partial states
type GameState = Record<string, unknown>;

export type MaskedGameState = GameState;
export type Viewer = "player1" | "player2" | "spectator";

/** Pending-choice fields owned by the side whose turn it is. */
export const ACTING_SIDE_PENDING_FIELDS = [
  "pendingForceSwitch",
  "pendingSelfSwitch",
  "pendingDeckSearch",
  "pendingBenchDamageSelection",
  "pendingTypeShift",
  "pendingPeek",
] as const;

/**
 * Swap game state perspective for player 2.
 * Player 1 receives the state as-is.
 * Player 2 receives the state with player/opponent swapped (game-core's swapSides: zones,
 * ready/prize/promotion flags, turn, starting player, PlusPower/Defender owner, result)
 * and "Jugador 1"/"Jugador 2" swapped in the event log.
 */
export function getGameStateForPlayer(
  state: GameState,
  forPlayer: "player1" | "player2"
): GameState {
  // Player 1 sees the state as-is
  if (forPlayer === "player1") {
    return state;
  }

  const swapped = swapSides({ activeModifiers: [], ...state } as unknown as EngineState) as unknown as GameState;

  // Swap event names so "Jugador 1" always means "self" from the receiver's POV
  const events = state.events as Array<{ message: string; type: string; timestamp: number }> | undefined;
  if (events) {
    swapped.events = events.map((e) => ({
      ...e,
      message: e.message
        .replace(/Jugador 1/g, "@@P1@@")
        .replace(/Jugador 2/g, "Jugador 1")
        .replace(/@@P1@@/g, "Jugador 2"),
    }));
  }
  return swapped;
}

// ---------------------------------------------------------------------------
// Hidden zones
// ---------------------------------------------------------------------------

export type HiddenZone =
  | "playerHand"
  | "playerDeck"
  | "playerPrizes"
  | "opponentHand"
  | "opponentDeck"
  | "opponentPrizes";

/**
 * Hook for effects that reveal normally hidden cards: Fossil's Clairvoyance (Omanyte: its
 * owner plays with the opponent's hand face up), Team Rocket's Here Comes Team Rocket!
 * (both players' prizes face up, spectators included), Rocket's Sneak Attack...
 *
 * A rule gets the state in the viewer's perspective (player 2: swapped; spectators: player
 * 1's) and returns the zones of THAT perspective the viewer may see. Rules must ask the
 * engine, never re-implement the card.
 */
export type RevealRule = (viewerState: GameState, viewer: Viewer) => readonly HiddenZone[];

/**
 * Clairvoyance (Omanyte): a side plays with its hand face up while the other side has a
 * working Clairvoyance in play (game-core isHandRevealed). Face up = public: the opponent
 * sees it, and so do spectators.
 */
const clairvoyanceRule: RevealRule = (viewerState) => {
  // Not a full game state (partial test fixtures): nothing is revealed
  if (!Array.isArray(viewerState.playerBench) || !Array.isArray(viewerState.opponentBench)) return [];
  const state = viewerState as unknown as EngineState;
  const zones: HiddenZone[] = [];
  try {
    if (isHandRevealed(state, "opponent")) zones.push("opponentHand");
    if (isHandRevealed(state, "player")) zones.push("playerHand");
  } catch {
    return []; // fail closed: keep the hands hidden
  }
  return zones;
};

export const REVEAL_RULES: RevealRule[] = [clairvoyanceRule];

/** Zones revealed to this viewer by REVEAL_RULES. */
export function revealedZones(viewerState: GameState, viewer: Viewer): Set<HiddenZone> {
  const zones = new Set<HiddenZone>();
  for (const rule of REVEAL_RULES) {
    for (const zone of rule(viewerState, viewer)) zones.add(zone);
  }
  return zones;
}

type HiddenZoneSide = "player" | "opponent";

const HIDDEN_ZONES = ["Hand", "Deck", "Prizes"] as const;

/** Same length, no card data: { id: "hidden-opponent-hand-3", hidden: true } */
function hideZones(state: GameState, sides: HiddenZoneSide[], revealed: Set<HiddenZone>): GameState {
  const masked: GameState = { ...state };
  for (const side of sides) {
    for (const zone of HIDDEN_ZONES) {
      const key = `${side}${zone}` as HiddenZone;
      if (revealed.has(key)) continue;
      const cards = state[key];
      if (Array.isArray(cards)) {
        masked[key] = cards.map((_, i) => ({ id: `hidden-${side}-${zone.toLowerCase()}-${i}`, hidden: true }));
      }
    }
  }
  return masked;
}

/** Drop pending choices the viewer doesn't own (not their turn, or a spectator). */
function stripForeignPending(state: GameState, viewer: Viewer): GameState {
  const owns = viewer !== "spectator" && state.isPlayerTurn === true;
  if (owns) return state;
  if (!ACTING_SIDE_PENDING_FIELDS.some((field) => state[field] !== undefined)) return state;
  const stripped: GameState = { ...state };
  for (const field of ACTING_SIDE_PENDING_FIELDS) delete stripped[field];
  return stripped;
}

/**
 * pendingAttackChoice for a viewer who is not its chooser (or a spectator): the question
 * without anything to choose from (no options, cards, ordering cards, thumbnails, deck,
 * context or queue) plus `waiting: true`. `state` is in the viewer's perspective: the
 * attacker is the side whose turn it is.
 */
function maskAttackChoice(state: GameState, viewer: Viewer): GameState {
  const choice = state.pendingAttackChoice as PendingAttackChoice | undefined;
  if (!choice) return state;
  const viewerIsAttacker = state.isPlayerTurn === true;
  const chooser = choice.step.chooser ?? "self";
  const viewerChooses = viewer !== "spectator" && (chooser === "opponent" ? !viewerIsAttacker : viewerIsAttacker);
  if (viewerChooses) return state;
  const { title, description, maxSelections, minSelections } = choice.step;
  return {
    ...state,
    pendingAttackChoice: {
      effect: choice.effect,
      step: { title, description, chooser, options: [], maxSelections, minSelections },
      waiting: true,
    },
  };
}

/**
 * The state a given viewer may receive: perspective-swapped for player 2, with the
 * opponent's hidden zones masked (unless a REVEAL_RULE shows them), pending choices
 * only for the side resolving them and pendingAttackChoice in full only for its chooser. Spectators see player 1's perspective with both
 * sides masked and no pending choices.
 */
export function maskGameStateForPlayer(
  state: GameState,
  forPlayer: Viewer
): GameState {
  const view = forPlayer === "spectator" ? state : getGameStateForPlayer(state, forPlayer);
  const sides: HiddenZoneSide[] = forPlayer === "spectator" ? ["player", "opponent"] : ["opponent"];
  return maskAttackChoice(stripForeignPending(hideZones(view, sides, revealedZones(view, forPlayer)), forPlayer), forPlayer);
}
