import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  ACCOUNT_STATE_TTL_MS,
  accountBlockReason,
  clearAccountStateCache,
  getAccountState,
  invalidateAccountState,
} from "../src/lib/account-state.js";
import { createUser } from "./helpers.js";

beforeEach(() => clearAccountStateCache());
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
});

describe("account state cache", () => {
  it("hits the DB once per user per TTL window, also for concurrent lookups", async () => {
    const user = await createUser();
    // Same in-flight/cached lookup is shared (spying on Prisma's proxied delegates is unreliable)
    const lookups = Array.from({ length: 20 }, () => getAccountState(user.id));
    expect(new Set(lookups).size).toBe(1);
    expect(getAccountState(user.id)).toBe(lookups[0]);
    expect(await lookups[0]).toMatchObject({ tokenVersion: 0, status: "active", role: "user" });
  });

  it("re-reads after invalidation and after the TTL", async () => {
    const user = await createUser();
    await getAccountState(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { status: "banned" } });
    expect((await getAccountState(user.id))?.status).toBe("active"); // cached
    invalidateAccountState(user.id);
    expect((await getAccountState(user.id))?.status).toBe("banned");

    await prisma.user.update({ where: { id: user.id }, data: { status: "active" } });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + ACCOUNT_STATE_TTL_MS + 1);
    expect((await getAccountState(user.id))?.status).toBe("active");
  });

  it("returns null for a deleted user", async () => {
    const user = await createUser();
    await prisma.user.delete({ where: { id: user.id } });
    expect(await getAccountState(user.id)).toBeNull();
  });

  it("block reasons: deleted, banned, active suspension; expired suspension is fine", () => {
    const base = { tokenVersion: 0, role: "user" as const, suspendedUntil: null };
    expect(accountBlockReason(null)).toMatch(/no encontrado/);
    expect(accountBlockReason({ ...base, status: "banned" })).toMatch(/deshabilitada/);
    expect(accountBlockReason({ ...base, status: "suspended", suspendedUntil: new Date(Date.now() + 60_000) })).toMatch(/suspendida/);
    expect(accountBlockReason({ ...base, status: "suspended", suspendedUntil: new Date(Date.now() - 60_000) })).toBeNull();
    expect(accountBlockReason({ ...base, status: "active" })).toBeNull();
  });
});
