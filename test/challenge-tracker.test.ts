/**
 * The challenge tracker of a multiplayer room (socket/challenge-tracker.ts): both decks as played,
 * and per seat the largest prize deficit, Bench use, the biggest attack hit and the Pokémon that
 * dealt the winning Knock Out; at the end, how the game ended. States are player 1's view.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getDeckById,
  initializeMultiplayerGame,
  type AttackHit,
  type GameCard,
  type GameState,
  type PokemonInPlay,
} from "@gonzaloaguila/game-core";
import { createChallengeTracker, finishTracker, observe } from "../src/socket/challenge-tracker.js";
import { GameRoomManager } from "../src/socket/rooms.js";

function byName(name: string): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name);
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

/** A dealt game (Zap vs Overgrowth), 6 Prizes each, PLAYING on player 1's turn. */
function dealt(): GameState {
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const p = [...base.playerDeck];
  const o = [...base.opponentDeck];
  return {
    ...base,
    gamePhase: GamePhase.Playing,
    gameStarted: true,
    turnNumber: 3,
    isPlayerTurn: true,
    playerHand: p.splice(0, 7),
    playerPrizes: p.splice(0, 6),
    playerDeck: p,
    opponentHand: o.splice(0, 7),
    opponentPrizes: o.splice(0, 6),
    opponentDeck: o,
    playerActivePokemon: null,
    opponentActivePokemon: null,
    playerBench: [],
    opponentBench: [],
  } as GameState;
}

const hit = (over: Partial<AttackHit>): AttackHit => ({ attackerSide: "player", attackerName: "Pikachu", attackName: "Roer", damage: 10, turn: 3, seq: 1, ...over });
const sources = { player1: "user", player2: "user" } as const;

describe("challenge tracker", () => {
  it("snapshots both decks with their sources", () => {
    const tracker = createChallengeTracker(dealt(), { player1: "user", player2: "theme" });
    const total = (cards: { qty: number }[]) => cards.reduce((n, c) => n + c.qty, 0);
    expect(tracker.decks.player1.source).toBe("user");
    expect(tracker.decks.player2.source).toBe("theme");
    expect(total(tracker.decks.player1.cards)).toBe(60);
    expect(total(tracker.decks.player2.cards)).toBe(60);
    expect(tracker.decks.player1.cards.every((c) => ALL_CARDS.some((card) => card.id === c.cardId))).toBe(true);
  });

  it("tracks the biggest hit per seat, player 2 included", () => {
    const start = dealt();
    const tracker = createChallengeTracker(start, sources);
    const a = { ...start, lastAttackHit: hit({ attackerSide: "opponent", damage: 120, seq: 1 }) };
    observe(tracker, start, a, { type: "attack" });
    const b = { ...a, lastAttackHit: hit({ attackerSide: "player", damage: 30, seq: 2 }) };
    observe(tracker, a, b, { type: "attack" });
    // The same hit seen again (another action) doesn't count twice nor change sides
    observe(tracker, b, { ...b }, { type: "endTurn" });
    const { feats } = finishTracker(tracker, b, null);
    expect(feats.player2.maxAttackDamage).toBe(120);
    expect(feats.player1.maxAttackDamage).toBe(30);
  });

  it("credits the winning KO's attacker to the winner", () => {
    const start = { ...dealt(), playerActivePokemon: inPlay("Parasect", "p1-a"), opponentActivePokemon: inPlay("Pikachu", "p2-a") };
    const tracker = createChallengeTracker(start, sources);
    const over = {
      ...start,
      gamePhase: GamePhase.GameOver,
      gameResult: "victory",
      opponentActivePokemon: null,
      opponentBench: [],
      lastAttackHit: hit({ attackerName: "Parasect", damage: 40 }),
    } as GameState;
    observe(tracker, start, over, { type: "attack" });
    const result = finishTracker(tracker, over, "player1");
    expect(result.endKind).toBe("no_pokemon");
    expect(result.feats.player1.finalKoBy).toBe("Parasect");
    expect(result.feats.player2.finalKoBy).toBeNull();
  });

  it("an attack followed by the rival's deck-out is no winning KO", () => {
    const start = { ...dealt(), playerActivePokemon: inPlay("Magikarp", "p1-a"), opponentActivePokemon: inPlay("Chansey", "p2-a") };
    const tracker = createChallengeTracker(start, sources);
    // The attack's endTurn makes the rival draw from an empty deck: game over in the same action
    const over = { ...start, gamePhase: GamePhase.GameOver, gameResult: "victory", opponentDeck: [], lastAttackHit: hit({ attackerName: "Magikarp", damage: 10 }) } as GameState;
    observe(tracker, start, over, { type: "attack" });
    const result = finishTracker(tracker, over, "player1");
    expect(result.endKind).toBe("deck_out");
    expect(result.feats.player1.finalKoBy).toBeNull();
    expect(result.feats.player1.maxAttackDamage).toBe(10);
  });

  it("keeps the largest prize deficit and the prizes the rival took", () => {
    const start = dealt();
    const tracker = createChallengeTracker(start, sources);
    const behind = { ...start, opponentPrizes: start.opponentPrizes.slice(0, 2) }; // player 2 took 4
    observe(tracker, start, behind, { type: "takePrize" });
    const back = { ...behind, playerPrizes: start.playerPrizes.slice(0, 1) }; // player 1 took 5
    observe(tracker, behind, back, { type: "takePrize" });
    const { feats } = finishTracker(tracker, back, null);
    expect(feats.player1.maxPrizeDeficit).toBe(4);
    expect(feats.player2.maxPrizeDeficit).toBe(1);
    expect(feats.player1.prizesTakenByRival).toBe(4);
    expect(feats.player2.prizesTakenByRival).toBe(5);
  });

  it("marks Bench use during setup", () => {
    const setup = { ...dealt(), gamePhase: GamePhase.Mulligan };
    const tracker = createChallengeTracker(setup, sources);
    const benched = { ...setup, playerBench: [inPlay("Pikachu", "p1-b")] };
    observe(tracker, setup, benched, { type: "playBasicToBench" });
    const { feats } = finishTracker(tracker, benched, null);
    expect(feats.player1.benchUsed).toBe(true);
    expect(feats.player2.benchUsed).toBe(false);
  });

  it("ends as prizes, no_pokemon or deck_out from the final state", () => {
    const start = { ...dealt(), playerActivePokemon: inPlay("Pikachu", "p1-a"), opponentActivePokemon: inPlay("Pikachu", "p2-a") };
    const end = (over: Partial<GameState>, winner: "player1" | "player2") => {
      const tracker = createChallengeTracker(start, sources);
      const final = { ...start, gamePhase: GamePhase.GameOver, gameResult: winner === "player1" ? "victory" : "defeat", ...over } as GameState;
      observe(tracker, start, final, { type: "endTurn" });
      return finishTracker(tracker, final, winner).endKind;
    };
    expect(end({ playerPrizes: [] }, "player1")).toBe("prizes");
    expect(end({ playerActivePokemon: null, playerBench: [] }, "player2")).toBe("no_pokemon");
    expect(end({ opponentDeck: [] }, "player1")).toBe("deck_out");
  });

  it("a surrender, a disconnect or a dropped game is not a played end", () => {
    const start = dealt();
    const surrendered = createChallengeTracker(start, sources);
    const over = { ...start, gamePhase: GamePhase.GameOver, gameResult: "victory", opponentPrizes: [] } as GameState;
    observe(surrendered, start, over, { type: "surrender" });
    expect(finishTracker(surrendered, over, "player1").endKind).toBe("forfeit");

    const left = createChallengeTracker(start, sources);
    expect(finishTracker(left, start, "player2").endKind).toBe("forfeit");
    expect(finishTracker(left, start, null).endKind).toBe("interrupted");
    expect(finishTracker(left, start, "draw").endKind).toBe("draw");
    expect(finishTracker(left, { ...start, turnNumber: 7 }, null).finalTurn).toBe(7);
  });
});

