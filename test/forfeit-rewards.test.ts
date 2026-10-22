/**
 * Forfeits and short games, and the per-opponent daily coin cap (ECONOMY.antiFarming):
 * - no minimum turn or duration (owner, 2026-10-22): a game counts for stats, XP, match coins and
 *   missions however short it was — a turn-0 surrender, a disconnect, a first-turn Knock Out — for
 *   both players, whoever forfeited it (the old "early forfeit" rule, established forfeiter and 3
 *   paid forfeit wins a day, is gone). Kept: the winner's 3 counted wins per opponent per economy
 *   day and friendly tables counting for nobody. Old early-forfeit losses (`matches.earlyForfeit`)
 *   stay out of countedOnlineGames;
 * - a player wins at most 200 coins per economy day from the same opponent (match coins of wins +
 *   net bet winnings); the cut part of a pot goes back to the loser.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import * as matches from "../src/modules/matches/matches.service.js";
import { XP_REWARDS } from "../src/modules/users/xp.service.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

type Any = Record<string, any>;

const ONLINE = ECONOMY.matchCoins.online;
const RULES = ECONOMY.antiFarming;
const PAIR_NOTE = "Tope diario contra este rival alcanzado";

let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  server = await startSocketServer();
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

/** A player with a stats row; `games` counted online games (half wins), `streak` current streak. */
async function createPlayer(options: { coins?: number; games?: number; verified?: boolean; streak?: number } = {}) {
  const user = await createUser({ coins: options.coins ?? 0 }, { emailVerified: options.verified ?? true });
  const games = options.games ?? 0;
  await prisma.userStats.create({
    data: {
      userId: user.id,
      normalWins: Math.ceil(games / 2),
      normalLosses: Math.floor(games / 2),
      currentStreak: options.streak ?? 0,
      bestStreak: options.streak ?? 0,
    },
  });
  return user;
}

/** Eligible for Lucky Duel bets (verified email, 20 counted online games). */
const bettor = (coins: number) => createPlayer({ coins, games: ECONOMY.tableBets.minOnlineGames });

async function open(
  player1Id: string,
  player2Id: string,
  options: { ageMs?: number; betAmount?: number; gameMode?: matches.GameModeMarker; mode?: matches.MultiplayerMode; at?: Date } = {},
) {
  const at = options.at ?? new Date();
  const match = await matches.openMultiplayerMatch(
    { player1Id, player2Id, mode: options.mode ?? "normal", betAmount: options.betAmount ?? 0, roomId: "F", gameMode: options.gameMode },
    at,
  );
  await prisma.match.update({ where: { id: match.id }, data: { startedAt: new Date(at.getTime() - (options.ageMs ?? 5 * 60_000)) } });
  return match;
}

/** The loser gave the game up (surrender, leave, disconnect…) on `turnNumber`. */
const surrender = (winnerId: string, turnNumber = 0) => ({ kind: "multiplayer", winnerId, reason: "rendición", turnNumber }) as const;
const played = (winnerId: string, turnNumber = 10) => ({ kind: "multiplayer", winnerId, reason: "test", turnNumber }) as const;

const stats = (userId: string) => prisma.userStats.findUniqueOrThrow({ where: { userId } });
const txs = (userId: string, types?: string[]) =>
  prisma.transaction
    .findMany({ where: { userId, ...(types ? { type: { in: types } } : {}) }, orderBy: { createdAt: "asc" } })
    .then((rows) => rows.map((r) => ({ type: r.type, amount: r.amount, description: r.description })));
const player = (res: matches.SettlementResult | null, userId: string) => res!.players.find((p) => p.userId === userId)!;

/** Set a config number for one test. */
function override<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
  const real = obj[key];
  obj[key] = value;
  onTestFinished(() => {
    obj[key] = real;
  });
}

