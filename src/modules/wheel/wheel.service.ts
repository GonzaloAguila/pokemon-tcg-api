import { prisma } from "../../lib/prisma.js";
import * as usersService from "../users/users.service.js";
import type { PackOpeningResult } from "../boosters/boosters.types.js";
import {
  CardRarityPool,
  grantPrize,
  pickWeighted,
  resolveAvatar,
  resolveCard,
  resolveCardBack,
  resolveCoins,
  resolveCollectibleCoin,
  resolveEmote,
  resolveRandomOverlay,
  type ResolvedPrize,
} from "../prizes/prizes.js";
import { WHEEL_SEGMENTS, WHEEL_SPIN_COST, type WheelSegment } from "./wheel.config.js";

export interface WheelSpinResult {
  segmentId: string;
  prize: ResolvedPrize;
  packResult?: PackOpeningResult;
  usedFreeSpin: boolean;
  freeSpins: number;
  balances: { coins: number; coupons: number; rareCandy: number };
}

function resolveSegmentPrize(segment: WheelSegment): ResolvedPrize {
  const { payload } = segment;
  switch (payload.type) {
    case "card":
      return resolveCard(payload.rarityPool);
    case "coins":
      return resolveCoins(payload.amount);
    case "card_back":
      return resolveCardBack();
    case "collectible_coin":
      return resolveCollectibleCoin();
    case "avatar":
      return resolveAvatar();
    case "free_pack":
      return { type: "free_pack" };
    case "spin_again":
      return { type: "spin_again", bonusCoins: payload.bonusCoins };
    case "jackpot":
      // 1000 coins + a Rare Holo card + a random variant + a battle emote (plus candy/coupons in grantPrize)
      return { type: "jackpot", prizes: [resolveCoins(1000), resolveCard(CardRarityPool.RareHolo), resolveRandomOverlay(), resolveEmote()] };
    case "nothing":
      return { type: "nothing" };
  }
}

/**
 * One wheel spin: consume a free spin or charge coins, roll the segment server-side,
 * and grant the prize — all in one transaction.
 */
export async function spinWheel(userId: string): Promise<WheelSpinResult> {
  const segment = pickWeighted(WHEEL_SEGMENTS.map((s) => ({ weight: s.weight, value: s })));
  const prize = resolveSegmentPrize(segment);

  return prisma.$transaction(async (tx) => {
    const { count: usedFree } = await tx.user.updateMany({
      where: { id: userId, freeWheelSpins: { gt: 0 } },
      data: { freeWheelSpins: { decrement: 1 } },
    });
    const usedFreeSpin = usedFree === 1;
    if (!usedFreeSpin) {
      await usersService.spendCoins(userId, WHEEL_SPIN_COST, "wheel_spin", "Giro de ruleta", tx);
    }

    const { packResult } = await grantPrize(tx, userId, prize, { type: "wheel_spin", label: "Ruleta" });
    if (prize.type === "spin_again") {
      await tx.user.update({ where: { id: userId }, data: { freeWheelSpins: { increment: 1 } } });
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { coins: true, coupons: true, rareCandy: true, freeWheelSpins: true },
    });

    return {
      segmentId: segment.id,
      prize,
      packResult,
      usedFreeSpin,
      freeSpins: user.freeWheelSpins,
      balances: { coins: user.coins, coupons: user.coupons, rareCandy: user.rareCandy },
    };
  });
}
