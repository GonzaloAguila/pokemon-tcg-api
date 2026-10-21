/**
 * Team Rocket in multiplayer (TR contract, pokemon-tcg-packs/tr-contract.md): on-play power
 * choices (resolvePowerChoice), Sinkhole retreat coins, coins flipped by the other player
 * (Knock Down, Digger: flippedBy), Final Beam's defender coin, server-run Trainer steps
 * (startTrainer / answerTrainerChoice: Challenge!, Rocket's Sneak Attack), face-up Prizes, Hay
 * Fever, Rainbow Energy and Conversion via chosenType. Every scenario runs as player 1 and as
 * player 2 (the state is stored in player 1's perspective; player 2 acts on a swapSides copy).
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getDeckById,
  initializeMultiplayerGame,
  isPokemonCard,
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
type Step = { title: string; options: { id: string }[]; cards?: GameCard[]; chooser?: string; [k: string]: unknown };
type Masked = GameState & {
  pendingPowerChoice?: { step: Step; waiting?: boolean; [k: string]: unknown };
  pendingTrainerChoice?: { cardId: string; trainerName: string; step: Step; chooser: string; waiting?: boolean };
};

const SOCKET = { p1: "s1", p2: "s2" } as const;
const VIEWER = { p1: "player1", p2: "player2" } as const;
const other = (side: Side): Side => (side === "p1" ? "p2" : "p1");

function byName(name: string, set = "Base Set"): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === set);
  if (!found) throw new Error(`card ${name} (${set}) not in catalog`);
  return found as GameCard;
}
const cardAs = (name: string, id: string, set?: string): GameCard => ({ ...byName(name, set), id });
const tr = (name: string, id: string): GameCard => cardAs(name, id, "Team Rocket");

const ENERGY_NAME: Record<string, string> = { L: "Lightning Energy", W: "Water Energy", F: "Fighting Energy", G: "Grass Energy", C: "Double Colorless Energy" };

function inPlay(card: GameCard, opts: { energy?: string; damage?: number; playedOnTurn?: number } = {}): PokemonInPlay {
  return {
    pokemon: toInPlayCard(card),
    attachedEnergy: [...(opts.energy ?? "")].map((code, i) => cardAs(ENERGY_NAME[code], `${card.id}-e${i}`)),
    attachedTrainers: [],
    previousEvolutions: [],
    currentDamage: opts.damage ?? 0,
    statusConditions: [],
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
  const shuffled = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  // Basic Pokémon first so the deck slices below always hold some (Challenge!, Summon Minions)
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

  const actAs = (side: Side, type: string, payload: unknown = {}) => manager.executeAction(room.id, SOCKET[side], { type, payload });
  return {
    manager,
    room,
    act: (type: string, payload: unknown = {}) => actAs(actor, type, payload),
    actAs,
    /** Stored state in the actor's perspective */
    mine: () => (actor === "p1" ? room.gameState! : swapSides(room.gameState!)),
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

/** A non-answerer's stub: the question, nothing to choose from. */
function expectStrippedStep(step: Step | undefined) {
  expect(step).toBeDefined();
  expect(step!.options).toEqual([]);
  for (const hidden of ["cards", "orderingCards", "thumbnails"]) expect(step![hidden]).toBeUndefined();
  expect(typeof step!.title).toBe("string");
}

const isBasic = (c: GameCard) => isPokemonCard(c) && c.stage === "basic";
const hidden = (cards: unknown[]) => cards.every((c) => (c as { hidden?: boolean }).hidden === true);

