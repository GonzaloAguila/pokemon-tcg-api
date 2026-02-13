/**
 * Battle Pass Service — Calendar-based Monthly System
 *
 * Each month has its own BattlePass, auto-created on first access.
 * All users are auto-enrolled. Day progression follows the calendar.
 * Premium is a monthly purchase that expires with the month.
 */

import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";
import { DEFAULT_MONTHLY_REWARDS } from "./seed-data.js";
import type {
  BattlePassRewardDef,
  BattlePassWithProgress,
  BattlePassListItem,
} from "./battle-pass.types.js";

// =============================================================================
// Calendar Helpers
// =============================================================================

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function getCurrentDayOfMonth(): number {
  return new Date().getUTCDate();
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function getCurrentYearMonth(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function getDaysRemaining(year: number, month: number): number {
  const total = getDaysInMonth(year, month);
  const current = getCurrentDayOfMonth();
  return Math.max(total - current, 0);
}

function isCurrentMonth(pass: { year: number | null; month: number | null }): boolean {
  if (pass.year == null || pass.month == null) return false;
  const { year, month } = getCurrentYearMonth();
  return pass.year === year && pass.month === month;
}

/**
 * Build rewards array for a specific month length.
 * - Months < 30 days: filter to day <= durationDays
 * - 31-day months: add day 31 as 100/200 coins
 */
function buildRewardsForMonth(durationDays: number): BattlePassRewardDef[] {
  const rewards = DEFAULT_MONTHLY_REWARDS.filter((r) => r.day <= durationDays);

  if (durationDays === 31) {
    rewards.push(
      { day: 31, track: "standard", rewardType: "coins", amount: 100, label: "100 Monedas", icon: "🪙" },
      { day: 31, track: "premium",  rewardType: "coins", amount: 200, label: "200 Monedas", icon: "🪙" },
    );
  }

  return rewards;
}

// =============================================================================
// Auto-create monthly pass
// =============================================================================

async function getOrCreateMonthlyPass(year: number, month: number) {
  const existing = await prisma.battlePass.findUnique({
    where: { year_month: { year, month } },
  });
  if (existing) return existing;

  const durationDays = getDaysInMonth(year, month);
  const monthName = MONTH_NAMES[month - 1];
  const slug = `${year}-${String(month).padStart(2, "0")}`;
  const name = `Pase de Batalla — ${monthName} ${year}`;

  const rewards = buildRewardsForMonth(durationDays);

  // Expire any previous active passes
  await prisma.battlePass.updateMany({
    where: { status: "active" },
    data: { status: "expired" },
  });

  return prisma.battlePass.create({
    data: {
      slug,
      name,
      description: `Pase de batalla mensual de ${monthName} ${year}.`,
      imageUrl: "",
      durationDays,
      premiumPrice: 2,
      status: "active",
      rewards: rewards as any,
      year,
      month,
    },
  });
}

// =============================================================================
// Auto-enrollment
// =============================================================================

async function getOrCreateEnrollment(userId: string, passId: string) {
  const existing = await prisma.userBattlePass.findUnique({
    where: { userId_battlePassId: { userId, battlePassId: passId } },
    include: { claimedRewards: true },
  });
  if (existing) return existing;

  return prisma.userBattlePass.create({
    data: { userId, battlePassId: passId },
    include: { claimedRewards: true },
  });
}

// =============================================================================
// Get current month's pass with full progress (main endpoint)
// =============================================================================

export async function getCurrentPassWithProgress(
  userId: string,
): Promise<BattlePassWithProgress> {
  const { year, month } = getCurrentYearMonth();
  const pass = await getOrCreateMonthlyPass(year, month);
  const enrollment = await getOrCreateEnrollment(userId, pass.id);

  const currentDay = getCurrentDayOfMonth();
  const daysRemaining = getDaysRemaining(year, month);
  const rewards = pass.rewards as unknown as BattlePassRewardDef[];

  return {
    id: pass.id,
    slug: pass.slug,
    name: pass.name,
    description: pass.description,
    imageUrl: pass.imageUrl,
    durationDays: pass.durationDays,
    premiumPrice: pass.premiumPrice,
    status: pass.status,
    rewards,
    year,
    month,
    daysRemaining,
    enrollment: {
      activatedAt: enrollment.activatedAt.toISOString(),
      isPremium: enrollment.isPremium,
      currentDay,
      claimedRewards: enrollment.claimedRewards.map((r) => ({
        day: r.day,
        track: r.track,
      })),
    },
  };
}

// =============================================================================
// List available passes (kept for backwards compatibility)
// =============================================================================

export async function getAvailablePasses(
  userId?: string,
): Promise<BattlePassListItem[]> {
  const { year, month } = getCurrentYearMonth();
  const pass = await getOrCreateMonthlyPass(year, month);

  const enrollment = userId
    ? await prisma.userBattlePass.findUnique({
        where: { userId_battlePassId: { userId, battlePassId: pass.id } },
      })
    : null;

  const currentDay = getCurrentDayOfMonth();
  const daysRemaining = getDaysRemaining(year, month);

  return [
    {
      id: pass.id,
      slug: pass.slug,
      name: pass.name,
      description: pass.description,
      imageUrl: pass.imageUrl,
      durationDays: pass.durationDays,
      premiumPrice: pass.premiumPrice,
      status: pass.status,
      isEnrolled: true, // always enrolled in calendar system
      isPremium: enrollment?.isPremium ?? false,
      currentDay,
      year,
      month,
      daysRemaining,
    },
  ];
}

// =============================================================================
// Get pass details by ID (kept for backwards compatibility)
// =============================================================================

export async function getPassWithProgress(
  passId: string,
  userId: string,
): Promise<BattlePassWithProgress> {
  const pass = await prisma.battlePass.findUnique({
    where: { id: passId },
  });
  if (!pass) throw Errors.NotFound("Pase de batalla");

  // Only allow fetching current month's pass
  if (!isCurrentMonth(pass)) {
    throw Errors.BadRequest("Este pase ya expiró");
  }

  const enrollment = await getOrCreateEnrollment(userId, pass.id);
  const currentDay = getCurrentDayOfMonth();
  const daysRemaining = getDaysRemaining(pass.year!, pass.month!);
  const rewards = pass.rewards as unknown as BattlePassRewardDef[];

  return {
    id: pass.id,
    slug: pass.slug,
    name: pass.name,
    description: pass.description,
    imageUrl: pass.imageUrl,
    durationDays: pass.durationDays,
    premiumPrice: pass.premiumPrice,
    status: pass.status,
    rewards,
    year: pass.year ?? undefined,
    month: pass.month ?? undefined,
    daysRemaining,
    enrollment: {
      activatedAt: enrollment.activatedAt.toISOString(),
      isPremium: enrollment.isPremium,
      currentDay,
      claimedRewards: enrollment.claimedRewards.map((r) => ({
        day: r.day,
        track: r.track,
      })),
    },
  };
}

// =============================================================================
// Upgrade to premium
// =============================================================================

export async function upgradeToPremium(passId: string, userId: string) {
  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");

  if (!isCurrentMonth(pass)) {
    throw Errors.BadRequest("Solo puedes comprar premium del mes actual");
  }

  const enrollment = await getOrCreateEnrollment(userId, pass.id);
  if (enrollment.isPremium) throw Errors.Conflict("Ya tienes el pase premium");

  await usersService.spendRareCandy(
    userId,
    pass.premiumPrice,
    "battle_pass_upgrade",
    `Mejora a Premium: ${pass.name}`,
  );

  await prisma.userBattlePass.update({
    where: { id: enrollment.id },
    data: { isPremium: true, upgradedAt: new Date() },
  });

  return { isPremium: true };
}

// =============================================================================
// Claim reward
// =============================================================================

export async function claimReward(
  passId: string,
  userId: string,
  day: number,
  track: string,
) {
  if (track !== "standard" && track !== "premium") {
    throw Errors.BadRequest("Track invalido");
  }

  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");

  if (!isCurrentMonth(pass)) {
    throw Errors.BadRequest("Este pase ya expiró, no puedes reclamar recompensas");
  }

  const enrollment = await getOrCreateEnrollment(userId, pass.id);

  // Validate day is unlocked (calendar day)
  const currentDay = getCurrentDayOfMonth();
  if (day < 1 || day > currentDay) {
    throw Errors.BadRequest("Este dia aun no esta disponible");
  }

  // Validate premium track
  if (track === "premium" && !enrollment.isPremium) {
    throw Errors.BadRequest(
      "Necesitas el pase premium para reclamar esta recompensa",
    );
  }

  // Check not already claimed
  const alreadyClaimed = enrollment.claimedRewards.some(
    (r) => r.day === day && r.track === track,
  );
  if (alreadyClaimed) {
    throw Errors.Conflict("Ya reclamaste esta recompensa");
  }

  // Find the reward definition
  const rewards = pass.rewards as unknown as BattlePassRewardDef[];
  const rewardDef = rewards.find((r) => r.day === day && r.track === track);
  if (!rewardDef) throw Errors.NotFound("Definicion de recompensa");

  // Grant reward inside a transaction
  return prisma.$transaction(async (tx) => {
    await tx.userBattlePassReward.create({
      data: {
        userBattlePassId: enrollment.id,
        day,
        track,
      },
    });

    const granted = await grantReward(tx, userId, rewardDef);
    return { day, track, reward: rewardDef, granted };
  });
}

// =============================================================================
// Reward granting (inside transaction)
// =============================================================================

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function grantReward(
  tx: Tx,
  userId: string,
  reward: BattlePassRewardDef,
) {
  switch (reward.rewardType) {
    case "coins": {
      const amount = reward.amount ?? 0;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });
      if (!user) throw Errors.NotFound("Usuario");
      const newBalance = user.coins + amount;
      await tx.user.update({
        where: { id: userId },
        data: { coins: newBalance },
      });
      await tx.transaction.create({
        data: {
          userId,
          type: "battle_pass_reward",
          description: `Pase de batalla: ${reward.label}`,
          amount,
          balanceAfter: newBalance,
        },
      });
      return { type: "coins", amount, newBalance };
    }

    case "ticket": {
      const amount = reward.amount ?? 1;
      await tx.user.update({
        where: { id: userId },
        data: { coupons: { increment: amount } },
      });
      return { type: "ticket", amount };
    }

    case "card_back": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCardBack.upsert({
        where: {
          userId_cardBackId: { userId, cardBackId: reward.rewardId },
        },
        update: {},
        create: { userId, cardBackId: reward.rewardId },
      });
      return { type: "card_back", cardBackId: reward.rewardId };
    }

    case "profile_coin": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCoin.upsert({
        where: { userId_coinId: { userId, coinId: reward.rewardId } },
        update: {},
        create: { userId, coinId: reward.rewardId },
      });
      return { type: "profile_coin", coinId: reward.rewardId };
    }

    case "card": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCard.upsert({
        where: {
          userId_cardDefId: { userId, cardDefId: reward.rewardId },
        },
        update: { quantity: { increment: 1 } },
        create: { userId, cardDefId: reward.rewardId, quantity: 1 },
      });
      return { type: "card", cardDefId: reward.rewardId };
    }

    case "pack": {
      return { type: "pack", packId: reward.rewardId };
    }

    case "avatar": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userAvatar.upsert({
        where: { userId_avatarId: { userId, avatarId: reward.rewardId } },
        update: {},
        create: { userId, avatarId: reward.rewardId },
      });
      return { type: "avatar", avatarId: reward.rewardId };
    }

    case "playmat": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userPlaymat.upsert({
        where: { userId_playmatId: { userId, playmatId: reward.rewardId } },
        update: {},
        create: { userId, playmatId: reward.rewardId },
      });
      return { type: "playmat", playmatId: reward.rewardId };
    }

    case "random_card": {
      // Pick a random card from the full catalog
      const { baseSetCards, jungleCards } = await import("@gonzaloaguila/game-core");
      const allCards = [...baseSetCards, ...jungleCards];
      const randomCard = allCards[Math.floor(Math.random() * allCards.length)];
      const cardDefId = randomCard.id;

      await tx.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId } },
        update: { quantity: { increment: 1 } },
        create: { userId, cardDefId, quantity: 1 },
      });
      return { type: "random_card", cardDefId, cardName: randomCard.name };
    }

    case "card_skin": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCardSkin.upsert({
        where: { userId_skinId: { userId, skinId: reward.rewardId } },
        update: {},
        create: { userId, skinId: reward.rewardId },
      });
      return { type: "card_skin", skinId: reward.rewardId };
    }

    default:
      return { type: "unknown" };
  }
}
