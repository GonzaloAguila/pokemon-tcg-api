import { CardRarity, LUCKY_DUEL_BASICS, getSetById } from "@gonzaloaguila/game-core";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import * as usersService from "../users/users.service.js";
import type { CardChangeReason } from "../users/card-ledger.js";
import { Errors } from "../../middleware/error-handler.js";
import { getAdventures } from "../adventure/content/load.js";
import type { AchievementCondition, AchievementCosmetic } from "../adventure/content/schema.js";
import { achievementCosmeticView, grantAchievementCosmetic } from "../adventure/cosmetics.js";
import { CHALLENGE_DEFS, challengeProgress, loadChallengeGames, type ChallengeId } from "./challenges.js";

// ---------------------------------------------------------------------------
// Tier rewards
// ---------------------------------------------------------------------------

const TIER_REWARDS: Record<string, { coins: number; coupons: number }> = {
  bronze:   { coins: 200,  coupons: 0 },
  silver:   { coins: 500,  coupons: 0 },
  gold:     { coins: 800,  coupons: 2 },
  platinum: { coins: 1500, coupons: 10 },
  legend:   { coins: 5000, coupons: 100 },
};

// ---------------------------------------------------------------------------
// Achievement definitions (server-side source of truth, served by GET /achievements)
//
// status:
//   "active"      — progresses and can be claimed.
//   "retired"     — economy v2 replaced it (collection % and coin-balance achievements are now
//                   the per-set milestones of /api/economy/milestones). It no longer progresses
//                   or pays; rewards already claimed are kept.
//   ("unavailable" was the "Próximamente" achievements of the "manual" checker: replaced on
//   2026-10-23 by the challenge achievements below; the status stays in the API's type.)
//
// Win / game / streak achievements read UserStats, which only counts online games (normal,
// ranked, draft; not friendly or vs AI) that passed the anti-farming rules (turn 3, 2 minutes,
// max 3 counted wins per day against the same opponent; see modules/matches).
//
// Lucky Duel achievements read every decided Lucky Duel, vs the AI and multiplayer (counted or
// not: a Lucky Duel can end on turn 1; friendly tables excluded; a draw is not a win):
//   "lucky-streak"     — UserStats.luckyDuelBestStreak (both modes; a loss, draw or abandon resets
//                        the current run).
//   "lucky-first-turn" — a won Lucky Duel whose last turn was the winner's first turn (turn 1 if
//                        they started, turn 2 if the rival did).
//   "lucky-win-with"   — a won Lucky Duel whose drawn Basic's name contains `starter` (and, with
//                        `against`, whose rival's drawn Basic's name contains it).
//
// Activity achievements (data already stored; also checked after a check-in and after opening
// packs, so they progress without a match):
//   "packs-opened" — packs the user opened: card-history rows of a pack (bought, daily, inventory,
//                    wheel/slots prize; one row per pack), or the legacy coin rows of pack
//                    purchases when those are more (purchases from before the card history).
//   "login-streak" — longest run of consecutive economy days with a check-in (EconomyClaim
//                    "check_in", key = the economy day; only verified accounts check in). It is
//                    computed over every check-in ever, so it never goes down.
//   "login-days"   — User.loginDays (+1 per economy day on a verified check-in).
//
// Collection achievements:
//   "collection"      — distinct cards of any set the user owns (UserCard.quantity > 0).
//   "holo-collection" — distinct Base Set Rare Holo cards the user owns ("Holo Completo": the 16
//                       holos of game-core's catalog, BASE_SET_HOLO_IDS). Re-checked after every
//                       card gain that can complete it: packs, trades, market, Fichas de canje,
//                       wheel/slots card prizes, battle pass, drafts, adventures.
//
// Challenge achievements (checker "challenge", challenges.ts): advanced goals of multiplayer games
// (decks as played, played wins, feats), read from the user's settled match rows. Like the Modo
// Aventura ones they don't count for "Leyenda Viviente".
//
// Modo Aventura achievements come from the adventure files (content/adventures/*.json,
// `achievements[]`, checker "adventure"): their `condition` is read from the user's
// AdventureProgress row of that adventure (won runs only; abandoned runs count nothing). They
// don't count for "Leyenda Viviente" (owner Q5: adding them must not raise everyone's target).
// ---------------------------------------------------------------------------

