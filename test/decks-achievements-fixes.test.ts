/**
 * Regression tests for the 2026-10-14 bugs:
 * 6  a deck without a card playable as a Basic Pokémon is invalid (save, list, rooms)
 * 8  the "collection" achievements count only Base Set cards
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
    expect(await checkDeckPlayable(user.id, deck.id)).toBe(`Mazo invalido: ${NO_BASIC_ERROR}`);
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

describe("bug 8: collection achievements count only Base Set cards", () => {
  it("102 non-Base-Set cards don't complete Colección 75% / Completa; Base Set cards do", async () => {
    const user = await createUser({}, { stats: true });
    const others = Array.from({ length: 102 }, (_, i) => ({
      userId: user.id,
      cardDefId: `jungle-${String(i + 1).padStart(3, "0")}-x${i}`,
      quantity: 1,
    }));
    await prisma.userCard.createMany({ data: others });
    await checkAndUpdateProgress(user.id);
    const progress = await prisma.userAchievement.findMany({ where: { userId: user.id, achievementId: { in: ["bronze-2", "gold-30", "legend-48"] } } });
    expect(progress.map((a) => a.progress)).toEqual([0, 0, 0]);
    await expect(claimAchievement(user.id, "legend-48")).rejects.toThrow(/no esta completo/);

    await prisma.userCard.createMany({
      data: [
        { userId: user.id, cardDefId: "base-set-058-pikachu", quantity: 1 },
        { userId: user.id, cardDefId: "base-set-091-bill", quantity: 0 }, // sold/used up: doesn't count
      ],
    });
    await checkAndUpdateProgress(user.id);
    const novato = await prisma.userAchievement.findUniqueOrThrow({ where: { userId_achievementId: { userId: user.id, achievementId: "bronze-2" } } });
    expect(novato.progress).toBe(1);
    const full = await prisma.userAchievement.findUniqueOrThrow({ where: { userId_achievementId: { userId: user.id, achievementId: "legend-48" } } });
    expect(full.progress).toBe(1);
  });
});
