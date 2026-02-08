/**
 * Deck CRUD Service
 *
 * Handles user deck creation, validation, and management.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeckCardEntry {
  cardDefId: string;
  quantity: number;
}

const DECK_SLOT_PRICE = 500;
const MIN_DECK_SIZE = 60;
const MAX_COPIES_PER_CARD = 4;

// Basic energy card IDs (unlimited copies allowed)
const BASIC_ENERGY_IDS = new Set([
  "base-set-097-fire-energy",
  "base-set-098-grass-energy",
  "base-set-099-lightning-energy",
  "base-set-100-psychic-energy",
  "base-set-101-fighting-energy",
  "base-set-102-water-energy",
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDeckCards(cards: DeckCardEntry[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check total card count
  const totalCards = cards.reduce((sum, c) => sum + c.quantity, 0);
  if (totalCards !== MIN_DECK_SIZE) {
    errors.push(
      `El mazo debe tener exactamente ${MIN_DECK_SIZE} cartas (tiene ${totalCards})`,
    );
  }

  // Check max copies per non-energy card
  for (const entry of cards) {
    if (
      !BASIC_ENERGY_IDS.has(entry.cardDefId) &&
      entry.quantity > MAX_COPIES_PER_CARD
    ) {
      errors.push(
        `Maximo ${MAX_COPIES_PER_CARD} copias de "${entry.cardDefId}" (tiene ${entry.quantity})`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Deck select shape
// ---------------------------------------------------------------------------

const deckSelect = {
  id: true,
  name: true,
  cards: true,
  isValid: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function getUserDecks(userId: string) {
  return prisma.deck.findMany({
    where: { userId },
    select: deckSelect,
    orderBy: { createdAt: "asc" },
  });
}

export async function getDeckById(userId: string, deckId: string) {
  const deck = await prisma.deck.findFirst({
    where: { id: deckId, userId },
    select: deckSelect,
  });

  if (!deck) throw Errors.NotFound("Mazo");
  return deck;
}

export async function createDeck(
  userId: string,
  data: { name: string; cards: DeckCardEntry[] },
) {
  // Check slot limit
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { maxDeckSlots: true },
  });
  if (!user) throw Errors.NotFound("Usuario");

  const existingCount = await prisma.deck.count({ where: { userId } });
  if (existingCount >= user.maxDeckSlots) {
    throw Errors.BadRequest(
      `Has alcanzado el limite de ${user.maxDeckSlots} mazos. Compra un slot adicional.`,
    );
  }

  // Validate deck
  const validation = validateDeckCards(data.cards);

  return prisma.deck.create({
    data: {
      name: data.name,
      cards: JSON.parse(JSON.stringify(data.cards)) as Prisma.InputJsonValue,
      isValid: validation.valid,
      userId,
    },
    select: deckSelect,
  });
}

export async function updateDeck(
  userId: string,
  deckId: string,
  data: { name?: string; cards?: DeckCardEntry[] },
) {
  // Ownership check
  const existing = await prisma.deck.findFirst({
    where: { id: deckId, userId },
  });
  if (!existing) throw Errors.NotFound("Mazo");

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;

  if (data.cards !== undefined) {
    const validation = validateDeckCards(data.cards);
    updateData.cards = JSON.parse(JSON.stringify(data.cards)) as Prisma.InputJsonValue;
    updateData.isValid = validation.valid;
  }

  return prisma.deck.update({
    where: { id: deckId },
    data: updateData,
    select: deckSelect,
  });
}

export async function deleteDeck(userId: string, deckId: string) {
  const existing = await prisma.deck.findFirst({
    where: { id: deckId, userId },
  });
  if (!existing) throw Errors.NotFound("Mazo");

  await prisma.deck.delete({ where: { id: deckId } });
}

export async function setActiveDeck(userId: string, deckId: string) {
  // Ownership check
  const existing = await prisma.deck.findFirst({
    where: { id: deckId, userId },
  });
  if (!existing) throw Errors.NotFound("Mazo");

  // Deactivate all, then activate the target
  await prisma.$transaction([
    prisma.deck.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    }),
    prisma.deck.update({
      where: { id: deckId },
      data: { isActive: true },
    }),
  ]);

  return prisma.deck.findUnique({
    where: { id: deckId },
    select: deckSelect,
  });
}

// ---------------------------------------------------------------------------
// Deck Slot Purchase
// ---------------------------------------------------------------------------

export async function purchaseDeckSlot(userId: string) {
  // Spend coins (atomic with transaction log)
  await usersService.spendCoins(
    userId,
    DECK_SLOT_PRICE,
    "deck_slot_purchase",
    "Compra de slot de mazo adicional",
  );

  // Increment max slots
  const user = await prisma.user.update({
    where: { id: userId },
    data: { maxDeckSlots: { increment: 1 } },
    select: { maxDeckSlots: true, coins: true },
  });

  return user;
}
