/**
 * Deck rules of the challenge achievements (docs: frontend repo
 * docs/superpowers/specs/2026-10-23-challenge-achievements-design.md, "Definiciones comunes"):
 * pure functions over the deck a game was played with, as game-core catalog ids.
 *
 * - A Trainer playable as a Basic (Clefairy Doll, Mysterious Fossil) is a Trainer.
 * - Basic Energy = the 6 typed basic Energy cards; special Energy (Double Colorless, Rainbow...)
 *   defines no type. Colorless is not a type for monotype, rainbow and two-colour decks.
 * - A card's set comes from getSetForCard; basic Energy counts for no set.
 * - A Pokémon's Leader is the owner prefix of its name ("Brock's Geodude"); "Rocket's" is no Leader.
 */
import { CardRarity, findCardById, getSetForCard, isBasicEnergy, type Card } from "@gonzaloaguila/game-core";

/** One line of a deck: a catalog id and its copies. */
export interface DeckEntry {
  cardId: string;
  qty: number;
}

/** Where a game's deck came from; only "user" and "draft" decks count for the challenges. */
export type DeckSource = "user" | "draft" | "theme" | "fallback" | "lucky-duel";

/** The deck a player played a multiplayer game with (Match.player1Deck / player2Deck). */
export interface DeckSnapshot {
  source: DeckSource;
  cards: DeckEntry[];
}

export const GYM_LEADERS: readonly string[] = ["Brock", "Misty", "Erika", "Lt. Surge", "Sabrina", "Blaine", "Koga", "Giovanni"];

const COLORLESS = "colorless";

/** The catalog cards of a deck (unknown ids skipped), one per entry. */
function cardsOf(entries: DeckEntry[]): Card[] {
  return entries.flatMap((entry) => {
    const card = entry.qty > 0 ? findCardById(entry.cardId) : undefined;
    return card ? [card] : [];
  });
}

const pokemonOf = (entries: DeckEntry[]) => cardsOf(entries).filter((c) => c.kind === "pokemon");
const typesOf = (card: Card): string[] => ("types" in card && Array.isArray(card.types) ? (card.types as string[]) : []);
const isEvolution = (card: Card) => "stage" in card && (card.stage === "stage-1" || card.stage === "stage-2");

/** The Leader a card's name belongs to ("Lt. Surge's Raticate" → "Lt. Surge"), or null. */
function leaderOf(name: string): string | null {
  return GYM_LEADERS.find((leader) => name.startsWith(`${leader}'s `)) ?? null;
}

export function isNoTrainers(cards: DeckEntry[]): boolean {
  return cardsOf(cards).every((c) => c.kind !== "trainer");
}

/** One basic Energy type in the deck, and every Pokémon of that type or Colorless. */
export function isMonotype(cards: DeckEntry[]): boolean {
  const energyTypes = basicEnergyTypes(cards);
  if (energyTypes.length !== 1) return false;
  return pokemonOf(cards).every((c) => typesOf(c).every((t) => t === energyTypes[0] || t === COLORLESS));
}

export function isBasicsOnly(cards: DeckEntry[]): boolean {
  return pokemonOf(cards).every((c) => !isEvolution(c));
}

/** No rare nor rare holo card. */
export function isBudget(cards: DeckEntry[]): boolean {
  return cardsOf(cards).every((c) => c.rarity !== CardRarity.Rare && c.rarity !== CardRarity.RareHolo);
}

/** The set every card but basic Energy belongs to, or null when there are several (or none). */
export function singleSetOf(cards: DeckEntry[]): string | null {
  const sets = setsOf(cards);
  return sets.size === 1 ? [...sets][0] : null;
}

/** At least one Stage 1 / Stage 2, and every one of them a "Dark" Pokémon. */
export function isDarkEvolutions(cards: DeckEntry[]): boolean {
  const evolutions = pokemonOf(cards).filter(isEvolution);
  return evolutions.length > 0 && evolutions.every((c) => c.name.startsWith("Dark "));
}

/** The Leaders with at least `min` Pokémon cards in the deck, in GYM_LEADERS order. */
export function leadersWithAtLeast(cards: DeckEntry[], min: number): string[] {
  const counts = new Map<string, number>();
  for (const entry of cards) {
    const card = findCardById(entry.cardId);
    const leader = card?.kind === "pokemon" ? leaderOf(card.name) : null;
    if (leader) counts.set(leader, (counts.get(leader) ?? 0) + entry.qty);
  }
  return GYM_LEADERS.filter((leader) => (counts.get(leader) ?? 0) >= min);
}

/** The distinct types of the deck's basic Energy, sorted. */
export function basicEnergyTypes(cards: DeckEntry[]): string[] {
  const types = new Set(cardsOf(cards).filter(isBasicEnergy).map((c) => String((c as { energyType?: string }).energyType)));
  return [...types].sort();
}

/** Distinct types among the deck's Pokémon (Colorless not counted). */
export function pokemonTypeCount(cards: DeckEntry[]): number {
  return new Set(pokemonOf(cards).flatMap(typesOf).filter((t) => t !== COLORLESS)).size;
}

/** Distinct sets of the deck's cards (basic Energy not counted). */
export function setCount(cards: DeckEntry[]): number {
  return setsOf(cards).size;
}

function setsOf(cards: DeckEntry[]): Set<string> {
  const sets = new Set<string>();
  for (const card of cardsOf(cards)) {
    if (isBasicEnergy(card)) continue;
    const set = getSetForCard(card);
    if (set) sets.add(set.id);
  }
  return sets;
}

/** A Pokémon's name without its Leader's prefix ("Misty's Seaking" → "Seaking"); other names unchanged. */
export function baseName(cardName: string): string {
  const leader = leaderOf(cardName);
  return leader ? cardName.slice(leader.length + 3) : cardName;
}
