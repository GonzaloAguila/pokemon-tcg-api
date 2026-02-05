/**
 * Catalog Service
 *
 * Provides access to card sets, individual cards, and theme decks.
 * Data comes from @poke-tcg/game-core package.
 */

import {
  baseSetCards,
  getBaseSetImageUrl,
  decks,
  getDeckById,
  resolveDeck,
  isPokemonCard,
  isEnergyCard,
  EnergyType,
  type Card,
  type Deck,
  type PokemonCard,
} from "@poke-tcg/game-core";

import type { SetInfo, DeckListItem } from "./catalog.types.js";

// =============================================================================
// Local Deck Helpers (not exported from game-core)
// =============================================================================

/**
 * Returns the unique energy types used by a deck
 */
function getDeckEnergyTypes(deck: Deck): EnergyType[] {
  const resolved = resolveDeck(deck);
  const types = new Set<EnergyType>();

  for (const entry of resolved) {
    if (isPokemonCard(entry.card)) {
      for (const t of entry.card.types) {
        if (t !== EnergyType.Colorless) types.add(t);
      }
    } else if (isEnergyCard(entry.card)) {
      if (entry.card.energyType !== EnergyType.Colorless) {
        types.add(entry.card.energyType);
      }
    }
  }

  return Array.from(types);
}

/**
 * Returns total card count in a deck
 */
function getDeckCardCount(deck: Deck): number {
  return deck.cards.reduce((sum, entry) => sum + entry.quantity, 0);
}

/**
 * Returns the featured Pokemon for deck display
 */
function getDeckFeaturedPokemon(deck: Deck, count: number = 3): PokemonCard[] {
  const resolved = resolveDeck(deck);

  // If deck has explicit featured Pokemon, use them
  if (deck.featuredPokemon) {
    const featured: PokemonCard[] = [];
    for (const cardNumber of deck.featuredPokemon) {
      const entry = resolved.find((e) => e.card.number === cardNumber);
      if (entry && isPokemonCard(entry.card)) {
        featured.push(entry.card);
      }
    }
    if (featured.length === count) {
      return featured;
    }
  }

  // Fallback: get first Pokemon cards
  const pokemon = resolved
    .filter((entry) => isPokemonCard(entry.card))
    .map((entry) => entry.card as PokemonCard);

  return pokemon.slice(0, count);
}

// =============================================================================
// Sets
// =============================================================================

const SETS: SetInfo[] = [
  {
    id: "base-set",
    name: "Base Set",
    code: "BS",
    releaseDate: "1999-01-09",
    totalCards: 102,
  },
];

/**
 * Get all available card sets
 */
export function getAllSets(): SetInfo[] {
  return SETS;
}

/**
 * Get a specific set by ID
 */
export function getSetById(setId: string): SetInfo | undefined {
  return SETS.find((s) => s.id === setId);
}

// =============================================================================
// Cards
// =============================================================================

/**
 * Get all cards in a set
 */
export function getCardsBySet(setId: string): Card[] {
  if (setId === "base-set") {
    return baseSetCards;
  }
  return [];
}

/**
 * Get a single card by ID (format: "base-set-1-alakazam")
 */
export function getCardById(cardId: string): Card | undefined {
  // Try to find in base set
  return baseSetCards.find((c) => c.id === cardId);
}

/**
 * Get a card by set and number
 */
export function getCardByNumber(setId: string, number: number): Card | undefined {
  if (setId === "base-set") {
    return baseSetCards.find((c) => c.number === number);
  }
  return undefined;
}

/**
 * Get image URL for a card
 */
export function getCardImageUrl(card: Card): string {
  return getBaseSetImageUrl(card);
}

/**
 * Search cards by name (case-insensitive partial match)
 */
export function searchCards(query: string, setId?: string): Card[] {
  const normalizedQuery = query.toLowerCase();
  const cards = setId ? getCardsBySet(setId) : baseSetCards;

  return cards.filter((c) => c.name.toLowerCase().includes(normalizedQuery));
}

/**
 * Filter cards by type/kind
 */
export function filterCards(
  setId: string,
  filters: {
    kind?: "pokemon" | "trainer" | "energy";
    type?: string;
    rarity?: string;
    stage?: string;
  }
): Card[] {
  let cards = getCardsBySet(setId);

  if (filters.kind) {
    cards = cards.filter((c) => c.kind === filters.kind);
  }

  if (filters.type && filters.kind === "pokemon") {
    cards = cards.filter(
      (c) => isPokemonCard(c) && c.types.includes(filters.type as EnergyType)
    );
  }

  if (filters.rarity) {
    cards = cards.filter((c) => c.rarity === filters.rarity);
  }

  if (filters.stage && filters.kind === "pokemon") {
    cards = cards.filter((c) => isPokemonCard(c) && c.stage === filters.stage);
  }

  return cards;
}

// =============================================================================
// Decks
// =============================================================================

/**
 * Get all theme decks (list view)
 */
export function getAllDecks(): DeckListItem[] {
  return decks.map((deck) => ({
    id: deck.id,
    name: deck.name,
    image: deck.image,
    cardCount: getDeckCardCount(deck),
    energyTypes: getDeckEnergyTypes(deck),
  }));
}

/**
 * Get a deck by ID (raw structure with card numbers)
 */
export function getDeck(deckId: string): Deck | undefined {
  return getDeckById(deckId);
}

/**
 * Get a deck with resolved cards (full card objects)
 */
export function getDeckResolved(deckId: string) {
  const deck = getDeckById(deckId);
  if (!deck) return undefined;

  const resolved = resolveDeck(deck);
  const featured = getDeckFeaturedPokemon(deck);

  return {
    id: deck.id,
    name: deck.name,
    image: deck.image,
    cardCount: getDeckCardCount(deck),
    energyTypes: getDeckEnergyTypes(deck),
    featuredPokemon: featured,
    cards: resolved.map((entry) => ({
      card: entry.card,
      quantity: entry.quantity,
    })),
  };
}
