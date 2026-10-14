/**
 * Regression tests for the 2026-10-14 bugs:
 * 6  a deck without a card playable as a Basic Pokémon is invalid (save, list, rooms)
 * 8  the Base Set "collection" achievements counted cards of any set. Economy v2 retired them
 *    (Colección 75% / Completa → per-set milestones); the two that remain (Coleccionista Novato,
 *    Coleccionista) are "of any set" by definition and count owned cards only
 */
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  NO_BASIC_ERROR,
  checkDeckPlayable,
  createDeck,
  getUserDecks,
  validateDeckCards,
  type DeckCardEntry,
} from "../src/modules/decks/decks.service.js";
import { checkAndUpdateProgress, claimAchievement } from "../src/modules/achievements/achievements.service.js";
import { createUser } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const ENERGY_ONLY: DeckCardEntry[] = [
  { cardDefId: "base-set-098-fire-energy", quantity: 30 },
  { cardDefId: "base-set-102-water-energy", quantity: 30 },
];

describe("bug 6: a deck needs a Basic Pokémon", () => {
  it("60 basic Energy is saved as invalid and can't take a seat", async () => {
    expect(validateDeckCards(ENERGY_ONLY)).toEqual({ valid: false, errors: [NO_BASIC_ERROR] });
    const user = await createUser();
    const deck = await createDeck(user.id, { name: "sin basicos", cards: ENERGY_ONLY });
    expect(deck.isValid).toBe(false);
    expect(await checkDeckPlayable(user.id, deck.id)).toBe(`Mazo inválido: ${NO_BASIC_ERROR}`);
  });

  it("Mysterious Fossil / Clefairy Doll count as Basics (game-core isPlayableAsBasic)", () => {
    const fossilDeck: DeckCardEntry[] = [
      { cardDefId: "fossil-062-mysterious-fossil", quantity: 4 },
      { cardDefId: "base-set-102-water-energy", quantity: 56 },
    ];
    expect(validateDeckCards(fossilDeck)).toEqual({ valid: true, errors: [] });
    const evolutionsOnly: DeckCardEntry[] = [
      { cardDefId: "base-set-014-raichu", quantity: 4 },
      { cardDefId: "base-set-100-lightning-energy", quantity: 56 },
    ];
    expect(validateDeckCards(evolutionsOnly).errors).toContain(NO_BASIC_ERROR);
  });

  it("a deck saved valid before the rule existed is listed as invalid", async () => {
    const user = await createUser();
    await prisma.deck.create({ data: { userId: user.id, name: "viejo", cards: ENERGY_ONLY as object[], isValid: true } });
    const [listed] = await getUserDecks(user.id);
    expect(listed.isValid).toBe(false);
  });

  it("a seat always needs an existing deck", async () => {
    const user = await createUser();
    expect(await checkDeckPlayable(user.id, undefined)).toBe("Debes elegir un mazo");
    expect(await checkDeckPlayable(user.id, "no-such-theme")).toBe("Mazo no encontrado");
    expect(await checkDeckPlayable(user.id, "brushfire")).toBeNull();
  });
});

describe("bug 8: the Base Set collection achievements (retired by economy v2)", () => {
  it("102 cards of other sets can't claim Colección 75% / Completa: both are retired", async () => {
    const user = await createUser({}, { stats: true });
    const others = Array.from({ length: 102 }, (_, i) => ({
      userId: user.id,
      cardDefId: `jungle-${String(i + 1).padStart(3, "0")}-x${i}`,
      quantity: 1,
    }));
    await prisma.userCard.createMany({ data: others });
    await checkAndUpdateProgress(user.id);
    await expect(claimAchievement(user.id, "legend-48")).rejects.toThrow(/retirado/);
    await expect(claimAchievement(user.id, "gold-30")).rejects.toThrow(/retirado/);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
  });

  it("the remaining collection achievements count owned cards (quantity > 0) of any set", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.userCard.create({ data: { userId: user.id, cardDefId: "base-set-091-bill", quantity: 0 } }); // used up
    await checkAndUpdateProgress(user.id);
    const novatoOf = () =>
      prisma.userAchievement.findUnique({ where: { userId_achievementId: { userId: user.id, achievementId: "bronze-2" } } });
    expect((await novatoOf())?.progress ?? 0).toBe(0);

    await prisma.userCard.create({ data: { userId: user.id, cardDefId: "jungle-010-scyther", quantity: 1 } });
    await checkAndUpdateProgress(user.id);
    expect((await novatoOf())?.progress).toBe(1);
  });
});
