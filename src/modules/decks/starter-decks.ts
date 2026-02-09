/**
 * Starter Deck Definitions
 *
 * Each new user picks a color on signup and receives one of these decks.
 * All decks share the same trainer base (16 cards) and total 60 cards.
 * Decks include cards from both Base Set and Jungle.
 */

import type { DeckCardEntry } from "./decks.service.js";

// ---------------------------------------------------------------------------
// Shared trainer base (16 cards)
// ---------------------------------------------------------------------------

const TRAINER_BASE: DeckCardEntry[] = [
  { cardDefId: "base-set-088-professor-oak", quantity: 1 },
  { cardDefId: "base-set-091-bill", quantity: 2 },
  { cardDefId: "base-set-094-potion", quantity: 2 },
  { cardDefId: "base-set-090-super-potion", quantity: 1 },
  { cardDefId: "base-set-080-defender", quantity: 2 },
  { cardDefId: "base-set-084-pluspower", quantity: 1 },
  { cardDefId: "base-set-095-switch", quantity: 2 },
  { cardDefId: "base-set-093-gust-of-wind", quantity: 2 },
  { cardDefId: "base-set-083-maintenance", quantity: 3 },
];

// ---------------------------------------------------------------------------
// Fire Deck — Ninetales + Flareon (21 pokemon + 23 energy)
// ---------------------------------------------------------------------------

const FIRE_DECK: DeckCardEntry[] = [
  ...TRAINER_BASE,
  // Main family: Ninetales
  { cardDefId: "base-set-068-vulpix", quantity: 4 },
  { cardDefId: "base-set-012-ninetales", quantity: 2 },
  // Secondary family: Charmeleon
  { cardDefId: "base-set-046-charmander", quantity: 4 },
  { cardDefId: "base-set-024-charmeleon", quantity: 2 },
  // Fillers
  { cardDefId: "base-set-036-magmar", quantity: 3 },
  { cardDefId: "base-set-028-growlithe", quantity: 1 },
  // Jungle: Flareon line
  { cardDefId: "jungle-051-eevee", quantity: 4 },
  { cardDefId: "jungle-003-flareon", quantity: 1 },
  // Energy
  { cardDefId: "base-set-098-fire-energy", quantity: 23 },
];

// ---------------------------------------------------------------------------
// Water Deck — Poliwrath + Vaporeon (22 pokemon + 22 energy)
// ---------------------------------------------------------------------------

const WATER_DECK: DeckCardEntry[] = [
  ...TRAINER_BASE,
  // Main family: Poliwrath (Stage 2)
  { cardDefId: "base-set-059-poliwag", quantity: 4 },
  { cardDefId: "base-set-038-poliwhirl", quantity: 3 },
  { cardDefId: "base-set-013-poliwrath", quantity: 2 },
  // Secondary family: Wartortle
  { cardDefId: "base-set-063-squirtle", quantity: 4 },
  { cardDefId: "base-set-042-wartortle", quantity: 2 },
  // Fillers
  { cardDefId: "base-set-041-seel", quantity: 3 },
  { cardDefId: "base-set-025-dewgong", quantity: 1 },
  // Jungle: Goldeen + Seaking
  { cardDefId: "jungle-053-goldeen", quantity: 2 },
  { cardDefId: "jungle-046-seaking", quantity: 1 },
  // Energy
  { cardDefId: "base-set-102-water-energy", quantity: 22 },
];

// ---------------------------------------------------------------------------
// Grass Deck — Beedrill + Victreebel (22 pokemon + 22 energy)
// ---------------------------------------------------------------------------

const GRASS_DECK: DeckCardEntry[] = [
  ...TRAINER_BASE,
  // Main family: Beedrill (Stage 2)
  { cardDefId: "base-set-069-weedle", quantity: 4 },
  { cardDefId: "base-set-033-kakuna", quantity: 3 },
  { cardDefId: "base-set-017-beedrill", quantity: 2 },
  // Secondary family: Ivysaur
  { cardDefId: "base-set-044-bulbasaur", quantity: 4 },
  { cardDefId: "base-set-030-ivysaur", quantity: 2 },
  // Fillers
  { cardDefId: "base-set-066-tangela", quantity: 3 },
  // Jungle: Bellsprout + Weepinbell + Paras
  { cardDefId: "jungle-049-bellsprout", quantity: 2 },
  { cardDefId: "jungle-048-weepinbell", quantity: 1 },
  { cardDefId: "jungle-059-paras", quantity: 1 },
  // Energy
  { cardDefId: "base-set-099-grass-energy", quantity: 22 },
];

