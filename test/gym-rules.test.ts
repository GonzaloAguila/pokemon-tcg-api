/**
 * Gym Leaders' deck rules (src/modules/gym/rules.ts): banned types for Pokémon and basic Energy,
 * exact composition, Spanish reasons. Pure, no DB.
 */
import { describe, expect, it } from "vitest";
import { checkGymRules, deckComposition, describeGymRules, gymRuleErrors } from "../src/modules/gym/rules.js";
import { BROCK } from "../src/modules/gym/content/brock.js";
import type { CardEntry } from "../src/modules/gym/content/types.js";

/** 20 Pokémon / 20 Trainers / 20 Energy, no Grass or Water: Brock's rules pass. */
function legalDeck(): CardEntry[] {
  return [
    { cardId: "base-set-052-machop", qty: 4 },
    { cardId: "base-set-046-charmander", qty: 4 },
    { cardId: "gym-heroes-069-brocks-onix", qty: 4 },
    { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 4 },
    { cardId: "team-rocket-059-machop", qty: 4 },
    { cardId: "base-set-091-bill", qty: 4 },
    { cardId: "base-set-088-professor-oak", qty: 4 },
    { cardId: "base-set-094-potion", qty: 4 },
    { cardId: "fossil-062-mysterious-fossil", qty: 4 },
    { cardId: "base-set-090-super-potion", qty: 4 },
    { cardId: "base-set-097-fighting-energy", qty: 12 },
    { cardId: "base-set-098-fire-energy", qty: 4 },
    { cardId: "base-set-096-double-colorless-energy", qty: 4 },
  ];
}

const replace = (deck: CardEntry[], from: string, to: CardEntry[]): CardEntry[] => [...deck.filter((e) => e.cardId !== from), ...to];

describe("gym deck rules (Brock)", () => {
  it("a 20/20/20 deck without Grass or Water passes", () => {
    expect(gymRuleErrors(legalDeck(), BROCK.rules)).toEqual([]);
    expect(checkGymRules(legalDeck(), BROCK.rules)).toBeNull();
  });

  it("counts Trainers played as Basics as Trainers and special Energy as Energy", () => {
    expect(deckComposition(legalDeck())).toEqual({ pokemon: 20, trainer: 20, energy: 20 });
  });

  it("refuses Water and Grass Pokémon", () => {
    const water = replace(legalDeck(), "base-set-046-charmander", [{ cardId: "base-set-063-squirtle", qty: 4 }]);
    expect(checkGymRules(water, BROCK.rules)).toBe("Tu mazo no puede tener Pokémon de tipo Agua");
    const grass = replace(legalDeck(), "base-set-046-charmander", [{ cardId: "base-set-044-bulbasaur", qty: 4 }]);
    expect(checkGymRules(grass, BROCK.rules)).toBe("Tu mazo no puede tener Pokémon de tipo Planta");
    // A Gym Challenge owner's Pokémon too (Erika's Bulbasaur is Grass)
    const erika = replace(legalDeck(), "base-set-046-charmander", [{ cardId: "gym-challenge-039-erikas-bulbasaur", qty: 4 }]);
    expect(gymRuleErrors(erika, BROCK.rules)).toContain("Tu mazo no puede tener Pokémon de tipo Planta");
  });

  it("refuses basic Water / Grass Energy but not special Energy", () => {
    const water = replace(legalDeck(), "base-set-098-fire-energy", [{ cardId: "base-set-102-water-energy", qty: 4 }]);
    expect(checkGymRules(water, BROCK.rules)).toBe("Tu mazo no puede tener Energía Agua básica");
    const grass = replace(legalDeck(), "base-set-098-fire-energy", [{ cardId: "base-set-099-grass-energy", qty: 4 }]);
    expect(checkGymRules(grass, BROCK.rules)).toBe("Tu mazo no puede tener Energía Planta básica");
    const rainbow = replace(legalDeck(), "base-set-098-fire-energy", [{ cardId: "team-rocket-017-rainbow-energy", qty: 4 }]);
    expect(checkGymRules(rainbow, BROCK.rules)).toBeNull();
  });

  it("a banned entry with quantity 0 doesn't count", () => {
    expect(checkGymRules([...legalDeck(), { cardId: "base-set-063-squirtle", qty: 0 }], BROCK.rules)).toBeNull();
  });

  it("asks for exactly 20 of each kind, with the counts", () => {
    const fewPokemon = replace(legalDeck(), "team-rocket-059-machop", [{ cardId: "team-rocket-059-machop", qty: 2 }, { cardId: "base-set-097-fighting-energy", qty: 2 }]);
    const errors = gymRuleErrors(fewPokemon, BROCK.rules);
    expect(errors).toContain("Tu mazo debe tener exactamente 20 Pokémon (tiene 18)");
    expect(errors).toContain("Tu mazo debe tener exactamente 20 Energías (tiene 22)");
    expect(errors).not.toContain(expect.stringContaining("Entrenadores"));
    const fewTrainers = replace(legalDeck(), "base-set-094-potion", [{ cardId: "base-set-063-squirtle", qty: 1 }, { cardId: "base-set-052-machop", qty: 3 }]);
    expect(gymRuleErrors(fewTrainers, BROCK.rules)).toEqual([
      "Tu mazo no puede tener Pokémon de tipo Agua",
      "Tu mazo debe tener exactamente 20 Pokémon (tiene 24)",
      "Tu mazo debe tener exactamente 20 Entrenadores (tiene 16)",
    ]);
  });

  it("a rule set without composition only checks the types", () => {
    const deck = [{ cardId: "base-set-052-machop", qty: 60 }];
    expect(checkGymRules(deck, { bannedTypes: ["water"] })).toBeNull();
    expect(checkGymRules(deck, { bannedTypes: ["fighting"] })).toBe("Tu mazo no puede tener Pokémon de tipo Lucha");
  });

  it("names unknown cards", () => {
    expect(checkGymRules([{ cardId: "base-set-999-nope", qty: 1 }, ...legalDeck()], BROCK.rules)).toBe("Carta desconocida: base-set-999-nope");
  });

  it("describes the rules in plain Spanish", () => {
    expect(describeGymRules(BROCK.rules)).toEqual([
      "Sin Pokémon ni Energía básica de tipo Planta o Agua",
      "Exactamente 20 Pokémon, 20 Entrenadores y 20 Energías",
    ]);
  });

  it("Brock's own deck is 60 known cards", () => {
    const total = BROCK.decks.normal.reduce((sum, e) => sum + e.qty, 0);
    expect(total).toBe(60);
    expect(gymRuleErrors(BROCK.decks.normal, { bannedTypes: ["grass", "water"] })).toEqual([]);
  });
});
