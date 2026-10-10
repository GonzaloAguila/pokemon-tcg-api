import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";

export async function createUser(balances: { coins?: number; coupons?: number; rareCandy?: number } = {}) {
  const tag = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      email: `test-${tag}@example.com`,
      username: `test_${tag}`,
      coins: balances.coins ?? 0,
      coupons: balances.coupons ?? 0,
      rareCandy: balances.rareCandy ?? 0,
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
