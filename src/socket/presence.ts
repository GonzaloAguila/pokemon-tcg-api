/**
 * Who is connected right now (single process, in memory like the game rooms).
 *
 * - Online: authenticated users with at least one socket on the main Socket.io server
 *   (lobby, chat, games, drafts, trades). A user counts once however many tabs/sockets they
 *   have, and leaves when their last socket disconnects. Anonymous sockets never count.
 * - Global chat: authenticated users with at least one socket in the global chat room, with
 *   the public identity shown in the chat (no email or anything private).
 *
 * handlers.ts feeds both on connect / globalChat:join / globalChat:leave / disconnect;
 * GET /api/presence reads the online count.
 */
import type { UserRole } from "@prisma/client";

/** Public identity of a user in the global chat's "Conectados" list. */
export interface ChatPresenceUser {
  id: string;
  username: string;
  activeAvatarId: string | null;
  role: UserRole;
}

/** Payload of `chat:presence`: the users in the chat (at most CHAT_PRESENCE_LIMIT) and how many there are. */
export interface ChatPresencePayload {
  users: ChatPresenceUser[];
  count: number;
}

/** Most users sent in one `chat:presence` (count still says how many there are). */
export const CHAT_PRESENCE_LIMIT = 200;

/** userId → socket ids of that user */
const onlineSockets = new Map<string, Set<string>>();
/** userId → sockets of that user in the global chat + their public identity */
const chatMembers = new Map<string, { sockets: Set<string>; user: ChatPresenceUser }>();

/** An authenticated socket connected. Returns true when it is the user's first one (they came online). */
export function trackOnline(userId: string, socketId: string): boolean {
  const sockets = onlineSockets.get(userId) ?? new Set<string>();
  const cameOnline = sockets.size === 0;
  sockets.add(socketId);
  onlineSockets.set(userId, sockets);
  return cameOnline;
}

/** A socket disconnected; the user leaves when it was their last one (then returns true). */
export function untrackOnline(userId: string, socketId: string): boolean {
  const sockets = onlineSockets.get(userId);
  if (!sockets || !sockets.delete(socketId)) return false;
  if (sockets.size > 0) return false;
  onlineSockets.delete(userId);
  return true;
}

/**
 * Whether the user has at least one authenticated socket on any page (lobby, game, or the
 * frontend's always-on presence socket): rooms.ts uses it to tell an away creator (reachable by
 * the `tableJoined` alert) from an offline one.
 */
export function isUserOnline(userId: string): boolean {
  return (onlineSockets.get(userId)?.size ?? 0) > 0;
}

/** Distinct authenticated users connected right now. */
export function getOnlineCount(): number {
  return onlineSockets.size;
}

/**
 * A socket of `user` joined the global chat. Returns true when the visible list changed
 * (first socket of that user, or their name/avatar/role changed since).
 */
export function joinChatPresence(socketId: string, user: ChatPresenceUser): boolean {
  const entry = chatMembers.get(user.id);
  const identity: ChatPresenceUser = {
    id: user.id,
    username: user.username,
    activeAvatarId: user.activeAvatarId ?? null,
    role: user.role,
  };
  if (!entry) {
    chatMembers.set(user.id, { sockets: new Set([socketId]), user: identity });
    return true;
  }
  entry.sockets.add(socketId);
  const changed =
    entry.user.username !== identity.username ||
    entry.user.activeAvatarId !== identity.activeAvatarId ||
    entry.user.role !== identity.role;
  if (changed) entry.user = identity;
  return changed;
}

/** A socket of `userId` left the global chat (or disconnected). Returns true when the user left the list. */
export function leaveChatPresence(userId: string, socketId: string): boolean {
  const entry = chatMembers.get(userId);
  if (!entry || !entry.sockets.delete(socketId)) return false;
  if (entry.sockets.size > 0) return false;
  chatMembers.delete(userId);
  return true;
}

/** The global chat's users, by username (case-insensitive). */
export function getChatPresence(): ChatPresencePayload {
  const users = [...chatMembers.values()]
    .map((entry) => entry.user)
    .sort((a, b) => a.username.localeCompare(b.username, "es", { sensitivity: "base" }));
  return { users: users.slice(0, CHAT_PRESENCE_LIMIT), count: users.length };
}

/** Tests only: forget every connection. */
export function resetPresence(): void {
  onlineSockets.clear();
  chatMembers.clear();
}
