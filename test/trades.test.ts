/**
 * Card trades: eligibility, validation (duplicates only, no gifts, balanced, no basic Energy),
 * the atomic accept (re-checks ownership, one accept wins, fees, locks), limits, expiry,
 * deck warnings and the backoffice revert.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { ALL_CARDS, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import * as trades from "../src/modules/trades/trades.service.js";
import { tradesRouter } from "../src/modules/trades/index.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const pokemonOf = (rarity: string, skip = 0) =>
  ALL_CARDS.filter((c) => c.kind === "pokemon" && c.rarity === rarity)[skip].id;
const COMMON = pokemonOf("common");
const COMMON_2 = pokemonOf("common", 1);
const UNCOMMON = pokemonOf("uncommon");
const RARE = pokemonOf("rare");
const HOLO = pokemonOf("rare-holo");
const BASIC_ENERGY = ALL_CARDS.find((c) => isBasicEnergy(c))!.id;

/** An account that can trade (verified, 10 days old, 20 online games) with these cards. */
async function trader(cards: Record<string, number>, coins = 500, options: { ageDays?: number; games?: number } = {}) {
  const user = await createUser({ coins }, { stats: true });
  await prisma.user.update({
    where: { id: user.id },
    data: { createdAt: new Date(Date.now() - (options.ageDays ?? 10) * 86_400_000) },
  });
  await prisma.userStats.update({ where: { userId: user.id }, data: { normalWins: options.games ?? 20 } });
  for (const [cardDefId, quantity] of Object.entries(cards)) {
    await prisma.userCard.create({ data: { userId: user.id, cardDefId, quantity } });
  }
  return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
}

const qty = async (userId: string, cardDefId: string) =>
  (await prisma.userCard.findUnique({ where: { userId_cardDefId: { userId, cardDefId } } }))?.quantity ?? 0;

describe("eligibility", () => {
  it("needs a verified email, 7 days of account and 20 online games", async () => {
    const ok = await trader({});
    expect(await trades.tradeIneligibilityReason(ok.id)).toBeNull();
    expect(await trades.tradeIneligibilityReason((await trader({}, 0, { ageDays: 2 })).id)).toMatch(/7 días/);
    expect(await trades.tradeIneligibilityReason((await trader({}, 0, { games: 5 })).id)).toMatch(/20 partidas online.*llevas 5/);
    const unverified = await trader({});
    await prisma.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
    expect(await trades.tradeIneligibilityReason(unverified.id)).toMatch(/verificar tu email/);
  });
});

describe("proposals", () => {
  it("rejects gifts, lopsided trades, basic Energy, non-duplicates, too many cards and yourself", async () => {
    const a = await trader({ [RARE]: 2, [COMMON]: 9, [BASIC_ENERGY]: 5, [HOLO]: 1 });
    const b = await trader({ [UNCOMMON]: 4, [RARE]: 3 });
    const propose = (offered: { cardDefId: string; quantity: number }[], requested: { cardDefId: string; quantity: number }[], to = b.username) =>
      trades.createTrade(a.id, { toUsername: to, offered, requested }, null);

    await expect(propose([{ cardDefId: RARE, quantity: 1 }], [])).rejects.toThrow("Elige al menos una carta para pedir");
    await expect(propose([{ cardDefId: COMMON, quantity: 1 }], [{ cardDefId: RARE, quantity: 1 }])).rejects.toThrow("muy desparejo");
    await expect(propose([{ cardDefId: BASIC_ENERGY, quantity: 1 }], [{ cardDefId: UNCOMMON, quantity: 1 }])).rejects.toThrow("no se puede intercambiar");
    await expect(propose([{ cardDefId: HOLO, quantity: 1 }], [{ cardDefId: RARE, quantity: 2 }])).rejects.toThrow("copias repetidas");
    await expect(propose([{ cardDefId: COMMON, quantity: 6 }], [{ cardDefId: UNCOMMON, quantity: 2 }])).rejects.toThrow("Máximo 5 cartas");
    await expect(propose([{ cardDefId: RARE, quantity: 1 }], [{ cardDefId: RARE, quantity: 1 }], a.username)).rejects.toThrow("contigo mismo");
    // b has only 4 uncommons: 3 can be given, 1 is kept
    await expect(propose([{ cardDefId: RARE, quantity: 1 }, { cardDefId: COMMON, quantity: 4 }], [{ cardDefId: UNCOMMON, quantity: 4 }])).rejects.toThrow(
      "no puede darte eso",
    );

    // 1 rare (8) for 3 uncommons (9): balanced
    const trade = await propose([{ cardDefId: RARE, quantity: 1 }], [{ cardDefId: UNCOMMON, quantity: 3 }]);
    expect(trade).toMatchObject({ status: "pending", offeredValue: 8, requestedValue: 9, fee: ECONOMY.trades.feeCoins });
    const message = await prisma.systemMessage.findFirst({ where: { recipientId: b.id, category: "trade" } });
    expect(message?.metadata).toEqual({ tradeId: trade.id });
  });
});