type CheckerType =
  | "stats-wins"
  | "stats-games"
  | "stats-streak"
  | "collection"
  | "holo-collection"
  | "coins"
  | "level"
  | "meta"
  | "challenge"
  | "lucky-streak"
  | "lucky-first-turn"
  | "lucky-win-with"
  | "adventure"
  | "packs-opened"
  | "login-streak"
  | "login-days";
export type AchievementStatus = "active" | "retired" | "unavailable";

interface AchievementDef {
  id: string;
  name: string;
  description: string;
  tier: string;
  progressTarget: number;
  checker: CheckerType;
  status: AchievementStatus;
  /** "lucky-win-with": part of the name of the player's drawn Basic, and of the rival's. */
  starter?: string;
  against?: string;
  /** "adventure": the adventure and the condition from its file. */
  adventureId?: string;
  condition?: AchievementCondition;
  /** An exclusive cosmetic granted with the reward on claim (adventure achievements). */
  cosmetic?: AchievementCosmetic;
  /** "challenge": which one (challenges.ts). */
  challengeId?: ChallengeId;
}

/** Catalog ids of the Base Set Rare Holo cards ("Holo Completo": 16 in game-core's catalog). */
export const BASE_SET_HOLO_IDS: readonly string[] = (getSetById("base-set")?.cards ?? [])
  .filter((card) => card.rarity === CardRarity.RareHolo)
  .map((card) => card.id);

