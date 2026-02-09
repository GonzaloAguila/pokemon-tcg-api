/**
 * Booster Pack Service
 *
 * Handles pack definitions, opening logic, and daily limits.
 */

import {
  baseSetCards,
  jungleCards,
  type Card,
} from "@gonzaloaguila/game-core";

import type {
  BoosterPackType,
  BoosterPackListItem,
  PackOpeningResult,
  PulledCard,
  UserDailyLimit,
  DailyLimitStatus,
} from "./boosters.types.js";

// =============================================================================
// Configuration
// =============================================================================

const DAILY_PACK_LIMIT = 5;

// =============================================================================
// In-Memory Storage (will be replaced with DB later)
// =============================================================================

/** Pack type definitions */
const packTypes: Map<string, BoosterPackType> = new Map();

/** Daily limit tracking by oderId */
const dailyLimits: Map<string, UserDailyLimit> = new Map();

// =============================================================================
// Initialize Default Packs
// =============================================================================

function initializeDefaultPacks(): void {
  // Base Set Booster Pack - 11 cards
  const baseSetPack: BoosterPackType = {
    id: "base-set-booster",
    name: "Booster Pack",
    description: "Contains 11 random cards from the original Base Set. Includes 1 guaranteed Rare!",
    setId: "base-set",
    image: "/packs/booster_chari.png",
    cardCount: 11,
    slots: [
      { rarity: "rare", count: 1, holoChance: 0.33 },
      { rarity: "uncommon", count: 3, upgradeChance: 0.05 },
      { rarity: "common", count: 5 },
      // 2 energy cards handled separately
    ],
    price: 200,
    available: true,
  };

  // Base Set Theme Pack - 5 cards (smaller/cheaper option)
  const baseSetThemePack: BoosterPackType = {
    id: "base-set-theme-pack",
    name: "Theme Pack",
    description: "A smaller pack with 5 cards. Good for quick collection building!",
    setId: "base-set",
    image: "/packs/booster_venu.png",
    cardCount: 5,
    slots: [
      { rarity: "uncommon", count: 1, holoChance: 0.1 },
      { rarity: "common", count: 4 },
    ],
    price: 100,
    available: true,
  };

  // Jungle Booster Pack - 11 cards
  const junglePack: BoosterPackType = {
    id: "jungle-booster",
    name: "Jungle Booster",
    description: "Contains 11 random cards from the Jungle expansion. Includes 1 guaranteed Rare!",
    setId: "jungle",
    image: "/packs/jungle/Jungle_Booster_Scyther.webp",
    cardCount: 11,
    slots: [
      { rarity: "rare", count: 1, holoChance: 0.33 },
      { rarity: "uncommon", count: 3, upgradeChance: 0.05 },
      { rarity: "common", count: 5 },
    ],
    price: 200,
    available: true,
  };

  packTypes.set(baseSetPack.id, baseSetPack);
  packTypes.set(baseSetThemePack.id, baseSetThemePack);
  packTypes.set(junglePack.id, junglePack);
}

// Initialize on module load
initializeDefaultPacks();

// =============================================================================
// Pack Type CRUD
// =============================================================================

/**
 * Get all available pack types
 */
export function getAllPacks(): BoosterPackListItem[] {
  return Array.from(packTypes.values()).map((pack) => ({
    id: pack.id,
    name: pack.name,
    description: pack.description,
    setId: pack.setId,
    image: pack.image,
    cardCount: pack.cardCount,
    price: pack.price ?? 0,
    available: pack.available,
  }));
}

/**
 * Get a specific pack type by ID
 */
export function getPackById(packId: string): BoosterPackType | undefined {
  return packTypes.get(packId);
}

/**
 * Create a new pack type
 */
export function createPack(pack: BoosterPackType): BoosterPackType {
  if (packTypes.has(pack.id)) {
    throw new Error(`Pack with ID '${pack.id}' already exists`);
  }
  packTypes.set(pack.id, pack);
  return pack;
}

/**
 * Update an existing pack type
 */
export function updatePack(packId: string, updates: Partial<BoosterPackType>): BoosterPackType {
  const existing = packTypes.get(packId);
  if (!existing) {
    throw new Error(`Pack '${packId}' not found`);
  }
  const updated = { ...existing, ...updates, id: packId }; // Can't change ID
  packTypes.set(packId, updated);
  return updated;
}

/**
 * Delete a pack type
 */
export function deletePack(packId: string): boolean {
  return packTypes.delete(packId);
}

// =============================================================================
// Pack Opening Logic
// =============================================================================

/** Map set IDs to their card arrays */
const setCardMap: Record<string, Card[]> = {
  "base-set": baseSetCards,
  jungle: jungleCards,
};

/**
 * Get cards by rarity from a set
 */
