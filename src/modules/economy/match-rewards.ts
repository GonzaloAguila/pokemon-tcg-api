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
}

/**
 * Credit the coins of one counted game (online win 25 / loss 10, AI 10 / 5), up to the daily
 * cap. The caller records `amount` on the match row in the same transaction.
 */
export async function grantMatchCoins(
  tx: Db,
  userId: string,
  kind: "online" | "ai",
  outcome: "win" | "loss",
  matchId: string,
  now = new Date(),
): Promise<MatchCoinGrant> {
  const wanted = ECONOMY.matchCoins[kind][outcome];
  if (wanted <= 0) return { amount: 0, capped: false };
  const earned = await matchCoinsEarnedToday(tx, userId, now, matchId);
  const amount = Math.max(0, Math.min(wanted, ECONOMY.matchCoins.dailyCap - earned));
  if (amount > 0) {
    const label = kind === "ai" ? "partida contra la IA" : "partida online";
    const result = outcome === "win" ? "Victoria" : "Derrota";
    await creditBalance(userId, "coins", amount, "match_reward", `${result} en ${label}: +${amount} monedas`, tx);
  }
  return { amount, capped: amount < wanted };
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
