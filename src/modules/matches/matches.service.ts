import { prisma } from "../../lib/prisma.js";
import { hasVerifiedEmail } from "../../lib/email-verification.js";
import { AppError, Errors } from "../../middleware/error-handler.js";
import { creditBalance, debitBalance, recordMatchResult, type Db } from "../users/users.service.js";
import {
  XP_REWARDS,
  grantExperience,
  lockUsers,
  type ExperienceGrant,
} from "../users/xp.service.js";
import { ECONOMY } from "../economy/config.js";
import { startOfEconomyDay } from "../economy/economy-time.js";
import { countedWinsAgainstToday, grantMatchCoins, type MatchCoinGrant } from "../economy/match-rewards.js";
import { recordMissionEvent, type MissionCompletion } from "../economy/missions.service.js";

// ---------------------------------------------------------------------------
// Matches: the one place where a finished game turns into stats, XP, coins and missions.
//
// Multiplayer (server-authoritative): a `matches` row is opened when the game starts (escrowing
// both players' table bet in the same transaction, when bets are enabled) and settled exactly
// once when it ends (`settledAt` is claimed with a conditional update, so a second end event is
// a no-op). Single player vs AI: the client reports the result (the engine runs in the
// browser), so it earns little, with a minimum duration and a daily game limit.
//
// Anti-farming (ECONOMY.antiFarming): a game only COUNTS — stats, ranking, achievements, XP,
// match coins and missions — if it reached turn 3 and lasted 2 minutes (AI: 3 minutes and the
// first 10 games of the day), and the winner has fewer than 3 counted wins against that
// opponent this economy day. A surrender in the mulligan/setup (turn 0) therefore counts for
// nobody. Friendly tables never count.
// ---------------------------------------------------------------------------

export type MultiplayerMode = "normal" | "friendly" | "draft";
/** The kind of game played (a table's / vs-AI game's rules): standard or Lucky Duel. */
export type GameModeMarker = "standard" | "lucky-duel";
/** The result a vs-AI game reports (player's view). */
export type AiResult = "victory" | "defeat" | "draw";
export type MatchMode = MultiplayerMode | "ai";

/** Highest bet any table can carry (legend tier). Lower tiers are capped by title, see users/titles.ts. */
export const MAX_BET = 1000;

/** A single-player game must last at least this long (server clock) to count. */
export const AI_MIN_DURATION_MS = ECONOMY.antiFarming.aiMinDurationMs;
/** Single-player games that count per user per economy day. */
export const AI_DAILY_REWARDED_GAMES = ECONOMY.antiFarming.aiDailyCountedGames;

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

/** The bet couldn't be escrowed because `userId` lacks the coins (nothing was charged). */
export class InsufficientStakeError extends AppError {
  constructor(public readonly userId: string, betAmount: number) {
    super(`No tienes suficientes monedas para la apuesta (${betAmount} monedas)`, 400, "BAD_REQUEST");
    this.name = "InsufficientStakeError";
  }
}

export function assertValidBet(betAmount: number) {
  if (!Number.isSafeInteger(betAmount) || betAmount < 0 || betAmount > MAX_BET) {
    throw Errors.BadRequest("Apuesta inválida");
  }
}

// ---------------------------------------------------------------------------
// Table bets (off by default: ECONOMY.tableBets.enabled)
// ---------------------------------------------------------------------------

/** Online games (normal + ranked + draft) that counted for the user's stats. */
export async function countedOnlineGames(db: Db, userId: string): Promise<number> {
  const s = await db.userStats.findUnique({ where: { userId } });
  if (!s) return 0;
  return s.normalWins + s.normalLosses + s.rankedWins + s.rankedLosses + s.draftWins + s.draftLosses;
}

/**
 * Why `userId` can't take part in a bet table (Spanish reason), or null. Only meaningful when
 * bets are enabled: ≥ minOnlineGames counted online games and a verified email.
 */