describe("forfeits and short games count (no minimum turn or duration)", () => {
  it("a turn-0 surrender 20 seconds in is a full counted game for both: win rewards, loss rewards, stats", async () => {
    const winner = await createPlayer();
    const forfeiter = await createPlayer({ streak: 4 });
    const { id } = await open(winner.id, forfeiter.id, { ageMs: 20_000 });
    const res = await matches.settleMatch(id, surrender(winner.id));

    expect(res).toMatchObject({ counted: true, winnerId: winner.id });
    expect(res).not.toHaveProperty("earlyForfeit");
    expect(player(res, winner.id)).toMatchObject({ outcome: "win", counted: true, rewardCoins: ONLINE.win, xpGained: XP_REWARDS.normal.win });
    expect(player(res, winner.id)).not.toHaveProperty("earlyForfeit");
    expect(player(res, winner.id)).not.toHaveProperty("forfeitBlockedBy");
    expect(player(res, winner.id).missionsCompleted.map((m) => m.missionId)).toEqual(["win_game"]);
    expect(player(res, forfeiter.id)).toMatchObject({ outcome: "loss", counted: true, rewardCoins: ONLINE.loss, xpGained: XP_REWARDS.normal.loss });

    expect(await stats(winner.id)).toMatchObject({ normalWins: 1, currentStreak: 1 });
    expect(await stats(forfeiter.id)).toMatchObject({ normalLosses: 1, currentStreak: 0, bestStreak: 4 });
    expect((await txs(forfeiter.id, ["match_reward"])).map((r) => r.amount)).toEqual([ONLINE.loss]);
    expect(await prisma.userMission.count({ where: { userId: forfeiter.id } })).toBeGreaterThan(0);
    expect(await prisma.match.findUniqueOrThrow({ where: { id } })).toMatchObject({
      counted: true,
      earlyForfeit: false,
      winnerId: winner.id,
      player1Coins: ONLINE.win,
      player2Coins: ONLINE.loss,
      player1Xp: XP_REWARDS.normal.win,
      player2Xp: XP_REWARDS.normal.loss,
    });
    // The loss counts toward countedOnlineGames like any other game
    expect(await matches.countedOnlineGames(prisma, forfeiter.id)).toBe(1);
  });

  it("a new or unverified forfeiter: the win counts all the same (an unverified loser gets XP, no coins)", async () => {
    const winner = await createPlayer();
    const newbie = await createPlayer({ games: 2 });
    const unverified = await createPlayer({ verified: false });

    const vsNewbie = await open(newbie.id, winner.id);
    const r1 = await matches.settleMatch(vsNewbie.id, surrender(winner.id, 2));
    expect(r1).toMatchObject({ counted: true });
    expect(player(r1, winner.id)).toMatchObject({ outcome: "win", counted: true, rewardCoins: ONLINE.win, xpGained: XP_REWARDS.normal.win });
    expect(player(r1, newbie.id)).toMatchObject({ outcome: "loss", rewardCoins: ONLINE.loss, xpGained: XP_REWARDS.normal.loss });
    expect(await matches.countedOnlineGames(prisma, newbie.id)).toBe(3);

    const vsUnverified = await open(unverified.id, winner.id);
    const r2 = await matches.settleMatch(vsUnverified.id, surrender(winner.id));
    expect(player(r2, winner.id)).toMatchObject({ counted: true, rewardCoins: ONLINE.win });
    expect(player(r2, unverified.id)).toMatchObject({ outcome: "loss", rewardCoins: 0, xpGained: XP_REWARDS.normal.loss, missionsCompleted: [] });
    expect(await txs(unverified.id)).toEqual([]);

    expect(await stats(winner.id)).toMatchObject({ normalWins: 2, currentStreak: 2 });
    expect(await stats(unverified.id)).toMatchObject({ normalLosses: 1 });
  });

  it("no daily limit on forfeit wins: 4 turn-0 surrenders by 4 opponents all count", async () => {
    const winner = await createPlayer();
    const opponents = await Promise.all([1, 2, 3, 4].map(() => createPlayer()));
    const results: [boolean, number][] = [];
    for (const o of opponents) {
      const { id } = await open(o.id, winner.id, { ageMs: 30_000 });
      const p = player(await matches.settleMatch(id, surrender(winner.id)), winner.id);
      results.push([p.counted, p.rewardCoins]);
    }
    expect(results).toEqual(opponents.map(() => [true, ONLINE.win]));
    expect(await stats(winner.id)).toMatchObject({ normalWins: 4 });
    for (const o of opponents) expect(await stats(o.id)).toMatchObject({ normalLosses: 1 });
  });

  it("the per-opponent counted-wins cap still stops a 4th win against the same opponent, short or not", async () => {
    expect(RULES.maxCountedWinsPerOpponentPerDay).toBe(3);
    const winner = await createPlayer();
    const loser = await createPlayer();
    const counted: boolean[] = [];
    for (const input of [played(winner.id), surrender(winner.id), played(winner.id, 1), surrender(winner.id)]) {
      const { id } = await open(winner.id, loser.id, { ageMs: 10_000 });
      counted.push(player(await matches.settleMatch(id, input), winner.id).counted);
    }
    expect(counted).toEqual([true, true, true, false]);
    // The 4th counts for nobody: no stats, coins or XP for either player
    expect(await stats(winner.id)).toMatchObject({ normalWins: 3 });
    expect(await stats(loser.id)).toMatchObject({ normalLosses: 3 });
    const last = await prisma.match.findFirstOrThrow({ where: { winnerId: winner.id }, orderBy: { settledAt: "desc" } });
    expect(last).toMatchObject({ counted: false, earlyForfeit: false, player1Coins: 0, player2Coins: 0, player1Xp: 0, player2Xp: 0 });
  });

  it("a Knock Out on turn 1 a few seconds in counts; friendly tables still count for nobody", async () => {
    const a = await createPlayer();
    const b = await createPlayer();
    const ko = await open(a.id, b.id, { ageMs: 5_000 });
    const res = await matches.settleMatch(ko.id, played(a.id, 1));
    expect(res).toMatchObject({ counted: true });
    expect(player(res, a.id)).toMatchObject({ rewardCoins: ONLINE.win, xpGained: XP_REWARDS.normal.win });
    expect(player(res, b.id)).toMatchObject({ rewardCoins: ONLINE.loss, xpGained: XP_REWARDS.normal.loss });
    expect(await stats(a.id)).toMatchObject({ normalWins: 1 });
    expect(await stats(b.id)).toMatchObject({ normalLosses: 1 });

    // Friendly: nothing at all, however long it lasted
    for (const input of [surrender(a.id), played(a.id)]) {
      const friendly = await open(a.id, b.id, { mode: "friendly" });
      const r = await matches.settleMatch(friendly.id, input);
      expect(r).toMatchObject({ counted: false });
      expect(player(r, a.id)).toMatchObject({ rewardCoins: 0, xpGained: 0 });
      expect(player(r, b.id)).toMatchObject({ rewardCoins: 0, xpGained: 0 });
    }
    expect(await stats(a.id)).toMatchObject({ normalWins: 1 });
    expect(await stats(b.id)).toMatchObject({ normalLosses: 1 });
  });

  it("a draft forfeit on turn 1 counts for both", async () => {
    const winner = await createPlayer();
    const forfeiter = await createPlayer();
    const { id } = await open(winner.id, forfeiter.id, { mode: "draft", ageMs: 10_000 });
    const res = await matches.settleMatch(id, surrender(winner.id, 1));
    expect(player(res, winner.id)).toMatchObject({ counted: true, xpGained: XP_REWARDS.draft.win });
    expect(player(res, forfeiter.id)).toMatchObject({ counted: true, xpGained: XP_REWARDS.draft.loss });
    expect(await stats(winner.id)).toMatchObject({ draftWins: 1 });
    expect(await stats(forfeiter.id)).toMatchObject({ draftLosses: 1 });
  });

  it("old early-forfeit losses (matches.earlyForfeit) still stay out of countedOnlineGames", async () => {
    const winner = await createPlayer();
    const old = await createPlayer({ games: 4 }); // 2 wins, 2 losses
    const { id } = await open(winner.id, old.id);
    // A row settled under the old rule: the loss is in the stats, flagged as an early forfeit
    await prisma.match.update({ where: { id }, data: { status: "finished", winnerId: winner.id, earlyForfeit: true, settledAt: new Date() } });
    expect(await matches.countedOnlineGames(prisma, old.id)).toBe(3);
    // A new short loss is counted
    const fresh = await open(winner.id, old.id, { ageMs: 10_000 });
    await matches.settleMatch(fresh.id, surrender(winner.id));
    expect(await stats(old.id)).toMatchObject({ normalLosses: 3 });
    expect(await matches.countedOnlineGames(prisma, old.id)).toBe(4);
  });
});

