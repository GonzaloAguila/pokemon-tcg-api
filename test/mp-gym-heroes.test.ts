/**
 * Gym Heroes in multiplayer: Stadiums (state.stadium, stadiumAction, Vermilion City Gym's coin),
 * Narrow Gym's Bench trim (benchTrim, off-turn), mid-attack questions (Flee answered by the
 * defender, Sabrina's ESP re-flip rolled by the server), Recall's attack indices, Blaine's Gamble's
 * coin after its steps, Minion of Team Rocket ending the turn once, attached Trainers, Tickling
 * Machine's face-down hands and the answer clock (an off-turn answer runs its own clock and is
 * answered by default when it runs out, never a kick). Every scenario runs as player 1 and as
 * player 2 (the state is stored in player 1's perspective; player 2 acts on a swapSides copy).
 */
import { describe, expect, it, vi } from "vitest";
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
import { GameRoomManager, attackCoinInfo, defaultSelection } from "../src/socket/rooms.js";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";
import { maskRoomState } from "../src/socket/room-state.js";

type Side = "p1" | "p2";
type Coin = "heads" | "tails";
type Masked = GameState & Record<string, any>;

const SOCKET = { p1: "s1", p2: "s2" } as const;
const USER = { p1: "user-1", p2: "user-2" } as const;
const VIEWER = { p1: "player1", p2: "player2" } as const;
const other = (side: Side): Side => (side === "p1" ? "p2" : "p1");

function byName(name: string, set = "Base Set"): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === set);
  if (!found) throw new Error(`card ${name} (${set}) not in catalog`);
  return found as GameCard;
}
const cardAs = (name: string, id: string, set?: string): GameCard => ({ ...byName(name, set), id });
const gh = (name: string, id: string): GameCard => cardAs(name, id, "Gym Heroes");

const ENERGY_NAME: Record<string, string> = {
  L: "Lightning Energy", W: "Water Energy", F: "Fighting Energy", G: "Grass Energy", P: "Psychic Energy", C: "Double Colorless Energy",
};

