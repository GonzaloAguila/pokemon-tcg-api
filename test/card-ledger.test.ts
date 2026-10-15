/**
 * Card history (card_transactions): every write to user_cards records its event in the same
 * transaction — packs, shop, trades (both sides, and their revert), admin adjustments.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ALL_CARDS } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { openPackForUser } from "../src/modules/boosters/boosters.service.js";
import { buyEnergy, getDailyOffers } from "../src/modules/market/market.service.js";
import { adjustCards } from "../src/modules/admin/admin.service.js";
import * as trades from "../src/modules/trades/trades.service.js";
import { adminRouter } from "../src/modules/admin/admin.controller.js";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const history = (userId: string) =>
  prisma.cardTransaction.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

const pokemonOf = (rarity: string) => ALL_CARDS.find((c) => c.kind === "pokemon" && c.rarity === rarity)!.id;
const RARE = pokemonOf("rare");
const HOLO = pokemonOf("rare-holo");

describe("every write to user_cards records the change", () => {
  it("no source file changes user_cards without calling recordCardChange", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(path.resolve(__dirname, "../src"));
    const writes = /\.userCard\.(create|createMany|upsert|update|updateMany|delete|deleteMany)\(/;
    const unlogged = files.filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return writes.test(source) && !source.includes("recordCardChange");
    });
    expect(unlogged).toEqual([]);
  });
});

describe("card history", () => {
  it("a pack writes one row with its 11 cards", async () => {
    const user = await createUser();
    const pack = await prisma.$transaction((tx) =>
      openPackForUser(tx, user.id, "base-set-booster", { reason: "pack_purchase", label: "Sobre comprado" }),
    );
    const rows = await history(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "pack_purchase", description: "Sobre comprado: Base Set", refId: "base-set-booster" });
    const cards = rows[0].cards as { cardDefId: string; quantity: number }[];
    expect(cards.reduce((n, c) => n + c.quantity, 0)).toBe(pack.cards.length);
  });

  it("buying Energy records the copies bought", async () => {
    const user = await createUser({ coins: 10_000 });
    const offer = (await getDailyOffers()).energyOffers[0];
    await buyEnergy(user.id, offer.energyType, 3);
    const rows = await history(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("energy_purchase");
    expect(rows[0].cards).toEqual([{ cardDefId: offer.cardDefId, quantity: 3 }]);
  });

  it("an admin removal records only the copies the player had", async () => {
    const admin = await createUser({}, { role: "admin" });
    const user = await createUser();
    await prisma.userCard.create({ data: { userId: user.id, cardDefId: RARE, quantity: 2 } });
    await adjustCards(user.id, [{ cardDefId: RARE, quantity: -5 }, { cardDefId: HOLO, quantity: 1 }], admin.id);
    const rows = await history(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "admin_adjustment", refId: admin.id });
    expect(rows[0].cards).toEqual([{ cardDefId: RARE, quantity: -2 }, { cardDefId: HOLO, quantity: 1 }]);
  });

  it("a trade records what each player gave and received, and its revert the opposite", async () => {
    const trader = async (cards: Record<string, number>) => {
      const user = await createUser({ coins: 500 }, { stats: true });
      await prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
      await prisma.userStats.update({ where: { userId: user.id }, data: { normalWins: 20 } });
      for (const [cardDefId, quantity] of Object.entries(cards)) {
        await prisma.userCard.create({ data: { userId: user.id, cardDefId, quantity } });
      }
      return user;
    };
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 });
    const tradeId = await trades.executeTrade(
      { userId: a.id, cards: [{ cardDefId: HOLO, quantity: 1 }], ip: null },
      { userId: b.id, cards: [{ cardDefId: RARE, quantity: 3 }], ip: null },
    );

    const [aTrade] = await history(a.id);
    const [bTrade] = await history(b.id);
    expect(aTrade).toMatchObject({ reason: "trade", refId: tradeId, description: `Intercambio con ${b.username}` });
    expect(aTrade.cards).toEqual([{ cardDefId: HOLO, quantity: -1 }, { cardDefId: RARE, quantity: 3 }]);
    expect(bTrade.cards).toEqual([{ cardDefId: RARE, quantity: -3 }, { cardDefId: HOLO, quantity: 1 }]);

    const admin = await createUser({}, { role: "admin" });
    await trades.revertTrade(admin.id, tradeId);
    const aRevert = (await history(a.id))[1];
    expect(aRevert).toMatchObject({ reason: "trade_revert", refId: tradeId });
    expect(aRevert.cards).toEqual([{ cardDefId: RARE, quantity: -3 }, { cardDefId: HOLO, quantity: 1 }]);
  });
});

describe("GET /admin/users/:userId/card-history", () => {
  it("pages the history newest first, for admins with users:view only", async () => {
    const http = await startHttpApp((app) => app.use("/api", adminRouter));
    try {
      const user = await createUser({ coins: 10_000 });
      const offer = (await getDailyOffers()).energyOffers[0];
      await buyEnergy(user.id, offer.energyType, 1);
      await buyEnergy(user.id, offer.energyType, 2);

      const viewer = await createUser({}, { role: "admin", permissions: ["users:view"] });
      const res = await http.request("GET", `/api/admin/users/${user.id}/card-history?limit=1`, { token: tokenFor(viewer) });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 2, page: 1, limit: 1 });
      expect(res.body.data[0].cards).toEqual([{ cardDefId: offer.cardDefId, quantity: 2 }]);

      const player = await createUser();
      const denied = await http.request("GET", `/api/admin/users/${user.id}/card-history`, { token: tokenFor(player) });
      expect(denied.status).toBe(403);
    } finally {
      await http.close();
    }
  });
});
