import { prisma } from "../../lib/prisma.js";
import { AppError, Errors } from "../../middleware/error-handler.js";
import { creditBalance, debitBalance, recordMatchResult, type Db } from "../users/users.service.js";
import {
  MIN_TURN_FOR_XP,
  XP_REWARDS,
  grantExperience,
  lockUsers,
  startOfTodayUtc,
  type ExperienceGrant,
} from "../users/xp.service.js";

// ---------------------------------------------------------------------------
// Matches: the one place where a finished game turns into stats, XP and coins.
//
// Multiplayer (server-authoritative): a `matches` row is opened when the game
// starts (escrowing both players' table bet in the same transaction) and
// settled exactly once when it ends (`settledAt` is claimed with a conditional
// update, so a second end event is a no-op). Single player vs AI: the client
// reports the result (the engine runs in the browser), so it only earns a
// small amount of XP, with a minimum duration and a daily game limit.
// ---------------------------------------------------------------------------

export type MultiplayerMode = "normal" | "friendly" | "draft";
export type MatchMode = MultiplayerMode | "ai";

/** Highest bet any table can carry (legend tier). Lower tiers are capped by title, see users/titles.ts. */
export const MAX_BET = 1000;

/** A single-player game must last at least this long (server clock) to earn XP. */
export const AI_MIN_DURATION_MS = 3 * 60_000;
/** Single-player games that earn XP per user per UTC day. */
export const AI_DAILY_REWARDED_GAMES = 10;

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
 * Open the match row of a multiplayer game that is about to start and, if the table has a bet,
 * deduct it from both players in the same transaction. Throws InsufficientStakeError (and
 * charges nobody) when either player can't cover it.
 */
export async function openMultiplayerMatch(input: OpenMatchInput): Promise<{ id: string }> {
  assertValidBet(input.betAmount);
  if (input.player1Id === input.player2Id) throw Errors.BadRequest("Un jugador no puede enfrentarse a sí mismo");
  const betAmount = input.mode === "friendly" ? 0 : input.betAmount;

  return prisma.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        mode: input.mode,
        status: "playing",
        roomId: input.roomId,
        player1Id: input.player1Id,
        player2Id: input.player2Id,
        betAmount,
        startedAt: new Date(),
      },
      select: { id: true },
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
  });
}

export type SettleInput =
  /** winnerId null = no result (cancelled / abandoned / draw): bets are refunded, no stats or XP. */
  | { kind: "multiplayer"; winnerId: string | null; reason: string; turnNumber: number }
  | { kind: "ai"; victory: boolean };

export interface PlayerSettlement {
  userId: string;
  outcome: "win" | "loss" | "none";
  /** Net coins this match moved for the player: +bet (won the pot), -bet (lost the stake) or 0. */
  coinsDelta: number;
  xpGained: number;
  xpCapped: boolean;
  levelsGained: number;
  level: number;
  experience: number;
  coins: number;
}

export interface SettlementResult {
  matchId: string;
  mode: MatchMode;
  betAmount: number;
  winnerId: string | null;
  players: PlayerSettlement[];
}