const RAW_DEFS: Omit<AchievementDef, "status">[] = [
  // Bronze (4; the rest were "Próximamente" until 2026-10-23)
  { id: "bronze-1",  name: "Primera Victoria",     description: "Gana tu primera partida online", tier: "bronze", progressTarget: 1, checker: "stats-wins" },
  { id: "bronze-2",  name: "Coleccionista Novato", description: "Consigue tu primera carta", tier: "bronze", progressTarget: 1, checker: "collection" },
  { id: "bronze-5",  name: "Primer Sobre",         description: "Abre tu primer sobre de cartas", tier: "bronze", progressTarget: 1, checker: "packs-opened" },
  { id: "bronze-6",  name: "Entrenador Dedicado",  description: "Juega 10 partidas online", tier: "bronze", progressTarget: 10, checker: "stats-games" },

  // Silver (5)
  { id: "silver-16", name: "Racha de 5",           description: "Gana 5 partidas online seguidas", tier: "silver", progressTarget: 5, checker: "stats-streak" },
  { id: "silver-17", name: "Semana Activa",        description: "Entra 7 días seguidos", tier: "silver", progressTarget: 7, checker: "login-streak" },
  { id: "silver-19", name: "Coleccionista",        description: "Consigue 25 cartas diferentes (de cualquier set)", tier: "silver", progressTarget: 25, checker: "collection" },
  { id: "silver-26", name: "50 Victorias",         description: "Acumula 50 victorias online", tier: "silver", progressTarget: 50, checker: "stats-wins" },
  { id: "silver-27", name: "Entrenador Experto",   description: "Alcanza el nivel 15", tier: "silver", progressTarget: 15, checker: "level" },

  // Gold (7)
  { id: "gold-28",   name: "Racha de 10",          description: "Gana 10 partidas online seguidas", tier: "gold", progressTarget: 10, checker: "stats-streak" },
  { id: "gold-29",   name: "Centenario",           description: "Gana 100 partidas online", tier: "gold", progressTarget: 100, checker: "stats-wins" },
  { id: "gold-30",   name: "Colección 75%",        description: "Retirado: ahora son los hitos de colección por set", tier: "gold", progressTarget: 77, checker: "collection" },
  { id: "gold-31",   name: "Mes Dedicado",         description: "Entra 30 días seguidos", tier: "gold", progressTarget: 30, checker: "login-streak" },
  { id: "gold-34",   name: "Veterano",             description: "Juega 200 partidas online", tier: "gold", progressTarget: 200, checker: "stats-games" },
  { id: "gold-35",   name: "Rica Colección",       description: "Retirado: ya no se premia acumular monedas", tier: "gold", progressTarget: 5000, checker: "coins" },
  { id: "gold-37",   name: "Maestro Trainer",      description: "Alcanza el nivel 30", tier: "gold", progressTarget: 30, checker: "level" },

  // Platinum (6)
  { id: "platinum-38", name: "Racha de 20",        description: "Gana 20 partidas online seguidas", tier: "platinum", progressTarget: 20, checker: "stats-streak" },
  { id: "platinum-39", name: "Quinientos",         description: "Gana 500 partidas online", tier: "platinum", progressTarget: 500, checker: "stats-wins" },
  { id: "platinum-40", name: "Holo Completo",      description: `Consigue las ${BASE_SET_HOLO_IDS.length} cartas holo de Base Set`, tier: "platinum", progressTarget: BASE_SET_HOLO_IDS.length, checker: "holo-collection" },
  { id: "platinum-41", name: "Año Activo",         description: "Entra 100 días distintos", tier: "platinum", progressTarget: 100, checker: "login-days" },
  { id: "platinum-43", name: "Millonario",         description: "Retirado: ya no se premia acumular monedas", tier: "platinum", progressTarget: 25000, checker: "coins" },
  { id: "platinum-44", name: "Sin Derrotas",       description: "Gana 30 partidas online seguidas", tier: "platinum", progressTarget: 30, checker: "stats-streak" },

  // Legend (5)
  { id: "legend-46", name: "Racha Legendaria",     description: "Gana 50 partidas online seguidas", tier: "legend", progressTarget: 50, checker: "stats-streak" },
  { id: "legend-47", name: "Mil Victorias",        description: "Gana 1000 partidas online", tier: "legend", progressTarget: 1000, checker: "stats-wins" },
  { id: "legend-48", name: "Colección Completa",   description: "Retirado: ahora son los hitos de colección por set", tier: "legend", progressTarget: 102, checker: "collection" },
  { id: "legend-49", name: "Invencible",           description: "Gana 100 partidas online seguidas", tier: "legend", progressTarget: 100, checker: "stats-streak" },
  { id: "legend-50", name: "Leyenda Viviente",     description: "Reclama todos los demás logros disponibles", tier: "legend", progressTarget: 0, checker: "meta" },

  // Lucky Duel (vs AI and multiplayer)
  { id: "lucky-first-turn",         name: "Primer golpe",       description: "Gana un Lucky Duel en tu primer turno", tier: "silver", progressTarget: 1, checker: "lucky-first-turn" },
  { id: "lucky-streak-10",          name: "Suerte imparable",   description: "Gana 10 Lucky Duel seguidos", tier: "gold", progressTarget: 10, checker: "lucky-streak" },
  { id: "lucky-magikarp",           name: "Magikarp campeón",   description: "Gana un Lucky Duel con Magikarp", tier: "silver", progressTarget: 1, checker: "lucky-win-with", starter: "Magikarp" },
  { id: "lucky-scyther-electabuzz", name: "Filo contra trueno", description: "Gana un Lucky Duel con Scyther contra Electabuzz", tier: "silver", progressTarget: 1, checker: "lucky-win-with", starter: "Scyther", against: "Electabuzz" },
];

/** Replaced by the per-set milestones (economy v2). */
const RETIRED_IDS = new Set(["gold-30", "legend-48", "gold-35", "platinum-43"]);

