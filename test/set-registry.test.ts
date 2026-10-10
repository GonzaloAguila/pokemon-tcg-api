/**
 * Catalog, boosters and draft read game-core's set registry (CARD_SETS / ALL_CARDS) instead of
 * hand-written Base Set + Jungle lists, so a new set needs only its booster entry.
 */
import { describe, expect, it } from "vitest";
import { ALL_CARDS, CARD_SETS, isBasicEnergy } from "@gonzaloaguila/game-core";
import { getAllSets, getCardById, getCardsBySet, searchCards } from "../src/modules/catalog/catalog.service.js";
import { STANDARD_BOOSTER_IDS, getAllPacks, openPack } from "../src/modules/boosters/boosters.service.js";

describe("set registry consumers", () => {
  it("the catalog lists every registry set with its cards", () => {
    expect(getAllSets().map((s) => s.id)).toEqual(CARD_SETS.map((s) => s.id));
    for (const set of CARD_SETS) {
      expect(getCardsBySet(set.id)).toHaveLength(set.cards.length);
    }
    expect(getAllSets().find((s) => s.id === "jungle")?.totalCards).toBe(48);
    expect(getCardById("jungle-004-jolteon")?.name).toBe("Jolteon");
    expect(searchCards("pikachu").length).toBeGreaterThanOrEqual(2); // Base Set + Jungle
    expect(searchCards("x").length).toBeLessThanOrEqual(ALL_CARDS.length);
  });

  it("every standard booster opens 9 cards of its set plus 2 basic Energy", () => {
    expect(STANDARD_BOOSTER_IDS).toEqual(["base-set-booster", "jungle-booster"]);
    expect(getAllPacks().map((p) => p.id)).toEqual(["base-set-booster", "base-set-theme-pack", "jungle-booster"]);
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

  it("the theme pack has no energy", () => {
    const result = openPack("base-set-theme-pack");
    expect(result.cards).toHaveLength(5);
    expect(result.cards.some((c) => c.slotType === "energy")).toBe(false);
  });
});
