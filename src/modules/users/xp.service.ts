import type { Db } from "./users.service.js";
import { ECONOMY } from "../economy/config.js";
import { startOfEconomyDay } from "../economy/economy-time.js";

// ---------------------------------------------------------------------------
// Experience and levels
//
// `users.level` starts at 1 and `users.experience` is the progress inside the
// current level (it resets on level up). Reaching the next level from level L
// takes L * 1000 XP, the same formula the frontend shows
// (getExperienceToNextLevel in src/domain/profile/transformers.ts):
// level 1 → 2 needs 1.000 XP, 2 → 3 needs 2.000, ...
//
// XP is only granted by the server, at settlement of a match (see
// modules/matches/matches.service.ts). The amounts live here.
// ---------------------------------------------------------------------------

export const XP_PER_LEVEL_FACTOR = 1000;
export const MAX_LEVEL = 100;

/** XP per finished match, by mode and outcome. Draws / abandoned games give none. */
export const XP_REWARDS = {
  normal: { win: 100, loss: 40 },
  draft: { win: 150, loss: 60 },
  friendly: { win: 0, loss: 0 },
  ai: { win: 50, loss: 20 },
} as const;

/** Most XP a user can earn per economy day (00:00 Argentina) across all modes (anti-farming). */
export const DAILY_XP_CAP = 2000;

/**
 * A game must reach this turn number to count (each player had a turn), so instant surrenders
 * between two accounts can't farm anything. Same rule for stats, coins and missions
 * (ECONOMY.antiFarming, see modules/matches).
 */
export const MIN_TURN_FOR_XP = ECONOMY.antiFarming.minTurn;

export type XpMode = keyof typeof XP_REWARDS;

export function experienceToNextLevel(level: number): number {
  return level * XP_PER_LEVEL_FACTOR;
}

/** Pure level math: add `gained` XP to (level, experience) and roll over full levels. */
export function applyExperience(level: number, experience: number, gained: number) {
  let lvl = Math.max(1, Math.floor(level));
  let xp = Math.max(0, Math.floor(experience)) + Math.max(0, Math.floor(gained));
  while (lvl < MAX_LEVEL && xp >= experienceToNextLevel(lvl)) {
    xp -= experienceToNextLevel(lvl);
    lvl++;
  }
  if (lvl >= MAX_LEVEL) {
    lvl = MAX_LEVEL;
    xp = Math.min(xp, experienceToNextLevel(MAX_LEVEL) - 1);
  }
  return { level: lvl, experience: xp, levelsGained: lvl - Math.max(1, Math.floor(level)) };
}

/** Start of the current economy day (00:00 Argentina); the daily XP cap resets then. */
export function startOfToday(now = new Date()): Date {
  return startOfEconomyDay(now);
}

/**
 * Lock the given users' rows for the rest of the transaction (always in id order, so two
 * settlements touching the same pair can't deadlock).
 */
export async function lockUsers(tx: Db, userIds: string[]) {
  const ids = [...new Set(userIds)].sort();
  for (const id of ids) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
  }
}

/** XP already granted to `userId` by matches settled this economy day. */
export async function experienceEarnedToday(tx: Db, userId: string, now = new Date()): Promise<number> {
  const since = startOfToday(now);
  const [asP1, asP2] = await Promise.all([
    tx.match.aggregate({ where: { player1Id: userId, settledAt: { gte: since } }, _sum: { player1Xp: true } }),
    tx.match.aggregate({ where: { player2Id: userId, settledAt: { gte: since } }, _sum: { player2Xp: true } }),
  ]);
  return (asP1._sum.player1Xp ?? 0) + (asP2._sum.player2Xp ?? 0);
}

export interface ExperienceGrant {
  userId: string;
  gained: number;
  level: number;
  experience: number;
  levelsGained: number;
  /** True when the daily cap cut the reward down. */
  capped: boolean;
}

/**
 * Grant up to `amount` XP inside `tx`, respecting DAILY_XP_CAP. The caller must hold the
 * user's row lock (lockUsers) and record the granted amount on the match row in the same
 * transaction, since the daily cap is computed from settled matches.
 */
export async function grantExperience(tx: Db, userId: string, amount: number, now = new Date()): Promise<ExperienceGrant | null> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { level: true, experience: true } });
  if (!user) return null;

  const wanted = Math.max(0, Math.floor(amount));
  const earned = wanted > 0 ? await experienceEarnedToday(tx, userId, now) : 0;
  const gained = Math.max(0, Math.min(wanted, DAILY_XP_CAP - earned));
  const next = applyExperience(user.level, user.experience, gained);
  if (gained > 0) {
    await tx.user.update({ where: { id: userId }, data: { level: next.level, experience: next.experience } });
  }
  return {
    userId,
    gained,
    level: next.level,
    experience: next.experience,
    levelsGained: next.levelsGained,
    capped: gained < wanted,
  };
}