/** The achievements of every adventure file (allStarters: one step per starter). */
function adventureDefs(): AchievementDef[] {
  return [...getAdventures().values()].flatMap((adventure) =>
    adventure.achievements.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      tier: a.tier,
      progressTarget: a.condition.type === "allStarters" ? adventure.starters.length : 1,
      checker: "adventure" as const,
      status: "active" as const,
      adventureId: adventure.id,
      condition: a.condition,
      cosmetic: a.cosmetic,
    })),
  );
}

/** The challenge achievements (challenges.ts). */
function challengeDefs(): AchievementDef[] {
  return CHALLENGE_DEFS.map((c) => ({ ...c, checker: "challenge" as const, status: "active" as const, challengeId: c.id }));
}

/** Whether an achievement counts for "Leyenda Viviente": every obtainable one except adventures' and challenges'. */
const countsForMeta = (d: AchievementDef) =>
  d.status === "active" && d.checker !== "meta" && d.checker !== "adventure" && d.checker !== "challenge";

const ACHIEVEMENT_DEFS: AchievementDef[] = (() => {
  const defs: AchievementDef[] = RAW_DEFS.map((d) => ({
    ...d,
    status: RETIRED_IDS.has(d.id) ? "retired" : "active",
  }));
  // "Leyenda Viviente": every other achievement that can actually be obtained
  const meta = defs.find((d) => d.checker === "meta")!;
  meta.progressTarget = defs.filter(countsForMeta).length;
  return [...defs, ...challengeDefs(), ...adventureDefs()];
})();

/** Ids that count for "Leyenda Viviente". */
const META_IDS = new Set(ACHIEVEMENT_DEFS.filter(countsForMeta).map((d) => d.id));

interface AdventureProgressRow {
  adventureId: string;
  clearsNormal: number;
  clearsHard: number;
  clearedStartersNormal: string[];
  clearedStartersHard: string[];
  flawlessClears: number;
  puristClears: number;
  monotypeClears: number;
}

/** Progress of an "adventure" achievement from the user's AdventureProgress row. */
function adventureProgress(def: AchievementDef, row: AdventureProgressRow | undefined): number {
  const condition = def.condition;
  if (!row || !condition) return 0;
  switch (condition.type) {
    case "clear":
      if (condition.difficulty === "normal") return row.clearsNormal;
      if (condition.difficulty === "hard") return row.clearsHard;
      return row.clearsNormal + row.clearsHard;
    case "flawless":
      return row.flawlessClears;
    case "purist":
      return row.puristClears;
    case "monotype":
      return row.monotypeClears;
    case "allStarters": {
      const starters =
        condition.difficulty === "hard" ? row.clearedStartersHard
        : condition.difficulty === "normal" ? row.clearedStartersNormal
        : [...row.clearedStartersNormal, ...row.clearedStartersHard];
      const known = new Set(getAdventures().get(row.adventureId)?.starters.map((s) => s.id) ?? []);
      return new Set(starters.filter((id) => known.has(id))).size;
    }
  }
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ClaimableAchievement {
  achievementId: string;
  name: string;
  tier: string;
}

export interface ClaimResult {
  achievementId: string;
  coins: number;
  coupons: number;
  /** The cosmetic this claim granted (adventure achievements), else null. */
  cosmetic: ReturnType<typeof achievementCosmeticView>;
}

/** Definitions plus the user's state (GET /achievements). */
export async function listAchievements(userId: string) {
  const rows = await prisma.userAchievement.findMany({
    where: { userId },
    select: { achievementId: true, progress: true, unlockedAt: true },
  });
  const byId = new Map(rows.map((r) => [r.achievementId, r]));
  return ACHIEVEMENT_DEFS.map((d) => {
    const row = byId.get(d.id);
    const reward = TIER_REWARDS[d.tier] ?? { coins: 0, coupons: 0 };
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      tier: d.tier,
      status: d.status,
      progressTarget: d.progressTarget,
      // Claimed = complete, even if the target grew afterwards ("Leyenda Viviente" when
      // achievements are added): the stored progress is frozen at the claim
      progress: row?.unlockedAt ? d.progressTarget : Math.min(row?.progress ?? 0, d.progressTarget),
      claimed: !!row?.unlockedAt,
      claimedAt: row?.unlockedAt ?? null,
      claimable: d.status === "active" && !row?.unlockedAt && (row?.progress ?? 0) >= d.progressTarget,
      reward: d.status === "active" ? reward : { coins: 0, coupons: 0 },
      /** Exclusive cosmetic granted on claim (adventure achievements), else null. */
      cosmetic: achievementCosmeticView(d.cosmetic),
    };
  });
}

