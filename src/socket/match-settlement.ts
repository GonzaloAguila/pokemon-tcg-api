/**
 * Bridge between in-memory game rooms and the `matches` table (modules/matches): opens the
 * match when a game starts (escrowing table bets) and settles it once when the game ends,
 * whatever the end path (game over, surrender, kick, disconnect forfeit, leave, admin close).
 */
import type { Server } from "socket.io";
import type { GameRoom } from "./rooms.js";
import {
  openMultiplayerMatch,
  settleMatch,
  type MultiplayerMode,
  type SettlementResult,
} from "../modules/matches/matches.service.js";
import { checkAndUpdateProgress } from "../modules/achievements/achievements.service.js";
import { userRoom } from "./io-registry.js";

type PlayerKey = "player1" | "player2";

export function roomMatchMode(room: GameRoom, isDraft: boolean): MultiplayerMode {
  if (isDraft) return "draft";
  return room.config.friendly ? "friendly" : "normal";
}

/**
 * Open the room's match before its game starts; with a bet, both stakes are deducted in the same
 * transaction. Throws InsufficientStakeError (nobody charged) when a player can't cover the bet.
 */
export async function openRoomMatch(room: GameRoom, mode: MultiplayerMode): Promise<void> {
  if (room.matchId) return;
  if (!room.player1Id || !room.player2Id) throw new Error("Need two players to start");
  const match = await openMultiplayerMatch({
    player1Id: room.player1Id,
    player2Id: room.player2Id,
    mode,
    betAmount: mode === "friendly" ? 0 : room.config.betAmount,
    roomId: room.id,
  });
  room.matchId = match.id;
  // Bets off / pair not eligible: the table is played without a bet
  room.config.betAmount = match.betAmount;
}

/**
 * Settle the room's result once (later calls are no-ops): stats, XP and the bet pot, or a
 * refund when `winner` is null. Runs in the background; each player gets `matchSettled`.
 * Must be called while the room still knows both players (before leaveRoom clears a seat).
 */
export function settleRoomResult(
  io: Server | null,
  room: GameRoom | undefined,
  winner: PlayerKey | null,
  reason: string,
  // The mode (draft or not) comes from the match row; kept for the existing callers
  _options: { isDraft?: boolean } = {},
): void {
  if (!room || room.resultSettled) return;
  room.resultSettled = true;

  const player1Id = room.player1Id;
  const player2Id = room.player2Id;
  const winnerId = winner === "player1" ? player1Id : winner === "player2" ? player2Id : null;

  if (!room.matchId) {
    // The match row couldn't be opened (DB error at start): no bet was taken, and without the
    // row the anti-farming rules can't be checked, so the game counts for nobody.
    console.warn(`[settlement] room ${room.id} ended without a match row; result not recorded`);
    return;
  }

  const matchId = room.matchId;
  settleMatch(matchId, {
    kind: "multiplayer",
    winnerId,
    reason,
    turnNumber: room.gameState?.turnNumber ?? 0,
  })
    .then((result) => {
      if (result) notifySettlement(io, room.id, result);
    })
    .catch((err) => console.error(`[settlement] room ${room.id} match ${matchId} failed:`, err));
}

function notifySettlement(io: Server | null, roomId: string, result: SettlementResult): void {
  for (const p of result.players) {
    checkAndUpdateProgress(p.userId).catch(console.error);
    io?.to(userRoom(p.userId)).emit("matchSettled", {
      roomId,
      mode: result.mode,
      betAmount: result.betAmount,
      outcome: p.outcome,
      counted: p.counted,
      coinsDelta: p.coinsDelta,
      rewardCoins: p.rewardCoins,
      rewardCoinsCapped: p.rewardCoinsCapped,
      missionsCompleted: p.missionsCompleted,
      emailVerified: p.emailVerified,
      coins: p.coins,
      xpGained: p.xpGained,
      xpCapped: p.xpCapped,
      levelsGained: p.levelsGained,
      level: p.level,
      experience: p.experience,
    });
  }
}
