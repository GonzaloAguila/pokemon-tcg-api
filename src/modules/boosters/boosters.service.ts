/**
 * Booster Pack Service
 *
 * Pack definitions, opening logic and the odds derived from it.
 *
 * There is no daily pack limit: the old in-memory DAILY_PACK_LIMIT was never enforced (and would
 * reset on every restart). Economy v2 bounds pack income through its faucets instead (daily
 * free pack, capped match coins, Rare Candy → coins capped per week), see modules/economy.
 */

import {
  ALL_CARDS,
  CARD_SETS,
  getSetById,
  isBasicEnergy,
  type Card,
} from "@gonzaloaguila/game-core";

import type { Db } from "../users/users.service.js";
import { ECONOMY } from "../economy/config.js";
import type {
  BoosterPackType,
  BoosterPackListItem,
  PackOpeningResult,
  PulledCard,
  PackOdds,
} from "./boosters.types.js";

// =============================================================================
// In-Memory Storage (pack definitions; DB-backed config is a later item)
// =============================================================================

/** Pack type definitions */
const packTypes: Map<string, BoosterPackType> = new Map();

// =============================================================================
// Initialize Default Packs
// =============================================================================

/**
 * Standard 11-card booster: 1 rare slot (33% holo, otherwise rare ∪ holo), 3 uncommons
 * (1% each to upgrade to the rare pool), 5 commons, 2 distinct basic Energy.
 * Every set listed here gets one; adding a set's booster = one entry (the cards come from
 * game-core's set registry).
 */
const STANDARD_BOOSTER_SLOTS: BoosterPackType["slots"] = [
  { rarity: "rare", count: 1, holoChance: 0.33 },
  { rarity: "uncommon", count: 3, upgradeChance: 0.01 },
  { rarity: "common", count: 5 },
];

interface SetBoosterDef {
  id: string;
  name: string;
  description: string;
  image: string;
}

/**
 * Booster per set id (keys must be ids in game-core's CARD_SETS). Every booster costs
 * ECONOMY.packs.price. (Base Set's 5-card "Theme Pack" for 100 was retired in economy v2: it was
 * API-only and its advertised 10% holo chance was never applied.)
 */
const SET_BOOSTERS: Record<string, SetBoosterDef> = {
  "base-set": {
    id: "base-set-booster",
    name: "Booster Pack",
    description: "Contains 11 random cards from the original Base Set. Includes 1 guaranteed Rare!",
    image: "/packs/booster_chari.png",
  },
  jungle: {
    id: "jungle-booster",
    name: "Jungle Booster",
    description: "Contains 11 random cards from the Jungle expansion. Includes 1 guaranteed Rare!",
    image: "/packs/jungle/Jungle_Booster_Scyther.webp",
  },
  fossil: {
    id: "fossil-booster",
    name: "Fossil Booster",
    description: "Contains 11 random cards from the Fossil expansion. Includes 1 guaranteed Rare!",
    image: "/packs/fossil/booster.png",
  },
  "team-rocket": {
    id: "team-rocket-booster",
    name: "Team Rocket Booster",
    description: "Contains 11 random cards from the Team Rocket expansion. Includes 1 guaranteed Rare!",
    image: "/packs/team-rocket/booster.png",
  },
};

/** Ids of the standard boosters, in set-registry order (one per set). */
export const STANDARD_BOOSTER_IDS: string[] = CARD_SETS.flatMap((set) => {
  const def = SET_BOOSTERS[set.id];
  return def ? [def.id] : [];
});

export function isStandardBoosterId(packId: string): boolean {
  return STANDARD_BOOSTER_IDS.includes(packId);
}

function initializeDefaultPacks(): void {
  for (const set of CARD_SETS) {
    const def = SET_BOOSTERS[set.id];
    if (!def) continue;
    packTypes.set(def.id, {
      ...def,
      setId: set.id,
      cardCount: 11,
      slots: STANDARD_BOOSTER_SLOTS,
      energyCount: 2,
      price: ECONOMY.packs.price,
      available: true,
    });
  }
}

/**
 * Trainers-only booster, sold in the market only: 11 Trainers of every set (1 rare slot with
 * 33% holo, 4 uncommons, 6 commons), no Energy. Not a STANDARD_BOOSTER_ID, so the daily free
 * pack, the welcome packs and prize packs keep giving set boosters.
 */
