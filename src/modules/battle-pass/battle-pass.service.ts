/**
 * Battle Pass Service
 *
 * Handles pass enrollment, premium upgrade, day progression, and reward claiming.
 */

import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";
import type {
  BattlePassRewardDef,
  BattlePassWithProgress,
  BattlePassListItem,
} from "./battle-pass.types.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Calculate how many days have been unlocked since activation.
 * Day 1 is unlocked immediately. Day 2 unlocks 24h after activation, etc.
 */
function calculateCurrentDay(activatedAt: Date, durationDays: number): number {
  const now = new Date();
  const elapsed = now.getTime() - activatedAt.getTime();
  const daysPassed = Math.floor(elapsed / (24 * 60 * 60 * 1000));
  return Math.min(daysPassed + 1, durationDays);
}

// =============================================================================
// List available passes
// =============================================================================

export async function getAvailablePasses(
  userId?: string,
): Promise<BattlePassListItem[]> {
  const passes = await prisma.battlePass.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    include: userId
      ? { userPasses: { where: { userId }, take: 1 } }
      : undefined,
  });

  return passes.map((pass) => {
    const enrollment =
      userId && "userPasses" in pass ? (pass as any).userPasses?.[0] : null;
    return {
      id: pass.id,
      slug: pass.slug,
      name: pass.name,
      description: pass.description,
      imageUrl: pass.imageUrl,
      durationDays: pass.durationDays,
      premiumPrice: pass.premiumPrice,
      status: pass.status,
      isEnrolled: !!enrollment,
      isPremium: enrollment?.isPremium ?? false,
      currentDay: enrollment
        ? calculateCurrentDay(enrollment.activatedAt, pass.durationDays)
        : null,
    };
  });
}

// =============================================================================
// Get pass details with user progress
// =============================================================================

export async function getPassWithProgress(
  passId: string,
  userId: string,
): Promise<BattlePassWithProgress> {
  const pass = await prisma.battlePass.findUnique({
    where: { id: passId },
    include: {
      userPasses: {
        where: { userId },
        take: 1,
        include: { claimedRewards: true },
      },
    },
  });

  if (!pass) throw Errors.NotFound("Pase de batalla");

  const enrollment = pass.userPasses[0] ?? null;
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
    enrollment: enrollment
      ? {
          activatedAt: enrollment.activatedAt.toISOString(),
          isPremium: enrollment.isPremium,
          currentDay: calculateCurrentDay(
            enrollment.activatedAt,
            pass.durationDays,
          ),
          claimedRewards: enrollment.claimedRewards.map((r) => ({
            day: r.day,
            track: r.track,
          })),
        }
      : null,
  };
}

// =============================================================================
// Activate (free enrollment)
// =============================================================================

export async function activatePass(passId: string, userId: string) {
  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");
  if (pass.status !== "active")
    throw Errors.BadRequest("Este pase no esta disponible");

  const existing = await prisma.userBattlePass.findUnique({
    where: { userId_battlePassId: { userId, battlePassId: passId } },
  });
  if (existing) throw Errors.Conflict("Ya estas inscrito en este pase");

  const enrollment = await prisma.userBattlePass.create({
    data: { userId, battlePassId: passId },
  });

  return {
    activatedAt: enrollment.activatedAt.toISOString(),
    isPremium: false,
    currentDay: 1,
  };
}

// =============================================================================
// Upgrade to premium
// =============================================================================

export async function upgradeToPremium(passId: string, userId: string) {
  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");

  const enrollment = await prisma.userBattlePass.findUnique({
    where: { userId_battlePassId: { userId, battlePassId: passId } },
  });
  if (!enrollment) throw Errors.BadRequest("Primero debes activar el pase");
  if (enrollment.isPremium) throw Errors.Conflict("Ya tienes el pase premium");

  await usersService.spendCoins(
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

  const enrollment = await prisma.userBattlePass.findUnique({
    where: { userId_battlePassId: { userId, battlePassId: passId } },
    include: { claimedRewards: true },
  });
  if (!enrollment) throw Errors.BadRequest("No estas inscrito en este pase");

  // Validate day is unlocked
  const currentDay = calculateCurrentDay(
    enrollment.activatedAt,
    pass.durationDays,
  );
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
      return { type: "avatar", avatarId: reward.rewardId };
    }

    default:
      return { type: "unknown" };
  }
}