/**
 * Points per tier, shown on profiles. Mirrors TIER_CONFIG in the frontend's
 * src/domain/profile/types.ts — keep them in sync.
 */
export const ACHIEVEMENT_TIER_POINTS: Record<string, number> = {
  bronze: 10,
  silver: 25,
  gold: 50,
  platinum: 100,
  legend: 250,
};

/** Achievements a player has earned (claimed), newest first, with their points (public profiles). */
export async function listEarnedAchievements(userId: string) {
  const rows = await prisma.userAchievement.findMany({
    where: { userId, unlockedAt: { not: null } },
    select: { achievementId: true, unlockedAt: true },
    orderBy: { unlockedAt: "desc" },
  });
  const defs = new Map(ACHIEVEMENT_DEFS.map((d) => [d.id, d]));
  return rows.flatMap((row) => {
    const def = defs.get(row.achievementId);
    if (!def || !row.unlockedAt) return [];
    return [{
      id: def.id,
      name: def.name,
      tier: def.tier,
      points: ACHIEVEMENT_TIER_POINTS[def.tier] ?? 0,
      unlockedAt: row.unlockedAt,
    }];
  });
}

// ---------------------------------------------------------------------------
// Check and update all achievement progress for a user
// (Only updates progress — NEVER grants rewards or sets unlockedAt)
// ---------------------------------------------------------------------------

