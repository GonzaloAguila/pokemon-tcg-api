import { describe, expect, it } from "vitest";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";

const card = (id: string) => ({ id, name: `Card ${id}`, kind: "pokemon" });

const state = {
  playerHand: [card("p1-h1"), card("p1-h2")],
  playerDeck: [card("p1-d1"), card("p1-d2"), card("p1-d3")],
  playerPrizes: [card("p1-p1")],
  playerDiscard: [card("p1-x1")],
  opponentHand: [card("p2-h1")],
  opponentDeck: [card("p2-d1"), card("p2-d2")],
  opponentPrizes: [card("p2-p1"), card("p2-p2")],
  opponentDiscard: [card("p2-x1")],
  isPlayerTurn: true,
  events: [],
};

const ids = (cards: unknown) => (cards as { id: string }[]).map((c) => c.id);
const isHidden = (cards: unknown) => (cards as Record<string, unknown>[]).every((c) => c.hidden === true && !("name" in c));

describe("maskGameStateForPlayer", () => {
  it("player 1 keeps their own zones and only sees counts of player 2's", () => {
    const view = maskGameStateForPlayer(state, "player1");
    expect(ids(view.playerHand)).toEqual(["p1-h1", "p1-h2"]);
    expect(isHidden(view.opponentHand)).toBe(true);
    expect(isHidden(view.opponentDeck)).toBe(true);
    expect(isHidden(view.opponentPrizes)).toBe(true);
    expect((view.opponentHand as unknown[]).length).toBe(1);
    expect((view.opponentDeck as unknown[]).length).toBe(2);
    expect((view.opponentPrizes as unknown[]).length).toBe(2);
    expect(ids(view.opponentDiscard)).toEqual(["p2-x1"]); // discard is public
  });

  it("player 2 sees their own cards as 'player' and player 1's as hidden", () => {
    const view = maskGameStateForPlayer(state, "player2");
    expect(ids(view.playerHand)).toEqual(["p2-h1"]);
    expect(isHidden(view.opponentHand)).toBe(true);
    expect((view.opponentHand as unknown[]).length).toBe(2);
    expect(view.isPlayerTurn).toBe(false);
  });

  it("spectators see no hand, deck or prize contents", () => {
    const view = maskGameStateForPlayer(state, "spectator");
    for (const key of ["playerHand", "playerDeck", "playerPrizes", "opponentHand", "opponentDeck", "opponentPrizes"]) {
      expect(isHidden(view[key])).toBe(true);
    }
  });

  it("does not mutate the stored state", () => {
    maskGameStateForPlayer(state, "spectator");
    expect(ids(state.opponentHand)).toEqual(["p2-h1"]);
  });
});
