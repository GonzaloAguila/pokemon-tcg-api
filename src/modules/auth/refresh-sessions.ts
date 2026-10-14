/**
 * Refresh sessions: one row per logged-in device with the SHA-256 of its refresh token (the
 * token itself is never stored). Logging in on another device adds a session instead of
 * replacing the previous one; logout ends only its own; anything that bumps tokenVersion
 * (ban, suspension, password change or reset) ends them all.
 */
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import { generateRefreshToken, type TokenPayload } from "../../lib/jwt.js";
import type { Db } from "../users/users.service.js";

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new refresh token for this device, stored as a session (expired sessions are pruned). */
export async function startRefreshSession(payload: TokenPayload, db: Db = prisma): Promise<string> {
  const token = generateRefreshToken(payload);
  const { exp } = jwt.decode(token) as { exp: number };
  await db.refreshSession.deleteMany({ where: { userId: payload.userId, expiresAt: { lt: new Date() } } });
  await db.refreshSession.create({
    data: { userId: payload.userId, tokenHash: hashRefreshToken(token), expiresAt: new Date(exp * 1000) },
  });
  return token;
}

/** Whether `token` is a live session of `userId`; marks it used. */
export async function useRefreshSession(userId: string, token: string): Promise<boolean> {
  const { count } = await prisma.refreshSession.updateMany({
    where: { userId, tokenHash: hashRefreshToken(token), expiresAt: { gt: new Date() } },
    data: { lastUsedAt: new Date() },
  });
  return count > 0;
}

/** Logout of one device. */
export async function endRefreshSession(token: string): Promise<void> {
  await prisma.refreshSession.deleteMany({ where: { tokenHash: hashRefreshToken(token) } });
}

/** Every device of the user (with a tokenVersion bump). */
export async function endAllRefreshSessions(userId: string, db: Db = prisma): Promise<void> {
  await db.refreshSession.deleteMany({ where: { userId } });
}
