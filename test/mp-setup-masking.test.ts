/**
 * Setup is face down: until both players are ready, the opponent's Active and Bench reach a
 * player as `{ id, hidden: true }` (no name, not even in the id) and the log hides what they
 * placed. Spectators see neither side; owners see their own Pokémon.
 */
import { describe, expect, it } from "vitest";
import { getDeckById, initializeMultiplayerGame, isPokemonCard, startGame, type GameCard } from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";

function setupRoom() {
  const manager = new GameRoomManager();
  const state = startGame(initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!));
  const basics = state.playerHand.filter((card: GameCard) => isPokemonCard(card) && card.stage === "basic");
  // Two Basics in player 1's opening hand: the first goes Active, the second to the Bench
  const otherCards = state.playerHand.filter((card: GameCard) => !basics.includes(card));
  const [active, benched] = [basics[0], basics[1] ?? state.playerDeck.find((card: GameCard) => isPokemonCard(card) && card.stage === "basic" && card !== basics[0])!];
  const room = manager.createRoom();
  Object.assign(room, {
    player1SocketId: "s1",
    player2SocketId: "s2",
    status: "playing",
    gameState: { ...state, playerHand: [active, benched, ...otherCards.slice(0, 5)] },
  });
  return { manager, room, active, benched };
}

describe("multiplayer setup is face down", () => {
  it("hides player 1's Pokémon from player 2 and spectators until the reveal", async () => {
    const { manager, room, active, benched } = setupRoom();
    expect((await manager.executeAction(room.id, "s1", { type: "playBasicToActive", payload: { cardId: active.id } })).success).toBe(true);
    expect((await manager.executeAction(room.id, "s1", { type: "playBasicToBench", payload: { cardId: benched.id } })).success).toBe(true);

    for (const viewer of ["player2", "spectator"] as const) {
      const seen = maskGameStateForPlayer(room.gameState!, viewer) as Record<string, unknown>;
      const p1Active = viewer === "player2" ? seen.opponentActivePokemon : seen.playerActivePokemon;
      const p1Bench = viewer === "player2" ? seen.opponentBench : seen.playerBench;
      expect(p1Active).toEqual({ id: expect.stringMatching(/^hidden-/), hidden: true });
      expect(p1Bench).toEqual([{ id: expect.stringMatching(/^hidden-/), hidden: true }]);
      const text = JSON.stringify(seen.events);
      expect(text).not.toContain(active.name);
      expect(text).not.toContain(benched.name);
      expect(text).toContain("colocó un Pokémon como Pokémon activo");
      expect(text).toContain("colocó un Pokémon en la banca");
    }

    const own = maskGameStateForPlayer(room.gameState!, "player1") as Record<string, any>;
    expect(own.playerActivePokemon.pokemon.name).toBe(active.name);
    expect(own.playerBench[0].pokemon.name).toBe(benched.name);
    expect(JSON.stringify(own.events)).toContain(`colocó ${active.name} como Pokémon activo`);
  });

  it("shows the board once the game is playing", async () => {
    const { manager, room, active } = setupRoom();
    await manager.executeAction(room.id, "s1", { type: "playBasicToActive", payload: { cardId: active.id } });
    room.gameState = { ...room.gameState!, gamePhase: "PLAYING" };
    const seen = maskGameStateForPlayer(room.gameState!, "player2") as Record<string, any>;
    expect(seen.opponentActivePokemon.pokemon.name).toBe(active.name);
  });
});
