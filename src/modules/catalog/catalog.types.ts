/**
 * Catalog module types
 */

export interface SetInfo {
  id: string;
  name: string;
  code: string;
  releaseDate: string;
  totalCards: number;
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
