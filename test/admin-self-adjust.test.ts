/**
 * Owner decision 2026-10-20: the superadmin may adjust their own account (balances, cards,
 * stats, cosmetics), with the normal ledgers and no notice to themselves; an admin still can't
 * act on themselves, and nobody bans/suspends/re-roles/deletes their own account.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { adminRouter } from "../src/modules/admin/admin.controller.js";
import { createUser } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;
const ALL_USER_PERMS = ["users:view", "users:moderate", "users:economy", "users:cards", "users:stats", "users:delete"];

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", adminRouter));
});
afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

const post = (token: string, path: string, body: unknown) => http.request("POST", path, { token, body });

describe("self adjustments", () => {
  it("the superadmin adjusts their own coins, cards and stats, recorded in the ledgers, no notice to self", async () => {
    const su = await createUser({ coins: 100 }, { role: "superadmin" });
    const token = tokenFor(su);
    const base = `/api/admin/users/${su.id}`;

    const coins = await post(token, `${base}/adjust-coins`, { amount: 50, reason: "pruebas" });
    expect(coins.status).toBe(200);
    expect(coins.body.coins).toBe(150);
    const tx = await prisma.transaction.findMany({ where: { userId: su.id, type: "admin_adjustment" } });
    expect(tx).toMatchObject([{ amount: 50, balanceAfter: 150, currency: "coins" }]);

    expect((await post(token, `${base}/adjust-coupons`, { amount: 3, reason: "pruebas" })).status).toBe(200);
    expect((await post(token, `${base}/adjust-rare-candy`, { amount: 1, reason: "pruebas" })).status).toBe(200);

    const cards = await post(token, `${base}/adjust-cards`, { cards: [{ cardDefId: "base-set-058-pikachu", quantity: 2 }] });
    expect(cards.status).toBe(200);
    expect((await prisma.userCard.findFirstOrThrow({ where: { userId: su.id, cardDefId: "base-set-058-pikachu" } })).quantity).toBe(2);
    const ledger = await prisma.cardTransaction.findMany({ where: { userId: su.id, reason: "admin_adjustment" } });
    expect(ledger).toMatchObject([{ refId: su.id, cards: [{ cardDefId: "base-set-058-pikachu", quantity: 2 }] }]);

    expect((await post(token, `${base}/adjust-stats`, { field: "normalWins", amount: 1 })).status).toBe(200);
    expect(await prisma.systemMessage.count({ where: { recipientId: su.id } })).toBe(0);
  });

  it("an admin can't adjust themselves (403, nothing changes)", async () => {
    const admin = await createUser({ coins: 100 }, { role: "admin", permissions: ALL_USER_PERMS });
    const token = tokenFor(admin);
    const base = `/api/admin/users/${admin.id}`;
    for (const [path, body] of [
      ["adjust-coins", { amount: 50, reason: "x" }],
      ["adjust-coupons", { amount: 5, reason: "x" }],
      ["adjust-rare-candy", { amount: 1, reason: "x" }],
      ["adjust-cards", { cards: [{ cardDefId: "base-set-058-pikachu", quantity: 1 }] }],
      ["adjust-stats", { field: "normalWins", amount: 1 }],
      ["grant-cosmetic", { type: "coin", itemId: "charizard" }],
    ] as const) {
      const res = await post(token, `${base}/${path}`, body);
      expect(res.status, path).toBe(403);
      expect(res.body.error.message).toBe("No puedes realizar esta acción sobre tu propia cuenta");
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).coins).toBe(100);
    expect(await prisma.userCard.count({ where: { userId: admin.id } })).toBe(0);
  });

  it("the superadmin still can't ban, suspend, re-role or delete themselves, nor adjust another superadmin", async () => {
    const su = await createUser({}, { role: "superadmin" });
    const token = tokenFor(su);
    const base = `/api/admin/users/${su.id}`;
    expect((await http.request("PATCH", `${base}/ban`, { token, body: { banned: true } })).status).toBe(403);
    expect((await post(token, `${base}/suspend`, { hours: 1 })).status).toBe(403);
    expect((await http.request("PATCH", `${base}/role`, { token, body: { role: "user" } })).status).toBe(403);
    expect((await http.request("DELETE", base, { token })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: su.id } })).status).toBe("active");

    const other = await createUser({}, { role: "superadmin" });
    expect((await post(token, `/api/admin/users/${other.id}/adjust-coins`, { amount: 5, reason: "x" })).status).toBe(403);
  });
});