export const TRAINER_BOOSTER_ID = "trainer-booster";

const TRAINER_BOOSTER: BoosterPackType = {
  id: TRAINER_BOOSTER_ID,
  name: "Entrenadores",
  description: "Contains 11 random Trainer cards from every expansion. Includes 1 guaranteed Rare!",
  setId: "trainers",
  trainersOnly: true,
  image: "/packs/trainers/booster_oak.png",
  cardCount: 11,
  slots: [
    { rarity: "rare", count: 1, holoChance: 0.33 },
    { rarity: "uncommon", count: 4, upgradeChance: 0.01 },
    { rarity: "common", count: 6 },
  ],
  energyCount: 0,
  price: ECONOMY.packs.price,
  available: true,
};

// Initialize on module load
initializeDefaultPacks();
packTypes.set(TRAINER_BOOSTER.id, TRAINER_BOOSTER);

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

const ALL_TRAINERS: Card[] = ALL_CARDS.filter((card) => card.kind === "trainer");

/** Cards a pack draws from: its set in game-core's registry, or every Trainer */
function setCards(pack: Pick<BoosterPackType, "setId" | "trainersOnly">): Card[] {
  if (pack.trainersOnly) return ALL_TRAINERS;
  return getSetById(pack.setId)?.cards ?? [];
}

/**
 * Get cards by rarity from a pack's pool. The "rare" pool is rare ∪ rare-holo (sets without
 * non-holo rares — Jungle, Fossil, Team Rocket — therefore always give a holo in the rare slot).
 */
