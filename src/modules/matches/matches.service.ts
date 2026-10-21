import { LUCKY_DUEL_BASICS } from "@gonzaloaguila/game-core";
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
import {
  PAIR_CAP_NOTE,
  coinsWonFromOpponentToday,
  countedWinsAgainstToday,
  grantMatchCoins,
  type MatchCoinGrant,
} from "../economy/match-rewards.js";
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
// opponent this economy day. Friendly tables never count. A game the loser forfeits before the
// threshold (surrender, leave, disconnect, kick, no-show: `forfeit: true`) is an "early forfeit"
// (ECONOMY.antiFarming.forfeit): it counts for the winner only against an established forfeiter
// (verified email, 10 counted online games), at most 3 such wins per winner per economy day; the
// forfeiter's loss is always recorded in the stats, without coins or XP.
//
// Per-opponent coin cap (ECONOMY.antiFarming.maxCoinsFromOpponentPerDay): a player wins at most
// 200 coins per economy day from the same opponent (match coins of wins + net bet winnings,
// `player1PairCoins` / `player2PairCoins`); past it the pot and the match coins are cut.
//
// Lucky Duel (`matches.gameMode`): vs the AI the stake (ECONOMY.luckyDuelAi) is escrowed at the
// start and settled with the result whatever the anti-farming rules say (a Lucky Duel can end on
// turn 1), except that a victory reported too soon is settled as a draw; an unfinished one is
// settled as an abandoned defeat when the player starts another vs-AI game. Every decided Lucky
// Duel (vs AI and multiplayer, counted or not, friendly tables excluded) updates the Lucky Duel
// streaks in UserStats and records each side's drawn Basic, who started and the last turn
// (Lucky Duel achievements).
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
// Table bets: standard tables behind ECONOMY.tableBets.enabled (off), Lucky Duel tables behind
// ECONOMY.tableBets.luckyDuel (on, 0–maxBet coins whatever the title, pot paid on any turn)
// ---------------------------------------------------------------------------

/** Whether a table of this kind can carry a bet. */
export function tableBetsEnabledFor(gameMode: GameModeMarker = "standard"): boolean {
  return gameMode === "lucky-duel" ? ECONOMY.tableBets.luckyDuel.enabled : ECONOMY.tableBets.enabled;
}

/**
 * The highest bet a creator can put on a table of this kind: Lucky Duel's flat cap
 * (ECONOMY.tableBets.luckyDuel.maxBet), else the creator's title cap (users/titles.ts).
 */
export function maxTableBet(gameMode: GameModeMarker, titleCap: number): number {
  return gameMode === "lucky-duel" ? Math.min(ECONOMY.tableBets.luckyDuel.maxBet, MAX_BET) : titleCap;
}

/**
 * Online games (normal + ranked + draft) that counted for the user's stats. Losses by an early
 * forfeit (`matches.earlyForfeit`, see ECONOMY.antiFarming.forfeit) are in the stats but are left
 * out here: forfeiting games at turn 0 must not make an account eligible for bets, trades or
 * paid forfeit wins.
 */
export async function countedOnlineGames(db: Db, userId: string): Promise<number> {
  const s = await db.userStats.findUnique({ where: { userId } });
  if (!s) return 0;
  const total = s.normalWins + s.normalLosses + s.rankedWins + s.rankedLosses + s.draftWins + s.draftLosses;
  const forfeitLosses = await db.match.count({
    where: {
      earlyForfeit: true,
      winnerId: { not: userId },
      OR: [{ player1Id: userId }, { player2Id: userId }],
    },
  });
  return Math.max(0, total - forfeitLosses);
}

/**
 * Whether `userId` is an established account whose early forfeit pays the winner
 * (ECONOMY.antiFarming.forfeit): verified email (OAuth counts) and enough counted online games.
 */
async function isEstablishedAccount(db: Db, userId: string): Promise<boolean> {
  if (!(await hasVerifiedEmail(userId, db))) return false;
  return (await countedOnlineGames(db, userId)) >= ECONOMY.antiFarming.forfeit.establishedMinOnlineGames;
}

/** Early-forfeit wins of `winnerId` that counted this economy day (other matches, all opponents). */
async function paidForfeitWinsToday(db: Db, winnerId: string, excludeMatchId: string, now: Date): Promise<number> {
  return db.match.count({
    where: {
      id: { not: excludeMatchId },
      winnerId,
      earlyForfeit: true,
      counted: true,
      settledAt: { gte: startOfEconomyDay(now) },
    },
  });
}

/**
 * Why `userId` can't take part in a bet table of this kind (Spanish reason), or null: bets on for
 * that kind of table, ≥ minOnlineGames counted online games and a verified email.
 */
