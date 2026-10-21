/**
 * A minimal AdventureEngine on game-core 0.9.0 primitives, for the adventure room's plumbing
 * tests until game-core 0.10.0's adventure API (createAdventureGame, the AI driver) is installed.
 * Its "AI" only sets up, readies, promotes, takes Prizes and ends its turns; passives other than
 * the lucky coin and battle modifiers are ignored.
 */
import {
  GamePhase,
  createGameEvent,
  doMulligan,
  endTurn,
  findCardById,
  isPokemonCard,
  playBasicPokemon,
  promoteActivePokemon,
  setPlayerReady,
  shuffle,
  startGame,
  startPlayingPhase,
  swapSides,
  takePrize,
  type GameCard,
  type GameState,
} from "@gonzaloaguila/game-core";
import type { AdventureEngine, SeededRng } from "../src/socket/adventure-engine.js";
import type { CardEntry } from "../src/modules/adventure/engine-types.js";

type StubStep = { kind: "place"; cardId: string } | { kind: "mulligan" } | { kind: "ready" } | { kind: "promote" } | { kind: "takePrize" } | { kind: "endTurn" };

function createRng(seed: number, state?: number): SeededRng {
  let a = (state ?? seed) >>> 0;
  return {
    next: () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state: () => a,
  };
}

function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

type Passives = { player?: string[]; luckyCoinUsed?: { player?: boolean } };
const passivesOf = (state: GameState) => (state as GameState & { passives?: Passives }).passives;

export function createStubEngine(): AdventureEngine & { stepsApplied: number } {
  const engine = {
    stepsApplied: 0,
    aiEventsSpeakFor: "ai" as const,
    hashSeed,
    createRng,
    createGame(config: { playerDeck: CardEntry[]; opponentDeck: CardEntry[]; prizeCount: number; playerPassives: string[] }): GameState {
      let n = 0;
      const cards = (entries: CardEntry[], side: string): GameCard[] =>
        entries.flatMap((e) => {
          const template = findCardById(e.cardId)!;
          return Array.from({ length: e.qty }, () => ({ ...template, id: `${side}-${template.name}-${n++}` }));
        });
      const state = {
        playerDeck: shuffle(cards(config.playerDeck, "p")),
        playerHand: [], playerPrizes: [], playerDiscard: [], playerActivePokemon: null, playerBench: [],
        opponentDeck: shuffle(cards(config.opponentDeck, "o")),
        opponentHand: [], opponentPrizes: [], opponentDiscard: [], opponentActivePokemon: null, opponentBench: [],
        selectedDeckId: "adventure", turnNumber: 0, startingPlayer: null, isPlayerTurn: false, gameStarted: false,
        gamePhase: GamePhase.Mulligan, playerReady: false, opponentReady: false, energyAttachedThisTurn: false,
        retreatedThisTurn: false, playerCanTakePrize: false, opponentCanTakePrize: false, playerNeedsToPromote: false,
        opponentNeedsToPromote: false, activeModifiers: [], gameResult: null,
        events: [createGameEvent("Aventura: batalla inicializada", "system")],
      } as GameState;
      return { ...startGame(state, { prizeCount: config.prizeCount }), passives: { player: [...config.playerPassives] } } as GameState;
    },
    nextAIStep(state: GameState, plan: unknown) {
      const step = ((): StubStep | null => {
        if (state.gamePhase === "GAME_OVER") return null;
        if (state.gamePhase === "MULLIGAN" || state.gamePhase === "SETUP") {
          if (state.opponentReady) return null;
          if (state.opponentActivePokemon) return { kind: "ready" };
          const basic = state.opponentHand.find((c) => isPokemonCard(c) && c.stage === "basic");
          return basic ? { kind: "place", cardId: basic.id } : { kind: "mulligan" };
        }
        if (state.opponentNeedsToPromote && state.opponentBench.length > 0) return { kind: "promote" };
        if (state.opponentCanTakePrize) return { kind: "takePrize" };
        if (!state.isPlayerTurn && !state.playerNeedsToPromote && !state.playerCanTakePrize) return { kind: "endTurn" };
        return null;
      })();
      return step ? { step, plan } : null;
    },
    applyAIStep(state: GameState, raw: unknown, options: { flip: () => "heads" | "tails"; onCoins: (c: { label: string; results: ("heads" | "tails")[] }) => void }) {
      const step = raw as StubStep;
      engine.stepsApplied += 1;
      switch (step.kind) {
        case "place":
          return swapSides(playBasicPokemon(swapSides(state), step.cardId, "active"));
        case "mulligan":
          return doMulligan(state, false);
        case "ready": {
          const ready = setPlayerReady(state, false);
          if (!ready.playerReady || !ready.opponentReady) return ready;
          const coin = options.flip();
          options.onCoins({ label: "Inicio", results: [coin] });
          return startPlayingPhase(ready, coin);
        }
        case "promote":
          return promoteActivePokemon(state, 0, false);
        case "takePrize":
          return takePrize(state, 0, false);
        case "endTurn":
          return swapSides(endTurn(swapSides(state), true));
      }
    },
    stepDelay: () => 0,
    stepActionType: (raw: unknown) => (raw as StubStep).kind,
    takeLuckyCoin(state: GameState, side: "player" | "opponent") {
      const passives = passivesOf(state);
      if (side !== "player" || !passives?.player?.includes("lucky_coin") || passives.luckyCoinUsed?.player) return null;
      return { state: { ...state, passives: { ...passives, luckyCoinUsed: { player: true } } } as GameState, coin: "heads" as const };
    },
  };
  return engine;
}
