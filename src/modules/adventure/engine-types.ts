/**
 * Adventure types that belong to game-core 0.10.0 (`domain/adventure`). Until the API moves to
 * that version they are declared here with the shapes of the plan (game-core
 * docs/superpowers/plans/2026-10-21-adventure-mode.md, Tasks 2–4); once it does, this file only
 * re-exports the engine's types so every import keeps working.
 */

export const ADVENTURE_PASSIVES = [
  "lucky_coin",
  "start_attached_energy",
  "opening_hand_plus_1",
  "prize_minus_one",
  "extra_heart",
] as const;
export type AdventurePassive = (typeof ADVENTURE_PASSIVES)[number];

/** A deck line by catalog id (`base-set-046-charmander`). */
export interface CardEntry {
  cardId: string;
  qty: number;
}

export type ModifierSide = "player" | "opponent";

/** Battle modifiers ("reglas de jefe", design §3.5). Sides are relative: player = the human. */
export type BattleModifier =
  | { type: "prizeCount"; player?: number; opponent?: number }
  | { type: "openingHand"; player?: number; opponent?: number }
  | { type: "noPrizeFor"; side: ModifierSide; names: string[] }
  | { type: "bonusCards"; side: ModifierSide; cards: CardEntry[]; to: "hand" }
  | { type: "opponentSetup"; active: string[]; bench: string[][] }
  | { type: "opponentPassives"; passives: AdventurePassive[] };

export const ADVENTURE_MODIFIER_TYPES = [
  "prizeCount",
  "openingHand",
  "noPrizeFor",
  "bonusCards",
  "opponentSetup",
  "opponentPassives",
] as const satisfies readonly BattleModifier["type"][];

/** What `createAdventureGame` takes (human = `player`, the AI = `opponent`). */
export interface AdventureGameConfig {
  playerDeck: CardEntry[];
  opponentDeck: CardEntry[];
  prizeCount: number;
  openingHand: number;
  playerPassives: AdventurePassive[];
  modifiers: BattleModifier[];
}
