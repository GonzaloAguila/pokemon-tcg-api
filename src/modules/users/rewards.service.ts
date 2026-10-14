import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import type { Db } from "./users.service.js";
import { startOfEconomyDay } from "../economy/economy-time.js";

// ---------------------------------------------------------------------------
// Daily free wheel / slot spin stamps (one per economy day, 00:00 Argentina).
//
// The old "daily coins" claim (200/day + Sunday bonus, POST /me/claim-daily-coins) was retired
// in economy v2: the daily reward is now the free daily pack + missions + check-in
// (modules/economy). The endpoint answers 410.
// ---------------------------------------------------------------------------

type DailyClaimField = "lastWheelSpinAt" | "lastSlotSpinAt";

function isAvailableToday(lastClaimAt: Date | null, now = new Date()): boolean {
  return !lastClaimAt || lastClaimAt < startOfEconomyDay(now);
}

/** Sets `field` to now only if it wasn't already set this economy day. Returns whether this call won the claim. */
async function markClaimedToday(tx: Db, userId: string, field: DailyClaimField): Promise<boolean> {
  const { count } = await tx.user.updateMany({
    where: { id: userId, OR: [{ [field]: null }, { [field]: { lt: startOfEconomyDay() } }] },
    data: { [field]: new Date() },
  });
  return count === 1;
}

async function assertUserExists(tx: Db, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw Errors.NotFound("Usuario");
}

// ---------------------------------------------------------------------------
// Daily rewards status
// ---------------------------------------------------------------------------

export async function getDailyRewardsStatus(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      lastWheelSpinAt: true,
      lastSlotSpinAt: true,
    },
  });

  if (!user) throw Errors.NotFound("Usuario");

  return {
    /** Retired (economy v2): always false. Use GET /api/economy/status. */
    dailyCoinsAvailable: false,
    wheelSpinAvailable: isAvailableToday(user.lastWheelSpinAt),
    slotSpinAvailable: isAvailableToday(user.lastSlotSpinAt),
  };
}

// ---------------------------------------------------------------------------
// Claim free wheel spin (1/day)
// ---------------------------------------------------------------------------

export async function claimFreeWheelSpin(userId: string) {
  return prisma.$transaction(async (tx) => {
    const claimed = await markClaimedToday(tx, userId, "lastWheelSpinAt");
    if (!claimed) await assertUserExists(tx, userId);
    return { available: claimed };
  });
}

// ---------------------------------------------------------------------------
// Claim free slot spin (1/day)
// ---------------------------------------------------------------------------

export async function claimFreeSlotSpin(userId: string) {
  return prisma.$transaction(async (tx) => {
    const claimed = await markClaimedToday(tx, userId, "lastSlotSpinAt");
    if (!claimed) await assertUserExists(tx, userId);
    return { available: claimed };
  });
}
