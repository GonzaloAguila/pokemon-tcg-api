/**
 * First-victory rewards of a leader's version (docs/gym-leaders.md): the medal, a coin and a card
 * back cosmetic and coins, granted once per user and version, all in one transaction.
 *
 * "First victory" is marked by the version's first owned-once reward: its medal when it has one
 * (normal: `boulder`), else its card back (expert: `cardback-brock-expert`), else its coin. The
 * marker row is inserted with ON CONFLICT DO NOTHING: only the call that created it grants the
 * rest (concurrent victories: exactly one). A later victory grants nothing (null).
 */
import { prisma } from "../../lib/prisma.js";
import { creditBalance, type Db } from "../users/users.service.js";
import type { GymLeaderDef, GymMode, GymRewards } from "./content/types.js";
import { leaderRewards, versionLabel } from "./content/index.js";

/** What was granted now (contract GrantedGymRewards: items the user already had are null). */
export type GrantedGymRewards = GymRewards;

/** Transaction log type of the coins. */
export const GYM_REWARD_TRANSACTION = "gym_reward";

async function grantMedalRow(tx: Db, userId: string, medalId: string): Promise<boolean> {
  return (await tx.userMedal.createMany({ data: [{ userId, medalId }], skipDuplicates: true })).count === 1;
}

async function grantCardBack(tx: Db, userId: string, cardBackId: string): Promise<boolean> {
  return (await tx.userCardBack.createMany({ data: [{ userId, cardBackId }], skipDuplicates: true })).count === 1;
}

async function grantCoin(tx: Db, userId: string, coinId: string): Promise<boolean> {
  return (await tx.userCoin.createMany({ data: [{ userId, coinId }], skipDuplicates: true })).count === 1;
}

/** The version's rewards for this victory: everything on the first one, null after (or when the version gives nothing). */
export async function grantGymVictoryRewards(userId: string, leader: GymLeaderDef, mode: GymMode): Promise<GrantedGymRewards | null> {
  const rewards = leaderRewards(leader, mode);
  if (!rewards) return null;
  return prisma.$transaction(async (tx) => {
    const granted: GrantedGymRewards = { medalId: null, coins: 0, coinId: null, cardBackId: null };
    // The marker first: not created = not the first victory (nothing else is written)
    if (rewards.medalId) {
      if (!(await grantMedalRow(tx, userId, rewards.medalId))) return null;
      granted.medalId = rewards.medalId;
    } else if (rewards.cardBackId) {
      if (!(await grantCardBack(tx, userId, rewards.cardBackId))) return null;
      granted.cardBackId = rewards.cardBackId;
    } else if (rewards.coinId) {
      if (!(await grantCoin(tx, userId, rewards.coinId))) return null;
      granted.coinId = rewards.coinId;
    } else {
      // Without a marker a version can't tell a first victory: it gives nothing (content error)
      console.error(`[gym] ${leader.id} ${mode} has no medal, card back nor coin to mark a first victory`);
      return null;
    }
    // The rest (an item the user already had, e.g. from the backoffice, isn't granted again)
    if (rewards.cardBackId && !granted.cardBackId && (await grantCardBack(tx, userId, rewards.cardBackId))) granted.cardBackId = rewards.cardBackId;
    if (rewards.coinId && !granted.coinId && (await grantCoin(tx, userId, rewards.coinId))) granted.coinId = rewards.coinId;
    if (rewards.coins > 0) {
      await creditBalance(userId, "coins", rewards.coins, GYM_REWARD_TRANSACTION, `Victoria contra ${versionLabel(leader, mode)}: +${rewards.coins} monedas`, tx);
      granted.coins = rewards.coins;
    }
    return granted;
  });
}
