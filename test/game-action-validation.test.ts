import { describe, expect, it } from "vitest";
import { getDeckById, initializeMultiplayerGame, baseSetCards, jungleCards, type GameState } from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";

const allCards = [...baseSetCards, ...jungleCards];
const byName = (name: string) => {
  const card = allCards.find((c) => c.name === name);
  if (!card) throw new Error(`card ${name} not found`);
  return card;
};
const pikachu = byName("Pikachu");
const vileplume = byName("Vileplume");
const lightning = baseSetCards.find((c) => c.id.endsWith("lightning-energy"))!;

function inPlay(card: typeof pikachu, id: string, extra: Record<string, unknown> = {}) {
  return {
    pokemon: { ...card, id },
    attachedEnergy: [{ ...lightning, id: `${id}-energy` }],
    attachedTrainers: [],
    previousEvolutions: [],
    currentDamage: 0,
    statusConditions: [],
    playedOnTurn: 0,
    ...extra,
  };
}

function setup(overrides: Partial<Record<keyof GameState, unknown>> = {}) {
  const manager = new GameRoomManager();
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const gameState = {
    ...base,
    gamePhase: "PLAYING",
    gameStarted: true,
    isPlayerTurn: true,
    turnNumber: 4,
    playerActivePokemon: inPlay(pikachu, "p1-pika", { currentDamage: 30 }),
    opponentActivePokemon: inPlay(pikachu, "p2-pika"),
    playerBench: [],
    opponentBench: [inPlay(pikachu, "p2-bench")],
    ...overrides,
  } as unknown as GameState;
  const room = manager.createRoom();
  Object.assign(room, { player1SocketId: "s1", player2SocketId: "s2", status: "playing", gameState });
  return { manager, room };
}

describe("executeAction rejects malformed actions before touching the game", () => {
  const malformed: Array<[string, unknown]> = [
    ["attack with string index", { type: "attack", payload: { attackIndex: "0" } }],
    ["attack without payload", { type: "attack" }],
    ["unknown action type", { type: "winGame", payload: {} }],
    ["retreat with huge energy list", { type: "retreat", payload: { energyIdsToDiscard: Array(5000).fill("e"), benchIndex: 0 } }],
    ["playTrainer with flat selections", { type: "playTrainer", payload: { cardId: "x", trainerName: "Potion", selections: ["p1-pika"] } }],
    ["usePower with unknown power", { type: "usePower", payload: { powerType: "drawAll", pokemonId: "p1-pika" } }],
    ["null action", null],
  ];

  it.each(malformed)("%s", async (_label, action) => {
    const { manager, room } = setup();
    const before = room.gameState;
    const result = await manager.executeAction(room.id, "s1", action as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid/i);
    expect(room.gameState).toBe(before);
  });

  it("still accepts the real client's endTurn", async () => {
    const { manager, room } = setup();
    const result = await manager.executeAction(room.id, "s1", { type: "endTurn", payload: {} });
    expect(result.success).toBe(true);
    expect(room.gameState?.isPlayerTurn).toBe(false);
  });
});

describe("playTrainer: the trainer that runs is the card in hand, not the client's trainerName", () => {
  it("rejects a Potion played as Bill", async () => {
    const potion = { ...byName("Potion"), id: "potion-1" };
    const { manager, room } = setup();
    room.gameState!.playerHand = [potion, ...room.gameState!.playerHand.slice(0, 3)];
    const handBefore = room.gameState!.playerHand.length;
    const result = await manager.executeAction(room.id, "s1", {
      type: "playTrainer",
      payload: { cardId: "potion-1", trainerName: "Bill", selections: [] },
    });
    expect(result.success).toBe(false);
    expect(room.gameState!.playerHand).toHaveLength(handBefore);
  });

  it("plays a real Bill", async () => {
    const bill = { ...byName("Bill"), id: "bill-1" };
    const { manager, room } = setup();
    room.gameState!.playerHand = [bill, ...room.gameState!.playerHand.slice(0, 3)];
    const handBefore = room.gameState!.playerHand.length;
    const result = await manager.executeAction(room.id, "s1", {
      type: "playTrainer",
      payload: { cardId: "bill-1", trainerName: "Bill", selections: [] },
    });
    expect(result.success).toBe(true);
    expect(room.gameState!.playerHand).toHaveLength(handBefore - 1 + 2);
  });

  it("rejects a card that isn't in the acting player's hand", async () => {
    const { manager, room } = setup();
    const result = await manager.executeAction(room.id, "s1", {
      type: "playTrainer",
      payload: { cardId: "ghost", trainerName: "Bill", selections: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe("usePower healFlip needs a Pokémon that can actually use Heal", () => {
  function forceHeads(room: ReturnType<typeof setup>["room"]) {
    room.pendingCoinFlips = { player1: { purpose: "healFlip", result: "heads", turnNumber: room.gameState!.turnNumber } };
  }

  it("rejects healing with a Pokémon that has no Heal power", async () => {
    const { manager, room } = setup();
    forceHeads(room);
    const result = await manager.executeAction(room.id, "s1", {
      type: "usePower",
      payload: { powerType: "healFlip", pokemonId: "p1-pika", targetPokemonId: "p1-pika" },
    });
    expect(result.success).toBe(false);
    expect(room.gameState!.playerActivePokemon!.currentDamage).toBe(30);
  });

  it("heals once with a real Vileplume, then refuses a second use the same turn", async () => {
    const { manager, room } = setup({ playerBench: [inPlay(vileplume, "p1-vile")] });
    forceHeads(room);
    const first = await manager.executeAction(room.id, "s1", {
      type: "usePower",
      payload: { powerType: "healFlip", pokemonId: "p1-vile", targetPokemonId: "p1-pika" },
    });
    expect(first.success).toBe(true);
    expect(room.gameState!.playerActivePokemon!.currentDamage).toBe(20);

    forceHeads(room);
    const second = await manager.executeAction(room.id, "s1", {
      type: "usePower",
      payload: { powerType: "healFlip", pokemonId: "p1-vile", targetPokemonId: "p1-pika" },
    });
    expect(second.success).toBe(false);
    expect(room.gameState!.playerActivePokemon!.currentDamage).toBe(20);
  });
});
