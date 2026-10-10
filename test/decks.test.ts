import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createDeck, checkDeckPlayable, type DeckCardEntry } from "../src/modules/decks/decks.service.js";
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
    expect(await checkDeckPlayable(owner.id, deck.id)).toMatch(/Mazo invalido/);
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
