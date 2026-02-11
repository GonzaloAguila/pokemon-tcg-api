import { prisma } from "../../lib/prisma.js";
import * as usersService from "../users/users.service.js";

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
// Achievement definitions (server-side)
// ---------------------------------------------------------------------------

type CheckerType = "stats-wins" | "stats-games" | "stats-streak" | "collection" | "coins" | "level" | "meta" | "manual";

interface AchievementDef {
  id: string;
  name: string;
  tier: string;
  progressTarget: number;
  checker: CheckerType;
}

const ACHIEVEMENT_DEFS: AchievementDef[] = [
  // Bronze (15)
  { id: "bronze-1",  name: "Primera Victoria",    tier: "bronze", progressTarget: 1,    checker: "stats-wins" },
  { id: "bronze-2",  name: "Coleccionista Novato", tier: "bronze", progressTarget: 1,    checker: "collection" },
  { id: "bronze-3",  name: "Evolucionador",        tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-4",  name: "Energía Vital",        tier: "bronze", progressTarget: 10,   checker: "manual" },
  { id: "bronze-5",  name: "Primer Sobre",         tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-6",  name: "Entrenador Dedicado",  tier: "bronze", progressTarget: 10,   checker: "stats-games" },
  { id: "bronze-7",  name: "Knock Out",            tier: "bronze", progressTarget: 10,   checker: "manual" },
  { id: "bronze-8",  name: "Mano Llena",           tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-9",  name: "Sin Piedad",           tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-10", name: "Velocista",            tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-11", name: "Deck Completo",        tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-12", name: "Tipo Agua",            tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-13", name: "Tipo Fuego",           tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-14", name: "Tipo Planta",          tier: "bronze", progressTarget: 1,    checker: "manual" },
  { id: "bronze-15", name: "Tipo Eléctrico",       tier: "bronze", progressTarget: 1,    checker: "manual" },

  // Silver (12)
  { id: "silver-16", name: "Racha de 5",           tier: "silver", progressTarget: 5,    checker: "stats-streak" },
  { id: "silver-17", name: "Semana Activa",         tier: "silver", progressTarget: 7,    checker: "manual" },
  { id: "silver-18", name: "Intocable",             tier: "silver", progressTarget: 1,    checker: "manual" },
  { id: "silver-19", name: "Coleccionista",         tier: "silver", progressTarget: 25,   checker: "collection" },
  { id: "silver-20", name: "Multi-deck",            tier: "silver", progressTarget: 3,    checker: "manual" },
  { id: "silver-21", name: "Estratega",             tier: "silver", progressTarget: 1,    checker: "manual" },
  { id: "silver-22", name: "Comeback",              tier: "silver", progressTarget: 1,    checker: "manual" },
  { id: "silver-23", name: "Súper Evolución",       tier: "silver", progressTarget: 1,    checker: "manual" },
  { id: "silver-24", name: "Crítico",               tier: "silver", progressTarget: 1,    checker: "manual" },
  { id: "silver-25", name: "Resistencia",           tier: "silver", progressTarget: 1,    checker: "manual" },
  { id: "silver-26", name: "50 Victorias",          tier: "silver", progressTarget: 50,   checker: "stats-wins" },
  { id: "silver-27", name: "Entrenador Experto",    tier: "silver", progressTarget: 15,   checker: "level" },

  // Gold (10)
  { id: "gold-28",   name: "Racha de 10",          tier: "gold", progressTarget: 10,    checker: "stats-streak" },
  { id: "gold-29",   name: "Centenario",           tier: "gold", progressTarget: 100,   checker: "stats-wins" },
  { id: "gold-30",   name: "Colección 75%",        tier: "gold", progressTarget: 77,    checker: "collection" },
  { id: "gold-31",   name: "Mes Dedicado",         tier: "gold", progressTarget: 30,    checker: "manual" },
  { id: "gold-32",   name: "Perfeccionista",       tier: "gold", progressTarget: 10,    checker: "manual" },
  { id: "gold-33",   name: "Domador",              tier: "gold", progressTarget: 7,     checker: "manual" },
  { id: "gold-34",   name: "Veterano",             tier: "gold", progressTarget: 200,   checker: "stats-games" },
  { id: "gold-35",   name: "Rica Colección",       tier: "gold", progressTarget: 5000,  checker: "coins" },
  { id: "gold-36",   name: "Todos los Decks",      tier: "gold", progressTarget: 6,     checker: "manual" },
  { id: "gold-37",   name: "Maestro Trainer",      tier: "gold", progressTarget: 30,    checker: "level" },

  // Platinum (8)
  { id: "platinum-38", name: "Racha de 20",        tier: "platinum", progressTarget: 20,    checker: "stats-streak" },
  { id: "platinum-39", name: "Quinientos",          tier: "platinum", progressTarget: 500,   checker: "stats-wins" },
  { id: "platinum-40", name: "Holo Completo",       tier: "platinum", progressTarget: 16,    checker: "manual" },
  { id: "platinum-41", name: "Año Activo",          tier: "platinum", progressTarget: 100,   checker: "manual" },
  { id: "platinum-42", name: "Élite",               tier: "platinum", progressTarget: 1,     checker: "manual" },
  { id: "platinum-43", name: "Millonario",          tier: "platinum", progressTarget: 25000, checker: "coins" },
  { id: "platinum-44", name: "Sin Derrotas",        tier: "platinum", progressTarget: 50,    checker: "manual" },
  { id: "platinum-45", name: "Campeón",             tier: "platinum", progressTarget: 3,     checker: "manual" },

  // Legend (5)
  { id: "legend-46", name: "Racha Legendaria",     tier: "legend", progressTarget: 50,   checker: "stats-streak" },
  { id: "legend-47", name: "Mil Victorias",        tier: "legend", progressTarget: 1000, checker: "stats-wins" },
  { id: "legend-48", name: "Colección Completa",   tier: "legend", progressTarget: 102,  checker: "collection" },
  { id: "legend-49", name: "Invencible",           tier: "legend", progressTarget: 100,  checker: "manual" },
  { id: "legend-50", name: "Leyenda Viviente",     tier: "legend", progressTarget: 49,   checker: "meta" },
];

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface UnlockedAchievement {
  achievementId: string;
  name: string;
  tier: string;
  coins: number;
  coupons: number;
}

// ---------------------------------------------------------------------------
// Check and update all achievement progress for a user
// ---------------------------------------------------------------------------

export async function checkAndUpdateProgress(userId: string): Promise<UnlockedAchievement[]> {
  // Load all needed data in parallel
  const [user, stats, distinctCardCount, existingAchievements] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true, level: true },
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
    prisma.userCard.count({ where: { userId } }),
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

  // Count already-unlocked achievements (for "meta" checker)
  const unlockedCount = existingAchievements.filter((a) => a.unlockedAt !== null).length;

  const newlyUnlocked: UnlockedAchievement[] = [];

  for (const def of ACHIEVEMENT_DEFS) {
    // Skip manual achievements — they need in-game event tracking
    if (def.checker === "manual") continue;

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
      case "coins":
        currentProgress = user.coins;
        break;
      case "level":
        currentProgress = user.level;
        break;
      case "meta":
        // Count unlocked achievements (excluding this one itself) + any we're unlocking in this run
        currentProgress = unlockedCount + newlyUnlocked.length;
        break;
    }

    // Cap progress to target
    const progress = Math.min(currentProgress, def.progressTarget);
    const isComplete = currentProgress >= def.progressTarget;

    const existing = existingMap.get(def.id);

    if (!existing) {
      // No record exists — create one
      await prisma.userAchievement.create({
        data: {
          userId,
          achievementId: def.id,
          progress,
          unlockedAt: isComplete ? new Date() : null,
        },
      });

      if (isComplete) {
        const reward = await grantReward(userId, def);
        newlyUnlocked.push(reward);
      }
    } else if (existing.unlockedAt === null) {
      // Record exists but not yet unlocked — update progress
      if (isComplete) {
        // Unlock it!
        await prisma.userAchievement.update({
          where: { userId_achievementId: { userId, achievementId: def.id } },
          data: { progress, unlockedAt: new Date() },
        });
        const reward = await grantReward(userId, def);
        newlyUnlocked.push(reward);
      } else if (progress !== existing.progress) {
        // Just update progress
        await prisma.userAchievement.update({
          where: { userId_achievementId: { userId, achievementId: def.id } },
          data: { progress },
        });
      }
    }
    // If already unlocked, skip entirely
  }

  return newlyUnlocked;
}

// ---------------------------------------------------------------------------
// Grant reward for an achievement
// ---------------------------------------------------------------------------

async function grantReward(userId: string, def: AchievementDef): Promise<UnlockedAchievement> {
  const reward = TIER_REWARDS[def.tier] ?? { coins: 0, coupons: 0 };

  if (reward.coins > 0) {
    await usersService.addCoins(userId, reward.coins, "achievement", `Logro: ${def.name}`);
  }
  if (reward.coupons > 0) {
    await usersService.addCoupons(userId, reward.coupons, "achievement", `Logro: ${def.name}`);
  }

  return {
    achievementId: def.id,
    name: def.name,
    tier: def.tier,
    coins: reward.coins,
    coupons: reward.coupons,
  };
}
