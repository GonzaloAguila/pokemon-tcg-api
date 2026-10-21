import { UNSUPPORTED_TRAINERS, findCardById, isPokemonCard, isTrainerCard, type Card } from "@gonzaloaguila/game-core";
import { isReleasedCard } from "../../../lib/released-sets.js";

/**
 * Why a catalog id can't be used in an adventure, or null: unknown id, a set still in development
 * or a Trainer the engine doesn't implement. Same rule as game-core 0.10.0's
 * `isAdventureCardAllowed` (swap when the API moves to it).
 */
export function adventureCardProblem(cardId: string): string | null {
  const card = findCardById(cardId);
  if (!card) return `carta desconocida ${cardId}`;
  if (!isReleasedCard(card)) return `${card.name} (${cardId}) es de un set en desarrollo`;
  if (isTrainerCard(card) && UNSUPPORTED_TRAINERS.includes(card.name)) return `${card.name} no está implementada`;
  return null;
}

/** The catalog card of an id the content validator already accepted. */
export function cardOf(cardId: string): Card {
  const card = findCardById(cardId);
  if (!card) throw new Error(`Unknown card id ${cardId}`);
  return card;
}

export function cardName(cardId: string): string {
  return findCardById(cardId)?.name ?? cardId;
}

export function isBasicPokemonCard(card: Card): boolean {
  return isPokemonCard(card) && card.stage === "basic";
}

/** "a", "a y b", "a, b y c". */
export function joinSpanish(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}