export async function betIneligibilityReason(
  userId: string,
  db: Db = prisma,
  gameMode: GameModeMarker = "standard",
): Promise<string | null> {
  const cfg = ECONOMY.tableBets;
  if (!tableBetsEnabledFor(gameMode)) {
    return gameMode === "lucky-duel" ? "Las apuestas en mesas Lucky Duel están desactivadas" : "Las apuestas de mesa están desactivadas";
  }
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

/**
 * Why these two players can't start another bet table today (Spanish reason), or null:
 * ECONOMY.tableBets.maxBetsPerDayPerOpponent bet tables per pair per economy day (both kinds).
 */
export async function betPairLimitReason(a: string, b: string, db: Db = prisma, now = new Date()): Promise<string | null> {
  const max = ECONOMY.tableBets.maxBetsPerDayPerOpponent;
  if ((await betsTodayBetween(db, a, b, now)) < max) return null;
  return `Ya jugaste ${max} mesas con apuesta contra este rival hoy`;
}

/**
 * The bet the table actually carries: 0 when bets are off for its kind, the pair isn't eligible
 * today or the bet is over a Lucky Duel table's cap (createRoom already refuses those).
 */
async function effectiveBet(tx: Db, input: OpenMatchInput, now: Date): Promise<number> {
  const gameMode = input.gameMode ?? "standard";
  if (input.mode === "friendly" || input.betAmount <= 0 || !tableBetsEnabledFor(gameMode)) return 0;
  if (gameMode === "lucky-duel" && input.betAmount > ECONOMY.tableBets.luckyDuel.maxBet) return 0;
  for (const id of [input.player1Id, input.player2Id]) {
    if (await betIneligibilityReason(id, tx, gameMode)) return 0;
  }
  if (await betPairLimitReason(input.player1Id, input.player2Id, tx, now)) return 0;
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
  /** The table's rules (default standard). */
  gameMode?: GameModeMarker;
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
        gameMode: input.gameMode ?? "standard",
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

/**
 * A Lucky Duel's facts for the achievements: the Basic each side drew (game-core catalog ids from
 * LUCKY_DUEL_BASICS) and who took turn 1 (null: the game ended before the reveal).
 */
export interface LuckyDuelStarters {
  /** Player 1's drawn Basic (vs AI: the player's). */
  player1StarterId: string;
  /** Player 2's drawn Basic (vs AI: the AI's). */
  player2StarterId: string;
  startingSide: "player1" | "player2" | null;
}

export type SettleInput =
  /**
   * winnerId null = no result (cancelled / abandoned): bets are refunded, nothing counts.
   * `draw: true` (with winnerId null) = a game played to a draw (Lucky Duel: both Actives Knocked
   * Out at once): no winner and no loser. It counts like any game (anti-farming rules minus the
   * per-opponent win cap) but changes no win/loss stats or streaks (the stats model has no draws);
   * both players get the loser's participation rewards (XP, match coins, "game_played" mission).
   * `luckyDuel`: the drawn Basics and the starting side (Lucky Duel tables only).
   * `forfeit`: the loser gave the game up (surrender, leave, disconnect timeout, turn-timer kick,
   * setup timeout, no-show, draft forfeit); before the anti-farming threshold it is an "early
   * forfeit" (ECONOMY.antiFarming.forfeit).
   */
  | {
      kind: "multiplayer";
      winnerId: string | null;
      draw?: boolean;
      reason: string;
      turnNumber: number;
      luckyDuel?: LuckyDuelStarters;
      forfeit?: boolean;
    }
  /**
   * turnNumber: last turn reached, reported by the client (the AI game runs in the browser).
   * `draw`: the game ended in a draw (Lucky Duel: both Actives Knocked Out at once): no winner,
   * the loser's rewards (same ruling as multiplayer). `abandoned`: a Lucky Duel left unfinished
   * (the player started another vs-AI game): a defeat. The game's mode is the match row's
   * `gameMode` (set at the start); `luckyDuel` is only stored for a Lucky Duel.
   */
  | { kind: "ai"; victory: boolean; draw?: boolean; abandoned?: boolean; turnNumber: number; luckyDuel?: LuckyDuelStarters };

/** What a vs-AI Lucky Duel's stake did (finish response `luckyDuel`). */
export interface LuckyDuelAiSettlement {
  /** Coins escrowed at the start (0 for an account without a verified email). */
  stake: number;
  /** Coins credited back: 2 × stake (victory), the stake (draw) or 0 (defeat / abandon). */
  payout: number;
  /** Consecutive vs-AI Lucky Duel victories after this game. */
  streak: number;
  /** Bonus credited by this game: ECONOMY.luckyDuelAi.streakBonus when the streak just reached a multiple of streakBonusEvery, else 0. */
  streakBonus: number;
  /** A victory reported sooner than ECONOMY.luckyDuelAi.minVictoryMs after the start, settled as a draw. */
  quickVictory: boolean;
}

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
  /** vs-AI Lucky Duel only. */
  luckyDuel?: LuckyDuelAiSettlement;
  /**
   * The loser forfeited before the anti-farming threshold (ECONOMY.antiFarming.forfeit). The
   * forfeiter's loss is in their stats, without coins, XP or missions.
   */
  earlyForfeit: boolean;
  /** Winner of an early forfeit that didn't count: why (null otherwise). */
  forfeitBlockedBy: ForfeitBlockReason | null;
  /** Winner of a non-friendly online game: the per-opponent daily coin cap (null otherwise). */
  pairCap: PairCapSettlement | null;
  /** Loser: part of their table-bet stake refunded because the winner reached the per-opponent cap. */
  betRefundedByPairCap: number;
}

/**
 * Why an early-forfeit win didn't count: the forfeiter isn't an established account, the winner
 * already has ECONOMY.antiFarming.forfeit.maxPaidWinsPerDay paid forfeit wins today, or the
 * per-opponent counted-wins cap (maxCountedWinsPerOpponentPerDay) was reached.
 */
export type ForfeitBlockReason = "forfeiter_not_established" | "daily_forfeit_limit" | "opponent_win_limit";

/** The per-opponent daily coin cap (ECONOMY.antiFarming.maxCoinsFromOpponentPerDay) for the winner. */
export interface PairCapSettlement {
  limit: number;
  /** Coins won from this opponent this economy day, this game included. */
  coinsWonToday: number;
  /** Match coins this game didn't pay because of the cap. */
  rewardCoinsCut: number;
  /** Net bet winnings this game didn't pay because of the cap (refunded to the loser). */
  betWinningsCut: number;
  /** coinsWonToday reached the limit: further wins against this opponent today pay no coins. */
  reached: boolean;
}

export interface SettlementResult {
  matchId: string;
  mode: MatchMode;
  betAmount: number;
  winnerId: string | null;
  counted: boolean;
  /** See PlayerSettlement.earlyForfeit. */
  earlyForfeit: boolean;
  players: PlayerSettlement[];
}

type AiRecordedResult = "victory" | "defeat" | "draw" | "abandoned";

/** A vs-AI match row's winReason: "victory" | "defeat" | "draw", prefixed "lucky-duel: " for that mode. */
function aiWinReason(result: AiRecordedResult, luckyDuel: boolean, quickVictory: boolean): string {
  if (!luckyDuel) return result;
  return `lucky-duel: ${result}${quickVictory ? " (quick victory)" : ""}`;
}

/**
 * Settle a match exactly once: pay the pot to the winner (or refund both stakes when there is
 * no result, a draw, or a standard table's game ended before turn 3), and — only for a counted game — record win/loss
 * stats (normal and draft), grant XP, match coins and mission progress. A vs-AI Lucky Duel also
 * settles its stake and streak bonus (whether it counted or not). Returns null when the match
 * doesn't exist or was already settled, so callers can fire it from every end path.
 */
export async function settleMatch(matchId: string, input: SettleInput, now = new Date()): Promise<SettlementResult | null> {
  return prisma.$transaction((tx) => settleMatchTx(tx, matchId, input, now), TX_OPTIONS);
}

/** settleMatch inside the caller's transaction (startAiMatch settles an abandoned Lucky Duel). */
async function settleMatchTx(tx: Db, matchId: string, input: SettleInput, now: Date): Promise<SettlementResult | null> {
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: { id: true, mode: true, gameMode: true, player1Id: true, player2Id: true, betAmount: true, startedAt: true, settledAt: true },
  });
  if (!match || match.settledAt) return null;
  const mode = match.mode as MatchMode;
  const isAi = mode === "ai";
  if ((input.kind === "ai") !== isAi) throw new Error(`settleMatch: ${input.kind} result for a ${mode} match`);
  const luckyDuel = match.gameMode === "lucky-duel";

  // vs-AI Lucky Duel: a victory reported too soon after the start is a draw (anti-script)
  const quickVictory =
    input.kind === "ai" &&
    luckyDuel &&
    input.victory &&
    (!match.startedAt || now.getTime() - match.startedAt.getTime() < ECONOMY.luckyDuelAi.minVictoryMs);
  const aiVictory = input.kind === "ai" && input.victory && !quickVictory;

  const players = [match.player1Id, match.player2Id].filter((id): id is string => !!id);
  let winnerId: string | null;
  if (input.kind === "ai") winnerId = aiVictory ? match.player1Id : null;
  else winnerId = input.winnerId && players.includes(input.winnerId) ? input.winnerId : null;
  // A draw is a played game without a winner (never together with a winner)
  const draw =
    input.kind === "multiplayer"
      ? input.draw === true && winnerId === null
      : quickVictory || (input.draw === true && !input.victory && !input.abandoned);
  const decided = input.kind === "ai" || winnerId !== null || draw;
  const aiResult: AiRecordedResult = aiVictory ? "victory" : draw ? "draw" : input.kind === "ai" && input.abandoned ? "abandoned" : "defeat";

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
      winReason: input.kind === "ai" ? aiWinReason(aiResult, luckyDuel, quickVictory) : input.reason.slice(0, 200),
      // Lucky Duel achievements read these (first turn, drawn Basics)
      ...(luckyDuel
        ? {
            finalTurn: input.turnNumber,
            ...(input.luckyDuel
              ? {
                  player1StarterId: input.luckyDuel.player1StarterId,
                  player2StarterId: input.luckyDuel.player2StarterId,
                  startingSide: input.luckyDuel.startingSide,
                }
              : {}),
          }
        : {}),
    },
  });
  if (count === 0) return null;

  const rules = decided ? await countingRules(tx, match, mode, input, winnerId, now) : NOT_COUNTED;
  const { counted, earlyForfeit } = rules;
  const loserId = winnerId ? players.find((p) => p !== winnerId) ?? null : null;
  const verified = new Map<string, boolean>();
  for (const p of players) verified.set(p, (await hasVerifiedEmail(p, tx)) ?? false);

  // Per-opponent daily coin cap (non-friendly online wins): what the winner already won from the
  // loser today, under both players' row locks (taken above, id order) so concurrent settlements
  // of the pair serialize. The pot is paid first, then the match coins, from what is left
  const pairCapApplies = !isAi && (mode === "normal" || mode === "draft") && !!winnerId && !!loserId;
  const pairLimit = ECONOMY.antiFarming.maxCoinsFromOpponentPerDay;
  const pairBefore = pairCapApplies ? await coinsWonFromOpponentToday(tx, winnerId!, loserId!, matchId, now) : 0;
  let pairRemaining = pairCapApplies ? Math.max(0, pairLimit - pairBefore) : Number.POSITIVE_INFINITY;
  let pairWon = 0;
  let betWinningsCut = 0;

  // Table bet: pot to the winner (only if the game reached the payout turn), else stakes back.
  // No house cut: the winner gets both stakes. A Lucky Duel pays on any turn (one Knock Out
  // decides it, like the vs-AI stake below); its draw or a game without a result refunds both.
  // Past the per-opponent cap the winner gets their stake back plus the winnings left under it,
  // and the loser the rest of their stake
  const bet = match.betAmount;
  const coinsDelta = new Map<string, number>(players.map((p) => [p, 0]));
  if (bet > 0 && !isAi) {
    const reachedPayoutTurn =
      input.kind === "multiplayer" && (luckyDuel || input.turnNumber >= ECONOMY.tableBets.minTurnForPayout);
    if (winnerId && reachedPayoutTurn) {
      const winnings = Math.min(bet, pairRemaining);
      betWinningsCut = bet - winnings;
      if (betWinningsCut === 0) {
        await creditBalance(winnerId, "coins", bet * 2, "bet_win", `Apuesta ganada: ${bet * 2} monedas del pozo`, tx);
      } else if (winnings > 0) {
        await creditBalance(
          winnerId,
          "coins",
          bet + winnings,
          "bet_win",
          `Apuesta ganada: ${bet + winnings} monedas (tu apuesta + ${winnings} de ganancia; ${PAIR_CAP_NOTE})`,
          tx,
        );
      } else {
        await creditBalance(winnerId, "coins", bet, "bet_refund", `Apuesta devuelta: ${bet} monedas (ganaste; ${PAIR_CAP_NOTE})`, tx);
      }
      if (betWinningsCut > 0 && loserId) {
        const part = betWinningsCut < bet ? "Apuesta devuelta en parte" : "Apuesta devuelta";
        await creditBalance(
          loserId,
          "coins",
          betWinningsCut,
          "bet_refund",
          `${part}: ${betWinningsCut} monedas (tu rival alcanzó su tope diario de monedas contra ti)`,
          tx,
        );
      }
      for (const p of players) coinsDelta.set(p, p === winnerId ? winnings : winnings > 0 ? -winnings : 0);
      pairRemaining -= winnings;
      pairWon += winnings;
    } else {
      const why = winnerId
        ? `la partida no llegó al turno ${ECONOMY.tableBets.minTurnForPayout}`
        : draw ? "empate" : "partida sin resultado";
      for (const p of players) {
        await creditBalance(p, "coins", bet, "bet_refund", `Apuesta devuelta: ${bet} monedas (${why})`, tx);
      }
    }
  }

  // vs-AI Lucky Duel stake (escrowed at the start): settled whatever the anti-farming rules say
  let luckyAi: LuckyDuelAiSettlement | undefined;
  if (isAi && luckyDuel && match.player1Id) {
    const payout = aiVictory ? bet * 2 : draw ? bet : 0;
    if (payout > 0) {
      if (aiVictory) {
        await creditBalance(match.player1Id, "coins", payout, "lucky_duel_win", `Lucky Duel ganado: ${payout} monedas`, tx);
      } else {
        await creditBalance(match.player1Id, "coins", payout, "lucky_duel_refund", `Lucky Duel empatado: ${payout} monedas devueltas`, tx);
      }
    }
    luckyAi = { stake: bet, payout, streak: 0, streakBonus: 0, quickVictory };
  }

  // Lucky Duel streaks: every decided game (counted or not; a Lucky Duel can end on turn 1),
  // friendly tables excluded. Under the players' row locks, so concurrent settlements serialize
  if (luckyDuel && decided && mode !== "friendly") {
    const cfg = ECONOMY.luckyDuelAi;
    for (const p of players) {
      const outcome = draw ? "draw" : p === winnerId ? "win" : "loss";
      const streaks = await recordLuckyDuelResult(tx, p, outcome, isAi);
      if (!luckyAi) continue;
      luckyAi.streak = streaks.aiStreak;
      const bonusDue = outcome === "win" && cfg.streakBonusEvery > 0 && streaks.aiStreak % cfg.streakBonusEvery === 0;
      // Only a staked game pays it (unverified accounts and games past the daily staked ones don't)
      if (bonusDue && cfg.streakBonus > 0 && bet > 0 && verified.get(p)) {
        await creditBalance(
          p,
          "coins",
          cfg.streakBonus,
          "lucky_duel_streak_bonus",
          `Racha de Lucky Duel: ${streaks.aiStreak} victorias seguidas (+${cfg.streakBonus} monedas)`,
          tx,
        );
        luckyAi.streakBonus = cfg.streakBonus;
      }
    }
  }

  // Stats (multiplayer normal/draft, counted only). A draw changes no stats: there is no draw
  // column, and neither streak breaks nor grows. An early forfeit that didn't count still records
  // the forfeiter's loss (streak broken); the winner gets nothing
  if (winnerId && (mode === "normal" || mode === "draft")) {
    if (counted) {
      for (const p of players) await recordMatchResult(p, mode, p === winnerId, tx);
    } else if (earlyForfeit && loserId) {
      await recordMatchResult(loserId, mode, false, tx);
    }
  }

  // XP, match coins and missions (counted only; coins and missions need a verified email). The
  // early forfeiter gets none of them, even when the win counted for the winner
  const grants = new Map<string, ExperienceGrant>();
  const coinGrants = new Map<string, MatchCoinGrant>();
  const missions = new Map<string, MissionCompletion[]>();
  for (const p of players) {
    // A draw pays both players what a loser gets (participation): XP, match coins, game_played
    const outcome = p === winnerId ? "win" : "loss";
    const rewarded = counted && !(earlyForfeit && p !== winnerId);
    const grant = await grantExperience(tx, p, rewarded ? XP_REWARDS[mode][outcome] : 0, now);
    if (grant) grants.set(p, grant);
    if (!rewarded || !verified.get(p)) continue;
    const pairLeft = pairCapApplies && p === winnerId ? pairRemaining : Number.POSITIVE_INFINITY;
    const coinGrant = await grantMatchCoins(tx, p, isAi ? "ai" : "online", outcome, matchId, now, pairLeft);
    coinGrants.set(p, coinGrant);
    if (pairCapApplies && p === winnerId) pairWon += coinGrant.amount;
    const completed = await recordMissionEvent(tx, p, "game_played", now);
    if (outcome === "win") completed.push(...(await recordMissionEvent(tx, p, "game_won", now)));
    missions.set(p, completed);
  }
  const coinsOf = (id: string | null) => (id && coinGrants.get(id)?.amount) || 0;
  const pairCoinsOf = (id: string | null) => (id && id === winnerId ? pairWon : 0);
  await tx.match.update({
    where: { id: matchId },
    data: {
      counted,
      earlyForfeit,
      player1Xp: (match.player1Id && grants.get(match.player1Id)?.gained) || 0,
      player2Xp: (match.player2Id && grants.get(match.player2Id)?.gained) || 0,
      player1Coins: coinsOf(match.player1Id),
      player2Coins: coinsOf(match.player2Id),
      player1PairCoins: pairCoinsOf(match.player1Id),
      player2PairCoins: pairCoinsOf(match.player2Id),
    },
  });
  const pairCap: PairCapSettlement | null = pairCapApplies
    ? {
        limit: pairLimit,
        coinsWonToday: pairBefore + pairWon,
        rewardCoinsCut: coinGrants.get(winnerId!)?.pairCut ?? 0,
        betWinningsCut,
        reached: pairBefore + pairWon >= pairLimit,
      }
    : null;

  const balances = await tx.user.findMany({ where: { id: { in: players } }, select: { id: true, coins: true } });
  return {
    matchId,
    mode,
    betAmount: bet,
    winnerId,
    counted,
    earlyForfeit,
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
        ...(luckyAi && p === match.player1Id ? { luckyDuel: luckyAi } : {}),
        earlyForfeit,
        forfeitBlockedBy: p === winnerId ? rules.forfeitBlockedBy : null,
        pairCap: p === winnerId ? pairCap : null,
        betRefundedByPairCap: p === loserId ? betWinningsCut : 0,
      };
    }),
  };
}

