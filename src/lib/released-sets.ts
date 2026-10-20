/**
 * Sets players can see and get. game-core registers a set as soon as its cards are cataloged and
 * flags it `inDevelopment` until its effects are done (Gym Challenge while it is being built);
 * such a set is never sold, listed, granted, drafted or accepted in a deck, so production keeps
 * behaving as before until the engine release clears the flag.
 */
import { ALL_CARDS, CARD_SETS, getSetForCard, type Card, type CardSetInfo } from "@gonzaloaguila/game-core";

/** game-core's CARD_SETS without the sets still in development, in registry order. */
export const RELEASED_SETS: readonly CardSetInfo[] = CARD_SETS.filter((set) => !set.inDevelopment);

const RELEASED_SET_IDS = new Set<string>(RELEASED_SETS.map((set) => set.id));

export function isReleasedSet(setId: string): boolean {
  return RELEASED_SET_IDS.has(setId);
}

/** Whether a card (catalog or in-game, by its `set`) belongs to a released set. */
export function isReleasedCard(card: Pick<Card, "set">): boolean {
  const setId = getSetForCard(card)?.id;
  return setId !== undefined && RELEASED_SET_IDS.has(setId);
}

/** game-core's ALL_CARDS without the cards of sets still in development. */
export const RELEASED_CARDS: readonly Card[] = ALL_CARDS.filter(isReleasedCard);
