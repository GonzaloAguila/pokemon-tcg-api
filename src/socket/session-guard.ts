/**
 * Session freshness for sockets. The handshake JWT is only verified on connect, so events
 * that matter (game actions, room create/join, drafts, chat) re-check the account through
 * the cached account state: deleted, banned or suspended users are rejected and all their
 * sockets disconnected.
 *
 * The access token's own expiry is deliberately NOT re-checked: the frontend keeps a game
 * socket open past the 15-minute token lifetime, and expiry alone must not kick a player.
 */
import type { Socket } from "socket.io";
import type { TokenPayload } from "../lib/jwt.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { accountBlockReason, getAccountState } from "../lib/account-state.js";
import { userRoom } from "./io-registry.js";

export type SessionCheck =
  | { ok: true; userId: string }
  | { ok: false; error: string; blocked: boolean };

/**
 * Handshake: verify the token and that it hasn't been revoked (tokenVersion) and the account
 * can play. Returns the payload to attach to socket.data.user, or null (anonymous socket).
 */
export async function authenticateHandshake(token: unknown): Promise<TokenPayload | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const payload = verifyAccessToken(token);
  if (!payload) return null;
  try {
    const state = await getAccountState(payload.userId);
    if (!state || state.tokenVersion !== payload.tokenVersion || accountBlockReason(state)) return null;
    return { ...payload, role: state.role };
  } catch (err) {
    console.error("[socket auth] account lookup failed:", err);
    return null;
  }
}

/** Check the socket's user is authenticated and still allowed to play. */
export async function checkSocketSession(socket: Socket): Promise<SessionCheck> {
  const userId = (socket.data.user as TokenPayload | undefined)?.userId;
  if (!userId) return { ok: false, error: "Autenticacion requerida", blocked: false };
  try {
    const reason = accountBlockReason(await getAccountState(userId));
    if (reason) return { ok: false, error: reason, blocked: true };
  } catch (err) {
    console.error("[socket session] account lookup failed:", err);
    return { ok: false, error: "No se pudo verificar la sesion", blocked: false };
  }
  return { ok: true, userId };
}

/**
 * Disconnect every socket of a blocked user. Call after emitting the error to the caller;
 * engine.io flushes queued packets before closing the transport.
 */
export function kickBlockedUser(socket: Socket): void {
  const userId = (socket.data.user as TokenPayload | undefined)?.userId;
  if (userId) socket.nsp.in(userRoom(userId)).disconnectSockets(true);
  socket.disconnect(true);
}

/**
 * Convenience for handlers that report errors as `{ message }` on an event ("error" or
 * "draft:error"). Returns the userId, or null after emitting the error (and kicking if blocked).
 */
export async function requireSocketUser(socket: Socket, errorEvent: string): Promise<string | null> {
  const check = await checkSocketSession(socket);
  if (check.ok) return check.userId;
  socket.emit(errorEvent, { message: check.error });
  if (check.blocked) kickBlockedUser(socket);
  return null;
}