/**
 * One decided Lucky Duel for `userId`: the Lucky Duel streak (both modes) grows on a win and
 * resets on a loss or draw; `vsAi` also moves the vs-AI streak. Needs the user's row lock.
 */
async function recordLuckyDuelResult(tx: Db, userId: string, outcome: "win" | "loss" | "draw", vsAi: boolean) {
  // Accounts get their stats row at signup; create it if it's missing (older accounts)
  const s = await tx.userStats.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { luckyDuelStreak: true, luckyDuelBestStreak: true, luckyDuelAiStreak: true },
  });
  const streak = outcome === "win" ? s.luckyDuelStreak + 1 : 0;
  const aiStreak = vsAi ? (outcome === "win" ? s.luckyDuelAiStreak + 1 : 0) : s.luckyDuelAiStreak;
  await tx.userStats.update({
    where: { userId },
    data: { luckyDuelStreak: streak, luckyDuelBestStreak: Math.max(s.luckyDuelBestStreak, streak), luckyDuelAiStreak: aiStreak },
  });
  return { streak, aiStreak };
}

interface CountingRules {
  counted: boolean;
  /** The loser forfeited before minTurn / minDurationMs (non-friendly online game with a winner). */
  earlyForfeit: boolean;
  forfeitBlockedBy: ForfeitBlockReason | null;
}

