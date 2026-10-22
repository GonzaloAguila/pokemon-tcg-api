/**
 * Gym Challenge in multiplayer: Koga's Ninja Trick (the defender is asked before any coin; the
 * server flips the plan of the Pokémon that defends only after the answer), Rebellion's power
 * coins and the new defender coins (Fortitude, Energy Drain), Chaos Gym (coin, offer answered
 * off-turn by the other player who then plays the card on their view, answer clock), Sabrina's
 * Psychic Control (borrowed Trainer, decline), Rocket's Minefield Gym's coin on a Bench play,
 * Lt. Surge's Secret Plan (face-down card hidden from the opponent and spectators, flipFaceDown)
 * and Misty's Wish (the looked-at Prize only to its player). Every scenario runs as player 1 and
 * as player 2 (the state is stored in player 1's perspective; player 2 acts on a swapSides copy).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getAvailableAttacks,
  getDeckById,
  getTrainerSteps,
  initializeMultiplayerGame,
  isPokemonCard,
  swapSides,
  toInPlayCard,
  type GameCard,
  type GameState,
  type PokemonInPlay,
} from "@gonzaloaguila/game-core";
import { GameRoomManager, chaosOfferPlayer, offTurnAnswerer } from "../src/socket/rooms.js";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";

type Side = "p1" | "p2";
type Coin = "heads" | "tails";
type Masked = GameState & Record<string, any>;

const SOCKET = { p1: "s1", p2: "s2" } as const;
const VIEWER = { p1: "player1", p2: "player2" } as const;
const other = (side: Side): Side => (side === "p1" ? "p2" : "p1");

function byName(name: string, set = "Base Set"): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === set);
  if (!found) throw new Error(`card ${name} (${set}) not in catalog`);
  return found as GameCard;
}
const cardAs = (name: string, id: string, set?: string): GameCard => ({ ...byName(name, set), id });
const gc = (name: string, id: string): GameCard => cardAs(name, id, "Gym Challenge");

const ENERGY_NAME: Record<string, string> = {
  L: "Lightning Energy", W: "Water Energy", F: "Fighting Energy", G: "Grass Energy", P: "Psychic Energy",
};

function inPlay(card: GameCard, opts: { energy?: string; damage?: number; trainers?: GameCard[] } = {}): PokemonInPlay {
  return {
    pokemon: toInPlayCard(card),
    attachedEnergy: [...(opts.energy ?? "")].map((code, i) => cardAs(ENERGY_NAME[code], `${card.id}-e${i}`)),
    attachedTrainers: opts.trainers ?? [],
    previousEvolutions: [],
    currentDamage: opts.damage ?? 0,
    statusConditions: [],
    playedOnTurn: 0,
  } as unknown as PokemonInPlay;
}

interface Board {
  myActive?: PokemonInPlay;
  myBench?: PokemonInPlay[];
  myHand?: GameCard[];
  theirActive?: PokemonInPlay;
  theirBench?: PokemonInPlay[];
  theirHand?: GameCard[];
  theirDiscard?: GameCard[];
  stadium?: { card: GameCard; playedBy: "player" | "opponent" };
}

const isBasic = (c: GameCard) => isPokemonCard(c) && c.stage === "basic";

/** A PLAYING game where it is `actor`'s turn, built in the actor's perspective. Coins: a script (throws when it runs out). */
function setupGame(actor: Side, board: Board = {}, coins: Coin[] = []) {
  const queue = [...coins];
  const manager = new GameRoomManager(() => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected coin flip");
    return next;
  });
  const shuffled = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const basicsFirst = (cards: GameCard[]) => [...cards].sort((a, b) => Number(isBasic(b)) - Number(isBasic(a)));
  const base = { ...shuffled, playerDeck: basicsFirst(shuffled.playerDeck), opponentDeck: basicsFirst(shuffled.opponentDeck) };
  const view = {
    ...base,
    gamePhase: GamePhase.Playing,
    gameStarted: true,
    turnNumber: 5,
    isPlayerTurn: true,
    startingPlayer: "player",
    playerActivePokemon: board.myActive ?? inPlay(cardAs("Pikachu", "my-active"), { energy: "L" }),
    playerBench: board.myBench ?? [],
    playerHand: board.myHand ?? [],
    playerDeck: base.playerDeck.slice(0, 20),
    playerPrizes: base.playerDeck.slice(20, 26),
    playerDiscard: [],
    opponentActivePokemon: board.theirActive ?? inPlay(cardAs("Pikachu", "their-active"), { energy: "L" }),
    opponentBench: board.theirBench ?? [],
    opponentHand: board.theirHand ?? base.opponentDeck.slice(0, 5),
    opponentDeck: base.opponentDeck.slice(5, 25),
    opponentPrizes: base.opponentDeck.slice(25, 31),
    opponentDiscard: board.theirDiscard ?? [],
    energyAttachedThisTurn: false,
    activeModifiers: [],
    events: [],
    ...(board.stadium ? { stadium: board.stadium } : {}),
  } as unknown as GameState;

  const room = manager.createRoom();
  Object.assign(room, {
    player1Id: "user-1",
    player2Id: "user-2",
    player1SocketId: SOCKET.p1,
    player2SocketId: SOCKET.p2,
    status: "playing",
    gameState: actor === "p1" ? view : swapSides(view),
    turnStartedAt: Date.now(),
  });

  const actAs = (side: Side, type: string, payload: unknown = {}) => manager.executeAction(room.id, SOCKET[side], { type, payload });
  return {
    manager,
    room,
    act: (type: string, payload: unknown = {}) => actAs(actor, type, payload),
    actAs,
    requestCoins: (side: Side, cardId: string) => manager.requestCoinFlip(room.id, SOCKET[side], { purpose: "trainer", cardId }),
    mine: (side: Side = actor) => (side === "p1" ? room.gameState! : swapSides(room.gameState!)),
    masked: (viewer: Side | "spectator") =>
      maskGameStateForPlayer(room.gameState!, viewer === "spectator" ? "spectator" : VIEWER[viewer]) as unknown as Masked,
    coinsLeft: () => queue.length,
  };
}

