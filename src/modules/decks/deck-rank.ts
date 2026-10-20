/**
 * Deck rank F–S shown on a lobby table (the deck itself is never revealed): the average points
 * per card (card_values overrides, else the rarity defaults, see trades/card-values.ts) over the
 * deck without its basic Energy, against the thresholds in ECONOMY.lobby.deckRank.
 */

import { findCardById, findCardDefinition, getDeckById as getThemeDeckById, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { ECONOMY } from "../economy/config.js";
import { cardTradeValue } from "../trades/card-values.js";
import type { DeckCardEntry } from "./decks.service.js";

export const DECK_RANKS = ["S", "A", "B", "C", "D", "E", "F"] as const;
export type DeckRank = (typeof DECK_RANKS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Average points per card, basic Energy left out (null: nothing but basic Energy / unknown cards). */
export function deckAveragePoints(cardDefIds: string[]): number | null {
  let total = 0;
  let count = 0;
  for (const id of cardDefIds) {
    const card = findCardById(id);
    if (!card || isBasicEnergy(card)) continue;
    total += cardTradeValue(id) ?? 0;
    count++;
  }
  return count > 0 ? total / count : null;
}

/** The rank of an average (ECONOMY.lobby.deckRank: the first threshold it reaches, else F). */
export function rankForAverage(average: number): DeckRank {
  const t = ECONOMY.lobby.deckRank;
  if (average >= t.S) return "S";
  if (average >= t.A) return "A";
  if (average >= t.B) return "B";
  if (average >= t.C) return "C";
  if (average >= t.D) return "D";
  if (average >= t.E) return "E";
  return "F";
}

export function rankForCards(cardDefIds: string[]): DeckRank | null {
  const average = deckAveragePoints(cardDefIds);
  return average === null ? null : rankForAverage(average);
}

/**
 * Name and catalog card ids (one per copy) of a deck the user may play: their DB deck (UUID) or
 * a theme deck. Null when it doesn't exist / isn't theirs.
 */
export async function loadDeckCards(userId: string, deckId: string): Promise<{ name: string; cardDefIds: string[] } | null> {
  if (UUID_RE.test(deckId)) {
    const deck = await prisma.deck.findFirst({ where: { id: deckId, userId }, select: { name: true, cards: true } });
    if (!deck) return null;
    const entries = (deck.cards ?? []) as unknown as DeckCardEntry[];
    return { name: deck.name, cardDefIds: entries.flatMap((e) => Array<string>(e.quantity).fill(e.cardDefId)) };
  }
  const theme = getThemeDeckById(deckId);
  if (!theme) return null;
  const cardDefIds: string[] = [];
  for (const entry of theme.cards) {
    const template = findCardDefinition(entry.set, entry.cardNumber);
    if (template) for (let i = 0; i < entry.quantity; i++) cardDefIds.push(template.id);
  }
  return { name: theme.name, cardDefIds };
}

/** A table's deck as its creator sees it in `myRooms` (name) and the lobby sees it (rank). */
export async function describeDeck(userId: string, deckId: string): Promise<{ name: string | null; rank: DeckRank | null }> {
  const deck = await loadDeckCards(userId, deckId);
  if (!deck) return { name: null, rank: null };
  return { name: deck.name, rank: rankForCards(deck.cardDefIds) };
}