const NOT_COUNTED: CountingRules = { counted: false, earlyForfeit: false, forfeitBlockedBy: null };

/**
 * The anti-farming rules (see the header), plus ECONOMY.antiFarming.forfeit for a multiplayer
 * game the loser forfeited before the threshold. Needs the players' row locks (the per-opponent
 * and per-day counts can't race).
 */
async function countingRules(
  tx: Db,
  match: { id: string; player1Id: string | null; player2Id: string | null; startedAt: Date | null },
  mode: MatchMode,
  input: SettleInput,
  winnerId: string | null,
  now: Date,
): Promise<CountingRules> {
  const rules = ECONOMY.antiFarming;
  if (mode === "friendly" || !match.startedAt) return NOT_COUNTED;
  if (input.kind === "ai") {
    return { ...NOT_COUNTED, counted: await aiGameCounts(tx, match, input, now) };
  }
  if (!match.player1Id || !match.player2Id) return NOT_COUNTED;
  const elapsed = now.getTime() - match.startedAt.getTime();
  const reachedThreshold = input.turnNumber >= rules.minTurn && elapsed >= rules.minDurationMs;

  // A draw has no winner to cap (the per-opponent cap counts wins); no result counts for nobody
  if (!winnerId) return { ...NOT_COUNTED, counted: reachedThreshold && input.draw === true };
  const loserId = winnerId === match.player1Id ? match.player2Id : match.player1Id;
  const underOpponentCap =
    (await countedWinsAgainstToday(tx, winnerId, loserId, match.id, now)) < rules.maxCountedWinsPerOpponentPerDay;
  if (reachedThreshold) return { ...NOT_COUNTED, counted: underOpponentCap };
  if (!input.forfeit) return NOT_COUNTED;

  // Early forfeit: the win counts only against an established forfeiter, within the caps
  let forfeitBlockedBy: ForfeitBlockReason | null = null;
  if (!(await isEstablishedAccount(tx, loserId))) forfeitBlockedBy = "forfeiter_not_established";
  else if (!underOpponentCap) forfeitBlockedBy = "opponent_win_limit";
  else if ((await paidForfeitWinsToday(tx, winnerId, match.id, now)) >= rules.forfeit.maxPaidWinsPerDay) {
    forfeitBlockedBy = "daily_forfeit_limit";
  }
  return { counted: forfeitBlockedBy === null, earlyForfeit: true, forfeitBlockedBy };
}