describe.each(["p1", "p2"] as const)("Team Rocket in multiplayer as %s", (actor) => {
  const opp = other(actor);

  // ── On-play power choices ──────────────────────────────────────────────────────

  it("Dark Dragonite's Summon Minions: resolvePowerChoice by the acting side only, masked for the opponent", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay(tr("Dark Dragonair", "dragonair"))],
      myHand: [tr("Dark Dragonite", "dragonite-h")],
    });
    expect((await t.act("evolve", { cardId: "dragonite-h", targetPokemonId: "dragonair" })).success).toBe(true);
    const pending = t.mine().pendingPowerChoice!;
    expect(pending.powerName).toBe("Invocar Secuaces");
    expect(pending.pokemonId).toBe("dragonite-h"); // the evolved Pokémon takes the evolution card's id

    // The acting player sees the deck's Basics; the opponent and spectators get the stub
    const full = t.masked(actor).pendingPowerChoice!;
    expect(full.waiting).toBeUndefined();
    const basics = full.step.options.map((o) => o.id);
    expect(basics.length).toBeGreaterThanOrEqual(2);
    for (const viewer of [opp, "spectator"] as const) {
      const stub = t.masked(viewer).pendingPowerChoice!;
      expect(Object.keys(stub).sort()).toEqual(["pokemonId", "powerName", "step", "waiting"]);
      expect(stub.waiting).toBe(true);
      expectStrippedStep(stub.step);
    }

    // Nothing else moves; the opponent can't answer
    await expectRejected(t, t.act("endTurn"), /Primero hay que resolver el Poder Pokémon/);
    await expectRejected(t, t.actAs(opp, "resolvePowerChoice", { selection: basics.slice(0, 1) }), /No es tu turno/);
    await expectRejected(t, t.act("resolvePowerChoice", { selection: ["not-an-option"] }), /./);

    expect((await t.act("resolvePowerChoice", { selection: basics.slice(0, 2) })).success).toBe(true);
    const after = t.mine();
    expect(after.pendingPowerChoice).toBeUndefined();
    expect(after.playerBench.map((p) => p.pokemon.id)).toEqual(["dragonite-h", ...basics.slice(0, 2)]);
    expect(after.playerDeck.some((c) => basics.slice(0, 2).includes(c.id))).toBe(false);
    expect(after.isPlayerTurn).toBe(true);
    await expectRejected(t, t.act("resolvePowerChoice", { selection: [] }), /No hay ninguna elección de Poder Pokémon/);
  });

  it("Dark Golbat's Sneak Attack: 10 damage to the chosen Pokémon of the opponent", async () => {
    const t = setupGame(actor, {
      myBench: [inPlay(cardAs("Zubat", "zubat", "Fossil"))],
      myHand: [tr("Dark Golbat", "golbat-h")],
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    expect((await t.act("evolve", { cardId: "golbat-h", targetPokemonId: "zubat" })).success).toBe(true);
    expect(t.masked(actor).pendingPowerChoice!.step.options.map((o) => o.id).sort()).toEqual(["bulba", "their-active"]);
    expect(t.masked(opp).pendingPowerChoice!.waiting).toBe(true);
    expect((await t.act("resolvePowerChoice", { selection: ["bulba"] })).success).toBe(true);
    expect(t.mine().opponentBench[0].currentDamage).toBe(10);
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(0);
  });

  // ── Coins ──────────────────────────────────────────────────────────────────────

  it("Sinkhole: the retreating player's server coin, tails = 20 to the retreated Pokémon; illegal retreats flip nothing", async () => {
    const board = {
      myBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
      theirBench: [inPlay(tr("Dark Dugtrio", "dugtrio"))],
    };
    const illegal = setupGame(actor, board);
    await expectRejected(illegal, illegal.act("retreat", { energyIdsToDiscard: [], benchIndex: 0 }), /energía/);

    const t = setupGame(actor, board, ["tails"]);
    const res = await t.act("retreat", { energyIdsToDiscard: ["my-active-e0"], benchIndex: 0 });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: "Socavón", results: ["tails"] });
    expect(t.mine().playerActivePokemon?.pokemon.id).toBe("bulba");
    expect(t.mine().playerBench.find((p) => p.pokemon.id === "my-active")?.currentDamage).toBe(20);

    const heads = setupGame(actor, board, ["heads"]);
    expect((await heads.act("retreat", { energyIdsToDiscard: ["my-active-e0"], benchIndex: 0 })).coinFlipInfo?.results).toEqual(["heads"]);
    expect(heads.mine().playerBench.find((p) => p.pokemon.id === "my-active")?.currentDamage).toBe(0);
  });

  it("Sinkhole Knocks Out the retreated Pokémon: Prize for the Dugtrio's owner", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(cardAs("Pikachu", "my-active"), { energy: "L", damage: 20 }),
      myBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
      theirBench: [inPlay(tr("Dark Dugtrio", "dugtrio"))],
    }, ["tails"]);
    expect((await t.act("retreat", { energyIdsToDiscard: ["my-active-e0"], benchIndex: 0 })).success).toBe(true);
    const after = t.mine();
    expect(after.playerBench.map((p) => p.pokemon.id)).toEqual([]);
    expect(after.playerDiscard.map((c) => c.id)).toContain("my-active");
    // game-core 0.10.2: the Dugtrio's owner is owed the Prize and picks it by hand
    expect(after.opponentCanTakePrize).toBe(true);
    expect(after.opponentPrizesOwed).toBe(1);
    expect(after.opponentPrizes).toHaveLength(6);
  });

  it("Knock Down: the attack's coin is flipped by the defending player (flippedBy)", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(tr("Dark Dugtrio", "dugtrio"), { energy: "FF" }),
      theirActive: inPlay(cardAs("Dragonair", "their-active")),
    }, ["tails"]);
    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: "Derribar", results: ["tails"], flippedBy: ["defender"] });
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(40);
  });

  it("Final Beam: the Knocked Out Dark Gyarados' coin comes as defenderResults", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay(tr("Dark Gyarados", "gyarados"), { energy: "W", damage: 60 }),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    }, ["heads"]);
    const res = await t.act("attack", { attackIndex: 0 }); // Pikachu's Gnaw: no coins of its own
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: "Roer", results: [], defenderResults: ["heads"] });
    expect(t.mine().opponentActivePokemon).toBeNull();
    expect(t.mine().playerActivePokemon?.currentDamage).toBe(20); // 20 x 1 Water Energy
  });

  it("Digger: coins until tails alternate players (flippedBy), rolled at requestCoinFlip", async () => {
    const t = setupGame(actor, { myHand: [tr("Digger", "digger-h")] }, ["heads", "tails"]);
    const ack = t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "trainer", cardId: "digger-h" });
    expect(ack).toEqual({ success: true, results: ["heads", "tails"], result: "heads", flippedBy: ["attacker", "defender"] });
    const res = await t.act("playTrainer", { cardId: "digger-h", selections: [] });
    expect(res.success, res.error).toBe(true);
    expect(res.opponentCoinFlipInfo).toEqual({ attackName: "Digger", results: ["heads", "tails"], flippedBy: ["attacker", "defender"] });
    expect(res.coinsShownTo).toBe(VIEWER[actor]);
    // Tails on the opponent's coin (odd index): the opponent's Active takes 10
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(10);
    expect(t.mine().playerActivePokemon?.currentDamage).toBe(0);
  });

  // ── Server-run Trainer steps ─────────────────────────────────────────────────

  it("Challenge! accepted: the opponent accepts, both pick Basics; the opponent never sees the player's picks", async () => {
    const t = setupGame(actor, { myHand: [tr("Challenge!", "challenge-h")] });
    // playTrainer can't answer for the opponent
    await expectRejected(t, t.act("playTrainer", { cardId: "challenge-h", selections: [["accept"], [], []] }), /startTrainer/);

    expect((await t.act("startTrainer", { cardId: "challenge-h", selections: [] })).success).toBe(true);
    const ask = t.masked(opp).pendingTrainerChoice!;
    expect(ask).toMatchObject({ cardId: "challenge-h", trainerName: "Challenge!", chooser: "opponent" });
    expect(ask.waiting).toBeUndefined();
    expect(ask.step.options.map((o) => o.id)).toEqual(["accept", "decline"]);
    // Wording: the opponent (answerer) gets stepForAnswerer's text, the waiting player the step's own
    const rawStep = (t.room.gameState as GameState & { pendingTrainerChoice: { step: Step } }).pendingTrainerChoice.step;
    expect(rawStep.answererDescription).toBeDefined();
    expect(ask.step.description).toBe(rawStep.answererDescription);
    expect(ask.step.title).toBe(rawStep.answererTitle ?? rawStep.title);
    for (const viewer of [actor, "spectator"] as const) {
      const stub = t.masked(viewer).pendingTrainerChoice!;
      expect(stub.waiting).toBe(true);
      expect(stub.chooser).toBe("opponent");
      expectStrippedStep(stub.step);
      expect(stub.step.description).toBe(rawStep.description);
    }
    // Only the opponent answers; nothing else moves meanwhile (surrender aside)
    await expectRejected(t, t.act("answerTrainerChoice", { selection: ["accept"] }), /No te corresponde elegir/);
    await expectRejected(t, t.act("endTurn"), /Primero hay que resolver la carta de Entrenador/);
    await expectRejected(t, t.act("attack", { attackIndex: 0 }), /Primero hay que resolver la carta de Entrenador/);
    expect(t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "trainer", cardId: "challenge-h" })).toMatchObject({ success: false });
    await expectRejected(t, t.actAs(opp, "answerTrainerChoice", { selection: ["maybe"] }), /Opción no válida/);

    // The opponent waits on nobody's turn timer: the player whose turn it is may kick, not the opponent
    t.room.turnStartedAt = Date.now() - 200_000;
    expect(t.manager.requestKick(t.room.id, SOCKET[opp]).success).toBe(false);

    expect((await t.actAs(opp, "answerTrainerChoice", { selection: ["accept"] })).success).toBe(true);
    // Step 2: the player picks Basics of their own deck; the opponent gets the stub
    const mineStep = t.masked(actor).pendingTrainerChoice!;
    expect(mineStep.chooser).toBe("self");
    const myPicks = mineStep.step.options.map((o) => o.id).slice(0, 2);
    expect(myPicks).toHaveLength(2);
    expect(t.masked(opp).pendingTrainerChoice!.waiting).toBe(true);
    await expectRejected(t, t.actAs(opp, "answerTrainerChoice", { selection: [] }), /No te corresponde elegir/);
    expect((await t.act("answerTrainerChoice", { selection: myPicks })).success).toBe(true);

    // Step 3: the opponent picks theirs; nothing they receive mentions the player's picks
    const theirStep = t.masked(opp).pendingTrainerChoice!;
    expect(theirStep.chooser).toBe("opponent");
    expect(theirStep.waiting).toBeUndefined();
    const oppJson = JSON.stringify(t.masked(opp));
    for (const id of myPicks) expect(oppJson).not.toContain(id);
    expect(JSON.stringify(t.masked("spectator"))).not.toContain(myPicks[0]);
    const theirPicks = theirStep.step.options.map((o) => o.id).slice(0, 1);
    expect(theirPicks).toHaveLength(1);
    expect(t.masked(actor).pendingTrainerChoice!.waiting).toBe(true);

    const done = await t.actAs(opp, "answerTrainerChoice", { selection: theirPicks });
    expect(done.success, done.error).toBe(true);
    const after = t.mine() as GameState & { pendingTrainerChoice?: unknown };
    expect(after.pendingTrainerChoice).toBeUndefined();
    expect(t.room.pendingTrainer).toBeUndefined();
    expect(after.playerBench.map((p) => p.pokemon.id).sort()).toEqual([...myPicks].sort());
    expect(after.opponentBench.map((p) => p.pokemon.id)).toEqual(theirPicks);
    expect(after.playerDiscard.map((c) => c.id)).toContain("challenge-h");
    expect(after.isPlayerTurn).toBe(true);
    // Events speak for the Trainer's player ("Jugador N jugó Challenge!...")
    const me = actor === "p1" ? "Jugador 1" : "Jugador 2";
    expect(t.room.gameState!.events.some((e) => e.message.startsWith(`${me} jugó Challenge!`))).toBe(true);
    await expectRejected(t, t.actAs(opp, "answerTrainerChoice", { selection: [] }), /No hay ninguna carta de Entrenador/);
  });

  it("Challenge! unanswered: no kick; when the opponent's answer clock runs out the server answers by default", async () => {
    const t = setupGame(actor, { myHand: [tr("Challenge!", "challenge-h")] });
    expect((await t.act("startTrainer", { cardId: "challenge-h", selections: [] })).success).toBe(true);
    t.room.turnStartedAt = Date.now() - 200_000;
    expect(t.manager.requestKick(t.room.id, SOCKET[opp])).toMatchObject({ success: false });
    // Owner rule (Gym Heroes): an off-turn answer is never a forfeit
    expect(t.manager.requestKick(t.room.id, SOCKET[actor])).toMatchObject({ success: false, error: expect.stringMatching(/respuesta por defecto/) });
    // Default answer: the engine's step.defaultSelection, "decline" (the player draws 2)
    expect((t.room.gameState as GameState & { pendingTrainerChoice: { step: { defaultSelection?: string[] } } }).pendingTrainerChoice.step.defaultSelection).toEqual(["decline"]);
    expect((await t.manager.autoAnswerTimedOut(t.room.id))?.success).toBe(true);
    expect(t.mine().playerHand).toHaveLength(2);
    expect(t.room.pendingTrainer).toBeUndefined();
    expect(t.mine().isPlayerTurn).toBe(true);
    expect(t.room.answerClock).toBeUndefined();
  });

  it("Challenge! declined: the player draws 2", async () => {
    const t = setupGame(actor, { myHand: [tr("Challenge!", "challenge-h")] });
    const deckBefore = t.mine().playerDeck.length;
    expect((await t.act("startTrainer", { cardId: "challenge-h", selections: [] })).success).toBe(true);
    expect((await t.actAs(opp, "answerTrainerChoice", { selection: ["decline"] })).success).toBe(true);
    const after = t.mine();
    expect(after.playerHand).toHaveLength(2);
    expect(after.playerDeck).toHaveLength(deckBefore - 2);
    expect(after.playerBench).toEqual([]);
    expect(t.room.pendingTrainer).toBeUndefined();
  });

  it("Rocket's Sneak Attack: the opponent's hand is revealed only to the player, through the step", async () => {
    const theirHand = [cardAs("Potion", "their-potion"), cardAs("Bulbasaur", "their-bulba"), cardAs("Grass Energy", "their-grass")];
    const t = setupGame(actor, { myHand: [tr("Rocket's Sneak Attack", "rsa-h")], theirHand });
    await expectRejected(t, t.act("playTrainer", { cardId: "rsa-h", selections: [["their-potion"]] }), /startTrainer/);

    expect((await t.act("startTrainer", { cardId: "rsa-h", selections: [] })).success).toBe(true);
    const full = t.masked(actor).pendingTrainerChoice!;
    expect(full.chooser).toBe("self");
    expect(full.step.reveals).toBe("opponentHand");
    expect(full.step.cards?.map((c) => c.id)).toEqual(["their-potion", "their-bulba", "their-grass"]);
    expect(full.step.cards?.[0].name).toBe("Potion");
    // The hand itself stays masked for the player; the opponent / spectators get the stub
    expect(hidden(t.masked(actor).opponentHand)).toBe(true);
    for (const viewer of [opp, "spectator"] as const) {
      const stub = t.masked(viewer).pendingTrainerChoice!;
      expect(stub.waiting).toBe(true);
      expectStrippedStep(stub.step);
    }
    await expectRejected(t, t.actAs(opp, "answerTrainerChoice", { selection: [] }), /No te corresponde elegir/);
    await expectRejected(t, t.act("answerTrainerChoice", { selection: ["their-bulba"] }), /Opción no válida/);

    expect((await t.act("answerTrainerChoice", { selection: ["their-potion"] })).success).toBe(true);
    const after = t.mine();
    expect(after.opponentHand.map((c) => c.id)).toEqual(["their-bulba", "their-grass"]);
    expect(after.opponentDeck.map((c) => c.id)).toContain("their-potion");
    expect(after.playerDiscard.map((c) => c.id)).toContain("rsa-h");
  });

  it("Rocket's Sneak Attack against an empty hand is played at once by startTrainer", async () => {
    const t = setupGame(actor, { myHand: [tr("Rocket's Sneak Attack", "rsa-h")], theirHand: [] });
    expect((await t.act("startTrainer", { cardId: "rsa-h", selections: [] })).success).toBe(true);
    expect((t.mine() as { pendingTrainerChoice?: unknown }).pendingTrainerChoice).toBeUndefined();
    expect(t.mine().playerDiscard.map((c) => c.id)).toContain("rsa-h");
  });

  // ── Revealed information, blockers, Energy, Conversion ──────────────────────

  it("Here Comes Team Rocket!: both sides' Prizes are sent face up to both players and spectators", async () => {
    const t = setupGame(actor, { myHand: [tr("Here Comes Team Rocket!", "hctr-h")] });
    expect(hidden(t.masked(actor).opponentPrizes)).toBe(true);
    expect(hidden(t.masked("spectator").playerPrizes)).toBe(true);
    expect((await t.act("playTrainer", { cardId: "hctr-h", selections: [] })).success).toBe(true);
    for (const viewer of [actor, opp] as const) {
      const masked = t.masked(viewer);
      expect(masked.opponentPrizes.every((c) => typeof c.name === "string")).toBe(true);
      expect(masked.playerPrizes.every((c) => typeof c.name === "string")).toBe(true);
      // The rest of the opponent's hidden zones stay hidden
      expect(hidden(masked.opponentHand)).toBe(true);
      expect(hidden(masked.opponentDeck)).toBe(true);
    }
    const spectator = t.masked("spectator");
    expect(spectator.playerPrizes.every((c) => typeof c.name === "string")).toBe(true);
    expect(spectator.opponentPrizes.every((c) => typeof c.name === "string")).toBe(true);
    expect(hidden(spectator.playerHand)).toBe(true);
  });

  it("Hay Fever (either side's Dark Vileplume) blocks Trainers: playTrainer, startTrainer and coins", async () => {
    for (const where of ["mine", "theirs"] as const) {
      const vileplume = [inPlay(tr("Dark Vileplume", "vileplume"))];
      const t = setupGame(actor, {
        myHand: [cardAs("Potion", "potion-h"), tr("Challenge!", "challenge-h"), cardAs("Poké Ball", "ball-h", "Jungle")],
        myActive: inPlay(cardAs("Pikachu", "my-active"), { energy: "L", damage: 10 }),
        ...(where === "mine" ? { myBench: vileplume } : { theirBench: vileplume }),
      });
      await expectRejected(t, t.act("playTrainer", { cardId: "potion-h", selections: [["my-active"]] }), /Entrenador|Trainer/i);
      await expectRejected(t, t.act("startTrainer", { cardId: "challenge-h", selections: [] }), /Entrenador|Trainer/i);
      expect(t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "trainer", cardId: "ball-h" })).toMatchObject({ success: false });
    }
  });

  it("Rainbow Energy: attaching it does 10 damage to that Pokémon", async () => {
    const t = setupGame(actor, { myHand: [tr("Rainbow Energy", "rainbow-h")] });
    expect((await t.act("attachEnergy", { cardId: "rainbow-h", pokemonId: "my-active" })).success).toBe(true);
    const active = t.mine().playerActivePokemon!;
    expect(active.attachedEnergy.map((e) => e.id)).toContain("rainbow-h");
    expect(active.currentDamage).toBe(10);
  });

  it("Conversion 1 / 2: conversionType goes to the engine as chosenType", async () => {
    const weakness = setupGame(actor, { myActive: inPlay(cardAs("Porygon", "porygon"), { energy: "L" }) });
    const res = await weakness.act("attack", { attackIndex: 0, conversionType: "water", conversionEffect: "changeWeakness" });
    expect(res.success, res.error).toBe(true);
    expect(weakness.mine().opponentActivePokemon?.modifiedWeakness).toBe("water");
    expect(weakness.mine().isPlayerTurn).toBe(false);

    const resistance = setupGame(actor, { myActive: inPlay(cardAs("Porygon", "porygon"), { energy: "LL" }) });
    expect((await resistance.act("attack", { attackIndex: 1, conversionType: "fire" })).success).toBe(true);
    const porygon = resistance.mine().playerActivePokemon!;
    expect(isPokemonCard(porygon.pokemon) && porygon.modifiedResistance).toBe("fire");
  });
});