describe("per-opponent daily coin cap", () => {
  it("match coins stop at the cap; XP, missions and stats still apply; the history says why", async () => {
    // 3 counted wins vs the same opponent pay 75 at most: lower the cap and raise the wins cap
    override(RULES, "maxCoinsFromOpponentPerDay", 60);
    override(RULES, "maxCountedWinsPerOpponentPerDay", 4);
    const a = await createPlayer();
    const b = await createPlayer();
    const rows: [number, Any | null][] = [];
    for (let i = 0; i < 4; i++) {
      const { id } = await open(i % 2 ? a.id : b.id, i % 2 ? b.id : a.id);
      const p = player(await matches.settleMatch(id, played(a.id)), a.id);
      rows.push([p.rewardCoins, p.pairCap]);
      expect(p.xpGained).toBe(XP_REWARDS.normal.win);
    }
    expect(rows).toEqual([
      [25, { limit: 60, coinsWonToday: 25, rewardCoinsCut: 0, betWinningsCut: 0, reached: false }],
      [25, { limit: 60, coinsWonToday: 50, rewardCoinsCut: 0, betWinningsCut: 0, reached: false }],
      [10, { limit: 60, coinsWonToday: 60, rewardCoinsCut: 15, betWinningsCut: 0, reached: true }],
      [0, { limit: 60, coinsWonToday: 60, rewardCoinsCut: 25, betWinningsCut: 0, reached: true }],
    ]);
    expect(await stats(a.id)).toMatchObject({ normalWins: 4 });
    const rewards = await txs(a.id, ["match_reward"]);
    expect(rewards.map((r) => r.amount)).toEqual([25, 25, 10, 0]);
    expect(rewards[2].description).toBe(`Victoria en partida online: +10 monedas (${PAIR_NOTE})`);
    expect(rewards[3].description).toBe(`Victoria en partida online: 0 monedas (${PAIR_NOTE})`);
    // The loser's own loss coins aren't touched by the winner's cap
    expect((await txs(b.id, ["match_reward"])).map((r) => r.amount)).toEqual([10, 10, 10, 10]);

    // Another opponent has its own cap; b beating a has its own too
    const c = await createPlayer();
    const vsC = await open(a.id, c.id);
    expect(player(await matches.settleMatch(vsC.id, played(a.id)), a.id)).toMatchObject({ rewardCoins: 25, pairCap: { coinsWonToday: 25 } });
    const bWins = await open(a.id, b.id);
    expect(player(await matches.settleMatch(bWins.id, played(b.id)), b.id)).toMatchObject({ rewardCoins: 25, pairCap: { coinsWonToday: 25 } });
  });

  it("a Lucky Duel pot past the cap: the winner gets the stake back plus what is left, the loser the rest", async () => {
    expect(RULES.maxCoinsFromOpponentPerDay).toBe(200);
    const a = await bettor(1000);
    const b = await bettor(1000);
    const bet = 100;

    // Game 1: pot 100 net + 25 match coins = 125 won from b
    const g1 = await open(a.id, b.id, { betAmount: bet, gameMode: "lucky-duel" });
    const r1 = await matches.settleMatch(g1.id, played(a.id));
    expect(player(r1, a.id)).toMatchObject({ coinsDelta: 100, rewardCoins: 25, pairCap: { coinsWonToday: 125, betWinningsCut: 0, rewardCoinsCut: 0, reached: false } });
    expect(player(r1, b.id)).toMatchObject({ coinsDelta: -100, betRefundedByPairCap: 0, pairCap: null });

    // Game 2: 75 left: 75 of the 100 winnings, no match coins; b gets 25 of their stake back
    const g2 = await open(b.id, a.id, { betAmount: bet, gameMode: "lucky-duel" });
    const r2 = await matches.settleMatch(g2.id, played(a.id));
    expect(player(r2, a.id)).toMatchObject({
      coinsDelta: 75,
      rewardCoins: 0,
      pairCap: { limit: 200, coinsWonToday: 200, betWinningsCut: 25, rewardCoinsCut: 25, reached: true },
    });
    expect(player(r2, b.id)).toMatchObject({ coinsDelta: -75, betRefundedByPairCap: 25, rewardCoins: ONLINE.loss });

    // Game 3: cap reached: the pot is refunded to both (stake back), still a counted win
    const g3 = await open(a.id, b.id, { betAmount: bet, gameMode: "lucky-duel" });
    const r3 = await matches.settleMatch(g3.id, played(a.id));
    expect(player(r3, a.id)).toMatchObject({ counted: true, coinsDelta: 0, rewardCoins: 0, pairCap: { coinsWonToday: 200, betWinningsCut: 100 } });
    expect(player(r3, b.id)).toMatchObject({ coinsDelta: 0, betRefundedByPairCap: 100 });

    const aBets = await txs(a.id, ["bet_stake", "bet_win", "bet_refund"]);
    expect(aBets.map((r) => [r.type, r.amount])).toEqual([
      ["bet_stake", -100],
      ["bet_win", 200],
      ["bet_stake", -100],
      ["bet_win", 175],
      ["bet_stake", -100],
      ["bet_refund", 100],
    ]);
    expect(aBets[3].description).toBe(`Apuesta ganada: 175 monedas (tu apuesta + 75 de ganancia; ${PAIR_NOTE})`);
    const bBets = await txs(b.id, ["bet_stake", "bet_win", "bet_refund"]);
    expect(bBets.map((r) => [r.type, r.amount])).toEqual([
      ["bet_stake", -100],
      ["bet_stake", -100],
      ["bet_refund", 25],
      ["bet_stake", -100],
      ["bet_refund", 100],
    ]);
    expect(bBets[2].description).toMatch(/^Apuesta devuelta en parte: 25 monedas/);
    // What a won from b today is exactly the cap: bet winnings + match coins
    const won = (await txs(a.id, ["bet_stake", "bet_win", "bet_refund", "match_reward"])).reduce((n, r) => n + r.amount, 0);
    expect(won).toBe(200);
  });

  it("the cap is per economy day (00:00 Argentina = 03:00 UTC)", async () => {
    override(RULES, "maxCoinsFromOpponentPerDay", 30);
    const a = await createPlayer();
    const b = await createPlayer();
    const lateNight = new Date("2026-03-10T02:58:00.000Z"); // 23:58 in Buenos Aires, March 9
    const nextDay = new Date("2026-03-10T03:02:00.000Z"); // 00:02 March 10
    const settleAt = async (at: Date) => {
      const { id } = await open(a.id, b.id, { at });
      return player(await matches.settleMatch(id, played(a.id), at), a.id);
    };
    expect((await settleAt(lateNight)).rewardCoins).toBe(25);
    expect((await settleAt(new Date(lateNight.getTime() + 60_000))).rewardCoins).toBe(5);
    const fresh = await settleAt(nextDay);
    expect(fresh).toMatchObject({ rewardCoins: 25, pairCap: { coinsWonToday: 25, reached: false } });
  });

  it("concurrent settlements of the same pair never pay past the cap", async () => {
    const a = await bettor(1000);
    const b = await bettor(1000);
    const games = [];
    for (let i = 0; i < ECONOMY.tableBets.maxBetsPerDayPerOpponent; i++) {
      games.push(await open(i % 2 ? a.id : b.id, i % 2 ? b.id : a.id, { betAmount: 100, gameMode: "lucky-duel" }));
    }
    const results = await Promise.allSettled(games.map((g) => matches.settleMatch(g.id, played(a.id))));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const rows = await prisma.match.findMany({ where: { id: { in: games.map((g) => g.id) } } });
    const pairCoins = rows.reduce((n, m) => n + (m.player1Id === a.id ? m.player1PairCoins : m.player2PairCoins), 0);
    expect(pairCoins).toBe(200);
    const won = (await txs(a.id, ["bet_stake", "bet_win", "bet_refund", "match_reward"])).reduce((n, r) => n + r.amount, 0);
    expect(won).toBe(200);
    // b's stakes minus refunds = exactly a's bet winnings (what a won minus a's match coins)
    const aMatchCoins = rows.reduce((n, m) => n + (m.player1Id === a.id ? m.player1Coins : m.player2Coins), 0);
    const bBets = (await txs(b.id, ["bet_stake", "bet_refund"])).reduce((n, r) => n + r.amount, 0);
    expect(bBets).toBe(-(200 - aMatchCoins));
  });

  it("vs-AI games are not affected", async () => {
    override(RULES, "maxCoinsFromOpponentPerDay", 0);
    const u = await createPlayer();
    const { matchId } = await matches.startAiMatch(u.id, "standard", new Date(Date.now() - 10 * 60_000));
    const res = await matches.finishAiMatch(u.id, matchId, true, 5);
    expect(res).toMatchObject({ counted: true, rewardCoins: ECONOMY.matchCoins.ai.win });
  });
});

