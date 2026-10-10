import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { adminRouter } from "../src/modules/admin/admin.controller.js";
import { createUser, getBalances } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;
let token: string;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", adminRouter));
  const admin = await createUser();
  const superadmin = await prisma.user.update({ where: { id: admin.id }, data: { role: "superadmin" } });
  token = tokenFor(superadmin);
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

const post = (path: string, body: unknown) => http.request("POST", path, { token, body });
const patch = (path: string, body: unknown) => http.request("PATCH", path, { token, body });

describe("admin economy bodies", () => {
  it("adjust-coins accepts what the admin panel sends (signed integer + reason)", async () => {
    const user = await createUser({ coins: 100 });
    expect((await post(`/api/admin/users/${user.id}/adjust-coins`, { amount: 50, reason: "premio" })).status).toBe(200);
    expect((await post(`/api/admin/users/${user.id}/adjust-coins`, { amount: -30, reason: "correccion" })).status).toBe(200);
    expect((await getBalances(user.id)).coins).toBe(120);
  });

  it.each([
    [{ amount: "50", reason: "x" }],
    [{ amount: 1.5, reason: "x" }],
    [{ amount: 0, reason: "x" }],
    [{ amount: 1e12, reason: "x" }],
    [{ amount: 10 }],
    [{ amount: 10, reason: "   " }],
    [{ amount: 10, reason: "r".repeat(1000) }],
    [{ amount: 10, reason: { toString: "x" } }],
  ])("adjust-coins rejects %j without touching the balance", async (body) => {
    const user = await createUser({ coins: 100 });
    const res = await post(`/api/admin/users/${user.id}/adjust-coins`, body);
    expect(res.status).toBe(400);
    expect((await getBalances(user.id)).coins).toBe(100);
  });

  it("adjust-coupons and adjust-rare-candy share the same validation", async () => {
    const user = await createUser();
    expect((await post(`/api/admin/users/${user.id}/adjust-coupons`, { amount: "x", reason: "r" })).status).toBe(400);
    expect((await post(`/api/admin/users/${user.id}/adjust-rare-candy`, { amount: 2.5, reason: "r" })).status).toBe(400);
    expect((await post(`/api/admin/users/${user.id}/adjust-coupons`, { amount: 5, reason: "r" })).status).toBe(200);
  });
});

describe("admin collection / stats / cosmetics bodies", () => {
  it("adjust-cards validates the card list", async () => {
    const user = await createUser();
    const url = `/api/admin/users/${user.id}/adjust-cards`;
    expect((await post(url, { cards: [{ cardDefId: "base-set-058-pikachu", quantity: 2 }] })).status).toBe(200);
    expect((await post(url, { cards: "base-set-058-pikachu" })).status).toBe(400);
    expect((await post(url, { cards: [] })).status).toBe(400);
    expect((await post(url, { cards: [{ cardDefId: "base-set-058-pikachu", quantity: "2" }] })).status).toBe(400);
    expect((await post(url, { cards: [{ cardDefId: "base-set-058-pikachu", quantity: 0 }] })).status).toBe(400);
    expect((await post(url, { cards: Array(1000).fill({ cardDefId: "base-set-058-pikachu", quantity: 1 }) })).status).toBe(400);
    const owned = await prisma.userCard.findUnique({ where: { userId_cardDefId: { userId: user.id, cardDefId: "base-set-058-pikachu" } } });
    expect(owned?.quantity).toBe(2);
  });

  it("adjust-stats only takes known fields and integer amounts", async () => {
    const user = await createUser();
    const url = `/api/admin/users/${user.id}/adjust-stats`;
    expect((await post(url, { field: "normalWins", amount: 3 })).status).toBe(200);
    expect((await post(url, { field: "coins", amount: 3 })).status).toBe(400);
    expect((await post(url, { field: "normalWins", amount: "3" })).status).toBe(400);
  });

  it("grant-cosmetic checks type and itemId", async () => {
    const user = await createUser();
    const url = `/api/admin/users/${user.id}/grant-cosmetic`;
    expect((await post(url, { type: "spaceship", itemId: "x" })).status).toBe(400);
    expect((await post(url, { type: "coin", itemId: "" })).status).toBe(400);
    expect((await post(url, { type: "coin", itemId: ["a"] })).status).toBe(400);
  });
});

describe("admin moderation bodies", () => {
  it("ban needs a boolean and a short optional reason", async () => {
    const user = await createUser();
    const url = `/api/admin/users/${user.id}/ban`;
    expect((await patch(url, { banned: "true" })).status).toBe(422);
    expect((await patch(url, { banned: true, reason: "r".repeat(2000) })).status).toBe(422);
    expect((await patch(url, { banned: true })).status).toBe(200);
    expect((await patch(url, { banned: false, reason: undefined })).status).toBe(200);
  });

  it("suspend needs integer hours between 1 and 8760", async () => {
    const user = await createUser();
    const url = `/api/admin/users/${user.id}/suspend`;
    for (const hours of [0, -5, 8761, "24", 1.5, null]) {
      const res = await post(url, { hours });
      expect(res.status, `hours=${hours}`).toBe(422);
    }
    expect((await post(url, { hours: 48, reason: "spam" })).status).toBe(200);
  });

  it("role only accepts user/admin", async () => {
    const user = await createUser();
    const url = `/api/admin/users/${user.id}/role`;
    expect((await patch(url, { role: "superadmin" })).status).toBe(400);
    expect((await patch(url, { role: "admin" })).status).toBe(200);
  });
});