/** vs AI: turn, duration and the counted games of the day. */
async function aiGameCounts(
  tx: Db,
  match: { id: string; player1Id: string | null; startedAt: Date | null },
  input: SettleInput,
  now: Date,
): Promise<boolean> {
  const rules = ECONOMY.antiFarming;
  if (!match.startedAt || input.turnNumber < rules.minTurn) return false;
  const elapsed = now.getTime() - match.startedAt.getTime();
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

/** Every Basic a Lucky Duel can deal (game-core): the only valid starter ids. */
const LUCKY_DUEL_BASIC_IDS: ReadonlySet<string> = new Set(LUCKY_DUEL_BASICS.map((c) => c.id));

/** The drawn Basics a vs-AI Lucky Duel reports at /finish (player's view). */
export interface AiLuckyDuelReport {
  playerStarterId: string;
  opponentStarterId: string;
  startingPlayer: "player" | "opponent";
}

export interface StartAiMatchResult {
  matchId: string;
  /**
   * Lucky Duel only: the stake escrowed for this game (0 = unstaked: no verified email or the
   * day's staked games are used up), the current vs-AI Lucky Duel streak and the staked games
   * left today after this one.
   */
  luckyDuel?: { stake: number; streak: number; stakedGamesLeft: number };
}

/**
 * The stake `userId`'s next vs-AI Lucky Duel takes and the staked games left today before it.
 * Only the first ECONOMY.luckyDuelAi.dailyStakedGames Lucky Duel starts of the economy day (the
 * day the AI's counted-games cap uses) are staked; accounts without a verified email never are.
 */
async function luckyDuelAiStake(db: Db, userId: string, now: Date): Promise<{ stake: number; stakedGamesLeft: number }> {
  const cfg = ECONOMY.luckyDuelAi;
  if (!(await hasVerifiedEmail(userId, db))) return { stake: 0, stakedGamesLeft: 0 };
  const stakedToday = await db.match.count({
    where: { player1Id: userId, mode: "ai", gameMode: "lucky-duel", betAmount: { gt: 0 }, startedAt: { gte: startOfEconomyDay(now) } },
  });
  const stakedGamesLeft = Math.max(0, cfg.dailyStakedGames - stakedToday);
  return { stake: stakedGamesLeft > 0 ? cfg.stake : 0, stakedGamesLeft };
}

/**
 * Start a single-player game (one at a time). The user's previous unfinished games go first: a
 * standard one is dropped; a Lucky Duel is settled as an abandoned defeat (stake kept, streak
 * reset), so leaving or reloading can't dodge a loss. `mode: "lucky-duel"` escrows
 * ECONOMY.luckyDuelAi.stake (400 "Necesitas N monedas para jugar Lucky Duel" when the user lacks
 * them; nothing is charged, the abandoned games are still settled). Accounts without a verified
 * email, and every start after the day's dailyStakedGames staked ones, play Lucky Duel for
 * nothing (stake 0, no payout, no streak bonus; the streak still moves).
 */
export async function startAiMatch(userId: string, mode: GameModeMarker = "standard", now = new Date()): Promise<StartAiMatchResult> {
  const result = await prisma.$transaction(async (tx) => {
    // Serialize the user's starts and finishes (one unfinished game at a time)
    await lockUsers(tx, [userId]);
    const open = await tx.match.findMany({
      where: { player1Id: userId, mode: "ai", settledAt: null },
      select: { id: true, gameMode: true },
    });
    const dropped = open.filter((m) => m.gameMode !== "lucky-duel").map((m) => m.id);
    if (dropped.length > 0) await tx.match.deleteMany({ where: { id: { in: dropped } } });
    for (const m of open.filter((o) => o.gameMode === "lucky-duel")) {
      await settleMatchTx(tx, m.id, { kind: "ai", victory: false, abandoned: true, turnNumber: 0 }, now);
    }

    if (mode !== "lucky-duel") {
      const match = await tx.match.create({
        data: { mode: "ai", status: "playing", player1Id: userId, startedAt: now },
        select: { id: true },
      });
      return { matchId: match.id };
    }

    // Under the user's lock: concurrent starts can't both take the day's last staked game
    const { stake, stakedGamesLeft } = await luckyDuelAiStake(tx, userId, now);
    if (stake > 0) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
      // Returned, not thrown: the abandoned games above stay settled
      if (!user || user.coins < stake) return { insufficient: stake };
    }
    const match = await tx.match.create({
      data: { mode: "ai", gameMode: "lucky-duel", status: "playing", player1Id: userId, betAmount: stake, startedAt: now },
      select: { id: true },
    });
    if (stake > 0) {
      await debitBalance(userId, "coins", stake, "lucky_duel_stake", `Lucky Duel: ${stake} monedas en juego`, tx);
    }
    const stats = await tx.userStats.findUnique({ where: { userId }, select: { luckyDuelAiStreak: true } });
    return {
      matchId: match.id,
      luckyDuel: { stake, streak: stats?.luckyDuelAiStreak ?? 0, stakedGamesLeft: stake > 0 ? stakedGamesLeft - 1 : stakedGamesLeft },
    };
  }, TX_OPTIONS);

  if ("insufficient" in result) throw Errors.BadRequest(`Necesitas ${result.insufficient} monedas para jugar Lucky Duel`);
  return result;
}

