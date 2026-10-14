/**
 * The game state a client receives for a room: masked for its viewer (state-masking.ts) plus
 * room facts the engine state doesn't know about.
 *
 * `awaitingUserId`: the user id of the player the game is waiting on (GameRoomManager
 * getAwaitingUserId / awaitedSide: the side whose turn it is, or whoever owes a pending
 * promotion, Prize or off-turn answer), null when nobody / both or the game is over. The other
 * player may ask to kick them (`requestKick`) once the turn timer runs out.
 */
import type { GameState } from "@gonzaloaguila/game-core";
import type { GameRoom, GameRoomManager } from "./rooms.js";
import { maskGameStateForPlayer, type MaskedGameState, type Viewer } from "./state-masking.js";

export type RoomGameState = MaskedGameState & { awaitingUserId: string | null };

export function maskRoomState(
  manager: GameRoomManager,
  room: GameRoom,
  state: GameState,
  viewer: Viewer,
): RoomGameState {
  return { ...maskGameStateForPlayer(state, viewer), awaitingUserId: manager.getAwaitingUserId(room) };
}