export async function betIneligibilityReason(userId: string, db: Db = prisma): Promise<string | null> {
  const cfg = ECONOMY.tableBets;
  if (!cfg.enabled) return "Las apuestas de mesa están desactivadas";
  const user = await db.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
  if (!user) return "Usuario no encontrado";
  if (cfg.requireVerifiedEmail && !user.emailVerified) return "Necesitas verificar tu email para apostar";
  if ((await countedOnlineGames(db, userId)) < cfg.minOnlineGames) {
    return `Necesitas ${cfg.minOnlineGames} partidas online para apostar`;
  }
  return null;
}

/** Bet tables already started today between the two players. */
async function betsTodayBetween(db: Db, a: string, b: string, now: Date): Promise<number> {
  return db.match.count({
    where: {
      betAmount: { gt: 0 },
      startedAt: { gte: startOfEconomyDay(now) },
      OR: [
        { player1Id: a, player2Id: b },
        { player1Id: b, player2Id: a },
      ],
    },
  });
}

/** The bet the table actually carries: 0 when bets are off or the pair isn't eligible today. */
async function effectiveBet(tx: Db, input: OpenMatchInput, now: Date): Promise<number> {
  if (input.mode === "friendly" || input.betAmount <= 0 || !ECONOMY.tableBets.enabled) return 0;
  for (const id of [input.player1Id, input.player2Id]) {
    if (await betIneligibilityReason(id, tx)) return 0;
  }
  if ((await betsTodayBetween(tx, input.player1Id, input.player2Id, now)) >= ECONOMY.tableBets.maxBetsPerDayPerOpponent) {
    return 0;
  }
  return input.betAmount;
}

// ---------------------------------------------------------------------------
// Multiplayer: open (escrow) and settle
// ---------------------------------------------------------------------------

export interface OpenMatchInput {
  player1Id: string;
  player2Id: string;
  mode: MultiplayerMode;
  betAmount: number;
  roomId: string;
}

/**
 * Open the match row of a multiplayer game that is about to start and, if the table carries a
 * bet (bets enabled and both players eligible), deduct it from both players in the same
 * transaction. Throws InsufficientStakeError (and charges nobody) when either player can't
 * cover it.
 */
export async function openMultiplayerMatch(input: OpenMatchInput, now = new Date()): Promise<{ id: string; betAmount: number }> {
  assertValidBet(input.betAmount);
  if (input.player1Id === input.player2Id) throw Errors.BadRequest("Un jugador no puede enfrentarse a sí mismo");

  return prisma.$transaction(async (tx) => {
    await lockUsers(tx, [input.player1Id, input.player2Id]);
    const betAmount = await effectiveBet(tx, input, now);
    const match = await tx.match.create({
      data: {
        mode: input.mode,
        status: "playing",
        roomId: input.roomId,
        player1Id: input.player1Id,
        player2Id: input.player2Id,
        betAmount,
        startedAt: now,
      },
      select: { id: true, betAmount: true },
    });

    if (betAmount > 0) {
      // Fixed order so two escrows over the same pair can't deadlock
      for (const userId of [input.player1Id, input.player2Id].sort()) {
        try {
          await debitBalance(userId, "coins", betAmount, "bet_stake", `Apuesta de mesa: ${betAmount} monedas en juego`, tx);
        } catch (err) {
          if (err instanceof AppError && err.statusCode === 400) throw new InsufficientStakeError(userId, betAmount);
          throw err;
        }
      }
    }
    return match;
  }, TX_OPTIONS);
}

export type SettleInput =
  /**
   * winnerId null = no result (cancelled / abandoned): bets are refunded, nothing counts.
   * `draw: true` (with winnerId null) = a game played to a draw (Lucky Duel: both Actives Knocked
   * Out at once): no winner and no loser. It counts like any game (anti-farming rules minus the
   * per-opponent win cap) but changes no win/loss stats or streaks (the stats model has no draws);
   * both players get the loser's participation rewards (XP, match coins, "game_played" mission).
   */
  | { kind: "multiplayer"; winnerId: string | null; draw?: boolean; reason: string; turnNumber: number }
  /** turnNumber: last turn reached, reported by the client (the AI game runs in the browser). */
  /**
   * `draw`: the game ended in a draw (Lucky Duel: both Actives Knocked Out at once): no winner,
   * the loser's rewards (same ruling as multiplayer). `mode` is only recorded on the match row
   * (winReason "lucky-duel: <result>").
   */
  | { kind: "ai"; victory: boolean; draw?: boolean; mode?: GameModeMarker; turnNumber: number };

