/**
 * Battle emotes in game rooms (tables and draft games). A seated player sends `sendEmote
 * { roomId, emoteId }`; the server checks the seat, the rate limit and the sender's loadout, then
 * broadcasts `emote { roomId, side, userId, emoteId, sentAt }` to the room (players and
 * spectators). Nothing is stored: an emote is a passing reaction. They keep working after the
 * game over (to say "gg") while the finished room exists (`FINISHED_ROOM_TTL_MS` after the end,
 * rooms.ts `sweepRooms`) and the player hasn't left it.
 *
 * Loadouts are read from the DB when the game starts (`snapshotRoomEmotes`, called with the
 * cosmetics snapshot) and re-read when a player sends one that isn't in the snapshot, so a
 * loadout changed mid-game works on the next emote. The rate limit runs first, so a client can't
 * turn misses into DB reads.
 */
import { prisma } from "../lib/prisma.js";
import { getEmoteLoadout } from "../modules/emotes/emotes.service.js";
import type { GameRoom, PlayerKey } from "./rooms.js";

/** Minimum time between two emotes of one player, and the cap per minute. */
export const EMOTE_COOLDOWN_MS = 3_000;
export const EMOTE_WINDOW_MS = 60_000;
export const EMOTE_MAX_PER_WINDOW = 10;

export const EMOTE_ERRORS = {
  rateLimited: { code: "EMOTE_RATE_LIMITED", error: "Espera un momento antes de enviar otro emote" },
  notInLoadout: { code: "EMOTE_NOT_EQUIPPED", error: "Ese emote no está en tu selección" },
  notInGame: { code: "NOT_IN_GAME", error: "No estás jugando en esa mesa" },
} as const;

const sent = new Map<string, number[]>();

/** Whether `userId` may send an emote now (and count it): one per 3 s, ten per minute. */
export function allowEmote(userId: string, now = Date.now()): boolean {
  const recent = (sent.get(userId) ?? []).filter((t) => now - t < EMOTE_WINDOW_MS);
  const last = recent[recent.length - 1];
  if ((last !== undefined && now - last < EMOTE_COOLDOWN_MS) || recent.length >= EMOTE_MAX_PER_WINDOW) {
    sent.set(userId, recent);
    return false;
  }
  recent.push(now);
  sent.set(userId, recent);
  return true;
}

/** Forget users idle for a whole window (the map would only grow otherwise). */
export function pruneEmoteLimits(now = Date.now()): void {
  for (const [userId, times] of sent) {
    if (times.length === 0 || now - times[times.length - 1] >= EMOTE_WINDOW_MS) sent.delete(userId);
  }
}

/** Tests: start every user with a clean limit. */
export function resetEmoteLimits(): void {
  sent.clear();
}

const pruneTimer = setInterval(() => pruneEmoteLimits(), EMOTE_WINDOW_MS);
pruneTimer.unref?.();

export type RoomEmoteLoadouts = Record<PlayerKey, string[]>;

async function loadoutOrEmpty(userId: string | null): Promise<string[]> {
  if (!userId) return [];
  try {
    return await getEmoteLoadout(userId, prisma);
  } catch (err) {
    console.error(`[room-emotes] Could not read the emotes of ${userId}:`, err);
    return [];
  }
}

/** Read both seats' loadouts and keep them with the room (when the game starts). */
export async function snapshotRoomEmotes(room: GameRoom): Promise<RoomEmoteLoadouts> {
  const [player1, player2] = await Promise.all([loadoutOrEmpty(room.player1Id), loadoutOrEmpty(room.player2Id)]);
  room.emoteLoadouts = { player1, player2 };
  return room.emoteLoadouts;
}

/**
 * Whether `seat` may send `emoteId`: in the snapshot, or in the loadout re-read now (the player
 * may have changed it after the game started). The re-read replaces that seat's snapshot.
 */
export async function seatHasEmote(room: GameRoom, seat: PlayerKey, emoteId: string): Promise<boolean> {
  if (room.emoteLoadouts?.[seat].includes(emoteId)) return true;
  const userId = seat === "player1" ? room.player1Id : room.player2Id;
  const fresh = await loadoutOrEmpty(userId);
  room.emoteLoadouts = { ...(room.emoteLoadouts ?? { player1: [], player2: [] }), [seat]: fresh };
  return fresh.includes(emoteId);
}
