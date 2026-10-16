/**
 * The game state a client receives for a room: masked for its viewer (state-masking.ts) plus
 * room facts the engine state doesn't know about.
 *
 * `awaitingUserId`: the user id of the player the game is waiting on (GameRoomManager
 * getAwaitingUserId / awaitedSide: the side whose turn it is, or whoever owes a pending
 * promotion, Prize or off-turn answer), null when nobody / both or the game is over. The other
 * player may ask to kick them (`requestKick`) once the turn timer runs out.
 *
 * `clock` (GameRoomManager.getClock): whose clock runs. `kind: "turn"` = the awaited player's
 * turn clock (`startedAt` + `durationSeconds`; kick when it ran out). `kind: "answer"` = a
 * player answering off-turn (Challenge!, Erika, Flee...): their clock runs from `startedAt`, the
 * turn clock of `pausedUserId` is paused with `pausedRemainingSeconds` left; when the answer clock
 * runs out the server answers by default (no kick). `awaitingUserId` = `clock.userId`.
 */
import type { GameState } from "@gonzaloaguila/game-core";
import type { GameRoom, GameRoomManager, RoomClock } from "./rooms.js";
import { maskGameStateForPlayer, type MaskedGameState, type Viewer } from "./state-masking.js";

export type RoomGameState = MaskedGameState & { awaitingUserId: string | null; clock: RoomClock };

export function maskRoomState(
  manager: GameRoomManager,
  room: GameRoom,
  state: GameState,
  viewer: Viewer,
): RoomGameState {
  return { ...maskGameStateForPlayer(state, viewer), awaitingUserId: manager.getAwaitingUserId(room), clock: manager.getClock(room) };
}
