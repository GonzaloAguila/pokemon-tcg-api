/**
 * Match rewards and anti-farming rules used by the match settlement (modules/matches).
 * The caller holds the players' row locks (lockUsers), so the daily cap / per-opponent counts
 * computed from settled `matches` rows can't race.
 */

import { creditBalance, type Db } from "../users/users.service.js";
import { ECONOMY } from "./config.js";
import { startOfEconomyDay } from "./economy-time.js";

/** Match coins already credited to `userId` by matches settled this economy day. */
export async function matchCoinsEarnedToday(db: Db, userId: string, now = new Date(), excludeMatchId?: string): Promise<number> {
  const since = startOfEconomyDay(now);
  const notThis = excludeMatchId ? { id: { not: excludeMatchId } } : {};
  const [asP1, asP2] = await Promise.all([
    db.match.aggregate({ where: { ...notThis, player1Id: userId, settledAt: { gte: since } }, _sum: { player1Coins: true } }),
    db.match.aggregate({ where: { ...notThis, player2Id: userId, settledAt: { gte: since } }, _sum: { player2Coins: true } }),
  ]);
  return (asP1._sum.player1Coins ?? 0) + (asP2._sum.player2Coins ?? 0);
}

export interface MatchCoinGrant {
  amount: number;
  /** True when the daily cap cut the reward down. */
  capped: boolean;
  /** Coins the per-opponent daily cap (ECONOMY.antiFarming.maxCoinsFromOpponentPerDay) cut off. */
  pairCut: number;
}

/** Transaction description suffix when the per-opponent daily cap cut a payout. */
export const PAIR_CAP_NOTE = "Tope diario contra este rival alcanzado";

/**
 * Credit the coins of one counted game (online win 25 / loss 10, AI 10 / 5), up to the daily
 * cap and, for an online win, up to `pairRemaining` (what the per-opponent daily cap still
 * allows). The caller records `amount` on the match row in the same transaction. A win the
 * per-opponent cap cuts to 0 leaves a 0-coin transaction saying so (the player's history).
 */
export async function grantMatchCoins(
  tx: Db,
  userId: string,
  kind: "online" | "ai",
  outcome: "win" | "loss",
  matchId: string,
  now = new Date(),
  pairRemaining = Number.POSITIVE_INFINITY,
): Promise<MatchCoinGrant> {
  const wanted = ECONOMY.matchCoins[kind][outcome];
  if (wanted <= 0) return { amount: 0, capped: false, pairCut: 0 };
  const earned = await matchCoinsEarnedToday(tx, userId, now, matchId);
  const afterDailyCap = Math.max(0, Math.min(wanted, ECONOMY.matchCoins.dailyCap - earned));
  const amount = Math.max(0, Math.min(afterDailyCap, pairRemaining));
  const pairCut = afterDailyCap - amount;
  const label = kind === "ai" ? "partida contra la IA" : "partida online";
  const result = outcome === "win" ? "Victoria" : "Derrota";
  const note = pairCut > 0 ? ` (${PAIR_CAP_NOTE})` : "";
  if (amount > 0) {
    await creditBalance(userId, "coins", amount, "match_reward", `${result} en ${label}: +${amount} monedas${note}`, tx);
  } else if (pairCut > 0) {
    await recordCoinNote(tx, userId, "match_reward", `${result} en ${label}: 0 monedas${note}`);
  }
  return { amount, capped: afterDailyCap < wanted, pairCut };
}

/**
 * Coins `userId` already won from `opponentId` in matches settled this economy day (other than
 * `excludeMatchId`): the matches' player1PairCoins / player2PairCoins (match coins of wins + net
 * bet winnings). The caller holds both players' row locks, so concurrent settlements of the pair
 * can't both read the same total.
 */
export async function coinsWonFromOpponentToday(
  db: Db,
  userId: string,
  opponentId: string,
  excludeMatchId: string,
  now = new Date(),
): Promise<number> {
  const since = startOfEconomyDay(now);
  const notThis = { id: { not: excludeMatchId }, settledAt: { gte: since } };
  const [asP1, asP2] = await Promise.all([
    db.match.aggregate({ where: { ...notThis, player1Id: userId, player2Id: opponentId }, _sum: { player1PairCoins: true } }),
    db.match.aggregate({ where: { ...notThis, player1Id: opponentId, player2Id: userId }, _sum: { player2PairCoins: true } }),
  ]);
  return (asP1._sum.player1PairCoins ?? 0) + (asP2._sum.player2PairCoins ?? 0);
}

/** A 0-coin line in the player's coin history (a payout a cap cut to nothing), at the current balance. */
async function recordCoinNote(tx: Db, userId: string, type: string, description: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
  if (!user) return;
  await tx.transaction.create({ data: { userId, type, description, currency: "coins", amount: 0, balanceAfter: user.coins } });
}

/** Counted wins of `winnerId` against `loserId` settled this economy day (other matches). */
export async function countedWinsAgainstToday(
  db: Db,
  winnerId: string,
  loserId: string,
  excludeMatchId: string,
  now = new Date(),
): Promise<number> {
  return db.match.count({
    where: {
      id: { not: excludeMatchId },
      counted: true,
      winnerId,
      settledAt: { gte: startOfEconomyDay(now) },
      OR: [
        { player1Id: winnerId, player2Id: loserId },
        { player1Id: loserId, player2Id: winnerId },
      ],
    },
  });
}
