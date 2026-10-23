/**
 * Brock, the Pewter City (Ciudad Plateada) Gym Leader. His normal deck starts from game-core's
 * `gym-heroes-brock` theme deck and is tuned with simulations (scripts/gym-deck-sim.ts; numbers
 * in docs/gym-leaders.md "Deck tuning"): the same 22 Pokémon; Good Manners, Secret Mission, Recall,
 * The Rocket's Trap and 6 Energy out for Energy Removal, Gust of Wind, PlusPower, Bill and Oak;
 * v2.1 (Pewter City Gym always in play, no Stadium in either deck): its 2 Pewter City Gym became
 * a Bill and a Professor Oak (sim N3).
 * His EXPERT deck (v2) is tuned the same way and must beat the normal deck's win rate. Both are
 * only the defaults: an admin can replace either from the backoffice (gym-decks.ts).
 */
import type { GymLeaderDef, GymRules } from "./types.js";

/**
 * The owner's rules (v2.1), both versions: no Grass, Psychic or Fighting Pokémon, none of Brock's
 * own Pokémon, no Stadium cards (Pewter City Gym is always in play), at most 20 Trainers; at most 2
 * copies of each Trainer (expert: 1). Pokémon and Energy keep the normal 4 (owner, 2026-10-23).
 */
const BROCK_RULES = {
  bannedPokemonTypes: ["grass", "psychic", "fighting"],
  bannedOwners: ["Brock"],
  noStadiums: true,
  maxTrainers: 20,
  fixedStadiumId: "gym-heroes-115-pewter-city-gym",
} satisfies Omit<GymRules, "maxTrainerCopies">;

export const BROCK: GymLeaderDef = {
  id: "brock",
  name: "Brock",
  title: "Líder del Gimnasio de Ciudad Plateada",
  medalId: "boulder",
  avatarId: "gym-brock",
  cosmetics: { playmatId: "playmat-ciudad-plateada", coinId: "golem", cardBackId: "cardback-brock" },
  emotes: { battleStart: "brock-smug", knockOut: "brock-excited", victory: "brock-beach" },
  entryCost: 100,
  attemptsPerDay: 2,
  rules: {
    normal: { ...BROCK_RULES, maxTrainerCopies: 2 },
    expert: { ...BROCK_RULES, maxTrainerCopies: 1 },
  },
  rewards: {
    normal: { medalId: "boulder", coins: 1500, coinId: "golem", cardBackId: "cardback-brock" },
    expert: { medalId: null, coins: 3000, coinId: null, cardBackId: "cardback-brock-expert" },
  },
  decks: {
    normal: [
      { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 2 },
      { cardId: "gym-heroes-022-brocks-rhyhorn", qty: 1 },
      { cardId: "gym-heroes-002-brocks-rhydon", qty: 2 },
      { cardId: "gym-heroes-038-brocks-geodude", qty: 2 },
      { cardId: "gym-heroes-066-brocks-geodude", qty: 2 },
      { cardId: "gym-heroes-040-brocks-graveler", qty: 3 },
      { cardId: "gym-heroes-020-brocks-golem", qty: 2 },
      { cardId: "gym-heroes-069-brocks-onix", qty: 2 },
      { cardId: "gym-heroes-072-brocks-sandshrew", qty: 2 },
      { cardId: "gym-heroes-071-brocks-sandshrew", qty: 1 },
      { cardId: "gym-heroes-023-brocks-sandslash", qty: 2 },
      { cardId: "gym-heroes-041-brocks-lickitung", qty: 1 },
      // Trainers: Brock's own, then generic ones the smart AI plays well (Energy Removal above all);
      // no Stadium (v2.1: Pewter City Gym is always in play)
      { cardId: "gym-heroes-015-brock", qty: 2 },
      { cardId: "gym-heroes-106-brocks-training-method", qty: 3 },
      { cardId: "base-set-092-energy-removal", qty: 4 },
      { cardId: "base-set-079-super-energy-removal", qty: 1 },
      { cardId: "base-set-093-gust-of-wind", qty: 2 },
      { cardId: "base-set-084-pluspower", qty: 1 },
      { cardId: "base-set-091-bill", qty: 3 },
      { cardId: "base-set-088-professor-oak", qty: 2 },
      { cardId: "base-set-097-fighting-energy", qty: 20 },
    ],
    // EXPERT (scripts/gym-deck-sim.ts E14, tuned in v2, re-run under v2.1): no Golem / Sandshrew lines; both Hitmonchan, 4 Rhyhorn
    // #70 / 3 Rhydon / 4 Onix, heavier Energy denial (Super Energy Removal ×3), Gust ×3, 2 DCE
    expert: [
      { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 4 },
      { cardId: "gym-heroes-022-brocks-rhyhorn", qty: 1 },
      { cardId: "gym-heroes-002-brocks-rhydon", qty: 3 },
      { cardId: "gym-heroes-069-brocks-onix", qty: 4 },
      { cardId: "gym-heroes-041-brocks-lickitung", qty: 1 },
      { cardId: "base-set-007-hitmonchan", qty: 4 },
      { cardId: "gym-heroes-011-rockets-hitmonchan", qty: 4 },
      { cardId: "gym-heroes-015-brock", qty: 2 },
      { cardId: "gym-heroes-106-brocks-training-method", qty: 1 },
      { cardId: "base-set-092-energy-removal", qty: 4 },
      { cardId: "base-set-079-super-energy-removal", qty: 3 },
      { cardId: "base-set-093-gust-of-wind", qty: 3 },
      { cardId: "base-set-084-pluspower", qty: 2 },
      { cardId: "base-set-091-bill", qty: 2 },
      { cardId: "base-set-088-professor-oak", qty: 2 },
      { cardId: "base-set-097-fighting-energy", qty: 18 },
      { cardId: "base-set-096-double-colorless-energy", qty: 2 },
    ],
  },
};
