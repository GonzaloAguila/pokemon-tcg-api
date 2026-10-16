/**
 * Tutorial lessons and puzzles, in the order they unlock. The frontend mirrors these ids in
 * `src/domain/scenarios/catalog.ts` (pokemon-tcg repo): keep both lists in sync. The rewards come
 * from ECONOMY.progress.
 */

import { ECONOMY } from "../economy/config.js";

export type ProgressTrack = "tutorial" | "puzzles";
export type PuzzleTier = keyof typeof ECONOMY.progress.puzzleCoins;

export const TUTORIAL_LESSONS = ["basics", "evolution", "trainers", "status"] as const;
export type TutorialLessonId = (typeof TUTORIAL_LESSONS)[number];

export interface PuzzleDef {
  id: string;
  /** 1-based position, used in the transaction description ("Puzzle 3 resuelto"). */
  number: number;
  tier: PuzzleTier;
}

function tierFor(n: number): PuzzleTier {
  if (n <= 4) return "easy";
  if (n <= 8) return "medium";
  return "hard";
}

export const PUZZLES: readonly PuzzleDef[] = Array.from({ length: 12 }, (_, i) => {
  const number = i + 1;
  return { id: `puzzle-${String(number).padStart(2, "0")}`, number, tier: tierFor(number) };
});

/** Key of the one-time tutorial reward (EconomyClaim kind "tutorial"). */
export const TUTORIAL_REWARD_KEY = "v1";

export function puzzleCoins(puzzle: PuzzleDef): number {
  return ECONOMY.progress.puzzleCoins[puzzle.tier];
}

/** Index of an item in its track, or -1 if the id is unknown. */
export function itemIndex(track: ProgressTrack, itemId: string): number {
  return track === "tutorial"
    ? (TUTORIAL_LESSONS as readonly string[]).indexOf(itemId)
    : PUZZLES.findIndex((p) => p.id === itemId);
}

/** Ids of a track in catalog order. */
export function trackItems(track: ProgressTrack): readonly string[] {
  return track === "tutorial" ? TUTORIAL_LESSONS : PUZZLES.map((p) => p.id);
}
