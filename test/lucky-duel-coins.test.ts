/**
 * Lucky Duel coins and achievements (docs/lucky-duel-coins-contract.md).
 *
 * - vs the AI: POST /matches/ai { mode: "lucky-duel" } escrows ECONOMY.luckyDuelAi.stake (400
 *   without the coins); /finish pays 2 × stake (victory), the stake (draw) or nothing (defeat),
 *   whatever the anti-farming rules say; a victory reported too soon is a draw; an unfinished one
 *   is settled as an abandoned defeat at the next start; every 5th consecutive victory pays the
 *   streak bonus; a second finish never pays twice.
 * - Achievements (both modes): lucky-first-turn, lucky-streak-10, lucky-magikarp,
 *   lucky-scyther-electabuzz, from the match rows / Lucky Duel streak.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { ALL_CARDS, LUCKY_DUEL_BASICS, findCardById, type GameState } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import * as matches from "../src/modules/matches/matches.service.js";
import { matchesRouter } from "../src/modules/matches/index.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { checkAndUpdateProgress, claimAchievement, listAchievements } from "../src/modules/achievements/achievements.service.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

type Any = Record<string, any>;
type User = Awaited<ReturnType<typeof createUser>>;

const CFG = ECONOMY.luckyDuelAi;
const MAGIKARP = "base-set-035-magikarp";
const SCYTHER = "jungle-010-scyther";
const ROCKETS_SCYTHER = "gym-heroes-013-rockets-scyther";
const ELECTABUZZ = "base-set-020-electabuzz";
const SURGES_ELECTABUZZ = "gym-heroes-006-lt-surges-electabuzz";
const OTHER = LUCKY_DUEL_BASICS.find((c) => c.name === "Pikachu")!.id;

let server: Awaited<ReturnType<typeof startSocketServer>>;
let app: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  server = await startSocketServer();
  app = await startHttpApp((a) => a.use("/api", matchesRouter));
});

afterAll(async () => {
  await app.close();
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

const coins = async (userId: string) => (await getBalances(userId)).coins;
/** Long enough ago for a victory to stand (minVictoryMs), short of the AI's counted minimum. */
const startedLongAgo = () => new Date(Date.now() - CFG.minVictoryMs - 30_000);

/** One whole vs-AI Lucky Duel through the service (started long enough ago for a victory to stand). */
async function playAi(user: User, result: matches.AiResult, options: { turn?: number; luckyDuel?: matches.AiLuckyDuelReport } = {}) {
  const { matchId } = await matches.startAiMatch(user.id, "lucky-duel", startedLongAgo());
  return matches.finishAiMatch(user.id, matchId, result, options.turn ?? 4, new Date(), options.luckyDuel);
}

const report = (playerStarterId: string, opponentStarterId: string, startingPlayer: "player" | "opponent" = "player") => ({
  playerStarterId,
  opponentStarterId,
  startingPlayer,
});

async function luckyClaimable(userId: string): Promise<string[]> {
  await checkAndUpdateProgress(userId);
  return (await listAchievements(userId)).filter((a) => a.id.startsWith("lucky-") && a.claimable).map((a) => a.id).sort();
}

async function luckyStats(userId: string) {
  return prisma.userStats.findUniqueOrThrow({
    where: { userId },
    select: { luckyDuelStreak: true, luckyDuelBestStreak: true, luckyDuelAiStreak: true },
  });
}

// ---------------------------------------------------------------------------
// Stake (escrow) and payouts vs the AI
// ---------------------------------------------------------------------------

