import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import * as usersService from "../src/modules/users/users.service.js";
import * as rewardsService from "../src/modules/users/rewards.service.js";
import * as marketService from "../src/modules/market/market.service.js";
import * as achievementsService from "../src/modules/achievements/achievements.service.js";
import * as battlePassService from "../src/modules/battle-pass/battle-pass.service.js";
import { purchaseDeckSlot } from "../src/modules/decks/decks.service.js";
import { createUser, getBalances, race } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("balance primitives", () => {
  it("rejects non-positive and non-integer amounts", async () => {
    const user = await createUser({ coins: 100 });
    for (const amount of [0, -50, 1.5, Number.NaN]) {
      await expect(usersService.addCoins(user.id, amount, "test", "test")).rejects.toThrow();
      await expect(usersService.spendCoins(user.id, amount, "test", "test")).rejects.toThrow();
    }
    expect((await getBalances(user.id)).coins).toBe(100);
  });

  it("never spends more than the balance under concurrency", async () => {
    const user = await createUser({ coins: 100 });
    const { fulfilled } = await race(8, () => usersService.spendCoins(user.id, 100, "test", "test"));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(0);
  });

  it("applies every concurrent credit exactly once", async () => {
    const user = await createUser({ coupons: 0 });
    await race(10, () => usersService.addCoupons(user.id, 5, "test", "test"));
    expect((await getBalances(user.id)).coupons).toBe(50);
  });

  it("logs the currency of each transaction", async () => {
    const user = await createUser({ rareCandy: 3 });
    await usersService.spendRareCandy(user.id, 1, "test", "test");
    const tx = await prisma.transaction.findFirstOrThrow({ where: { userId: user.id } });
    expect(tx).toMatchObject({ currency: "rareCandy", amount: -1, balanceAfter: 2 });
  });
});

describe("market", () => {
  it("rejects a negative energy quantity without touching the balance", async () => {
    const user = await createUser({ coins: 100 });
    const { energyOffers } = await marketService.getDailyOffers();
    await expect(marketService.buyEnergy(user.id, energyOffers[0].energyType, -1000)).rejects.toThrow();
    expect((await getBalances(user.id)).coins).toBe(100);
    expect(await prisma.userCard.count({ where: { userId: user.id } })).toBe(0);
  });

  it("sells the same daily card only once under concurrency", async () => {
    const user = await createUser({ coins: 100_000 });
    const { cardOffers } = await marketService.getDailyOffers(user.id);
    const offer = cardOffers[0];
    const { fulfilled } = await race(5, () => marketService.buyDailyCard(user.id, offer.cardDefId));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(100_000 - offer.price);
  });

  it("does not charge when the purchase cannot be completed", async () => {
    const user = await createUser({ coins: 100_000 });
    const { cardOffers } = await marketService.getDailyOffers(user.id);
    await marketService.buyDailyCard(user.id, cardOffers[0].cardDefId);
    const before = (await getBalances(user.id)).coins;
    await expect(marketService.buyDailyCard(user.id, cardOffers[0].cardDefId)).rejects.toThrow();
    expect((await getBalances(user.id)).coins).toBe(before);
  });
});

describe("one-time rewards", () => {
  it("grants the daily coins once under concurrency", async () => {
    const user = await createUser({ coins: 0 });
    const { fulfilled } = await race(6, () => rewardsService.claimDailyCoins(user.id));
    const awarded = fulfilled.filter((r) => r.value.alreadyClaimed === false);
    expect(awarded).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(awarded[0].value.awardedCoins);
  });

  it("pays an achievement reward once under concurrency", async () => {
    const user = await createUser({ coins: 0 });
    await prisma.userAchievement.create({ data: { userId: user.id, achievementId: "bronze-1", progress: 1 } });
    const { fulfilled } = await race(6, () => achievementsService.claimAchievement(user.id, "bronze-1"));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(200);
  });

  it("charges the battle pass premium upgrade once under concurrency", async () => {
    const now = new Date();
    const pass = await prisma.battlePass.upsert({
      where: { year_month: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 } },
      update: {},
      create: {
        slug: `test-${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`,
        name: "Test pass",
        premiumPrice: 10,
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      },
    });
    const user = await createUser({ rareCandy: 1000 });
    const { fulfilled } = await race(5, () => battlePassService.upgradeToPremium(pass.id, user.id));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).rareCandy).toBe(1000 - pass.premiumPrice);
  });

  it("buys a deck slot atomically", async () => {
    const user = await createUser({ coins: 500 });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { maxDeckSlots: true } });
    const { fulfilled } = await race(4, () => purchaseDeckSlot(user.id));
    expect(fulfilled).toHaveLength(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { maxDeckSlots: true, coins: true } });
    expect(after).toEqual({ maxDeckSlots: before.maxDeckSlots + 1, coins: 0 });
  });
});

describe("admin adjustments", () => {
  it("log the right currency and never overdraw", async () => {
    const { adjustCoupons } = await import("../src/modules/admin/admin.service.js");
    const admin = await createUser();
    const user = await createUser({ coupons: 10 });
    await adjustCoupons(user.id, 5, "bonus", admin.id);
    await expect(adjustCoupons(user.id, -100, "penalty", admin.id)).rejects.toThrow();
    const { fulfilled } = await race(4, () => adjustCoupons(user.id, -15, "penalty", admin.id));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).coupons).toBe(0);
    const rows = await prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.currency, r.amount])).toEqual([["coupons", 5], ["coupons", -15]]);
  });
});
