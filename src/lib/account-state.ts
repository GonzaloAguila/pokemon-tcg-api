/**
 * Short-lived cache of the account fields that decide whether a session is still allowed:
 * tokenVersion (bumped on ban/suspension to revoke tokens), role, status and suspension.
 *
 * Used by HTTP requireAuth (tokenVersion + status on every request) and by the socket
 * session guard (status on game actions, room joins, drafts and chat) without a DB hit per
 * request. Admin moderation calls invalidateAccountState() so its changes apply at once in
 * this (single) process; the TTL only bounds staleness for changes made outside the app.
 */
import type { UserRole } from "@prisma/client";
import { prisma } from "./prisma.js";

export interface AccountState {
  tokenVersion: number;
  role: UserRole;
  status: string;
  suspendedUntil: Date | null;
}

export const ACCOUNT_STATE_TTL_MS = 15_000;
const SWEEP_THRESHOLD = 5_000;

const cache = new Map<string, { expiresAt: number; value: Promise<AccountState | null> }>();

function sweepExpired(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

/** Account state for `userId` (null if the user doesn't exist), cached for ACCOUNT_STATE_TTL_MS. */
export function getAccountState(userId: string): Promise<AccountState | null> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;

  if (cache.size >= SWEEP_THRESHOLD) sweepExpired(now);

  const value = prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true, role: true, status: true, suspendedUntil: true },
  });
  const entry = { expiresAt: now + ACCOUNT_STATE_TTL_MS, value };
  cache.set(userId, entry);
  // Never cache a failed lookup
  value.catch(() => {
    if (cache.get(userId) === entry) cache.delete(userId);
  });
  return value;
}

export function invalidateAccountState(userId: string): void {
  cache.delete(userId);
}

export function clearAccountStateCache(): void {
  cache.clear();
}

/**
 * Spanish reason when the account can't use the app (deleted, banned, actively suspended),
 * or null when it can. An expired suspension doesn't block.
 */
export function accountBlockReason(state: AccountState | null, now: Date = new Date()): string | null {
  if (!state) return "Usuario no encontrado";
  if (state.status === "banned") return "Tu cuenta ha sido deshabilitada";
  if (state.status === "suspended" && state.suspendedUntil && state.suspendedUntil > now) {
    return "Tu cuenta esta suspendida";
  }
  return null;
}
