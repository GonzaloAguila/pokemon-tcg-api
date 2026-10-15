/**
 * Card trades: eligibility, card points (admin-set or by rarity), the trade table flow
 * (manager + sockets) and executeTrade (re-checks ownership, fees, locks, limits), deck warnings
 * and the backoffice revert.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ALL_CARDS, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import * as trades from "../src/modules/trades/trades.service.js";
import { cardTradeValue, listSetCardValues, loadCardValues, setCardValues } from "../src/modules/trades/card-values.js";
import { tradesRouter } from "../src/modules/trades/index.js";
import { TradeTableManager } from "../src/socket/trade-tables.js";
import { tradeTableManager } from "../src/socket/trade-handlers.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.cardValue.deleteMany({});
  await loadCardValues();
});

const pokemonOf = (rarity: string, skip = 0) =>
  ALL_CARDS.filter((c) => c.kind === "pokemon" && c.rarity === rarity)[skip].id;
const COMMON = pokemonOf("common");
const UNCOMMON = pokemonOf("uncommon");
const RARE = pokemonOf("rare");
const HOLO = pokemonOf("rare-holo");
const BASIC_ENERGY = ALL_CARDS.find((c) => isBasicEnergy(c))!.id;
const P = ECONOMY.trades.valueByRarity; // common 3, uncommon 5, rare 10, holo 30

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

const party = (userId: string, cards: { cardDefId: string; quantity: number }[], ip: string | null = null) => ({ userId, cards, ip });

describe("eligibility", () => {
  it("needs a verified email, 7 days of account and 20 online games", async () => {
    expect(await trades.tradeIneligibilityReason((await trader({})).id)).toBeNull();
    expect(await trades.tradeIneligibilityReason((await trader({}, 0, { ageDays: 2 })).id)).toMatch(/7 días/);
    expect(await trades.tradeIneligibilityReason((await trader({}, 0, { games: 5 })).id)).toMatch(/20 partidas online.*llevas 5/);
    const unverified = await trader({});
    await prisma.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
    expect(await trades.tradeIneligibilityReason(unverified.id)).toMatch(/verificar tu email/);
  });
});

describe("card points", () => {
  it("by rarity until an admin sets them; basic Energy can't be traded; reset goes back to the default", async () => {
    expect([cardTradeValue(COMMON), cardTradeValue(UNCOMMON), cardTradeValue(RARE), cardTradeValue(HOLO)]).toEqual([P.common, P.uncommon, P.rare, P["rare-holo"]]);
    expect(cardTradeValue(BASIC_ENERGY)).toBeNull();
    const admin = await createUser({}, { role: "superadmin" });
    await setCardValues(admin.id, [{ cardDefId: HOLO, points: 50 }]);
    expect(cardTradeValue(HOLO)).toBe(50);
    const listed = listSetCardValues("base-set").find((c) => c.cardDefId === HOLO);
    expect(listed).toMatchObject({ points: 50, defaultPoints: P["rare-holo"], custom: true });
    await setCardValues(admin.id, [{ cardDefId: HOLO, points: null }]);
    expect(cardTradeValue(HOLO)).toBe(P["rare-holo"]);
    await expect(setCardValues(admin.id, [{ cardDefId: BASIC_ENERGY, points: 5 }])).rejects.toThrow("no se intercambia");
  });
});

describe("trade table manager", () => {
  it("open, sit, both confirm the same version; any change clears the confirmations", () => {
    const m = new TradeTableManager();
    const seat = (userId: string) => ({ userId, username: userId, avatarId: null, socketId: `s-${userId}`, ip: null });
    const table = m.create(seat("ana"));
    expect(m.list().map((t) => t.id)).toEqual([table.id]);
    expect(() => m.create(seat("ana"))).toThrow("Ya estás en una mesa");
    m.setCards(table.id, "ana", [{ cardDefId: HOLO, quantity: 1 }]);
    expect(() => m.confirm(table.id, "ana", table.version)).toThrow("Falta el otro jugador");

    m.join(table.id, seat("beto"));
    expect(m.list()).toEqual([]);
    expect(() => m.join(table.id, seat("caro"))).toThrow("dos jugadores");
    m.setCards(table.id, "beto", [{ cardDefId: COMMON, quantity: 1 }]);
    expect(() => m.confirm(table.id, "ana", table.version)).toThrow("desparejo");
    m.setCards(table.id, "beto", [{ cardDefId: RARE, quantity: 3 }]); // 30 vs 30
    const v = table.version;
    expect(m.confirm(table.id, "ana", v)).toBe(false);
    m.setCards(table.id, "beto", [{ cardDefId: RARE, quantity: 2 }, { cardDefId: UNCOMMON, quantity: 2 }]); // 30 again, but a change
    expect(table.creator.confirmed).toBe(false);
    expect(() => m.confirm(table.id, "beto", v)).toThrow("La mesa cambió");
    expect(m.confirm(table.id, "beto", table.version)).toBe(false);
    expect(m.confirm(table.id, "ana", table.version)).toBe(true);

    // The joiner leaving frees the seat; the creator leaving closes the table
    m.beginExecution(table.id);
    expect(() => m.leave(table.id, "beto")).toThrow("se está realizando");
    m.executionFailed(table.id);
    expect(m.leave(table.id, "beto").closed).toBe(false);
    expect(table.status).toBe("waiting");
    expect(m.leave(table.id, "ana").closed).toBe(true);
    expect(m.getTable(table.id)).toBeUndefined();
  });

  it("a player can't put more than 10 cards nor basic Energy on the table", () => {
    const m = new TradeTableManager();
    const table = m.create({ userId: "ana", username: "ana", avatarId: null, socketId: "s", ip: null });
    expect(() => m.setCards(table.id, "ana", [{ cardDefId: COMMON, quantity: 11 }])).toThrow("Máximo 10 cartas");
    expect(() => m.setCards(table.id, "ana", [{ cardDefId: BASIC_ENERGY, quantity: 1 }])).toThrow("no se puede intercambiar");
  });
});

describe("executeTrade", () => {
  it("moves the cards (each keeps 1), charges both fees, locks the received copies", async () => {
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 });
    const tradeId = await trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }], "1.1.1.1"), party(b.id, [{ cardDefId: RARE, quantity: 3 }], "2.2.2.2"));
    expect([await qty(a.id, HOLO), await qty(a.id, RARE), await qty(b.id, HOLO), await qty(b.id, RARE)]).toEqual([1, 3, 1, 1]);
    expect((await getBalances(a.id)).coins).toBe(500 - ECONOMY.trades.feeCoins);
    expect((await getBalances(b.id)).coins).toBe(500 - ECONOMY.trades.feeCoins);
    const row = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId } });
    expect(row).toMatchObject({ status: "completed", offeredValue: 30, requestedValue: 30, flags: [] });
    const tradable = new Map((await trades.getTradableCards(a.id)).map((c) => [c.cardDefId, c]));
    expect(tradable.get(RARE)).toMatchObject({ owned: 3, locked: 3, tradable: 0 });
  });

  it("checks again what each one owns: if a card is gone nothing moves", async () => {
    const a = await trader({ [HOLO]: 1 });
    const b = await trader({ [RARE]: 4 });
    await expect(trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }]))).rejects.toThrow("copias repetidas");
    expect(await qty(b.id, RARE)).toBe(4);
    expect((await getBalances(b.id)).coins).toBe(500);
  });

  it("without coins for the fee nothing happens", async () => {
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 }, 10);
    await expect(trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }]))).rejects.toThrow("monedas para la comisión");
    expect(await qty(a.id, HOLO)).toBe(2);
    expect((await getBalances(a.id)).coins).toBe(500);
  });

  it("the same trade twice at once: one goes through", async () => {
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 });
    const { fulfilled } = await race(4, () =>
      trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }])),
    );
    expect(fulfilled).toHaveLength(1);
    expect([await qty(a.id, HOLO), await qty(b.id, RARE)]).toEqual([1, 1]);
  });

  it("one trade a day with the same player; same connection is flagged", async () => {
    const a = await trader({ [HOLO]: 5 });
    const b = await trader({ [RARE]: 9 });
    await trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }], "9.9.9.9"), party(b.id, [{ cardDefId: RARE, quantity: 3 }], "9.9.9.9"));
    expect((await prisma.trade.findFirstOrThrow({ where: { fromUserId: a.id } })).flags).toEqual(["same_ip"]);
    await expect(trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }]))).rejects.toThrow(
      "Ya intercambiaron hoy",
    );
  });

  it("warns about decks left short, and marks them invalid after the trade", async () => {
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 });
    const deck = await prisma.deck.create({ data: { userId: b.id, name: "Mi mazo", isValid: true, cards: [{ cardDefId: RARE, quantity: 2 }] } });
    expect(await trades.deckWarningsFor(b.id, [{ cardDefId: RARE, quantity: 3 }])).toEqual([{ deckId: deck.id, deckName: "Mi mazo", cardDefId: RARE }]);
    await trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }]));
    expect((await prisma.deck.findUniqueOrThrow({ where: { id: deck.id } })).isValid).toBe(false);
  });

  it("an admin reverts it: cards back, locks gone", async () => {
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 });
    const admin = await createUser({}, { role: "superadmin" });
    const tradeId = await trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }]));
    expect((await trades.revertTrade(admin.id, tradeId)).status).toBe("reverted");
    expect([await qty(a.id, HOLO), await qty(a.id, RARE), await qty(b.id, HOLO), await qty(b.id, RARE)]).toEqual([2, 0, 0, 4]);
    expect(await prisma.cardLock.count({ where: { tradeId } })).toBe(0);
    await expect(trades.revertTrade(admin.id, tradeId)).rejects.toThrow("Solo se revierte");
  });
});

describe("trade tables over sockets", () => {
  it("open a table, sit down, put cards, confirm both: the trade is done", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startSocketServer();
    try {
      const a = await trader({ [HOLO]: 2 });
      const b = await trader({ [RARE]: 4 });
      const sa = await server.connect(tokenFor(a));
      const sb = await server.connect(tokenFor(b));

      const created = nextEvent<any>(sa, "trade:state");
      sa.emit("trade:create", {});
      const table = await created;
      expect(table).toMatchObject({ status: "waiting", youAre: "creator" });

      const joinedB = nextEvent<any>(sb, "trade:state");
      sb.emit("trade:join", { tableId: table.id });
      expect((await joinedB).status).toBe("negotiating");

      // Asking for cards you don't have is refused
      const refused = nextEvent<any>(sa, "trade:error");
      sa.emit("trade:setCards", { tableId: table.id, cards: [{ cardDefId: RARE, quantity: 1 }] });
      expect((await refused).message).toMatch(/copias repetidas/);

      sa.emit("trade:setCards", { tableId: table.id, cards: [{ cardDefId: HOLO, quantity: 1 }] });
      await nextEvent(sb, "trade:state");
      const seen = nextEvent<any>(sa, "trade:state");
      sb.emit("trade:setCards", { tableId: table.id, cards: [{ cardDefId: RARE, quantity: 3 }] });
      const both = await seen;
      expect(both.creator.points).toBe(30);
      expect(both.joiner.points).toBe(30);
      expect(both.balanceProblem).toBeNull();

      sa.emit("trade:confirm", { tableId: table.id, version: both.version });
      await nextEvent(sb, "trade:state");
      const doneA = nextEvent<any>(sa, "trade:completed");
      const doneB = nextEvent<any>(sb, "trade:completed");
      sb.emit("trade:confirm", { tableId: table.id, version: both.version });
      const [ra, rb] = await Promise.all([doneA, doneB]);
      expect(ra.tradeId).toBe(rb.tradeId);
      expect([await qty(a.id, RARE), await qty(b.id, HOLO)]).toEqual([3, 1]);
      expect(tradeTableManager.getTable(table.id)).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe("HTTP", () => {
  it("eligibility, history, deck warnings; card values need users:economy", async () => {
    const app = await startHttpApp((x) => x.use("/api", tradesRouter));
    try {
      const a = await trader({ [HOLO]: 2 });
      const b = await trader({ [RARE]: 4 });
      await trades.executeTrade(party(a.id, [{ cardDefId: HOLO, quantity: 1 }]), party(b.id, [{ cardDefId: RARE, quantity: 3 }]));
      expect((await app.request("GET", "/api/trades/eligibility", { token: tokenFor(a) })).body).toMatchObject({ eligible: true });
      expect((await app.request("GET", "/api/trades", { token: tokenFor(a) })).body.trades).toHaveLength(1);
      const warnings = await app.request("POST", "/api/trades/deck-warnings", { token: tokenFor(a), body: { cards: [{ cardDefId: HOLO, quantity: 1 }] } });
      expect(warnings.body).toEqual({ warnings: [] });

      expect((await app.request("GET", "/api/admin/card-values?set=base-set", { token: tokenFor(a) })).status).toBe(403);
      const admin = await createUser({}, { role: "admin", permissions: ["users:economy"] });
      const list = await app.request("GET", "/api/admin/card-values?set=jungle", { token: tokenFor(admin) });
      expect(list.body.cards.length).toBeGreaterThan(40);
      const put = await app.request("PATCH", "/api/admin/card-values", { token: tokenFor(admin), body: { values: [{ cardDefId: COMMON, points: 7 }] } });
      expect(put.status).toBe(200);
      expect(cardTradeValue(COMMON)).toBe(7);
      expect((await app.request("PATCH", "/api/admin/card-values", { token: tokenFor(admin), body: { values: [{ cardDefId: COMMON, points: 0 }] } })).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
