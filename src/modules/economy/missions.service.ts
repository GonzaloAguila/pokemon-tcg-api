/**
 * Daily missions (reset at 00:00 Argentina) and the weekly mission (complete N daily missions in
 * the economy week). Progress comes only from server events: the daily pack claim and the
 * settlement of a counted game (multiplayer settlement or /api/matches/ai). Rewards are credited
 * automatically, in the same transaction as the event that completes the mission.
 */

import { prisma } from "../../lib/prisma.js";
import { creditBalance, type Db } from "../users/users.service.js";
import { lockUsers } from "../users/xp.service.js";
import { ECONOMY, type MissionEvent } from "./config.js";
import { economyDay, economyWeek, nextEconomyDayStart, nextEconomyWeekStart } from "./economy-time.js";
import { grantPacks } from "./pack-inventory.js";

export interface MissionCompletion {
  missionId: string;
  title: string;
  kind: "daily" | "weekly";
  rewardCoins: number;
  rewardPacks: number;
  rewardExchangeTokens: number;
}

/**
 * Advance the user's missions for `event` (inside the caller's transaction; locks the user's
 * row) and grant the rewards of every mission it completes. Returns the completed missions.
 */
export async function recordMissionEvent(
  tx: Db,
  userId: string,
  event: MissionEvent,
  now = new Date(),
  amount = 1,
): Promise<MissionCompletion[]> {
  const defs = ECONOMY.missions.daily.filter((d) => d.event === event);
  if (defs.length === 0 || amount <= 0) return [];
  await lockUsers(tx, [userId]);

  const day = economyDay(now);
  const completions: MissionCompletion[] = [];
  for (const def of defs) {
    const done = await advance(tx, userId, def.id, day, def.target, amount);
    if (!done) continue;
    if (def.rewardCoins > 0) {
      await creditBalance(userId, "coins", def.rewardCoins, "mission_reward", `Misión diaria: ${def.title}`, tx);
    }
    completions.push({
      missionId: def.id,
      title: def.title,
      kind: "daily",
      rewardCoins: def.rewardCoins,
      rewardPacks: 0,
      rewardExchangeTokens: 0,
    });

    const weekly = ECONOMY.missions.weekly;
    const weeklyDone = await advance(tx, userId, weekly.id, economyWeek(now), weekly.target, 1);
    if (weeklyDone) {
      await grantPacks(tx, userId, weekly.rewardPacks, "weekly_mission");
      if (weekly.rewardExchangeTokens > 0) {
        await creditBalance(
          userId,
          "exchangeTokens",
          weekly.rewardExchangeTokens,
          "weekly_mission_reward",
          `Misión semanal: ${weekly.title}`,
          tx,
        );
      }
      completions.push({
        missionId: weekly.id,
        title: weekly.title,
        kind: "weekly",
        rewardCoins: 0,
        rewardPacks: weekly.rewardPacks,
        rewardExchangeTokens: weekly.rewardExchangeTokens,
      });
    }
  }
  return completions;
}

/** Add progress to one mission; returns true for the call that completed it. Needs the user lock. */
async function advance(tx: Db, userId: string, missionId: string, period: string, target: number, amount: number) {
  const where = { userId_missionId_period: { userId, missionId, period } };
  const row = await tx.userMission.findUnique({ where, select: { progress: true, completedAt: true } });
  if (row?.completedAt) return false;
  const progress = Math.min(target, (row?.progress ?? 0) + amount);
  if (!row) await tx.userMission.create({ data: { userId, missionId, period, progress } });
  else await tx.userMission.update({ where, data: { progress } });
  if (progress < target) return false;
  const { count } = await tx.userMission.updateMany({
    where: { userId, missionId, period, completedAt: null },
    data: { completedAt: new Date() },
  });
  return count === 1;
}

export interface MissionStatus {
  id: string;
  title: string;
  target: number;
  progress: number;
  completed: boolean;
  rewardCoins: number;
}

export async function getMissionsStatus(userId: string, now = new Date()) {
  const day = economyDay(now);
  const week = economyWeek(now);
  const rows = await prisma.userMission.findMany({
    where: { userId, OR: [{ period: day }, { period: week, missionId: ECONOMY.missions.weekly.id }] },
    select: { missionId: true, period: true, progress: true, completedAt: true },
  });
  const find = (id: string, period: string) => rows.find((r) => r.missionId === id && r.period === period);

  const daily: MissionStatus[] = ECONOMY.missions.daily.map((def) => {
    const row = find(def.id, day);
    return {
      id: def.id,
      title: def.title,
      target: def.target,
      progress: row?.progress ?? 0,
      completed: !!row?.completedAt,
      rewardCoins: def.rewardCoins,
    };
  });
  const weeklyDef = ECONOMY.missions.weekly;
  const weeklyRow = find(weeklyDef.id, week);
  return {
    day,
    resetsAt: nextEconomyDayStart(now).toISOString(),
    daily,
    weekly: {
      id: weeklyDef.id,
      title: weeklyDef.title,
      week,
      target: weeklyDef.target,
      progress: weeklyRow?.progress ?? 0,
      completed: !!weeklyRow?.completedAt,
      rewardPacks: weeklyDef.rewardPacks,
      rewardExchangeTokens: weeklyDef.rewardExchangeTokens,
      resetsAt: nextEconomyWeekStart(now).toISOString(),
    },
  };
}
