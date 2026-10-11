/**
 * Multiplayer actions that run through game-core's generic API: board actions
 * (playBasicPokemon / attachEnergyCard / evolvePokemonCard), the effect registry
 * (playTrainerCard / usePokemonPower, server-rolled coins) and attack legality
 * (canExecuteAttack). Every scenario runs as player 1 and as player 2: the state is stored in
 * player 1's perspective and player 2 acts on a swapSides copy.
 *
 * Illegal moves must come back as `{ success: false, error: <Spanish reason> }` and leave the
 * stored state untouched (same object).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getDeckById,
  initializeMultiplayerGame,
  swapSides,
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
const NAME = { p1: "Jugador 1", p2: "Jugador 2" } as const;
const other = (side: Side): Side => (side === "p1" ? "p2" : "p1");

function byName(name: string, set = "Base Set"): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === set) ?? ALL_CARDS.find((c) => c.name === name);
  if (!found) throw new Error(`card ${name} not in catalog`);
  return found as GameCard;
}
const cardAs = (name: string, id: string, set?: string): GameCard => ({ ...byName(name, set), id });

const ENERGY_NAME: Record<string, string> = { L: "Lightning Energy", W: "Water Energy", P: "Psychic Energy", G: "Grass Energy" };

function inPlay(
  name: string,
  id: string,
  opts: { energy?: string; damage?: number; status?: string[]; playedOnTurn?: number; set?: string } = {},
): PokemonInPlay {
  return {
    pokemon: cardAs(name, id, opts.set),
    attachedEnergy: [...(opts.energy ?? "")].map((code, i) => cardAs(ENERGY_NAME[code], `${id}-e${i}`)),
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
  myDeck?: GameCard[];
  theirActive?: PokemonInPlay;
  theirBench?: PokemonInPlay[];
  turnNumber?: number;
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
    turnNumber: board.turnNumber ?? 5,
    isPlayerTurn: true,
    startingPlayer: "player",
    playerActivePokemon: board.myActive ?? inPlay("Pikachu", "my-active", { energy: "L" }),
    playerBench: board.myBench ?? [],
    playerHand: board.myHand ?? [],
    playerDeck: board.myDeck ?? base.playerDeck.slice(0, 20),
    playerPrizes: base.playerDeck.slice(20, 26),
    playerDiscard: [],
    opponentActivePokemon: board.theirActive ?? inPlay("Pikachu", "their-active", { energy: "L" }),
    opponentBench: board.theirBench ?? [],
    opponentHand: base.opponentDeck.slice(0, 5),
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
    manager,
    room,
    act: (type: string, payload: unknown = {}) => actAs(actor, type, payload),
    actAs,
    /** Stored state in the actor's perspective */
    mine: () => (actor === "p1" ? room.gameState! : swapSides(room.gameState!)),
    masked: (viewer: Side | "spectator") =>
      maskGameStateForPlayer(room.gameState!, viewer === "spectator" ? "spectator" : VIEWER[viewer]) as unknown as GameState,
    requestCoins: (request: { purpose: "trainer"; cardId: string } | { purpose: "power"; pokemonId: string }) =>
      manager.requestCoinFlip(room.id, SOCKET[actor], request),
    coinsLeft: () => queue.length,
    lastEvents: (n: number) => room.gameState!.events.slice(-n).map((e) => e.message),
  };
}

/** The action failed with `reason` (substring) and the stored state is the same object. */
async function expectRejected(t: ReturnType<typeof setupGame>, result: Promise<{ success: boolean; error?: string }>, reason: string | RegExp) {
  const before = t.room.gameState;
  const res = await result;
  expect(res.success).toBe(false);
  expect(res.error).toMatch(reason);
  expect(t.room.gameState).toBe(before);
}