describe("accepting", () => {
  it("moves the cards (each keeps 1), charges both fees, locks the received copies and notifies", async () => {
    const a = await trader({ [RARE]: 3 });
    const b = await trader({ [UNCOMMON]: 4, [COMMON_2]: 1 });
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, "1.1.1.1");
    const done = await trades.acceptTrade(b.id, trade.id, "2.2.2.2");
    expect(done.status).toBe("completed");

    expect([await qty(a.id, RARE), await qty(a.id, UNCOMMON)]).toEqual([2, 3]);
    expect([await qty(b.id, RARE), await qty(b.id, UNCOMMON)]).toEqual([1, 1]);
    expect((await getBalances(a.id)).coins).toBe(500 - ECONOMY.trades.feeCoins);
    expect((await getBalances(b.id)).coins).toBe(500 - ECONOMY.trades.feeCoins);

    // The 3 uncommons a received are locked: a can't trade them on yet (owned 3 - 1 kept - 3 locked)
    const tradable = new Map((await trades.getTradableCards(a.id)).map((c) => [c.cardDefId, c]));
    expect(tradable.get(UNCOMMON)).toMatchObject({ owned: 3, locked: 3, tradable: 0 });
    expect(await prisma.systemMessage.count({ where: { recipientId: a.id, category: "trade" } })).toBe(1);

    // Accepting again does nothing
    await expect(trades.acceptTrade(b.id, trade.id, null)).rejects.toThrow("ya no está pendiente");
  });

  it("five accepts at once: one trade, cards moved once", async () => {
    const a = await trader({ [RARE]: 2 });
    const b = await trader({ [UNCOMMON]: 4 });
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, null);
    const { fulfilled } = await race(5, () => trades.acceptTrade(b.id, trade.id, null));
    expect(fulfilled).toHaveLength(1);
    expect([await qty(a.id, RARE), await qty(a.id, UNCOMMON), await qty(b.id, RARE), await qty(b.id, UNCOMMON)]).toEqual([1, 3, 1, 1]);
    expect((await getBalances(b.id)).coins).toBe(500 - ECONOMY.trades.feeCoins);
  });

  it("re-checks what each one owns now: if the cards are gone nothing moves and the proposal stays pending", async () => {
    const a = await trader({ [RARE]: 2 });
    const b = await trader({ [UNCOMMON]: 4 });
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, null);
    await prisma.userCard.update({ where: { userId_cardDefId: { userId: a.id, cardDefId: RARE } }, data: { quantity: 1 } });
    await expect(trades.acceptTrade(b.id, trade.id, null)).rejects.toThrow("ya no tiene lo que ofreció");
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: trade.id } })).status).toBe("pending");
    expect(await qty(b.id, UNCOMMON)).toBe(4);
    expect((await getBalances(b.id)).coins).toBe(500);
  });

  it("without coins for the fee nothing happens", async () => {
    const a = await trader({ [RARE]: 2 });
    const b = await trader({ [UNCOMMON]: 4 }, 10);
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, null);
    await expect(trades.acceptTrade(b.id, trade.id, null)).rejects.toThrow("monedas para la comisión");
    expect(await qty(a.id, RARE)).toBe(2);
    expect((await getBalances(a.id)).coins).toBe(500);
  });

  it("one trade a day with the same player; same connection is allowed but flagged", async () => {
    const a = await trader({ [RARE]: 5 });
    const b = await trader({ [UNCOMMON]: 9 });
    const offer = { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] };
    const first = await trades.createTrade(a.id, offer, "9.9.9.9");
    const second = await trades.createTrade(a.id, offer, "9.9.9.9");
    await trades.acceptTrade(b.id, first.id, "9.9.9.9");
    expect((await prisma.trade.findUniqueOrThrow({ where: { id: first.id } })).flags).toEqual(["same_ip"]);
    await expect(trades.acceptTrade(b.id, second.id, null)).rejects.toThrow("Ya intercambiaron hoy");
    await expect(trades.createTrade(a.id, offer, null)).rejects.toThrow("Ya intercambiaron hoy");
  });

  it("an expired proposal can't be accepted and shows as expired", async () => {
    const a = await trader({ [RARE]: 2 });
    const b = await trader({ [UNCOMMON]: 4 });
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, null);
    await prisma.trade.update({ where: { id: trade.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(trades.acceptTrade(b.id, trade.id, null)).rejects.toThrow("venció");
    const history = await trades.listTrades(b.id, "history");
    expect(history.find((t) => t.id === trade.id)?.status).toBe("expired");
  });

  it("warns about decks left short, and marks them invalid after the trade", async () => {
    const a = await trader({ [RARE]: 2 });
    const b = await trader({ [UNCOMMON]: 4 });
    const deck = await prisma.deck.create({
      data: { userId: b.id, name: "Mi mazo", isValid: true, cards: [{ cardDefId: UNCOMMON, quantity: 2 }] },
    });
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, null);
    expect((await trades.getTrade(b.id, trade.id)).deckWarnings).toEqual([{ deckId: deck.id, deckName: "Mi mazo", cardDefId: UNCOMMON }]);
    await trades.acceptTrade(b.id, trade.id, null);
    expect((await prisma.deck.findUniqueOrThrow({ where: { id: deck.id } })).isValid).toBe(false);
  });
});

