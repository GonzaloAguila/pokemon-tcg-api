import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { creditBalance, type Db } from "./users.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSameUTCDay(d1: Date, d2: Date): boolean {
  return (
    d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate()
  );
}

function isAvailableToday(lastClaimAt: Date | null): boolean {
  if (!lastClaimAt) return true;
  return !isSameUTCDay(lastClaimAt, new Date());
}

type DailyClaimField = "lastDailyCoinsAt" | "lastWheelSpinAt" | "lastSlotSpinAt";

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Sets `field` to now only if it wasn't already set today (UTC). Returns whether this call won the claim. */
async function markClaimedToday(tx: Db, userId: string, field: DailyClaimField): Promise<boolean> {
  const { count } = await tx.user.updateMany({
    where: { id: userId, OR: [{ [field]: null }, { [field]: { lt: startOfTodayUtc() } }] },
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
      lastDailyCoinsAt: true,
      lastWheelSpinAt: true,
      lastSlotSpinAt: true,
    },
  });

  if (!user) throw Errors.NotFound("Usuario");

  return {
    dailyCoinsAvailable: isAvailableToday(user.lastDailyCoinsAt),
    wheelSpinAvailable: isAvailableToday(user.lastWheelSpinAt),
    slotSpinAvailable: isAvailableToday(user.lastSlotSpinAt),
  };
}

// ---------------------------------------------------------------------------
// Claim daily coins (200/day, Sundays: +500 coins & +5 coupons)
// ---------------------------------------------------------------------------

const DAILY_COINS_AMOUNT = 200;
const SUNDAY_BONUS_COINS = 500;
const SUNDAY_BONUS_COUPONS = 5;

export async function claimDailyCoins(userId: string) {
  const isSunday = new Date().getUTCDay() === 0;
  const totalCoins = DAILY_COINS_AMOUNT + (isSunday ? SUNDAY_BONUS_COINS : 0);
  const totalCoupons = isSunday ? SUNDAY_BONUS_COUPONS : 0;

  return prisma.$transaction(async (tx) => {
    // Atomically mark today's claim; a concurrent request re-checks the WHERE and matches nothing.
    const claimed = await markClaimedToday(tx, userId, "lastDailyCoinsAt");
    if (!claimed) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true, coupons: true } });
      if (!user) throw Errors.NotFound("Usuario");
      return { coins: user.coins, coupons: user.coupons, awardedCoins: 0, awardedCoupons: 0, alreadyClaimed: true };
    }

    const description = isSunday
      ? `Recompensa diaria: ${totalCoins} monedas + ${totalCoupons} cupones (bonus domingo)`
      : `Recompensa diaria: ${totalCoins} monedas`;
    const coins = await creditBalance(userId, "coins", totalCoins, "daily_login", description, tx);
    const coupons =
      totalCoupons > 0
        ? await creditBalance(userId, "coupons", totalCoupons, "daily_login", description, tx)
        : (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { coupons: true } })).coupons;

    return {
      coins,
      coupons,
      awardedCoins: totalCoins,
      awardedCoupons: totalCoupons,
      isSunday,
      alreadyClaimed: false,
    };
  });
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
