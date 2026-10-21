import { describe, expect, it } from "vitest";
import { ALL_CARDS, GamePhase, getDeckById, initializeMultiplayerGame, type GameState } from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";

const card = (name: string, id: string) => ({ ...ALL_CARDS.find((c) => c.name === name)!, id });
const inPlay = (name: string, id: string, damage = 0) => ({
  pokemon: card(name, id),
  attachedEnergy: [],
  attachedTrainers: [],
  previousEvolutions: [],
  currentDamage: damage,
  statusConditions: [],
  playedOnTurn: 0,
});

/** Player 1's turn: Poké Ball and Bill in hand, a damaged Active and Vileplume (Heal) on the Bench. */
function roomWithGame(manager: GameRoomManager) {
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const state = {
    ...base,
    gamePhase: GamePhase.Playing,
    isPlayerTurn: true,
    turnNumber: 3,
    playerHand: [card("Poké Ball", "pb"), card("Bill", "bill")],
    playerActivePokemon: inPlay("Pikachu", "pika", 20),
    playerBench: [inPlay("Vileplume", "vile")],
    opponentActivePokemon: inPlay("Pikachu", "their-pika"),
    events: [],
  } as unknown as GameState;
  const room = manager.createRoom();
  Object.assign(room, { player1SocketId: "s1", player2SocketId: "s2", status: "playing", gameState: state });
  return room;
}

describe("server-rolled coins for Trainers and powers (requestCoinFlip)", () => {
  it("only the player whose turn it is can request them, for a card that flips", () => {
    const manager = new GameRoomManager();
    const room = roomWithGame(manager);
    expect(manager.requestCoinFlip(room.id, "s2", { purpose: "trainer", cardId: "pb" })).toEqual({ success: false, error: "No es tu turno" });
    expect(manager.requestCoinFlip(room.id, "intruder", { purpose: "trainer", cardId: "pb" }).success).toBe(false);
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "bill" })).toEqual({ success: false, error: "Esta carta no lanza monedas" });
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "ghost" })).toEqual({ success: false, error: "La carta no está en tu mano" });
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "pb" }).success).toBe(true);
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "power", pokemonId: "vile" }).success).toBe(true);
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "power", pokemonId: "pika" }).success).toBe(false);
  });

  it("asking again returns the same coins (no re-rolls)", () => {
    const manager = new GameRoomManager();
    const room = roomWithGame(manager);
    const trainer = manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "pb" });
    const power = manager.requestCoinFlip(room.id, "s1", { purpose: "power", pokemonId: "vile" });
    for (let i = 0; i < 20; i++) {
      expect(manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "pb" })).toEqual(trainer);
      expect(manager.requestCoinFlip(room.id, "s1", { purpose: "power", pokemonId: "vile" })).toEqual(power);
    }
  });

  it("power coins are per turn; Trainer coins stay with the card", () => {
    const flips: Array<"heads" | "tails"> = ["heads", "tails", "tails"];
    const manager = new GameRoomManager(() => flips.shift()!);
    const room = roomWithGame(manager);
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "pb" })).toMatchObject({ results: ["heads"] });
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "power", pokemonId: "vile" })).toMatchObject({ results: ["tails"] });
    room.gameState!.turnNumber = 5; // player 1's next turn
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "power", pokemonId: "vile" })).toMatchObject({ results: ["tails"] });
    expect(flips).toHaveLength(0);
    expect(manager.requestCoinFlip(room.id, "s1", { purpose: "trainer", cardId: "pb" })).toMatchObject({ results: ["heads"] });
  });
});