describe("closing and reverting", () => {
  it("the receiver rejects, the proposer cancels; others can't", async () => {
    const a = await trader({ [RARE]: 3 });
    const b = await trader({ [UNCOMMON]: 7 });
    const offer = { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] };
    const t1 = await trades.createTrade(a.id, offer, null);
    const t2 = await trades.createTrade(a.id, offer, null);
    await expect(trades.closeTrade(a.id, t1.id, "reject")).rejects.toThrow("ya no está pendiente");
    expect((await trades.closeTrade(b.id, t1.id, "reject")).status).toBe("rejected");
    expect((await trades.closeTrade(a.id, t2.id, "cancel")).status).toBe("cancelled");
    await expect(trades.getTrade((await trader({})).id, t1.id)).rejects.toThrow("no encontrado");
  });

  it("an admin reverts a completed trade: cards back, locks gone", async () => {
    const a = await trader({ [RARE]: 2 });
    const b = await trader({ [UNCOMMON]: 4 });
    const admin = await createUser({}, { role: "superadmin" });
    const trade = await trades.createTrade(a.id, { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] }, null);
    await trades.acceptTrade(b.id, trade.id, null);
    const reverted = await trades.revertTrade(admin.id, trade.id);
    expect(reverted.status).toBe("reverted");
    expect([await qty(a.id, RARE), await qty(a.id, UNCOMMON), await qty(b.id, RARE), await qty(b.id, UNCOMMON)]).toEqual([2, 0, 0, 4]);
    expect(await prisma.cardLock.count({ where: { tradeId: trade.id } })).toBe(0);
    await expect(trades.revertTrade(admin.id, trade.id)).rejects.toThrow("Solo se revierte");
  });
});

describe("HTTP", () => {
  it("propose, list, accept; the backoffice list needs users:view", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await startHttpApp((a) => a.use("/api", tradesRouter));
    try {
      const a = await trader({ [RARE]: 2 });
      const b = await trader({ [UNCOMMON]: 4 });
      const eligibility = await app.request("GET", "/api/trades/eligibility", { token: tokenFor(a) });
      expect(eligibility.body).toMatchObject({ eligible: true, config: { feeCoins: ECONOMY.trades.feeCoins } });
      const theirs = await app.request("GET", `/api/trades/tradable/${b.username}`, { token: tokenFor(a) });
      expect(theirs.body.cards).toMatchObject([{ cardDefId: UNCOMMON, tradable: 3 }]);

      const created = await app.request("POST", "/api/trades", {
        token: tokenFor(a),
        body: { toUsername: b.username, offered: [{ cardDefId: RARE, quantity: 1 }], requested: [{ cardDefId: UNCOMMON, quantity: 3 }] },
      });
      expect(created.status).toBe(201);
      const incoming = await app.request("GET", "/api/trades?box=incoming", { token: tokenFor(b) });
      expect(incoming.body.trades.map((t: { id: string }) => t.id)).toContain(created.body.id);
      const accepted = await app.request("POST", `/api/trades/${created.body.id}/accept`, { token: tokenFor(b), body: {} });
      expect(accepted.status).toBe(200);
      expect(accepted.body.status).toBe("completed");

      expect((await app.request("GET", "/api/admin/trades", { token: tokenFor(a) })).status).toBe(403);
      const admin = await createUser({}, { role: "admin", permissions: ["users:view"] });
      const list = await app.request("GET", `/api/admin/trades?username=${a.username}`, { token: tokenFor(admin) });
      expect(list.body).toMatchObject({ total: 1, page: 1 });
      expect((await app.request("POST", "/api/trades", { token: tokenFor(a), body: { toUsername: b.username, offered: "x" } })).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