export interface PlayerSettlement {
  userId: string;
  outcome: "win" | "loss" | "draw" | "none";
  /** The game passed the anti-farming rules (stats, XP, coins and missions were applied). */
  counted: boolean;
  /** Net coins the table bet moved for the player: +bet (won the pot), -bet (lost the stake) or 0. */
  coinsDelta: number;
  /** Match coins credited (online win 25 / loss 10, AI 10 / 5; daily cap). */
  rewardCoins: number;
  rewardCoinsCapped: boolean;
  xpGained: number;
  xpCapped: boolean;
  levelsGained: number;
  level: number;
  experience: number;
  coins: number;
  missionsCompleted: MissionCompletion[];
  /**
   * False for a local account without a verified email: a counted game still gives it stats and
   * XP, but no match coins and no mission progress (rewardCoins 0, missionsCompleted []).
   */
  emailVerified: boolean;
}

export interface SettlementResult {
  matchId: string;
  mode: MatchMode;
  betAmount: number;
  winnerId: string | null;
  counted: boolean;
  players: PlayerSettlement[];
}

/** A vs-AI match row's winReason: "victory" | "defeat" | "draw", prefixed "lucky-duel: " for that mode. */
function aiWinReason(input: { victory: boolean; draw?: boolean; mode?: GameModeMarker }): string {
  const result = input.victory ? "victory" : input.draw ? "draw" : "defeat";
  return input.mode === "lucky-duel" ? `lucky-duel: ${result}` : result;
}

/**
 * Settle a match exactly once: pay the pot to the winner (or refund both stakes when there is
 * no result or the game ended before turn 3), and — only for a counted game — record win/loss
 * stats (normal and draft), grant XP, match coins and mission progress. Returns null when the
 * match doesn't exist or was already settled, so callers can fire it from every end path.
 */