describe.each(["p1", "p2"] as const)("multiplayer engine actions as %s", (actor) => {
  // ── Board actions ────────────────────────────────────────────────────────────

  it("plays a Basic to the Bench; evolutions and Active during play are rejected", async () => {
    const t = setupGame(actor, { myHand: [cardAs("Pikachu", "pika-h"), cardAs("Raichu", "raichu-h")] });
    const res = await t.act("playBasicToBench", { cardId: "pika-h" });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerBench.map((p) => p.pokemon.id)).toEqual(["pika-h"]);
    expect(t.mine().playerBench[0].playedOnTurn).toBe(5);
    expect(t.mine().playerHand.map((c) => c.id)).toEqual(["raichu-h"]);
    expect(t.lastEvents(1)[0]).toBe(`${NAME[actor]} colocó Pikachu en la banca`);

    await expectRejected(t, t.act("playBasicToBench", { cardId: "raichu-h" }), "Solo puedes poner en juego Pokémon Básicos");
    await expectRejected(t, t.act("playBasicToActive", { cardId: "raichu-h" }), /Básicos/);
    await expectRejected(t, t.actAs(other(actor), "playBasicToBench", { cardId: "pika-h" }), "Not your turn");
  });

  it("attaches one Energy per turn to any own Pokémon (by id)", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay("Pikachu", "my-bench")],
      myHand: [cardAs("Lightning Energy", "l1"), cardAs("Lightning Energy", "l2")],
    });
    const res = await t.act("attachEnergy", { cardId: "l1", pokemonId: "my-bench" });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerBench[0].attachedEnergy.map((e) => e.id)).toEqual(["l1"]);
    expect(t.mine().energyAttachedThisTurn).toBe(true);

    await expectRejected(t, t.act("attachEnergy", { cardId: "l2", pokemonId: "my-active" }), "Solo puedes adjuntar una energía por turno");
    await expectRejected(t, t.act("attachEnergy", { cardId: "l2", pokemonId: "their-active" }), "Debes elegir uno de tus Pokémon en juego");
  });

  it("Rain Dance: Water Energy to Water Pokémon doesn't use the turn's attachment", async () => {
    const t = setupGame(actor, {
      myActive: inPlay("Squirtle", "squirtle"),
      myBench: [inPlay("Blastoise", "blastoise")],
      myHand: [cardAs("Water Energy", "w1"), cardAs("Water Energy", "w2"), cardAs("Lightning Energy", "l1")],
    });
    for (const cardId of ["w1", "w2"]) {
      const res = await t.act("attachEnergy", { cardId, pokemonId: "squirtle" });
      expect(res.success, res.error).toBe(true);
    }
    expect(t.mine().energyAttachedThisTurn).toBe(false);
    expect((await t.act("attachEnergy", { cardId: "l1", pokemonId: "blastoise" })).success).toBe(true);
    expect(t.mine().playerActivePokemon!.attachedEnergy.map((e) => e.id)).toEqual(["w1", "w2"]);
  });

  it("evolves by Pokémon id (or legacy index); not on turns 1-2 nor the turn it was played", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay("Pikachu", "new-pika", { playedOnTurn: 5 })],
      myHand: [cardAs("Raichu", "raichu-1"), cardAs("Raichu", "raichu-2")],
    });
    await expectRejected(t, t.act("evolve", { cardId: "raichu-1", targetPokemonId: "new-pika" }), "entró en juego o evolucionó este turno");
    await expectRejected(t, t.act("evolve", { cardId: "raichu-1", targetPokemonId: "their-active" }), "Debes elegir uno de tus Pokémon en juego");

    const res = await t.act("evolve", { cardId: "raichu-1", targetPokemonId: "my-active" });
    expect(res.success, res.error).toBe(true);
    const active = t.mine().playerActivePokemon!;
    expect(active.pokemon.name).toBe("Raichu");
    expect(active.previousEvolutions.map((c) => c.name)).toEqual(["Pikachu"]);
    expect(active.attachedEnergy).toHaveLength(1);

    // Legacy targetIndex (Active = -1) is still accepted: Raichu can't evolve from Raichu
    await expectRejected(t, t.act("evolve", { cardId: "raichu-2", targetIndex: -1 }), "Raichu no evoluciona de Raichu");

    for (const turnNumber of [1, 2]) {
      const early = setupGame(actor, { turnNumber, myHand: [cardAs("Raichu", "raichu-1")] });
      await expectRejected(early, early.act("evolve", { cardId: "raichu-1", targetPokemonId: "my-active" }), "No puedes evolucionar en tu primer turno");
    }
  });

  // ── Trainers (effect registry) ───────────────────────────────────────────────

  it("Super Potion: [[pokemonId], [energyId]] heals 40 and discards that Energy", async () => {
    const t = setupGame(actor, {
      myActive: inPlay("Pikachu", "my-active", { energy: "LL", damage: 30 }),
      myHand: [cardAs("Super Potion", "sp")],
    });
    await expectRejected(t, t.act("playTrainer", { cardId: "sp", selections: [["their-active"], ["their-active-e0"]] }), /Opción no válida/);
    await expectRejected(t, t.act("playTrainer", { cardId: "sp", selections: [["my-active"]] }), /Falta elegir/);
    await expectRejected(t, t.act("playTrainer", { cardId: "sp", trainerName: "Bill", selections: [] }), "La carta no coincide");

    const res = await t.act("playTrainer", { cardId: "sp", selections: [["my-active"], ["my-active-e1"]] });
    expect(res.success, res.error).toBe(true);
    const active = t.mine().playerActivePokemon!;
    expect(active.currentDamage).toBe(0);
    expect(active.attachedEnergy.map((e) => e.id)).toEqual(["my-active-e0"]);
    expect(t.mine().playerDiscard.map((c) => c.id).sort()).toEqual(["my-active-e1", "sp"]);
    expect(t.lastEvents(3).join(" | ")).toContain(`${NAME[actor]} jugó Super Potion`);
  });

  it("Energy Removal: [[opponentActiveEnergyId]]; own Energy is not an option", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay("Pikachu", "their-active", { energy: "LL" }),
      myHand: [cardAs("Energy Removal", "er")],
    });
    await expectRejected(t, t.act("playTrainer", { cardId: "er", selections: [["my-active-e0"]] }), /Opción no válida/);
    const res = await t.act("playTrainer", { cardId: "er", trainerName: "Energy Removal", selections: [["their-active-e1"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().opponentActivePokemon!.attachedEnergy.map((e) => e.id)).toEqual(["their-active-e0"]);
    expect(t.mine().opponentDiscard.map((c) => c.id)).toEqual(["their-active-e1"]);
  });

  it("Poké Ball heads: coin from requestCoinFlip (no re-roll), then pick a Pokémon from the deck", async () => {
    const deck = [cardAs("Bellsprout", "bell-d", "Jungle"), cardAs("Grass Energy", "g-d")];
    const t = setupGame(actor, { myHand: [cardAs("Poké Ball", "pb", "Jungle")], myDeck: deck }, ["heads"]);
    const first = t.requestCoins({ purpose: "trainer", cardId: "pb" });
    expect(first).toEqual({ success: true, results: ["heads"], result: "heads" });
    expect(t.requestCoins({ purpose: "trainer", cardId: "pb" })).toEqual(first); // stored, no new flip

    await expectRejected(t, t.act("playTrainer", { cardId: "pb", selections: [["g-d"]] }), /Opción no válida/);
    const res = await t.act("playTrainer", { cardId: "pb", selections: [["bell-d"]], coinResult: "tails" });
    expect(res.success, res.error).toBe(true);
    expect(res.opponentCoinFlipInfo).toEqual({ attackName: "Poké Ball", results: ["heads"] });
    expect(t.mine().playerHand.map((c) => c.id)).toEqual(["bell-d"]);
    expect(t.room.effectCoins ?? {}).toEqual({});
  });

  it("Poké Ball tails: no step, the coin can't be re-rolled by asking again", async () => {
    const deck = [cardAs("Bellsprout", "bell-d", "Jungle")];
    const t = setupGame(actor, { myHand: [cardAs("Poké Ball", "pb", "Jungle"), cardAs("Poké Ball", "pb2", "Jungle")], myDeck: deck }, ["tails", "heads"]);
    expect(t.requestCoins({ purpose: "trainer", cardId: "pb" })).toMatchObject({ results: ["tails"] });
    expect(t.requestCoins({ purpose: "trainer", cardId: "pb2" })).toMatchObject({ results: ["heads"] });
    expect(t.requestCoins({ purpose: "trainer", cardId: "pb" })).toMatchObject({ results: ["tails"] });

    await expectRejected(t, t.act("playTrainer", { cardId: "pb", selections: [["bell-d"]] }), "Hay selecciones de más");
    const res = await t.act("playTrainer", { cardId: "pb", selections: [] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerDeck.map((c) => c.id)).toEqual(["bell-d"]);
    expect(t.mine().playerDiscard.map((c) => c.id)).toEqual(["pb"]);
    expect(t.coinsLeft()).toBe(0);
  });

  it("a coin Trainer played without requestCoinFlip gets a server coin", async () => {
    const t = setupGame(actor, { myHand: [cardAs("Poké Ball", "pb", "Jungle")], myDeck: [cardAs("Bellsprout", "bell-d", "Jungle")] }, ["heads"]);
    const res = await t.act("playTrainer", { cardId: "pb", selections: [["bell-d"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerHand.map((c) => c.id)).toEqual(["bell-d"]);
  });

  // ── Activated powers (effect registry) ───────────────────────────────────────

  it("Damage Swap: [[source], [target], [amount]] moves damage between own Pokémon", async () => {
    const t = setupGame(actor, {
      myActive: inPlay("Alakazam", "alakazam"),
      myBench: [inPlay("Pikachu", "pika", { damage: 20 })],
    });
    await expectRejected(t, t.act("usePower", { pokemonId: "alakazam", selections: [["pika"], ["alakazam"], ["30"]] }), /Opción no válida/);
    await expectRejected(t, t.act("usePower", { pokemonId: "pika", selections: [] }), "Este Pokémon no tiene un Poder Pokémon");
    const res = await t.act("usePower", { pokemonId: "alakazam", selections: [["pika"], ["alakazam"], ["10"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerBench[0].currentDamage).toBe(10);
    expect(t.mine().playerActivePokemon!.currentDamage).toBe(10);
  });

  it("a power can't be used by the opponent's Pokémon", async () => {
    const t = setupGame(actor, { theirBench: [inPlay("Alakazam", "their-alakazam")], myActive: inPlay("Pikachu", "my-active", { damage: 10 }) });
    await expectRejected(t, t.act("usePower", { pokemonId: "their-alakazam", selections: [] }), "Debes elegir uno de tus Pokémon en juego");
  });

  it("Heal heads: coin from requestCoinFlip, then [[damagedPokemonId]]; once per turn", async () => {
    const t = setupGame(actor, {
      myActive: inPlay("Pikachu", "my-active", { damage: 30 }),
      myBench: [inPlay("Vileplume", "vileplume", { set: "Jungle" })],
    }, ["heads"]);
    expect(t.requestCoins({ purpose: "power", pokemonId: "vileplume" })).toMatchObject({ success: true, results: ["heads"] });
    const res = await t.act("usePower", { pokemonId: "vileplume", selections: [["my-active"]] });
    expect(res.success, res.error).toBe(true);
    expect(res.opponentCoinFlipInfo).toEqual({ attackName: "Heal", results: ["heads"] });
    expect(t.mine().playerActivePokemon!.currentDamage).toBe(20);

    await expectRejected(t, t.act("usePower", { pokemonId: "vileplume", selections: [["my-active"]] }), /./);
    expect(t.requestCoins({ purpose: "power", pokemonId: "vileplume" }).success).toBe(false);
  });

  it("Heal tails: nothing to choose, the power is used", async () => {
    const t = setupGame(actor, {
      myActive: inPlay("Pikachu", "my-active", { damage: 30 }),
      myBench: [inPlay("Vileplume", "vileplume", { set: "Jungle" })],
    }, ["tails"]);
    await expectRejected(t, t.act("usePower", { pokemonId: "vileplume", selections: [["my-active"]] }), "Hay selecciones de más");
    const res = await t.act("usePower", { pokemonId: "vileplume", selections: [] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().playerActivePokemon!.currentDamage).toBe(30);
    expect(t.mine().usedPowersThisTurn).toContain("vileplume");
    expect(t.coinsLeft()).toBe(0); // the failed attempt kept its coin
  });

  // ── Attack legality ──────────────────────────────────────────────────────────

  it("illegal attacks are rejected before any coin: no Energy, Paralyzed, confused without Energy, twice", async () => {
    const noEnergy = setupGame(actor, { myActive: inPlay("Pikachu", "my-active") });
    await expectRejected(noEnergy, noEnergy.act("attack", { attackIndex: 0 }), "no tiene la energía necesaria");

    const paralyzed = setupGame(actor, { myActive: inPlay("Pikachu", "my-active", { energy: "LL", status: ["paralyzed"] }) });
    await expectRejected(paralyzed, paralyzed.act("attack", { attackIndex: 0 }), "paralizado");

    const confused = setupGame(actor, { myActive: inPlay("Pikachu", "my-active", { status: ["confused"] }) });
    await expectRejected(confused, confused.act("attack", { attackIndex: 1 }), "no tiene la energía necesaria");

    // Conversion's chosen type goes to the engine (chosenType), which ignores it for an attack
    // without ChangeWeakness / ChangeResistance: the attack is a normal one
    const conversion = setupGame(actor, { myActive: inPlay("Pikachu", "my-active", { energy: "LL" }) });
    const notConversion = await conversion.act("attack", { attackIndex: 0, conversionType: "fire", conversionEffect: "changeWeakness" });
    expect(notConversion.success, notConversion.error).toBe(true);
    expect(conversion.mine().opponentActivePokemon?.modifiedWeakness).toBeUndefined();

    const twice = setupGame(actor, { theirActive: inPlay("Raichu", "their-active") });
    const first = await twice.act("attack", { attackIndex: 0 }); // Growl, no coins
    expect(first.success, first.error).toBe(true);
    await expectRejected(twice, twice.act("attack", { attackIndex: 0 }), /./);
  });

  // ── Pending choices belong to the side whose turn it is ──────────────────────

  it("Call for Family: only the attacker sees and resolves its deck search", async () => {
    const t = setupGame(actor, {
      myActive: inPlay("Bellsprout", "my-active", { energy: "G", set: "Jungle" }),
      myDeck: [cardAs("Bellsprout", "bell-d", "Jungle"), cardAs("Grass Energy", "g-d")],
    });
    const res = await t.act("attack", { attackIndex: 1 });
    expect(res.success, res.error).toBe(true);
    expect(t.masked(actor).pendingDeckSearch).toBeDefined();
    expect(t.masked(other(actor)).pendingDeckSearch).toBeUndefined();
    expect(t.masked("spectator").pendingDeckSearch).toBeUndefined();

    await expectRejected(t, t.actAs(other(actor), "deckSearch", { cardId: "bell-d" }), "Not your turn");
    const search = await t.act("deckSearch", { cardId: "bell-d" });
    expect(search.success, search.error).toBe(true);
    expect(t.mine().playerBench.map((p) => p.pokemon.id)).toEqual(["bell-d"]);
    expect(t.mine().pendingDeckSearch).toBeUndefined();
  });

  it("Peek: the peeked card only reaches the player who peeked", async () => {
    const deck = [cardAs("Bellsprout", "top-card", "Jungle"), cardAs("Grass Energy", "g-d")];
    const t = setupGame(actor, { myBench: [inPlay("Mankey", "mankey", { set: "Jungle" })], myDeck: deck });
    const res = await t.act("usePower", { pokemonId: "mankey", selections: [["playerDeck"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.masked(actor).pendingPeek?.revealedCards.map((c) => c.id)).toEqual(["top-card"]);
    expect(t.masked(other(actor)).pendingPeek).toBeUndefined();
    expect(t.masked("spectator").pendingPeek).toBeUndefined();
    await expectRejected(t, t.actAs(other(actor), "clearPeek"), "Not your turn");
    expect((await t.act("clearPeek")).success).toBe(true);
  });

  it("the starting player is swapped for player 2 and kept as stored", async () => {
    const t = setupGame(actor, { myHand: [cardAs("Pikachu", "pika-h")] });
    const stored = t.room.gameState!.startingPlayer;
    expect(stored).toBe(actor === "p1" ? "player" : "opponent"); // the actor started
    expect(t.masked(actor).startingPlayer).toBe("player");
    expect(t.masked(other(actor)).startingPlayer).toBe("opponent");
    expect((await t.act("playBasicToBench", { cardId: "pika-h" })).success).toBe(true);
    expect(t.room.gameState!.startingPlayer).toBe(stored);
  });
});

describe("start of the game", () => {
  function mulliganRoom(coin: Coin) {
    const manager = new GameRoomManager(() => coin);
    const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
    const state = {
      ...base,
      gamePhase: GamePhase.Mulligan,
      playerHand: base.playerDeck.slice(0, 7),
      playerDeck: base.playerDeck.slice(7, 47),
      opponentHand: base.opponentDeck.slice(0, 7),
      opponentDeck: base.opponentDeck.slice(7, 47),
      playerActivePokemon: inPlay("Pikachu", "p1-active"),
      opponentActivePokemon: inPlay("Pikachu", "p2-active"),
      playerReady: false,
      opponentReady: false,
      events: [],
    } as unknown as GameState;
    const room = manager.createRoom();
    Object.assign(room, { player1SocketId: "s1", player2SocketId: "s2", status: "playing", gameState: state });
    return { manager, room };
  }

  it.each(["s1", "s2"])("setup: %s places its Active then Bench without waiting for its turn", async (socket) => {
    const { manager, room } = mulliganRoom("heads");
    const mine = socket === "s1" ? "player" : "opponent";
    const state = room.gameState as unknown as Record<string, unknown>;
    state[`${mine}ActivePokemon`] = null;
    state[`${mine}Hand`] = [cardAs("Pikachu", "pika-a"), cardAs("Pikachu", "pika-b"), cardAs("Raichu", "raichu")];
    expect((await manager.executeAction(room.id, socket, { type: "playBasicToBench", payload: { cardId: "pika-b" } })).error).toBe(
      "Primero coloca tu Pokémon activo",
    );
    expect((await manager.executeAction(room.id, socket, { type: "playBasicToActive", payload: { cardId: "pika-a" } })).success).toBe(true);
    expect((await manager.executeAction(room.id, socket, { type: "playBasicToBench", payload: { cardId: "pika-b" } })).success).toBe(true);
    expect((await manager.executeAction(room.id, socket, { type: "playBasicToBench", payload: { cardId: "raichu" } })).success).toBe(false);
    const after = room.gameState as unknown as Record<string, PokemonInPlay | PokemonInPlay[] | null>;
    expect((after[`${mine}ActivePokemon`] as PokemonInPlay).pokemon.id).toBe("pika-a");
    expect((after[`${mine}ActivePokemon`] as PokemonInPlay).playedOnTurn).toBe(0);
    expect((after[`${mine}Bench`] as PokemonInPlay[]).map((p) => p.pokemon.id)).toEqual(["pika-b"]);
  });

  it.each([["heads", "player1"], ["tails", "player2"]] as const)("coin %s: %s starts and draws its first card (once)", async (coin, starter) => {
    const { manager, room } = mulliganRoom(coin);
    expect((await manager.executeAction(room.id, "s1", { type: "playerReady" })).success).toBe(true);
    expect((await manager.executeAction(room.id, "s2", { type: "playerReady" })).success).toBe(true);
    const state = room.gameState!;
    expect(state.gamePhase).toBe("PLAYING");
    expect(state.turnNumber).toBe(1);
    expect(state.isPlayerTurn).toBe(starter === "player1");
    expect(state.playerHand).toHaveLength(starter === "player1" ? 8 : 7);
    expect(state.opponentHand).toHaveLength(starter === "player2" ? 8 : 7);
    expect(state.playerDeck.length + state.playerHand.length).toBe(47);
  });
});
