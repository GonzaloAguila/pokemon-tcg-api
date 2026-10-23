import { prisma } from "../../lib/prisma.js";

/** The game's result for the player whose history it is ("interrupted": no result, stakes refunded). */
export type HistoryResult = "victory" | "defeat" | "draw" | "abandoned" | "interrupted";

/**
 * How the game ended, read from the row's winReason: "game" (played to the end: Prizes, no
 * Pokémon, deck out), "surrender", "disconnect" (left or dropped), "timeout" (a turn or answer
 * clock), "setup-timeout" (didn't finish the setup in time), "no-show" (never came to the table).
 * Who did it follows from the result (a won "surrender" = the rival surrendered).
 */
export type HistoryEnd = "game" | "surrender" | "disconnect" | "timeout" | "setup-timeout" | "no-show";

export type HistoryOpponent =
  | { kind: "player"; username: string | null }
  | { kind: "ai" }
  | { kind: "gym"; leaderName: string; mode: string; game: number; bestOf: number; score: unknown };

/** One settled game of GET /matches/history, from the player's side. */
export interface HistoryEntry {
  id: string;
  playedAt: string;
  /** Match.mode: "normal" | "friendly" | "draft" | "ai" | "gym". */
  mode: string;
  /** "standard" | "lucky-duel". */
  gameMode: string;
  result: HistoryResult;
  end: HistoryEnd;
  opponent: HistoryOpponent;
  betAmount: number;
  xp: number;
  coins: number;
  /** Counted for stats, ranking and achievements (online games past the anti-farming rules). */
  counted: boolean;
}

const seat = { select: { id: true, username: true } } as const;

export const HISTORY_SELECT = {
  id: true,
  status: true,
  mode: true,
  gameMode: true,
  player1Id: true,
  player2Id: true,
  winnerId: true,
  winReason: true,
  betAmount: true,
  player1Xp: true,
  player2Xp: true,
  player1Coins: true,
  player2Coins: true,
  counted: true,
  gym: true,
  createdAt: true,
  settledAt: true,
  player1: seat,
  player2: seat,
} as const;

interface HistoryRow {
  id: string;
  status: string;
  mode: string;
  gameMode: string;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  winReason: string | null;
  betAmount: number;
  player1Xp: number;
  player2Xp: number;
  player1Coins: number;
  player2Coins: number;
  counted: boolean;
  gym: unknown;
  createdAt: Date;
  settledAt: Date | null;
  player1: { id: string; username: string } | null;
  player2: { id: string; username: string } | null;
}

/** The end of an online or gym game from its winReason (texts of socket/handlers.ts, rooms.ts and gym/history.ts). */
function endOf(reason: string): HistoryEnd {
  const text = reason.toLowerCase();
  if (text.startsWith("no-show") || text.includes("no se presentó")) return "no-show";
  if (text.includes("se ha rendido")) return "surrender";
  if (text.includes("preparación a tiempo")) return "setup-timeout";
  // "Oponente desconectado (tiempo de espera agotado)" is a disconnect, not a clock
  if (text.includes("desconect") || text.includes("abandon")) return "disconnect";
  if (text.includes("tiempo")) return "timeout";
  return "game";
}

/** Rows that end without a result: nothing was decided and the stakes went back. */
function isInterrupted(reason: string): boolean {
  const text = reason.toLowerCase();
  return (
    text.includes("reinicio del servidor") ||
    text.includes("no pudo comenzar") ||
    text.includes("ningún jugador se presentó") ||
    text.includes("admin") ||
    text.includes("error")
  );
}

/** A settled match row as one entry of `userId`'s history. */
export function toHistoryEntry(row: HistoryRow, userId: string): HistoryEntry {
  const isPlayer1 = row.player1Id === userId;
  const reason = row.winReason ?? "";
  const base = {
    id: row.id,
    playedAt: (row.settledAt ?? row.createdAt).toISOString(),
    mode: row.mode,
    gameMode: row.gameMode,
    betAmount: row.betAmount,
    xp: isPlayer1 ? row.player1Xp : row.player2Xp,
    coins: isPlayer1 ? row.player1Coins : row.player2Coins,
    counted: row.counted,
  };

  // vs the AI (client-reported): winReason is "victory" | "defeat" | "draw" | "abandoned", with a
  // "lucky-duel: " prefix and " (quick victory)" (a too-quick win, settled as a draw)
  if (row.mode === "ai") {
    const outcome = reason.replace(/^lucky-duel: /, "").replace(/ \(quick victory\)$/, "");
    const result: HistoryResult =
      outcome === "victory" ? "victory" : outcome === "draw" ? "draw" : outcome === "abandoned" ? "abandoned" : "defeat";
    return { ...base, result, end: "game", opponent: { kind: "ai" } };
  }

  // A Gym Leader game: player 1 is the challenger, the leader is in `gym`
  if (row.mode === "gym") {
    const gym = (row.gym ?? {}) as { leaderName?: string; mode?: string; game?: number; bestOf?: number; score?: unknown };
    const opponent: HistoryOpponent = {
      kind: "gym",
      leaderName: gym.leaderName ?? "Líder de Gimnasio",
      mode: gym.mode ?? "normal",
      game: gym.game ?? 1,
      bestOf: gym.bestOf ?? 3,
      score: gym.score ?? null,
    };
    const result: HistoryResult =
      row.winnerId === userId
        ? "victory"
        : reason === "Empate"
          ? "draw"
          : row.status === "abandoned" && isInterrupted(reason)
            ? "interrupted"
            : "defeat";
    return { ...base, result, end: result === "interrupted" ? "game" : endOf(reason), opponent };
  }

  const rival = isPlayer1 ? row.player2 : row.player1;
  const opponent: HistoryOpponent = { kind: "player", username: rival?.username ?? null };
  let result: HistoryResult;
  if (row.winnerId === userId) result = "victory";
  else if (row.winnerId) result = "defeat";
  else if (row.status === "finished") result = "draw";
  else result = "interrupted";
  return { ...base, result, end: result === "interrupted" || result === "draw" ? "game" : endOf(reason), opponent };
}

/** The player's settled games (online, vs AI and gym), newest first. */
export async function listUserMatches(userId: string, page: number, limit: number) {
  const where = { settledAt: { not: null }, OR: [{ player1Id: userId }, { player2Id: userId }] };
  const [rows, total] = await Promise.all([
    prisma.match.findMany({
      where,
      orderBy: { settledAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: HISTORY_SELECT,
    }),
    prisma.match.count({ where }),
  ]);
  return { data: rows.map((row) => toHistoryEntry(row, userId)), total, page, limit };
}
