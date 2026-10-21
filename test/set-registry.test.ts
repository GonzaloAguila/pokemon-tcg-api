/**
 * Catalog, boosters and draft read game-core's set registry (CARD_SETS / ALL_CARDS) instead of
 * hand-written Base Set + Jungle lists, so a new set needs only its booster entry.
 */
import { describe, expect, it } from "vitest";
import { ALL_CARDS, CARD_SETS, isBasicEnergy } from "@gonzaloaguila/game-core";
import { getAllSets, getCardById, getCardsBySet, searchCards } from "../src/modules/catalog/catalog.service.js";
import { STANDARD_BOOSTER_IDS, getAllPacks, getPackById, openPack } from "../src/modules/boosters/boosters.service.js";
import { draftPool } from "../src/socket/draft-rooms.js";

describe("set registry consumers", () => {
  it("the catalog lists every registry set with its cards", () => {
    expect(getAllSets().map((s) => s.id)).toEqual(CARD_SETS.filter((s) => !s.inDevelopment).map((s) => s.id));
    for (const set of CARD_SETS.filter((s) => !s.inDevelopment)) {
      expect(getCardsBySet(set.id)).toHaveLength(set.cards.length);
    }
    expect(getAllSets().find((s) => s.id === "jungle")?.totalCards).toBe(48);
    expect(getCardById("jungle-004-jolteon")?.name).toBe("Jolteon");
    expect(searchCards("pikachu").length).toBeGreaterThanOrEqual(2); // Base Set + Jungle
    expect(searchCards("x").length).toBeLessThanOrEqual(ALL_CARDS.length);
  });

  it("every standard booster opens 9 cards of its set plus 2 basic Energy", () => {
    expect(STANDARD_BOOSTER_IDS).toEqual([
      "base-set-booster",
      "jungle-booster",
      "fossil-booster",
      "team-rocket-booster",
      "gym-heroes-booster",
      "gym-challenge-booster",
    ]);
    expect(getAllPacks().map((p) => p.id)).toEqual([
      "base-set-booster",
      "jungle-booster",
      "fossil-booster",
      "team-rocket-booster",
      "gym-heroes-booster",
      "gym-challenge-booster",
      "trainer-booster", // market-only, see trainer-booster.test.ts
    ]);
    for (const packId of STANDARD_BOOSTER_IDS) {
      const pack = getAllPacks().find((p) => p.id === packId)!;
      const setName = CARD_SETS.find((s) => s.id === pack.setId)!.name;
      const result = openPack(packId);
      expect(result.cards).toHaveLength(11);
      const energy = result.cards.filter((c) => c.slotType === "energy");
      expect(energy).toHaveLength(2);
      expect(energy.every((c) => isBasicEnergy(c.card))).toBe(true);
      expect(result.cards.filter((c) => c.slotType !== "energy").every((c) => c.card.set === setName)).toBe(true);
    }
  });

  it("Fossil: catalog set (47 cards, 62 printed), booster slots and the draft pool", () => {
    const fossil = getAllSets().find((s) => s.id === "fossil");
    expect(fossil).toMatchObject({ name: "Fossil", code: "FO", totalCards: 47, printedTotal: 62 });
    expect(getAllSets().find((s) => s.id === "jungle")?.printedTotal).toBe(64);
    expect(getCardById("fossil-062-mysterious-fossil")?.name).toBe("Mysterious Fossil");

    const pack = getPackById("fossil-booster")!;
    const jungle = getPackById("jungle-booster")!;
    expect(pack).toMatchObject({ name: "Fossil Booster", setId: "fossil", image: "/packs/fossil/booster.png", cardCount: 11, energyCount: 2 });
    expect(pack.price).toBe(jungle.price);
    expect(pack.slots).toEqual(jungle.slots);

    for (let i = 0; i < 20; i++) {
      const { cards } = openPack("fossil-booster");
      expect(cards).toHaveLength(11);
      const bySlot = (pred: (slot: string) => boolean) => cards.filter((c) => pred(c.slotType));
      // 1 rare (holo or not), 3 uncommon (1% upgraded to rare), 5 common, 2 basic Energy
      expect(bySlot((s) => s === "rare" || s === "rare-holo").length).toBeGreaterThanOrEqual(1);
      expect(bySlot((s) => s === "common")).toHaveLength(5);
      expect(bySlot((s) => s === "energy")).toHaveLength(2);
      expect(cards.filter((c) => c.slotType !== "energy").every((c) => c.card.set === "Fossil")).toBe(true);
      expect(cards.filter((c) => c.slotType === "energy").every((c) => isBasicEnergy(c.card))).toBe(true);
    }

    const fossilIds = new Set(CARD_SETS.find((s) => s.id === "fossil")!.cards.map((c) => c.id));
    expect(draftPool.filter((c) => fossilIds.has(c.id))).toHaveLength(47);
  });

  it("Team Rocket: catalog set (66 cards, 83 printed), booster like Jungle/Fossil, Dark Raichu rare, draft pool", () => {
    const tr = getAllSets().find((s) => s.id === "team-rocket");
    expect(tr).toMatchObject({ name: "Team Rocket", code: "TR", totalCards: 66, printedTotal: 83 });
    expect(getCardsBySet("team-rocket")).toHaveLength(66);
    expect(getCardById("team-rocket-083-dark-raichu")?.name).toBe("Dark Raichu");
    expect(getCardById("team-rocket-017-rainbow-energy")?.name).toBe("Rainbow Energy");

    const pack = getPackById("team-rocket-booster")!;
    const jungle = getPackById("jungle-booster")!;
    expect(pack).toMatchObject({
      name: "Team Rocket Booster",
      setId: "team-rocket",
      image: "/packs/team-rocket/booster.png",
      cardCount: 11,
      energyCount: 2,
      available: true,
    });
    expect(pack.price).toBe(jungle.price);
    expect(pack.slots).toEqual(jungle.slots);

    const rares = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { cards } = openPack("team-rocket-booster");
      expect(cards).toHaveLength(11);
      const bySlot = (pred: (slot: string) => boolean) => cards.filter((c) => pred(c.slotType));
      const rare = bySlot((s) => s === "rare" || s === "rare-holo");
      expect(rare.length).toBeGreaterThanOrEqual(1);
      for (const c of rare) rares.add(c.card.id);
      expect(bySlot((s) => s === "common")).toHaveLength(5);
      expect(bySlot((s) => s === "energy")).toHaveLength(2);
      expect(cards.filter((c) => c.slotType !== "energy").every((c) => c.card.set === "Team Rocket")).toBe(true);
      // Like Fossil: the set has no basic Energy, the Energy slots are Base Set basic Energy
      expect(cards.filter((c) => c.slotType === "energy").every((c) => isBasicEnergy(c.card))).toBe(true);
    }
    // Dark Raichu (#83, the secret rare) is in the rare pool; 200 packs see most of the 18 rares
    const rarePool = CARD_SETS.find((s) => s.id === "team-rocket")!.cards.filter((c) => c.rarity === "rare-holo").map((c) => c.id);
    expect(rarePool).toContain("team-rocket-083-dark-raichu");
    expect([...rares].every((id) => rarePool.includes(id))).toBe(true);
    expect(rares.size).toBeGreaterThan(10);

    const trIds = new Set(CARD_SETS.find((s) => s.id === "team-rocket")!.cards.map((c) => c.id));
    expect(draftPool.filter((c) => trIds.has(c.id))).toHaveLength(66);
  });

  it("Gym Heroes: catalog set (122 cards, 132 printed), booster with Base Set's slots, rare / holo slot rarities, draft pool", () => {
    const gh = getAllSets().find((s) => s.id === "gym-heroes");
    expect(gh).toMatchObject({ name: "Gym Heroes", code: "G1", totalCards: 122, printedTotal: 132 });
    expect(getCardsBySet("gym-heroes")).toHaveLength(122);
    expect(getCardById("gym-heroes-001-blaines-moltres")?.name).toBe("Blaine's Moltres");
    expect(getCardById("gym-heroes-124-narrow-gym")?.name).toBe("Narrow Gym");

    const pack = getPackById("gym-heroes-booster")!;
    const base = getPackById("base-set-booster")!;
    expect(pack).toMatchObject({
      name: "Gym Heroes Booster",
      setId: "gym-heroes",
      image: "/packs/gym-heroes/booster.png",
      cardCount: 11,
      energyCount: 2,
      available: true,
    });
    expect(pack.price).toBe(base.price);
    expect(pack.slots).toEqual(base.slots);

    const set = CARD_SETS.find((s) => s.id === "gym-heroes")!;
    const rarityOf = new Map(set.cards.map((c) => [c.id, c.rarity]));
    let holos = 0;
    let plainRares = 0;
    for (let i = 0; i < 300; i++) {
      const { cards } = openPack("gym-heroes-booster");
      expect(cards).toHaveLength(11);
      const bySlot = (slot: string) => cards.filter((c) => c.slotType === slot);
      // 1 rare slot (holo or not; the uncommons' 1% upgrade may add one), 3 uncommon slots, 5 commons, 2 basic Energy
      const rare = cards.filter((c) => c.slotType === "rare" || c.slotType === "rare-holo");
      expect(rare.length).toBeGreaterThanOrEqual(1);
      expect(rare.length + bySlot("uncommon").length).toBe(4);
      expect(bySlot("common")).toHaveLength(5);
      expect(bySlot("energy")).toHaveLength(2);
      // The 9 set cards are Gym Heroes Pokémon of their slot's rarity (Trainers only come in the Trainer booster)
      const setCardsPulled = cards.filter((c) => c.slotType !== "energy");
      expect(setCardsPulled.every((c) => c.card.set === "Gym Heroes" && c.card.kind === "pokemon")).toBe(true);
      for (const c of bySlot("common")) expect(rarityOf.get(c.card.id)).toBe("common");
      for (const c of bySlot("uncommon")) expect(rarityOf.get(c.card.id)).toBe("uncommon");
      for (const c of rare) expect(["rare", "rare-holo"]).toContain(rarityOf.get(c.card.id));
      // The Energy slots are Base Set basic Energy (the set's own basic Energy aren't separate catalog cards)
      expect(bySlot("energy").every((c) => isBasicEnergy(c.card))).toBe(true);
      holos += rare.filter((c) => rarityOf.get(c.card.id) === "rare-holo").length;
      plainRares += rare.filter((c) => rarityOf.get(c.card.id) === "rare").length;
    }
    // Unlike Jungle / Fossil / Team Rocket the set has non-holo rares: both show up
    expect(holos).toBeGreaterThan(100);
    expect(plainRares).toBeGreaterThan(30);

    const ghIds = new Set(set.cards.map((c) => c.id));
    expect(draftPool.filter((c) => ghIds.has(c.id))).toHaveLength(122);
  });

  it("every booster costs the same (the 5-card Theme Pack was retired in economy v2)", () => {
    expect(getAllPacks().every((p) => p.price === 200)).toBe(true);
    expect(getPackById("base-set-theme-pack")).toBeUndefined();
  });
});
