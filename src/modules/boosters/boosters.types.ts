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
  /** Rare slot: when the holo roll fails, a non-holo rare (any rare if the set has none) */
  nonHoloWhenNotHolo?: boolean;
}

/**
 * Definition of a booster pack type
 */
export interface BoosterPackType {
  id: string;
  name: string;
  description: string;
  /** Set the cards come from; for a Trainers-only booster an id of its own ("trainers", "gym-trainers") */
  setId: string;
  /** Trainers-only booster: cards come from these sets' Trainers instead of `setId` */
  trainerSetIds?: string[];
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
  /** Basic Energy cards added after the rarity slots (standard boosters: 2) */
  energyCount?: number;
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

/** Odds of one rarity inside a pack (see getPackOdds). */
export interface RarityOdds {
  /** "rare-holo" | "rare" | "uncommon" | "common" | "basic-energy" */
  rarity: string;
  /** Distinct cards of this rarity the pack can give */
  cards: number;
  /** Chance (0-1) of getting at least one copy of a given card of this rarity per pack */
  chancePerCard: number;
  /** Chance (0-1) of at least one card of this rarity per pack */
  chanceAtLeastOne: number;
  /** Expected cards of this rarity per pack */
  expectedPerPack: number;
}

export interface PackOdds {
  packId: string;
  name: string;
  setId: string;
  price: number;
  cardCount: number;
  /** Chance (0-1) of at least one holo per pack */
  holoChance: number;
  rarities: RarityOdds[];
  /** cardDefId -> chance (0-1) of at least one copy per pack */
  cardChances: Record<string, number>;
}
