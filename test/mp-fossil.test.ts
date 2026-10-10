/**
 * Fossil in multiplayer: Mysterious Fossil (play / discardFromPlay + promotion), attack choices
 * (pendingAttackChoice answered by its chooser, masked for everyone else), coin plans (Stone
 * Barrage until tails, Haunter's Transparency coin), Clairvoyance, Curse's mid-turn Knock Out,
 * Headache, Prehistoric Power and Ditto. Every scenario runs as player 1 and as player 2 (the
 * state is stored in player 1's perspective; player 2 acts on a swapSides copy).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getDeckById,
  initializeMultiplayerGame,
  swapSides,
  toInPlayCard,
  type GameCard,
  type GameState,
  type PokemonInPlay,
} from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";

type Side = "p1" | "p2";
type Coin = "heads" | "tails";

const SOCKET = { p1: "s1", p2: "s2" } as const;
const VIEWER = { p1: "player1", p2: "player2" } as const;
const other = (side: Side): Side => (side === "p1" ? "p2" : "p1");

function byName(name: string, set = "Base Set"): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === set);
  if (!found) throw new Error(`card ${name} (${set}) not in catalog`);
  return found as GameCard;
}
const cardAs = (name: string, id: string, set?: string): GameCard => ({ ...byName(name, set), id });
const fossil = (name: string, id: string): GameCard => cardAs(name, id, "Fossil");

const ENERGY_NAME: Record<string, string> = {
  L: "Lightning Energy",
  W: "Water Energy",
  P: "Psychic Energy",
  G: "Grass Energy",
  F: "Fighting Energy",
  R: "Fire Energy",
};

function inPlay(
  card: GameCard,
  opts: { energy?: string; damage?: number; status?: string[]; playedOnTurn?: number } = {},
): PokemonInPlay {
  return {
    pokemon: toInPlayCard(card),
    attachedEnergy: [...(opts.energy ?? "")].map((code, i) => cardAs(ENERGY_NAME[code], `${card.id}-e${i}`)),
    attachedTrainers: [],
    previousEvolutions: [],
    currentDamage: opts.damage ?? 0,
    statusConditions: opts.status ?? [],
    playedOnTurn: opts.playedOnTurn ?? 0,
  } as unknown as PokemonInPlay;
}

interface Board {
  myActive?: PokemonInPlay;
  myBench?: PokemonInPlay[];
  myHand?: GameCard[];
  theirActive?: PokemonInPlay;
  theirBench?: PokemonInPlay[];
  theirHand?: GameCard[];
}

/** A PLAYING game where it is `actor`'s turn, built in the actor's perspective. */
function setupGame(actor: Side, board: Board = {}, coins: Coin[] = []) {
  const queue = [...coins];
  const manager = new GameRoomManager(() => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected coin flip");
    return next;
  });
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
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
    opponentDiscard: [],
    energyAttachedThisTurn: false,
    activeModifiers: [],
    events: [],
  } as unknown as GameState;

  const room = manager.createRoom();
  Object.assign(room, {
    player1SocketId: SOCKET.p1,
    player2SocketId: SOCKET.p2,
    status: "playing",
    gameState: actor === "p1" ? view : swapSides(view),
  });

  const actAs = (side: Side, type: string, payload: unknown = {}) =>
    manager.executeAction(room.id, SOCKET[side], { type, payload });
  return {
    room,
    act: (type: string, payload: unknown = {}) => actAs(actor, type, payload),
    actAs,
    /** Stored state in the actor's perspective */
    mine: () => (actor === "p1" ? room.gameState! : swapSides(room.gameState!)),
    masked: (viewer: Side | "spectator") =>
      maskGameStateForPlayer(room.gameState!, viewer === "spectator" ? "spectator" : VIEWER[viewer]) as unknown as GameState & {
        pendingAttackChoice?: Record<string, unknown> & { step: Record<string, unknown> & { options: { id: string }[] } };
      },
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

/** The non-chooser's stub: the question, nothing to choose from. */
function expectWaitingStub(choice: Record<string, unknown> | undefined, chooser: "self" | "opponent") {
  expect(choice).toBeDefined();
  expect(choice!.waiting).toBe(true);
  expect(Object.keys(choice!).sort()).toEqual(["effect", "step", "waiting"]);
  const step = choice!.step as Record<string, unknown>;
  expect(step.options).toEqual([]);
  expect(step.chooser).toBe(chooser);
  for (const hidden of ["cards", "orderingCards", "thumbnails"]) expect(step[hidden]).toBeUndefined();
  expect(typeof step.title).toBe("string");
}

describe.each(["p1", "p2"] as const)("Fossil in multiplayer as %s", (actor) => {
  const opp = other(actor);

  // ── Mysterious Fossil ──────────────────────────────────────────────────────────

  it("Mysterious Fossil is played as a Basic and discarded from the Bench (no prize)", async () => {
    const t = setupGame(actor, { myHand: [fossil("Mysterious Fossil", "fossil-h")] });
    expect((await t.act("playBasicToBench", { cardId: "fossil-h" })).success).toBe(true);
    expect(t.mine().playerBench.map((p) => p.pokemon.id)).toEqual(["fossil-h"]);
    expect(t.mine().playerBench[0].pokemon.types).toEqual([]);

    await expectRejected(t, t.actAs(opp, "discardFromPlay", { pokemonId: "fossil-h" }), /Not your turn/);
    expect((await t.act("discardFromPlay", { pokemonId: "fossil-h" })).success).toBe(true);
    expect(t.mine().playerBench).toEqual([]);
    expect(t.mine().playerDiscard.map((c) => c.name)).toEqual(["Mysterious Fossil"]);
    expect(t.mine().opponentPrizes).toHaveLength(6);
  });

  it("an Active Mysterious Fossil discarded: the player promotes mid-turn and keeps playing", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(fossil("Mysterious Fossil", "fossil-a")),
      myBench: [inPlay(cardAs("Pikachu", "pika-b"), { energy: "L" })],
      myHand: [cardAs("Lightning Energy", "l-h")],
    });
    expect((await t.act("discardFromPlay", { pokemonId: "fossil-a" })).success).toBe(true);
    expect(t.mine().playerActivePokemon).toBeNull();
    expect(t.mine().playerNeedsToPromote).toBe(true);
    await expectRejected(t, t.actAs(opp, "promote", { benchIndex: 0 }), /No promotion needed/);

    expect((await t.act("promote", { benchIndex: 0 })).success).toBe(true);
    expect(t.mine().playerActivePokemon?.pokemon.id).toBe("pika-b");
    // Still the same turn: the player can attach and attack
    expect(t.mine().isPlayerTurn).toBe(true);
    expect(t.mine().turnNumber).toBe(5);
    expect((await t.act("attachEnergy", { cardId: "l-h", pokemonId: "pika-b" })).success).toBe(true);
  });

  // ── Attack choices ─────────────────────────────────────────────────────────────

  it("Terror Strike: the defending player chooses (off-turn), the attacker can't; masked for the attacker", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(fossil("Arbok", "arbok"), { energy: "G" }),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba")), inPlay(cardAs("Charmander", "charm"))],
    }, ["heads"]); // Terror Strike: heads → the switch
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success).toBe(true);
    expect(res.coinFlipInfo?.results).toEqual(["heads"]);
    const pending = t.mine().pendingAttackChoice!;
    expect(pending.step.chooser).toBe("opponent");
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(10);

    // The chooser (defending player) sees the options; attacker and spectators get the stub
    const chooserView = t.masked(opp).pendingAttackChoice!;
    expect(chooserView.waiting).toBeUndefined();
    expect(chooserView.step.options.map((o) => o.id).sort()).toEqual(["bulba", "charm"]);
    expect(chooserView.context).toBeDefined();
    expectWaitingStub(t.masked(actor).pendingAttackChoice, "opponent");
    expectWaitingStub(t.masked("spectator").pendingAttackChoice, "opponent");

    // Nothing else moves while the choice is pending
    await expectRejected(t, t.act("endTurn"), /resolver la elección/);
    await expectRejected(t, t.act("resolveAttackChoice", { selection: ["charm"] }), /No te corresponde elegir/);
    await expectRejected(t, t.actAs(opp, "resolveAttackChoice", { selection: ["arbok"] }), /./);

    expect((await t.actAs(opp, "resolveAttackChoice", { selection: ["charm"] })).success).toBe(true);
    const after = t.mine();
    expect(after.pendingAttackChoice).toBeUndefined();
    expect(after.opponentActivePokemon?.pokemon.id).toBe("charm");
    expect(after.opponentBench.map((p) => p.pokemon.id).sort()).toEqual(["bulba", "their-active"]);
    // The attacker's turn is over
    expect(after.isPlayerTurn).toBe(false);
    await expectRejected(t, t.actAs(opp, "resolveAttackChoice", { selection: ["bulba"] }), /No hay ninguna elección/);
  });

  it("Prophecy: the attacker picks the opponent's deck and reorders its top 3 (seen only by the attacker)", async () => {
    const t = setupGame(actor, { myActive: inPlay(fossil("Hypno", "hypno"), { energy: "P" }) });
    const top3 = t.mine().opponentDeck.slice(0, 3).map((c) => c.id);
    expect((await t.act("attack", { attackIndex: 0 })).success).toBe(true);

    const step1 = t.masked(actor).pendingAttackChoice!;
    expect(step1.step.options.map((o) => o.id).sort()).toEqual(["opponent", "player"]);
    expectWaitingStub(t.masked(opp).pendingAttackChoice, "self");
    await expectRejected(t, t.actAs(opp, "resolveAttackChoice", { selection: ["opponent"] }), /No te corresponde elegir/);

    expect((await t.act("resolveAttackChoice", { selection: ["opponent"] })).success).toBe(true);
    const step2 = t.masked(actor).pendingAttackChoice!.step as { orderingCards?: GameCard[]; options: { id: string }[] };
    expect(step2.orderingCards?.map((c) => c.id)).toEqual(top3);
    expect(step2.orderingCards?.every((c) => typeof c.name === "string")).toBe(true);
    // The defender sees neither the cards nor the chosen deck
    const stub = t.masked(opp).pendingAttackChoice!;
    expectWaitingStub(stub, "self");
    expect(stub.deck).toBeUndefined();
    expect(stub.context).toBeUndefined();
    expect(t.mine().isPlayerTurn).toBe(true);

    expect((await t.act("resolveAttackChoice", { selection: ["2", "1", "0"] })).success).toBe(true);
    // New order top3[2], top3[1], top3[0]; the opponent's turn began by drawing the first
    expect(t.mine().pendingAttackChoice).toBeUndefined();
    expect(t.mine().isPlayerTurn).toBe(false);
    expect(t.mine().opponentHand.map((c) => c.id)).toContain(top3[2]);
    expect(t.mine().opponentDeck.slice(0, 2).map((c) => c.id)).toEqual([top3[1], top3[0]]);
  });

  it("Dragonair's Hyper Beam: the attacker picks the Energy to discard; the defender can't", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Dragonair", "dragonair"), { energy: "WWWW" }),
      theirActive: inPlay(cardAs("Pikachu", "their-active"), { energy: "LL" }),
    });
    expect((await t.act("attack", { attackIndex: 1 })).success).toBe(true);
    expect(t.mine().pendingAttackChoice?.step.chooser ?? "self").toBe("self");
    expect(t.masked(actor).pendingAttackChoice!.step.options.map((o) => o.id).sort()).toEqual(["their-active-e0", "their-active-e1"]);
    expectWaitingStub(t.masked(opp).pendingAttackChoice, "self");
    await expectRejected(t, t.actAs(opp, "resolveAttackChoice", { selection: ["their-active-e0"] }), /No te corresponde elegir/);
    await expectRejected(t, t.act("resolveAttackChoice", { selection: ["dragonair-e0"] }), /./);

    expect((await t.act("resolveAttackChoice", { selection: ["their-active-e1"] })).success).toBe(true);
    expect(t.mine().opponentActivePokemon?.attachedEnergy.map((e) => e.id)).toEqual(["their-active-e0"]);
    expect(t.mine().opponentDiscard.map((c) => c.id)).toEqual(["their-active-e1"]);
    expect(t.mine().isPlayerTurn).toBe(false);
  });

  // ── Attack coins ───────────────────────────────────────────────────────────────

  it("Stone Barrage flips until tails (server coins) and does 10 per heads", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(fossil("Geodude", "geodude"), { energy: "FF" }),
      theirActive: inPlay(cardAs("Bulbasaur", "their-active")),
    }, ["heads", "heads", "tails"]);
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: expect.any(String), results: ["heads", "heads", "tails"] });
    expect(t.coinsLeft()).toBe(0);
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(20);
  });

  it("Haunter's Transparency: the defender's coin comes last, apart from the attacker's", async () => {
    // Thunder Jolt (1 coin) against a Defending Haunter (Transparency: heads prevents it all)
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "pika"), { energy: "LL" }),
      theirActive: inPlay(fossil("Haunter", "haunter")),
    }, ["tails", "heads"]);
    const res = await t.act("attack", { attackIndex: 1 });
    expect(res.success).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: expect.any(String), results: ["tails"], defenderResults: ["heads"] });
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(0);
    expect(t.coinsLeft()).toBe(0);
  });

  it("Transparency against an attack without coins: only the defender's coin", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "pika"), { energy: "L" }),
      theirActive: inPlay(fossil("Haunter", "haunter")),
    }, ["tails"]);
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: expect.any(String), results: [], defenderResults: ["tails"] });
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(10);
  });

  // ── Powers ───────────────────────────────────────────────────────────────────

  it("Clairvoyance: Omanyte's owner sees the opponent's hand; the opponent doesn't see theirs", async () => {
    const theirHand = [cardAs("Bill", "their-bill", "Base Set"), cardAs("Potion", "their-potion", "Base Set")];
    const myHand = [cardAs("Pikachu", "my-pika")];
    const t = setupGame(actor, {
      myBench: [inPlay(fossil("Omanyte", "omanyte"))],
      myHand,
      theirHand,
    });
    expect(t.masked(actor).opponentHand.map((c) => c.id)).toEqual(["their-bill", "their-potion"]);
    expect(t.masked(actor).opponentHand.every((c) => c.name)).toBe(true);
    expect(t.masked(opp).opponentHand).toEqual([{ id: "hidden-opponent-hand-0", hidden: true }]);
    // Face up = public: spectators see that hand, never the other one
    const spectator = t.masked("spectator");
    const revealed = actor === "p1" ? spectator.opponentHand : spectator.playerHand;
    const hidden = actor === "p1" ? spectator.playerHand : spectator.opponentHand;
    expect(revealed.map((c) => c.id)).toEqual(["their-bill", "their-potion"]);
    expect(hidden).toEqual([{ id: `hidden-${actor === "p1" ? "player" : "opponent"}-hand-0`, hidden: true }]);
    // Decks and prizes stay hidden
    expect(t.masked(actor).opponentDeck.every((c) => (c as { hidden?: boolean }).hidden)).toBe(true);
  });

  it("Curse Knocks Out the Defending Pokémon: the opponent promotes off-turn and the turn goes on", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(fossil("Gengar", "gengar")),
      theirActive: inPlay(cardAs("Pikachu", "their-active"), { damage: 30 }),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"), { damage: 10 }), inPlay(cardAs("Charmander", "charm"))],
    });
    const prizesBefore = t.mine().playerPrizes.length;
    const res = await t.act("usePower", { pokemonId: "gengar", selections: [["bulba"], ["their-active"]] });
    expect(res.success).toBe(true);
    expect(t.mine().opponentActivePokemon).toBeNull();
    expect(t.mine().opponentNeedsToPromote).toBe(true);
    expect(t.mine().playerPrizes).toHaveLength(prizesBefore - 1);

    await expectRejected(t, t.act("promote", { benchIndex: 0 }), /No promotion needed/);
    expect((await t.actAs(opp, "promote", { benchIndex: 1 })).success).toBe(true);
    const after = t.mine();
    expect(after.opponentActivePokemon?.pokemon.id).toBe("charm");
    expect(after.isPlayerTurn).toBe(true);
    expect(after.turnNumber).toBe(5);
    expect((await t.act("endTurn")).success).toBe(true);
    expect(t.mine().isPlayerTurn).toBe(false);
  });

  it("a prize taken off-turn after a mid-turn Knock Out (Buzzap) doesn't end the turn", async () => {
    const t = setupGame(actor, { myBench: [inPlay(cardAs("Electrode", "electrode"))] });
    const res = await t.act("usePower", { pokemonId: "electrode", selections: [["lightning"], ["my-active"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().opponentCanTakePrize).toBe(true);
    expect((await t.actAs(opp, "takePrize", { prizeIndex: 0 })).success).toBe(true);
    expect(t.mine().isPlayerTurn).toBe(true);
    expect(t.mine().turnNumber).toBe(5);
  });

  it("a Knock Out in the between-turns checkup: prize, promotion, then the turn passes once", async () => {
    // The actor's own Active dies from Poison after endTurn: the opponent takes a prize, the
    // actor promotes, and only then the opponent's turn starts (endTurn of the actor's side)
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "my-active"), { damage: 30, status: ["poisoned"] }),
      myBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    expect((await t.act("endTurn")).success).toBe(true);
    expect(t.mine().playerActivePokemon).toBeNull();
    expect(t.mine().playerNeedsToPromote).toBe(true);
    expect(t.mine().opponentCanTakePrize).toBe(true);
    expect(t.mine().isPlayerTurn).toBe(true);

    expect((await t.actAs(opp, "takePrize", { prizeIndex: 0 })).success).toBe(true);
    expect(t.mine().isPlayerTurn).toBe(true); // still waiting for the promotion
    expect((await t.act("promote", { benchIndex: 0 })).success).toBe(true);
    expect(t.mine().playerActivePokemon?.pokemon.id).toBe("bulba");
    expect(t.mine().isPlayerTurn).toBe(false);
    expect(t.mine().turnNumber).toBe(6);
  });

  it("Headache: the opponent can't play Trainers during their next turn", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(fossil("Psyduck", "psyduck"), { energy: "P" }),
      theirHand: [cardAs("Bill", "their-bill"), fossil("Mysterious Fossil", "their-fossil")],
    });
    expect((await t.act("attack", { attackIndex: 0 })).success).toBe(true);
    expect(t.mine().isPlayerTurn).toBe(false);
    await expectRejected(t, t.actAs(opp, "playTrainer", { cardId: "their-bill", selections: [] }), /./);
    await expectRejected(t, t.actAs(opp, "playBasicToBench", { cardId: "their-fossil" }), /./);
  });

  it("Prehistoric Power (either side): evolving is rejected", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay(cardAs("Charmander", "charm"), { playedOnTurn: 1 })],
      myHand: [cardAs("Charmeleon", "charmeleon-h")],
      theirBench: [inPlay(fossil("Aerodactyl", "aero"))],
    });
    await expectRejected(t, t.act("evolve", { cardId: "charmeleon-h", targetPokemonId: "charm" }), /./);
  });

  it("Ditto attacks with the Defending Pokémon's attacks (effective card)", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(fossil("Ditto", "ditto"), { energy: "LL" }),
      theirActive: inPlay(cardAs("Pikachu", "their-active"), { energy: "L" }),
    }, ["heads"]);
    const res = await t.act("attack", { attackIndex: 1 }); // Pikachu's Thunder Jolt (1 coin)
    expect(res.success).toBe(true);
    expect(res.coinFlipInfo?.attackName).toBe(byName("Pikachu").attacks[1].name);
    expect(res.coinFlipInfo?.results).toEqual(["heads"]);
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(30);
  });
});
