/**
 * What a run's difficulty changes, read from the content (schema.ts `difficulties`, a battle's
 * `opponent.deckByDifficulty` / `modifiersByDifficulty`). Pure: the validator, the run rules, the
 * HTTP views and the battle rooms all resolve a difficulty through these helpers.
 */
import type { BattleModifier, CardEntry } from "../engine-types.js";
import type { AdventureBattle, AdventureContent, Difficulty, TreasureOffer, TreasurePools } from "./schema.js";
import { cardOf, isBasicPokemonCard } from "./cards.js";

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
 * `modifiers`; a hard `byStarter` gives the run's starter's, or `modifiers` without one), with
 * the rival's opening Bench (withOpeningBench).
 */
export function battleModifiers(battle: AdventureBattle, difficulty: Difficulty, starterId: string): BattleModifier[] {
  const own = battle.modifiersByDifficulty?.[difficulty];
  const listed = (!own ? battle.modifiers : Array.isArray(own) ? own : (own.byStarter[starterId] ?? battle.modifiers)) as BattleModifier[];
  const deck = rivalDeckOf(battle, difficulty, starterId);
  return deck ? withOpeningBench(listed, battle.opponent.lead, deck) : listed;
}

/**
 * Every adventure rival starts with an Active and a Benched Pokémon (owner, 2026-10-24: a lone
 * Active Knocked Out on turn 1 ended the battle at once). Without an `opponentSetup` the battle
 * gets one: the lead as the Active when it is a Basic in the deck (else the deck's first Basic),
 * and the deck's next Basic — another species first, else a second copy — on the Bench. A setup
 * without a Bench gets one Basic the setup doesn't already use. Nothing changes when the deck has
 * no Basic left for the Bench.
 */
export function withOpeningBench(modifiers: BattleModifier[], lead: string | undefined, deck: CardEntry[]): BattleModifier[] {
  const basics = deck.filter((e) => isBasicPokemonCard(cardOf(e.cardId)));
  if (basics.length === 0) return modifiers;
  const left = new Map<string, number>();
  for (const e of basics) left.set(e.cardId, (left.get(e.cardId) ?? 0) + e.qty);
  const take = (id: string) => left.set(id, (left.get(id) ?? 0) - 1);
  /** A Basic still in the deck: another species than `avoid` first, else one more copy. */
  const nextBasic = (avoid: string | undefined) =>
    basics.find((e) => e.cardId !== avoid && (left.get(e.cardId) ?? 0) > 0)?.cardId ??
    basics.find((e) => (left.get(e.cardId) ?? 0) > 0)?.cardId;

  const setup = modifiers.find((m): m is Extract<BattleModifier, { type: "opponentSetup" }> => m.type === "opponentSetup");
  if (setup && setup.bench.length > 0) return modifiers;
  if (setup) {
    for (const id of [...setup.active, ...setup.bench.flat()]) take(id);
    const bench = nextBasic(setup.active[0]);
    return bench ? modifiers.map((m) => (m === setup ? { ...setup, bench: [[bench]] } : m)) : modifiers;
  }
  const active = lead !== undefined && basics.some((e) => e.cardId === lead) ? lead : basics[0].cardId;
  take(active);
  const bench = nextBasic(active);
  return [...modifiers, { type: "opponentSetup", active: [active], bench: bench ? [[bench]] : [] }];
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