// ---------------------------------------------------------------------------
// Socket: a turn-0 surrender is a counted game (matchSettled payload)
// ---------------------------------------------------------------------------

describe("matchSettled after a surrender", () => {
  const sockets: ClientSocket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  it("a surrender on turn 0 pays the winner a win and the loser a loss; no forfeit fields", async () => {
    const winner = await createPlayer();
    const forfeiter = await createPlayer({ streak: 2 });
    const s1 = await server.connect(tokenFor(winner));
    const s2 = await server.connect(tokenFor(forfeiter));
    sockets.push(s1, s2);
    // Lucky Duel tables need no deck; the surrender before the reveal is turn 0
    s1.emit("createRoom", { mode: "lucky-duel" });
    const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
    const started = Promise.all([nextEvent<Any>(s1, "gameStart"), nextEvent<Any>(s2, "gameStart")]);
    s2.emit("joinRoom", { roomId });
    await started;

    const settled = Promise.all([nextEvent<Any>(s1, "matchSettled", 8000), nextEvent<Any>(s2, "matchSettled", 8000)]);
    s2.emit("action", { roomId, action: { type: "surrender", payload: {} } });
    const [toWinner, toForfeiter] = await settled;
    expect(toWinner).toMatchObject({
      roomId,
      outcome: "win",
      counted: true,
      rewardCoins: ONLINE.win,
      xpGained: XP_REWARDS.normal.win,
      pairCap: { limit: 200, coinsWonToday: ONLINE.win, rewardCoinsCut: 0, betWinningsCut: 0, reached: false },
      betRefundedByPairCap: 0,
    });
    expect(toForfeiter).toMatchObject({
      outcome: "loss",
      counted: true,
      rewardCoins: ONLINE.loss,
      xpGained: XP_REWARDS.normal.loss,
      pairCap: null,
      betRefundedByPairCap: 0,
    });
    for (const payload of [toWinner, toForfeiter]) {
      expect(payload).not.toHaveProperty("earlyForfeit");
      expect(payload).not.toHaveProperty("forfeitBlockedBy");
    }
    expect(await stats(winner.id)).toMatchObject({ normalWins: 1, currentStreak: 1 });
    expect(await stats(forfeiter.id)).toMatchObject({ normalLosses: 1, currentStreak: 0 });
  });
});