// ---------------------------------------------------------------------------
// Electric Deck — Raichu + Jolteon (20 pokemon + 24 energy)
// ---------------------------------------------------------------------------

const ELECTRIC_DECK: DeckCardEntry[] = [
  ...TRAINER_BASE,
  // Main family: Raichu
  { cardDefId: "base-set-058-pikachu", quantity: 4 },
  { cardDefId: "base-set-014-raichu", quantity: 2 },
  // Secondary family: Magneton
  { cardDefId: "base-set-053-magnemite", quantity: 4 },
  { cardDefId: "base-set-009-magneton", quantity: 2 },
  // Fillers
  { cardDefId: "base-set-067-voltorb", quantity: 4 },
  { cardDefId: "base-set-020-electabuzz", quantity: 1 },
  // Jungle: Jolteon line
  { cardDefId: "jungle-051-eevee", quantity: 2 },
  { cardDefId: "jungle-004-jolteon", quantity: 1 },
  // Energy
  { cardDefId: "base-set-100-lightning-energy", quantity: 24 },
];

// ---------------------------------------------------------------------------
// Psychic Deck — Kadabra + Mr. Mime (22 pokemon + 22 energy)
// ---------------------------------------------------------------------------

const PSYCHIC_DECK: DeckCardEntry[] = [
  ...TRAINER_BASE,
  // Main family: Kadabra
  { cardDefId: "base-set-043-abra", quantity: 4 },
  { cardDefId: "base-set-032-kadabra", quantity: 3 },
  // Secondary family: Dragonair
  { cardDefId: "base-set-026-dratini", quantity: 3 },
  { cardDefId: "base-set-018-dragonair", quantity: 2 },
  // Fillers
  { cardDefId: "base-set-050-gastly", quantity: 3 },
  { cardDefId: "base-set-029-haunter", quantity: 2 },
  // Jungle: Mr. Mime + Exeggutor line
  { cardDefId: "jungle-006-mr-mime", quantity: 1 },
  { cardDefId: "jungle-052-exeggcute", quantity: 2 },
  { cardDefId: "jungle-035-exeggutor", quantity: 2 },
  // Energy
  { cardDefId: "base-set-101-psychic-energy", quantity: 22 },
];

// ---------------------------------------------------------------------------
// Fighting Deck — Machoke + Primeape (22 pokemon + 22 energy)
// ---------------------------------------------------------------------------

const FIGHTING_DECK: DeckCardEntry[] = [
  ...TRAINER_BASE,
  // Main family: Machoke
  { cardDefId: "base-set-052-machop", quantity: 4 },
  { cardDefId: "base-set-034-machoke", quantity: 3 },
  // Secondary family: Pidgeotto
  { cardDefId: "base-set-057-pidgey", quantity: 4 },
  { cardDefId: "base-set-022-pidgeotto", quantity: 2 },
  // Fillers
  { cardDefId: "base-set-062-sandshrew", quantity: 3 },
  { cardDefId: "base-set-056-onix", quantity: 2 },
  { cardDefId: "base-set-007-hitmonchan", quantity: 1 },
  // Jungle: Mankey + Primeape
  { cardDefId: "jungle-055-mankey", quantity: 2 },
  { cardDefId: "jungle-043-primeape", quantity: 1 },
  // Energy
  { cardDefId: "base-set-097-fighting-energy", quantity: 22 },
];

// ---------------------------------------------------------------------------
// Color → Deck mapping
// ---------------------------------------------------------------------------

export type StarterColor =
  | "fire"
  | "water"
  | "grass"
  | "electric"
  | "psychic"
  | "fighting";

const STARTER_DECK_NAMES: Record<StarterColor, string> = {
  fire: "Mazo Inicial — Fuego",
  water: "Mazo Inicial — Agua",
  grass: "Mazo Inicial — Planta",
  electric: "Mazo Inicial — Electrico",
  psychic: "Mazo Inicial — Psiquico",
  fighting: "Mazo Inicial — Lucha",
};

const STARTER_DECKS: Record<StarterColor, DeckCardEntry[]> = {
  fire: FIRE_DECK,
  water: WATER_DECK,
  grass: GRASS_DECK,
  electric: ELECTRIC_DECK,
  psychic: PSYCHIC_DECK,
  fighting: FIGHTING_DECK,
};

export function getStarterDeck(color: StarterColor): {
  name: string;
  cards: DeckCardEntry[];
} {
  return {
    name: STARTER_DECK_NAMES[color],
    cards: STARTER_DECKS[color],
  };
}
