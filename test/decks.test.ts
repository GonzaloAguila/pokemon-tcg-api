import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { decks as themeDecks, isLimitedInDeck, resolveDeck } from "@gonzaloaguila/game-core";
import { createDeck, checkDeckPlayable, validateDeckCards, type DeckCardEntry } from "../src/modules/decks/decks.service.js";
import { getStarterDeck, type StarterColor } from "../src/modules/decks/starter-decks.js";
import { setStarterDeck } from "../src/modules/users/users.service.js";
import { createUser, race } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

// 4 Pikachu + 56 Lightning Energy = 60 cards
const deckCards: DeckCardEntry[] = [
  { cardDefId: "base-set-058-pikachu", quantity: 4 },
  { cardDefId: "base-set-100-lightning-energy", quantity: 56 },
];

describe("deck ownership", () => {
  it("marks a deck invalid when the user doesn't own its cards (energy is free)", async () => {
    const user = await createUser();
    const deck = await createDeck(user.id, { name: "t", cards: deckCards });
    expect(deck.isValid).toBe(false);

    await prisma.userCard.create({ data: { userId: user.id, cardDefId: "base-set-058-pikachu", quantity: 4 } });
    const owned = await createDeck(user.id, { name: "t2", cards: deckCards });
    expect(owned.isValid).toBe(true);
    expect(await checkDeckPlayable(user.id, owned.id)).toBeNull();
  });

  it("refuses to play someone else's deck or an unowned one", async () => {
    const owner = await createUser();
    const other = await createUser();
    await prisma.userCard.create({ data: { userId: owner.id, cardDefId: "base-set-058-pikachu", quantity: 4 } });
    const deck = await createDeck(owner.id, { name: "t", cards: deckCards });
    expect(await checkDeckPlayable(other.id, deck.id)).toBe("Mazo no encontrado");
    await prisma.userCard.updateMany({ where: { userId: owner.id }, data: { quantity: 1 } });
    expect(await checkDeckPlayable(owner.id, deck.id)).toMatch(/Mazo inválido/);
    expect(await checkDeckPlayable(other.id, "overgrowth")).toBeNull(); // theme decks are public
  });
});

describe("starter deck", () => {
  it("grants the starter cards once under concurrency and the deck is valid", async () => {
    const user = await createUser();
    await prisma.userStats.create({ data: { userId: user.id } });
    const { fulfilled } = await race(4, () => setStarterDeck(user.id, "fire"));
    expect(fulfilled).toHaveLength(1);
    const decks = await prisma.deck.findMany({ where: { userId: user.id } });
    expect(decks).toHaveLength(1);
    expect(decks[0].isValid).toBe(true);
    const total = await prisma.userCard.aggregate({ where: { userId: user.id }, _sum: { quantity: true } });
    expect(total._sum.quantity).toBe(60);
  });
});

describe("deck rules: special Energy is limited (game-core isLimitedInDeck)", () => {
  const RAINBOW = "team-rocket-017-rainbow-energy";
  const deckWith = (rainbow: DeckCardEntry[]): DeckCardEntry[] => {
    const special = rainbow.reduce((sum, e) => sum + e.quantity, 0);
    return [
      { cardDefId: "base-set-058-pikachu", quantity: 4 },
      ...rainbow,
      { cardDefId: "base-set-100-lightning-energy", quantity: 56 - special },
    ];
  };

  it("rejects 5 Rainbow Energy, accepts 4; basic Energy stays unlimited", () => {
    expect(validateDeckCards(deckWith([{ cardDefId: RAINBOW, quantity: 4 }]))).toEqual({ valid: true, errors: [] });
    const five = validateDeckCards(deckWith([{ cardDefId: RAINBOW, quantity: 5 }]));
    expect(five.valid).toBe(false);
    expect(five.errors).toEqual(['Máximo 4 copias de "Rainbow Energy" (tiene 5)']);
    expect(validateDeckCards(deckWith([{ cardDefId: "base-set-096-double-colorless-energy", quantity: 5 }])).valid).toBe(false);
  });

  it("copies of one card are summed over its variant entries", () => {
    const split = validateDeckCards(deckWith([
      { cardDefId: RAINBOW, quantity: 3 },
      { cardDefId: RAINBOW, quantity: 2, variantId: "holo-sparkle" },
    ]));
    expect(split.valid).toBe(false);
  });

  it("a deck with 5 Rainbow Energy can't be used in a room even when they are owned", async () => {
    const user = await createUser();
    await prisma.userCard.createMany({
      data: [
        { userId: user.id, cardDefId: "base-set-058-pikachu", quantity: 4 },
        { userId: user.id, cardDefId: RAINBOW, quantity: 5 },
      ],
    });
    const deck = await createDeck(user.id, { name: "rainbow", cards: deckWith([{ cardDefId: RAINBOW, quantity: 5 }]) });
    expect(deck.isValid).toBe(false);
    expect(await checkDeckPlayable(user.id, deck.id)).toMatch(/Mazo inválido: Máximo 4 copias de "Rainbow Energy"/);
  });

  it("every starter deck and theme deck still passes the copy limits", () => {
    const colors: StarterColor[] = ["fire", "water", "grass", "electric", "psychic", "fighting"];
    for (const color of colors) {
      expect(validateDeckCards(getStarterDeck(color).cards), color).toEqual({ valid: true, errors: [] });
    }
    for (const theme of themeDecks) {
      const byName = new Map<string, number>();
      for (const { card, quantity } of resolveDeck(theme)) {
        if (!isLimitedInDeck(card)) continue;
        byName.set(card.name, (byName.get(card.name) ?? 0) + quantity);
      }
      for (const [name, quantity] of byName) expect(quantity, `${theme.id}: ${name}`).toBeLessThanOrEqual(4);
    }
  });
});