export async function checkAndUpdateProgress(userId: string): Promise<ClaimableAchievement[]> {
  // A real Promise (run once, awaited by several): Prisma's query promises are lazy thenables
  const existingQuery = Promise.resolve(
    prisma.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true, progress: true, unlockedAt: true },
    }),
  );
  // Data only some checkers read: queried (in parallel with the rest) only while one of their
  // achievements is still unclaimed
  const pending = (checker: CheckerType) =>
    existingQuery.then((rows) => {
      const claimed = new Set(rows.filter((r) => r.unlockedAt).map((r) => r.achievementId));
      return ACHIEVEMENT_DEFS.some((d) => d.checker === checker && d.status === "active" && !claimed.has(d.id));
    });

  // Load all needed data in parallel
  const [user, stats, distinctCardCount, existingAchievements, adventureRows, packsOpened, longestLoginStreak, holoCount, challengeGames] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { level: true, loginDays: true },
    }),
    prisma.userStats.findUnique({
      where: { userId },
      select: {
        normalWins: true,
        normalLosses: true,
        rankedWins: true,
        rankedLosses: true,
        draftWins: true,
        draftLosses: true,
        currentStreak: true,
        bestStreak: true,
        luckyDuelBestStreak: true,
      },
    }),
    // Distinct cards of any set: the two collection achievements still active (Coleccionista
    // Novato, Coleccionista) say "de cualquier set". The Base Set ones (Colección 75% / Completa,
    // the hotfix's base-set-only count) are retired in favour of the per-set milestones.
    prisma.userCard.count({ where: { userId, quantity: { gt: 0 } } }),
    existingQuery,
    prisma.adventureProgress.findMany({ where: { userId } }),
    pending("packs-opened").then((needed) => (needed ? countPacksOpened(userId) : 0)),
    pending("login-streak").then((needed) => (needed ? longestCheckInStreakOf(userId) : 0)),
    pending("holo-collection").then((needed) =>
      needed ? prisma.userCard.count({ where: { userId, quantity: { gt: 0 }, cardDefId: { in: [...BASE_SET_HOLO_IDS] } } }) : 0,
    ),
    pending("challenge").then((needed) => (needed ? loadChallengeGames(userId) : [])),
  ]);

  if (!user) return [];
  // An account without a UserStats row (signup always creates one) only progresses adventures
  const adventureById = new Map(adventureRows.map((row) => [row.adventureId, row]));

  const totalWins = stats ? stats.normalWins + stats.rankedWins + stats.draftWins : 0;
  const totalLosses = stats ? stats.normalLosses + stats.rankedLosses + stats.draftLosses : 0;
  const totalGames = totalWins + totalLosses;

  // Build a map of existing achievement state
  const existingMap = new Map(existingAchievements.map((a) => [a.achievementId, a]));

  // Claimed achievements that count for "Leyenda Viviente"
  const claimedCount = existingAchievements.filter((a) => a.unlockedAt !== null && META_IDS.has(a.achievementId)).length;

  const newlyClaimable: ClaimableAchievement[] = [];

  for (const def of ACHIEVEMENT_DEFS) {
    // Retired achievements no longer progress
    if (def.status !== "active") continue;
    // Claimed ones never change (skip their queries)
    if (existingMap.get(def.id)?.unlockedAt) continue;
    if (!stats && !CHECKERS_WITHOUT_STATS.has(def.checker)) continue;

    // Calculate current progress
    let currentProgress = 0;
    switch (def.checker) {
      case "stats-wins":
        currentProgress = totalWins;
        break;
      case "stats-games":
        currentProgress = totalGames;
        break;
      case "stats-streak":
        currentProgress = stats!.bestStreak;
        break;
      case "collection":
        currentProgress = distinctCardCount;
        break;
      case "holo-collection":
        currentProgress = holoCount;
        break;
      case "level":
        currentProgress = user.level;
        break;
      case "meta":
        currentProgress = claimedCount;
        break;
      case "lucky-streak":
        currentProgress = stats!.luckyDuelBestStreak;
        break;
      case "adventure":
        currentProgress = adventureProgress(def, adventureById.get(def.adventureId!));
        break;
      case "packs-opened":
        currentProgress = packsOpened;
        break;
      case "login-streak":
        currentProgress = longestLoginStreak;
        break;
      case "login-days":
        currentProgress = user.loginDays;
        break;
      case "lucky-first-turn":
      case "lucky-win-with":
        currentProgress = await prisma.match.count({ where: luckyDuelWinWhere(userId, def) });
        break;
      case "challenge":
        currentProgress = challengeProgress(def.challengeId!, challengeGames);
        break;
    }

    // Cap progress to target
    const progress = Math.min(currentProgress, def.progressTarget);
    const isComplete = currentProgress >= def.progressTarget;

    const existing = existingMap.get(def.id);

    if (!existing) {
      // No record exists — create one (never set unlockedAt here). skipDuplicates makes this
      // ON CONFLICT DO NOTHING, so concurrent checks (e.g. login + session restore) don't 500.
      const { count } = await prisma.userAchievement.createMany({
        data: [{ userId, achievementId: def.id, progress }],
        skipDuplicates: true,
      });

      if (count === 1 && isComplete) {
        newlyClaimable.push({ achievementId: def.id, name: def.name, tier: def.tier });
      }
    } else if (existing.unlockedAt === null) {
      // Record exists, not yet claimed — update progress if changed
      if (progress !== existing.progress) {
        await prisma.userAchievement.update({
          where: { userId_achievementId: { userId, achievementId: def.id } },
          data: { progress },
        });
      }
      // Track newly claimable (was below target, now at/above)
      if (isComplete && existing.progress < def.progressTarget) {
        newlyClaimable.push({ achievementId: def.id, name: def.name, tier: def.tier });
      }
    }
    // If already claimed (unlockedAt set), skip entirely
  }

  return newlyClaimable;
}

