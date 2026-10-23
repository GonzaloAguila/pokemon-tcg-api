/**
 * What a multiplayer game did, for the challenge achievements (modules/achievements/challenges.ts):
 * both decks as played, and per seat the largest prize deficit, Bench use, the biggest attack hit
 * (game-core's lastAttackHit) and the Pokémon that dealt the winning Knock Out. Created when a game
 * starts (rooms.ts startGame / startGameWithRawDecks), fed every committed action (runActionNow)
 * and read once at settlement (match-settlement.ts). The server state is player 1's view:
 * "player" = player 1, "opponent" = player 2.
 */
import { GamePhase, findCardDefinition, type GameCard, type GameState, type PokemonInPlay } from "@gonzaloaguila/game-core";
import type { DeckEntry, DeckSnapshot, DeckSource } from "../modules/achievements/challenge-decks.js";

type Seat = "player1" | "player2";

/** What one seat did in the game (Match.feats). */
export interface SeatFeats {
  /** The most Prizes the rival was ahead at any moment (Prizes taken by the rival − by this seat) */
  maxPrizeDeficit: number;
  /** This seat had a Benched Pokémon at some point (setup included) */
  benchUsed: boolean;
  /** The biggest damage of one of this seat's attack hits (full damage, before the HP cap) */
  maxAttackDamage: number;
  /** Prizes the rival took */
  prizesTakenByRival: number;
  /** The card name of the Pokémon whose attack won the game (winner only), else null */
  finalKoBy: string | null;
}

/** What a settled multiplayer game stores for the challenge achievements (SettleInput.challenge). */
export interface MatchChallengeData {
  player1Deck: DeckSnapshot;
  player2Deck: DeckSnapshot;
  endKind: EndKind;
  feats: Record<"player1" | "player2", SeatFeats>;
  finalTurn: number;
}

/** How a multiplayer game ended (Match.endKind); only prizes / no_pokemon / deck_out are played wins. */
export type EndKind = "prizes" | "no_pokemon" | "deck_out" | "draw" | "forfeit" | "interrupted";

export interface ChallengeTracker {
  decks: Record<Seat, DeckSnapshot>;
  initialPrizes: Record<Seat, number>;
  maxPrizeDeficit: Record<Seat, number>;
  benchUsed: Record<Seat, boolean>;
  maxAttackDamage: Record<Seat, number>;
  /** The engine ended the game (not a surrender) */
  engineEnded: boolean;
  /** The attack hit that ended the game */
  finalKo: { seat: Seat; name: string } | null;
}

const seatOf = (side: "player" | "opponent"): Seat => (side === "player" ? "player1" : "player2");

/** Every card a side holds, in any zone (at a game's start: the whole deck). */
function sideCards(state: GameState, side: "player" | "opponent"): GameCard[] {
  const inPlay = (p: PokemonInPlay | null): GameCard[] =>
    p ? [p.pokemon, ...p.attachedEnergy, ...(p.attachedTrainers ?? []), ...(p.previousEvolutions ?? [])] : [];
  const s = side === "player"
    ? [state.playerDeck, state.playerHand, state.playerPrizes, state.playerDiscard, ...state.playerBench.map(inPlay), inPlay(state.playerActivePokemon)]
    : [state.opponentDeck, state.opponentHand, state.opponentPrizes, state.opponentDiscard, ...state.opponentBench.map(inPlay), inPlay(state.opponentActivePokemon)];
  return s.flat();
}

