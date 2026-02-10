import { prisma } from "../../lib/prisma.js";
import * as usersService from "../users/users.service.js";

const SPIN_COST = 100; // coins

// ---------------------------------------------------------------------------
// Prize type — mirrors frontend ResolvedPrize (only fields needed server-side)
// ---------------------------------------------------------------------------

interface ResolvedPrize {
  type: string;
  amount?: number;        // coins
  cardDefId?: string;     // card
  overlayId?: string;     // overlay
  skinId?: string;        // overlay (skin record ID)
  cardBackId?: string;    // card_back
  coinId?: string;        // collectible_coin
  avatarId?: string;      // avatar
  bonusCoins?: number;    // spin_again
  prizes?: ResolvedPrize[]; // jackpot sub-prizes
}

// ---------------------------------------------------------------------------
// Pay for a wheel spin (deduct coins)
// ---------------------------------------------------------------------------

export async function payWheelSpin(userId: string) {
  return usersService.spendCoins(
    userId,
    SPIN_COST,
    "wheel_spin",
    "Giro de ruleta",
  );
}

// ---------------------------------------------------------------------------
// Claim a wheel prize — persist to user's collection
// ---------------------------------------------------------------------------

export async function claimWheelPrize(userId: string, prize: ResolvedPrize) {
  switch (prize.type) {
    case "coins": {
      if (!prize.amount) break;
      await usersService.addCoins(
        userId,
        prize.amount,
        "wheel_spin",
        `Ruleta: +${prize.amount} monedas`,
      );
      break;
    }

    case "card": {
      if (!prize.cardDefId) break;
      await prisma.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId: prize.cardDefId } },
        update: { quantity: { increment: 1 } },
        create: { userId, cardDefId: prize.cardDefId, quantity: 1 },
      });
      break;
    }

    case "overlay": {
      if (!prize.skinId) break;
      await prisma.userCardSkin.upsert({
        where: { userId_skinId: { userId, skinId: prize.skinId } },
        update: {},
        create: { userId, skinId: prize.skinId },
      });
      break;
    }

    case "card_back": {
      if (!prize.cardBackId) break;
      await prisma.userCardBack.upsert({
        where: { userId_cardBackId: { userId, cardBackId: prize.cardBackId } },
        update: {},
        create: { userId, cardBackId: prize.cardBackId },
      });
      break;
    }

    case "collectible_coin": {
      if (!prize.coinId) break;
      await prisma.userCoin.upsert({
        where: { userId_coinId: { userId, coinId: prize.coinId } },
        update: {},
        create: { userId, coinId: prize.coinId },
      });
      break;
    }

    case "avatar": {
      if (!prize.avatarId) break;
      await prisma.userAvatar.upsert({
        where: { userId_avatarId: { userId, avatarId: prize.avatarId } },
        update: {},
        create: { userId, avatarId: prize.avatarId },
      });
      break;
    }

    case "free_pack": {
      // Grant equivalent coins for now
      await usersService.addCoins(
        userId,
        200,
        "wheel_spin",
        "Ruleta: Sobre gratis (equivalente)",
      );
      break;
    }

    case "jackpot": {
      if (!prize.prizes) break;
      // Jackpot: 1 rare candy + 100 coupons + sub-prizes
      await usersService.addRareCandy(userId, 1, "wheel_spin", "Ruleta: Jackpot — Rare Candy");
      await usersService.addCoupons(userId, 100, "wheel_spin", "Ruleta: Jackpot — 100 cupones");
      for (const subPrize of prize.prizes) {
        await claimWheelPrize(userId, subPrize);
      }
      break;
    }

    // "nothing", "spin_again" — no persistent reward
    default:
      break;
  }

  return { success: true };
}
