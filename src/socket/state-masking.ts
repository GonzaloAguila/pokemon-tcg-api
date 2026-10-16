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
 * Gym Heroes: the Stadium (`stadium { card, playedBy }`), Narrow Gym's `pendingBenchTrim` queue,
 * Recall's `recallActiveOnTurn`, Pokémon's `previousEvolutions` and attached Trainers (Charity,
 * Sabrina's ESP) are public and sent as is (swapSides keeps them relative). Tickling Machine's
 * `setAsideHands` are face down for EVERYONE, their owner included (counts only). A mid-attack
 * question (`pendingAttackChoice.reaction`) never carries its `resume` (the paused attack's
 * coins and options, server-side only).
 *
 * Still visible to the owner: their own deck order and prizes (the client needs the
 * deck contents for search effects); hiding those needs search UIs to get a sorted
 * copy instead — tracked as a follow-up.
 */

import {
  arePrizesRevealed,
  isHandRevealed,
  maskDuelFor,
  swapSides,
  type GameState as EngineState,
  type PendingAttackChoice,
  type PendingPowerChoice,
  type SelectionStep,
  stepForAnswerer,
} from "@gonzaloaguila/game-core";
import type { PendingTrainerChoice } from "./rooms.js";

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

/**
 * Here Comes Team Rocket!: Prize cards are played face up (game-core arePrizesRevealed). Face
 * up = public: both players and spectators see them.
 */
const prizesFaceUpRule: RevealRule = (viewerState) => {
  if (!Array.isArray(viewerState.playerPrizes) || !Array.isArray(viewerState.opponentPrizes)) return [];
  const state = viewerState as unknown as EngineState;
  const zones: HiddenZone[] = [];
  try {
    if (arePrizesRevealed(state, "opponent")) zones.push("opponentPrizes");
    if (arePrizesRevealed(state, "player")) zones.push("playerPrizes");
  } catch {
    return []; // fail closed
  }
  return zones;
};

export const REVEAL_RULES: RevealRule[] = [clairvoyanceRule, prizesFaceUpRule];

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

/**
 * Tickling Machine (Gym Heroes): a hand set aside face down until the end of its owner's next
 * turn — nobody may look, its owner and spectators included. Same-length placeholders; the
 * entries' `side` stays as swapSides left it.
 */
function hideSetAsideHands(state: GameState): GameState {
  const setAside = state.setAsideHands;
  if (!Array.isArray(setAside) || setAside.length === 0) return state;
  return {
    ...state,
    setAsideHands: setAside.map((entry: { side?: string; cards?: unknown[] }, n: number) => ({
      ...entry,
      cards: (Array.isArray(entry.cards) ? entry.cards : []).map((_, i) => ({ id: `hidden-set-aside-${n}-${i}`, hidden: true })),
    })),
  };
}

/**
 * Misty's Duel: a player never sees the rival's pick of the current round before both are in
 * (game-core maskDuelFor: the rival's pick null, `playerPicked` / `opponentPicked` flags kept);
 * spectators see neither pick, only the flags. `lastRound` / `lastDuel` are public. Fails closed
 * (both picks hidden) on a partial state.
 */
function maskDuel(state: GameState, viewer: Viewer): GameState {
  const duel = state.pendingDuel as { playerPick: unknown; opponentPick: unknown } | undefined;
  if (!duel) return state;
  let masked: GameState;
  try {
    masked = maskDuelFor(state as unknown as EngineState, "player") as unknown as GameState;
  } catch {
    masked = {
      ...state,
      pendingDuel: { ...duel, playerPick: null, opponentPick: null, playerPicked: duel.playerPick !== null, opponentPicked: duel.opponentPick !== null },
    };
  }
  if (viewer !== "spectator") return masked;
  return { ...masked, pendingDuel: { ...(masked.pendingDuel as object), playerPick: null, opponentPick: null } };
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
  if (viewerChooses) {
    // A mid-attack question: who / what asks, never how the paused attack resumes
    if (choice.reaction) {
      const { resume: _resume, ...reaction } = choice.reaction;
      return withAnswererStep({ ...state, pendingAttackChoice: { ...choice, reaction } }, "pendingAttackChoice", { ...choice, reaction });
    }
    return withAnswererStep(state, "pendingAttackChoice", choice);
  }
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
 * The pending choice in full for the player who answers it. A step the other player answers
 * (`chooser: "opponent"`: Terror Strike, Knock Back, Challenge!) goes out as game-core's
 * stepForAnswerer(step): `title` / `description` replaced by `answererTitle` /
 * `answererDescription`, worded for the answerer. Any other step is sent as is.
 */
function withAnswererStep<C extends { step: SelectionStep }>(state: GameState, field: string, choice: C): GameState {
  const step = stepForAnswerer(choice.step);
  return step === choice.step ? state : { ...state, [field]: { ...choice, step } };
}

/** A step without anything to choose from (no options, cards, ordering cards, thumbnails). */
function strippedStep(step: SelectionStep): Pick<SelectionStep, "title" | "description" | "options" | "maxSelections" | "minSelections"> {
  const { title, description, maxSelections, minSelections } = step;
  return { title, description, options: [], maxSelections, minSelections };
}

/**
 * pendingPowerChoice (Summon Minions, Sneak Attack, Reel In) belongs to the side whose turn it
 * is: in full for it; everyone else gets the question without options + `waiting: true`.
 */
function maskPowerChoice(state: GameState, viewer: Viewer): GameState {
  const choice = state.pendingPowerChoice as PendingPowerChoice | undefined;
  if (!choice) return state;
  if (viewer !== "spectator" && state.isPlayerTurn === true) return state;
  return {
    ...state,
    pendingPowerChoice: { pokemonId: choice.pokemonId, powerName: choice.powerName, step: strippedStep(choice.step), waiting: true },
  };
}

/**
 * pendingTrainerChoice (startTrainer: Challenge!, Rocket's Sneak Attack): `chooser` is relative
 * to the Trainer's player, the side whose turn it is. The player who answers gets the step in
 * full (Sneak Attack's revealed hand included); the other player and spectators get it
 * stripped + `waiting: true`. The answers given so far are never in the state.
 */
function maskTrainerChoice(state: GameState, viewer: Viewer): GameState {
  const choice = state.pendingTrainerChoice as PendingTrainerChoice | undefined;
  if (!choice) return state;
  const viewerIsTrainerPlayer = state.isPlayerTurn === true;
  const viewerAnswers = viewer !== "spectator" && (choice.chooser === "opponent" ? !viewerIsTrainerPlayer : viewerIsTrainerPlayer);
  if (viewerAnswers) return withAnswererStep(state, "pendingTrainerChoice", choice);
  return {
    ...state,
    pendingTrainerChoice: {
      cardId: choice.cardId,
      trainerName: choice.trainerName,
      step: { ...strippedStep(choice.step), chooser: choice.step.chooser ?? "self" },
      chooser: choice.chooser,
      waiting: true,
    },
  };
}

/**
 * The state a given viewer may receive: perspective-swapped for player 2, with the
 * opponent's hidden zones masked (unless a REVEAL_RULE shows them), pending choices
 * only for the side resolving them, and pendingAttackChoice / pendingPowerChoice /
 * pendingTrainerChoice in full only for whoever answers them. Spectators see player 1's
 * perspective with both sides masked and no pending choices.
 */
export function maskGameStateForPlayer(
  state: GameState,
  forPlayer: Viewer
): GameState {
  const view = forPlayer === "spectator" ? state : getGameStateForPlayer(state, forPlayer);
  const sides: HiddenZoneSide[] = forPlayer === "spectator" ? ["player", "opponent"] : ["opponent"];
  let masked = stripForeignPending(maskDuel(hideSetAsideHands(hideZones(view, sides, revealedZones(view, forPlayer))), forPlayer), forPlayer);
  masked = maskAttackChoice(masked, forPlayer);
  masked = maskPowerChoice(masked, forPlayer);
  return maskTrainerChoice(masked, forPlayer);
}