export async function settleMatch(matchId: string, input: SettleInput, now = new Date()): Promise<SettlementResult | null> {
  return prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: { id: true, mode: true, player1Id: true, player2Id: true, betAmount: true, startedAt: true, settledAt: true },
    });
    if (!match || match.settledAt) return null;
    const mode = match.mode as MatchMode;
    const isAi = mode === "ai";
    if ((input.kind === "ai") !== isAi) throw new Error(`settleMatch: ${input.kind} result for a ${mode} match`);

    const players = [match.player1Id, match.player2Id].filter((id): id is string => !!id);
    let winnerId: string | null;
    if (input.kind === "ai") winnerId = input.victory ? match.player1Id : null;
    else winnerId = input.winnerId && players.includes(input.winnerId) ? input.winnerId : null;
    // A draw is a played game without a winner (never together with a winner)
    const draw = input.kind === "multiplayer" ? input.draw === true && winnerId === null : input.draw === true && !input.victory;
    const decided = input.kind === "ai" || winnerId !== null || draw;

    // Lock the players' rows (id order) BEFORE anything else: the claim below writes winnerId, a
    // foreign key to users (a key-share lock on the winner's row), so locking afterwards takes
    // the users out of order and deadlocks with any other ordered locker of the same pair (the
    // drafted-cards credit at the end of a draft tournament, another settlement)
    await lockUsers(tx, players);

    // Claim the settlement: a concurrent call blocks on this row, then matches nothing
    const { count } = await tx.match.updateMany({
      where: { id: matchId, settledAt: null },
      data: {
        settledAt: now,
        finishedAt: now,
        status: decided ? "finished" : "abandoned",
        winnerId,
        winReason: input.kind === "ai" ? aiWinReason(input) : input.reason.slice(0, 200),
      },
    });
    if (count === 0) return null;

    const counted = decided && (await isCounted(tx, match, mode, input, winnerId, now));

    // Table bet: pot to the winner (only if the game reached the payout turn), else stakes back
    const bet = match.betAmount;
    const coinsDelta = new Map<string, number>(players.map((p) => [p, 0]));
    if (bet > 0) {
      const reachedPayoutTurn = input.kind === "multiplayer" && input.turnNumber >= ECONOMY.tableBets.minTurnForPayout;
      if (winnerId && reachedPayoutTurn) {
        await creditBalance(winnerId, "coins", bet * 2, "bet_win", `Apuesta ganada: ${bet * 2} monedas del pozo`, tx);
        for (const p of players) coinsDelta.set(p, p === winnerId ? bet : -bet);
      } else {
        const why = winnerId
          ? `la partida no llegó al turno ${ECONOMY.tableBets.minTurnForPayout}`
          : draw ? "empate" : "partida sin resultado";
        for (const p of players) {
          await creditBalance(p, "coins", bet, "bet_refund", `Apuesta devuelta: ${bet} monedas (${why})`, tx);
        }
      }
    }

    // Stats (multiplayer normal/draft, counted only). A draw changes no stats: there is no draw
    // column, and neither streak breaks nor grows
    if (counted && winnerId && (mode === "normal" || mode === "draft")) {
      for (const p of players) await recordMatchResult(p, mode, p === winnerId, tx);
    }

    // XP, match coins and missions (counted only; coins and missions need a verified email)
    const grants = new Map<string, ExperienceGrant>();
    const coinGrants = new Map<string, MatchCoinGrant>();
    const missions = new Map<string, MissionCompletion[]>();
    const verified = new Map<string, boolean>();
    for (const p of players) verified.set(p, (await hasVerifiedEmail(p, tx)) ?? false);
    for (const p of players) {
      // A draw pays both players what a loser gets (participation): XP, match coins, game_played
      const outcome = p === winnerId ? "win" : "loss";
      const grant = await grantExperience(tx, p, counted ? XP_REWARDS[mode][outcome] : 0, now);
      if (grant) grants.set(p, grant);
      if (!counted || !verified.get(p)) continue;
      coinGrants.set(p, await grantMatchCoins(tx, p, isAi ? "ai" : "online", outcome, matchId, now));
      const completed = await recordMissionEvent(tx, p, "game_played", now);
      if (outcome === "win") completed.push(...(await recordMissionEvent(tx, p, "game_won", now)));
      missions.set(p, completed);
    }
    const coinsOf = (id: string | null) => (id && coinGrants.get(id)?.amount) || 0;
    await tx.match.update({
      where: { id: matchId },
      data: {
        counted,
        player1Xp: (match.player1Id && grants.get(match.player1Id)?.gained) || 0,
        player2Xp: (match.player2Id && grants.get(match.player2Id)?.gained) || 0,
        player1Coins: coinsOf(match.player1Id),
        player2Coins: coinsOf(match.player2Id),
      },
    });

    const balances = await tx.user.findMany({ where: { id: { in: players } }, select: { id: true, coins: true } });
    return {
      matchId,
      mode,
      betAmount: bet,
      winnerId,
      counted,
      players: players.map((p): PlayerSettlement => {
        const grant = grants.get(p);
        return {
          userId: p,
          outcome: !decided ? "none" : draw ? "draw" : p === winnerId ? "win" : "loss",
          counted,
          coinsDelta: coinsDelta.get(p) ?? 0,
          rewardCoins: coinGrants.get(p)?.amount ?? 0,
          rewardCoinsCapped: coinGrants.get(p)?.capped ?? false,
          xpGained: grant?.gained ?? 0,
          xpCapped: grant?.capped ?? false,
          levelsGained: grant?.levelsGained ?? 0,
          level: grant?.level ?? 1,
          experience: grant?.experience ?? 0,
          coins: balances.find((b) => b.id === p)?.coins ?? 0,
          missionsCompleted: missions.get(p) ?? [],
          emailVerified: verified.get(p) ?? false,
        };
      }),
    };
  }, TX_OPTIONS);
}

