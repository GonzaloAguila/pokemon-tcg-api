/**
 * Gym Leaders' deck rules (src/modules/gym/rules.ts, v2.1): banned Pokémon types (Energy free),
 * banned owners (no "Brock's …" Pokémon), no Stadium cards, at most 25 Trainers, copy limits by
 * name (basic Energy exempt); Brock's versions (normal 2 copies, expert 1) and data. Pure, no DB.
 */
import { describe, expect, it } from "vitest";
import { findCardById, isTrainerCard } from "@gonzaloaguila/game-core";
import { checkGymRules, describeGymRules, gymRuleErrors, publicGymRules, trainerCount } from "../src/modules/gym/rules.js";
import { BROCK } from "../src/modules/gym/content/brock.js";
import { leaderModes } from "../src/modules/gym/content/index.js";
import type { CardEntry } from "../src/modules/gym/content/types.js";

const NORMAL = BROCK.rules.normal;
const EXPERT = BROCK.rules.expert!;

/** 20 different Basic Pokémon (Fire / Water / Lightning / Colorless, none of Brock's). */
const POKEMON = [
  "base-set-003-chansey", "base-set-005-clefairy", "base-set-016-zapdos", "base-set-020-electabuzz",
  "base-set-026-dratini", "base-set-027-farfetchd", "base-set-028-growlithe", "base-set-035-magikarp",
  "base-set-036-magmar", "base-set-039-porygon", "base-set-041-seel", "base-set-046-charmander",
  "base-set-048-doduo", "base-set-053-magnemite", "base-set-057-pidgey", "base-set-058-pikachu",
  "base-set-059-poliwag", "base-set-060-ponyta", "base-set-061-rattata", "base-set-063-squirtle",
];
/** 20 different Trainers (Mysterious Fossil, played as a Basic, among them). */
const TRAINERS = [
  "base-set-091-bill", "base-set-088-professor-oak", "base-set-094-potion", "base-set-090-super-potion",
  "base-set-081-energy-retrieval", "base-set-095-switch", "base-set-084-pluspower", "base-set-080-defender",
  "base-set-082-full-heal", "base-set-093-gust-of-wind", "base-set-092-energy-removal", "base-set-079-super-energy-removal",
  "base-set-085-pokemon-center", "base-set-078-scoop-up", "base-set-089-revive", "base-set-083-maintenance",
  "base-set-074-item-finder", "base-set-071-computer-search", "base-set-075-lass", "fossil-062-mysterious-fossil",
];

/** One copy of everything but basic Energy, 20 Trainers: both versions pass. */
function legalDeck(): CardEntry[] {
  return [
    ...POKEMON.map((cardId) => ({ cardId, qty: 1 })),
    ...TRAINERS.map((cardId) => ({ cardId, qty: 1 })),
    { cardId: "base-set-098-fire-energy", qty: 10 },
    { cardId: "base-set-102-water-energy", qty: 10 },
  ];
}

const replace = (deck: CardEntry[], from: string, to: CardEntry[]): CardEntry[] => [...deck.filter((e) => e.cardId !== from), ...to];

