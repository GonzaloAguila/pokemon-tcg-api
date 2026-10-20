/**
 * Trainers-only booster: sold in the market (coins), 11 Trainers of every set, not a standard
 * booster (daily free pack, welcome and prize packs keep giving set boosters).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNSUPPORTED_TRAINERS } from "@gonzaloaguila/game-core";
import { RELEASED_CARDS as ALL_CARDS, RELEASED_SETS as CARD_SETS } from "../src/lib/released-sets.js";
import { prisma } from "../src/lib/prisma.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import {
  STANDARD_BOOSTER_IDS,
  TRAINER_BOOSTER_ID,
  getAllPacks,
  getPackOdds,
  openPack,
} from "../src/modules/boosters/boosters.service.js";
import { createUser, getBalances } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

// Every Trainer the engine can play (UNSUPPORTED_TRAINERS never come out of a booster)
const TRAINERS = ALL_CARDS.filter((c) => c.kind === "trainer" && !UNSUPPORTED_TRAINERS.includes(c.name));
let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", boostersRouter));
});
afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

describe("trainer booster", () => {
  it("is listed with the boosters' price but is not a standard (free/prize) booster", () => {
    const pack = getAllPacks().find((p) => p.id === TRAINER_BOOSTER_ID);
    expect(pack).toMatchObject({ cardCount: 11, price: ECONOMY.packs.price, available: true });
    expect(STANDARD_BOOSTER_IDS).not.toContain(TRAINER_BOOSTER_ID);
  });

  it("opens 11 Trainers with a rare, and over many packs covers every set", () => {
    const sets = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { cards } = openPack(TRAINER_BOOSTER_ID);
      expect(cards).toHaveLength(11);
      expect(cards.every((p) => p.card.kind === "trainer")).toBe(true);
      expect(cards.some((p) => p.card.rarity === "rare" || p.card.rarity === "rare-holo")).toBe(true);
      for (const p of cards) sets.add(p.card.set);
    }
    expect(sets.size).toBe(CARD_SETS.length);
  });

  it("odds cover exactly the playable Trainers", () => {
    const odds = getPackOdds(TRAINER_BOOSTER_ID)!;
    expect(Object.keys(odds.cardChances).sort()).toEqual(TRAINERS.map((c) => c.id).sort());
    expect(odds.rarities.find((r) => r.rarity === "rare-holo")).toBeDefined();
  });

  it("is bought with coins and its cards go to the collection", async () => {
    const user = await createUser({ coins: ECONOMY.packs.price + 5 });
    const res = await http.request("POST", `/api/packs/${TRAINER_BOOSTER_ID}/open`, { token: tokenFor(user) });
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(11);
    expect((await getBalances(user.id)).coins).toBe(5);
    const owned = await prisma.userCard.aggregate({ where: { userId: user.id }, _sum: { quantity: true } });
    expect(owned._sum.quantity).toBe(11);

    const broke = await http.request("POST", `/api/packs/${TRAINER_BOOSTER_ID}/open`, { token: tokenFor(user) });
    expect(broke.status).toBeGreaterThanOrEqual(400);
  });
});

describe("set boosters", () => {
  it("never give Trainers (they only come in the Trainer booster), in packs or in their odds", () => {
    for (const packId of STANDARD_BOOSTER_IDS) {
      for (let i = 0; i < 100; i++) {
        const { cards } = openPack(packId);
        expect(cards).toHaveLength(11);
        expect(cards.some((p) => p.card.kind === "trainer")).toBe(false);
      }
      const odds = getPackOdds(packId)!;
      const trainerIds = new Set(TRAINERS.map((c) => c.id));
      expect(Object.keys(odds.cardChances).some((id) => trainerIds.has(id))).toBe(false);
    }
  });
});

describe("card weights", () => {
  it("a card with weight 0.25 comes out about a quarter as often as the others of its rarity, and the odds say so", () => {
    const charizard = "base-set-004-charizard";
    const blastoise = "base-set-002-blastoise";
    ECONOMY.packs.cardWeights[charizard] = 0.25;
    try {
      const odds = getPackOdds("base-set-booster")!;
      const ratio = odds.cardChances[charizard] / odds.cardChances[blastoise];
      expect(ratio).toBeGreaterThan(0.24);
      expect(ratio).toBeLessThan(0.27);
      expect(odds.rarities.find((r) => r.rarity === "rare-holo")!.chancePerCard).toBe(odds.cardChances[blastoise]);

      let zard = 0;
      let blast = 0;
      for (let i = 0; i < 6000; i++) {
        for (const p of openPack("base-set-booster").cards) {
          if (p.card.id === charizard) zard++;
          if (p.card.id === blastoise) blast++;
        }
      }
      expect(zard / blast).toBeGreaterThan(0.15);
      expect(zard / blast).toBeLessThan(0.38);
    } finally {
      delete ECONOMY.packs.cardWeights[charizard];
    }
  });
});