function getCardsByRarity(setId: string, rarity: string): Card[] {
  const cards = setCardMap[setId];
  if (!cards) return [];

  return cards.filter((card) => {
    if (rarity === "rare-holo") {
      return card.rarity === "rare-holo";
    }
    if (rarity === "rare") {
      return card.rarity === "rare" || card.rarity === "rare-holo";
    }
    return card.rarity === rarity;
  });
}

/**
 * Get energy cards from a set (Jungle has no energy, falls back to Base Set)
 */
function getEnergyCards(setId: string): Card[] {
  const cards = setCardMap[setId] ?? baseSetCards;
  const energy = cards.filter((card) => card.kind === "energy");
  return energy.length > 0 ? energy : baseSetCards.filter((card) => card.kind === "energy");
}

/**
 * Pick random items from an array
 */
function pickRandom<T>(array: T[], count: number): T[] {
  const shuffled = [...array].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Open a pack and return the pulled cards
 */
export function openPack(packId: string): PackOpeningResult {
  const pack = packTypes.get(packId);
  if (!pack) {
    throw new Error(`Pack '${packId}' not found`);
  }

  if (!pack.available) {
    throw new Error(`Pack '${packId}' is not available`);
  }

  const pulledCards: PulledCard[] = [];

  // Process each slot in the distribution
  for (const slot of pack.slots) {
    for (let i = 0; i < slot.count; i++) {
      let targetRarity = slot.rarity;
      let isHolo = false;

      // Check for holo upgrade on rare slot
      if (slot.rarity === "rare" && slot.holoChance) {
        if (Math.random() < slot.holoChance) {
          targetRarity = "rare-holo";
          isHolo = true;
        }
      }

      // Per-card rarity upgrade (e.g. uncommon → rare)
      if (slot.upgradeChance && Math.random() < slot.upgradeChance) {
        if (slot.rarity === "uncommon") targetRarity = "rare";
        else if (slot.rarity === "common") targetRarity = "uncommon";
      }

      const availableCards = getCardsByRarity(pack.setId, targetRarity);
      if (availableCards.length === 0) continue;

      const [card] = pickRandom(availableCards, 1);
      pulledCards.push({
        card,
        slotType: isHolo ? "rare-holo" : targetRarity,
        isHolo: isHolo || card.rarity === "rare-holo",
      });
    }
  }

  // Add energy cards for standard booster packs (2 basic energy)
  if (pack.id === "base-set-booster" || pack.id === "jungle-booster") {
    const energyCards = getEnergyCards(pack.setId);
    const pickedEnergy = pickRandom(energyCards, 2);
    for (const card of pickedEnergy) {
      pulledCards.push({
        card,
        slotType: "energy",
        isHolo: false,
      });
    }
  }

  return {
    packId: pack.id,
    packName: pack.name,
    cards: pulledCards,
    openedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Daily Limit Management
// =============================================================================

/**
 * Get today's date string
 */
function getTodayString(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Get or create daily limit record for a user
 */
function getUserDailyLimit(userId: string): UserDailyLimit {
  const today = getTodayString();
  const key = `${userId}-${today}`;

  let record = dailyLimits.get(key);

  if (!record || record.date !== today) {
    // New day or new user, reset counter
    record = {
      userId,
      date: today,
      packsOpened: 0,
    };
    dailyLimits.set(key, record);
  }

  return record;
}

/**
 * Check daily limit status for a user
 */
export function getDailyLimitStatus(userId: string): DailyLimitStatus {
  const record = getUserDailyLimit(userId);
  const remaining = Math.max(0, DAILY_PACK_LIMIT - record.packsOpened);

  return {
    userId,
    date: record.date,
    packsOpened: record.packsOpened,
    packsRemaining: remaining,
    dailyLimit: DAILY_PACK_LIMIT,
    canOpen: remaining > 0,
  };
}

/**
 * Increment pack opened counter for a user
 */
export function recordPackOpening(userId: string): void {
  const record = getUserDailyLimit(userId);
  record.packsOpened++;
  dailyLimits.set(`${userId}-${record.date}`, record);
}

/**
 * Check if user can open a pack (has remaining daily limit)
 */
export function canUserOpenPack(userId: string): boolean {
  const status = getDailyLimitStatus(userId);
  return status.canOpen;
}

/**
 * Open a pack with daily limit check
 */
export function openPackWithLimit(packId: string, userId: string): PackOpeningResult {
  if (!canUserOpenPack(userId)) {
    throw new Error("Daily pack limit reached. Come back tomorrow!");
  }

  const result = openPack(packId);
  recordPackOpening(userId);

  return result;
}

// =============================================================================
// Cleanup (for memory management)
// =============================================================================

/**
 * Clean up old daily limit records (call periodically)
 */
export function cleanupOldRecords(): void {
  const today = getTodayString();

  for (const [key, record] of dailyLimits.entries()) {
    if (record.date !== today) {
      dailyLimits.delete(key);
    }
  }
}
