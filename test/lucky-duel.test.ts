/**
 * Lucky Duel tables (spec: pokemon-tcg-game-core docs/superpowers/specs/2026-10-18-lucky-duel-design.md).
 *
 * - createRoom { mode: "lucky-duel" }: no deck needed (one sent is ignored), no Prizes; bets work
 *   like at any table (a draw refunds both stakes); every lobby object carries `mode`.
 * - The start deals game-core's initializeLuckyDuelGame (random Basic + deck per seat, server RNG):
 *   both Actives placed, 7-card hands, 0 Prizes, MULLIGAN until both are ready.
 * - Until both players are ready both Actives go out as `{ id, hidden: true }` to EVERY viewer
 *   (owners, rival, spectators, rejoins) and only playerReady / surrender are accepted; the
 *   both-ready transition reveals them.
 * - A draw (both Actives Knocked Out at once): gameOver { winner: null, reason: "Empate" }; the
 *   match settles as a draw (no stats or streak change, the loser's XP for both).
 * - Standard tables are unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { ALL_CARDS, type GameState } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { GameRoomManager, LUCKY_DUEL_FACE_DOWN_ERROR } from "../src/socket/rooms.js";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";
import * as matches from "../src/modules/matches/matches.service.js";
import { XP_REWARDS } from "../src/modules/users/xp.service.js";
import { matchesRouter } from "../src/modules/matches/index.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { settleRoomResult } from "../src/socket/match-settlement.js";
import { createUser, getBalances } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  server = await startSocketServer();
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

/** Deterministic rng for the room manager's Lucky Duel draws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Any = Record<string, any>;
const act = (type: string, payload: Any = {}) => ({ type, payload });
const WIN_MISSION_COINS = ECONOMY.missions.daily.find((m) => m.id === "win_game")!.rewardCoins;

/** The masked state without the viewer's own hand (visible to its owner by design). */
const withoutOwnHand = (state: Any) => {
  const { playerHand: _hand, ...rest } = state;
  return JSON.stringify(rest);
};

/** Neither Active of `raw` can be read from `masked` (its own hand aside). */
function expectFaceDown(masked: Any, raw: GameState) {
  const p1 = raw.playerActivePokemon!;
  const p2 = raw.opponentActivePokemon!;
  const ids = [p1.pokemon.id, p2.pokemon.id].sort();
  expect(masked.playerActivePokemon).toEqual({ id: expect.any(String), hidden: true });
  expect(masked.opponentActivePokemon).toEqual({ id: expect.any(String), hidden: true });
  expect([masked.playerActivePokemon.id, masked.opponentActivePokemon.id].sort()).toEqual(ids);
  const json = withoutOwnHand(masked);
  for (const active of [p1, p2]) {
    expect(json).not.toContain(`"${active.pokemon.name}"`);
    expect(json).not.toContain(active.pokemon.name);
  }
  // The owner's own deck is hidden too before the reveal (its evolutions name the Basic)
  expect((masked.playerDeck as Any[]).every((c) => c.hidden === true && !("name" in c))).toBe(true);
}

// ---------------------------------------------------------------------------
// Room manager (no sockets)
// ---------------------------------------------------------------------------

