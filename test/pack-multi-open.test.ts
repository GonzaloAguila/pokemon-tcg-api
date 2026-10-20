/**
 * POST /api/packs/:packId/open { quantity }: several packs, one charge (all or nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import { getPackById, STANDARD_BOOSTER_IDS } from "../src/modules/boosters/boosters.service.js";
import { createUser, getBalances } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

const packId = STANDARD_BOOSTER_IDS[0];
const price = getPackById(packId)!.price!;
let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", boostersRouter));
});
afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

const open = (token: string, body?: unknown) => http.request("POST", `/api/packs/${packId}/open`, { token, body });

describe("opening several packs at once", () => {
  it("charges price × quantity once and gives every pack, first pack's fields kept at the top", async () => {
    const user = await createUser({ coins: price * 3 + 7 });
    const res = await open(tokenFor(user), { quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body.packs).toHaveLength(3);
    for (const p of res.body.packs) {
      expect(p.packId).toBe(packId);
      expect(p.cards).toHaveLength(11);
    }
    expect(res.body.packId).toBe(packId);
    expect(res.body.cards).toEqual(res.body.packs[0].cards);
    expect((await getBalances(user.id)).coins).toBe(7);

    const tx = await prisma.transaction.findMany({ where: { userId: user.id, type: "pack_purchase" } });
    expect(tx).toHaveLength(1);
    expect(tx[0].amount).toBe(-price * 3);

    const owned = await prisma.userCard.aggregate({ where: { userId: user.id }, _sum: { quantity: true } });
    expect(owned._sum.quantity).toBe(33);
    expect(await prisma.cardTransaction.count({ where: { userId: user.id, reason: "pack_purchase" } })).toBe(3);
  });

  it("without a body opens one pack (backward compatible) and still returns packs", async () => {
    const user = await createUser({ coins: price });
    const res = await open(tokenFor(user));
    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(11);
    expect(res.body.packs).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(0);
  });

  it("not enough coins for all of them: 400, nothing charged, no cards", async () => {
    const user = await createUser({ coins: price * 2 });
    const res = await open(tokenFor(user), { quantity: 3 });
    expect(res.status).toBe(400);
    expect((await getBalances(user.id)).coins).toBe(price * 2);
    expect(await prisma.userCard.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
  });

  it("rejects quantities outside 1-10 or not integers", async () => {
    const user = await createUser({ coins: price * 20 });
    for (const quantity of [0, 11, -1, 1.5, "2"]) {
      const res = await open(tokenFor(user), { quantity });
      expect(res.status).toBe(400);
    }
    expect((await getBalances(user.id)).coins).toBe(price * 20);
  });
});
