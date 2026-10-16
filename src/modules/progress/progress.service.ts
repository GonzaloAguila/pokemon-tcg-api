/**
 * Tutorial and puzzle progress. Completion is reported by the client (like vs-AI results), so the
 * rewards are small and paid once: the tutorial reward through `claimOnce`, a puzzle's coins only
 * by the call whose insert created its row (`createMany` + `skipDuplicates`, count === 1), inside
 * the same transaction as the credit.
 */

import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { creditBalance, type Db } from "../users/users.service.js";
import { lockUsers } from "../users/xp.service.js";
import { claimOnce, hasClaim } from "../economy/claims.js";
import { ECONOMY } from "../economy/config.js";
import { grantPacks } from "../economy/pack-inventory.js";
import {
  PUZZLES,
  TUTORIAL_LESSONS,
  TUTORIAL_REWARD_KEY,
  itemIndex,
  puzzleCoins,
  trackItems,
  type ProgressTrack,
} from "./catalog.js";

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

export interface ProgressView {
  tutorial: { completed: string[]; rewardClaimed: boolean };
  puzzles: { completed: string[] };
}

async function assertUser(tx: Db, userId: string) {
  await lockUsers(tx, [userId]);
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw Errors.NotFound("Usuario");
}

/** Completed ids of every track (catalog order) + whether the tutorial reward was claimed. */
export async function getProgress(userId: string, db: Db = prisma): Promise<ProgressView> {
  const [rows, rewardClaimed] = await Promise.all([
    db.userProgress.findMany({ where: { userId }, select: { track: true, itemId: true } }),
    hasClaim(db, userId, "tutorial", TUTORIAL_REWARD_KEY),
  ]);
  const done = (track: ProgressTrack) => {
    const ids = new Set(rows.filter((r) => r.track === track).map((r) => r.itemId));
    return trackItems(track).filter((id) => ids.has(id));
  };
  return {
    tutorial: { completed: done("tutorial"), rewardClaimed },
    puzzles: { completed: done("puzzles") },
  };
}

async function isCompleted(tx: Db, userId: string, track: ProgressTrack, itemId: string) {
  const row = await tx.userProgress.findUnique({
    where: { userId_track_itemId: { userId, track, itemId } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Mark `itemId` as completed (requires the previous item of the track). Returns true only for the
 * call that inserted the row.
 */
async function complete(tx: Db, userId: string, track: ProgressTrack, itemId: string, previousMessage: string) {
  const index = itemIndex(track, itemId);
  if (index > 0 && !(await isCompleted(tx, userId, track, trackItems(track)[index - 1]))) {
    throw Errors.Conflict(previousMessage);
  }
  const { count } = await tx.userProgress.createMany({
    data: [{ userId, track, itemId }],
    skipDuplicates: true,
  });
  return count === 1;
}

/** POST /progress/tutorial/:lessonId — idempotent; lessons go in order. */
export async function completeTutorialLesson(userId: string, lessonId: string): Promise<ProgressView> {
  if (itemIndex("tutorial", lessonId) < 0) throw Errors.NotFound("Lección");
  return prisma.$transaction(async (tx) => {
    await assertUser(tx, userId);
    await complete(tx, userId, "tutorial", lessonId, "Completá la lección anterior");
    return getProgress(userId, tx);
  }, TX_OPTIONS);
}

/** POST /progress/tutorial/claim — once, after every lesson: coins + one "choose your set" pack. */
export async function claimTutorialReward(userId: string) {
  const { coins, packs } = ECONOMY.progress.tutorialReward;
  return prisma.$transaction(async (tx) => {
    await assertUser(tx, userId);
    const done = await tx.userProgress.count({
      where: { userId, track: "tutorial", itemId: { in: [...TUTORIAL_LESSONS] } },
    });
    if (done < TUTORIAL_LESSONS.length) throw Errors.Conflict("Completá todas las lecciones del tutorial");
    if (!(await claimOnce(tx, userId, "tutorial", TUTORIAL_REWARD_KEY))) {
      throw Errors.Conflict("Ya reclamaste la recompensa del tutorial");
    }
    if (coins > 0) await creditBalance(userId, "coins", coins, "tutorial_reward", "Tutorial completado", tx);
    await grantPacks(tx, userId, packs, "tutorial");
    return { coins, packs, progress: await getProgress(userId, tx) };
  }, TX_OPTIONS);
}

/** POST /progress/puzzles/:puzzleId — puzzles go in order; the tier's coins only on the first solve. */
export async function completePuzzle(userId: string, puzzleId: string) {
  const puzzle = PUZZLES.find((p) => p.id === puzzleId);
  if (!puzzle) throw Errors.NotFound("Puzzle");
  return prisma.$transaction(async (tx) => {
    await assertUser(tx, userId);
    const firstTime = await complete(tx, userId, "puzzles", puzzle.id, "Resolvé el puzzle anterior");
    const coins = firstTime ? puzzleCoins(puzzle) : 0;
    if (coins > 0) {
      await creditBalance(userId, "coins", coins, "puzzle_reward", `Puzzle ${puzzle.number} resuelto`, tx);
    }
    return { firstTime, coins, progress: await getProgress(userId, tx) };
  }, TX_OPTIONS);
}