describe("GameRoomManager: a Lucky Duel table", () => {
  async function seatedRoom(seed = 7) {
    const manager = new GameRoomManager(undefined, { random: mulberry32(seed) });
    const room = manager.createRoom(undefined, { mode: "lucky-duel", prizeCount: 6, betAmount: 50 });
    await manager.joinRoom(room.id, "user-1", "sock-1");
    await manager.joinRoom(room.id, "user-2", "sock-2");
    return { manager, room };
  }

  it("never carries Prizes, whatever the caller asked; the bet is kept", async () => {
    const { room } = await seatedRoom();
    expect(room.config).toMatchObject({ mode: "lucky-duel", prizeCount: 0, betAmount: 50 });
    expect(new GameRoomManager().createRoom().config.mode).toBe("standard");
  });

  it("starts with both Actives placed, 7-card hands, 0 Prizes, 52-card decks, face down", async () => {
    const { manager, room } = await seatedRoom();
    const state = await manager.startLuckyDuelGame(room.id);
    expect(room.status).toBe("playing");
    expect(state).toMatchObject({ gameMode: "lucky-duel", luckyDuelRevealed: false, gamePhase: "MULLIGAN" });
    expect(state.playerPrizes).toHaveLength(0);
    expect(state.opponentPrizes).toHaveLength(0);
    expect(state.playerHand).toHaveLength(7);
    expect(state.opponentHand).toHaveLength(7);
    expect(state.playerDeck).toHaveLength(52);
    expect(state.opponentDeck).toHaveLength(52);
    expect(state.playerActivePokemon?.pokemon.stage).toBe("basic");
    expect(state.opponentActivePokemon?.pokemon.stage).toBe("basic");
    expect(state.playerBench).toHaveLength(0);
    // Opaque ids: nothing about the card
    expect(state.playerActivePokemon!.pokemon.id).toMatch(/^ld1-/);
    expect(state.opponentActivePokemon!.pokemon.id).toMatch(/^ld2-/);
    // No event names an Active before the reveal
    const log = JSON.stringify(state.events);
    expect(log).not.toContain(state.playerActivePokemon!.pokemon.name);
    expect(log).not.toContain(state.opponentActivePokemon!.pokemon.name);
  });

  it("masks both Actives (and the own deck) for player 1, player 2 and spectators until the reveal", async () => {
    const { manager, room } = await seatedRoom(11);
    const state = await manager.startLuckyDuelGame(room.id);
    for (const viewer of ["player1", "player2", "spectator"] as const) {
      expectFaceDown(maskGameStateForPlayer(state as unknown as Any, viewer) as Any, state);
    }
  });

  it("only accepts getting ready (or surrendering) before the reveal; both ready reveals the Actives", async () => {
    const { manager, room } = await seatedRoom(3);
    const state = await manager.startLuckyDuelGame(room.id);
    const active1 = state.playerActivePokemon!;
    const card = state.playerHand[0];
    for (const action of [
      act("attack", { attackIndex: 0 }),
      act("attachEnergy", { cardId: card.id, pokemonId: active1.pokemon.id }),
      act("usePower", { pokemonId: active1.pokemon.id, selections: [] }),
      act("mulligan"),
      act("endTurn"),
    ]) {
      expect(await manager.executeAction(room.id, "sock-1", action)).toEqual({ success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR });
      expect(await manager.executeAction(room.id, "sock-2", action)).toEqual({ success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR });
    }
    expect(manager.requestCoinFlip(room.id, "sock-2", { roomId: room.id, purpose: "power", pokemonId: active1.pokemon.id } as never))
      .toEqual({ success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR });

    const first = await manager.executeAction(room.id, "sock-2", act("playerReady"));
    expect(first.success).toBe(true);
    expect(first.gameState!.luckyDuelRevealed).toBe(false);
    expectFaceDown(maskGameStateForPlayer(first.gameState as unknown as Any, "player1") as Any, state);

    const second = await manager.executeAction(room.id, "sock-1", act("playerReady"));
    expect(second.success).toBe(true);
    const revealed = second.gameState!;
    expect(revealed).toMatchObject({ luckyDuelRevealed: true, gamePhase: "PLAYING" });
    const p1View = maskGameStateForPlayer(revealed as unknown as Any, "player1") as Any;
    const p2View = maskGameStateForPlayer(revealed as unknown as Any, "player2") as Any;
    const spectatorView = maskGameStateForPlayer(revealed as unknown as Any, "spectator") as Any;
    expect(p1View.playerActivePokemon.pokemon.name).toBe(active1.pokemon.name);
    expect(p2View.opponentActivePokemon.pokemon.name).toBe(active1.pokemon.name);
    expect(spectatorView.opponentActivePokemon.pokemon.name).toBe(state.opponentActivePokemon!.pokemon.name);
    // Normal masking again: own deck visible, rival's hidden
    expect(p1View.playerDeck.some((c: Any) => typeof c.name === "string")).toBe(true);
    expect(p1View.opponentDeck.every((c: Any) => c.hidden === true)).toBe(true);
    expect(revealed.events.some((e) => e.message.includes("Lucky Duel: ¡"))).toBe(true);
  });

  it("a surrender before the reveal still has a winner", async () => {
    const { manager, room } = await seatedRoom();
    await manager.startLuckyDuelGame(room.id);
    const result = await manager.executeAction(room.id, "sock-2", act("surrender"));
    expect(result).toMatchObject({ success: true, gameOver: true, winner: "player1" });
    expect(result.draw).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sockets (production handlers)
// ---------------------------------------------------------------------------

const HITMONCHAN = "base-set-007-hitmonchan";
const FIGHTING = "base-set-097-fighting-energy";

async function playableDeck(userId: string) {
  await prisma.userCard.createMany({
    data: [
      { userId, cardDefId: HITMONCHAN, quantity: 4 },
      { userId, cardDefId: FIGHTING, quantity: 56 },
    ],
  });
  return prisma.deck.create({
    data: {
      userId,
      name: "Hitmonchan",
      isValid: true,
      cards: [
        { cardDefId: HITMONCHAN, quantity: 4 },
        { cardDefId: FIGHTING, quantity: 56 },
      ],
    },
  });
}

type RoomListing = { id: string; mode: string; prizeCount: number; betAmount: number; creatorUsername?: string | null };

type User = Awaited<ReturnType<typeof createUser>>;

async function luckyTable(options: { bet?: number; players?: [User, User] } = {}) {
  const [p1, p2] = options.players ?? (await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]));
  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  const listed = nextEvent<{ rooms: RoomListing[] }>(s2, "roomList");
  s1.emit("createRoom", { mode: "lucky-duel", ...(options.bet ? { betAmount: options.bet } : {}) });
  const created = await nextEvent<{ roomId: string; mode: string }>(s1, "roomCreated");
  const list = await listed;
  const started = Promise.all([nextEvent<Any>(s1, "gameStart"), nextEvent<Any>(s2, "gameStart")]);
  s2.emit("joinRoom", { roomId: created.roomId });
  const [g1, g2] = await started;
  return { roomId: created.roomId, created, list, p1, p2, s1, s2, g1, g2 };
}

const ready = (socket: ClientSocket, roomId: string) => socket.emit("action", { roomId, action: act("playerReady") });

/** Both players press Listo: the Actives are revealed and the game is PLAYING. */
async function revealBoth(t: Awaited<ReturnType<typeof luckyTable>>) {
  const firstReady = nextEvent<Any>(t.s1, "gameState");
  ready(t.s1, t.roomId);
  await firstReady;
  const revealed = Promise.all([nextEvent<Any>(t.s1, "gameState"), nextEvent<Any>(t.s2, "gameState")]);
  ready(t.s2, t.roomId);
  for (const update of await revealed) expect(update.gameState.luckyDuelRevealed).toBe(true);
}

/**
 * Both Actives Poisoned one hit from a Knock Out (game-core: the checkup Knocks Out both), the
 * game at `turn`, its match started 10 minutes ago. Returns the socket whose turn it is.
 */
async function armDraw(t: Awaited<ReturnType<typeof luckyTable>>, turn = 6) {
  const room = roomManager.getRoom(t.roomId)!;
  const state = room.gameState!;
  const poisoned = (active: NonNullable<GameState["playerActivePokemon"]>, cardId: string) => {
    const card = ALL_CARDS.find((c) => c.id === cardId)!;
    return { ...active, pokemon: { ...card, id: active.pokemon.id } as typeof active.pokemon, currentDamage: 20, statusConditions: ["poisoned"] as typeof active.statusConditions, attachedEnergy: [] };
  };
  room.gameState = {
    ...state,
    turnNumber: turn,
    playerActivePokemon: poisoned(state.playerActivePokemon!, "base-set-043-abra"),
    opponentActivePokemon: poisoned(state.opponentActivePokemon!, "base-set-050-gastly"),
  };
  await prisma.match.update({ where: { id: room.matchId! }, data: { startedAt: new Date(Date.now() - 10 * 60_000) } });
  return room.gameState.isPlayerTurn ? t.s1 : t.s2;
}

describe("Lucky Duel over sockets", () => {
  it("createRoom: no deck is needed and the lobby lists the mode", async () => {
    const user = await createUser({ coins: 5000 }, { stats: true });
    const s = await server.connect(tokenFor(user));
    const unknownMode = nextEvent<{ message: string }>(s, "error");
    s.emit("createRoom", { mode: "chaos" });
    expect((await unknownMode).message).toMatch(/Datos inválidos/);

    const t = await luckyTable();
    expect(t.created.mode).toBe("lucky-duel");
    expect(t.list.rooms.find((r) => r.id === t.roomId)).toMatchObject({ mode: "lucky-duel", prizeCount: 0, betAmount: 0 });
    const room = roomManager.getRoom(t.roomId)!;
    expect(room.player1DeckId).toBeNull();
    expect(room.player2DeckId).toBeNull();
    // getRooms (the playing table) carries it too
    const rooms = nextEvent<{ rooms: RoomListing[] }>(t.s1, "roomList");
    t.s1.emit("getRooms");
    const playing = (await rooms).rooms.find((r) => r.id === t.roomId);
    expect(playing?.mode).toBe("lucky-duel");
    // Once it is being played the seats are public again (spectators see who plays)
    expect(playing?.creatorUsername).toBeTruthy();
  });

  it("a deck sent anyway is ignored (no ownership check, no deck stored)", async () => {
    const user = await createUser({}, { stats: true });
    const s = await server.connect(tokenFor(user));
    s.emit("createRoom", { mode: "lucky-duel", deckId: "00000000-0000-4000-8000-000000000000" });
    const { roomId } = await nextEvent<{ roomId: string }>(s, "roomCreated");
    expect(roomManager.getRoom(roomId)!.player1DeckId).toBeNull();
    s.emit("deleteRoom", { roomId });
    await nextEvent(s, "roomDeleted");
  });

  it("gameStart, rejoin and spectators never get the face-down Actives; both ready reveals them", async () => {
    const t = await luckyTable();
    const raw = roomManager.getRoom(t.roomId)!.gameState!;
    expect(t.g1.mode).toBe("lucky-duel");
    expect(t.g1.gameState).toMatchObject({ gameMode: "lucky-duel", luckyDuelRevealed: false });
    expectFaceDown(t.g1.gameState, raw);
    expectFaceDown(t.g2.gameState, raw);
    expect(t.g1.playerVariantMap ?? {}).toEqual({});

    // Spectator
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    const watching = nextEvent<Any>(sv, "gameStart");
    sv.emit("spectateRoom", { roomId: t.roomId });
    const spectated = await watching;
    expect(spectated.mode).toBe("lucky-duel");
    expectFaceDown(spectated.gameState, raw);

    // Rejoin from another socket (reload)
    const again = await server.connect(tokenFor(t.p1));
    const rejoined = nextEvent<Any>(again, "gameStart");
    again.emit("joinRoom", { roomId: t.roomId });
    const rejoin = await rejoined;
    expect(rejoin.mode).toBe("lucky-duel");
    expectFaceDown(rejoin.gameState, raw);
    const p1 = again;

    // Acting before the reveal is refused (no engine reason that could name a card)
    const refused = nextEvent<Any>(t.s2, "actionResult");
    t.s2.emit("action", { roomId: t.roomId, action: act("attack", { attackIndex: 0 }) });
    expect(await refused).toEqual({ success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR });
    const coin = await new Promise<Any>((resolve) =>
      t.s2.emit("requestCoinFlip", { roomId: t.roomId, purpose: "power", pokemonId: raw.opponentActivePokemon!.pokemon.id }, resolve));
    expect(coin).toEqual({ success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR });

    // One ready: still face down for everyone
    const afterFirst = Promise.all([nextEvent<Any>(p1, "gameState"), nextEvent<Any>(t.s2, "gameState"), nextEvent<Any>(sv, "gameState")]);
    ready(t.s2, t.roomId);
    for (const update of await afterFirst) expectFaceDown(update.gameState, raw);

    // Both ready: revealed for everyone
    const afterBoth = Promise.all([nextEvent<Any>(p1, "gameState"), nextEvent<Any>(t.s2, "gameState"), nextEvent<Any>(sv, "gameState")]);
    ready(p1, t.roomId);
    const [s1State, s2State, svState] = (await afterBoth).map((u) => u.gameState);
    const name1 = raw.playerActivePokemon!.pokemon.name;
    const name2 = raw.opponentActivePokemon!.pokemon.name;
    expect(s1State).toMatchObject({ luckyDuelRevealed: true, gamePhase: "PLAYING" });
    expect(s1State.playerActivePokemon.pokemon.name).toBe(name1);
    expect(s1State.opponentActivePokemon.pokemon.name).toBe(name2);
    expect(s2State.playerActivePokemon.pokemon.name).toBe(name2);
    expect(s2State.opponentActivePokemon.pokemon.name).toBe(name1);
    expect(svState.playerActivePokemon.pokemon.name).toBe(name1);
    expect(s1State.playerActivePokemon.pokemon.id).toBe(t.g1.gameState.playerActivePokemon.id);
  });

  it("both Actives Knocked Out at once: gameOver without a winner, settled as a draw", async () => {
    const t = await luckyTable();
    // Streaks to check they neither break nor grow
    await prisma.userStats.update({ where: { userId: t.p1.id }, data: { currentStreak: 2, bestStreak: 4, normalWins: 3 } });
    await prisma.userStats.update({ where: { userId: t.p2.id }, data: { currentStreak: 1, bestStreak: 1, normalLosses: 2 } });

    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    const turnSocket = await armDraw(t);
    const over = Promise.all([nextEvent<Any>(t.s1, "gameOver"), nextEvent<Any>(t.s2, "gameOver")]);
    const settled = Promise.all([nextEvent<Any>(t.s1, "matchSettled", 8000), nextEvent<Any>(t.s2, "matchSettled", 8000)]);
    turnSocket.emit("action", { roomId: t.roomId, action: act("endTurn") });
    for (const payload of await over) expect(payload).toEqual({ winner: null, reason: "Empate" });
    expect(room.gameState!.gameResult).toBe("draw");
    expect(room.status).toBe("finished");

    for (const s of await settled) {
      expect(s).toMatchObject({ roomId: t.roomId, outcome: "draw", counted: true, betAmount: 0, coinsDelta: 0, xpGained: XP_REWARDS.normal.loss });
    }
    const match = await prisma.match.findUniqueOrThrow({ where: { id: room.matchId! } });
    expect(match).toMatchObject({ status: "finished", winnerId: null, winReason: "Lucky Duel: Empate", counted: true, mode: "normal" });
    expect(match.player1Xp).toBe(XP_REWARDS.normal.loss);
    expect(match.player2Xp).toBe(XP_REWARDS.normal.loss);
    expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: t.p1.id } })).toMatchObject({ currentStreak: 2, bestStreak: 4, normalWins: 3, normalLosses: 0 });
    expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: t.p2.id } })).toMatchObject({ currentStreak: 1, bestStreak: 1, normalWins: 0, normalLosses: 2 });
  });

  it("a standard table is unchanged: deck required, mode standard, Actives not hidden", async () => {
    const [p1, p2] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
    const [deck1, deck2] = await Promise.all([playableDeck(p1.id), playableDeck(p2.id)]);
    const s1 = await server.connect(tokenFor(p1));
    const s2 = await server.connect(tokenFor(p2));
    const noDeck = nextEvent<{ message: string }>(s1, "error");
    s1.emit("createRoom", { prizeCount: 6 });
    expect((await noDeck).message).toBe("Debes elegir un mazo");

    const listed = nextEvent<{ rooms: RoomListing[] }>(s2, "roomList");
    s1.emit("createRoom", { deckId: deck1.id, prizeCount: 4 });
    const created = await nextEvent<{ roomId: string; mode: string }>(s1, "roomCreated");
    expect(created.mode).toBe("standard");
    // A waiting table is anonymous: who created it is not sent
    expect((await listed).rooms.find((r) => r.id === created.roomId)).toMatchObject({
      mode: "standard",
      prizeCount: 4,
      creatorUsername: null,
      creatorAvatarId: null,
      creatorTitleId: null,
    });
    const joinNoDeck = nextEvent<{ message: string }>(s2, "error");
    s2.emit("joinRoom", { roomId: created.roomId });
    expect((await joinNoDeck).message).toBe("Debes elegir un mazo");

    const started = Promise.all([nextEvent<Any>(s1, "gameStart"), nextEvent<Any>(s2, "gameStart")]);
    s2.emit("joinRoom", { roomId: created.roomId, deckId: deck2.id });
    const [g1] = await started;
    expect(g1.mode).toBe("standard");
    expect(g1.gameState.gameMode).toBeUndefined();
    expect(g1.gameState.playerPrizes).toHaveLength(4);
    expect(g1.gameState.playerActivePokemon).toBeNull();
    expect(g1.gameState.playerDeck.some((c: Any) => typeof c.name === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Settlement of a draw
// ---------------------------------------------------------------------------

describe("settleMatch: a draw", () => {
  async function played(ageMs = 5 * 60_000) {
    const [a, b] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
    const match = await matches.openMultiplayerMatch({ roomId: "LD", player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0 });
    await prisma.match.update({ where: { id: match.id }, data: { startedAt: new Date(Date.now() - ageMs) } });
    return { a, b, match };
  }

  it("counts for both with the loser's rewards and no stats change", async () => {
    const { a, b, match } = await played();
    const result = await matches.settleMatch(match.id, { kind: "multiplayer", winnerId: null, draw: true, reason: "Empate", turnNumber: 8 });
    expect(result).toMatchObject({ winnerId: null, counted: true });
    for (const p of result!.players) expect(p).toMatchObject({ outcome: "draw", counted: true, xpGained: XP_REWARDS.normal.loss });
    for (const id of [a.id, b.id]) {
      expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({ normalWins: 0, normalLosses: 0, currentStreak: 0 });
    }
    expect(await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).toMatchObject({ status: "finished", winnerId: null });
  });

  it("a draw before turn 3 counts for nobody; without `draw` a null winner stays 'no result'", async () => {
    const early = await played();
    const r1 = await matches.settleMatch(early.match.id, { kind: "multiplayer", winnerId: null, draw: true, reason: "Empate", turnNumber: 2 });
    for (const p of r1!.players) expect(p).toMatchObject({ outcome: "draw", counted: false, xpGained: 0 });

    const none = await played();
    const r2 = await matches.settleMatch(none.match.id, { kind: "multiplayer", winnerId: null, reason: "x", turnNumber: 8 });
    for (const p of r2!.players) expect(p).toMatchObject({ outcome: "none", counted: false });
    expect(await prisma.match.findUniqueOrThrow({ where: { id: none.match.id } })).toMatchObject({ status: "abandoned" });
  });
});

// ---------------------------------------------------------------------------
// vs the AI (client-reported: POST /api/matches/ai, then /finish)
// ---------------------------------------------------------------------------

describe("POST /api/matches/ai/:matchId/finish: a Lucky Duel vs the AI", () => {
  const LONG = (3 * 60_000) + 1000;

  it("accepts result draw (the loser's rewards) and records the mode", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    await prisma.userStats.update({ where: { userId: u.id }, data: { currentStreak: 3, bestStreak: 3 } });
    const token = tokenFor(u);
    const app = await startHttpApp((a) => a.use("/api", matchesRouter));
    try {
      // The mode is the one the game started with (lucky-duel-coins.test.ts: the stake)
      const { matchId } = (await app.request("POST", "/api/matches/ai", { token, body: { mode: "lucky-duel" } })).body;
      await prisma.match.update({ where: { id: matchId }, data: { startedAt: new Date(Date.now() - LONG) } });
      expect((await app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "draw", turnNumber: 6, mode: "chaos" } })).status).toBe(422);
      const done = await app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "draw", turnNumber: 6, mode: "lucky-duel" } });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ outcome: "draw", counted: true, xpGained: XP_REWARDS.ai.loss, rewardCoins: ECONOMY.matchCoins.ai.loss, mode: "lucky-duel" });
      expect(await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).toMatchObject({ status: "finished", winnerId: null, winReason: "lucky-duel: draw" });
      expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: u.id } })).toMatchObject({ currentStreak: 3, bestStreak: 3 });

      // Old clients (no mode) keep working
      const second = (await app.request("POST", "/api/matches/ai", { token })).body.matchId;
      await prisma.match.update({ where: { id: second }, data: { startedAt: new Date(Date.now() - LONG) } });
      const won = await app.request("POST", `/api/matches/ai/${second}/finish`, { token, body: { result: "victory", turnNumber: 6 } });
      expect(won.body).toMatchObject({ outcome: "win", xpGained: XP_REWARDS.ai.win });
      expect(await prisma.match.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ winnerId: u.id, winReason: "victory" });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Table bets at Lucky Duel tables (owner rulings: a draw refunds both stakes; 2026-10-21: Lucky
// Duel tables take bets of 0–100 coins while standard tables stay without bets)
// ---------------------------------------------------------------------------

describe("Lucky Duel tables with a bet (standard table bets off)", () => {
  beforeEach(() => {
    expect(ECONOMY.tableBets.enabled).toBe(false);
    expect(ECONOMY.tableBets.luckyDuel).toEqual({ enabled: true, maxBet: 100 });
  });

  /** A player allowed to bet: verified email and 20 online games (title "joven", max bet 50 at standard tables). */
  async function veteran(coinsAmount = 100) {
    const user = await createUser({ coins: coinsAmount });
    await prisma.userStats.create({ data: { userId: user.id, normalWins: 10, normalLosses: 10 } });
    return user;
  }
  async function betTable(bet = 20, start = 100) {
    const t = await luckyTable({ bet, players: [await veteran(start), await veteran(start)] });
    expect(roomManager.getRoom(t.roomId)!.config).toMatchObject({ mode: "lucky-duel", betAmount: bet });
    expect(t.list.rooms.find((r) => r.id === t.roomId)).toMatchObject({ mode: "lucky-duel", betAmount: bet });
    // Both stakes are taken when the game starts
    expect((await getBalances(t.p1.id)).coins).toBe(start - bet);
    expect((await getBalances(t.p2.id)).coins).toBe(start - bet);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: roomManager.getRoom(t.roomId)!.matchId! } })).betAmount).toBe(bet);
    return t;
  }
  /** `user` opens a Lucky Duel table with `bet`: its roomId, or the error message. */
  async function tryCreate(user: User, bet: number): Promise<{ roomId?: string; error?: string; socket: ClientSocket }> {
    const socket = await server.connect(tokenFor(user));
    const created = nextEvent<{ roomId: string }>(socket, "roomCreated").then((r) => ({ roomId: r.roomId }));
    const failed = nextEvent<{ message: string }>(socket, "error").then((e) => ({ error: e.message }));
    socket.emit("createRoom", { mode: "lucky-duel", betAmount: bet });
    return { ...(await Promise.race([created, failed])), socket };
  }
  const coins = async (userId: string) => (await getBalances(userId)).coins;
  const betRows = async (userId: string) =>
    (await prisma.transaction.findMany({ where: { userId, type: { in: ["bet_stake", "bet_win", "bet_refund"] } }, orderBy: { createdAt: "asc" } }))
      .map((r) => [r.type, r.amount]);
  async function eventually(check: () => Promise<void>, ms = 4000) {
    const until = Date.now() + ms;
    for (;;) {
      try {
        return await check();
      } catch (err) {
        if (Date.now() > until) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  it("a draw refunds each player's own stake once (balances back to before the game)", async () => {
    const t = await betTable(20);
    await revealBoth(t);
    // Before turn 3: the draw counts for nobody, so nothing but the refund moves coins
    const turnSocket = await armDraw(t, 2);
    const settled = Promise.all([nextEvent<Any>(t.s1, "matchSettled", 8000), nextEvent<Any>(t.s2, "matchSettled", 8000)]);
    const over = nextEvent<Any>(t.s1, "gameOver");
    turnSocket.emit("action", { roomId: t.roomId, action: act("endTurn") });
    expect(await over).toEqual({ winner: null, reason: "Empate" });
    for (const s of await settled) expect(s).toMatchObject({ outcome: "draw", betAmount: 20, coinsDelta: 0, counted: false, coins: 100 });
    expect(await coins(t.p1.id)).toBe(100);
    expect(await coins(t.p2.id)).toBe(100);

    // Settling again (another end path, a retry) refunds nothing more
    const room = roomManager.getRoom(t.roomId)!;
    settleRoomResult(null, room, "draw", "Empate");
    expect(await matches.settleMatch(room.matchId!, { kind: "multiplayer", winnerId: null, draw: true, reason: "Empate", turnNumber: 2 })).toBeNull();
    for (const p of [t.p1, t.p2]) {
      expect(await coins(p.id)).toBe(100);
      expect(await betRows(p.id)).toEqual([["bet_stake", -20], ["bet_refund", 20]]);
    }
    expect(await prisma.match.findUniqueOrThrow({ where: { id: room.matchId! } })).toMatchObject({ status: "finished", winnerId: null, betAmount: 20 });
  });

  it("a counted draw also refunds both stakes (no pot, no house cut)", async () => {
    const t = await betTable(20);
    await revealBoth(t);
    const turnSocket = await armDraw(t, 6);
    const settled = Promise.all([nextEvent<Any>(t.s1, "matchSettled", 8000), nextEvent<Any>(t.s2, "matchSettled", 8000)]);
    turnSocket.emit("action", { roomId: t.roomId, action: act("endTurn") });
    for (const s of await settled) expect(s).toMatchObject({ outcome: "draw", counted: true, coinsDelta: 0, betAmount: 20 });
    for (const p of [t.p1, t.p2]) expect(await betRows(p.id)).toEqual([["bet_stake", -20], ["bet_refund", 20]]);
  });

  it("a win takes the pot as at a normal table", async () => {
    const t = await betTable(20);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    room.gameState!.turnNumber = 4;
    await prisma.match.update({ where: { id: room.matchId! }, data: { startedAt: new Date(Date.now() - 5 * 60_000) } });
    const settled = nextEvent<Any>(t.s2, "matchSettled", 8000);
    const over = nextEvent<Any>(t.s1, "gameOver");
    t.s1.emit("action", { roomId: t.roomId, action: act("surrender") });
    expect((await over).winner).toBe("player2");
    const winnerTotal = 120 + ECONOMY.matchCoins.online.win + 50; // pot + match coins + "win 1 game" mission
    expect(await settled).toMatchObject({ outcome: "win", coinsDelta: 20, coins: winnerTotal, betAmount: 20 });
    await eventually(async () => expect(await coins(t.p1.id)).toBe(80 + ECONOMY.matchCoins.online.loss));
  });

  it("leaving the game forfeits it: the other player takes the pot", async () => {
    const t = await betTable(20);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    room.gameState!.turnNumber = 3;
    await prisma.match.update({ where: { id: room.matchId! }, data: { startedAt: new Date(Date.now() - 5 * 60_000) } });
    const over = nextEvent<Any>(t.s2, "gameOver");
    t.s1.emit("leaveRoom", { roomId: t.roomId });
    expect((await over).winner).toBe("player2");
    await eventually(async () => expect(await coins(t.p2.id)).toBe(120 + ECONOMY.matchCoins.online.win + 50));
    expect(await coins(t.p1.id)).toBe(80 + ECONOMY.matchCoins.online.loss);
  });

  it("createRoom takes bets of 0, 50 and 100 coins whatever the title, and refuses 101", async () => {
    for (const bet of [0, 50, 100]) {
      // A veteran's title ("joven") caps standard tables at 50: Lucky Duel's cap is 100 for everyone
      const r = await tryCreate(await veteran(1000), bet);
      expect(r.error).toBeUndefined();
      expect(roomManager.getRoom(r.roomId!)!.config).toMatchObject({ mode: "lucky-duel", betAmount: bet });
      roomManager.forceDeleteRoom(r.roomId!);
    }
    const rich = await veteran(1000);
    const over = await tryCreate(rich, 101);
    expect(over.error).toBe("Las mesas Lucky Duel permiten apostar hasta 100 monedas");
    expect(roomManager.findWaitingRoomsByUser(rich.id)).toEqual([]);
  });

  it("a standard table's bet is still forced to 0", async () => {
    const user = await veteran(1000);
    const s = await server.connect(tokenFor(user));
    s.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 50, friendly: false });
    const { roomId } = await nextEvent<{ roomId: string }>(s, "roomCreated");
    expect(roomManager.getRoom(roomId)!.config).toMatchObject({ mode: "standard", betAmount: 0 });
    roomManager.forceDeleteRoom(roomId);
  });

  it("a friendly Lucky Duel table carries no bet", async () => {
    const s = await server.connect(tokenFor(await veteran(1000)));
    s.emit("createRoom", { mode: "lucky-duel", betAmount: 50, friendly: true });
    const { roomId } = await nextEvent<{ roomId: string }>(s, "roomCreated");
    expect(roomManager.getRoom(roomId)!.config.betAmount).toBe(0);
    roomManager.forceDeleteRoom(roomId);
  });

  it("the creator must cover the bet and be eligible", async () => {
    expect((await tryCreate(await veteran(99), 100)).error).toMatch(/No tienes suficientes monedas para apostar 100/);
    const unverified = await createUser({ coins: 1000 }, { emailVerified: false });
    await prisma.userStats.create({ data: { userId: unverified.id, normalWins: 10, normalLosses: 10 } });
    expect((await tryCreate(unverified, 50)).error).toMatch(/verificar tu email/);
    expect((await tryCreate(await createUser({ coins: 1000 }, { stats: true }), 50)).error).toMatch(/partidas online para apostar/);
  });

  it("a joiner who can't cover the bet can't take the seat (nobody is charged)", async () => {
    const creator = await veteran(200);
    const r = await tryCreate(creator, 100);
    const poor = await veteran(99);
    const sp = await server.connect(tokenFor(poor));
    sp.emit("joinRoom", { roomId: r.roomId });
    expect((await nextEvent<{ message: string }>(sp, "error")).message).toBe(
      "No tienes suficientes monedas para la apuesta de esta mesa (100 monedas)",
    );
    expect(roomManager.getRoom(r.roomId!)).toMatchObject({ status: "waiting", player2Id: null });
    expect(await coins(creator.id)).toBe(200);
    expect(await coins(poor.id)).toBe(99);
    roomManager.forceDeleteRoom(r.roomId!);
  });

  it("a pair that used up today's bet tables can't start another one", async () => {
    const creator = await veteran(1000);
    const joiner = await veteran(1000);
    const now = new Date();
    for (let i = 0; i < ECONOMY.tableBets.maxBetsPerDayPerOpponent; i++) {
      await prisma.match.create({
        data: { mode: "normal", gameMode: "lucky-duel", status: "finished", player1Id: creator.id, player2Id: joiner.id, betAmount: 10, startedAt: now, settledAt: now },
      });
    }
    const r = await tryCreate(creator, 50);
    const sj = await server.connect(tokenFor(joiner));
    sj.emit("joinRoom", { roomId: r.roomId });
    expect((await nextEvent<{ message: string }>(sj, "error")).message).toBe(
      `Ya jugaste ${ECONOMY.tableBets.maxBetsPerDayPerOpponent} mesas con apuesta contra este rival hoy`,
    );
    expect(roomManager.getRoom(r.roomId!)).toMatchObject({ status: "waiting", player2Id: null });
    roomManager.forceDeleteRoom(r.roomId!);
  });

  it("a Knock Out on turn 1 pays the whole pot to the winner (no turn rule, no house cut)", async () => {
    const t = await betTable(100, 200);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    const state = room.gameState!;
    expect(state.turnNumber).toBeLessThan(ECONOMY.tableBets.minTurnForPayout);
    // The Active of the player whose turn it is: Poisoned one hit from a Knock Out (checkup)
    const turnKey = state.isPlayerTurn ? "playerActivePokemon" : "opponentActivePokemon";
    const active = state[turnKey]!;
    const abra = ALL_CARDS.find((c) => c.id === "base-set-043-abra")!;
    room.gameState = {
      ...state,
      [turnKey]: { ...active, pokemon: { ...abra, id: active.pokemon.id } as typeof active.pokemon, currentDamage: 20, statusConditions: ["poisoned"], attachedEnergy: [] },
    };
    const [turnSocket, winnerSocket] = state.isPlayerTurn ? [t.s1, t.s2] : [t.s2, t.s1];
    const [winner, loser] = state.isPlayerTurn ? [t.p2, t.p1] : [t.p1, t.p2];
    const settled = Promise.all([nextEvent<Any>(winnerSocket, "matchSettled", 8000), nextEvent<Any>(turnSocket, "matchSettled", 8000)]);
    const over = nextEvent<Any>(t.s1, "gameOver");
    turnSocket.emit("action", { roomId: t.roomId, action: act("endTurn") });
    expect((await over).winner).toBe(state.isPlayerTurn ? "player2" : "player1");
    const [won, lost] = await settled;
    // Too short to count (no match coins): only the pot moves
    expect(won).toMatchObject({ outcome: "win", betAmount: 100, coinsDelta: 100, counted: false, coins: 300 });
    expect(lost).toMatchObject({ outcome: "loss", betAmount: 100, coinsDelta: -100, counted: false, coins: 100 });
    expect(await betRows(winner.id)).toEqual([["bet_stake", -100], ["bet_win", 200]]);
    expect(await betRows(loser.id)).toEqual([["bet_stake", -100]]);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: room.matchId! } })).toMatchObject({ status: "finished", winnerId: winner.id, betAmount: 100 });
  });

  it("a surrender before the reveal forfeits the stake to the other player", async () => {
    const t = await betTable(100, 200);
    const settled = nextEvent<Any>(t.s2, "matchSettled", 8000);
    const over = nextEvent<Any>(t.s2, "gameOver");
    t.s1.emit("action", { roomId: t.roomId, action: act("surrender") });
    expect((await over).winner).toBe("player2");
    // The forfeiter is an established account (ECONOMY.antiFarming.forfeit): the early win also
    // counts (match coins + the win mission), within the per-opponent coin cap (100 + 25 < 200)
    expect(await settled).toMatchObject({
      outcome: "win",
      coinsDelta: 100,
      counted: true,
      earlyForfeit: true,
      coins: 300 + ECONOMY.matchCoins.online.win + WIN_MISSION_COINS,
    });
    expect(await coins(t.p1.id)).toBe(100);
  });

  it("leaving on turn 1 forfeits the pot like at any bet table", async () => {
    const t = await betTable(50);
    await revealBoth(t);
    expect(roomManager.getRoom(t.roomId)!.gameState!.turnNumber).toBeLessThan(ECONOMY.tableBets.minTurnForPayout);
    const over = nextEvent<Any>(t.s2, "gameOver");
    t.s1.emit("leaveRoom", { roomId: t.roomId });
    expect((await over).winner).toBe("player2");
    // Pot + the early forfeit's counted win (established forfeiter): match coins + win mission
    await eventually(async () => expect(await coins(t.p2.id)).toBe(150 + ECONOMY.matchCoins.online.win + WIN_MISSION_COINS));
    expect(await coins(t.p1.id)).toBe(50);
  });

  it("a game closed without a result (admin) refunds both stakes", async () => {
    const t = await betTable(100, 100);
    roomManager.forceDeleteRoom(t.roomId);
    await eventually(async () => {
      expect(await coins(t.p1.id)).toBe(100);
      expect(await coins(t.p2.id)).toBe(100);
    });
    expect(await prisma.match.findFirstOrThrow({ where: { roomId: t.roomId } })).toMatchObject({ status: "abandoned" });
  });
});
