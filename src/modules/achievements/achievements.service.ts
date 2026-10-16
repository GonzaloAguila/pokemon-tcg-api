import { prisma } from "../../lib/prisma.js";
import * as usersService from "../users/users.service.js";
import { Errors } from "../../middleware/error-handler.js";

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
//   "unavailable" — needs in-game event tracking that doesn't exist yet ("manual"); it can't
//                   progress, so it's shown as "Próximamente" and excluded from "Leyenda Viviente".
//
// Win / game / streak achievements read UserStats, which only counts online games (normal,
// ranked, draft; not friendly or vs AI) that passed the anti-farming rules (turn 3, 2 minutes,
// max 3 counted wins per day against the same opponent; see modules/matches).
// ---------------------------------------------------------------------------

type CheckerType = "stats-wins" | "stats-games" | "stats-streak" | "collection" | "coins" | "level" | "meta" | "manual";
export type AchievementStatus = "active" | "retired" | "unavailable";

interface AchievementDef {
  id: string;
  name: string;
  description: string;
  tier: string;
  progressTarget: number;
  checker: CheckerType;
  status: AchievementStatus;
}

const RAW_DEFS: Omit<AchievementDef, "status">[] = [
  // Bronze (15)
  { id: "bronze-1",  name: "Primera Victoria",     description: "Gana tu primera partida online", tier: "bronze", progressTarget: 1, checker: "stats-wins" },
  { id: "bronze-2",  name: "Coleccionista Novato", description: "Consigue tu primera carta", tier: "bronze", progressTarget: 1, checker: "collection" },
  { id: "bronze-3",  name: "Evolucionador",        description: "Evoluciona un Pokémon por primera vez", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-4",  name: "Energía Vital",        description: "Adjunta 10 energías en total", tier: "bronze", progressTarget: 10, checker: "manual" },
  { id: "bronze-5",  name: "Primer Sobre",         description: "Abre tu primer sobre de cartas", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-6",  name: "Entrenador Dedicado",  description: "Juega 10 partidas online", tier: "bronze", progressTarget: 10, checker: "stats-games" },
  { id: "bronze-7",  name: "Knock Out",            description: "Debilita 10 Pokémon enemigos", tier: "bronze", progressTarget: 10, checker: "manual" },
  { id: "bronze-8",  name: "Mano Llena",           description: "Ten 10 cartas en mano al mismo tiempo", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-9",  name: "Sin Piedad",           description: "Gana sin que tu rival tome premios", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-10", name: "Velocista",            description: "Gana una partida en menos de 10 turnos", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-11", name: "Deck Completo",        description: "Usa todas las cartas de un deck en una partida", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-12", name: "Tipo Agua",            description: "Gana con un deck de tipo Agua", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-13", name: "Tipo Fuego",           description: "Gana con un deck de tipo Fuego", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-14", name: "Tipo Planta",          description: "Gana con un deck de tipo Planta", tier: "bronze", progressTarget: 1, checker: "manual" },
  { id: "bronze-15", name: "Tipo Eléctrico",       description: "Gana con un deck de tipo Eléctrico", tier: "bronze", progressTarget: 1, checker: "manual" },

  // Silver (12)
  { id: "silver-16", name: "Racha de 5",           description: "Gana 5 partidas online seguidas", tier: "silver", progressTarget: 5, checker: "stats-streak" },
  { id: "silver-17", name: "Semana Activa",        description: "Inicia sesión 7 días seguidos", tier: "silver", progressTarget: 7, checker: "manual" },
  { id: "silver-18", name: "Intocable",            description: "Gana sin recibir daño en tu activo", tier: "silver", progressTarget: 1, checker: "manual" },
  { id: "silver-19", name: "Coleccionista",        description: "Consigue 25 cartas diferentes (de cualquier set)", tier: "silver", progressTarget: 25, checker: "collection" },
  { id: "silver-20", name: "Multi-deck",           description: "Gana con 3 decks diferentes", tier: "silver", progressTarget: 3, checker: "manual" },
  { id: "silver-21", name: "Estratega",            description: "Usa 5 cartas Trainer en un turno", tier: "silver", progressTarget: 1, checker: "manual" },
  { id: "silver-22", name: "Comeback",             description: "Gana estando 4 premios abajo", tier: "silver", progressTarget: 1, checker: "manual" },
  { id: "silver-23", name: "Súper Evolución",      description: "Evoluciona hasta Stage 2 en un turno", tier: "silver", progressTarget: 1, checker: "manual" },
  { id: "silver-24", name: "Crítico",              description: "Haz 100+ de daño en un ataque", tier: "silver", progressTarget: 1, checker: "manual" },
  { id: "silver-25", name: "Resistencia",          description: "Sobrevive 5 ataques con el mismo Pokémon", tier: "silver", progressTarget: 1, checker: "manual" },
  { id: "silver-26", name: "50 Victorias",         description: "Acumula 50 victorias online", tier: "silver", progressTarget: 50, checker: "stats-wins" },
  { id: "silver-27", name: "Entrenador Experto",   description: "Alcanza el nivel 15", tier: "silver", progressTarget: 15, checker: "level" },

  // Gold (10)
  { id: "gold-28",   name: "Racha de 10",          description: "Gana 10 partidas online seguidas", tier: "gold", progressTarget: 10, checker: "stats-streak" },
  { id: "gold-29",   name: "Centenario",           description: "Gana 100 partidas online", tier: "gold", progressTarget: 100, checker: "stats-wins" },
  { id: "gold-30",   name: "Colección 75%",        description: "Retirado: ahora son los hitos de colección por set", tier: "gold", progressTarget: 77, checker: "collection" },
  { id: "gold-31",   name: "Mes Dedicado",         description: "Inicia sesión 30 días seguidos", tier: "gold", progressTarget: 30, checker: "manual" },
  { id: "gold-32",   name: "Perfeccionista",       description: "Gana 10 partidas sin perder ningún Pokémon", tier: "gold", progressTarget: 10, checker: "manual" },
  { id: "gold-33",   name: "Domador",              description: "Usa todos los tipos de energía", tier: "gold", progressTarget: 7, checker: "manual" },
  { id: "gold-34",   name: "Veterano",             description: "Juega 200 partidas online", tier: "gold", progressTarget: 200, checker: "stats-games" },
  { id: "gold-35",   name: "Rica Colección",       description: "Retirado: ya no se premia acumular monedas", tier: "gold", progressTarget: 5000, checker: "coins" },
  { id: "gold-36",   name: "Todos los Decks",      description: "Gana con todos los theme decks", tier: "gold", progressTarget: 6, checker: "manual" },
  { id: "gold-37",   name: "Maestro Trainer",      description: "Alcanza el nivel 30", tier: "gold", progressTarget: 30, checker: "level" },

  // Platinum (8)
  { id: "platinum-38", name: "Racha de 20",        description: "Gana 20 partidas online seguidas", tier: "platinum", progressTarget: 20, checker: "stats-streak" },
  { id: "platinum-39", name: "Quinientos",         description: "Gana 500 partidas online", tier: "platinum", progressTarget: 500, checker: "stats-wins" },
  { id: "platinum-40", name: "Holo Completo",      description: "Consigue todas las cartas holo", tier: "platinum", progressTarget: 16, checker: "manual" },
  { id: "platinum-41", name: "Año Activo",         description: "Inicia sesión 100 días", tier: "platinum", progressTarget: 100, checker: "manual" },
  { id: "platinum-42", name: "Élite",              description: "Alcanza el top 100 del ranking", tier: "platinum", progressTarget: 1, checker: "manual" },
  { id: "platinum-43", name: "Millonario",         description: "Retirado: ya no se premia acumular monedas", tier: "platinum", progressTarget: 25000, checker: "coins" },
  { id: "platinum-44", name: "Sin Derrotas",       description: "Gana 50 partidas sin perder", tier: "platinum", progressTarget: 50, checker: "manual" },
  { id: "platinum-45", name: "Campeón",            description: "Gana 3 torneos", tier: "platinum", progressTarget: 3, checker: "manual" },

  // Legend (5)
  { id: "legend-46", name: "Racha Legendaria",     description: "Gana 50 partidas online seguidas", tier: "legend", progressTarget: 50, checker: "stats-streak" },
  { id: "legend-47", name: "Mil Victorias",        description: "Gana 1000 partidas online", tier: "legend", progressTarget: 1000, checker: "stats-wins" },
  { id: "legend-48", name: "Colección Completa",   description: "Retirado: ahora son los hitos de colección por set", tier: "legend", progressTarget: 102, checker: "collection" },
  { id: "legend-49", name: "Invencible",           description: "Gana 100 partidas sin perder", tier: "legend", progressTarget: 100, checker: "manual" },
  { id: "legend-50", name: "Leyenda Viviente",     description: "Reclama todos los demás logros disponibles", tier: "legend", progressTarget: 0, checker: "meta" },
];

/** Replaced by the per-set milestones (economy v2). */
const RETIRED_IDS = new Set(["gold-30", "legend-48", "gold-35", "platinum-43"]);

const ACHIEVEMENT_DEFS: AchievementDef[] = (() => {
  const defs: AchievementDef[] = RAW_DEFS.map((d) => ({
    ...d,
    status: RETIRED_IDS.has(d.id) ? "retired" : d.checker === "manual" ? "unavailable" : "active",
  }));
  // "Leyenda Viviente": every other achievement that can actually be obtained
  const meta = defs.find((d) => d.checker === "meta")!;
  meta.progressTarget = defs.filter((d) => d.status === "active" && d.checker !== "meta").length;
  return defs;
})();

/** Ids that count for "Leyenda Viviente". */
const META_IDS = new Set(ACHIEVEMENT_DEFS.filter((d) => d.status === "active" && d.checker !== "meta").map((d) => d.id));

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
      progress: Math.min(row?.progress ?? 0, d.progressTarget),
      claimed: !!row?.unlockedAt,
      claimedAt: row?.unlockedAt ?? null,
      claimable: d.status === "active" && !row?.unlockedAt && (row?.progress ?? 0) >= d.progressTarget,
      reward: d.status === "active" ? reward : { coins: 0, coupons: 0 },
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
  // Load all needed data in parallel
  const [user, stats, distinctCardCount, existingAchievements] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { level: true },
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
      },
    }),
    // Distinct cards of any set: the two collection achievements still active (Coleccionista
    // Novato, Coleccionista) say "de cualquier set". The Base Set ones (Colección 75% / Completa,
    // the hotfix's base-set-only count) are retired in favour of the per-set milestones.
    prisma.userCard.count({ where: { userId, quantity: { gt: 0 } } }),
    prisma.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true, progress: true, unlockedAt: true },
    }),
  ]);

  if (!user || !stats) return [];

  const totalWins = stats.normalWins + stats.rankedWins + stats.draftWins;
  const totalLosses = stats.normalLosses + stats.rankedLosses + stats.draftLosses;
  const totalGames = totalWins + totalLosses;

  // Build a map of existing achievement state
  const existingMap = new Map(existingAchievements.map((a) => [a.achievementId, a]));

  // Claimed achievements that count for "Leyenda Viviente"
  const claimedCount = existingAchievements.filter((a) => a.unlockedAt !== null && META_IDS.has(a.achievementId)).length;

  const newlyClaimable: ClaimableAchievement[] = [];

  for (const def of ACHIEVEMENT_DEFS) {
    // Retired achievements no longer progress; manual ones need in-game tracking (not built)
    if (def.status !== "active") continue;

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
        currentProgress = stats.bestStreak;
        break;
      case "collection":
        currentProgress = distinctCardCount;
        break;
      case "level":
        currentProgress = user.level;
        break;
      case "meta":
        currentProgress = claimedCount;
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

  return {
    achievementId: def.id,
    coins: reward.coins,
    coupons: reward.coupons,
  };
}
