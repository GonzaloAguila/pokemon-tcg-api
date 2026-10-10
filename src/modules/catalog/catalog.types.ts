/**
 * Catalog module types
 */

export interface SetInfo {
  id: string;
  name: string;
  code: string;
  releaseDate: string;
  totalCards: number;
  /** Cards printed in the set, holo/non-holo duplicates included (Fossil: 62) */
  printedTotal: number;
}

export interface CardListResponse {
  setId: string;
  cards: unknown[]; // Card type from game-core
  total: number;
}

export interface DeckListItem {
  id: string;
  name: string;
  image: string;
  cardCount: number;
  energyTypes: string[];
}
