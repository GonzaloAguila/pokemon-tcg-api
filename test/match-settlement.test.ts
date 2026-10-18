import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import * as matches from "../src/modules/matches/matches.service.js";
import { DAILY_XP_CAP, XP_REWARDS, applyExperience } from "../src/modules/users/xp.service.js";
import { maxBetForTitle } from "../src/modules/users/titles.js";
import { matchesRouter } from "../src/modules/matches/index.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const ONLINE = ECONOMY.matchCoins.online;
const AI = ECONOMY.matchCoins.ai;
const WIN_MISSION = ECONOMY.missions.daily.find((m) => m.id === "win_game")!.rewardCoins;
const PLAY_MISSION = ECONOMY.missions.daily.find((m) => m.id === "play_games")!.rewardCoins;

async function createPlayer(coins = 0, opts: { eligibleForBets?: boolean } = {}) {
  const user = await createUser({ coins });
  if (opts.eligibleForBets) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    await prisma.userStats.create({ data: { userId: user.id, normalWins: 10, normalLosses: 10 } });
  } else {
    await prisma.userStats.create({ data: { userId: user.id } });
  }
  return user;
}

async function profile(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { coins: true, level: true, experience: true, stats: true },
  });
}

async function txTypes(userId: string, types?: string[]) {
  const rows = await prisma.transaction.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return rows.filter((r) => !types || types.includes(r.type)).map((r) => [r.type, r.amount]);
}

const win = (winnerId: string | null, turnNumber = 10) =>
  ({ kind: "multiplayer", winnerId, reason: "test", turnNumber }) as const;

/** Open a match that started long enough ago to count. */
async function openPlayed(input: Omit<matches.OpenMatchInput, "roomId"> & { roomId?: string }, ageMs = 5 * 60_000) {
  const match = await matches.openMultiplayerMatch({ roomId: "T", ...input });
  await prisma.match.update({ where: { id: match.id }, data: { startedAt: new Date(Date.now() - ageMs) } });
  return match;
}

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

describe("table bets are off by default", () => {
  it("a bet table is opened without a bet and nobody is charged", async () => {
    const a = await createPlayer(100, { eligibleForBets: true });
    const b = await createPlayer(100, { eligibleForBets: true });
    const match = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 50, roomId: "OFF" });
    expect(match.betAmount).toBe(0);
    expect((await getBalances(a.id)).coins).toBe(100);
    expect(await txTypes(a.id)).toEqual([]);
  });
});

