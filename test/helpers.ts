import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";

/**
 * A test account. Verified email by default (economy routes require it); `stats` creates the
 * UserStats row that match results update.
 */
export async function createUser(
  balances: { coins?: number; coupons?: number; rareCandy?: number } = {},
  options: {
    emailVerified?: boolean;
    stats?: boolean;
    role?: "user" | "admin" | "superadmin";
    provider?: "local" | "google" | "discord";
    permissions?: string[];
  } = {},
) {
  const tag = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      email: `test-${tag}@example.com`,
      username: `test_${tag}`,
      coins: balances.coins ?? 0,
      coupons: balances.coupons ?? 0,
      rareCandy: balances.rareCandy ?? 0,
      emailVerified: options.emailVerified ?? true,
      role: options.role ?? "user",
      provider: options.provider ?? "local",
      ...(options.permissions ? { permissions: options.permissions } : {}),
      ...(options.stats ? { stats: { create: {} } } : {}),
    },
  });
}

export async function getBalances(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { coins: true, coupons: true, rareCandy: true },
  });
}

/** Fire `count` calls at once and report how many resolved vs rejected. */
export async function race<T>(count: number, fn: () => Promise<T>) {
  const results = await Promise.allSettled(Array.from({ length: count }, fn));
  return {
    fulfilled: results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<T>[],
    rejected: results.filter((r) => r.status === "rejected") as PromiseRejectedResult[],
  };
}
