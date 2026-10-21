/**
 * What a run's difficulty changes, read from the content (schema.ts `difficulties`, a battle's
 * `opponent.deckByDifficulty` / `modifiersByDifficulty`). Pure: the validator, the run rules, the
 * HTTP views and the battle rooms all resolve a difficulty through these helpers.
 */
import type { BattleModifier, CardEntry } from "../engine-types.js";
import type { AdventureBattle, AdventureContent, Difficulty, TreasureOffer, TreasurePools } from "./schema.js";

export interface DifficultyRules {
  description: string;
  hearts: number;
  treasurePools: TreasurePools;
  treasureOffer: TreasureOffer;
}

/** The difficulty's rules, falling back to the adventure's own for what it doesn't change. */
export function difficultyRules(adventure: AdventureContent, difficulty: Difficulty): DifficultyRules {
  const own = adventure.difficulties[difficulty];
  return {
    description: own.description,
    hearts: own.hearts ?? adventure.rules.hearts,
    treasurePools: own.treasurePools ?? adventure.treasurePools,
    treasureOffer: own.treasureOffer ?? adventure.treasureOffer,
  };
}

/** The battle's rules in a run of that difficulty (its own list replaces `modifiers`). */
export function battleModifiers(battle: AdventureBattle, difficulty: Difficulty): BattleModifier[] {
  return (battle.modifiersByDifficulty?.[difficulty] ?? battle.modifiers) as BattleModifier[];
}

/**
 * The rival deck of a battle for a run: `deck`, or `deckByDifficulty` (hard: one deck, or the
 * run's starter's). Null when a hard `byStarter` has no deck for that starter.
 */
export function rivalDeckOf(battle: AdventureBattle, difficulty: Difficulty, starterId: string): CardEntry[] | null {
  const { deck, deckByDifficulty } = battle.opponent;
  if (deck) return deck;
  if (!deckByDifficulty) return null;
  if (difficulty === "normal") return deckByDifficulty.normal;
  const hard = deckByDifficulty.hard;
  return Array.isArray(hard) ? hard : (hard.byStarter[starterId] ?? null);
}
