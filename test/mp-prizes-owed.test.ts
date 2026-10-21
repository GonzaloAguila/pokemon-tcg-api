/**
 * Prizes owed are a count since game-core 0.10.2 (prizesOwed / playerPrizesOwed): takePrize is
 * accepted once per Prize owed, consecutive picks included, and the turn only ends with the
 * last one. A takePrize with nothing owed (a double click, a stale board, after the last Prize
 * won the game) is answered quietly with NO_PRIZE_OWED_CODE (handlers.ts sends no error toast).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getDeckById,
  initializeMultiplayerGame,
  prizesOwed,
  type GameCard,
  type GameState,
  type PokemonInPlay,
} from "@gonzaloaguila/game-core";
import { GameRoomManager, NO_PRIZE_OWED_CODE } from "../src/socket/rooms.js";

const S1 = "sock-1";
const S2 = "sock-2";

function byName(name: string): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === "Base Set");
  if (!found) throw new Error(`card ${name} not in catalog`);
  return found as GameCard;
}

function inPlay(name: string, id: string): PokemonInPlay {
  return {
    pokemon: { ...byName(name), id },
    attachedEnergy: [],
    attachedTrainers: [],
    previousEvolutions: [],
    currentDamage: 0,
    statusConditions: [],
    playedOnTurn: 0,
  } as unknown as PokemonInPlay;
}

/** A PLAYING game in player 1's perspective, on player 1's turn, after their attack. */
function room(board: Partial<GameState> = {}) {
  const manager = new GameRoomManager(() => "heads");
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const state = {
    ...base,
    gamePhase: GamePhase.Playing,
    gameStarted: true,
    turnNumber: 5,
    isPlayerTurn: true,
    startingPlayer: "player",
    playerReady: true,
    opponentReady: true,
    attackedThisTurn: true,
    playerActivePokemon: inPlay("Pikachu", "p1-active"),
    playerBench: [],
    playerHand: [],
    playerDeck: base.playerDeck.slice(0, 20),
    playerPrizes: base.playerDeck.slice(20, 26),
    playerDiscard: [],
    opponentActivePokemon: inPlay("Pikachu", "p2-active"),
    opponentBench: [],
    opponentHand: base.opponentDeck.slice(0, 5),
    opponentDeck: base.opponentDeck.slice(5, 25),
    opponentPrizes: base.opponentDeck.slice(25, 31),
    opponentDiscard: [],
    activeModifiers: [],
    events: [],
    ...board,
  } as unknown as GameState;
  const r = manager.createRoom();
  Object.assign(r, {
    player1Id: "p1",
    player2Id: "p2",
    players: ["p1", "p2"],
    player1SocketId: S1,
    player2SocketId: S2,
    status: "playing",
    gameState: state,
    turnStartedAt: Date.now(),
  });
  const take = (socket: string, prizeIndex = 0) => manager.executeAction(r.id, socket, { type: "takePrize", payload: { prizeIndex } });
  return { manager, room: r, take };
}

const quiet = { success: false, code: NO_PRIZE_OWED_CODE, error: "No tienes premios por tomar" };

describe("takePrize with Prizes owed as a count", () => {
  it("two Prizes owed: two consecutive picks, the turn ends with the second; a third is answered quietly", async () => {
    const t = room({ playerCanTakePrize: true, playerPrizesOwed: 2 } as Partial<GameState>);

    const first = await t.take(S1, 3);
    expect(first.success, first.error).toBe(true);
    let s = t.room.gameState!;
    expect(s.playerPrizes).toHaveLength(5);
    expect(prizesOwed(s, "player")).toBe(1);
    expect(s.isPlayerTurn).toBe(true); // still waiting for the second Prize

    const second = await t.take(S1, 0);
    expect(second.success, second.error).toBe(true);
    s = t.room.gameState!;
    expect(s.playerPrizes).toHaveLength(4);
    expect(prizesOwed(s, "player")).toBe(0);
    expect(s.isPlayerTurn).toBe(false); // nothing else pending: the attacker's turn is over

    // The double click: nothing changes, no alarming error
    const before = t.room.gameState;
    expect(await t.take(S1, 0)).toEqual(quiet);
    expect(t.room.gameState).toBe(before);
  });

  it("the off-turn side takes its Prize (player 2) and a repeat is answered quietly", async () => {
    const t = room({ opponentCanTakePrize: true, attackedThisTurn: false } as Partial<GameState>);
    const taken = await t.take(S2, 0);
    expect(taken.success, taken.error).toBe(true);
    expect(t.room.gameState!.opponentPrizes).toHaveLength(5);
    expect(prizesOwed(t.room.gameState!, "opponent")).toBe(0);
    expect(await t.take(S2, 0)).toEqual(quiet);
    // Player 1 owes nothing either
    expect(await t.take(S1, 0)).toEqual(quiet);
  });

  it("a takePrize after the last Prize won the game is answered quietly, not 'La partida ya terminó'", async () => {
    const t = room({ playerCanTakePrize: true, playerPrizesOwed: 1 } as Partial<GameState>);
    t.room.gameState = { ...t.room.gameState!, playerPrizes: t.room.gameState!.playerPrizes.slice(0, 1) };
    const won = await t.take(S1, 0);
    expect(won).toMatchObject({ success: true, gameOver: true, winner: "player1" });
    expect(await t.take(S1, 0)).toEqual(quiet);
    // Any other action still gets the plain answer
    expect(await t.manager.executeAction(t.room.id, S1, { type: "endTurn", payload: {} })).toEqual({ success: false, error: "La partida ya terminó" });
  });

  it("a stale Prize index is rejected in Spanish and the Prize stays owed", async () => {
    const t = room({ playerCanTakePrize: true, playerPrizesOwed: 1 } as Partial<GameState>);
    t.room.gameState = { ...t.room.gameState!, playerPrizes: t.room.gameState!.playerPrizes.slice(0, 2) };
    expect(await t.take(S1, 5)).toEqual({ success: false, error: "Ese premio ya no está: elige otro" });
    expect(prizesOwed(t.room.gameState!, "player")).toBe(1);
    expect((await t.take(S1, 1)).success).toBe(true);
  });

  it("other rejections speak Spanish (promotion, turn, seat)", async () => {
    const t = room();
    expect(await t.manager.executeAction(t.room.id, S1, { type: "promote", payload: { benchIndex: 0 } })).toEqual({
      success: false,
      error: "No necesitas promover un Pokémon",
    });
    expect(await t.manager.executeAction(t.room.id, S2, { type: "endTurn", payload: {} })).toEqual({ success: false, error: "No es tu turno" });
    expect(await t.manager.executeAction(t.room.id, "intruder", { type: "endTurn", payload: {} })).toEqual({ success: false, error: "No juegas en esta mesa" });
    expect(await t.manager.executeAction("NOPE00", S1, { type: "endTurn", payload: {} })).toEqual({ success: false, error: "La partida ya no existe" });
  });
});
