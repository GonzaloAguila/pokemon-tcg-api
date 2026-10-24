import type { AdventurePassive, CardEntry } from "./engine-types.js";
import type { Difficulty } from "./content/schema.js";

export type RunStatus = "active" | "won" | "lost" | "abandoned";
export type RunPhase = "pre_battle" | "in_battle" | "choosing_treasure" | "finished";

/** The mutable part of a run (an `AdventureRun` row without ids / timestamps / battle snapshot). */
export interface RunState {
  adventureId: string;
  adventureVersion: number;
  difficulty: Difficulty;
  starterId: string;
  status: RunStatus;
  phase: RunPhase;
  currentBattle: number;
  attempt: number;
  hearts: number;
  maxHearts: number;
  heartsLost: number;
  deck: CardEntry[];
  passives: AdventurePassive[];
  treasuresTaken: string[];
  treasuresSkipped: number;
  pendingOffer: string[];
  offTypeUsed: boolean;
  stolen: CardEntry[];
  cardsStolen: number;
  seed: string;
}

export type RunEvent =
  | { type: "offer"; offer: string[] }
  | { type: "heartLost"; hearts: number }
  | { type: "runWon" }
  | { type: "runLost" };

export type TreasureChoice = { treasureId: string } | { skip: true };

export interface DeckEdit {
  /** Cards taken out of the deck for the rest of the run. */
  remove: CardEntry[];
  /** Basic Energy cards set to these counts (0 removes the type). */
  energies: { cardId: string; qty: number }[];
}

export interface AchievementFacts {
  won: boolean;
  difficulty: Difficulty;
  starterId: string;
  flawless: boolean;
  purist: boolean;
  monotype: boolean;
}

/** An action outside its run phase (HTTP 409). */
export class RunPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunPhaseError";
  }
}

/** An action that breaks a run rule (HTTP 422). */
export class RunRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRuleError";
  }
}