describe("challenge tracker in a room", () => {
  function seatedRoom() {
    const manager = new GameRoomManager(() => "heads");
    const r = manager.createRoom();
    Object.assign(r, { player1Id: "p1", player2Id: "p2", players: ["p1", "p2"], player1SocketId: "s1", player2SocketId: "s2" });
    return { manager, room: r };
  }

  it("each game of a room starts a fresh tracker with its deck sources", async () => {
    const { manager, room } = seatedRoom();
    await manager.startGame(room.id, undefined, { player1: "theme", player2: "theme" });
    const first = room.challengeTracker;
    expect(first?.decks.player1.source).toBe("theme");
    await manager.startGame(room.id, undefined, { player1: "fallback", player2: "theme" });
    expect(room.challengeTracker).not.toBe(first);
    expect(room.challengeTracker?.decks.player1.source).toBe("fallback");
  });

  it("a draft game's decks are draft decks", async () => {
    const { manager, room } = seatedRoom();
    const zap = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
    await manager.startGameWithRawDecks(room.id, zap.playerDeck, zap.opponentDeck, 6);
    expect(room.challengeTracker?.decks.player1.source).toBe("draft");
    expect(room.challengeTracker?.decks.player2.source).toBe("draft");
  });

  it("every committed action is observed (Bench use of player 2)", async () => {
    const { manager, room } = seatedRoom();
    const base = dealt();
    const basic = base.opponentDeck.find((c) => c.kind === "pokemon" && c.stage === "basic");
    expect(basic).toBeDefined();
    const start = {
      ...base,
      isPlayerTurn: false,
      playerActivePokemon: inPlay("Pikachu", "p1-a"),
      opponentActivePokemon: inPlay("Pikachu", "p2-a"),
      opponentHand: [...base.opponentHand, basic!],
      opponentDeck: base.opponentDeck.filter((c) => c !== basic),
    } as GameState;
    Object.assign(room, { status: "playing", gameState: start, turnStartedAt: Date.now() });
    room.challengeTracker = createChallengeTracker(start, sources);
    const result = await manager.executeAction(room.id, "s2", { type: "playBasicToBench", payload: { cardId: basic!.id } });
    expect(result.success, result.error).toBe(true);
    const { feats } = finishTracker(room.challengeTracker!, room.gameState, null);
    expect(feats.player2.benchUsed).toBe(true);
    expect(feats.player1.benchUsed).toBe(false);
  });
});
