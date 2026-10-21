import { describe, expect, it } from "vitest";
import { getDeckById, initializeMultiplayerGame, baseSetCards, jungleCards, type GameState } from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";

const pikachu = baseSetCards.find((c) => c.name === "Pikachu")!;
const lightning = baseSetCards.find((c) => c.name === "Lightning Energy" || c.id.endsWith("lightning-energy"))!;

function inPlay(id: string, extra: Record<string, unknown> = {}) {
  return {
    pokemon: { ...pikachu, id },
    attachedEnergy: [{ ...lightning, id: `${id}-energy` }],
    currentDamage: 0,
    statusConditions: [],
    turnPlayed: 0,
    ...extra,
  };
}

function roomWithConfusedAttacker(manager: GameRoomManager) {
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const gameState = {
    ...base,
    gamePhase: "PLAYING",
    gameStarted: true,
    isPlayerTurn: true,
    turnNumber: 4,
    playerActivePokemon: inPlay("p1-pika", { statusConditions: ["confused"] }),
    opponentActivePokemon: inPlay("p2-pika"),
    playerBench: [],
    opponentBench: [inPlay("p2-bench")],
  } as unknown as GameState;
  const room = manager.createRoom();
  Object.assign(room, { player1SocketId: "s1", player2SocketId: "s2", status: "playing", gameState });
  return room;
}

describe("confusion in multiplayer (server-flipped)", () => {
  it("tails: attack fails, 20 self-damage, coin broadcast; heads: the attack lands", async () => {
    const seen = { heads: false, tails: false };
    for (let i = 0; i < 60 && !(seen.heads && seen.tails); i++) {
      const manager = new GameRoomManager();
      const room = roomWithConfusedAttacker(manager);
      const result = await manager.executeAction(room.id, "s1", { type: "attack", payload: { attackIndex: 0 } });
      expect(result.success).toBe(true);
      const state = result.gameState as GameState;
      if (result.coinFlipInfo?.attackName === "Confusión") {
        seen.tails = true;
        expect(result.coinFlipInfo.results).toEqual(["tails"]);
        expect(state.playerActivePokemon?.currentDamage ?? 0).toBe(20);
        expect(state.opponentActivePokemon?.currentDamage ?? 0).toBe(0);
      } else {
        seen.heads = true;
        expect(state.opponentActivePokemon?.currentDamage ?? 0).toBeGreaterThan(0);
        expect(state.playerActivePokemon?.currentDamage ?? 0).toBe(0);
      }
    }
    expect(seen).toEqual({ heads: true, tails: true });
  });

  it("heads: the confusion coin is its own batch (confusionCoinFlipInfo), before the attack's coins", async () => {
    // Gnaw (no coins of its own): only the confusion coin is shown
    const flips: ("heads" | "tails")[] = ["heads"];
    const manager = new GameRoomManager(() => flips.shift()!);
    const room = roomWithConfusedAttacker(manager);
    const result = await manager.executeAction(room.id, "s1", { type: "attack", payload: { attackIndex: 0 } });
    expect(result.success).toBe(true);
    expect(result.confusionCoinFlipInfo).toEqual({ attackName: "Confusión", results: ["heads"] });
    expect(result.coinFlipInfo).toBeUndefined();
    expect(flips).toEqual([]);
  });

  it("heads with an attack that flips: both batches, the attack's coins untouched", async () => {
    const jolteon = jungleCards.find((c) => c.name === "Jolteon")!; // 1: Pin Missile, 4 coins
    const flips: ("heads" | "tails")[] = ["heads", "tails", "heads", "heads", "tails"];
    const manager = new GameRoomManager(() => flips.shift()!);
    const room = roomWithConfusedAttacker(manager);
    const state = room.gameState!;
    room.gameState = {
      ...state,
      playerActivePokemon: {
        ...state.playerActivePokemon!,
        pokemon: { ...jolteon, id: "p1-jolteon" },
        attachedEnergy: [0, 1, 2].map((i) => ({ ...lightning, id: `p1-e${i}` })),
      },
    } as GameState;
    const result = await manager.executeAction(room.id, "s1", { type: "attack", payload: { attackIndex: 1 } });
    expect(result.success).toBe(true);
    expect(result.confusionCoinFlipInfo).toEqual({ attackName: "Confusión", results: ["heads"] });
    expect(result.coinFlipInfo).toMatchObject({ attackName: jolteon.attacks[1].name, results: ["tails", "heads", "heads", "tails"] });
  });

  it("tails: only the confusion coin (coinFlipInfo), no separate batch", async () => {
    const manager = new GameRoomManager(() => "tails");
    const room = roomWithConfusedAttacker(manager);
    const result = await manager.executeAction(room.id, "s1", { type: "attack", payload: { attackIndex: 0 } });
    expect(result.success).toBe(true);
    expect(result.coinFlipInfo).toEqual({ attackName: "Confusión", results: ["tails"] });
    expect(result.confusionCoinFlipInfo).toBeUndefined();
  });
});
