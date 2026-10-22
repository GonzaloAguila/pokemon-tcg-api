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

/**
 * The battle's rules in a run of that difficulty and starter (the difficulty's own list replaces
 * `modifiers`; a hard `byStarter` gives the run's starter's, or `modifiers` without one).
 */
export function battleModifiers(battle: AdventureBattle, difficulty: Difficulty, starterId: string): BattleModifier[] {
  const own = battle.modifiersByDifficulty?.[difficulty];
  if (!own) return battle.modifiers as BattleModifier[];
  if (Array.isArray(own)) return own as BattleModifier[];
  return (own.byStarter[starterId] ?? battle.modifiers) as BattleModifier[];
}

/** Every list of rules a battle has, labelled (" (difícil, charmander)"), for the validator. */
export function battleModifierLists(battle: AdventureBattle): { label: string; difficulty: Difficulty | null; starterId: string | null; modifiers: BattleModifier[] }[] {
  const lists: { label: string; difficulty: Difficulty | null; starterId: string | null; modifiers: BattleModifier[] }[] = [
    { label: "", difficulty: null, starterId: null, modifiers: battle.modifiers as BattleModifier[] },
  ];
  const { normal, hard } = battle.modifiersByDifficulty ?? {};
  if (normal) lists.push({ label: " (normal)", difficulty: "normal", starterId: null, modifiers: normal as BattleModifier[] });
  if (hard && Array.isArray(hard)) lists.push({ label: " (difícil)", difficulty: "hard", starterId: null, modifiers: hard as BattleModifier[] });
  if (hard && !Array.isArray(hard)) {
    for (const [starterId, modifiers] of Object.entries(hard.byStarter)) {
      lists.push({ label: ` (difícil, ${starterId})`, difficulty: "hard", starterId, modifiers: modifiers as BattleModifier[] });
    }
  }
  return lists;
}

/** The battle's objective line in a run of that difficulty, or null. */
export function battleObjective(battle: AdventureBattle, difficulty: Difficulty): string | null {
  return battle.objectiveByDifficulty?.[difficulty] ?? battle.objective ?? null;
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