describe("vs AI Lucky Duel: the stake", () => {
  it("POST /matches/ai { mode: lucky-duel } escrows the stake and returns it with the streak", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const token = tokenFor(u);
    const res = await app.request("POST", "/api/matches/ai", { token, body: { mode: "lucky-duel" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matchId: expect.any(String), luckyDuel: { stake: CFG.stake, streak: 0 } });
    expect(await coins(u.id)).toBe(100 - CFG.stake);
    const match = await prisma.match.findUniqueOrThrow({ where: { id: res.body.matchId } });
    expect(match).toMatchObject({ mode: "ai", gameMode: "lucky-duel", betAmount: CFG.stake, settledAt: null });
    const tx = await prisma.transaction.findFirstOrThrow({ where: { userId: u.id, type: "lucky_duel_stake" } });
    expect(tx).toMatchObject({ amount: -CFG.stake, balanceAfter: 100 - CFG.stake, currency: "coins" });

    // A standard start (no body, or mode standard) takes nothing and returns only the matchId
    const plain = await app.request("POST", "/api/matches/ai", { token });
    expect(plain.body).toEqual({ matchId: expect.any(String) });
    expect((await app.request("POST", "/api/matches/ai", { token, body: { mode: "chaos" } })).status).toBe(422);
  });

  it("without the coins: 400 with the usual error shape, nothing charged or created", async () => {
    const u = await createUser({ coins: CFG.stake - 1 }, { stats: true });
    const res = await app.request("POST", "/api/matches/ai", { token: tokenFor(u), body: { mode: "lucky-duel" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: `Necesitas ${CFG.stake} monedas para jugar Lucky Duel`, code: "BAD_REQUEST" } });
    expect(await coins(u.id)).toBe(CFG.stake - 1);
    expect(await prisma.match.count({ where: { player1Id: u.id } })).toBe(0);
  });

  it("victory pays 2 × stake, draw refunds the stake, defeat pays nothing — even on turn 1", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const won = await playAi(u, "victory", { turn: 1 });
    expect(won).toMatchObject({ outcome: "win", counted: false, mode: "lucky-duel", luckyDuel: { stake: 20, payout: 40, streak: 1, streakBonus: 0, quickVictory: false } });
    expect(await coins(u.id)).toBe(120);
    const drawn = await playAi(u, "draw", { turn: 1 });
    expect(drawn).toMatchObject({ outcome: "draw", luckyDuel: { stake: 20, payout: 20, streak: 0, streakBonus: 0 } });
    expect(await coins(u.id)).toBe(120);
    const lost = await playAi(u, "defeat", { turn: 2 });
    expect(lost).toMatchObject({ outcome: "loss", luckyDuel: { stake: 20, payout: 0, streak: 0, streakBonus: 0 } });
    expect(await coins(u.id)).toBe(100);
    const types = (await prisma.transaction.findMany({ where: { userId: u.id } })).map((t) => `${t.type}:${t.amount}`).sort();
    expect(types).toEqual(["lucky_duel_refund:20", "lucky_duel_stake:-20", "lucky_duel_stake:-20", "lucky_duel_stake:-20", "lucky_duel_win:40"]);
  });

  it("the normal vs-AI rewards still follow the anti-farming rules (a long counted game adds them)", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const { matchId } = await matches.startAiMatch(u.id, "lucky-duel", new Date(Date.now() - matches.AI_MIN_DURATION_MS - 1000));
    const res = await matches.finishAiMatch(u.id, matchId, "victory", 5);
    expect(res).toMatchObject({ counted: true, rewardCoins: ECONOMY.matchCoins.ai.win, luckyDuel: { payout: 40 } });
    // stake back + 20, the AI match coins and the "win 1 game" mission
    expect(await coins(u.id)).toBe(120 + ECONOMY.matchCoins.ai.win + 50);
  });

  it("a victory reported sooner than minVictoryMs is settled as a draw (stake back, streak reset)", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    await prisma.userStats.update({ where: { userId: u.id }, data: { luckyDuelAiStreak: 3, luckyDuelStreak: 3, luckyDuelBestStreak: 3 } });
    const { matchId } = await matches.startAiMatch(u.id, "lucky-duel");
    const res = await matches.finishAiMatch(u.id, matchId, "victory", 1, new Date(), report(MAGIKARP, OTHER));
    expect(res).toMatchObject({ outcome: "draw", luckyDuel: { stake: 20, payout: 20, streak: 0, streakBonus: 0, quickVictory: true } });
    expect(await coins(u.id)).toBe(100);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).toMatchObject({ winnerId: null, winReason: "lucky-duel: draw (quick victory)" });
    expect(await luckyStats(u.id)).toEqual({ luckyDuelStreak: 0, luckyDuelBestStreak: 3, luckyDuelAiStreak: 0 });
    expect(await luckyClaimable(u.id)).toEqual([]);
  });

  it("a second finish never pays twice (409), also when both arrive at once", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const { matchId } = await matches.startAiMatch(u.id, "lucky-duel", startedLongAgo());
    const { fulfilled, rejected } = await race(2, () => matches.finishAiMatch(u.id, matchId, "victory", 3));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409 });
    await expect(matches.finishAiMatch(u.id, matchId, "victory", 3)).rejects.toMatchObject({ statusCode: 409 });
    expect(await coins(u.id)).toBe(120);
    expect((await luckyStats(u.id)).luckyDuelAiStreak).toBe(1);
  });

  it("the stored mode wins: a standard game finished as lucky-duel moves no coins, a Lucky Duel finished without mode still settles its stake", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const token = tokenFor(u);
    const plain = (await app.request("POST", "/api/matches/ai", { token })).body.matchId;
    await prisma.match.update({ where: { id: plain }, data: { startedAt: startedLongAgo() } });
    const asLucky = await app.request("POST", `/api/matches/ai/${plain}/finish`, { token, body: { result: "victory", turnNumber: 1, mode: "lucky-duel" } });
    expect(asLucky.status).toBe(200);
    expect(asLucky.body.luckyDuel).toBeUndefined();
    expect(asLucky.body.mode).toBe("standard");
    expect(await coins(u.id)).toBe(100);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: plain } })).toMatchObject({ gameMode: "standard", winReason: "victory", finalTurn: null });

    const lucky = (await app.request("POST", "/api/matches/ai", { token, body: { mode: "lucky-duel" } })).body.matchId;
    await prisma.match.update({ where: { id: lucky }, data: { startedAt: startedLongAgo() } });
    const done = await app.request("POST", `/api/matches/ai/${lucky}/finish`, { token, body: { result: "victory", turnNumber: 2 } });
    expect(done.body).toMatchObject({ mode: "lucky-duel", luckyDuel: { payout: 40 } });
    expect(await coins(u.id)).toBe(120);
  });

  it("an account without a verified email plays for nothing (stake 0, no bonus) but keeps its streak", async () => {
    const u = await createUser({ coins: 100 }, { stats: true, emailVerified: false });
    const start = await app.request("POST", "/api/matches/ai", { token: tokenFor(u), body: { mode: "lucky-duel" } });
    expect(start.body.luckyDuel).toEqual({ stake: 0, streak: 0 });
    await prisma.match.delete({ where: { id: start.body.matchId } });
    for (let i = 0; i < CFG.streakBonusEvery; i++) {
      const res = await playAi(u, "victory");
      expect(res.luckyDuel).toMatchObject({ stake: 0, payout: 0, streakBonus: 0, streak: i + 1 });
    }
    expect(await coins(u.id)).toBe(100);
    expect(await prisma.transaction.count({ where: { userId: u.id } })).toBe(0);
  });

  it("GET /matches/ai/lucky-duel: the stake, the bonus rule and the streaks", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    await playAi(u, "victory");
    await playAi(u, "victory");
    const res = await app.request("GET", "/api/matches/ai/lucky-duel", { token: tokenFor(u) });
    expect(res.body).toEqual({
      stake: CFG.stake,
      streakBonusEvery: CFG.streakBonusEvery,
      streakBonus: CFG.streakBonus,
      streak: 2,
      luckyDuelStreak: 2,
      luckyDuelBestStreak: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Abandon: starting another vs-AI game settles an unfinished Lucky Duel as a defeat
// ---------------------------------------------------------------------------

describe("vs AI Lucky Duel: abandon on a new start", () => {
  it("a new start settles the unfinished Lucky Duel as a defeat (stake kept, streak reset, finish → 409)", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    await playAi(u, "victory");
    await playAi(u, "victory");
    const { matchId: left } = await matches.startAiMatch(u.id, "lucky-duel");
    expect(await coins(u.id)).toBe(120); // 100 + 2 × 20 - 20 escrowed
    const next = await matches.startAiMatch(u.id, "lucky-duel");
    expect(next.luckyDuel).toEqual({ stake: 20, streak: 0 });
    expect(await coins(u.id)).toBe(100);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: left } })).toMatchObject({
      status: "finished",
      winnerId: null,
      winReason: "lucky-duel: abandoned",
      settledAt: expect.any(Date),
      finalTurn: 0,
    });
    expect(await luckyStats(u.id)).toEqual({ luckyDuelStreak: 0, luckyDuelBestStreak: 2, luckyDuelAiStreak: 0 });
    await expect(matches.finishAiMatch(u.id, left, "victory", 5)).rejects.toMatchObject({ statusCode: 409 });
    expect(await coins(u.id)).toBe(100);
  });

  it("a standard start also settles it (and still drops a standard unfinished game)", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const { matchId: lucky } = await matches.startAiMatch(u.id, "lucky-duel");
    const { matchId: plain } = await matches.startAiMatch(u.id);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: lucky } })).winReason).toBe("lucky-duel: abandoned");
    await matches.startAiMatch(u.id);
    expect(await prisma.match.findUnique({ where: { id: plain } })).toBeNull();
    expect(await coins(u.id)).toBe(80);
  });

  it("a start refused for lack of coins still settles the abandoned game", async () => {
    const u = await createUser({ coins: CFG.stake }, { stats: true });
    const { matchId: left } = await matches.startAiMatch(u.id, "lucky-duel");
    await expect(matches.startAiMatch(u.id, "lucky-duel")).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.match.findUniqueOrThrow({ where: { id: left } })).toMatchObject({ winReason: "lucky-duel: abandoned" });
    expect(await coins(u.id)).toBe(0);
  });

  it("two starts at once: one game stays open, the other is abandoned, each stake taken once", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const { fulfilled } = await race(2, () => matches.startAiMatch(u.id, "lucky-duel"));
    expect(fulfilled).toHaveLength(2);
    expect(await prisma.match.count({ where: { player1Id: u.id, settledAt: null } })).toBe(1);
    expect(await prisma.match.count({ where: { player1Id: u.id, winReason: "lucky-duel: abandoned" } })).toBe(1);
    expect(await coins(u.id)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Streak bonus vs the AI
// ---------------------------------------------------------------------------

describe("vs AI Lucky Duel: the streak bonus", () => {
  it(`every ${CFG.streakBonusEvery}th consecutive victory pays ${CFG.streakBonus} (at 5 and at 10)`, async () => {
    const u = await createUser({ coins: 1000 }, { stats: true });
    for (let i = 1; i <= 10; i++) {
      const res = await playAi(u, "victory");
      const bonus = i % CFG.streakBonusEvery === 0 ? CFG.streakBonus : 0;
      expect(res.luckyDuel).toMatchObject({ streak: i, streakBonus: bonus, payout: 40 });
    }
    expect(await coins(u.id)).toBe(1000 + 10 * 20 + 2 * CFG.streakBonus);
    const bonuses = await prisma.transaction.findMany({ where: { userId: u.id, type: "lucky_duel_streak_bonus" } });
    expect(bonuses.map((b) => b.amount)).toEqual([CFG.streakBonus, CFG.streakBonus]);
    expect(await luckyStats(u.id)).toEqual({ luckyDuelStreak: 10, luckyDuelBestStreak: 10, luckyDuelAiStreak: 10 });
  });

  for (const breaker of ["defeat", "draw", "abandon"] as const) {
    it(`a ${breaker} resets the streak: the bonus needs 5 new victories`, async () => {
      const u = await createUser({ coins: 1000 }, { stats: true });
      for (let i = 0; i < 4; i++) await playAi(u, "victory");
      if (breaker === "abandon") await matches.startAiMatch(u.id, "lucky-duel");
      else await playAi(u, breaker);
      for (let i = 1; i <= 5; i++) {
        const res = await playAi(u, "victory");
        expect(res.luckyDuel).toMatchObject({ streak: i, streakBonus: i === 5 ? CFG.streakBonus : 0 });
      }
      expect(await prisma.transaction.count({ where: { userId: u.id, type: "lucky_duel_streak_bonus" } })).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Starter ids
// ---------------------------------------------------------------------------

describe("vs AI Lucky Duel: the reported Basics", () => {
  it("ids that aren't Lucky Duel Basics are rejected with 400 and nothing is settled", async () => {
    const u = await createUser({ coins: 100 }, { stats: true });
    const token = tokenFor(u);
    const { matchId } = (await app.request("POST", "/api/matches/ai", { token, body: { mode: "lucky-duel" } })).body;
    await prisma.match.update({ where: { id: matchId }, data: { startedAt: startedLongAgo() } });
    const finish = (luckyDuel: unknown) =>
      app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "victory", turnNumber: 2, luckyDuel } });
    for (const bad of [report("base-set-004-charizard", OTHER), report(OTHER, "not-a-card"), report(OTHER, "base-set-091-bill")]) {
      const res = await finish(bad);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("Pokémon de Lucky Duel inválido");
    }
    expect((await finish({ playerStarterId: OTHER, opponentStarterId: OTHER, startingPlayer: "rival" })).status).toBe(422);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).settledAt).toBeNull();
    expect(await coins(u.id)).toBe(80);

    const ok = await finish(report(SCYTHER, ELECTABUZZ, "opponent"));
    expect(ok.status).toBe(200);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).toMatchObject({
      player1StarterId: SCYTHER,
      player2StarterId: ELECTABUZZ,
      startingSide: "player2",
      finalTurn: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Achievements: vs AI
// ---------------------------------------------------------------------------

describe("Lucky Duel achievements vs the AI", () => {
  it("lucky-magikarp: only a victory with your own Magikarp", async () => {
    const u = await createUser({ coins: 1000 }, { stats: true });
    await playAi(u, "defeat", { luckyDuel: report(MAGIKARP, OTHER) });
    await playAi(u, "draw", { luckyDuel: report(MAGIKARP, OTHER) });
    await playAi(u, "victory", { luckyDuel: report(OTHER, MAGIKARP) });
    expect(await luckyClaimable(u.id)).toEqual([]);
    await playAi(u, "victory", { luckyDuel: report("team-rocket-047-magikarp", OTHER) });
    expect(await luckyClaimable(u.id)).toEqual(["lucky-magikarp"]);

    const before = await coins(u.id);
    expect(await claimAchievement(u.id, "lucky-magikarp")).toEqual({ achievementId: "lucky-magikarp", coins: 500, coupons: 0 });
    expect(await coins(u.id)).toBe(before + 500);
    const def = (await listAchievements(u.id)).find((a) => a.id === "lucky-magikarp")!;
    expect(def).toMatchObject({ name: "Magikarp campeón", tier: "silver", progressTarget: 1, claimed: true, status: "active" });
  });

  it("lucky-scyther-electabuzz: a victory with a Scyther against an Electabuzz (owner variants included)", async () => {
    const u = await createUser({ coins: 1000 }, { stats: true });
    await playAi(u, "victory", { luckyDuel: report(SCYTHER, OTHER) });
    await playAi(u, "victory", { luckyDuel: report(ELECTABUZZ, SCYTHER) });
    await playAi(u, "defeat", { luckyDuel: report(SCYTHER, ELECTABUZZ) });
    expect(await luckyClaimable(u.id)).toEqual([]);
    await playAi(u, "victory", { luckyDuel: report(SCYTHER, SURGES_ELECTABUZZ) });
    expect(await luckyClaimable(u.id)).toEqual(["lucky-scyther-electabuzz"]);

    const v = await createUser({ coins: 1000 }, { stats: true });
    await playAi(v, "victory", { luckyDuel: report(ROCKETS_SCYTHER, ELECTABUZZ) });
    expect(await luckyClaimable(v.id)).toEqual(["lucky-scyther-electabuzz"]);
  });

  it("lucky-first-turn: turn 1 when you started, turn 2 when the AI did", async () => {
    const a = await createUser({ coins: 1000 }, { stats: true });
    await playAi(a, "victory", { turn: 2, luckyDuel: report(OTHER, OTHER, "player") });
    await playAi(a, "victory", { turn: 1, luckyDuel: report(OTHER, OTHER, "opponent") });
    await playAi(a, "victory", { turn: 3, luckyDuel: report(OTHER, OTHER, "opponent") });
    await playAi(a, "defeat", { turn: 1, luckyDuel: report(OTHER, OTHER, "player") });
    expect(await luckyClaimable(a.id)).toEqual([]);
    await playAi(a, "victory", { turn: 1, luckyDuel: report(OTHER, OTHER, "player") });
    expect(await luckyClaimable(a.id)).toEqual(["lucky-first-turn"]);

    const b = await createUser({ coins: 1000 }, { stats: true });
    await playAi(b, "victory", { turn: 2, luckyDuel: report(OTHER, OTHER, "opponent") });
    expect(await luckyClaimable(b.id)).toEqual(["lucky-first-turn"]);
  });

  it("lucky-streak-10: progress is the best Lucky Duel streak; a defeat restarts the run", async () => {
    const u = await createUser({ coins: 1000 }, { stats: true });
    for (let i = 0; i < 9; i++) await playAi(u, "victory");
    await playAi(u, "defeat");
    await playAi(u, "victory");
    await checkAndUpdateProgress(u.id);
    let def = (await listAchievements(u.id)).find((a) => a.id === "lucky-streak-10")!;
    expect(def).toMatchObject({ progress: 9, progressTarget: 10, claimable: false, tier: "gold", name: "Suerte imparable" });
    for (let i = 0; i < 9; i++) await playAi(u, "victory");
    expect(await luckyClaimable(u.id)).toEqual(["lucky-streak-10"]);
    def = (await listAchievements(u.id)).find((a) => a.id === "lucky-streak-10")!;
    expect(def.reward).toEqual({ coins: 800, coupons: 2 });
  });
});

// ---------------------------------------------------------------------------
// Achievements and streaks: multiplayer (server-authoritative)
// ---------------------------------------------------------------------------

const act = (type: string, payload: Any = {}) => ({ type, payload });

async function luckyTable(options: { friendly?: boolean } = {}) {
  const [p1, p2] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  s1.emit("createRoom", { mode: "lucky-duel", ...(options.friendly ? { friendly: true } : {}) });
  const created = await nextEvent<{ roomId: string }>(s1, "roomCreated");
  const started = Promise.all([nextEvent<Any>(s1, "gameStart"), nextEvent<Any>(s2, "gameStart")]);
  s2.emit("joinRoom", { roomId: created.roomId });
  await started;
  return { roomId: created.roomId, p1, p2, s1, s2 };
}

async function revealBoth(t: Awaited<ReturnType<typeof luckyTable>>) {
  const firstReady = nextEvent<Any>(t.s1, "gameState");
  t.s1.emit("action", { roomId: t.roomId, action: act("playerReady") });
  await firstReady;
  const revealed = Promise.all([nextEvent<Any>(t.s1, "gameState"), nextEvent<Any>(t.s2, "gameState")]);
  t.s2.emit("action", { roomId: t.roomId, action: act("playerReady") });
  await revealed;
}

/** `loser` surrenders; resolves once both players got matchSettled. */
async function surrender(t: Awaited<ReturnType<typeof luckyTable>>, loser: ClientSocket) {
  const settled = Promise.all([nextEvent<Any>(t.s1, "matchSettled", 8000), nextEvent<Any>(t.s2, "matchSettled", 8000)]);
  loser.emit("action", { roomId: t.roomId, action: act("surrender") });
  return settled;
}

describe("Lucky Duel achievements and streaks in multiplayer", () => {
  const sockets: ClientSocket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  it("records the drawn Basics, who started and the last turn; a first-turn win with Scyther vs Electabuzz", async () => {
    const t = await luckyTable();
    sockets.push(t.s1, t.s2);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    const state = room.gameState as GameState;
    // The recorded starters are the Basics actually dealt (the in-game card ids are random)
    expect(findCardById(room.luckyDuelStarters!.player1)!.name).toBe(state.playerActivePokemon!.pokemon.name);
    expect(findCardById(room.luckyDuelStarters!.player2)!.name).toBe(state.opponentActivePokemon!.pokemon.name);
    expect(state.turnNumber).toBe(1);

    const starterIsP1 = state.startingPlayer === "player";
    const [winner, loser] = starterIsP1 ? [t.p1, t.p2] : [t.p2, t.p1];
    room.luckyDuelStarters = starterIsP1 ? { player1: SCYTHER, player2: SURGES_ELECTABUZZ } : { player1: SURGES_ELECTABUZZ, player2: SCYTHER };
    await prisma.userStats.update({ where: { userId: winner.id }, data: { luckyDuelAiStreak: 3, luckyDuelStreak: 9, luckyDuelBestStreak: 9 } });
    await prisma.userStats.update({ where: { userId: loser.id }, data: { luckyDuelStreak: 4, luckyDuelBestStreak: 4, luckyDuelAiStreak: 2 } });

    await surrender(t, starterIsP1 ? t.s2 : t.s1);
    const match = await prisma.match.findUniqueOrThrow({ where: { id: room.matchId! } });
    expect(match).toMatchObject({
      mode: "normal",
      gameMode: "lucky-duel",
      winnerId: winner.id,
      player1StarterId: room.luckyDuelStarters.player1,
      player2StarterId: room.luckyDuelStarters.player2,
      startingSide: starterIsP1 ? "player1" : "player2",
      finalTurn: 1,
      counted: false,
    });
    // Multiplayer moves the Lucky Duel streak (both modes), never the vs-AI one
    expect(await luckyStats(winner.id)).toEqual({ luckyDuelStreak: 10, luckyDuelBestStreak: 10, luckyDuelAiStreak: 3 });
    expect(await luckyStats(loser.id)).toEqual({ luckyDuelStreak: 0, luckyDuelBestStreak: 4, luckyDuelAiStreak: 2 });

    expect(await luckyClaimable(winner.id)).toEqual(["lucky-first-turn", "lucky-scyther-electabuzz", "lucky-streak-10"]);
    expect(await luckyClaimable(loser.id)).toEqual([]);
  });

  it("a win on the rival's turn is not a first-turn win; Magikarp counts on either seat", async () => {
    const t = await luckyTable();
    sockets.push(t.s1, t.s2);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    const starterIsP1 = room.gameState!.startingPlayer === "player";
    // The non-starter wins on turn 1 (the starter's turn): not its first turn
    const [winner, loserSocket] = starterIsP1 ? [t.p2, t.s1] : [t.p1, t.s2];
    room.luckyDuelStarters = starterIsP1 ? { player1: OTHER, player2: MAGIKARP } : { player1: MAGIKARP, player2: OTHER };
    await surrender(t, loserSocket);
    expect(await luckyClaimable(winner.id)).toEqual(["lucky-magikarp"]);
  });

  it("a draw is nobody's win and resets both streaks", async () => {
    const t = await luckyTable();
    sockets.push(t.s1, t.s2);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    room.luckyDuelStarters = { player1: MAGIKARP, player2: MAGIKARP };
    for (const p of [t.p1, t.p2]) {
      await prisma.userStats.update({ where: { userId: p.id }, data: { luckyDuelStreak: 5, luckyDuelBestStreak: 5 } });
    }
    // Both Actives Poisoned one hit from a Knock Out: the checkup Knocks Out both (game-core)
    const state = room.gameState!;
    const poisoned = (active: NonNullable<GameState["playerActivePokemon"]>, cardId: string) => {
      const card = ALL_CARDS.find((c) => c.id === cardId)!;
      return { ...active, pokemon: { ...card, id: active.pokemon.id } as typeof active.pokemon, currentDamage: 20, statusConditions: ["poisoned"] as typeof active.statusConditions, attachedEnergy: [] };
    };
    room.gameState = {
      ...state,
      playerActivePokemon: poisoned(state.playerActivePokemon!, "base-set-043-abra"),
      opponentActivePokemon: poisoned(state.opponentActivePokemon!, "base-set-050-gastly"),
    };
    const turnSocket = room.gameState.isPlayerTurn ? t.s1 : t.s2;
    const settled = Promise.all([nextEvent<Any>(t.s1, "matchSettled", 8000), nextEvent<Any>(t.s2, "matchSettled", 8000)]);
    turnSocket.emit("action", { roomId: t.roomId, action: act("endTurn") });
    for (const s of await settled) expect(s.outcome).toBe("draw");
    for (const p of [t.p1, t.p2]) {
      expect((await luckyStats(p.id)).luckyDuelStreak).toBe(0);
      expect(await luckyClaimable(p.id)).toEqual([]);
    }
  });

  it("friendly tables move no Lucky Duel streak and earn no Lucky Duel achievement", async () => {
    const t = await luckyTable({ friendly: true });
    sockets.push(t.s1, t.s2);
    await revealBoth(t);
    const room = roomManager.getRoom(t.roomId)!;
    room.luckyDuelStarters = { player1: MAGIKARP, player2: MAGIKARP };
    await surrender(t, t.s2);
    const match = await prisma.match.findUniqueOrThrow({ where: { id: room.matchId! } });
    expect(match).toMatchObject({ mode: "friendly", gameMode: "lucky-duel", winnerId: t.p1.id });
    expect(await luckyStats(t.p1.id)).toEqual({ luckyDuelStreak: 0, luckyDuelBestStreak: 0, luckyDuelAiStreak: 0 });
    expect(await luckyClaimable(t.p1.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// "Leyenda Viviente" after the target grew
// ---------------------------------------------------------------------------

describe("Leyenda Viviente with the Lucky Duel achievements", () => {
  it("its target counts the 4 new achievements; a claim made before stays claimed and shows complete", async () => {
    const u = await createUser({}, { stats: true });
    const list = await listAchievements(u.id);
    const meta = list.find((a) => a.id === "legend-50")!;
    const active = list.filter((a) => a.status === "active" && a.id !== "legend-50");
    expect(meta.progressTarget).toBe(active.length);
    for (const id of ["lucky-first-turn", "lucky-streak-10", "lucky-magikarp", "lucky-scyther-electabuzz"]) {
      expect(active.map((a) => a.id)).toContain(id);
    }

    // Claimed when the target was 4 lower: still claimed, shown complete, never paid again
    await prisma.userAchievement.create({
      data: { userId: u.id, achievementId: "legend-50", progress: meta.progressTarget - 4, unlockedAt: new Date() },
    });
    await checkAndUpdateProgress(u.id);
    const after = (await listAchievements(u.id)).find((a) => a.id === "legend-50")!;
    expect(after).toMatchObject({ claimed: true, claimable: false, progress: meta.progressTarget });
    await expect(claimAchievement(u.id, "legend-50")).rejects.toMatchObject({ statusCode: 409 });

    // Not claimed yet with every old achievement claimed: no longer claimable until the new ones are
    const v = await createUser({}, { stats: true });
    await prisma.userAchievement.create({ data: { userId: v.id, achievementId: "legend-50", progress: meta.progressTarget - 4 } });
    await checkAndUpdateProgress(v.id);
    expect((await listAchievements(v.id)).find((a) => a.id === "legend-50")).toMatchObject({ claimable: false });
    await expect(claimAchievement(v.id, "legend-50")).rejects.toMatchObject({ statusCode: 400 });
  });
});