/**
 * Check the user's achievements without waiting (after a check-in, opening packs or another card
 * gain): errors are logged, never thrown to the caller.
 */
export function refreshProgressInBackground(userId: string, trigger: string): void {
  checkAndUpdateProgress(userId).catch((error) => console.error(`[achievements] check after ${trigger} failed for ${userId}:`, error));
}

// ---------------------------------------------------------------------------
// Activity achievements (packs opened, check-ins; see the header)
// ---------------------------------------------------------------------------

/** Checkers that don't read UserStats (they progress for an account without that row too). */
const CHECKERS_WITHOUT_STATS = new Set<CheckerType>(["adventure", "packs-opened", "login-streak", "login-days", "holo-collection", "challenge"]);

/** card_transactions reasons of an opened pack (one row per pack). */
const PACK_OPENING_REASONS: CardChangeReason[] = ["pack_purchase", "daily_pack", "stored_pack", "prize_pack"];

/**
 * Packs the user opened: their card-history rows, or the legacy coin rows of pack purchases
 * (`transactions.type` "pack_purchase", one per purchase of 1-10 packs) when those are more —
 * purchases made before the card history existed. Purchases since then write both rows, so the
 * two are never added.
 */
async function countPacksOpened(userId: string): Promise<number> {
  const [ledger, legacy] = await Promise.all([
    prisma.cardTransaction.count({ where: { userId, reason: { in: PACK_OPENING_REASONS } } }),
    prisma.transaction.count({ where: { userId, type: "pack_purchase" } }),
  ]);
  return Math.max(ledger, legacy);
}

