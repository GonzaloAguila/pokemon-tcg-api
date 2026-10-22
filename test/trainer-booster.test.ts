/**
 * Trainers-only boosters: sold in the market (coins), 11 Trainers of a group of sets (Clásicos:
 * Base Set to Team Rocket; Gimnasio: Gym Heroes and Gym Challenge), not standard boosters (daily
 * free pack, welcome and prize packs keep giving set boosters).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNSUPPORTED_TRAINERS } from "@gonzaloaguila/game-core";
import { RELEASED_CARDS as ALL_CARDS, RELEASED_SETS as CARD_SETS } from "../src/lib/released-sets.js";
import { prisma } from "../src/lib/prisma.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import {
  GYM_TRAINER_BOOSTER_ID,
  STANDARD_BOOSTER_IDS,
  TRAINER_BOOSTER_ID,
  TRAINER_BOOSTER_IDS,
  getAllPacks,
  getPackOdds,
  openPack,
} from "../src/modules/boosters/boosters.service.js";
import { createUser, getBalances } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

// Every Trainer the engine can play (UNSUPPORTED_TRAINERS never come out of a booster)
const TRAINERS = ALL_CARDS.filter((c) => c.kind === "trainer" && !UNSUPPORTED_TRAINERS.includes(c.name));
const setIdOf = (setName: string) => CARD_SETS.find((s) => s.name === setName)!.id;
const BOOSTER_SET_IDS: Record<string, string[]> = {
  [TRAINER_BOOSTER_ID]: ["base-set", "jungle", "fossil", "team-rocket"],
  [GYM_TRAINER_BOOSTER_ID]: ["gym-heroes", "gym-challenge"],
};
const trainersOf = (packId: string) => TRAINERS.filter((c) => BOOSTER_SET_IDS[packId].includes(setIdOf(c.set)));
let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", boostersRouter));
});
afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

describe("trainer boosters", () => {
  it("Clásicos and Gimnasio are listed with the boosters' price but are not standard (free/prize) boosters", () => {
    expect(TRAINER_BOOSTER_IDS).toEqual([TRAINER_BOOSTER_ID, GYM_TRAINER_BOOSTER_ID]);
    for (const packId of TRAINER_BOOSTER_IDS) {
      const pack = getAllPacks().find((p) => p.id === packId);
      expect(pack).toMatchObject({ cardCount: 11, price: ECONOMY.packs.price, available: true });
      expect(STANDARD_BOOSTER_IDS).not.toContain(packId);
    }
    expect(getAllPacks().find((p) => p.id === TRAINER_BOOSTER_ID)!.name).toBe("Entrenadores Clásicos");
    expect(getAllPacks().find((p) => p.id === GYM_TRAINER_BOOSTER_ID)!.name).toBe("Entrenadores de Gimnasio");
  });

  it("every released set's Trainers are in exactly one Trainer booster", () => {
    for (const set of CARD_SETS) {
      if (!TRAINERS.some((c) => setIdOf(c.set) === set.id)) continue;
      expect(TRAINER_BOOSTER_IDS.filter((packId) => BOOSTER_SET_IDS[packId].includes(set.id))).toHaveLength(1);
    }
  });

  it.each([TRAINER_BOOSTER_ID, GYM_TRAINER_BOOSTER_ID])("%s opens 11 Trainers with a rare, only of its sets, and covers all of them", (packId) => {
    const sets = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const { cards } = openPack(packId);
      expect(cards).toHaveLength(11);
      expect(cards.every((p) => p.card.kind === "trainer")).toBe(true);
      expect(cards.some((p) => p.card.rarity === "rare" || p.card.rarity === "rare-holo")).toBe(true);
      for (const p of cards) sets.add(setIdOf(p.card.set));
    }
    expect([...sets].sort()).toEqual([...BOOSTER_SET_IDS[packId]].sort());
  });

  it.each([TRAINER_BOOSTER_ID, GYM_TRAINER_BOOSTER_ID])("%s odds cover exactly its sets' playable Trainers, holos included", (packId) => {
    const odds = getPackOdds(packId)!;
    expect(Object.keys(odds.cardChances).sort()).toEqual(trainersOf(packId).map((c) => c.id).sort());
    expect(odds.rarities.find((r) => r.rarity === "rare-holo")).toBeDefined();
  });

  it.each([TRAINER_BOOSTER_ID, GYM_TRAINER_BOOSTER_ID])("%s is bought with coins and its cards go to the collection", async (packId) => {
    const user = await createUser({ coins: ECONOMY.packs.price + 5 });
    const res = await http.request("POST", `/api/packs/${packId}/open`, { token: tokenFor(user) });
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(11);
    expect((await getBalances(user.id)).coins).toBe(5);
    const owned = await prisma.userCard.aggregate({ where: { userId: user.id }, _sum: { quantity: true } });
    expect(owned._sum.quantity).toBe(11);

    const broke = await http.request("POST", `/api/packs/${packId}/open`, { token: tokenFor(user) });
    expect(broke.status).toBeGreaterThanOrEqual(400);
  });
});

describe("set boosters", () => {
  it("never give Trainers (they only come in the Trainer boosters), in packs or in their odds", () => {
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
