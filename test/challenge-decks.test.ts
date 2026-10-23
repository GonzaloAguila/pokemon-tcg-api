import { describe, expect, it } from "vitest";
import { ALL_CARDS } from "@gonzaloaguila/game-core";
import {
  baseName,
  basicEnergyTypes,
  isBasicsOnly,
  isBudget,
  isDarkEvolutions,
  isMonotype,
  isNoTrainers,
  leadersWithAtLeast,
  pokemonTypeCount,
  setCount,
  singleSetOf,
  type DeckEntry,
} from "../src/modules/achievements/challenge-decks.js";

/** The catalog id of the card named `name` in set `setId` (the first printing). */
function id(name: string, setId: string): string {
  const card = ALL_CARDS.find((c) => c.name === name && c.id.startsWith(`${setId}-`));
  if (!card) throw new Error(`no ${name} in ${setId}`);
  return card.id;
}
const e = (name: string, setId: string, qty = 1): DeckEntry => ({ cardId: id(name, setId), qty });
const energy = (type: string, qty = 10): DeckEntry => ({ cardId: id(`${type} Energy`, "base-set"), qty });

describe("challenge deck rules", () => {
  it("no Trainers: a Clefairy Doll is a Trainer", () => {
    const deck = [e("Squirtle", "base-set", 4), energy("Water")];
    expect(isNoTrainers(deck)).toBe(true);
    expect(isNoTrainers([...deck, e("Clefairy Doll", "base-set")])).toBe(false);
  });

  it("monotype: one basic Energy type, Pokémon of that type or Colorless", () => {
    const deck = [e("Squirtle", "base-set", 4), e("Pidgey", "base-set", 2), energy("Water")];
    expect(isMonotype(deck)).toBe(true);
    expect(isMonotype([...deck, energy("Fire", 1)])).toBe(false);
    expect(isMonotype([...deck, e("Charmander", "base-set")])).toBe(false);
  });

  it("basics only: one Stage 1 breaks it", () => {
    const deck = [e("Squirtle", "base-set", 4), energy("Water")];
    expect(isBasicsOnly(deck)).toBe(true);
    expect(isBasicsOnly([...deck, e("Wartortle", "base-set")])).toBe(false);
  });

  it("budget: one rare breaks it", () => {
    const deck = [e("Squirtle", "base-set", 4), e("Bill", "base-set"), energy("Water")];
    expect(isBudget(deck)).toBe(true);
    expect(isBudget([...deck, e("Blastoise", "base-set")])).toBe(false);
  });

  it("single set: basic Energy doesn't count", () => {
    const deck = [e("Paras", "jungle", 4), e("Parasect", "jungle", 3), energy("Grass")];
    expect(singleSetOf(deck)).toBe("jungle");
    expect(singleSetOf([...deck, e("Squirtle", "base-set")])).toBeNull();
  });

  it("dark evolutions: every Stage 1/2 is Dark, and there is one", () => {
    const deck = [e("Charmander", "team-rocket", 4), e("Dark Charmeleon", "team-rocket", 3), e("Dark Charizard", "team-rocket", 2), energy("Fire")];
    expect(isDarkEvolutions(deck)).toBe(true);
    expect(isDarkEvolutions([...deck, e("Charmeleon", "base-set")])).toBe(false);
    expect(isDarkEvolutions([e("Charmander", "team-rocket", 4), energy("Fire")])).toBe(false);
  });

  it("leaders with at least N Pokémon", () => {
    const deck = [e("Brock's Geodude", "gym-heroes", 4), e("Misty's Psyduck", "gym-heroes", 4), e("Erika's Oddish", "gym-heroes", 3), energy("Water")];
    expect(leadersWithAtLeast(deck, 4)).toEqual(["Brock", "Misty"]);
  });

  it("basic Energy types: Double Colorless doesn't count", () => {
    const deck = [energy("Water", 6), energy("Lightning", 6), e("Double Colorless Energy", "base-set", 4)];
    expect(basicEnergyTypes(deck)).toEqual(["lightning", "water"]);
  });

  it("Pokémon types: Colorless doesn't count", () => {
    const deck = [e("Charmander", "base-set"), e("Squirtle", "base-set"), e("Paras", "jungle"), e("Pikachu", "base-set"), e("Pidgey", "base-set")];
    expect(pokemonTypeCount(deck)).toBe(4);
  });

  it("set count: basic Energy doesn't count", () => {
    const deck = [e("Squirtle", "base-set"), e("Paras", "jungle"), e("Psyduck", "fossil"), e("Dark Charmeleon", "team-rocket"), energy("Water")];
    expect(setCount(deck)).toBe(4);
    expect(setCount([energy("Water"), e("Squirtle", "base-set")])).toBe(1);
  });

  it("base name strips a Leader's prefix only", () => {
    expect(baseName("Lt. Surge's Raticate")).toBe("Raticate");
    expect(baseName("Misty's Seaking")).toBe("Seaking");
    expect(baseName("Dark Raticate")).toBe("Dark Raticate");
    expect(baseName("Farfetch'd")).toBe("Farfetch'd");
  });

  it("every deck challenge is achievable with a legal 60-card deck", () => {
    const sixty = (entries: DeckEntry[]) => entries.reduce((n, x) => n + x.qty, 0);
    const noTrainers = [e("Squirtle", "base-set", 4), e("Wartortle", "base-set", 4), e("Blastoise", "base-set", 2), e("Pidgey", "base-set", 4), energy("Water", 46)];
    const darkFire = [e("Charmander", "team-rocket", 4), e("Charmander", "base-set", 4), e("Dark Charmeleon", "team-rocket", 4), e("Dark Charizard", "team-rocket", 4), e("Bill", "base-set", 4), energy("Fire", 40)];
    expect(sixty(noTrainers)).toBe(60);
    expect(sixty(darkFire)).toBe(60);
    expect(isNoTrainers(noTrainers) && isMonotype(noTrainers)).toBe(true);
    expect(isDarkEvolutions(darkFire)).toBe(true);
    expect(isBasicsOnly([e("Squirtle", "base-set", 4), energy("Water", 56)])).toBe(true);
  });
});