/**
 * The vs-AI Lucky Duel numbers for the play page: the stake the next game takes (0 without a
 * verified email or once the day's staked games are used up), the staked games left today, the
 * bonus rule, the current vs-AI streak and the best Lucky Duel streak (both modes, "Suerte
 * imparable").
 */
export async function getLuckyDuelAiStatus(userId: string, now = new Date()) {
  const [{ stake, stakedGamesLeft }, stats] = await Promise.all([
    luckyDuelAiStake(prisma, userId, now),
    prisma.userStats.findUnique({ where: { userId }, select: { luckyDuelAiStreak: true, luckyDuelStreak: true, luckyDuelBestStreak: true } }),
  ]);
  const cfg = ECONOMY.luckyDuelAi;
  return {
    stake,
    stakedGamesLeft,
    streakBonusEvery: cfg.streakBonusEvery,
    streakBonus: cfg.streakBonus,
    streak: stats?.luckyDuelAiStreak ?? 0,
    luckyDuelStreak: stats?.luckyDuelStreak ?? 0,
    luckyDuelBestStreak: stats?.luckyDuelBestStreak ?? 0,
  };
}

/**
 * Report the end of a single-player game started with startAiMatch. `result`: "victory" | "defeat" | "draw" (a boolean is read as victory / defeat). A draw
 * (Lucky Duel) has no winner: the loser's XP / match coins / game_played, no streak change.
 * The game's mode is the one it was started with. A Lucky Duel settles its stake (and streak
 * bonus) and, when `luckyDuel` is given, stores the drawn Basics for the achievements (400 if an
 * id isn't a Lucky Duel Basic).
 */