/** The anti-farming rules (see the header). Needs the players' row locks. */
async function isCounted(
  tx: Db,
  match: { id: string; player1Id: string | null; player2Id: string | null; startedAt: Date | null },
  mode: MatchMode,
  input: SettleInput,
  winnerId: string | null,
  now: Date,
): Promise<boolean> {
  const rules = ECONOMY.antiFarming;
  if (mode === "friendly" || !match.startedAt || input.turnNumber < rules.minTurn) return false;
  const elapsed = now.getTime() - match.startedAt.getTime();

  if (input.kind === "ai") {
    if (!match.player1Id || elapsed < rules.aiMinDurationMs) return false;
    const countedToday = await tx.match.count({
      where: {
        id: { not: match.id },
        player1Id: match.player1Id,
        mode: "ai",
        counted: true,
        settledAt: { gte: startOfEconomyDay(now) },
      },
    });
    return countedToday < rules.aiDailyCountedGames;
  }

  if (elapsed < rules.minDurationMs || !match.player1Id || !match.player2Id) return false;
  // A draw has no winner to cap (the per-opponent cap counts wins); no result counts for nobody
  if (!winnerId) return input.draw === true;
  const loserId = winnerId === match.player1Id ? match.player2Id : match.player1Id;
  return (await countedWinsAgainstToday(tx, winnerId, loserId, match.id, now)) < rules.maxCountedWinsPerOpponentPerDay;
}

/**
 * Refund every multiplayer match that was never settled (the in-memory game was lost, e.g. the
 * process restarted). Call once at startup, before any game can start.
 */
export async function refundUnsettledMatches(reason = "Partida interrumpida por un reinicio del servidor"): Promise<number> {
  const open = await prisma.match.findMany({
    where: { settledAt: null, mode: { not: "ai" } },
    select: { id: true },
  });
  let settled = 0;
  for (const { id } of open) {
    const result = await settleMatch(id, { kind: "multiplayer", winnerId: null, reason, turnNumber: 0 });
    if (result) settled++;
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Single player vs AI (client-reported)
// ---------------------------------------------------------------------------

/** Start a single-player game; drops the user's previous unfinished one (one at a time). */
export async function startAiMatch(userId: string, now = new Date()): Promise<{ matchId: string }> {
  return prisma.$transaction(async (tx) => {
    await tx.match.deleteMany({ where: { player1Id: userId, mode: "ai", settledAt: null } });
    const match = await tx.match.create({
      data: { mode: "ai", status: "playing", player1Id: userId, startedAt: now },
      select: { id: true },
    });
    return { matchId: match.id };
  });
}

/**
 * Report the end of a single-player game started with startAiMatch. `result`: "victory" | "defeat" | "draw" (a boolean is read as victory / defeat). A draw
 * (Lucky Duel) has no winner: the loser's XP / match coins / game_played, no streak change.
 * `mode` (optional) is recorded on the match row.
 */
export async function finishAiMatch(
  userId: string,
  matchId: string,
  result: AiResult | boolean,
  turnNumber: number,
  now = new Date(),
  mode?: GameModeMarker,
) {
  const outcome: AiResult = typeof result === "boolean" ? (result ? "victory" : "defeat") : result;
  const match = await prisma.match.findFirst({
    where: { id: matchId, player1Id: userId, mode: "ai" },
    select: { settledAt: true },
  });
  if (!match) throw Errors.NotFound("Partida");
  if (match.settledAt) throw Errors.Conflict("Esta partida ya fue registrada");

  const settled = await settleMatch(
    matchId,
    { kind: "ai", victory: outcome === "victory", draw: outcome === "draw", ...(mode ? { mode } : {}), turnNumber },
    now,
  );
  if (!settled) throw Errors.Conflict("Esta partida ya fue registrada");
  const me = settled.players[0];
  return {
    matchId,
    outcome: me.outcome,
    counted: me.counted,
    xpGained: me.xpGained,
    xpCapped: me.xpCapped,
    levelsGained: me.levelsGained,
    level: me.level,
    experience: me.experience,
    rewardCoins: me.rewardCoins,
    rewardCoinsCapped: me.rewardCoinsCapped,
    coins: me.coins,
    missionsCompleted: me.missionsCompleted,
    emailVerified: me.emailVerified,
  };
}
