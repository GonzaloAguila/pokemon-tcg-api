/**
 * Brock, the Pewter City (Ciudad Plateada) Gym Leader. His normal deck starts from game-core's
 * `gym-heroes-brock` theme deck and is tuned with simulations (scripts/gym-deck-sim.ts; numbers
 * in docs/gym-leaders.md "Deck tuning"): the same 22 Pokémon; Good Manners, Secret Mission, Recall,
 * The Rocket's Trap and 6 Energy out for Energy Removal, Gust of Wind, PlusPower, Bill and Oak.
 */
import type { GymLeaderDef } from "./types.js";

export const BROCK: GymLeaderDef = {
  id: "brock",
  name: "Brock",
  title: "Líder del Gimnasio de Ciudad Plateada",
  medalId: "boulder",
  avatarId: "gym-brock",
  cosmetics: { playmatId: "playmat-ciudad-plateada", coinId: "golem", cardBackId: "cardback-brock" },
  rules: {
    bannedTypes: ["grass", "water"],
    composition: { pokemon: 20, trainer: 20, energy: 20 },
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
      // Trainers: Brock's own, then generic ones the smart AI plays well (Energy Removal above all)
      { cardId: "gym-heroes-015-brock", qty: 2 },
      { cardId: "gym-heroes-115-pewter-city-gym", qty: 2 },
      { cardId: "gym-heroes-106-brocks-training-method", qty: 3 },
      { cardId: "base-set-092-energy-removal", qty: 4 },
      { cardId: "base-set-079-super-energy-removal", qty: 1 },
      { cardId: "base-set-093-gust-of-wind", qty: 2 },
      { cardId: "base-set-084-pluspower", qty: 1 },
      { cardId: "base-set-091-bill", qty: 2 },
      { cardId: "base-set-088-professor-oak", qty: 1 },
      { cardId: "base-set-097-fighting-energy", qty: 20 },
    ],
  },
};