function inPlay(
  card: GameCard,
  opts: { energy?: string; damage?: number; under?: GameCard[]; status?: string[]; trainers?: GameCard[] } = {},
): PokemonInPlay {
  return {
    pokemon: toInPlayCard(card),
    attachedEnergy: [...(opts.energy ?? "")].map((code, i) => cardAs(ENERGY_NAME[code], `${card.id}-e${i}`)),
    attachedTrainers: opts.trainers ?? [],
    previousEvolutions: opts.under ?? [],
    currentDamage: opts.damage ?? 0,
    statusConditions: opts.status ?? [],
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
  /** The Stadium in play, in the actor's perspective */
  stadium?: { card: GameCard; playedBy: "player" | "opponent" };
}

const isBasic = (c: GameCard) => isPokemonCard(c) && c.stage === "basic";

/**
 * A PLAYING game where it is `actor`'s turn, built in the actor's perspective. Coins: a script
 * (throws when it runs out: no unexpected flip) or a function.
 */
function setupGame(actor: Side, board: Board = {}, coins: Coin[] | (() => Coin) = []) {
  const queue = Array.isArray(coins) ? [...coins] : [];
  const manager = new GameRoomManager(() => {
    if (typeof coins === "function") return coins();
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
    opponentDiscard: [],
    energyAttachedThisTurn: false,
    activeModifiers: [],
    events: [],
    ...(board.stadium ? { stadium: board.stadium } : {}),
  } as unknown as GameState;

  const room = manager.createRoom();
  Object.assign(room, {
    player1Id: USER.p1,
    player2Id: USER.p2,
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
    /** Stored state in `side`'s perspective (default: the actor's) */
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

const fiveBenched = (prefix: string) =>
  ["Bulbasaur", "Charmander", "Squirtle", "Rattata", "Pidgey"].map((name, i) => inPlay(cardAs(name, `${prefix}-${i}`)));

describe.each(["p1", "p2"] as const)("Gym Heroes in multiplayer as %s", (actor) => {
  const opp = other(actor);

  // ── Stadiums ───────────────────────────────────────────────────────────────────

  it("a Stadium played by one player is in both players' states, playedBy relative to each", async () => {
    const t = setupGame(actor, { myHand: [gh("Pewter City Gym", "pewter-h")] });
    expect((await t.act("playTrainer", { cardId: "pewter-h", selections: [] })).success).toBe(true);
    expect(t.masked(actor).stadium).toMatchObject({ card: { id: "pewter-h", name: "Pewter City Gym" }, playedBy: "player" });
    expect(t.masked(opp).stadium).toMatchObject({ card: { id: "pewter-h", name: "Pewter City Gym" }, playedBy: "opponent" });
    expect(t.masked("spectator").stadium).toMatchObject({ card: { name: "Pewter City Gym" }, playedBy: actor === "p1" ? "player" : "opponent" });
    expect(t.mine().playerHand).toEqual([]);
  });

  it("Celadon City Gym: stadiumAction { selections } on the acting side's view (the other player's Stadium)", async () => {
    const t = setupGame(actor, {
      myActive: inPlay(gh("Erika's Oddish", "oddish"), { energy: "GG", status: ["poisoned"] }),
      stadium: { card: gh("Celadon City Gym", "celadon"), playedBy: "opponent" },
    });
    expect(t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "stadium" })).toMatchObject({ success: false, error: /no lanza monedas/ });
    await expectRejected(t, t.actAs(opp, "stadiumAction", { selections: [["oddish"], ["oddish-e0"]] }), /Not your turn/);
    await expectRejected(t, t.act("stadiumAction", { selections: [["their-active"]] }), /./);
    const res = await t.act("stadiumAction", { selections: [["oddish"], ["oddish-e0"]] });
    expect(res.success, res.error).toBe(true);
    const after = t.mine();
    expect(after.playerActivePokemon?.statusConditions).toEqual([]);
    expect(after.playerActivePokemon?.attachedEnergy.map((e) => e.id)).toEqual(["oddish-e1"]);
    expect(after.playerDiscard.map((c) => c.id)).toContain("oddish-e0");
    expect(after.stadium?.playedBy).toBe("opponent");
  });

  it("Vermilion City Gym: attack { vermilionCoin: true } adds the Stadium's server coin; refused without the Stadium", async () => {
    const board = { myActive: inPlay(gh("Lt. Surge's Spearow", "spearow"), { energy: "L" }) };
    const without = setupGame(actor, board);
    await expectRejected(without, without.act("attack", { attackIndex: 0, vermilionCoin: true }), /./);
    expect(without.coinsLeft()).toBe(0);

    const t = setupGame(actor, { ...board, stadium: { card: gh("Vermilion City Gym", "vermilion"), playedBy: "player" } }, ["heads"]);
    const res = await t.act("attack", { attackIndex: 0, vermilionCoin: true });
    expect(res.success, res.error).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: "Pico Taladro", results: ["heads"] });
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(30); // 20 + 10 (heads)

    // Without the opt-in: no coin at all
    const plain = setupGame(actor, { ...board, stadium: { card: gh("Vermilion City Gym", "vermilion"), playedBy: "player" } });
    const plainRes = await plain.act("attack", { attackIndex: 0 });
    expect(plainRes.success, plainRes.error).toBe(true);
    expect(plainRes.coinFlipInfo).toBeUndefined();
    expect(plain.mine().opponentActivePokemon?.currentDamage).toBe(20);
  });

  // ── Narrow Gym ───────────────────────────────────────────────────────────────────

  it("Narrow Gym: the opponent trims first, off-turn (benchTrim), then the player; nothing else meanwhile", async () => {
    const t = setupGame(actor, {
      myHand: [gh("Narrow Gym", "narrow-h")],
      myBench: fiveBenched("mine"),
      theirBench: fiveBenched("theirs"),
    });
    expect((await t.act("playTrainer", { cardId: "narrow-h", selections: [] })).success).toBe(true);
    expect(t.mine().pendingBenchTrim).toEqual([{ side: "opponent", keep: 4 }, { side: "player", keep: 4 }]);
    // Public: both players see the queue in their own perspective
    expect(t.masked(opp).pendingBenchTrim).toEqual([{ side: "player", keep: 4 }, { side: "opponent", keep: 4 }]);

    await expectRejected(t, t.act("benchTrim", { discardIds: ["mine-0"] }), /No te corresponde elegir/);
    await expectRejected(t, t.act("endTurn"), /Primero hay que reducir la Banca/);
    await expectRejected(t, t.actAs(opp, "benchTrim", { discardIds: ["mine-0"] }), /./);

    const res = await t.actAs(opp, "benchTrim", { discardIds: ["theirs-4"] });
    expect(res.success, res.error).toBe(true);
    expect(t.mine().opponentBench.map((p) => p.pokemon.id)).toEqual(["theirs-0", "theirs-1", "theirs-2", "theirs-3"]);
    expect(t.mine().opponentHand.map((c) => c.id)).toContain("theirs-4"); // back to the hand
    await expectRejected(t, t.actAs(opp, "benchTrim", { discardIds: ["theirs-0"] }), /No te corresponde elegir/);

    expect((await t.act("benchTrim", { discardIds: ["mine-1"] })).success).toBe(true);
    expect(t.mine().pendingBenchTrim ?? []).toEqual([]);
    expect(t.mine().playerBench).toHaveLength(4);
    expect(t.mine().isPlayerTurn).toBe(true);
    expect((await t.act("endTurn")).success).toBe(true);
  });

  // ── Mid-attack questions ─────────────────────────────────────────────────────────

  it("Flee: the attack pauses (not done, turn goes on), the defender answers off-turn and the attack resumes", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay(gh("Misty's Tentacruel", "tentacruel")),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    const res = await t.act("attack", { attackIndex: 0 }); // Pikachu's Gnaw: 10
    expect(res.success, res.error).toBe(true);
    expect(res.attackPaused).toBe(true);
    const paused = t.mine();
    expect(paused.attackedThisTurn).toBeFalsy();
    expect(paused.isPlayerTurn).toBe(true);
    expect(paused.opponentActivePokemon?.currentDamage).toBe(0);
    expect(paused.pendingAttackChoice?.reaction?.answers).toBe("flee");

    // The defender gets the step (worded for them), without the paused attack's continuation
    const full = t.masked(opp).pendingAttackChoice;
    expect(full.step.options.map((o: { id: string }) => o.id)).toEqual(["bulba"]);
    expect(full.reaction).toMatchObject({ answers: "flee", pokemonId: "tentacruel" });
    expect(full.reaction.resume).toBeUndefined();
    expect(t.masked(actor).pendingAttackChoice).toMatchObject({ waiting: true });
    expect(t.masked(actor).pendingAttackChoice.step.options).toEqual([]);

    await expectRejected(t, t.act("endTurn"), /Primero hay que resolver la elección del ataque/);
    await expectRejected(t, t.act("resolveAttackChoice", { selection: ["bulba"] }), /No te corresponde elegir/);
    await expectRejected(t, t.act("attack", { attackIndex: 0 }), /Primero hay que resolver/);

    const answered = await t.actAs(opp, "resolveAttackChoice", { selection: ["bulba"] });
    expect(answered.success, answered.error).toBe(true);
    const after = t.mine();
    expect(after.pendingAttackChoice).toBeUndefined();
    expect(after.opponentActivePokemon?.pokemon.id).toBe("bulba");
    expect(after.isPlayerTurn).toBe(false); // the attack happened: the turn passed
  });

  it("Sabrina's ESP: the server re-flips the attack's coins (showCoinFlip); coins from the client are rejected", async () => {
    let next: Coin = "tails";
    const t = setupGame(actor, {
      myActive: inPlay(gh("Sabrina's Haunter", "haunter"), { energy: "PP" }),
      myHand: [gh("Sabrina's ESP", "esp-h")],
    }, () => next);
    expect((await t.act("playTrainer", { cardId: "esp-h", selections: [["haunter"]] })).success).toBe(true);
    // Attached Trainers are public: both players see Sabrina's ESP on the Haunter
    expect(t.masked(actor).playerActivePokemon?.attachedTrainers?.map((c: GameCard) => c.name)).toEqual(["Sabrina's ESP"]);
    expect(t.masked(opp).opponentActivePokemon?.attachedTrainers?.map((c: GameCard) => c.name)).toEqual(["Sabrina's ESP"]);

    const res = await t.act("attack", { attackIndex: 0 });
    expect(res.success, res.error).toBe(true);
    expect(res.attackPaused).toBe(true);
    expect(res.coinFlipInfo).toEqual({ attackName: "Espíritus Nocturnos", results: ["tails"] }); // shown before the question
    expect(t.mine().pendingAttackChoice?.reaction?.answers).toBe("espReflip");
    expect(t.masked(actor).pendingAttackChoice.step.options.map((o: { id: string }) => o.id)).toEqual(["keep", "reflip"]);
    expect(t.masked(actor).pendingAttackChoice.reaction.resume).toBeUndefined();

    await expectRejected(t, t.act("resolveAttackChoice", { selection: ["reflip"], coinResults: ["heads"] }), /Datos inválidos/);
    await expectRejected(t, t.actAs(opp, "resolveAttackChoice", { selection: ["reflip"] }), /No te corresponde elegir/);

    next = "heads";
    const reflip = await t.act("resolveAttackChoice", { selection: ["reflip"] });
    expect(reflip.success, reflip.error).toBe(true);
    expect(reflip.coinFlipInfo).toEqual({ attackName: "Espíritus Nocturnos", results: ["heads"] });
    expect(t.mine().opponentActivePokemon?.currentDamage).toBe(30);
    expect(t.mine().isPlayerTurn).toBe(false);
  });

  it("Charity stays attached for everyone to see", async () => {
    const t = setupGame(actor, { myHand: [gh("Charity", "charity-h")] });
    const res = await t.act("playTrainer", { cardId: "charity-h", selections: [] });
    expect(res.success, res.error).toBe(true);
    expect(t.masked(actor).playerActivePokemon?.attachedTrainers?.map((c: GameCard) => c.id)).toEqual(["charity-h"]);
    expect(t.masked(opp).opponentActivePokemon?.attachedTrainers?.map((c: GameCard) => c.id)).toEqual(["charity-h"]);
    expect(t.masked("spectator")[actor === "p1" ? "playerActivePokemon" : "opponentActivePokemon"]?.attachedTrainers).toHaveLength(1);
  });

  // ── Recall ─────────────────────────────────────────────────────────────────────

  it("Recall: an attack index past the Active's own (the Basic's attack) is accepted; masking keeps the mark and the cards under it", async () => {
    const geodude = gh("Brock's Geodude", "geodude-under");
    const t = setupGame(actor, {
      myActive: inPlay(gh("Brock's Graveler", "graveler"), { energy: "F", under: [geodude] }),
      myHand: [gh("Recall", "recall-h")],
    });
    await expectRejected(t, t.act("attack", { attackIndex: 1 }), /./); // not without Recall
    expect((await t.act("playTrainer", { cardId: "recall-h", selections: [] })).success).toBe(true);
    for (const viewer of [actor, opp] as const) {
      const masked = t.masked(viewer);
      expect(masked.recallActiveOnTurn).toBe(5);
      const graveler = viewer === actor ? masked.playerActivePokemon : masked.opponentActivePokemon;
      expect(graveler?.previousEvolutions?.map((c: GameCard) => c.id)).toEqual(["geodude-under"]);
    }
    const res = await t.act("attack", { attackIndex: 1 }); // Brock's Geodude's Tackle
    expect(res.success, res.error).toBe(true);
    expect(t.mine().opponentActivePokemon!.currentDamage).toBeGreaterThan(0);
    expect(t.mine().isPlayerTurn).toBe(false);
  });

  // ── Trainers ───────────────────────────────────────────────────────────────────

  it("Blaine's Gamble: no coin before the steps; the server flips it when the answers arrive and everyone sees it", async () => {
    const t = setupGame(actor, { myHand: [gh("Blaine's Gamble", "gamble-h"), cardAs("Potion", "potion")] }, ["heads"]);
    expect(t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "trainer", cardId: "gamble-h" })).toMatchObject({ success: false });
    expect(t.coinsLeft()).toBe(1);
    await expectRejected(t, t.act("playTrainer", { cardId: "gamble-h", selections: [["not-in-hand"]] }), /./);
    expect(t.coinsLeft()).toBe(1); // a wrong answer flips nothing

    const res = await t.act("playTrainer", { cardId: "gamble-h", selections: [["potion"]] });
    expect(res.success, res.error).toBe(true);
    expect(t.coinsLeft()).toBe(0);
    expect(res.coinFlipInfo).toEqual({ attackName: "Blaine's Gamble", results: ["heads"] }); // to the whole room
    expect(res.opponentCoinFlipInfo).toBeUndefined();
    expect(t.room.effectCoins ?? {}).toEqual({});
  });

  it("Minion of Team Rocket with a tails: the turn ends exactly once", async () => {
    const t = setupGame(actor, { myHand: [gh("Minion of Team Rocket", "minion-h")] }, ["heads", "tails"]);
    const ack = t.manager.requestCoinFlip(t.room.id, SOCKET[actor], { purpose: "trainer", cardId: "minion-h" });
    expect(ack).toMatchObject({ success: true, results: ["heads", "tails"] });
    const before = t.mine();
    const res = await t.act("playTrainer", { cardId: "minion-h", selections: [] });
    expect(res.success, res.error).toBe(true);
    const after = t.mine();
    expect(after.turnNumber).toBe(before.turnNumber + 1);
    expect(after.isPlayerTurn).toBe(false);
    expect(after.attackedThisTurn).toBeFalsy();
    const ends = after.events.filter((e) => /^Fin del turno de Jugador/.test(e.message));
    expect(ends).toHaveLength(1);
    expect(ends[0].message).toBe(`Fin del turno de ${actor === "p1" ? "Jugador 1" : "Jugador 2"}`);
    // The other player plays on
    expect((await t.actAs(opp, "endTurn")).success).toBe(true);
  });

  // ── The answer clock ───────────────────────────────────────────────────────────

  it("an off-turn answer runs the answerer's clock (turn clock paused); no kick; when it runs out the default answer resumes the attack", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay(gh("Misty's Tentacruel", "tentacruel")),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    expect((await t.act("attack", { attackIndex: 0 })).attackPaused).toBe(true);
    expect(t.room.answerClock?.side).toBe(VIEWER[opp]);
    const clock = t.manager.getClock(t.room);
    expect(clock).toMatchObject({ kind: "answer", userId: USER[opp], pausedUserId: USER[actor], pausedRemainingSeconds: 180, durationSeconds: 180 });
    const sent = maskRoomState(t.manager, t.room, t.room.gameState!, VIEWER[actor]);
    expect(sent.awaitingUserId).toBe(USER[opp]);
    expect(sent.clock).toEqual(clock);

    t.room.turnStartedAt = Date.now() - 200_000;
    expect(t.manager.requestKick(t.room.id, SOCKET[actor])).toMatchObject({ success: false });
    expect(t.manager.requestKick(t.room.id, SOCKET[opp])).toMatchObject({ success: false });

    const auto = await t.manager.autoAnswerTimedOut(t.room.id);
    expect(auto?.success).toBe(true);
    const after = t.mine();
    expect(after.pendingAttackChoice).toBeUndefined();
    expect(after.opponentActivePokemon?.pokemon.id).toBe("tentacruel"); // default: Flee not used
    expect(after.opponentActivePokemon?.currentDamage).toBe(20); // Gnaw 10 x2 (Lightning Weakness)
    expect(t.room.answerClock).toBeUndefined();
    expect(t.manager.getClock(t.room)).toMatchObject({ kind: "turn", userId: USER[opp] }); // the turn passed
    expect(await t.manager.autoAnswerTimedOut(t.room.id)).toBeNull(); // nothing owed any more
  });

  it("the answer clock's timeout answers by itself and reports it (setOnAutoAnswer)", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay(gh("Misty's Tentacruel", "tentacruel")),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    const onAuto = vi.fn();
    t.manager.setOnAutoAnswer(onAuto);
    t.room.turnTimerDuration = 0.05;
    expect((await t.act("attack", { attackIndex: 0 })).attackPaused).toBe(true);
    await vi.waitFor(() => expect(onAuto).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onAuto.mock.calls[0][0]).toBe(t.room.id);
    expect(onAuto.mock.calls[0][1]).toBe(VIEWER[opp]);
    expect(onAuto.mock.calls[0][2]).toMatchObject({ type: "resolveAttackChoice" });
    expect(onAuto.mock.calls[0][3]).toMatchObject({ success: true });
    expect(t.mine().pendingAttackChoice).toBeUndefined();
  });

  it("an answer in time cancels the clock and control returns to the player whose turn it is", async () => {
    const t = setupGame(actor, {
      myHand: [gh("Narrow Gym", "narrow-h")],
      myBench: fiveBenched("mine"),
      theirBench: fiveBenched("theirs"),
    });
    const onAuto = vi.fn();
    t.manager.setOnAutoAnswer(onAuto);
    t.room.turnTimerDuration = 0.1;
    expect((await t.act("playTrainer", { cardId: "narrow-h", selections: [] })).success).toBe(true);
    expect(t.manager.getClock(t.room)).toMatchObject({ kind: "answer", userId: USER[opp] });
    expect((await t.actAs(opp, "benchTrim", { discardIds: ["theirs-0"] })).success).toBe(true);
    // The player's own trim is on their own clock
    expect(t.room.answerClock).toBeUndefined();
    expect(t.manager.getClock(t.room)).toMatchObject({ kind: "turn", userId: USER[actor] });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onAuto).not.toHaveBeenCalled();
  });

  it("closing the room (admin close / kick / forfeit paths) leaves no answer timer behind", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay(gh("Misty's Tentacruel", "tentacruel")),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    const onAuto = vi.fn();
    t.manager.setOnAutoAnswer(onAuto);
    t.room.turnTimerDuration = 0.1;
    expect((await t.act("attack", { attackIndex: 0 })).attackPaused).toBe(true);
    const timers = (t.manager as unknown as { answerTimers: Map<string, unknown> }).answerTimers;
    expect(timers.has(t.room.id)).toBe(true);
    expect(t.manager.forceDeleteRoom(t.room.id)).toBe(true);
    expect(timers.has(t.room.id)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onAuto).not.toHaveBeenCalled();
  });

  it("a surrender while an answer is pending cancels the answer timer", async () => {
    const t = setupGame(actor, {
      theirActive: inPlay(gh("Misty's Tentacruel", "tentacruel")),
      theirBench: [inPlay(cardAs("Bulbasaur", "bulba"))],
    });
    t.room.turnTimerDuration = 60;
    expect((await t.act("attack", { attackIndex: 0 })).attackPaused).toBe(true);
    const timers = (t.manager as unknown as { answerTimers: Map<string, unknown> }).answerTimers;
    expect(timers.has(t.room.id)).toBe(true);
    expect((await t.act("surrender")).gameOver).toBe(true);
    expect(timers.has(t.room.id)).toBe(false);
  });

  it("an off-turn Bench trim that times out is answered with the engine's pick", async () => {
    const t = setupGame(actor, {
      myHand: [gh("Narrow Gym", "narrow-h")],
      theirBench: fiveBenched("theirs"),
    });
    expect((await t.act("playTrainer", { cardId: "narrow-h", selections: [] })).success).toBe(true);
    expect((await t.manager.autoAnswerTimedOut(t.room.id))?.success).toBe(true);
    expect(t.mine().opponentBench).toHaveLength(4);
    expect(t.mine().pendingBenchTrim ?? []).toEqual([]);
    expect(t.mine().isPlayerTurn).toBe(true);
  });
});