/** A side's cards as catalog ids and copies. */
function snapshot(state: GameState, side: "player" | "opponent", source: DeckSource): DeckSnapshot {
  const counts = new Map<string, number>();
  for (const card of sideCards(state, side)) {
    const id = findCardDefinition(card.set, card.number)?.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { source, cards: [...counts].map(([cardId, qty]): DeckEntry => ({ cardId, qty })) };
}

function trackBoard(tracker: ChallengeTracker, state: GameState): void {
  tracker.initialPrizes.player1 = Math.max(tracker.initialPrizes.player1, state.playerPrizes.length);
  tracker.initialPrizes.player2 = Math.max(tracker.initialPrizes.player2, state.opponentPrizes.length);
  const taken1 = tracker.initialPrizes.player1 - state.playerPrizes.length;
  const taken2 = tracker.initialPrizes.player2 - state.opponentPrizes.length;
  tracker.maxPrizeDeficit.player1 = Math.max(tracker.maxPrizeDeficit.player1, taken2 - taken1);
  tracker.maxPrizeDeficit.player2 = Math.max(tracker.maxPrizeDeficit.player2, taken1 - taken2);
  if (state.playerBench.length > 0) tracker.benchUsed.player1 = true;
  if (state.opponentBench.length > 0) tracker.benchUsed.player2 = true;
}

/** A tracker for the game that starts with `state` (decks dealt, Prizes set aside). */
export function createChallengeTracker(state: GameState, sources: Record<Seat, DeckSource>): ChallengeTracker {
  const tracker: ChallengeTracker = {
    decks: { player1: snapshot(state, "player", sources.player1), player2: snapshot(state, "opponent", sources.player2) },
    initialPrizes: { player1: 0, player2: 0 },
    maxPrizeDeficit: { player1: 0, player2: 0 },
    benchUsed: { player1: false, player2: false },
    maxAttackDamage: { player1: 0, player2: 0 },
    engineEnded: false,
    finalKo: null,
  };
  trackBoard(tracker, state);
  return tracker;
}

/** One committed action: `prev` → `next` (player 1's view). */
export function observe(tracker: ChallengeTracker, prev: GameState, next: GameState, action: { type: string }): void {
  trackBoard(tracker, next);
  const hit = next.lastAttackHit;
  const newHit = hit && hit.seq !== prev.lastAttackHit?.seq ? hit : undefined;
  if (newHit) {
    const seat = seatOf(newHit.attackerSide);
    tracker.maxAttackDamage[seat] = Math.max(tracker.maxAttackDamage[seat], newHit.damage);
  }
  const ended = next.gamePhase === GamePhase.GameOver && prev.gamePhase !== GamePhase.GameOver;
  if (!ended) return;
  tracker.engineEnded = action.type !== "surrender";
  if (newHit && (action.type === "attack" || action.type === "resolveAttackChoice")) {
    tracker.finalKo = { seat: seatOf(newHit.attackerSide), name: newHit.attackerName };
  }
}

function endKindOf(tracker: ChallengeTracker, state: GameState | null | undefined, winner: Seat | "draw" | null): EndKind {
  if (winner === "draw") return "draw";
  if (winner === null) return "interrupted";
  if (!tracker.engineEnded || !state) return "forfeit";
  const winnerPrizes = winner === "player1" ? state.playerPrizes : state.opponentPrizes;
  if (winnerPrizes.length === 0) return "prizes";
  const loserActive = winner === "player1" ? state.opponentActivePokemon : state.playerActivePokemon;
  const loserBench = winner === "player1" ? state.opponentBench : state.playerBench;
  if (!loserActive && loserBench.length === 0) return "no_pokemon";
  return "deck_out";
}

/** The game's end, for its match row: how it ended, each seat's feats and the last turn. */
export function finishTracker(
  tracker: ChallengeTracker,
  finalState: GameState | null | undefined,
  winner: Seat | "draw" | null,
): { endKind: EndKind; feats: Record<Seat, SeatFeats>; finalTurn: number } {
  if (finalState) trackBoard(tracker, finalState);
  const taken = (seat: Seat) =>
    tracker.initialPrizes[seat] - (finalState ? (seat === "player1" ? finalState.playerPrizes.length : finalState.opponentPrizes.length) : tracker.initialPrizes[seat]);
  const endKind = endKindOf(tracker, finalState, winner);
  const feats = (seat: Seat, rival: Seat): SeatFeats => ({
    maxPrizeDeficit: tracker.maxPrizeDeficit[seat],
    benchUsed: tracker.benchUsed[seat],
    maxAttackDamage: tracker.maxAttackDamage[seat],
    prizesTakenByRival: taken(rival),
    finalKoBy: tracker.finalKo && tracker.finalKo.seat === seat && winner === seat && endKind !== "forfeit" ? tracker.finalKo.name : null,
  });
  return { endKind, feats: { player1: feats("player1", "player2"), player2: feats("player2", "player1") }, finalTurn: finalState?.turnNumber ?? 0 };
}
