/**
 * Season 1: Base Set — 30 days of rewards
 *
 * Standard: free track (mostly coins, some tickets, 2 card backs)
 * Premium:  better rewards every day (more coins, packs, card backs, profile coins, cards)
 */

import type { BattlePassRewardDef } from "./battle-pass.types.js";

export const SEASON_1_REWARDS: BattlePassRewardDef[] = [
  // Day 1
  { day: 1,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 1,  track: "premium",  rewardType: "coins",        amount: 300,  label: "300 Monedas",            icon: "🪙" },

  // Day 2
  { day: 2,  track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 2,  track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 3
  { day: 3,  track: "standard", rewardType: "coins",        amount: 75,   label: "75 Monedas",             icon: "🪙" },
  { day: 3,  track: "premium",  rewardType: "coins",        amount: 250,  label: "250 Monedas",            icon: "🪙" },

  // Day 4
  { day: 4,  track: "standard", rewardType: "ticket",       amount: 1,    label: "1 Cupon",                icon: "🎟️" },
  { day: 4,  track: "premium",  rewardType: "card_back",    rewardId: "blue-swirl", label: "Dorso: Remolino Azul", icon: "🎴" },

  // Day 5
  { day: 5,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 5,  track: "premium",  rewardType: "profile_coin", rewardId: "lucario", label: "Moneda: Lucario", icon: "🥇" },

  // Day 6
  { day: 6,  track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 6,  track: "premium",  rewardType: "coins",        amount: 400,  label: "400 Monedas",            icon: "🪙" },

  // Day 7
  { day: 7,  track: "standard", rewardType: "card_back",    rewardId: "pokeball-pattern", label: "Dorso: Poke Ball", icon: "🎴" },
  { day: 7,  track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 8
  { day: 8,  track: "standard", rewardType: "coins",        amount: 75,   label: "75 Monedas",             icon: "🪙" },
  { day: 8,  track: "premium",  rewardType: "ticket",       amount: 2,    label: "2 Cupones",              icon: "🎟️" },

  // Day 9
  { day: 9,  track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 9,  track: "premium",  rewardType: "card",         rewardId: "base-set-025-pikachu", label: "Carta: Pikachu", icon: "⚡" },

  // Day 10
  { day: 10, track: "standard", rewardType: "coins",        amount: 150,  label: "150 Monedas",            icon: "🪙" },
  { day: 10, track: "premium",  rewardType: "card_back",    rewardId: "fire-flames", label: "Dorso: Llamas Ardientes", icon: "🔥" },

  // Day 11
  { day: 11, track: "standard", rewardType: "ticket",       amount: 1,    label: "1 Cupon",                icon: "🎟️" },
  { day: 11, track: "premium",  rewardType: "coins",        amount: 500,  label: "500 Monedas",            icon: "🪙" },

  // Day 12
  { day: 12, track: "standard", rewardType: "coins",        amount: 75,   label: "75 Monedas",             icon: "🪙" },
  { day: 12, track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 13
  { day: 13, track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 13, track: "premium",  rewardType: "profile_coin", rewardId: "vulpix-alola", label: "Moneda: Vulpix Alola", icon: "❄️" },

  // Day 14
  { day: 14, track: "standard", rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },
  { day: 14, track: "premium",  rewardType: "card_back",    rewardId: "water-waves", label: "Dorso: Olas Marinas", icon: "🌊" },

  // Day 15 — Halfway
  { day: 15, track: "standard", rewardType: "card_back",    rewardId: "pikachu-yellow", label: "Dorso: Pikachu", icon: "🎴" },
  { day: 15, track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 16
  { day: 16, track: "standard", rewardType: "coins",        amount: 75,   label: "75 Monedas",             icon: "🪙" },
  { day: 16, track: "premium",  rewardType: "coins",        amount: 350,  label: "350 Monedas",            icon: "🪙" },

  // Day 17
  { day: 17, track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 17, track: "premium",  rewardType: "ticket",       amount: 3,    label: "3 Cupones",              icon: "🎟️" },

  // Day 18
  { day: 18, track: "standard", rewardType: "ticket",       amount: 1,    label: "1 Cupon",                icon: "🎟️" },
  { day: 18, track: "premium",  rewardType: "card",         rewardId: "base-set-004-charizard", label: "Carta: Charizard", icon: "🔥" },

  // Day 19
  { day: 19, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 19, track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 20
  { day: 20, track: "standard", rewardType: "coins",        amount: 150,  label: "150 Monedas",            icon: "🪙" },
  { day: 20, track: "premium",  rewardType: "card_back",    rewardId: "grass-garden", label: "Dorso: Jardin Verde", icon: "🌿" },

  // Day 21
  { day: 21, track: "standard", rewardType: "coins",        amount: 75,   label: "75 Monedas",             icon: "🪙" },
  { day: 21, track: "premium",  rewardType: "coins",        amount: 600,  label: "600 Monedas",            icon: "🪙" },

  // Day 22
  { day: 22, track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 22, track: "premium",  rewardType: "profile_coin", rewardId: "charizard", label: "Moneda: Charizard", icon: "🔥" },

  // Day 23
  { day: 23, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 23, track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 24
  { day: 24, track: "standard", rewardType: "ticket",       amount: 2,    label: "2 Cupones",              icon: "🎟️" },
  { day: 24, track: "premium",  rewardType: "card_back",    rewardId: "legendary-birds", label: "Dorso: Aves Legendarias", icon: "🦅" },

  // Day 25
  { day: 25, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 25, track: "premium",  rewardType: "ticket",       amount: 3,    label: "3 Cupones",              icon: "🎟️" },

  // Day 26
  { day: 26, track: "standard", rewardType: "coins",        amount: 75,   label: "75 Monedas",             icon: "🪙" },
  { day: 26, track: "premium",  rewardType: "coins",        amount: 500,  label: "500 Monedas",            icon: "🪙" },

  // Day 27
  { day: 27, track: "standard", rewardType: "coins",        amount: 50,   label: "50 Monedas",             icon: "🪙" },
  { day: 27, track: "premium",  rewardType: "card",         rewardId: "base-set-015-venusaur", label: "Carta: Venusaur", icon: "🌿" },

  // Day 28
  { day: 28, track: "standard", rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },
  { day: 28, track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // Day 29
  { day: 29, track: "standard", rewardType: "coins",        amount: 150,  label: "150 Monedas",            icon: "🪙" },
  { day: 29, track: "premium",  rewardType: "card_back",    rewardId: "galaxy", label: "Dorso: Galaxia", icon: "🌌" },

  // Day 30 — Grand Finale
  { day: 30, track: "standard", rewardType: "coins",        amount: 500,  label: "500 Monedas",            icon: "🎉" },
  { day: 30, track: "premium",  rewardType: "card_back",    rewardId: "mewtwo-psychic", label: "Dorso: Mewtwo Psiquico", icon: "🧬" },
];