describe("Gym Heroes masking and coins (unit)", () => {
  it("Tickling Machine: set-aside hands are face down for both players and spectators, counts kept", () => {
    const secret = [cardAs("Pikachu", "Pikachu-0-17000-0.1"), cardAs("Potion", "Potion-1-17000-0.2")];
    const state = {
      isPlayerTurn: true,
      playerHand: [],
      opponentHand: [],
      playerBench: [],
      opponentBench: [],
      activeModifiers: [],
      events: [],
      setAsideHands: [{ side: "opponent", cards: secret, returnsAfterTurn: 6 }],
    } as unknown as Record<string, unknown>;
    for (const viewer of ["player1", "player2", "spectator"] as const) {
      const masked = maskGameStateForPlayer(state, viewer) as { setAsideHands: { cards: { id: string; hidden?: boolean; name?: string }[]; returnsAfterTurn: number }[] };
      expect(masked.setAsideHands).toHaveLength(1);
      expect(masked.setAsideHands[0].returnsAfterTurn).toBe(6);
      expect(masked.setAsideHands[0].cards).toHaveLength(2);
      for (const card of masked.setAsideHands[0].cards) {
        expect(card.hidden).toBe(true);
        expect(card.name).toBeUndefined();
        expect(card.id).not.toMatch(/Pikachu|Potion/); // instance ids carry the card name
      }
    }
    // The stored state keeps the cards
    expect((state.setAsideHands as { cards: unknown[] }[])[0].cards).toBe(secret);
  });

  it("attack coins: flippedBy for the attack's own coins only, defenderFlippedBy for an attacker-flipped defender coin", () => {
    expect(
      attackCoinInfo("Derribar", { smokescreen: 1, attack: 2, stadium: 1, defender: 1, attackFlipper: "opponent", defenderFlipper: "attacker" }, ["heads", "tails", "heads", "tails", "heads"]),
    ).toEqual({
      attackName: "Derribar",
      results: ["heads", "tails", "heads", "tails"],
      flippedBy: ["attacker", "defender", "defender", "attacker"],
      defenderResults: ["heads"],
      defenderFlippedBy: ["attacker"],
    });
    expect(attackCoinInfo("Roer", { smokescreen: 0, attack: 0, defender: 1 }, ["tails"])).toEqual({ attackName: "Roer", results: [], defenderResults: ["tails"] });
  });

  it("default answers: the step's own default, else its fewest first options (Erika: \"0\"), else every option", () => {
    const options = ["0", "1", "2", "3"].map((id) => ({ id, label: id }));
    expect(defaultSelection({ title: "Erika", description: "", options, maxSelections: 1 })).toEqual(["0"]);
    expect(defaultSelection({ title: "Huida", description: "", options, maxSelections: 1, minSelections: 0 })).toEqual([]);
    expect(defaultSelection({ title: "Challenge!", description: "", options, maxSelections: 1, defaultSelection: ["2"] } as never)).toEqual(["2"]);
    // A disabled first option is skipped (it would make both fallbacks invalid)
    const firstDisabled = [{ id: "0", label: "0", disabled: true }, ...options.slice(1)];
    expect(defaultSelection({ title: "Erika", description: "", options: firstDisabled, maxSelections: 1 })).toEqual(["1"]);
  });
});
