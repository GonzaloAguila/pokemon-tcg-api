/**
 * Trainer title ids, computed server-side so clients can't claim a title
 * (e.g. "superadmin") they don't have. Mirrors getTrainerTitle() in the
 * frontend's src/domain/profile/titles.ts — keep the thresholds in sync.
 */

export function computeTrainerTitleId(
  totalGames: number,
  winRate: number,
  bestStreak: number,
  role?: string,
): string {
  if (role === "superadmin") return "superadmin";
  if (role === "admin") return "admin";

  if (totalGames >= 1000 && winRate >= 75 && bestStreak >= 20) return "maestro-pokemon";
  if (totalGames >= 500 && winRate >= 70 && bestStreak >= 15) return "alto-mando";

  //                     <35%            35-50%          50-60%            60-70%              70%+
  if (totalGames < 20) return "novato";
  if (totalGames < 50) {
    if (winRate < 35) return "cazabichos";
    if (winRate < 60) return "joven";
    return "excursionista";
  }
  if (totalGames < 100) {
    if (winRate < 35) return "pescador";
    if (winRate < 60) return "pokefan";
    return "cinturon-negro";
  }
  if (totalGames < 200) {
    if (winRate < 35) return "cazabichos";
    if (winRate < 50) return "pokefan";
    if (winRate < 60) return "pokemon-ranger";
    return "domadragones";
  }
  if (totalGames < 500) {
    if (winRate < 35) return "pescador";
    if (winRate < 50) return "pokemania";
    if (winRate < 60) return "cinturon-negro";
    if (winRate < 70) return "estrella-naciente";
    return "as-entrenador";
  }
  if (totalGames < 1000) {
    if (winRate < 35) return "pokemania";
    if (winRate < 50) return "pokemon-ranger";
    if (winRate < 60) return "as-entrenador";
    return "veterano";
  }
  if (winRate < 35) return "pokemania";
  if (winRate < 50) return "as-entrenador";
  if (winRate < 60) return "veterano";
  if (winRate < 70) return "lider-de-gimnasio";
  return "campeon";
}

export interface StatsForTitle {
  normalWins: number;
  normalLosses: number;
  rankedWins: number;
  rankedLosses: number;
  draftWins: number;
  draftLosses: number;
  bestStreak: number;
}

export function titleIdFromStats(stats: StatsForTitle | null | undefined, role?: string): string {
  const wins = (stats?.normalWins ?? 0) + (stats?.rankedWins ?? 0) + (stats?.draftWins ?? 0);
  const losses = (stats?.normalLosses ?? 0) + (stats?.rankedLosses ?? 0) + (stats?.draftLosses ?? 0);
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  return computeTrainerTitleId(total, winRate, stats?.bestStreak ?? 0, role);
}
