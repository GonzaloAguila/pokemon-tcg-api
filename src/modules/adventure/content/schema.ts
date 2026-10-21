/**
 * Shape of an adventure file (`content/adventures/<id>.json`). The cross-checks against the card
 * catalog and between sections (deck sizes, pools, evolution chains…) live in `validate.ts`.
 */
import { z } from "zod";
import { ADVENTURE_PASSIVES } from "../engine-types.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "id inválido (minúsculas, números y guiones)");
const text = z.string().min(1).max(200);
const cardId = z.string().min(1).max(100);
const qty = z.number().int().min(1).max(60);

export const DIFFICULTIES = ["normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const cardEntrySchema = z.object({ cardId, qty }).strict();
const deckSchema = z.array(cardEntrySchema).min(1).max(60);

export const STARTER_REFS = ["starter.basic", "starter.stage1", "starter.stage2"] as const;
/** A treasure card: a catalog id, or a token resolved with the run's starter line. */
const treasureCardSchema = z.union([
  cardEntrySchema,
  z.object({ ref: z.enum(STARTER_REFS), qty }).strict(),
]);

const passiveSchema = z.enum(ADVENTURE_PASSIVES);
const side = z.enum(["player", "opponent"]);
const prizes = z.number().int().min(1).max(6);
const hand = z.number().int().min(1).max(15);

const sidePairModifier = <T extends "prizeCount" | "openingHand">(type: T, value: z.ZodNumber) =>
  z
    .object({ type: z.literal(type), player: value.optional(), opponent: value.optional() })
    .strict()
    .refine((m) => m.player !== undefined || m.opponent !== undefined, `${type}: falta player u opponent`);

/** Battle modifiers: the closed vocabulary of design §3.5 (each one an engine hook). */
export const modifierSchema = z.union([
  sidePairModifier("prizeCount", prizes),
  sidePairModifier("openingHand", hand),
  z.object({ type: z.literal("noPrizeFor"), side, names: z.array(text).min(1).max(10) }).strict(),
  z.object({ type: z.literal("bonusCards"), side, cards: z.array(cardEntrySchema).min(1).max(10), to: z.literal("hand") }).strict(),
  z
    .object({
      type: z.literal("opponentSetup"),
      active: z.array(cardId).min(1).max(3),
      bench: z.array(z.array(cardId).min(1).max(3)).max(5),
    })
    .strict(),
  z.object({ type: z.literal("opponentPassives"), passives: z.array(passiveSchema).min(1).max(5) }).strict(),
]);

const opponentSchema = z
  .object({
    name: text,
    trainerClass: text,
    /** Catalog id of the Pokémon shown on the map (default: the deck's first Pokémon). */
    lead: cardId.optional(),
    deck: deckSchema.optional(),
    /** A deck per difficulty: hard is one deck, or one per starter (`byStarter`). */
    deckByDifficulty: z
      .object({
        normal: deckSchema,
        hard: z.union([deckSchema, z.object({ byStarter: z.record(id, deckSchema) }).strict()]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((o) => (o.deck === undefined) !== (o.deckByDifficulty === undefined), "el rival necesita deck o deckByDifficulty (uno solo)");

export const TREASURE_POOLS = ["tier1", "major", "tier2"] as const;
export type TreasurePoolId = (typeof TREASURE_POOLS)[number];

const battleSchema = z
  .object({
    index: z.number().int().min(1).max(10),
    id,
    location: text,
    opponent: opponentSchema,
    treasurePool: z.enum(TREASURE_POOLS).nullable(),
    modifiers: z.array(modifierSchema).max(10),
    /** A difficulty's own battle rules: they replace `modifiers` in runs of that difficulty. */
    modifiersByDifficulty: z
      .object({ normal: z.array(modifierSchema).max(10).optional(), hard: z.array(modifierSchema).max(10).optional() })
      .strict()
      .optional(),
  })
  .strict();

/** How rare a treasure is: weights its chance in an offer (`treasureOffer.rarityWeights`) and its tag. */
export const TREASURE_RARITIES = ["common", "rare", "epic"] as const;
export type TreasureRarity = (typeof TREASURE_RARITIES)[number];
const rarity = z.enum(TREASURE_RARITIES);

const treasureSchema = z.discriminatedUnion("kind", [
  z
    .object({ id, name: text, description: text, rarity, kind: z.literal("cards"), cards: z.array(treasureCardSchema).min(1).max(10) })
    .strict(),
  z.object({ id, name: text, description: text, rarity, kind: z.literal("passive"), passive: passiveSchema }).strict(),
]);

const weight = z.number().int().min(1).max(1000);
/** How offers are drawn from a battle's pool (run-logic `generateOffer`). */
const treasureOfferSchema = z
  .object({
    /** Relative chance of each rarity among an offer's candidates. */
    rarityWeights: z.object({ common: weight, rare: weight, epic: weight }).strict(),
    /** Most passive treasures in one offer. */
    maxPassives: z.number().int().min(0).max(3),
  })
  .strict();

/** The offer pools: treasure ids per pool a battle may name. */
const treasurePoolsSchema = z.object({ tier1: z.array(id), major: z.array(id), tier2: z.array(id) }).strict();

/**
 * What changes with the difficulty. `description` is the one-line Spanish summary of the new-run
 * screen; every other field, when present, replaces the adventure's own (`rules.hearts`,
 * `treasurePools`, `treasureOffer`) in runs of that difficulty.
 */
const difficultySchema = z
  .object({
    description: text,
    hearts: z.number().int().min(1).max(10).optional(),
    treasurePools: treasurePoolsSchema.optional(),
    treasureOffer: treasureOfferSchema.optional(),
  })
  .strict();

const rewardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cosmetic"), cosmeticType: z.literal("cardBack"), id, name: text }).strict(),
  z.object({ type: z.literal("starter_unlock"), id, name: text }).strict(),
  z.object({ type: z.literal("card"), cardId, name: text }).strict(),
]);

/** Achievement conditions, read from AdventureProgress (achievements checker "adventure"). */
const achievementConditionSchema = z.discriminatedUnion("type", [
  /** at least one won run (in `difficulty`, or any) */
  z.object({ type: z.literal("clear"), difficulty: z.enum(DIFFICULTIES).optional() }).strict(),
  /** a won run without losing a heart */
  z.object({ type: z.literal("flawless") }).strict(),
  /** won with every starter (in `difficulty`, or across both) */
  z.object({ type: z.literal("allStarters"), difficulty: z.enum(DIFFICULTIES).optional() }).strict(),
  /** a won run that skipped every treasure */
  z.object({ type: z.literal("purist") }).strict(),
  /** a won run whose decks never had a card / basic Energy off the starter's type */
  z.object({ type: z.literal("monotype") }).strict(),
]);
export type AchievementCondition = z.infer<typeof achievementConditionSchema>;

export const ACHIEVEMENT_TIERS = ["bronze", "silver", "gold", "platinum", "legend"] as const;

/** Cosmetic types an adventure achievement may grant on claim (prizes/catalog.ts ADVENTURE_*). */
export const ACHIEVEMENT_COSMETIC_TYPES = ["playmat", "cardBack"] as const;
export type AchievementCosmeticType = (typeof ACHIEVEMENT_COSMETIC_TYPES)[number];

const achievementSchema = z
  .object({
    id: z.string().regex(/^adventure-[a-z0-9-]{1,60}$/, "los logros de aventura empiezan con 'adventure-'"),
    name: text,
    description: text,
    tier: z.enum(ACHIEVEMENT_TIERS),
    condition: achievementConditionSchema,
    /** An exclusive cosmetic granted with the tier reward when the achievement is claimed. */
    cosmetic: z.object({ type: z.enum(ACHIEVEMENT_COSMETIC_TYPES), id, name: text }).strict().optional(),
  })
  .strict();

const starterSchema = z
  .object({
    id,
    name: text,
    energyType: z.enum(["grass", "fire", "water", "lightning", "psychic", "fighting"]),
    line: z.object({ basic: cardId, stage1: cardId, stage2: cardId }).strict(),
    deck: deckSchema,
    /** Playable only with a UserStarterUnlock row (reward type starter_unlock, e.g. Pikachu). */
    requiresUnlock: z.boolean().optional(),
  })
  .strict();

export const adventureSchema = z
  .object({
    id,
    version: z.number().int().min(1),
    name: text,
    description: text,
    rules: z
      .object({
        hearts: z.number().int().min(1).max(10),
        prizeCount: prizes,
        openingHand: hand,
        minDeckSize: z.number().int().min(1).max(60),
        maxDeckSize: z.number().int().min(1).max(60),
        /** null = no copy limit (adventure mode, owner ruling 2026-10-21) */
        maxCopies: z.number().int().min(1).nullable(),
      })
      .strict(),
    starters: z.array(starterSchema).min(1).max(10),
    battles: z.array(battleSchema).min(1).max(20),
    /** Per difficulty: its description and what it changes (hearts, treasure pools, offer weights). */
    difficulties: z.object({ normal: difficultySchema, hard: difficultySchema }).strict(),
    treasurePools: treasurePoolsSchema,
    treasures: z.array(treasureSchema).min(1).max(100),
    treasureOffer: treasureOfferSchema,
    rewards: z.object({ normal: rewardSchema, hard: rewardSchema }).strict(),
    achievements: z.array(achievementSchema).max(30),
  })
  .strict();

export type AdventureContent = z.infer<typeof adventureSchema>;
export type AdventureStarter = AdventureContent["starters"][number];
export type AdventureBattle = AdventureContent["battles"][number];
export type AdventureTreasure = AdventureContent["treasures"][number];
export type AdventureReward = AdventureContent["rewards"]["normal"];
export type AdventureAchievement = AdventureContent["achievements"][number];
export type AchievementCosmetic = NonNullable<AdventureAchievement["cosmetic"]>;
export type TreasurePools = AdventureContent["treasurePools"];
export type TreasureOffer = AdventureContent["treasureOffer"];
export type TreasureCard = z.infer<typeof treasureCardSchema>;
