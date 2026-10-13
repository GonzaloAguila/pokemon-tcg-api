import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import * as matches from "../src/modules/matches/matches.service.js";
import { DAILY_XP_CAP, XP_REWARDS, applyExperience } from "../src/modules/users/xp.service.js";
import { maxBetForTitle } from "../src/modules/users/titles.js";
import { matchesRouter } from "../src/modules/matches/index.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

async function createPlayer(coins = 0) {
  const user = await createUser({ coins });
  await prisma.userStats.create({ data: { userId: user.id } });
  return user;
}

async function profile(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { coins: true, level: true, experience: true, stats: true },
  });
}

async function txTypes(userId: string) {
  const rows = await prisma.transaction.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => [r.type, r.amount]);
}

const win = (winnerId: string | null, turnNumber = 10) =>
  ({ kind: "multiplayer", winnerId, reason: "test", turnNumber }) as const;

describe("level math (matches the frontend: level L needs L * 1000 XP)", () => {
  it("adds XP inside the level and rolls over full levels", () => {
    expect(applyExperience(1, 0, 100)).toEqual({ level: 1, experience: 100, levelsGained: 0 });
    expect(applyExperience(1, 950, 100)).toEqual({ level: 2, experience: 50, levelsGained: 1 });
    // 1 -> 2 costs 1000, 2 -> 3 costs 2000
    expect(applyExperience(1, 0, 3000)).toEqual({ level: 3, experience: 0, levelsGained: 2 });
    expect(applyExperience(2, 1999, 1)).toEqual({ level: 3, experience: 0, levelsGained: 1 });
  });

  it("never goes past the max level", () => {
    const r = applyExperience(100, 0, 10_000_000);
    expect(r.level).toBe(100);
    expect(r.experience).toBeLessThan(100 * 1000);
  });
});