describe("table bets (when re-enabled)", () => {
  beforeEach(() => {
    ECONOMY.tableBets.enabled = true;
  });
  afterEach(() => {
    ECONOMY.tableBets.enabled = false;
  });

  it("validates the bet server-side and caps it by title", async () => {
    for (const bad of [-1, 1.5, matches.MAX_BET + 1, Number.NaN]) {
      expect(() => matches.assertValidBet(bad)).toThrow();
    }
    expect(maxBetForTitle("novato")).toBe(20);
    expect(maxBetForTitle("domadragones")).toBe(200);
    expect(maxBetForTitle("superadmin")).toBe(1000);
    expect(maxBetForTitle("made-up")).toBe(20);
  });

  it("requires a verified email and enough online games from both players", async () => {
    const fresh = await createPlayer(100);
    await prisma.user.update({ where: { id: fresh.id }, data: { emailVerified: false } });
    expect(await matches.betIneligibilityReason(fresh.id)).toMatch(/verificar tu email/);
    await prisma.user.update({ where: { id: fresh.id }, data: { emailVerified: true } });
    expect(await matches.betIneligibilityReason(fresh.id)).toMatch(/20 partidas online/);

    const vet = await createPlayer(100, { eligibleForBets: true });
    expect(await matches.betIneligibilityReason(vet.id)).toBeNull();
    // A pair with an ineligible player plays without a bet
    const m = await matches.openMultiplayerMatch({ player1Id: vet.id, player2Id: fresh.id, mode: "normal", betAmount: 20, roomId: "E1" });
    expect(m.betAmount).toBe(0);
    expect((await getBalances(vet.id)).coins).toBe(100);
  });

  it("at most 3 bet tables per day against the same opponent", async () => {
    const a = await createPlayer(1000, { eligibleForBets: true });
    const b = await createPlayer(1000, { eligibleForBets: true });
    const bets: number[] = [];
    for (let i = 0; i < ECONOMY.tableBets.maxBetsPerDayPerOpponent + 1; i++) {
      const m = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 10, roomId: `L${i}` });
      bets.push(m.betAmount);
      await matches.settleMatch(m.id, win(null));
    }
    expect(bets).toEqual([10, 10, 10, 0]);
  });

  it("escrows both stakes when the game starts and pays the pot to the winner exactly once", async () => {
    const a = await createPlayer(100, { eligibleForBets: true });
    const b = await createPlayer(100, { eligibleForBets: true });
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 40 });

    expect((await getBalances(a.id)).coins).toBe(60);
    expect((await getBalances(b.id)).coins).toBe(60);

    // Several end events at once (game over + forfeit timer + kick...): one settlement
    const { fulfilled, rejected } = await race(5, () => matches.settleMatch(id, win(a.id)));
    expect(rejected).toHaveLength(0);
    expect(fulfilled.filter((r) => r.value !== null)).toHaveLength(1);
    expect(await matches.settleMatch(id, win(b.id))).toBeNull();

    expect(await txTypes(a.id, ["bet_stake", "bet_win", "bet_refund"])).toEqual([["bet_stake", -40], ["bet_win", 80]]);
    expect(await txTypes(b.id, ["bet_stake", "bet_win", "bet_refund"])).toEqual([["bet_stake", -40]]);
    const pa = await profile(a.id);
    const pb = await profile(b.id);
    expect(pa.coins).toBe(140 + ONLINE.win + WIN_MISSION);
    expect(pb.coins).toBe(60 + ONLINE.loss);
    expect(pa.stats).toMatchObject({ normalWins: 11, normalLosses: 10, currentStreak: 1 });
    expect(pb.stats).toMatchObject({ normalWins: 10, normalLosses: 11 });

    const row = await prisma.match.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "finished", winnerId: a.id, betAmount: 40, counted: true, player1Xp: 100, player2Xp: 40 });
    expect(row.settledAt).not.toBeNull();
  });

  it("a game that ends before turn 3 refunds the bet instead of paying it", async () => {
    const a = await createPlayer(50, { eligibleForBets: true });
    const b = await createPlayer(50, { eligibleForBets: true });
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 50 });
    const result = await matches.settleMatch(id, win(a.id, 0));
    expect(result?.counted).toBe(false);
    expect((await getBalances(a.id)).coins).toBe(50);
    expect((await getBalances(b.id)).coins).toBe(50);
    expect(await txTypes(b.id)).toEqual([["bet_stake", -50], ["bet_refund", 50]]);
  });

  it("charges nobody when a player can't cover the bet", async () => {
    const rich = await createPlayer(100, { eligibleForBets: true });
    const poor = await createPlayer(10, { eligibleForBets: true });
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
    const a = await createPlayer(50, { eligibleForBets: true });
    const b = await createPlayer(50, { eligibleForBets: true });
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 50 });
    expect((await getBalances(a.id)).coins).toBe(0);

    const result = await matches.settleMatch(id, win(null));
    expect(result?.players.map((p) => p.outcome)).toEqual(["none", "none"]);

    const pa = await profile(a.id);
    const pb = await profile(b.id);
    expect([pa.coins, pb.coins]).toEqual([50, 50]);
    expect(pa.stats).toMatchObject({ normalWins: 10, normalLosses: 10 });
    expect([pa.experience, pb.experience]).toEqual([0, 0]);
    expect(await txTypes(b.id)).toEqual([["bet_stake", -50], ["bet_refund", 50]]);
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).status).toBe("abandoned");
  });

  it("refunds matches left unsettled by a restart", async () => {
    const a = await createPlayer(30, { eligibleForBets: true });
    const b = await createPlayer(30, { eligibleForBets: true });
    const { id } = await matches.openMultiplayerMatch({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 30, roomId: "T4" });

    expect(await matches.refundUnsettledMatches()).toBeGreaterThanOrEqual(1);
    expect((await getBalances(a.id)).coins).toBe(30);
    expect((await getBalances(b.id)).coins).toBe(30);
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).settledAt).not.toBeNull();
  });

  it("friendly tables take no bet, record no stats and give no XP or coins", async () => {
    const a = await createPlayer(100, { eligibleForBets: true });
    const b = await createPlayer(100, { eligibleForBets: true });
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "friendly", betAmount: 50 });
    expect((await getBalances(a.id)).coins).toBe(100);
    const result = await matches.settleMatch(id, win(a.id));
    expect(result?.counted).toBe(false);
    const pa = await profile(a.id);
    expect(pa.coins).toBe(100);
    expect(pa.stats).toMatchObject({ normalWins: 10 });
    expect(pa.experience).toBe(0);
  });

  it("ignores a winner that isn't one of the players", async () => {
    const a = await createPlayer(20, { eligibleForBets: true });
    const b = await createPlayer(20, { eligibleForBets: true });
    const outsider = await createPlayer(0);
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 20 });
    await matches.settleMatch(id, win(outsider.id));
    expect((await getBalances(outsider.id)).coins).toBe(0);
    expect((await getBalances(a.id)).coins).toBe(20);
    expect((await getBalances(b.id)).coins).toBe(20);
  });
});

