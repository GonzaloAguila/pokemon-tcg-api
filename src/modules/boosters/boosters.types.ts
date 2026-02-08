/**
 * Booster Pack Types
 */

import type { Card } from "@gonzaloaguila/game-core";

/**
 * Defines how many cards of each rarity appear in a pack
 */
export interface PackSlotDistribution {
  rarity: "common" | "uncommon" | "rare" | "rare-holo";
  count: number;
  /** For rare slot: chance to upgrade to holo (0-1) */
  holoChance?: number;
  /** Per-card chance to upgrade rarity (e.g. uncommon → rare) */
  upgradeChance?: number;
}

/**
 * Definition of a booster pack type
 */
export interface BoosterPackType {
  id: string;
  name: string;
  description: string;
  setId: string;
  /** Image/artwork for the pack */
  image: string;
  /** Total cards in pack */
  cardCount: number;
  /** Distribution of rarities */
  slots: PackSlotDistribution[];
  /** Price in virtual currency (for future use) */
  price?: number;
  /** Is this pack available for opening? */
  available: boolean;
}

/**
 * Result of opening a pack
 */
export interface PackOpeningResult {
  packId: string;
  packName: string;
  cards: PulledCard[];
  openedAt: string;
}

/**
 * A card pulled from a pack with its slot info
 */
export interface PulledCard {
  card: Card;
  slotType: "common" | "uncommon" | "rare" | "rare-holo" | "energy";
  isHolo: boolean;
}

/**
 * Daily limit tracking (in-memory for now)
 */
export interface UserDailyLimit {
  userId: string;
  date: string; // YYYY-MM-DD
  packsOpened: number;
}

/**
 * Response for daily limit check
 */
export interface DailyLimitStatus {
  userId: string;
  date: string;
  packsOpened: number;
  packsRemaining: number;
  dailyLimit: number;
  canOpen: boolean;
}

/**
 * List item for pack display
 */
export interface BoosterPackListItem {
  id: string;
  name: string;
  description: string;
  setId: string;
  image: string;
  cardCount: number;
  price: number;
  available: boolean;
}
