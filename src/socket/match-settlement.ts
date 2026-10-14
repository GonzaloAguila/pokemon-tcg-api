/**
 * Records a game room's result exactly once, whatever the end path (game over, surrender,
 * turn-timer kick, disconnect forfeit, setup timeout, draft forfeit): win/loss stats (skipped
 * for friendly rooms) and the achievement progress that depends on them.
 *
 * Before this, every path recorded on its own and executeAction kept accepting actions after
 * GAME_OVER, so each extra action carrying `gameOver` recorded another win.
 */
import type { Server } from "socket.io";
import type { GameRoom, PlayerKey } from "./rooms.js";
import { recordMatchResult } from "../modules/users/users.service.js";
import { checkAndUpdateProgress } from "../modules/achievements/achievements.service.js";

/**
 * Settle the room's result once (later calls are no-ops). Runs in the background. Must be
 * called while the room still knows both players. `winner` null = no result (nothing recorded).
 */
export function settleRoomResult(
  _io: Server | null,
  room: GameRoom | undefined,
  winner: PlayerKey | null,
  reason: string,
  options: { isDraft?: boolean } = {},
): void {
  if (!room || room.resultSettled) return;
  room.resultSettled = true;
  if (!winner || room.config.friendly || !room.player1Id || !room.player2Id) return;

  const mode = options.isDraft ? ("draft" as const) : ("normal" as const);
  const winnerId = winner === "player1" ? room.player1Id : room.player2Id;
  const loserId = winner === "player1" ? room.player2Id : room.player1Id;
  console.log(`[settlement] room ${room.id}: ${winner} wins (${reason})`);
  recordMatchResult(winnerId, mode, true).then(() => checkAndUpdateProgress(winnerId)).catch(console.error);
  recordMatchResult(loserId, mode, false).then(() => checkAndUpdateProgress(loserId)).catch(console.error);
}
