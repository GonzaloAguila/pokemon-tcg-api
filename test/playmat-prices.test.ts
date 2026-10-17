/**
 * Playmats are priced by rarity in the daily market.
 */
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { AVAILABLE_PLAYMATS } from "../src/modules/prizes/catalog.js";
import { PLAYMAT_PRICES, getDailyOffers } from "../src/modules/market/market.service.js";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("playmat prices", () => {
  it("cost more the rarer they are", () => {
    expect(PLAYMAT_PRICES.common).toBeLessThan(PLAYMAT_PRICES.uncommon);
    expect(PLAYMAT_PRICES.uncommon).toBeLessThan(PLAYMAT_PRICES.rare);
    expect(PLAYMAT_PRICES.rare).toBeLessThan(PLAYMAT_PRICES.legendary);
  });

  it("the daily playmat offer costs its rarity's price", async () => {
    // Over a few weeks every playmat comes up at least once
    const seen = new Set<string>();
    for (let day = 0; day < 60; day++) {
      const offers = await getDailyOffers(undefined, new Date(Date.UTC(2026, 9, 1 + day, 12)));
      const playmat = offers.cosmeticOffers.find((offer) => offer.type === "playmat")!;
      const item = AVAILABLE_PLAYMATS.find((p) => p.itemId === playmat.itemId)!;
      expect(playmat.price).toBe(PLAYMAT_PRICES[item.rarity]);
      seen.add(item.rarity);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