/**
 * Settle a match exactly once: pay the pot to the winner (or refund both stakes when there is
 * no result), record win/loss stats (normal and draft), grant XP. Returns null when the match
 * doesn't exist or was already settled, so callers can fire it from every end path.
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
    const decided = input.kind === "ai" || winnerId !== null;

    // Claim the settlement: a concurrent call blocks on this row, then matches nothing
    const { count } = await tx.match.updateMany({
      where: { id: matchId, settledAt: null },
      data: {
        settledAt: now,
        finishedAt: now,
        status: decided ? "finished" : "abandoned",
        winnerId,
        winReason: input.kind === "ai" ? (input.victory ? "victory" : "defeat") : input.reason.slice(0, 200),
      },
    });
    if (count === 0) return null;

    await lockUsers(tx, players);

    // Coins: pot to the winner, or each stake back
    const bet = match.betAmount;
    const coinsDelta = new Map<string, number>(players.map((p) => [p, 0]));
    if (bet > 0) {
      if (winnerId) {
        await creditBalance(winnerId, "coins", bet * 2, "bet_win", `Apuesta ganada: ${bet * 2} monedas del pozo`, tx);
        for (const p of players) coinsDelta.set(p, p === winnerId ? bet : -bet);
      } else {
        for (const p of players) {
          await creditBalance(p, "coins", bet, "bet_refund", `Apuesta devuelta: ${bet} monedas (partida sin resultado)`, tx);
        }
      }
    }

    // Stats (multiplayer, decided, not friendly)
    if (winnerId && (mode === "normal" || mode === "draft")) {
      for (const p of players) await recordMatchResult(p, mode, p === winnerId, tx);
    }

    // XP
    const eligible = decided && (await isEligibleForXp(tx, match, input, now));
    const grants = new Map<string, ExperienceGrant>();
    for (const p of players) {
      const outcome = p === winnerId ? "win" : "loss";
      const amount = eligible ? XP_REWARDS[mode][outcome] : 0;
      const grant = await grantExperience(tx, p, amount, now);
      if (grant) grants.set(p, grant);
    }
    await tx.match.update({
      where: { id: matchId },
      data: {
        player1Xp: (match.player1Id && grants.get(match.player1Id)?.gained) || 0,
        player2Xp: (match.player2Id && grants.get(match.player2Id)?.gained) || 0,
      },
    });

    const balances = await tx.user.findMany({ where: { id: { in: players } }, select: { id: true, coins: true } });
    return {
      matchId,
      mode,
      betAmount: bet,
      winnerId,
      players: players.map((p): PlayerSettlement => {
        const grant = grants.get(p);
        return {
          userId: p,
          outcome: !decided ? "none" : p === winnerId ? "win" : "loss",
          coinsDelta: coinsDelta.get(p) ?? 0,
          xpGained: grant?.gained ?? 0,
          xpCapped: grant?.capped ?? false,
          levelsGained: grant?.levelsGained ?? 0,
          level: grant?.level ?? 1,
          experience: grant?.experience ?? 0,
          coins: balances.find((b) => b.id === p)?.coins ?? 0,
        };
      }),
    };
  });
}

async function isEligibleForXp(
  tx: Db,
  match: { id: string; player1Id: string | null; startedAt: Date | null },
  input: SettleInput,
  now: Date,
): Promise<boolean> {
  if (input.kind === "multiplayer") return input.turnNumber >= MIN_TURN_FOR_XP;
  if (!match.player1Id || !match.startedAt) return false;
  if (now.getTime() - match.startedAt.getTime() < AI_MIN_DURATION_MS) return false;
  const rewardedToday = await tx.match.count({
    where: {
      id: { not: match.id },
      player1Id: match.player1Id,
      mode: "ai",
      settledAt: { gte: startOfTodayUtc(now) },
      player1Xp: { gt: 0 },
    },
  });
  return rewardedToday < AI_DAILY_REWARDED_GAMES;
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

/** Report the end of a single-player game started with startAiMatch. */
export async function finishAiMatch(userId: string, matchId: string, victory: boolean, now = new Date()) {
  const match = await prisma.match.findFirst({
    where: { id: matchId, player1Id: userId, mode: "ai" },
    select: { settledAt: true },
  });
  if (!match) throw Errors.NotFound("Partida");
  if (match.settledAt) throw Errors.Conflict("Esta partida ya fue registrada");

  const result = await settleMatch(matchId, { kind: "ai", victory }, now);
  if (!result) throw Errors.Conflict("Esta partida ya fue registrada");
  const me = result.players[0];
  return {
    matchId,
    xpGained: me.xpGained,
    xpCapped: me.xpCapped,
    levelsGained: me.levelsGained,
    level: me.level,
    experience: me.experience,
  };
}