describe("counted games (anti-farming) and match rewards", () => {
  it("a counted online game gives stats, XP, match coins and mission progress", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0 });
    const res = await matches.settleMatch(id, win(a.id));
    expect(res?.counted).toBe(true);
    expect(res?.players[0]).toMatchObject({ outcome: "win", rewardCoins: ONLINE.win, xpGained: XP_REWARDS.normal.win });
    expect(res?.players[0].missionsCompleted.map((m) => m.missionId)).toEqual(["win_game"]);
    expect(res?.players[1]).toMatchObject({ outcome: "loss", rewardCoins: ONLINE.loss, missionsCompleted: [] });
    expect(await txTypes(a.id)).toEqual([["match_reward", ONLINE.win], ["mission_reward", WIN_MISSION]]);
    expect(await txTypes(b.id)).toEqual([["match_reward", ONLINE.loss]]);
    expect((await profile(a.id)).stats).toMatchObject({ normalWins: 1 });
    expect(await prisma.match.findUniqueOrThrow({ where: { id } })).toMatchObject({ player1Coins: ONLINE.win, player2Coins: ONLINE.loss, counted: true });
  });

  it("an account without a verified email gets stats and XP but no match coins or missions", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    await prisma.user.update({ where: { id: a.id }, data: { emailVerified: false } });
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0 });
    const res = await matches.settleMatch(id, win(a.id));
    expect(res?.counted).toBe(true);
    expect(res?.players[0]).toMatchObject({ outcome: "win", rewardCoins: 0, missionsCompleted: [], xpGained: XP_REWARDS.normal.win, emailVerified: false });
    expect(res?.players[1]).toMatchObject({ outcome: "loss", rewardCoins: ONLINE.loss, emailVerified: true });
    expect(await txTypes(a.id)).toEqual([]);
    expect(await prisma.userMission.count({ where: { userId: a.id } })).toBe(0);
    expect((await profile(a.id)).stats).toMatchObject({ normalWins: 1 });

    // Same for a single-player game
    const { matchId } = await matches.startAiMatch(a.id, "standard", new Date(Date.now() - 10 * 60_000));
    const ai = await matches.finishAiMatch(a.id, matchId, true, 5);
    expect(ai).toMatchObject({ counted: true, rewardCoins: 0, missionsCompleted: [], emailVerified: false });
    expect(ai.xpGained).toBeGreaterThan(0);
  });

  it("a surrender in the mulligan (turn 0) counts for nobody", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0 });
    const res = await matches.settleMatch(id, win(b.id, 0));
    expect(res?.counted).toBe(false);
    expect(res?.players.map((p) => [p.outcome, p.rewardCoins, p.xpGained])).toEqual([["loss", 0, 0], ["win", 0, 0]]);
    expect((await profile(b.id)).stats).toMatchObject({ normalWins: 0, normalLosses: 0, currentStreak: 0 });
    expect((await profile(a.id)).stats).toMatchObject({ normalWins: 0, normalLosses: 0 });
    expect(await txTypes(b.id)).toEqual([]);
  });

  it("a game shorter than 2 minutes doesn't count, even past turn 3", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0 }, 60_000);
    const res = await matches.settleMatch(id, win(a.id, 12));
    expect(res?.counted).toBe(false);
    expect((await profile(a.id)).stats).toMatchObject({ normalWins: 0 });
  });

  it("only 3 wins per day against the same opponent count", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const c = await createPlayer();
    const counted: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const { id } = await openPlayed({ player1Id: i % 2 ? a.id : b.id, player2Id: i % 2 ? b.id : a.id, mode: "normal", betAmount: 0 });
      counted.push((await matches.settleMatch(id, win(a.id)))!.counted);
    }
    expect(counted).toEqual([true, true, true, false]);
    expect((await profile(a.id)).stats).toMatchObject({ normalWins: 3 });
    expect((await profile(b.id)).stats).toMatchObject({ normalLosses: 3 });

    // Another opponent still counts, and b beating a still counts for b
    const vsC = await openPlayed({ player1Id: a.id, player2Id: c.id, mode: "normal", betAmount: 0 });
    expect((await matches.settleMatch(vsC.id, win(a.id)))!.counted).toBe(true);
    const bWins = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "normal", betAmount: 0 });
    expect((await matches.settleMatch(bWins.id, win(b.id)))!.counted).toBe(true);
  });

  it("match coins stop at the daily cap", async () => {
    const a = await createPlayer();
    const opponents = await Promise.all([1, 2, 3, 4].map(() => createPlayer()));
    const rewards: number[] = [];
    for (const o of opponents) {
      const { id } = await openPlayed({ player1Id: a.id, player2Id: o.id, mode: "normal", betAmount: 0 });
      const res = await matches.settleMatch(id, win(a.id));
      rewards.push(res!.players[0].rewardCoins);
    }
    expect(rewards).toEqual([25, 25, 25, 0]);
    expect(rewards.reduce((n, r) => n + r, 0)).toBe(ECONOMY.matchCoins.dailyCap);
    // Missions: 1 win (50) + 2 games (50); the weekly mission isn't reached
    const missionRows = await txTypes(a.id, ["mission_reward"]);
    expect(missionRows).toEqual([["mission_reward", WIN_MISSION], ["mission_reward", PLAY_MISSION]]);
  });

  it("draft matches give draft XP and stats", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const { id } = await openPlayed({ player1Id: a.id, player2Id: b.id, mode: "draft", betAmount: 0 });
    await matches.settleMatch(id, win(b.id));
    const pa = await profile(a.id);
    const pb = await profile(b.id);
    expect([pa.experience, pb.experience]).toEqual([XP_REWARDS.draft.loss, XP_REWARDS.draft.win]);
    expect(pb.stats).toMatchObject({ draftWins: 1 });
    expect(pa.stats).toMatchObject({ draftLosses: 1 });
  });

  it("levels up and respects the daily XP cap", async () => {
    const a = await createPlayer();
    const opponents = await Promise.all([1, 2, 3].map(() => createPlayer()));
    await prisma.user.update({ where: { id: a.id }, data: { level: 1, experience: 950 } });

    const first = await openPlayed({ player1Id: a.id, player2Id: opponents[0].id, mode: "normal", betAmount: 0 });
    const res = await matches.settleMatch(first.id, win(a.id));
    expect(res?.players[0]).toMatchObject({ userId: a.id, xpGained: 100, level: 2, experience: 50, levelsGained: 1 });

    // Pretend a already earned almost the whole cap today
    await prisma.match.create({
      data: { mode: "normal", status: "finished", player1Id: a.id, player1Xp: DAILY_XP_CAP - 100 - 30, settledAt: new Date() },
    });
    const second = await openPlayed({ player1Id: a.id, player2Id: opponents[1].id, mode: "normal", betAmount: 0 });
    const capped = await matches.settleMatch(second.id, win(a.id));
    expect(capped?.players[0]).toMatchObject({ xpGained: 30, xpCapped: true });

    const third = await openPlayed({ player1Id: a.id, player2Id: opponents[2].id, mode: "normal", betAmount: 0 });
    const none = await matches.settleMatch(third.id, win(a.id));
    expect(none?.players[0]).toMatchObject({ xpGained: 0, xpCapped: true });
    // the opponent isn't affected by a's cap
    expect(none?.players[1]).toMatchObject({ xpGained: XP_REWARDS.normal.loss });
  });
});

