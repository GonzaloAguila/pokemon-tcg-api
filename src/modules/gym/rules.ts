/**
 * A Gym Leader's rules for the challenger's deck (docs/gym-leaders.md, v2.1): banned Pokémon types
 * (Pokémon only: Energy is not restricted by type), banned owners ("Brock" = no "Brock's …"
 * Pokémon), no Stadium cards (the gym's own is always in play), at most N Trainers in total
 * (Trainers played as Basics — Mysterious Fossil, Clefairy Doll — count) and at most N copies of
 * each card by name (basic Energy exempt). Pure: the normal deck rules (60 cards, 4 copies,
 * ownership) are checkDeckPlayable's.
 */
import { findCardById, hasOwner, isBasicEnergy, isPokemonCard, isTrainerCard, type Card } from "@gonzaloaguila/game-core";
import type { BannableType, CardEntry, GymRules } from "./content/types.js";

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

/** "1 copia" / "2 copias". */
const copies = (n: number) => (n === 1 ? "1 copia" : `${n} copias`);

const isStadium = (card: Card) => isTrainerCard(card) && card.trainerType === "stadium";

/** "a, b o c" */
function orList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} o ${items.at(-1)}`;
}

/** The Trainer cards of the deck list (unknown ids are not counted). */
export function trainerCount(entries: readonly CardEntry[]): number {
  return entries.reduce((sum, entry) => {
    const card = findCardById(entry.cardId);
    return card && isTrainerCard(card) ? sum + entry.qty : sum;
  }, 0);
}

/** Every rule the deck breaks (Spanish, in a stable order), empty when it follows them all. */
export function gymRuleErrors(entries: readonly CardEntry[], rules: GymRules): string[] {
  const errors: string[] = [];
  const unknown = entries.find((entry) => !findCardById(entry.cardId));
  if (unknown) errors.push(`Carta desconocida: ${unknown.cardId}`);

  const present = entries.filter((entry) => entry.qty > 0).map((entry) => findCardById(entry.cardId)).filter((card) => !!card);
  for (const type of rules.bannedPokemonTypes) {
    const card = present.find((c) => isPokemonCard(c) && (c.types as string[]).includes(type));
    if (card) errors.push(`Tu mazo no puede tener Pokémon de tipo ${pokemonTypeLabel(type)} (${card.name})`);
  }
  for (const owner of rules.bannedOwners) {
    const card = present.find((c) => isPokemonCard(c) && hasOwner(c, owner));
    if (card) errors.push(`Tu mazo no puede tener Pokémon de ${owner} (${card.name})`);
  }
  if (rules.noStadiums) {
    const card = present.find(isStadium);
    if (card) errors.push(`Tu mazo no puede tener cartas de Estadio (${card.name})`);
  }
  if (rules.maxTrainers !== undefined) {
    const trainers = trainerCount(entries);
    if (trainers > rules.maxTrainers) errors.push(`Tu mazo no puede tener más de ${rules.maxTrainers} Entrenadores (tiene ${trainers})`);
  }
  if (rules.maxCopies !== undefined) {
    // By the card's display name (card.name, as the deck builder and checkDeckPlayable show it)
    const byName = new Map<string, number>();
    for (const entry of entries) {
      const card = findCardById(entry.cardId);
      if (!card || entry.qty <= 0 || isBasicEnergy(card)) continue;
      byName.set(card.name, (byName.get(card.name) ?? 0) + entry.qty);
    }
    for (const [name, qty] of byName) {
      if (qty > rules.maxCopies) errors.push(`Tu mazo no puede tener más de ${copies(rules.maxCopies)} de ${name} (tiene ${qty})`);
    }
  }
  return errors;
}

/** The first rule the deck breaks, or null. */
export function checkGymRules(entries: readonly CardEntry[], rules: GymRules): string | null {
  return gymRuleErrors(entries, rules)[0] ?? null;
}

/** The fixed Stadium as the payloads send it, or null. */
export function fixedStadiumOf(rules: GymRules): { cardId: string; name: string } | null {
  if (!rules.fixedStadiumId) return null;
  const card = findCardById(rules.fixedStadiumId);
  return card ? { cardId: card.id, name: card.name } : null;
}

/**
 * The rules in plain Spanish for a table / the admin panel: "Sin Pokémon de tipo Planta, Psíquico
 * o Lucha", "Sin Pokémon de Brock", "Sin cartas de Estadio", "Hasta 25 Entrenadores", "Hasta 2
 * copias de cada carta (la Energía básica no tiene límite)", "Pewter City Gym siempre en juego".
 */
export function describeGymRules(rules: GymRules): string[] {
  const lines: string[] = [];
  if (rules.bannedPokemonTypes.length > 0) lines.push(`Sin Pokémon de tipo ${orList(rules.bannedPokemonTypes.map(pokemonTypeLabel))}`);
  if (rules.bannedOwners.length > 0) lines.push(`Sin Pokémon de ${orList(rules.bannedOwners)}`);
  if (rules.noStadiums) lines.push("Sin cartas de Estadio");
  if (rules.maxTrainers !== undefined) lines.push(`Hasta ${rules.maxTrainers} Entrenadores`);
  if (rules.maxCopies !== undefined) lines.push(`Hasta ${copies(rules.maxCopies)} de cada carta (la Energía básica no tiene límite)`);
  const stadium = fixedStadiumOf(rules);
  if (stadium) lines.push(`${stadium.name} siempre en juego`);
  return lines;
}

/** The rules as the payloads send them (contract GymRules: absent limits are null). */
export function publicGymRules(rules: GymRules) {
  return {
    bannedPokemonTypes: [...rules.bannedPokemonTypes] as string[],
    bannedOwners: [...rules.bannedOwners] as string[],
    noStadiums: rules.noStadiums,
    maxTrainers: rules.maxTrainers ?? null,
    maxCopies: rules.maxCopies ?? null,
    fixedStadium: fixedStadiumOf(rules),
  };
}