describe("table bets", () => {
  it("validates the bet server-side and caps it by title", async () => {
    for (const bad of [-1, 1.5, matches.MAX_BET + 1, Number.NaN]) {
      expect(() => matches.assertValidBet(bad)).toThrow();
    }
    expect(maxBetForTitle("novato")).toBe(20);
    expect(maxBetForTitle("domadragones")).toBe(200);
    expect(maxBetForTitle("superadmin")).toBe(1000);
    expect(maxBetForTitle("made-up")).toBe(20);
  });

  it("escrows both stakes when the game starts and pays the pot to the winner exactly once", async () => {
    const a = await createPlayer(100);
    const b = await createPlayer(100);
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 40, roomId: "T1" });

    expect((await getBalances(a.id)).coins).toBe(60);
    expect((await getBalances(b.id)).coins).toBe(60);

    // Several end events at once (game over + forfeit timer + kick...): one settlement
    const { fulfilled, rejected } = await race(5, () => matches.settleMatch(id, win(a.id)));
    expect(rejected).toHaveLength(0);
    expect(fulfilled.filter((r) => r.value !== null)).toHaveLength(1);
    expect(await matches.settleMatch(id, win(b.id))).toBeNull();

    const pa = await profile(a.id);
    const pb = await profile(b.id);
    expect(pa.coins).toBe(140);
    expect(pb.coins).toBe(60);
    expect(pa.stats).toMatchObject({ normalWins: 1, normalLosses: 0, currentStreak: 1 });
    expect(pb.stats).toMatchObject({ normalWins: 0, normalLosses: 1 });
    expect(pa.experience).toBe(XP_REWARDS.normal.win);
    expect(pb.experience).toBe(XP_REWARDS.normal.loss);

    expect(await txTypes(a.id)).toEqual([["bet_stake", -40], ["bet_win", 80]]);
    expect(await txTypes(b.id)).toEqual([["bet_stake", -40]]);

    const row = await prisma.match.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "finished", winnerId: a.id, betAmount: 40, player1Xp: 100, player2Xp: 40 });
    expect(row.settledAt).not.toBeNull();
  });

  it("charges nobody when a player can't cover the bet", async () => {
    const rich = await createPlayer(100);
    const poor = await createPlayer(10);
    const before = await prisma.match.count();

    const err = await matches
      .openMultiplayerMatch({ player1Id: rich.id, player2Id: poor.id, mode: "normal", betAmount: 50, roomId: "T2" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(matches.InsufficientStakeError);
    expect(err.userId).toBe(poor.id);

    expect((await getBalances(rich.id)).coins).toBe(100);
    expect((await getBalances(poor.id)).coins).toBe(10);
    expect(await prisma.match.count()).toBe(before);
    expect(await txTypes(rich.id)).toEqual([]);
  });

  it("refunds both stakes when there is no result (cancelled / abandoned / draw)", async () => {
    const a = await createPlayer(50);
    const b = await createPlayer(50);
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 50, roomId: "T3" });
    expect((await getBalances(a.id)).coins).toBe(0);

    const result = await matches.settleMatch(id, win(null));
    expect(result?.players.map((p) => p.outcome)).toEqual(["none", "none"]);

    const pa = await profile(a.id);
    const pb = await profile(b.id);
    expect([pa.coins, pb.coins]).toEqual([50, 50]);
    expect(pa.stats).toMatchObject({ normalWins: 0, normalLosses: 0 });
    expect([pa.experience, pb.experience]).toEqual([0, 0]);
    expect(await txTypes(b.id)).toEqual([["bet_stake", -50], ["bet_refund", 50]]);
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).status).toBe("abandoned");
  });

  it("refunds matches left unsettled by a restart", async () => {
    const a = await createPlayer(30);
    const b = await createPlayer(30);
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 30, roomId: "T4" });

    expect(await matches.refundUnsettledMatches()).toBeGreaterThanOrEqual(1);
    expect((await getBalances(a.id)).coins).toBe(30);
    expect((await getBalances(b.id)).coins).toBe(30);
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).settledAt).not.toBeNull();
  });

  it("friendly tables take no bet, record no stats and give no XP", async () => {
    const a = await createPlayer(100);
    const b = await createPlayer(100);
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "friendly", betAmount: 50, roomId: "T5" });
    expect((await getBalances(a.id)).coins).toBe(100);
    await matches.settleMatch(id, win(a.id));
    const pa = await profile(a.id);
    expect(pa.coins).toBe(100);
    expect(pa.stats).toMatchObject({ normalWins: 0 });
    expect(pa.experience).toBe(0);
  });

  it("ignores a winner that isn't one of the players", async () => {
    const a = await createPlayer(20);
    const b = await createPlayer(20);
    const outsider = await createPlayer(0);
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 20, roomId: "T6" });
    await matches.settleMatch(id, win(outsider.id));
    expect((await getBalances(outsider.id)).coins).toBe(0);
    expect((await getBalances(a.id)).coins).toBe(20);
    expect((await getBalances(b.id)).coins).toBe(20);
  });
});

describe("multiplayer XP", () => {
  it("draft matches give draft XP and stats", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "draft", betAmount: 0, roomId: "D1" });
    await matches.settleMatch(id, win(b.id));
    const pa = await profile(a.id);
    const pb = await profile(b.id);
    expect([pa.experience, pb.experience]).toEqual([XP_REWARDS.draft.loss, XP_REWARDS.draft.win]);
    expect(pb.stats).toMatchObject({ draftWins: 1 });
    expect(pa.stats).toMatchObject({ draftLosses: 1 });
  });

  it("a game that ends before both players had a turn gives no XP (stats and bets still settle)", async () => {
    const a = await createPlayer(10);
    const b = await createPlayer(10);
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 10, roomId: "X1" });
    await matches.settleMatch(id, win(a.id, 1));
    const pa = await profile(a.id);
    expect(pa.experience).toBe(0);
    expect(pa.coins).toBe(20);
    expect(pa.stats).toMatchObject({ normalWins: 1 });
  });

  it("levels up and respects the daily XP cap", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    await prisma.user.update({ where: { id: a.id }, data: { level: 1, experience: 950 } });

    const first = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0, roomId: "X2" });
    const res = await matches.settleMatch(first.id, win(a.id));
    expect(res?.players[0]).toMatchObject({ userId: a.id, xpGained: 100, level: 2, experience: 50, levelsGained: 1 });

    // Pretend a already earned almost the whole cap today
    await prisma.match.create({
      data: { mode: "normal", status: "finished", player1Id: a.id, player1Xp: DAILY_XP_CAP - 100 - 30, settledAt: new Date() },
    });
    const second = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0, roomId: "X3" });
    const capped = await matches.settleMatch(second.id, win(a.id));
    expect(capped?.players[0]).toMatchObject({ xpGained: 30, xpCapped: true });

    const third = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0, roomId: "X4" });
    const none = await matches.settleMatch(third.id, win(a.id));
    expect(none?.players[0]).toMatchObject({ xpGained: 0, xpCapped: true });
    // b isn't affected by a's cap
    expect(none?.players[1]).toMatchObject({ xpGained: XP_REWARDS.normal.loss });
  });
});