describe("single player vs AI (client-reported, bounded)", () => {
  async function startedAgo(userId: string, ms: number) {
    const { matchId } = await matches.startAiMatch(userId);
    await prisma.match.update({ where: { id: matchId }, data: { startedAt: new Date(Date.now() - ms) } });
    return matchId;
  }
  const LONG = matches.AI_MIN_DURATION_MS + 1000;

  it("a finished game counts once (XP, coins, missions); reporting it again is rejected", async () => {
    const u = await createPlayer();
    const matchId = await startedAgo(u.id, LONG);
    const res = await matches.finishAiMatch(u.id, matchId, true, 8);
    expect(res).toMatchObject({ counted: true, xpGained: XP_REWARDS.ai.win, level: 1, experience: XP_REWARDS.ai.win, rewardCoins: AI.win });
    expect(res.missionsCompleted.map((m) => m.missionId)).toEqual(["win_game"]);
    expect(res.coins).toBe(AI.win + WIN_MISSION);
    await expect(matches.finishAiMatch(u.id, matchId, true, 8)).rejects.toMatchObject({ statusCode: 409 });
    // No stats from single player
    expect((await profile(u.id)).stats).toMatchObject({ normalWins: 0, normalLosses: 0 });
  });

  it("a game shorter than the minimum or before turn 3 is recorded without rewards", async () => {
    const u = await createPlayer();
    const { matchId } = await matches.startAiMatch(u.id);
    const res = await matches.finishAiMatch(u.id, matchId, true, 8);
    expect(res).toMatchObject({ counted: false, xpGained: 0, rewardCoins: 0 });
    await expect(matches.finishAiMatch(u.id, matchId, true, 8)).rejects.toMatchObject({ statusCode: 409 });

    const early = await startedAgo(u.id, LONG);
    expect(await matches.finishAiMatch(u.id, early, true, 2)).toMatchObject({ counted: false, rewardCoins: 0 });
    expect((await getBalances(u.id)).coins).toBe(0);
  });

  it("only the first games of the day count", async () => {
    const u = await createPlayer();
    for (let i = 0; i < matches.AI_DAILY_REWARDED_GAMES; i++) {
      const id = await startedAgo(u.id, LONG);
      expect((await matches.finishAiMatch(u.id, id, false, 5)).xpGained).toBe(XP_REWARDS.ai.loss);
    }
    const extra = await startedAgo(u.id, LONG);
    expect(await matches.finishAiMatch(u.id, extra, true, 5)).toMatchObject({ counted: false, xpGained: 0, rewardCoins: 0 });
    expect((await profile(u.id)).experience).toBe(XP_REWARDS.ai.loss * matches.AI_DAILY_REWARDED_GAMES);
  });

  it("someone else's match or an abandoned start can't be finished", async () => {
    const u = await createPlayer();
    const other = await createPlayer();
    const mine = await startedAgo(u.id, LONG);
    await expect(matches.finishAiMatch(other.id, mine, true, 5)).rejects.toMatchObject({ statusCode: 404 });

    // Starting a new game drops the unfinished one
    await matches.startAiMatch(u.id);
    await expect(matches.finishAiMatch(u.id, mine, true, 5)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("HTTP: rewards are decided by the server; bad bodies are rejected", async () => {
    const u = await createPlayer();
    const token = tokenFor(u);
    const app = await startHttpApp((a) => a.use("/api", matchesRouter));
    try {
      expect((await app.request("POST", "/api/matches/ai")).status).toBe(401);
      const start = await app.request("POST", "/api/matches/ai", { token });
      expect(start.status).toBe(200);
      const { matchId } = start.body;

      expect((await app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "win", turnNumber: 5 } })).status).toBe(422);
      expect((await app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "victory" } })).status).toBe(422);
      expect((await app.request("POST", `/api/matches/ai/${matchId}/finish`, { token, body: { result: "victory", turnNumber: -1 } })).status).toBe(422);
      expect((await app.request("POST", "/api/matches/ai/not-a-uuid/finish", { token, body: { result: "victory", turnNumber: 5 } })).status).toBe(404);

      await prisma.match.update({ where: { id: matchId }, data: { startedAt: new Date(Date.now() - LONG) } });
      const done = await app.request("POST", `/api/matches/ai/${matchId}/finish`, {
        token,
        body: { result: "victory", turnNumber: 6, xp: 999_999, xpGained: 999_999, rewardCoins: 999_999 },
      });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ xpGained: XP_REWARDS.ai.win, rewardCoins: AI.win });
      expect((await profile(u.id)).experience).toBe(XP_REWARDS.ai.win);
    } finally {
      await app.close();
    }
  });
});