describe("gym deck rules (Brock, v2.1)", () => {
  it("a deck without Grass / Psychic / Fighting or Brock's Pokémon, single copies, 20 Trainers passes both versions", () => {
    expect(legalDeck().reduce((sum, e) => sum + e.qty, 0)).toBe(60);
    expect(gymRuleErrors(legalDeck(), NORMAL)).toEqual([]);
    expect(checkGymRules(legalDeck(), EXPERT)).toBeNull();
  });

  it("refuses Grass, Psychic and Fighting Pokémon, naming one", () => {
    expect(checkGymRules(replace(legalDeck(), "base-set-003-chansey", [{ cardId: "base-set-043-abra", qty: 1 }]), NORMAL)).toBe("Tu mazo no puede tener Pokémon de tipo Psíquico (Abra)");
    expect(checkGymRules(replace(legalDeck(), "base-set-003-chansey", [{ cardId: "base-set-044-bulbasaur", qty: 1 }]), NORMAL)).toBe("Tu mazo no puede tener Pokémon de tipo Planta (Bulbasaur)");
    expect(checkGymRules(replace(legalDeck(), "base-set-003-chansey", [{ cardId: "base-set-052-machop", qty: 1 }]), EXPERT)).toBe("Tu mazo no puede tener Pokémon de tipo Lucha (Machop)");
  });

  it("Energy is not restricted by type any more (Grass / Psychic / Fighting basic Energy are fine)", () => {
    const deck = replace(legalDeck(), "base-set-102-water-energy", [
      { cardId: "base-set-099-grass-energy", qty: 4 },
      { cardId: "base-set-101-psychic-energy", qty: 3 },
      { cardId: "base-set-097-fighting-energy", qty: 3 },
    ]);
    expect(checkGymRules(deck, EXPERT)).toBeNull();
  });

  it("refuses Brock's own Pokémon, whatever their type", () => {
    // Brock's Vulpix is a Fire Pokémon: only the owner rule catches it
    const vulpix = replace(legalDeck(), "base-set-003-chansey", [{ cardId: "gym-heroes-073-brocks-vulpix", qty: 1 }]);
    expect(gymRuleErrors(vulpix, NORMAL)).toEqual(["Tu mazo no puede tener Pokémon de Brock (Brock's Vulpix)"]);
    const onix = replace(legalDeck(), "base-set-003-chansey", [{ cardId: "gym-heroes-069-brocks-onix", qty: 1 }]);
    expect(gymRuleErrors(onix, NORMAL)).toEqual(["Tu mazo no puede tener Pokémon de tipo Lucha (Brock's Onix)", "Tu mazo no puede tener Pokémon de Brock (Brock's Onix)"]);
    // Another leader's Pokémon are fine
    const mistys = replace(legalDeck(), "base-set-003-chansey", [{ cardId: "gym-heroes-090-mistys-staryu", qty: 1 }]);
    expect(findCardById("gym-heroes-090-mistys-staryu")?.name).toBe("Misty's Staryu");
    expect(checkGymRules(mistys, EXPERT)).toBeNull();
  });

  it("refuses Stadium cards (Pewter City Gym is always in play)", () => {
    const deck = replace(legalDeck(), "base-set-075-lass", [{ cardId: "gym-heroes-115-pewter-city-gym", qty: 1 }]);
    expect(checkGymRules(deck, NORMAL)).toBe("Tu mazo no puede tener cartas de Estadio (Pewter City Gym)");
  });

  it("at most 25 Trainers (Trainers played as Basics count)", () => {
    const extra = ["gym-heroes-016-erika", "base-set-086-pokemon-flute", "base-set-087-pokedex", "base-set-076-pokemon-breeder", "base-set-070-clefairy-doll", "base-set-077-pokemon-trader"];
    const deck = (n: number) => [
      ...legalDeck().filter((e) => e.cardId !== "base-set-098-fire-energy"),
      ...extra.slice(0, n).map((cardId) => ({ cardId, qty: 1 })),
      { cardId: "base-set-098-fire-energy", qty: 10 - n },
    ];
    expect(trainerCount(deck(5))).toBe(25);
    expect(checkGymRules(deck(5), EXPERT)).toBeNull();
    expect(trainerCount(deck(6))).toBe(26);
    expect(checkGymRules(deck(6), EXPERT)).toBe("Tu mazo no puede tener más de 25 Entrenadores (tiene 26)");
  });

  it("copies by name: normal 2, expert 1; Pokémon, Trainers and special Energy alike; basic Energy free", () => {
    const twoBills = replace(legalDeck(), "base-set-075-lass", [{ cardId: "base-set-091-bill", qty: 1 }]);
    expect(checkGymRules(twoBills, NORMAL)).toBeNull();
    expect(checkGymRules(twoBills, EXPERT)).toBe("Tu mazo no puede tener más de 1 copia de Bill (tiene 2)");
    const fourBills = replace(twoBills, "base-set-074-item-finder", [{ cardId: "base-set-091-bill", qty: 2 }]).filter((e) => e.cardId !== "base-set-071-computer-search");
    expect(fourBills.reduce((sum, e) => sum + e.qty, 0)).toBe(60);
    expect(checkGymRules(fourBills, NORMAL)).toBe("Tu mazo no puede tener más de 2 copias de Bill (tiene 4)");
    const threePikachu = replace(legalDeck(), "base-set-003-chansey", [{ cardId: "base-set-058-pikachu", qty: 2 }]).filter((e) => e.cardId !== "base-set-005-clefairy");
    expect(checkGymRules(threePikachu, NORMAL)).toBe("Tu mazo no puede tener más de 2 copias de Pikachu (tiene 3)");
    const twoDce = replace(legalDeck(), "base-set-098-fire-energy", [
      { cardId: "base-set-098-fire-energy", qty: 8 },
      { cardId: "base-set-096-double-colorless-energy", qty: 2 },
    ]);
    expect(checkGymRules(twoDce, NORMAL)).toBeNull();
    expect(checkGymRules(twoDce, EXPERT)).toBe("Tu mazo no puede tener más de 1 copia de Double Colorless Energy (tiene 2)");
    // The same card in two entries (a user deck's variants) is summed
    expect(checkGymRules([...legalDeck(), { cardId: "base-set-091-bill", qty: 1 }], EXPERT)).toBe("Tu mazo no puede tener más de 1 copia de Bill (tiene 2)");
  });

  it("a banned entry with quantity 0 doesn't count", () => {
    expect(checkGymRules([...legalDeck(), { cardId: "base-set-043-abra", qty: 0 }], NORMAL)).toBeNull();
  });

  it("a rule set without limits only checks what it has", () => {
    const deck = [{ cardId: "base-set-091-bill", qty: 40 }, { cardId: "base-set-052-machop", qty: 20 }];
    expect(checkGymRules(deck, { bannedPokemonTypes: [], bannedOwners: [], noStadiums: false })).toBeNull();
    expect(checkGymRules(deck, { bannedPokemonTypes: ["fighting"], bannedOwners: [], noStadiums: false })).toBe("Tu mazo no puede tener Pokémon de tipo Lucha (Machop)");
  });

  it("names unknown cards", () => {
    expect(checkGymRules([{ cardId: "base-set-999-nope", qty: 1 }, ...legalDeck()], NORMAL)).toBe("Carta desconocida: base-set-999-nope");
  });

  it("describes each version's rules in plain Spanish", () => {
    expect(describeGymRules(NORMAL)).toEqual([
      "Sin Pokémon de tipo Planta, Psíquico o Lucha",
      "Sin Pokémon de Brock",
      "Sin cartas de Estadio",
      "Hasta 25 Entrenadores",
      "Hasta 2 copias de cada carta (la Energía básica no tiene límite)",
      "Pewter City Gym siempre en juego",
    ]);
    expect(describeGymRules(EXPERT)[4]).toBe("Hasta 1 copia de cada carta (la Energía básica no tiene límite)");
  });

  it("the payload form (contract GymRules)", () => {
    expect(publicGymRules(NORMAL)).toEqual({
      bannedPokemonTypes: ["grass", "psychic", "fighting"],
      bannedOwners: ["Brock"],
      noStadiums: true,
      maxTrainers: 25,
      maxCopies: 2,
      fixedStadium: { cardId: "gym-heroes-115-pewter-city-gym", name: "Pewter City Gym" },
    });
    expect(publicGymRules(EXPERT).maxCopies).toBe(1);
    expect(publicGymRules({ bannedPokemonTypes: ["fire"], bannedOwners: [], noStadiums: false })).toEqual({
      bannedPokemonTypes: ["fire"],
      bannedOwners: [],
      noStadiums: false,
      maxTrainers: null,
      maxCopies: null,
      fixedStadium: null,
    });
  });

  it("Brock: both versions, 100 coins a challenge; his decks are 60 known cards without Stadiums (his own copies aren't limited)", () => {
    expect(leaderModes(BROCK)).toEqual(["normal", "expert"]);
    expect(BROCK.entryCost).toBe(100);
    for (const deck of [BROCK.decks.normal, BROCK.decks.expert!]) {
      expect(deck.reduce((sum, e) => sum + e.qty, 0)).toBe(60);
      expect(deck.every((e) => !!findCardById(e.cardId))).toBe(true);
      expect(deck.some((e) => { const card = findCardById(e.cardId)!; return isTrainerCard(card) && card.trainerType === "stadium"; })).toBe(false);
    }
    expect(BROCK.decks.expert).not.toEqual(BROCK.decks.normal);
  });

  it("Brock's rewards: normal = medal + coin + card back + 1500; expert = 3000 + the EXPERT card back", () => {
    expect(BROCK.rewards.normal).toEqual({ medalId: "boulder", coins: 1500, coinId: "golem", cardBackId: "cardback-brock" });
    expect(BROCK.rewards.expert).toEqual({ medalId: null, coins: 3000, coinId: null, cardBackId: "cardback-brock-expert" });
  });
});
