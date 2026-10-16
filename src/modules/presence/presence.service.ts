import { prisma } from "../../lib/prisma.js";
import { getOnlineCount } from "../../socket/presence.js";

/** How long the registered-accounts count is reused before asking the DB again. */
export const REGISTERED_COUNT_TTL_MS = 60_000;

let registeredCache: { value: Promise<number>; expiresAt: number } | null = null;

/** Accounts that can log in: every user row (deleted users are removed) except banned ones. */
export function getRegisteredCount(now: number = Date.now()): Promise<number> {
  if (registeredCache && registeredCache.expiresAt > now) return registeredCache.value;
  const value = prisma.user.count({ where: { status: { not: "banned" } } });
  const entry = { value, expiresAt: now + REGISTERED_COUNT_TTL_MS };
  registeredCache = entry;
  // Never keep a failed count
  value.catch(() => {
    if (registeredCache === entry) registeredCache = null;
  });
  return value;
}

/** Tests only. */
export function clearRegisteredCountCache(): void {
  registeredCache = null;
}

export interface PresenceSummary {
  /** Distinct authenticated users with a live socket right now */
  online: number;
  /** Accounts that can log in (not banned), cached for REGISTERED_COUNT_TTL_MS */
  registered: number;
}

export async function getPresenceSummary(): Promise<PresenceSummary> {
  return { online: getOnlineCount(), registered: await getRegisteredCount() };
}
