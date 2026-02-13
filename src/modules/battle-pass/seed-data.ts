/**
 * Default Monthly Rewards — 30-day template
 *
 * This template is used when auto-creating a new month's battle pass.
 * The service layer adapts it for the actual month length:
 * - February (28/29 days): filters to day <= durationDays
 * - 31-day months: adds day 31 as 100/200 coins
 *
 * Pattern:
 * - Day 1: 500 coins welcome bonus (both tracks)
 * - Regular days: Standard 100 coins, Premium 200 coins
 * - Every 5th day (5/10/15/20/25): Special hito (both tracks get it, premium also gets coins)
 * - Premium intercalated extras on days 3/8/13/18/23
 * - Day 30 (last): Card skin variant (both tracks, premium also gets coins)
 */

import type { BattlePassRewardDef } from "./battle-pass.types.js";

export const DEFAULT_MONTHLY_REWARDS: BattlePassRewardDef[] = [
  // ── Day 1: Welcome bonus ──────────────────────────────────────────────
  { day: 1,  track: "standard", rewardType: "coins",        amount: 500,  label: "500 Monedas",            icon: "🪙" },
  { day: 1,  track: "premium",  rewardType: "coins",        amount: 500,  label: "500 Monedas",            icon: "🪙" },

  // ── Day 2 ─────────────────────────────────────────────────────────────
  { day: 2,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 2,  track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 3 (premium intercalated: booster pack) ────────────────────────
  { day: 3,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 3,  track: "premium",  rewardType: "pack",         rewardId: "base-set-booster", label: "Booster Pack", icon: "📦" },

  // ── Day 4 ─────────────────────────────────────────────────────────────
  { day: 4,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 4,  track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 5: Hito — Profile Coin ────────────────────────────────────────
  { day: 5,  track: "standard", rewardType: "profile_coin", rewardId: "lucario", label: "Moneda: Lucario", icon: "🥇" },
  { day: 5,  track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 6 ─────────────────────────────────────────────────────────────
  { day: 6,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 6,  track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 7 ─────────────────────────────────────────────────────────────
  { day: 7,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 7,  track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 8 (premium intercalated: profile coin) ────────────────────────
  { day: 8,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 8,  track: "premium",  rewardType: "profile_coin", rewardId: "charizard", label: "Moneda: Charizard", icon: "🔥" },

  // ── Day 9 ─────────────────────────────────────────────────────────────
  { day: 9,  track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 9,  track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 10: Hito — Card Back ──────────────────────────────────────────
  { day: 10, track: "standard", rewardType: "card_back",    rewardId: "pikachu", label: "Dorso: Pikachu", icon: "🎴" },
  { day: 10, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 11 ────────────────────────────────────────────────────────────
  { day: 11, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 11, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 12 ────────────────────────────────────────────────────────────
  { day: 12, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 12, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 13 (premium intercalated: card back) ──────────────────────────
  { day: 13, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 13, track: "premium",  rewardType: "card_back",    rewardId: "haymaker", label: "Dorso: Haymaker", icon: "🎴" },

  // ── Day 14 ────────────────────────────────────────────────────────────
  { day: 14, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 14, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 15: Hito — Playmat ────────────────────────────────────────────
  { day: 15, track: "standard", rewardType: "playmat",      rewardId: "stadium", label: "Tapete: Estadio", icon: "🏟️" },
  { day: 15, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 16 ────────────────────────────────────────────────────────────
  { day: 16, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 16, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 17 ────────────────────────────────────────────────────────────
  { day: 17, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 17, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 18 (premium intercalated: playmat) ────────────────────────────
  { day: 18, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 18, track: "premium",  rewardType: "playmat",      rewardId: "street", label: "Tapete: Calle",   icon: "🏟️" },

  // ── Day 19 ────────────────────────────────────────────────────────────
  { day: 19, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 19, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 20: Hito — Avatar ─────────────────────────────────────────────
  { day: 20, track: "standard", rewardType: "avatar",       rewardId: "snorlax", label: "Avatar: Snorlax", icon: "😴" },
  { day: 20, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 21 ────────────────────────────────────────────────────────────
  { day: 21, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 21, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 22 ────────────────────────────────────────────────────────────
  { day: 22, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 22, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 23 (premium intercalated: avatar) ─────────────────────────────
  { day: 23, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 23, track: "premium",  rewardType: "avatar",       rewardId: "pikachu", label: "Avatar: Pikachu", icon: "⚡" },

  // ── Day 24 ────────────────────────────────────────────────────────────
  { day: 24, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 24, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 25: Hito — Random Card ────────────────────────────────────────
  { day: 25, track: "standard", rewardType: "random_card",                label: "Carta Misteriosa",       icon: "❓" },
  { day: 25, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 26 ────────────────────────────────────────────────────────────
  { day: 26, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 26, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 27 ────────────────────────────────────────────────────────────
  { day: 27, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 27, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 28 ────────────────────────────────────────────────────────────
  { day: 28, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 28, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 29 ────────────────────────────────────────────────────────────
  { day: 29, track: "standard", rewardType: "coins",        amount: 100,  label: "100 Monedas",            icon: "🪙" },
  { day: 29, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },

  // ── Day 30: Grand Finale — Card Skin Variant ──────────────────────────
  { day: 30, track: "standard", rewardType: "card_skin",    rewardId: "charizard-sepia", label: "Variante: Charizard Sepia", icon: "🎨" },
  { day: 30, track: "premium",  rewardType: "coins",        amount: 200,  label: "200 Monedas",            icon: "🪙" },
];

// Keep old export name for backward compatibility with seed.ts
export const SEASON_1_REWARDS = DEFAULT_MONTHLY_REWARDS;
