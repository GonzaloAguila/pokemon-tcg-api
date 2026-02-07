import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";

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
// Claim daily coins (500/day)
// ---------------------------------------------------------------------------

const DAILY_COINS_AMOUNT = 500;

export async function claimDailyCoins(userId: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { lastDailyCoinsAt: true, coins: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    if (!isAvailableToday(user.lastDailyCoinsAt)) {
      return { coins: user.coins, awarded: 0, alreadyClaimed: true };
    }

    const newBalance = user.coins + DAILY_COINS_AMOUNT;

    await tx.user.update({
      where: { id: userId },
      data: {
        coins: newBalance,
        lastDailyCoinsAt: new Date(),
      },
    });

    await tx.transaction.create({
      data: {
        userId,
        type: "daily_login",
        description: "Recompensa diaria de monedas",
        amount: DAILY_COINS_AMOUNT,
        balanceAfter: newBalance,
      },
    });

    return { coins: newBalance, awarded: DAILY_COINS_AMOUNT, alreadyClaimed: false };
  });
}

// ---------------------------------------------------------------------------
// Claim free wheel spin (1/day)
// ---------------------------------------------------------------------------

export async function claimFreeWheelSpin(userId: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { lastWheelSpinAt: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    if (!isAvailableToday(user.lastWheelSpinAt)) {
      return { available: false };
    }

    await tx.user.update({
      where: { id: userId },
      data: { lastWheelSpinAt: new Date() },
    });

    return { available: true };
  });
}

// ---------------------------------------------------------------------------
// Claim free slot spin (1/day)
// ---------------------------------------------------------------------------

export async function claimFreeSlotSpin(userId: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { lastSlotSpinAt: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    if (!isAvailableToday(user.lastSlotSpinAt)) {
      return { available: false };
    }

    await tx.user.update({
      where: { id: userId },
      data: { lastSlotSpinAt: new Date() },
    });

    return { available: true };
  });
}
