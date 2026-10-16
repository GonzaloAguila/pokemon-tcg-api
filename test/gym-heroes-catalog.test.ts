/**
 * Gym Heroes in the catalog, the pack system and the economy config: everything follows
 * game-core's set registry plus one SET_BOOSTERS entry and one set-milestone holo variant.
 * (Booster contents: set-registry.test.ts.)
 */
import { afterAll, describe, expect, it } from "vitest";
import { CARD_SETS } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { catalogRouter } from "../src/modules/catalog/index.js";
import { economyRouter } from "../src/modules/economy/index.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import { getOdds } from "../src/modules/economy/odds.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { STANDARD_BOOSTER_IDS, getPackOdds } from "../src/modules/boosters/boosters.service.js";
import { ALL_VARIANTS } from "../src/modules/prizes/catalog.js";
import { startHttpApp } from "./http-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Gym Heroes: catalog, packs and economy", () => {
  it("the catalog endpoints return the set and its cards", async () => {
    const app = await startHttpApp((a) => a.use("/api", catalogRouter));
    try {
      const sets = await app.request("GET", "/api/sets");
      expect(sets.status).toBe(200);
      const listed = JSON.stringify(sets.body);
      expect(listed).toContain("gym-heroes");

      const set = await app.request("GET", "/api/sets/gym-heroes");
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ id: "gym-heroes", name: "Gym Heroes", code: "G1", printedTotal: 132 });

      const cards = await app.request("GET", "/api/sets/gym-heroes/cards");
      expect(cards.status).toBe(200);
      expect(cards.body.total).toBe(CARD_SETS.find((s) => s.id === "gym-heroes")!.cards.length);
      const ids = (cards.body.cards as { id: string }[]).map((c) => c.id);
      expect(ids).toContain("gym-heroes-010-mistys-tentacruel");
      expect(ids).toContain("gym-heroes-107-celadon-city-gym");

      const stadiums = await app.request("GET", "/api/sets/gym-heroes/cards?search=gym");
      expect((stadiums.body.cards as { name: string }[]).map((c) => c.name)).toEqual(
        expect.arrayContaining(["Narrow Gym", "Celadon City Gym", "Vermilion City Gym"]),
      );

      const card = await app.request("GET", "/api/cards/gym-heroes-002-brocks-rhydon");
      expect(card.body).toMatchObject({ name: "Brock's Rhydon", set: "Gym Heroes" });
    } finally {
      await app.close();
    }
  });

  it("the booster is listed and sold like the other sets; its odds have non-holo rares", async () => {
    expect(STANDARD_BOOSTER_IDS).toContain("gym-heroes-booster");
    const app = await startHttpApp((a) => a.use("/api", boostersRouter));
    try {
      const packs = await app.request("GET", "/api/packs");
      expect(JSON.stringify(packs.body)).toContain("gym-heroes-booster");
      const pack = await app.request("GET", "/api/packs/gym-heroes-booster");
      expect(pack.status).toBe(200);
    } finally {
      await app.close();
    }

    const odds = getPackOdds("gym-heroes-booster")!;
    const base = getPackOdds("base-set-booster")!;
    expect(odds.price).toBe(ECONOMY.packs.price);
    // Same slots as Base Set: ~66.5% holo (the set has non-holo rares, unlike Jungle / Fossil / TR)
    expect(odds.holoChance).toBeGreaterThan(0.665);
    expect(odds.holoChance).toBeLessThan(0.68);
    expect(Math.abs(odds.holoChance - base.holoChance)).toBeLessThan(0.01);
    expect(odds.cardChances["gym-heroes-001-blaines-moltres"]).toBeGreaterThan(0);
    expect(odds.cardChances["gym-heroes-124-narrow-gym"]).toBeUndefined(); // Trainers: Trainer booster only
    expect(getOdds().packs.map((p) => p.packId)).toContain("gym-heroes-booster");
  });

  it("the economy config lists the set: booster, milestone card back, title and holo variant", async () => {
    expect(ALL_VARIANTS.map((v) => v.itemId)).toContain(ECONOMY.setMilestones.holoVariantBySet["gym-heroes"]);
    const app = await startHttpApp((a) => a.use("/api", economyRouter));
    try {
      const config = await app.request("GET", "/api/economy/config");
      expect(config.status).toBe(200);
      expect(config.body.packs.boosterIds).toContain("gym-heroes-booster");
      expect(config.body.setMilestones.sets).toContainEqual({
        setId: "gym-heroes",
        cardBackId: "set-gym-heroes",
        titleMedalId: "title-maestro-gym-heroes",
        holoVariantSkinId: "blaine-s-moltres-holo-sparkle",
      });
    } finally {
      await app.close();
    }
  });
});
