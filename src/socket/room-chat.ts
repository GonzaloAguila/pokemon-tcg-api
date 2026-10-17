/**
 * Room chats (game tables and drafts): players and spectators write in the same chat, each
 * message says whether its author watches (`isSpectator`, shown as "Espectador"). Messages are
 * not stored in the DB: a room keeps its last ROOM_CHAT_HISTORY in memory, sent to whoever
 * joins or watches it (`chatHistory` / `draft:chatHistory`).
 *
 * Flood control is shared by every chat (room, draft, global): at most CHAT_MAX_PER_WINDOW
 * messages per user per CHAT_WINDOW_MS.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";

export interface RoomChatMessage {
  id: string;
  /** Socket of the author (legacy field of the game room chat). */
  senderId: string;
  userId: string;
  username: string;
  role: string;
  content: string;
  timestamp: number;
  /** Written by someone watching the room, not playing it. */
  isSpectator: boolean;
}

export const ROOM_CHAT_HISTORY = 50;

const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX_PER_WINDOW = 8;
const chatTimestamps = new Map<string, number[]>();

/** Whether `userId` may send another chat message now (and count it). */
export function allowChatMessage(userId: string): boolean {
  const now = Date.now();
  const recent = (chatTimestamps.get(userId) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
  if (recent.length >= CHAT_MAX_PER_WINDOW) {
    chatTimestamps.set(userId, recent);
    return false;
  }
  recent.push(now);
  chatTimestamps.set(userId, recent);
  return true;
}

/** A room chat message by `userId` (name and role read from the DB, never from the client). */
export async function buildRoomChatMessage(
  userId: string,
  socketId: string,
  content: string,
  isSpectator: boolean,
): Promise<RoomChatMessage> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, role: true } });
  return {
    id: randomUUID(),
    senderId: socketId,
    userId,
    username: user?.username ?? "Anónimo",
    role: user?.role ?? "user",
    content,
    timestamp: Date.now(),
    isSpectator,
  };
}

/** Keep `message` in a room's history (the last ROOM_CHAT_HISTORY). */
export function rememberChatMessage(history: RoomChatMessage[], message: RoomChatMessage): void {
  history.push(message);
  if (history.length > ROOM_CHAT_HISTORY) history.splice(0, history.length - ROOM_CHAT_HISTORY);
}
