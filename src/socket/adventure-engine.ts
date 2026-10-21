/**
 * The engine calls of an adventure battle room, behind one interface: game-core 0.10.0's
 * adventure API (createAdventureGame, createSeededRng / hashSeed, the AI driver nextAIStep /
 * applyAIStep, takeLuckyCoin). adventure-room.ts only talks to this; the implementation is
 * registered at boot (`setAdventureEngine`) and tests may register their own.
 *
 * Every call happens inside the room's `withRoomRandom` (seeded Math.random), synchronously.
 */
import type { GameState } from "@gonzaloaguila/game-core";
import type { AdventureGameConfig } from "../modules/adventure/engine-types.js";

export type Coin = "heads" | "tails";

/** A seeded generator whose state can be persisted (game-core createSeededRng). */
export interface SeededRng {
  next(): number;
  state(): number;
}

/** Coins the AI flipped while applying one step (game-core AICoinRecord). */
export interface AICoins {
  /** Caption: the attack's / Trainer's / power's name, "Confusión"… */
  label: string;
  results: Coin[];
  /** Who flipped each coin, relative to the AI ("self") — omitted: all the AI's. */
  flippedBy?: ("self" | "opponent")[];
}

/** One thing the AI seat does now (opaque to the room; plain JSON). */
export type AIStep = unknown;
/** The AI's plan between steps (queued actions of its turn; plain JSON, persisted). */
export type AIPlan = unknown;

export interface AdventureEngine {
  hashSeed(text: string): number;
  createRng(seed: number, state?: number): SeededRng;
  /** A battle in its opening (MULLIGAN), human = "player". */
  createGame(config: AdventureGameConfig): GameState;
  /** What the AI (the "opponent" side) must do now, or null when the human must act / it's over. */
  nextAIStep(state: GameState, plan: AIPlan | null): { step: AIStep; plan: AIPlan | null } | null;
  applyAIStep(state: GameState, step: AIStep, options: { flip: () => Coin; onCoins: (coins: AICoins) => void }): GameState;
  /** Pause before the step (ms), for the player to follow the AI's turn. */
  stepDelay(step: AIStep): number;
  /** The `opponentAction.type` the client animates for the step ("attack", "playTrainer"…). */
  stepActionType(step: AIStep): string;
  /** The side's lucky coin if it has the passive and hasn't used it (state marks it used). */
  takeLuckyCoin(state: GameState, side: "player" | "opponent"): { state: GameState; coin: "heads" } | null;
  /**
   * Whose second person ("Jugaste…", "Tu turno") the log lines of an AI step use: the AI's
   * ("ai": neutralized as Jugador 2) or the human's ("human": as Jugador 1).
   */
  aiEventsSpeakFor: "ai" | "human";
}

let engine: AdventureEngine | null = null;

export function setAdventureEngine(next: AdventureEngine | null): void {
  engine = next;
}

export function getAdventureEngine(): AdventureEngine | null {
  return engine;
}