export async function finishAiMatch(
  userId: string,
  matchId: string,
  result: AiResult | boolean,
  turnNumber: number,
  now = new Date(),
  luckyDuel?: AiLuckyDuelReport,
) {
  const outcome: AiResult = typeof result === "boolean" ? (result ? "victory" : "defeat") : result;
  if (luckyDuel && (!LUCKY_DUEL_BASIC_IDS.has(luckyDuel.playerStarterId) || !LUCKY_DUEL_BASIC_IDS.has(luckyDuel.opponentStarterId))) {
    throw Errors.BadRequest("Pokémon de Lucky Duel inválido");
  }
  const match = await prisma.match.findFirst({
    where: { id: matchId, player1Id: userId, mode: "ai" },
    select: { settledAt: true, gameMode: true },
  });
  if (!match) throw Errors.NotFound("Partida");
  if (match.settledAt) throw Errors.Conflict("Esta partida ya fue registrada");

  const settled = await settleMatch(
    matchId,
    {
      kind: "ai",
      victory: outcome === "victory",
      draw: outcome === "draw",
      turnNumber,
      ...(luckyDuel
        ? {
            luckyDuel: {
              player1StarterId: luckyDuel.playerStarterId,
              player2StarterId: luckyDuel.opponentStarterId,
              startingSide: luckyDuel.startingPlayer === "player" ? "player1" : "player2",
            },
          }
        : {}),
    },
    now,
  );
  if (!settled) throw Errors.Conflict("Esta partida ya fue registrada");
  const me = settled.players[0];
  return {
    matchId,
    mode: match.gameMode as GameModeMarker,
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
    ...(me.luckyDuel ? { luckyDuel: me.luckyDuel } : {}),
  };
}
