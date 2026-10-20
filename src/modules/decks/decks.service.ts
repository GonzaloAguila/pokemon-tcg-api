/**
 * Deck CRUD Service
 *
 * Handles user deck creation, validation, and management.
 */

import type { Prisma } from "@prisma/client";
import { findCardById, getDeckById as getThemeDeckById, isLimitedInDeck, isPlayableAsBasic, resolveDeck } from "@gonzaloaguila/game-core";
import { isReleasedCard } from "../../lib/released-sets.js";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeckCardEntry {
  cardDefId: string;
  quantity: number;
  variantId?: string;
}

const DECK_SLOT_PRICE = 500;
const MIN_DECK_SIZE = 60;
const MAX_COPIES_PER_CARD = 4;
export const NO_BASIC_ERROR = "El mazo necesita al menos un Pokémon básico";
/** A card of a set still in development (game-core `inDevelopment`) can't be in a deck yet. */
export const UNRELEASED_CARD_ERROR = (name: string) => `"${name}" pertenece a una expansión que todavía no está disponible`;

/**
 * Basic Energy is the only unlimited card (game-core isLimitedInDeck): special Energy (Double
 * Colorless, Rainbow, Full Heal, Potion Energy) is limited to 4 like any other card. Unknown
 * card ids count as limited.
 */
function isUnlimited(cardDefId: string): boolean {
  const card = findCardById(cardDefId);
  return !!card && !isLimitedInDeck(card);
}

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

  // Max copies per limited card, summed over entries (one card can appear once per variant).
  // Counted per card id like the frontend deck builder: every special Energy name has a
  // single id, so that is also "by name" for them. Same-name cards of different sets (Base Set
  // and Jungle Pikachu) are still counted apart — changing that would invalidate saved decks.
  const copies = new Map<string, number>();
  for (const entry of cards) {
    if (isUnlimited(entry.cardDefId)) continue;
    copies.set(entry.cardDefId, (copies.get(entry.cardDefId) ?? 0) + entry.quantity);
  }
  for (const [cardDefId, quantity] of copies) {
    if (quantity > MAX_COPIES_PER_CARD) {
      const name = findCardById(cardDefId)?.name ?? cardDefId;
      errors.push(`Máximo ${MAX_COPIES_PER_CARD} copias de "${name}" (tiene ${quantity})`);
    }
  }

  // A deck needs a card to start with: at least one card playable as a Basic Pokémon
  // (game-core isPlayableAsBasic: Basic Pokémon, Mysterious Fossil, Clefairy Doll). Without one
  // the opening mulligans forever.
  const hasBasic = cards.some((entry) => {
    const card = findCardById(entry.cardDefId);
    return entry.quantity > 0 && !!card && isPlayableAsBasic(card);
  });
  if (!hasBasic) errors.push(NO_BASIC_ERROR);

  for (const entry of cards) {
    const card = findCardById(entry.cardDefId);
    if (card && !isReleasedCard(card)) {
      errors.push(UNRELEASED_CARD_ERROR(card.name));
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Cards the user doesn't own enough copies of (basic energy is unlimited).
 * Entries can repeat a cardDefId with different variants, so quantities are summed.
 */
async function findCollectionShortfalls(userId: string, cards: DeckCardEntry[]): Promise<string[]> {
  const needed = new Map<string, number>();
  for (const entry of cards) {
    if (isUnlimited(entry.cardDefId)) continue;
    needed.set(entry.cardDefId, (needed.get(entry.cardDefId) ?? 0) + entry.quantity);
  }
  if (needed.size === 0) return [];

  const owned = await prisma.userCard.findMany({
    where: { userId, cardDefId: { in: [...needed.keys()] } },
    select: { cardDefId: true, quantity: true },
  });
  const ownedById = new Map(owned.map((c) => [c.cardDefId, c.quantity]));

  const errors: string[] = [];
  for (const [cardDefId, quantity] of needed) {
    const have = ownedById.get(cardDefId) ?? 0;
    if (have < quantity) errors.push(`No tienes suficientes copias de "${cardDefId}" (${have}/${quantity})`);
  }
  return errors;
}

/** Deck rules plus collection ownership. */
export async function validateDeckForUser(userId: string, cards: DeckCardEntry[]) {
  const rules = validateDeckCards(cards);
  const shortfalls = await findCollectionShortfalls(userId, cards);
  const errors = [...rules.errors, ...shortfalls];
  return { valid: errors.length === 0, errors };
}

/**
 * Whether `deckId` can be used by `userId` in a game. Theme decks (non-UUID ids) are
 * public; user decks must belong to the player and pass validation against the
 * current collection. Returns an error message, or null when playable.
 */
export async function checkDeckPlayable(userId: string, deckId: string | undefined | null): Promise<string | null> {
  // A seat in a room always needs a deck (a room without one started with default theme decks)
  if (!deckId) return "Debes elegir un mazo";
  if (!UUID_RE.test(deckId)) {
    const theme = getThemeDeckById(deckId);
    if (!theme) return "Mazo no encontrado";
    const unreleased = resolveDeck(theme).find((entry) => !isReleasedCard(entry.card));
    return unreleased ? `Mazo inválido: ${UNRELEASED_CARD_ERROR(unreleased.card.name)}` : null;
  }
  const deck = await prisma.deck.findFirst({ where: { id: deckId, userId }, select: { cards: true } });
  if (!deck) return "Mazo no encontrado";
  const validation = await validateDeckForUser(userId, (deck.cards ?? []) as unknown as DeckCardEntry[]);
  return validation.valid ? null : `Mazo inválido: ${validation.errors[0]}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * isValid as stored (rules + ownership when saved) AND the current rules: decks saved before a
 * rule existed (e.g. no Basic Pokémon) show as invalid without a migration.
 */
function withCurrentRules<T extends { isValid: boolean; cards: Prisma.JsonValue }>(deck: T): T {
  if (!deck.isValid) return deck;
  const rules = validateDeckCards((deck.cards ?? []) as unknown as DeckCardEntry[]);
  return rules.valid ? deck : { ...deck, isValid: false };
}

export async function getUserDecks(userId: string) {
  const decks = await prisma.deck.findMany({
    where: { userId },
    select: deckSelect,
    orderBy: { createdAt: "asc" },
  });
  return decks.map(withCurrentRules);
}

export async function getDeckById(userId: string, deckId: string) {
  const deck = await prisma.deck.findFirst({
    where: { id: deckId, userId },
    select: deckSelect,
  });

  if (!deck) throw Errors.NotFound("Mazo");
  return withCurrentRules(deck);
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
      `Has alcanzado el límite de ${user.maxDeckSlots} mazos. Compra un slot adicional.`,
    );
  }

  // Validate deck (rules + collection ownership)
  const validation = await validateDeckForUser(userId, data.cards);

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
    const validation = await validateDeckForUser(userId, data.cards);
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
  // Charge and grant in one transaction so a failure can't take coins without the slot.
  return prisma.$transaction(async (tx) => {
    await usersService.spendCoins(
      userId,
      DECK_SLOT_PRICE,
      "deck_slot_purchase",
      "Compra de slot de mazo adicional",
      tx,
    );

    return tx.user.update({
      where: { id: userId },
      data: { maxDeckSlots: { increment: 1 } },
      select: { maxDeckSlots: true, coins: true },
    });
  });
}
