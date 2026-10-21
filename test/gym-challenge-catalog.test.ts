/**
 * Gym Challenge released (game-core 0.9.0 cleared `inDevelopment`): a booster like Gym Heroes'
 * (layout, price, image), 11 Pokémon of the set (no basic Energy), the catalog serves its 122
 * cards, its supported Trainers come in the Trainer booster, drafts / Fichas de canje / set
 * milestones include it and the Gym Leader decks that use it are playable in multiplayer.
 */
import { afterAll, describe, expect, it } from "vitest";
import { CARD_SETS, isSetInDevelopment } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { catalogRouter } from "../src/modules/catalog/index.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import { economyRouter } from "../src/modules/economy/index.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { exchangeCost } from "../src/modules/economy/economy.service.js";
import { ALL_VARIANTS } from "../src/modules/prizes/catalog.js";
import { DRAFT_PACK_SETS, draftPool } from "../src/socket/draft-rooms.js";
import { REWARD_PACK_SET_IDS } from "../src/socket/draft-rewards.js";
import { RELEASED_SETS } from "../src/lib/released-sets.js";
import {
  STANDARD_BOOSTER_IDS,
  TRAINER_BOOSTER_ID,
  getPackById,
  getPackOdds,
  isOpenableCard,
  openPack,
} from "../src/modules/boosters/boosters.service.js";
import { checkDeckPlayable, validateDeckCards } from "../src/modules/decks/decks.service.js";
import { startHttpApp } from "./http-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const GC = CARD_SETS.find((s) => s.id === "gym-challenge")!;
const rarityOf = new Map(GC.cards.map((c) => [c.id, c.rarity]));

describe("Gym Challenge released", () => {
  it("game-core no longer flags the set", () => {
    expect(GC.inDevelopment).toBeFalsy();
    expect(isSetInDevelopment(GC.cards[0])).toBe(false);
    expect(RELEASED_SETS.map((s) => s.id)).toContain("gym-challenge");
  });

  it("the booster has Gym Heroes' layout, price and the set's image", () => {
    expect(STANDARD_BOOSTER_IDS).toContain("gym-challenge-booster");
    const pack = getPackById("gym-challenge-booster")!;
    const gh = getPackById("gym-heroes-booster")!;
    expect(pack).toMatchObject({
      name: "Gym Challenge Booster",
      setId: "gym-challenge",
      image: "/packs/gym-challenge/booster.png",
      cardCount: 11,
      energyCount: 0,
      available: true,
    });
    expect(pack.price).toBe(gh.price);
    expect(pack.slots).toEqual(gh.slots);
  });

  it("opens 11 Pokémon of the set by slot rarity: no basic Energy, never a Trainer", () => {
    let holos = 0;
    for (let i = 0; i < 300; i++) {
      const { cards } = openPack("gym-challenge-booster");
      expect(cards).toHaveLength(11);
      const bySlot = (slot: string) => cards.filter((c) => c.slotType === slot);
      const rare = cards.filter((c) => c.slotType === "rare" || c.slotType === "rare-holo");
      expect(rare.length).toBeGreaterThanOrEqual(1);
      expect(rare.length + bySlot("uncommon").length).toBe(5);
      expect(bySlot("common")).toHaveLength(6);
      const setCards = cards;
      expect(setCards.every((c) => c.card.set === "Gym Challenge" && c.card.kind === "pokemon")).toBe(true);
      for (const c of bySlot("common")) expect(rarityOf.get(c.card.id)).toBe("common");
      for (const c of bySlot("uncommon")) expect(rarityOf.get(c.card.id)).toBe("uncommon");
      for (const c of rare) expect(["rare", "rare-holo"]).toContain(rarityOf.get(c.card.id));
      holos += rare.filter((c) => rarityOf.get(c.card.id) === "rare-holo").length;
    }
    expect(holos).toBeGreaterThan(100);
  });

  it("its Trainers come in the Trainer booster unless the engine lists them as unsupported", () => {
    const odds = getPackOdds(TRAINER_BOOSTER_ID)!;
    expect(odds.cardChances["gym-challenge-018-giovanni"]).toBeGreaterThan(0);
    const giovanni = GC.cards.find((c) => c.id === "gym-challenge-018-giovanni")!;
    expect(isOpenableCard(giovanni, new Set(["Giovanni"]))).toBe(false);
  });

  it("the catalog endpoints return the set and its 122 cards; decks accept them", async () => {
    const app = await startHttpApp((a) => {
      a.use("/api", catalogRouter);
      a.use("/api", boostersRouter);
    });
    try {
      const set = await app.request("GET", "/api/sets/gym-challenge");
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ id: "gym-challenge", name: "Gym Challenge", code: "G2", printedTotal: 132 });
      const cards = await app.request("GET", "/api/sets/gym-challenge/cards");
      expect(cards.body.total).toBe(122);
      const card = await app.request("GET", "/api/cards/gym-challenge-001-blaines-arcanine");
      expect(card.body).toMatchObject({ name: "Blaine's Arcanine", set: "Gym Challenge" });
      const packs = await app.request("GET", "/api/packs");
      expect(JSON.stringify(packs.body)).toContain("gym-challenge-booster");
    } finally {
      await app.close();
    }

    const deck = validateDeckCards([
      { cardDefId: "base-set-058-pikachu", quantity: 4 },
      { cardDefId: "gym-challenge-001-blaines-arcanine", quantity: 1 },
      { cardDefId: "base-set-100-lightning-energy", quantity: 55 },
    ]);
    expect(deck.valid).toBe(true);
  });

  it("the Gym Leader decks with its cards (Blaine, Sabrina, Giovanni, Koga) are playable", async () => {
    for (const deckId of ["gym-heroes-blaine", "gym-heroes-sabrina", "gym-challenge-giovanni", "gym-challenge-koga"]) {
      expect(await checkDeckPlayable("anyone", deckId)).toBeNull();
    }
  });

  it("drafts, draft prizes, Fichas de canje and set milestones include it", async () => {
    expect(DRAFT_PACK_SETS).toContain("gym-challenge");
    expect(REWARD_PACK_SET_IDS).toContain("gym-challenge");
    expect(draftPool.some((c) => c.set === "Gym Challenge")).toBe(true);
    expect(exchangeCost("gym-challenge-001-blaines-arcanine")).not.toBeNull();

    const holo = ECONOMY.setMilestones.holoVariantBySet["gym-challenge"];
    expect(ALL_VARIANTS.map((v) => v.itemId)).toContain(holo);
    const app = await startHttpApp((a) => a.use("/api", economyRouter));
    try {
      const config = await app.request("GET", "/api/economy/config");
      expect(config.body.packs.boosterIds).toContain("gym-challenge-booster");
      expect(config.body.setMilestones.sets).toContainEqual(
        expect.objectContaining({ setId: "gym-challenge", holoVariantSkinId: holo }),
      );
    } finally {
      await app.close();
    }
  });
});
