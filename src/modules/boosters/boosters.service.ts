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
  CARD_SETS,
  getSetById,
  getSetForCard,
  isBasicEnergy,
  UNSUPPORTED_TRAINERS,
  type Card,
} from "@gonzaloaguila/game-core";

import type { Db } from "../users/users.service.js";
import { RELEASED_CARDS, RELEASED_SETS, isReleasedSet } from "../../lib/released-sets.js";
import { recordCardChange, type CardChangeReason } from "../users/card-ledger.js";
import { ECONOMY } from "../economy/config.js";
import type {
  BoosterPackType,
  BoosterPackListItem,
  PackOpeningResult,
  PulledCard,
  PackOdds,
  PackSlotDistribution,
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
 * Chance that a booster's fourth uncommon is a second rare (rare ∪ holo pool), in every booster.
 * The owner dropped basic Energy from boosters (2026-10-21): cheap in the market and a wasted slot.
 */
export const SECOND_RARE_CHANCE = 0.1;

/**
 * Standard 11-card booster: 1 rare slot, 3 uncommons (1% each to upgrade to the rare pool),
 * 1 uncommon that is a second rare with SECOND_RARE_CHANCE, 6 commons. No basic Energy.
 * Every set listed here gets one; adding a set's booster = one entry (the cards come from
 * game-core's set registry).
 */
// The rare pool is rare ∪ rare-holo, every card equally likely (owner, 2026-10-23: "rara y
// rara-holo son un solo grupo"; a separate holo roll over a small holo pool made a few cards come
// out several times as often as the others). Sets with only holo rares always give a holo.
const STANDARD_BOOSTER_SLOTS: BoosterPackType["slots"] = [
  { rarity: "rare", count: 1 },
  { rarity: "uncommon", count: 3, upgradeChance: 0.01 },
  { rarity: "uncommon", count: 1, upgradeChance: SECOND_RARE_CHANCE },
  { rarity: "common", count: 6 },
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
  "gym-heroes": {
    id: "gym-heroes-booster",
    name: "Gym Heroes Booster",
    description: "Contains 11 random cards from the Gym Heroes expansion. Includes 1 guaranteed Rare!",
    image: "/packs/gym-heroes/booster.png",
  },
  "gym-challenge": {
    id: "gym-challenge-booster",
    name: "Gym Challenge Booster",
    description: "Contains 11 random cards from the Gym Challenge expansion. Includes 1 guaranteed Rare!",
    image: "/packs/gym-challenge/booster.png",
  },
};

/** Set name of each standard booster ("Base Set"), for the card history. */
const BOOSTER_SET_NAME = new Map(CARD_SETS.flatMap((set) => (SET_BOOSTERS[set.id] ? [[SET_BOOSTERS[set.id].id, set.name] as const] : [])));

/**
 * Ids of the standard boosters, in set-registry order (one per released set: a set still
 * `inDevelopment` in game-core is neither sold nor listed until the engine clears the flag).
 */
export const STANDARD_BOOSTER_IDS: string[] = RELEASED_SETS.flatMap((set) => {
  const def = SET_BOOSTERS[set.id];
  return def ? [def.id] : [];
});

/** The standard booster of a set, or null when the set has none (or is still in development). */
export function boosterIdForSet(setId: string): string | null {
  return isReleasedSet(setId) ? (SET_BOOSTERS[setId]?.id ?? null) : null;
}

export function isStandardBoosterId(packId: string): boolean {
  return STANDARD_BOOSTER_IDS.includes(packId);
}

function initializeDefaultPacks(): void {
  for (const set of RELEASED_SETS) {
    const def = SET_BOOSTERS[set.id];
    if (!def) continue;
    packTypes.set(def.id, {
      ...def,
      setId: set.id,
      cardCount: 11,
      slots: STANDARD_BOOSTER_SLOTS,
      energyCount: 0,
      price: ECONOMY.packs.price,
      available: true,
    });
  }
}

/**
 * Trainers-only boosters, sold in the market only: 11 Trainers of a group of sets (1 rare slot
 * from the same single rare pool, 4 uncommons — the fourth a second rare with SECOND_RARE_CHANCE —, 6 commons), no
 * Energy. One booster per era so each Trainer stays findable as sets are added (player
 * suggestion, 2026-10-22). Not STANDARD_BOOSTER_IDS, so the daily free pack, the welcome packs and
 * prize packs keep giving set boosters. A new set's Trainers go in one of these groups.
 */
/** Classic Trainers (the original id: it was the one Trainer booster before the split). */
export const TRAINER_BOOSTER_ID = "trainer-booster";
export const GYM_TRAINER_BOOSTER_ID = "gym-trainer-booster";

const TRAINER_BOOSTER_SLOTS: BoosterPackType["slots"] = [
  { rarity: "rare", count: 1 },
  { rarity: "uncommon", count: 3, upgradeChance: 0.01 },
  { rarity: "uncommon", count: 1, upgradeChance: SECOND_RARE_CHANCE },
  { rarity: "common", count: 6 },
];

const TRAINER_BOOSTERS: (Pick<BoosterPackType, "id" | "name" | "description" | "setId" | "image"> & { trainerSetIds: string[] })[] = [
  {
    id: TRAINER_BOOSTER_ID,
    name: "Entrenadores Clásicos",
    description: "Contains 11 random Trainer cards from Base Set, Jungle, Fossil and Team Rocket. Includes 1 guaranteed Rare!",
    setId: "trainers",
    trainerSetIds: ["base-set", "jungle", "fossil", "team-rocket"],
    image: "/packs/trainers/booster_oak.png",
  },
  {
    id: GYM_TRAINER_BOOSTER_ID,
    name: "Entrenadores de Gimnasio",
    description: "Contains 11 random Trainer cards from Gym Heroes and Gym Challenge. Includes 1 guaranteed Rare!",
    setId: "gym-trainers",
    trainerSetIds: ["gym-heroes", "gym-challenge"],
    image: "/packs/trainers-gym/booster_brock.png",
  },
];

/** Ids of the Trainer boosters on sale (a group whose sets are all in development isn't). */
export const TRAINER_BOOSTER_IDS: string[] = [];

function initializeTrainerBoosters(): void {
  for (const { trainerSetIds, ...def } of TRAINER_BOOSTERS) {
    const releasedSetIds = trainerSetIds.filter(isReleasedSet);
    if (releasedSetIds.length === 0) continue;
    packTypes.set(def.id, {
      ...def,
      trainerSetIds: releasedSetIds,
      cardCount: 11,
      slots: TRAINER_BOOSTER_SLOTS,
      energyCount: 0,
      price: ECONOMY.packs.price,
      available: true,
    });
    TRAINER_BOOSTER_IDS.push(def.id);
  }
}

// Initialize on module load
initializeDefaultPacks();
initializeTrainerBoosters();

// =============================================================================
// Pack Types (read-only; there is no admin CRUD)
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

// =============================================================================
// Pack Opening Logic
// =============================================================================

/**
 * Trainers the engine can't play yet (game-core UNSUPPORTED_TRAINERS: a set's cards still being
 * built) never come out of a booster.
 */
const UNSUPPORTED = new Set<string>(UNSUPPORTED_TRAINERS);
export function isOpenableCard(card: Card, unsupported: ReadonlySet<string> = UNSUPPORTED): boolean {
  return !(card.kind === "trainer" && unsupported.has(card.name));
}

type PackPool = Pick<BoosterPackType, "setId" | "trainerSetIds">;

/**
 * Cards a pack draws from: the playable Trainers of its sets for a Trainer booster; for a set
 * booster its set in game-core's registry without the Trainers (they only come in the Trainer
 * boosters) and without basic Energy (Base Set prints them as commons; boosters never give them).
 */
function setCards(pack: PackPool): Card[] {
  if (pack.trainerSetIds) {
    const setIds = new Set(pack.trainerSetIds);
    return RELEASED_CARDS.filter((card) => card.kind === "trainer" && isOpenableCard(card) && setIds.has(getSetForCard(card)?.id ?? ""));
  }
  return (getSetById(pack.setId)?.cards ?? []).filter(
    (card) => card.kind !== "trainer" && !isBasicEnergy(card) && isOpenableCard(card),
  );
}

/**
 * Get cards by rarity from a pack's pool. The "rare" pool is rare ∪ rare-holo (sets without
 * non-holo rares — Jungle, Fossil, Team Rocket — therefore always give a holo in the rare slot).
 */
function getCardsByRarity(pack: PackPool, rarity: string): Card[] {
  return setCards(pack).filter((card) =>
    rarity === "rare" ? card.rarity === "rare" || card.rarity === "rare-holo" : card.rarity === rarity,
  );
}

/**
 * Get basic energy cards from a set (excludes special energies like Double Colorless).
 * Sets without basic Energy (Jungle) use the first registry set that has them (Base Set).
 */
function getEnergyCards(pack: PackPool): Card[] {
  const energy = (pack.trainerSetIds ? [] : (getSetById(pack.setId)?.cards ?? [])).filter(isBasicEnergy);
  if (energy.length > 0) return energy;
  return CARD_SETS.map((set) => set.cards.filter(isBasicEnergy)).find((cards) => cards.length > 0) ?? [];
}

/** A card's weight in its pool (ECONOMY.packs.cardWeights, default 1). */
function cardWeight(card: Card): number {
  const weight = ECONOMY.packs.cardWeights[card.id];
  return weight !== undefined && weight > 0 ? weight : 1;
}

/** One card of the pool, each with its weight (cardWeight). */
function pickWeighted(cards: Card[]): Card {
  const total = cards.reduce((sum, card) => sum + cardWeight(card), 0);
  let roll = Math.random() * total;
  for (const card of cards) {
    roll -= cardWeight(card);
    if (roll < 0) return card;
  }
  return cards[cards.length - 1];
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
function slotOutcomes(slot: BoosterPackType["slots"][number]): { probability: number; rarity: string }[] {
  const upgraded = slot.rarity === "uncommon" ? "rare" : slot.rarity === "common" ? "uncommon" : null;
  if (!slot.upgradeChance || !upgraded) return [{ probability: 1, rarity: slot.rarity }];
  return [
    { probability: 1 - slot.upgradeChance, rarity: slot.rarity },
    { probability: slot.upgradeChance, rarity: upgraded },
  ];
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
      let targetRarity: PackSlotDistribution["rarity"] = slot.rarity;

      // Per-card rarity upgrade (e.g. uncommon → rare)
      if (slot.upgradeChance && Math.random() < slot.upgradeChance) {
        if (slot.rarity === "uncommon") targetRarity = "rare";
        else if (slot.rarity === "common") targetRarity = "uncommon";
      }

      const availableCards = getCardsByRarity(pack, targetRarity);
      if (availableCards.length === 0) continue;

      const card = pickWeighted(availableCards);
      const isHolo = card.rarity === "rare-holo";
      pulledCards.push({ card, slotType: isHolo ? "rare-holo" : targetRarity, isHolo });
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

/** How a pack reached the player, for the card history ("Sobre diario" → "Sobre diario: Base Set"). */
export interface PackSource {
  reason: CardChangeReason;
  label: string;
}

/** Add the pulled cards to the user's collection and card history (inside the caller's transaction). */
export async function addPulledCards(tx: Db, userId: string, result: PackOpeningResult, source: PackSource): Promise<void> {
  for (const pulled of result.cards) {
    await tx.userCard.upsert({
      where: { userId_cardDefId: { userId, cardDefId: pulled.card.id } },
      update: { quantity: { increment: 1 } },
      create: { userId, cardDefId: pulled.card.id, quantity: 1 },
    });
  }
  const changes = result.cards.map((pulled) => ({ cardDefId: pulled.card.id, quantity: 1 }));
  const packName = BOOSTER_SET_NAME.get(result.packId) ?? result.packName;
  await recordCardChange(tx, userId, source.reason, `${source.label}: ${packName}`, changes, result.packId);
}

/** Open `packId` and add its cards to the user's collection, inside the caller's transaction. */
export async function openPackForUser(tx: Db, userId: string, packId: string, source: PackSource): Promise<PackOpeningResult> {
  const result = openPack(packId);
  await addPulledCards(tx, userId, result, source);
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
        const totalWeight = pool.reduce((sum, card) => sum + cardWeight(card), 0);
        for (const card of pool) {
          dist.set(card.id, (dist.get(card.id) ?? 0) + (outcome.probability * cardWeight(card)) / totalWeight);
        }
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
        // A regular card of this rarity (cards with a lower weight come out less: cardChances)
        chancePerCard: Math.max(...cards.map((c) => cardChances[c.id])),
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
