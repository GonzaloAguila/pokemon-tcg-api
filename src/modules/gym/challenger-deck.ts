/**
 * The challenger's deck for a gym battle: the normal deck rules (checkDeckPlayable: 60 cards,
 * copies, owned cards, released sets) plus the leader's rules (rules.ts), as the deck list the
 * battle is built from. User decks are DB UUIDs; theme decks (game-core ids) play only if they
 * pass the same gym rules.
 */
import { findCardDefinition, getDeckById as getThemeDeckById } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { checkDeckPlayable, type DeckCardEntry } from "../decks/decks.service.js";
import type { DeckSource } from "../achievements/challenge-decks.js";
import type { CardEntry, GymRules } from "./content/types.js";
import { checkGymRules } from "./rules.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sum quantities per card id (a user deck repeats a card once per variant). */
function merge(entries: CardEntry[]): CardEntry[] {
  const byId = new Map<string, number>();
  for (const entry of entries) byId.set(entry.cardId, (byId.get(entry.cardId) ?? 0) + entry.qty);
  return [...byId].map(([cardId, qty]) => ({ cardId, qty }));
}

/** Where the challenger's deck comes from, for the challenge achievements (only "user" decks count). */
export const challengerDeckSource = (deckId: string): DeckSource => (UUID_RE.test(deckId) ? "user" : "theme");

/** The deck as a card list (user deck of `userId`, or a theme deck), null when not found. */
export async function loadDeckEntries(userId: string, deckId: string): Promise<CardEntry[] | null> {
  if (UUID_RE.test(deckId)) {
    const deck = await prisma.deck.findFirst({ where: { id: deckId, userId }, select: { cards: true } });
    if (!deck) return null;
    const cards = (deck.cards ?? []) as unknown as DeckCardEntry[];
    return merge(cards.filter((c) => c.quantity > 0).map((c) => ({ cardId: c.cardDefId, qty: c.quantity })));
  }
  const theme = getThemeDeckById(deckId);
  if (!theme) return null;
  const entries: CardEntry[] = [];
  for (const entry of theme.cards) {
    const card = findCardDefinition(entry.set, entry.cardNumber);
    if (!card) return null;
    entries.push({ cardId: card.id, qty: entry.quantity });
  }
  return merge(entries);
}

/** The deck list when the user may challenge a leader's version (its `rules`) with it, else the first reason (Spanish). */
export async function checkChallengerDeck(
  userId: string,
  deckId: string,
  rules: GymRules,
): Promise<{ ok: true; entries: CardEntry[] } | { ok: false; error: string }> {
  const playable = await checkDeckPlayable(userId, deckId);
  if (playable) return { ok: false, error: playable };
  const entries = await loadDeckEntries(userId, deckId);
  if (!entries) return { ok: false, error: "Mazo no encontrado" };
  const ruleError = checkGymRules(entries, rules);
  return ruleError ? { ok: false, error: ruleError } : { ok: true, entries };
}
