/**
 * The adventure rooms' engine: game-core's adventure API (0.10.0). Registered at boot
 * (`setAdventureEngine(gameCoreAdventureEngine)` in index.ts).
 */
import {
  aiStepActionType,
  applyAIStep,
  createAdventureGame,
  createSeededRng,
  hashSeed,
  nextAIStep,
  takeLuckyCoin,
  type AIPlanState,
  type AIStep,
} from "@gonzaloaguila/game-core";
import type { AdventureEngine } from "./adventure-engine.js";

export const gameCoreAdventureEngine: AdventureEngine = {
  hashSeed,
  createRng: (seed, state) => createSeededRng(seed, state),
  createGame: (config) => createAdventureGame(config),
  // The AI never plays a Trainer whose steps the human answers (Erika, Treaty, Quiz) nor Misty's Duel:
  // the battle page has no flow for pendingOpponentTrainerStep (none of them is in Adventure 1)
  nextAIStep: (state, plan) => nextAIStep(state, plan as AIPlanState | null, { otherPlayerAnswersByHuman: false, otherPlayerDuels: false }),
  applyAIStep: (state, step, { flip, onCoins }) =>
    applyAIStep(state, step as AIStep, {
      flip,
      onCoins: (record) => onCoins({ label: record.label, results: record.results, flippedBy: record.flippedBy }),
    }),
  stepDelay: (step) => (step as AIStep).delay,
  stepActionType: (step) => aiStepActionType(step as AIStep),
  takeLuckyCoin: (state, side) => takeLuckyCoin(state, side),
  // The AI executor writes its lines from the human's view ("Rival…", "No tienes más Pokémon")
  aiEventsSpeakFor: "human",
};