function getCardsByRarity(pack: Pick<BoosterPackType, "setId" | "trainersOnly">, rarity: string): Card[] {
  const cards = setCards(pack);
  if (cards.length === 0) return [];

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
 * Get basic energy cards from a set (excludes special energies like Double Colorless).
 * Sets without basic Energy (Jungle) use the first registry set that has them (Base Set).
 */
function getEnergyCards(pack: Pick<BoosterPackType, "setId" | "trainersOnly">): Card[] {
  const energy = setCards(pack).filter(isBasicEnergy);
  if (energy.length > 0) return energy;
  return CARD_SETS.map((set) => set.cards.filter(isBasicEnergy)).find((cards) => cards.length > 0) ?? [];
}

/** `count` distinct items, uniformly (partial Fisher–Yates). */
function pickRandom<T>(array: T[], count: number): T[] {
  const items = [...array];
  const n = Math.min(count, items.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (items.length - i));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.slice(0, n);
}

/** Possible rarity targets of one draw of `slot`, with their probabilities (mirrors openPack). */
function slotOutcomes(slot: BoosterPackType["slots"][number]): { probability: number; rarity: string; isHolo: boolean }[] {
  const base: { probability: number; rarity: string; isHolo: boolean }[] =
    slot.rarity === "rare" && slot.holoChance
      ? [
          { probability: slot.holoChance, rarity: "rare-holo", isHolo: true },
          { probability: 1 - slot.holoChance, rarity: "rare", isHolo: false },
        ]
      : [{ probability: 1, rarity: slot.rarity, isHolo: false }];
  if (!slot.upgradeChance) return base;
  const upgraded = slot.rarity === "uncommon" ? "rare" : slot.rarity === "common" ? "uncommon" : null;
  if (!upgraded) return base;
  return base.flatMap((o) => [
    { ...o, probability: o.probability * (1 - slot.upgradeChance!) },
    { probability: o.probability * slot.upgradeChance!, rarity: upgraded, isHolo: o.isHolo },
  ]);
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

      const availableCards = getCardsByRarity(pack, targetRarity);
      if (availableCards.length === 0) continue;

      const [card] = pickRandom(availableCards, 1);
      pulledCards.push({
        card,
        slotType: isHolo ? "rare-holo" : targetRarity,
        isHolo: isHolo || card.rarity === "rare-holo",
      });
    }
  }

  // Basic energy cards of standard booster packs
  if (pack.energyCount) {
    const energyCards = getEnergyCards(pack);
    const pickedEnergy = pickRandom(energyCards, pack.energyCount);
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

/** Add the pulled cards to the user's collection (inside the caller's transaction). */
export async function addPulledCards(tx: Db, userId: string, result: PackOpeningResult): Promise<void> {
  for (const pulled of result.cards) {
    await tx.userCard.upsert({
      where: { userId_cardDefId: { userId, cardDefId: pulled.card.id } },
      update: { quantity: { increment: 1 } },
      create: { userId, cardDefId: pulled.card.id, quantity: 1 },
    });
  }
}

/** Open `packId` and add its cards to the user's collection, inside the caller's transaction. */
export async function openPackForUser(tx: Db, userId: string, packId: string): Promise<PackOpeningResult> {
  const result = openPack(packId);
  await addPulledCards(tx, userId, result);
  return result;
}

// =============================================================================
// Odds (computed from the same slot definitions and pools openPack uses)
// =============================================================================

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function rarityGroup(card: Card): string {
  return isBasicEnergy(card) ? "basic-energy" : card.rarity;
}

/**
 * Exact odds of a pack: for every card, the chance to get at least one copy per pack; per
 * rarity, the pool size, the chance of a given card and the chance of at least one card of
 * that rarity. Draws are independent (the energy slot picks distinct cards).
 */
export function getPackOdds(packId: string): PackOdds | null {
  const pack = packTypes.get(packId);
  if (!pack) return null;

  // Per draw: probability of each card id
  const draws: Map<string, number>[] = [];
  for (const slot of pack.slots) {
    const outcomes = slotOutcomes(slot);
    for (let i = 0; i < slot.count; i++) {
      const dist = new Map<string, number>();
      for (const outcome of outcomes) {
        const pool = getCardsByRarity(pack, outcome.rarity);
        if (pool.length === 0) continue; // openPack skips the card
        for (const card of pool) dist.set(card.id, (dist.get(card.id) ?? 0) + outcome.probability / pool.length);
      }
      draws.push(dist);
    }
  }
  const energyChance = new Map<string, number>();
  if (pack.energyCount) {
    const energy = getEnergyCards(pack);
    for (const card of energy) energyChance.set(card.id, Math.min(1, pack.energyCount / energy.length));
  }

  const cardsById = new Map<string, Card>();
  for (const card of [...setCards(pack), ...getEnergyCards(pack)]) cardsById.set(card.id, card);

  const cardChances: Record<string, number> = {};
  for (const [id] of cardsById) {
    let none = 1 - (energyChance.get(id) ?? 0);
    for (const dist of draws) none *= 1 - (dist.get(id) ?? 0);
    const p = 1 - none;
    if (p > 0) cardChances[id] = round(p);
  }

  const groups = new Map<string, Card[]>();
  for (const card of cardsById.values()) {
    if (!cardChances[card.id]) continue;
    const key = rarityGroup(card);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const groupOrder = ["rare-holo", "rare", "uncommon", "common", "basic-energy"];
  const rarities = [...groups.entries()]
    .sort(([a], [b]) => groupOrder.indexOf(a) - groupOrder.indexOf(b))
    .map(([rarity, cards]) => {
      const ids = new Set(cards.map((c) => c.id));
      let none = 1;
      for (const dist of draws) {
        let p = 0;
        for (const id of ids) p += dist.get(id) ?? 0;
        none *= 1 - p;
      }
      // Energy slot: at least one of these energies (they are all basic Energy or none)
      if (rarity === "basic-energy" && pack.energyCount) none *= 0;
      let expected = 0;
      for (const id of ids) {
        expected += energyChance.has(id) ? energyChance.get(id)! : 0;
        for (const dist of draws) expected += dist.get(id) ?? 0;
      }
      return {
        rarity,
        cards: cards.length,
        chancePerCard: cardChances[cards[0].id],
        chanceAtLeastOne: round(1 - none),
        expectedPerPack: round(expected),
      };
    });

  return {
    packId: pack.id,
    name: pack.name,
    setId: pack.setId,
    price: pack.price ?? 0,
    cardCount: pack.cardCount,
    holoChance: rarities.find((r) => r.rarity === "rare-holo")?.chanceAtLeastOne ?? 0,
    rarities,
    cardChances,
  };
}

export function getAllPackOdds(): PackOdds[] {
  return [...packTypes.keys()].flatMap((id) => {
    const odds = getPackOdds(id);
    return odds && packTypes.get(id)?.available ? [odds] : [];
  });
}