describe("single player vs AI (client-reported, bounded)", () => {
  async function startedAgo(userId: string, ms: number) {
    const { matchId } = await matches.startAiMatch(userId);
    await prisma.match.update({ where: { id: matchId }, data: { startedAt: new Date(Date.now() - ms) } });
    return matchId;
  }

  it("a finished game earns AI XP once; reporting it again is rejected", async () => {
    const u = await createPlayer();
    const matchId = await startedAgo(u.id, matches.AI_MIN_DURATION_MS + 1000);
    const res = await matches.finishAiMatch(u.id, matchId, true);
    expect(res).toMatchObject({ xpGained: XP_REWARDS.ai.win, level: 1, experience: XP_REWARDS.ai.win });
    await expect(matches.finishAiMatch(u.id, matchId, true)).rejects.toMatchObject({ statusCode: 409 });
    // No stats from single player
    expect((await profile(u.id)).stats).toMatchObject({ normalWins: 0, normalLosses: 0 });
  });

  it("a game shorter than the minimum is recorded without XP", async () => {
    const u = await createPlayer();
    const { matchId } = await matches.startAiMatch(u.id);
    const res = await matches.finishAiMatch(u.id, matchId, true);
    expect(res.xpGained).toBe(0);
    await expect(matches.finishAiMatch(u.id, matchId, true)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("only the first games of the day earn XP", async () => {
    const u = await createPlayer();
    for (let i = 0; i < matches.AI_DAILY_REWARDED_GAMES; i++) {
      const id = await startedAgo(u.id, matches.AI_MIN_DURATION_MS + 1000);
      expect((await matches.finishAiMatch(u.id, id, false)).xpGained).toBe(XP_REWARDS.ai.loss);
    }
    const extra = await startedAgo(u.id, matches.AI_MIN_DURATION_MS + 1000);
    expect((await matches.finishAiMatch(u.id, extra, true)).xpGained).toBe(0);
    expect((await profile(u.id)).experience).toBe(XP_REWARDS.ai.loss * matches.AI_DAILY_REWARDED_GAMES);
  });

  it("someone else's match or an abandoned start can't be finished", async () => {
    const u = await createPlayer();
    const other = await createPlayer();
    const mine = await startedAgo(u.id, matches.AI_MIN_DURATION_MS + 1000);
    await expect(matches.finishAiMatch(other.id, mine, true)).rejects.toMatchObject({ statusCode: 404 });

    // Starting a new game drops the unfinished one
    await matches.startAiMatch(u.id);
    await expect(matches.finishAiMatch(u.id, mine, true)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("HTTP: the amount of XP is decided by the server; bad bodies are rejected", async () => {
    const u = await createPlayer();
    const token = tokenFor(u);
    const app = await startHttpApp((a) => a.use("/api", matchesRouter));
    try {
      expect((await app.request("POST", "/api/matches/ai")).status).toBe(401);
      const start = await app.request("POST", "/api/matches/ai", { token });
      expect(start.status).toBe(200);
      const { matchId } = start.body;

      expect((await app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "win" } })).status).toBe(422);
      expect((await app.request("POST", "/api/matches/ai/not-a-uuid/finish", { token, body: { result: "victory" } })).status).toBe(404);

      await prisma.match.update({ where: { id: matchId }, data: { startedAt: new Date(Date.now() - matches.AI_MIN_DURATION_MS - 1000) } });
      const done = await app.request("POST", `/api/matches/ai/${matchId}/finish`, {
        token,
        body: { result: "victory", xp: 999_999, xpGained: 999_999 },
      });
      expect(done.status).toBe(200);
      expect(done.body.xpGained).toBe(XP_REWARDS.ai.win);
      expect((await profile(u.id)).experience).toBe(XP_REWARDS.ai.win);
    } finally {
      await app.close();
    }
  });
});