async function expectRejected(t: ReturnType<typeof setupGame>, result: Promise<{ success: boolean; error?: string }>, reason: string | RegExp) {
  const before = t.room.gameState;
  const res = await result;
  expect(res.success).toBe(false);
  expect(res.error).toMatch(reason);
  expect(t.room.gameState).toBe(before);
}

const VIEWER_KEY = { p1: "player1", p2: "player2" } as const;

describe.each(["p1", "p2"] as const)("Gym Challenge in multiplayer as %s", (actor) => {
  const opp = other(actor);

  // ── Koga's Ninja Trick ─────────────────────────────────────────────────────────

  it("Ninja Trick: the defender is asked before any coin; the server flips the attack's coins only after the answer", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "pika"), { energy: "LL" }),
      theirActive: inPlay(gc("Koga's Ekans", "ekans"), { trainers: [gc("Koga's Ninja Trick", "ninja")] }),
      theirBench: [inPlay(gc("Koga's Grimer", "grimer"))],
    }, ["heads"]);

    const res = await t.act("attack", { attackIndex: 1 });
    expect(res.success, res.error).toBe(true);
    expect(res.attackPaused).toBe(true);
    expect(res.coinFlipInfo).toBeUndefined();
    expect(t.coinsLeft()).toBe(1); // nothing flipped yet
    expect(t.mine().attackedThisTurn).toBeFalsy();

    // The defender gets the question (worded for them), the attacker waits; answer clock
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    const asked = t.masked(opp).pendingAttackChoice;
    expect(asked.step.options.map((o: { id: string }) => o.id)).toEqual(["grimer"]);
    expect(asked.reaction?.resume).toBeUndefined();
    expect(t.masked(actor).pendingAttackChoice).toMatchObject({ waiting: true, step: { options: [] } });

    // A forged answer from the attacker is rejected
    await expectRejected(t, t.act("resolveAttackChoice", { selection: ["grimer"] }), /No te corresponde/);

    const answered = await t.actAs(opp, "resolveAttackChoice", { selection: ["grimer"] });
    expect(answered.success, answered.error).toBe(true);
    expect(answered.coinFlipInfo?.results).toEqual(["heads"]);
    expect(t.coinsLeft()).toBe(0);
    const after = t.mine();
    expect(after.opponentActivePokemon?.pokemon.id).toBe("grimer");
    expect(after.opponentActivePokemon?.currentDamage).toBe(30);
    expect(after.opponentBench.map((p) => p.pokemon.id)).toEqual(["ekans"]);
    expect(after.opponentDiscard.map((c) => c.id)).toContain("ninja");
  });

  it("Ninja Trick: no answer by the deadline = no switch (default), then the attack's coins", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "pika"), { energy: "LL" }),
      theirActive: inPlay(gc("Koga's Ekans", "ekans"), { trainers: [gc("Koga's Ninja Trick", "ninja")] }),
      theirBench: [inPlay(gc("Koga's Grimer", "grimer"))],
    }, ["tails"]);
    expect((await t.act("attack", { attackIndex: 1 })).success).toBe(true);
    const auto = await t.manager.autoAnswerTimedOut(t.room.id);
    expect(auto?.success, auto?.error).toBe(true);
    expect(auto?.coinFlipInfo?.results).toEqual(["tails"]);
    expect(t.mine().opponentActivePokemon?.pokemon.id).toBe("ekans");
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(30);
  });

  // ── Rebellion / defender coins ─────────────────────────────────────────────────

  it("Rebellion: the attacker's 2 power coins come first in showCoinFlip (powerCoins)", async () => {
    const t = setupGame(actor, { myActive: inPlay(gc("Misty's Gyarados", "gyarados"), { energy: "WWWW" }) }, ["heads", "tails"]);
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toMatchObject({ results: ["heads", "tails"], powerCoins: 2, smokescreenCoins: 0 });
    expect(res.coinFlipInfo?.flippedBy).toBeUndefined();
    expect(t.mine(opp).playerActivePokemon?.currentDamage ?? 70).toBeGreaterThan(0);
  });

  it("Fortitude: the defending player's coin goes in defenderResults; heads leaves Machamp at 10 HP", async () => {
    const t = setupGame(actor, { theirActive: inPlay(gc("Giovanni's Machamp", "machamp"), { damage: 90 }) }, ["heads"]);
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toMatchObject({ results: [], defenderResults: ["heads"] });
    expect(t.mine().opponentActivePokemon?.pokemon.id).toBe("machamp");
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(90);
  });

  it("Energy Drain: heads asks the defending player (off-turn) which attacker Energy to discard", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "pika"), { energy: "LL" }),
      theirActive: inPlay(gc("Koga's Muk", "muk")),
    }, ["heads"]);
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo?.defenderResults).toEqual(["heads"]);
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    expect(t.masked(actor).pendingAttackChoice).toMatchObject({ waiting: true });
    const step = t.masked(opp).pendingAttackChoice.step;
    expect(step.options.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining(["pika-e0", "pika-e1"]));
    await expectRejected(t, t.act("resolveAttackChoice", { selection: ["pika-e0"] }), /No te corresponde/);
    const answered = await t.actAs(opp, "resolveAttackChoice", { selection: ["pika-e1"] });
    expect(answered.success, answered.error).toBe(true);
    expect(t.mine().playerDiscard.map((c) => c.id)).toContain("pika-e1");
    expect(t.mine().isPlayerTurn).toBe(false); // the attack's turn ended
  });

  // ── Chaos Gym ──────────────────────────────────────────────────────────────────

  it("Chaos Gym tails: the other player is asked off-turn, accepts and plays the card on their own view", async () => {
    const t = setupGame(actor, {
      myHand: [cardAs("Bill", "bill")],
      stadium: { card: gc("Chaos Gym", "chaos"), playedBy: "player" },
    }, ["tails"]);
    const coin = t.requestCoins(actor, "bill");
    expect(coin).toMatchObject({ success: true, results: ["tails"] });
    const played = await t.act("playTrainer", { cardId: "bill", selections: [] });
    expect(played.success, played.error).toBe(true);
    expect(played.opponentCoinFlipInfo).toMatchObject({ attackName: "Chaos Gym", results: ["tails"] });
    expect(t.mine().playerHand).toEqual([]);
    expect(t.mine().playerDiscard.map((c) => c.id)).toEqual(["bill"]);

    // The offer: the other player answers (worded for them), the card's player waits
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    expect(t.masked(opp).pendingTrainerChoice).toMatchObject({ cardId: "bill", chooser: "opponent" });
    expect(t.masked(opp).pendingTrainerChoice.step.options.map((o: { id: string }) => o.id)).toEqual(["accept", "decline"]);
    expect(t.masked(actor).pendingTrainerChoice).toMatchObject({ waiting: true });
    await expectRejected(t, t.act("answerTrainerChoice", { selection: ["accept"] }), /No te corresponde/);

    expect((await t.actAs(opp, "answerTrainerChoice", { selection: ["accept"] })).success).toBe(true);
    expect(chaosOfferPlayer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    // The card's player can't end the turn meanwhile (game-core blocks it); the offered player
    // plays only that card, off-turn
    await t.act("endTurn");
    expect(t.mine().pendingChaosOffer).toMatchObject({ accepted: true });
    expect(t.mine().isPlayerTurn).toBe(true);
    const handBefore = t.mine(opp).playerHand.length;
    const res = await t.actAs(opp, "playTrainer", { cardId: "bill", selections: [] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine(opp).playerHand).toHaveLength(handBefore + 2);
    expect(t.mine(opp).playerHand.map((c) => c.id)).not.toContain("bill");
    expect(t.mine().playerDiscard.map((c) => c.id)).toEqual(["bill"]); // back in its owner's discard pile
    expect(t.mine().pendingChaosOffer).toBeUndefined();
    expect(offTurnAnswerer(t.room.gameState)).toBeNull();
    expect(t.mine().isPlayerTurn).toBe(true); // still the card's player's turn
  });

  it("Chaos Gym: the offer is declined by default when the offered player's answer clock runs out", async () => {
    const t = setupGame(actor, { myHand: [cardAs("Bill", "bill")], stadium: { card: gc("Chaos Gym", "chaos"), playedBy: "opponent" } }, ["tails"]);
    expect((await t.act("playTrainer", { cardId: "bill", selections: [] })).success).toBe(true);
    const auto = await t.manager.autoAnswerTimedOut(t.room.id);
    expect(auto?.success, auto?.error).toBe(true);
    expect(t.mine().pendingChaosOffer).toBeUndefined();
    expect(t.room.gameState!.pendingTrainerChoice).toBeUndefined();
    expect((await t.act("endTurn")).success).toBe(true);
  });

  it("Chaos Gym: after accepting, the offered player may give the card up (declineChaosOffer), also by default", async () => {
    const t = setupGame(actor, { myHand: [cardAs("Bill", "bill")], stadium: { card: gc("Chaos Gym", "chaos"), playedBy: "player" } }, ["tails"]);
    expect((await t.act("playTrainer", { cardId: "bill", selections: [] })).success).toBe(true);
    expect((await t.actAs(opp, "answerTrainerChoice", { selection: ["accept"] })).success).toBe(true);
    await expectRejected(t, t.act("declineChaosOffer"), /Chaos Gym/);
    const auto = await t.manager.autoAnswerTimedOut(t.room.id);
    expect(auto?.success, auto?.error).toBe(true);
    expect(t.mine().pendingChaosOffer).toBeUndefined();
  });

  it("Chaos Gym heads: the card is played again with its own flow (pendingChaosGymPlay), or forfeited", async () => {
    const t = setupGame(actor, { myHand: [cardAs("Bill", "bill")], stadium: { card: gc("Chaos Gym", "chaos"), playedBy: "player" } }, ["heads"]);
    expect((await t.act("playTrainer", { cardId: "bill", selections: [] })).success).toBe(true);
    expect(t.mine().pendingChaosGymPlay).toMatchObject({ cardId: "bill" });
    expect((await t.act("forfeitChaosGymPlay")).success).toBe(true);
    expect(t.mine().pendingChaosGymPlay).toBeUndefined();
    expect(t.mine().playerDiscard.map((c) => c.id)).toContain("bill");
  });

  // ── Sabrina's Psychic Control ──────────────────────────────────────────────────

  it("Psychic Control: heads borrows a Trainer of the opponent's discard pile, played with the generic flow; it stays there", async () => {
    const t = setupGame(actor, {
      myHand: [gc("Sabrina's Psychic Control", "pc")],
      theirDiscard: [cardAs("Bill", "their-bill")],
    }, ["heads"]);
    expect(t.requestCoins(actor, "pc")).toMatchObject({ success: true, results: ["heads"] });
    const played = await t.act("playTrainer", { cardId: "pc", selections: [["their-bill"]] });
    expect(played.success, played.error).toBe(true);
    expect(t.mine().pendingBorrowedTrainer).toMatchObject({ cardId: "their-bill" });
    await expectRejected(t, t.act("attachEnergy", { cardId: "x", pokemonId: "pika" }), /./);
    const res = await t.act("playTrainer", { cardId: "their-bill", selections: [] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerHand).toHaveLength(2);
    expect(t.mine().opponentDiscard.map((c) => c.id)).toEqual(["their-bill"]);
    expect(t.mine().pendingBorrowedTrainer).toBeUndefined();
  });

  it("Psychic Control: the borrowed Trainer can be given up (declineBorrowedTrainer); not by the other player", async () => {
    const t = setupGame(actor, { myHand: [gc("Sabrina's Psychic Control", "pc")], theirDiscard: [cardAs("Bill", "their-bill")] }, ["heads"]);
    expect((await t.act("playTrainer", { cardId: "pc", selections: [["their-bill"]] })).success).toBe(true);
    await expectRejected(t, t.actAs(opp, "declineBorrowedTrainer"), /No es tu turno/);
    expect((await t.act("declineBorrowedTrainer")).success).toBe(true);
    expect(t.mine().pendingBorrowedTrainer).toBeUndefined();
  });

  // ── Rocket's Minefield Gym ─────────────────────────────────────────────────────

  it("Minefield Gym: a Basic onto the Bench flips the server's coin, shown to both; tails = 20 damage", async () => {
    const t = setupGame(actor, {
      myHand: [cardAs("Pikachu", "new-pika")],
      stadium: { card: gc("Rocket's Minefield Gym", "minefield"), playedBy: "opponent" },
    }, ["tails"]);
    const res = await t.act("playBasicToBench", { cardId: "new-pika" });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: "Rocket's Minefield Gym", results: ["tails"] });
    expect(t.mine().playerBench[0]).toMatchObject({ pokemon: { id: "new-pika" }, currentDamage: 20 });
    // An illegal play flips nothing
    await expectRejected(t, t.act("playBasicToBench", { cardId: "nope" }), /./);
    expect(t.coinsLeft()).toBe(0);
  });

  // ── Lt. Surge's Secret Plan ────────────────────────────────────────────────────

  it("Secret Plan: the face-down card is hidden from the opponent and spectators, revealed to both once flipped", async () => {
    const t = setupGame(actor, { myHand: [gc("Lt. Surge's Secret Plan", "plan"), gc("Sabrina's Gastly", "hidden-gastly")] });
    const res = await t.act("playTrainer", { cardId: "plan", selections: [["hidden-gastly"]] });
    expect(res.success, res.error).toBe(true);
    const placeholder = t.mine().playerBench[0];
    expect(placeholder.pokemon.faceDownCard?.name).toBe("Sabrina's Gastly");

    expect(t.masked(actor).playerBench[0].pokemon.faceDownCard.name).toBe("Sabrina's Gastly");
    for (const viewer of [opp, "spectator"] as const) {
      const masked = t.masked(viewer);
      const bench = viewer === "spectator" && actor === "p2" ? masked.opponentBench : viewer === "spectator" ? masked.playerBench : masked.opponentBench;
      expect(bench[0].pokemon.id).toBe(placeholder.pokemon.id);
      expect(bench[0].pokemon.faceDownCard.name).not.toBe("Sabrina's Gastly");
      expect(JSON.stringify(masked)).not.toContain("Sabrina's Gastly");
      expect(JSON.stringify(masked)).not.toContain("hidden-gastly");
    }

    await expectRejected(t, t.actAs(opp, "flipFaceDown", { pokemonId: placeholder.pokemon.id }), /No es tu turno/);
    const flipped = await t.act("flipFaceDown", { pokemonId: placeholder.pokemon.id });
    expect(flipped.success, flipped.error).toBe(true);
    expect(t.masked(opp).opponentBench[0].pokemon.name).toBe("Sabrina's Gastly");
    expect(t.masked(actor).playerBench[0].pokemon.name).toBe("Sabrina's Gastly");
  });

  // ── Misty's Wish ───────────────────────────────────────────────────────────────

  it("Misty's Wish: the looked-at Prize (reveals ownPrizes) goes only to its player", async () => {
    const t = setupGame(actor, { myHand: [gc("Misty's Wish", "wish"), cardAs("Water Energy", "w1")] });
    const view = t.mine();
    const first = getTrainerSteps(view, "wish", []);
    expect(first).not.toBeNull();
    const pick = [first!.options[0].id];
    const started = await t.act("startTrainer", { cardId: "wish", selections: [pick] });
    expect(started.success, started.error).toBe(true);
    const mineChoice = t.masked(actor).pendingTrainerChoice;
    expect(mineChoice.step.reveals).toBe("ownPrizes");
    const revealed = (mineChoice.step.cards ?? []) as GameCard[];
    expect(revealed.length).toBeGreaterThan(0);
    for (const viewer of [opp, "spectator"] as const) {
      const theirs = t.masked(viewer).pendingTrainerChoice;
      expect(theirs.waiting).toBe(true);
      expect(theirs.step.cards).toBeUndefined();
      expect(theirs.step.options).toEqual([]);
    }
  });

  // ── Warp Point (opponent step) and an offered card with server steps ──────────

  it("Warp Point: the opponent picks first (off-turn, answer clock, default), then the player", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay(cardAs("Bulbasaur", "my-bulba"))],
      theirBench: [inPlay(cardAs("Squirtle", "their-squirtle"))],
      myHand: [gc("Warp Point", "warp")],
    });
    await expectRejected(t, t.act("playTrainer", { cardId: "warp", selections: [] }), /startTrainer/);
    expect((await t.act("startTrainer", { cardId: "warp", selections: [] })).success).toBe(true);
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    expect(t.masked(opp).pendingTrainerChoice.step.options.map((o: { id: string }) => o.id)).toEqual(["their-squirtle"]);
    expect(t.masked(actor).pendingTrainerChoice).toMatchObject({ waiting: true });
    const auto = await t.manager.autoAnswerTimedOut(t.room.id);
    expect(auto?.success, auto?.error).toBe(true);
    // The player's own switch: their turn clock, answered by them
    expect(offTurnAnswerer(t.room.gameState)).toBeNull();
    expect((await t.act("answerTrainerChoice", { selection: ["my-bulba"] })).success).toBe(true);
    expect(t.mine().playerActivePokemon?.pokemon.id).toBe("my-bulba");
    expect(t.mine().opponentActivePokemon?.pokemon.id).toBe("their-squirtle");
  });

  it("Chaos Gym: an offered Warp Point is played off-turn; its opponent step goes to the card's owner (playedOffTurn)", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay(cardAs("Bulbasaur", "my-bulba"))],
      theirBench: [inPlay(cardAs("Squirtle", "their-squirtle"))],
      myHand: [gc("Warp Point", "warp")],
      stadium: { card: gc("Chaos Gym", "chaos"), playedBy: "player" },
    }, ["tails"]);
    expect((await t.act("playTrainer", { cardId: "warp", selections: [] })).success).toBe(true);
    expect((await t.actAs(opp, "answerTrainerChoice", { selection: ["accept"] })).success).toBe(true);
    const started = await t.actAs(opp, "startTrainer", { cardId: "warp", selections: [] });
    expect(started.success, started.error).toBe(true);
    // The offered player's opponent (the card's owner, whose turn it is) answers first
    expect(t.room.gameState!.pendingTrainerChoice).toMatchObject({ chooser: "opponent", playedOffTurn: true });
    expect(offTurnAnswerer(t.room.gameState)).toBeNull();
    expect(t.masked(actor).pendingTrainerChoice.step.options.map((o: { id: string }) => o.id)).toEqual(["my-bulba"]);
    expect(t.masked(opp).pendingTrainerChoice).toMatchObject({ waiting: true, playedOffTurn: true });
    await expectRejected(t, t.actAs(opp, "answerTrainerChoice", { selection: ["my-bulba"] }), /No te corresponde/);
    expect((await t.act("answerTrainerChoice", { selection: ["my-bulba"] })).success).toBe(true);
    // Then the offered player's own switch, off-turn (answer clock)
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[opp]);
    const done = await t.actAs(opp, "answerTrainerChoice", { selection: ["their-squirtle"] });
    expect(done.success, done.error).toBe(true);
    expect(t.mine().playerActivePokemon?.pokemon.id).toBe("my-bulba");
    expect(t.mine().opponentActivePokemon?.pokemon.id).toBe("their-squirtle");
    expect(t.mine().pendingChaosOffer).toBeUndefined();
    expect(t.mine().playerDiscard.map((c) => c.id)).toContain("warp");
    expect(t.mine().isPlayerTurn).toBe(true);
  });

  it("Blaine's Quiz #2: the guess is on the 10-second answer clock, also when the guesser is the side whose turn it is (offered by Chaos Gym)", async () => {
    const t = setupGame(actor, {
      myHand: [gc("Blaine's Quiz #2", "quiz2"), cardAs("Potion", "my-potion")],
      theirHand: [cardAs("Potion", "their-potion")],
      stadium: { card: gc("Chaos Gym", "chaos"), playedBy: "player" },
    }, ["tails"]);
    const played = await t.act("playTrainer", { cardId: "quiz2", selections: [] });
    expect(played.success, played.error).toBe(true);
    expect((await t.actAs(opp, "answerTrainerChoice", { selection: ["accept"] })).success).toBe(true);
    const started = await t.actAs(opp, "startTrainer", { cardId: "quiz2", selections: [["their-potion"]] });
    expect(started.success, started.error).toBe(true);
    // The offered player's opponent guesses: the card's owner, whose turn it is
    expect(t.room.gameState!.pendingTrainerChoice).toMatchObject({ chooser: "opponent", playedOffTurn: true });
    expect(t.masked(actor).pendingTrainerChoice.step.answerTimeLimitMs).toBe(10_000);
    expect(offTurnAnswerer(t.room.gameState)).toBe(VIEWER_KEY[actor]);
    expect(t.manager.getClock(t.room)).toMatchObject({ kind: "answer", durationSeconds: 10 });
    const auto = await t.manager.autoAnswerTimedOut(t.room.id);
    expect(auto?.success, auto?.error).toBe(true);
    expect(t.room.gameState!.pendingTrainerChoice).toBeUndefined();
    expect(t.mine().pendingChaosOffer).toBeUndefined();
    expect(t.mine().isPlayerTurn).toBe(true);
    expect(t.manager.getClock(t.room)).toMatchObject({ kind: "turn", durationSeconds: 180 });
  });
  // ── Fuchsia / Saffron City Gym, Shapeshift ──────────────────────────────────────

  it("Fuchsia City Gym: the stadium coin comes from requestCoinFlip (stadium); heads shuffles a Koga's Pokémon in", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay(gc("Koga's Grimer", "my-grimer"))],
      stadium: { card: gc("Fuchsia City Gym", "fuchsia"), playedBy: "opponent" },
    }, ["heads"]);
    expect(t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "stadium" })).toMatchObject({ success: true, results: ["heads"] });
    const res = await t.act("stadiumAction", { selections: [["my-grimer"]] });
    expect(res.success, res.error).toBe(true);
    expect(res.opponentCoinFlipInfo).toMatchObject({ attackName: "Fuchsia City Gym", results: ["heads"] });
    expect(t.mine().playerBench).toEqual([]);
    expect(t.mine().playerDeck.map((c) => c.id)).toContain("my-grimer");
    await expectRejected(t, t.act("stadiumAction", { selections: [] }), /Ya usaste/);
  });

  it("Saffron City Gym: a basic Energy of a Sabrina's Pokémon back to the hand (no coin)", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(gc("Sabrina's Gastly", "my-gastly"), { energy: "P" }),
      stadium: { card: gc("Saffron City Gym", "saffron"), playedBy: "player" },
    });
    const res = await t.act("stadiumAction", { selections: [["my-gastly"], ["my-gastly-e0"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerHand.map((c) => c.id)).toEqual(["my-gastly-e0"]);
    await expectRejected(t, t.actAs(opp, "stadiumAction", { selections: [["my-gastly"], ["my-gastly-e0"]] }), /No es tu turno/);
  });
  it("Shapeshift: usePower attaches an Evolution card; the attack comes from getAvailableAttacks (the copied card's)", async () => {
    const raichu = byName("Raichu");
    const t = setupGame(actor, {
      myActive: inPlay(gc("Brock's Ninetales", "ninetales"), { energy: "LLL" }),
      myHand: [cardAs("Raichu", "raichu")],
    }, ["heads"]);
    const res = await t.act("usePower", { pokemonId: "ninetales", selections: [["raichu"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerHand).toEqual([]);
    expect(getAvailableAttacks(t.mine(), t.mine().playerActivePokemon!)[0].attack.name).toBe(raichu.kind === "pokemon" ? raichu.attacks[0].name : "");
    const attacked = await t.act("attack", { attackIndex: 0 });
    expect(attacked.success, attacked.error).toBe(true);
    expect(attacked.coinFlipInfo?.attackName).toBe(raichu.kind === "pokemon" ? raichu.attacks[0].name : "");
  });
});
