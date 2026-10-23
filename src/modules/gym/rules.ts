/**
 * A Gym Leader's rules for the challenger's deck (docs/gym-leaders.md): banned types (no Pokémon
 * with any of them among its `types`, no basic Energy of them) and an exact composition (Pokémon /
 * Trainers / Energy; Trainers played as Basics — Mysterious Fossil, Clefairy Doll — are Trainers,
 * Energy = basic + special). Pure: the normal deck rules (60 cards, copies, ownership) are
 * checkDeckPlayable's.
 */
import { findCardById, getEnergyTypeInSpanish, isBasicEnergy, isEnergyCard, isPokemonCard, isTrainerCard } from "@gonzaloaguila/game-core";
import type { BannableType, CardEntry, GymComposition, GymRules } from "./content/types.js";

/** "Pokémon de tipo …" (getEnergyTypeInSpanish speaks of Energy: "Eléctrica", "Psíquica"). */
const POKEMON_TYPE_ES: Record<BannableType, string> = {
  grass: "Planta",
  fire: "Fuego",
  water: "Agua",
  lightning: "Eléctrico",
  psychic: "Psíquico",
  fighting: "Lucha",
};

export function pokemonTypeLabel(type: BannableType): string {
  return POKEMON_TYPE_ES[type];
}

export function energyTypeLabel(type: BannableType): string {
  return getEnergyTypeInSpanish(type);
}

/** How many Pokémon, Trainers and Energy cards the deck list has (unknown ids are not counted). */
export function deckComposition(entries: readonly CardEntry[]): GymComposition {
  const counts: GymComposition = { pokemon: 0, trainer: 0, energy: 0 };
  for (const entry of entries) {
    const card = findCardById(entry.cardId);
    if (!card) continue;
    if (isPokemonCard(card)) counts.pokemon += entry.qty;
    else if (isTrainerCard(card)) counts.trainer += entry.qty;
    else if (isEnergyCard(card)) counts.energy += entry.qty;
  }
  return counts;
}

/** Every rule the deck breaks (Spanish, in a stable order), empty when it follows them all. */
export function gymRuleErrors(entries: readonly CardEntry[], rules: GymRules): string[] {
  const errors: string[] = [];
  const unknown = entries.find((entry) => !findCardById(entry.cardId));
  if (unknown) errors.push(`Carta desconocida: ${unknown.cardId}`);

  const present = entries.filter((entry) => entry.qty > 0).map((entry) => findCardById(entry.cardId)).filter((card) => !!card);
  for (const type of rules.bannedTypes) {
    if (present.some((card) => isPokemonCard(card) && (card.types as string[]).includes(type))) {
      errors.push(`Tu mazo no puede tener Pokémon de tipo ${pokemonTypeLabel(type)}`);
    }
  }
  for (const type of rules.bannedTypes) {
    if (present.some((card) => isEnergyCard(card) && isBasicEnergy(card) && card.energyType === type)) {
      errors.push(`Tu mazo no puede tener Energía ${energyTypeLabel(type)} básica`);
    }
  }

  if (rules.composition) {
    const counts = deckComposition(entries);
    const wanted = rules.composition;
    if (counts.pokemon !== wanted.pokemon) errors.push(`Tu mazo debe tener exactamente ${wanted.pokemon} Pokémon (tiene ${counts.pokemon})`);
    if (counts.trainer !== wanted.trainer) errors.push(`Tu mazo debe tener exactamente ${wanted.trainer} Entrenadores (tiene ${counts.trainer})`);
    if (counts.energy !== wanted.energy) errors.push(`Tu mazo debe tener exactamente ${wanted.energy} Energías (tiene ${counts.energy})`);
  }
  return errors;
}

/** The first rule the deck breaks, or null. */
export function checkGymRules(entries: readonly CardEntry[], rules: GymRules): string | null {
  return gymRuleErrors(entries, rules)[0] ?? null;
}

/**
 * The rules in plain Spanish for a table / the admin panel: "Sin Pokémon ni Energía básica de tipo
 * Planta o Agua", "Exactamente 20 Pokémon, 20 Entrenadores y 20 Energías".
 */
export function describeGymRules(rules: GymRules): string[] {
  const lines: string[] = [];
  if (rules.bannedTypes.length > 0) {
    const names = rules.bannedTypes.map(pokemonTypeLabel);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} o ${names.at(-1)}`;
    lines.push(`Sin Pokémon ni Energía básica de tipo ${list}`);
  }
  if (rules.composition) {
    const { pokemon, trainer, energy } = rules.composition;
    lines.push(`Exactamente ${pokemon} Pokémon, ${trainer} Entrenadores y ${energy} Energías`);
  }
  return lines;
}
