/**
 * Adventure types from game-core (0.10.0, `domain/adventure`), re-exported for the API's
 * adventure module. `ADVENTURE_PASSIVES` is kept as a literal tuple here (zod's enum needs one)
 * and checked against the engine's list.
 */
import { ADVENTURE_MODIFIER_TYPES as ENGINE_MODIFIER_TYPES, ADVENTURE_PASSIVES as ENGINE_PASSIVES } from "@gonzaloaguila/game-core";
import type { AdventurePassive, BattleModifier } from "@gonzaloaguila/game-core";

export type { AdventureGameConfig, AdventurePassive, BattleModifier, CardEntry, TableSide as ModifierSide } from "@gonzaloaguila/game-core";

export const ADVENTURE_PASSIVES = [
  "lucky_coin",
  "start_attached_energy",
  "opening_hand_plus_1",
  "prize_minus_one",
  "extra_heart",
] as const satisfies readonly AdventurePassive[];

export const ADVENTURE_MODIFIER_TYPES = [
  "prizeCount",
  "openingHand",
  "noPrizeFor",
  "bonusCards",
  "opponentSetup",
  "opponentPassives",
  "darkness",
  "alwaysConfused",
] as const satisfies readonly BattleModifier["type"][];

// The engine's lists must be exactly these (a new passive / modifier needs content support here)
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
if (!same(ADVENTURE_PASSIVES, ENGINE_PASSIVES) || !same(ADVENTURE_MODIFIER_TYPES, ENGINE_MODIFIER_TYPES)) {
  throw new Error("game-core's adventure passives / modifiers differ from the API's content schema");
}