async function longestCheckInStreakOf(userId: string): Promise<number> {
  const rows = await prisma.economyClaim.findMany({ where: { userId, kind: "check_in" }, select: { key: true } });
  return longestDayStreak(rows.map((r) => r.key));
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Longest run of consecutive days among economy-day keys ("YYYY-MM-DD", already the Argentina
 * calendar day: no time zone is applied here). Duplicates count once; malformed keys are ignored.
 */
export function longestDayStreak(keys: readonly string[]): number {
  const days = new Set<number>();
  for (const key of keys) {
    const match = DAY_KEY.exec(key);
    if (!match) continue;
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    // Reject impossible dates (2026-02-30 would roll over to March)
    if (new Date(ms).toISOString().slice(0, 10) !== key) continue;
    days.add(ms / 86_400_000);
  }
  const sorted = [...days].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Lucky Duel wins (matches rows; see the header)
// ---------------------------------------------------------------------------

/** Catalog ids of the Lucky Duel Basics whose name contains `name` (Misty's, Lt. Surge's, Dark… included). */
function luckyBasicIds(name: string): string[] {
  return LUCKY_DUEL_BASICS.filter((c) => c.name.includes(name)).map((c) => c.id);
}

/** The user's won Lucky Duels that meet a "lucky-first-turn" / "lucky-win-with" achievement. */
function luckyDuelWinWhere(userId: string, def: AchievementDef): Prisma.MatchWhereInput {
  const base: Prisma.MatchWhereInput = { winnerId: userId, gameMode: "lucky-duel", mode: { not: "friendly" } };
  if (def.checker === "lucky-first-turn") {
    // The winner's first turn: turn 1 if they started, turn 2 if the rival did
    return {
      ...base,
      OR: [
        { player1Id: userId, startingSide: "player1", finalTurn: 1 },
        { player1Id: userId, startingSide: "player2", finalTurn: 2 },
        { player2Id: userId, startingSide: "player2", finalTurn: 1 },
        { player2Id: userId, startingSide: "player1", finalTurn: 2 },
      ],
    };
  }
  const mine = { in: luckyBasicIds(def.starter ?? "") };
  const theirs = def.against ? { in: luckyBasicIds(def.against) } : undefined;
  return {
    ...base,
    OR: [
      { player1Id: userId, player1StarterId: mine, ...(theirs ? { player2StarterId: theirs } : {}) },
      { player2Id: userId, player2StarterId: mine, ...(theirs ? { player1StarterId: theirs } : {}) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Claim an achievement reward
// ---------------------------------------------------------------------------

export async function claimAchievement(userId: string, achievementId: string): Promise<ClaimResult> {
  const def = ACHIEVEMENT_DEFS.find((d) => d.id === achievementId);
  if (!def) throw Errors.NotFound("Logro");

  return prisma.$transaction(async (tx) => {
    if (def.status !== "active") {
      const record = await tx.userAchievement.findUnique({
        where: { userId_achievementId: { userId, achievementId } },
      });
      if (record?.unlockedAt) throw Errors.Conflict("Este logro ya fue reclamado");
      throw Errors.BadRequest(
        def.status === "retired" ? "Este logro fue retirado" : "Este logro todavía no está disponible",
      );
    }

    // Mark as claimed only if complete and unclaimed; concurrent claims match nothing.
    const { count } = await tx.userAchievement.updateMany({
      where: { userId, achievementId, unlockedAt: null, progress: { gte: def.progressTarget } },
      data: { unlockedAt: new Date() },
    });
    if (count === 0) {
      const record = await tx.userAchievement.findUnique({
        where: { userId_achievementId: { userId, achievementId } },
      });
      if (record?.unlockedAt) throw Errors.Conflict("Este logro ya fue reclamado");
      throw Errors.BadRequest("Este logro todavía no está completo");
    }

    return grantReward(tx, userId, def);
  });
}

// ---------------------------------------------------------------------------
// Grant reward for an achievement
// ---------------------------------------------------------------------------

async function grantReward(tx: usersService.Db, userId: string, def: AchievementDef): Promise<ClaimResult> {
  const reward = TIER_REWARDS[def.tier] ?? { coins: 0, coupons: 0 };

  if (reward.coins > 0) {
    await usersService.addCoins(userId, reward.coins, "achievement", `Logro: ${def.name}`, tx);
  }
  if (reward.coupons > 0) {
    await usersService.addCoupons(userId, reward.coupons, "achievement", `Logro: ${def.name}`, tx);
  }
  // Same transaction as the claim (unlockedAt set once), so it is granted exactly once
  if (def.cosmetic) await grantAchievementCosmetic(tx, userId, def.cosmetic);

  return {
    achievementId: def.id,
    coins: reward.coins,
    coupons: reward.coupons,
    cosmetic: achievementCosmeticView(def.cosmetic),
  };
}

// ---------------------------------------------------------------------------
// Cosmetics of achievements claimed before the achievement had one
// ---------------------------------------------------------------------------

/**
 * Give every player who already claimed an achievement its cosmetic (added to the content after
 * they claimed it), once per deploy that adds one. Idempotent: cosmetics already owned are
 * skipped, and nothing ever removes a cosmetic. Returns how many were granted per achievement.
 *   node -e "require('./dist/modules/achievements/achievements.service.js').backfillAchievementCosmetics().then((r) => { console.log(r); process.exit(0); })"
 */
export async function backfillAchievementCosmetics(): Promise<Record<string, number>> {
  const granted: Record<string, number> = {};
  for (const def of ACHIEVEMENT_DEFS) {
    if (!def.cosmetic) continue;
    const claimed = await prisma.userAchievement.findMany({
      where: { achievementId: def.id, unlockedAt: { not: null } },
      select: { userId: true },
    });
    const userIds = claimed.map((c) => c.userId);
    const { type, id } = def.cosmetic;
    const { count } =
      type === "playmat"
        ? await prisma.userPlaymat.createMany({ data: userIds.map((userId) => ({ userId, playmatId: id })), skipDuplicates: true })
        : await prisma.userCardBack.createMany({ data: userIds.map((userId) => ({ userId, cardBackId: id })), skipDuplicates: true });
    granted[def.id] = count;
  }
  return granted;
}
