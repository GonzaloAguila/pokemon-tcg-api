/**
 * Card trades between players.
 *
 * Trades happen at trade tables (socket/trade-tables.ts): a player opens a table, another sits
 * down, each puts cards on their side and both confirm. executeTrade then runs everything in ONE
 * transaction with both players' rows locked (lockUsers, id order): eligibility and daily limits
 * again, both collections checked against what they own now, the copies move with conditional
 * decrements (a player always keeps 1 copy), both pay the fee and the received copies are locked
 * for ECONOMY.trades.lockDays. Any failure rolls all of it back.
 *
 * Rules (ECONOMY.trades): cards only, duplicates only, no basic Energy, both sides with cards,
 * the cheaper side worth at least minValueRatio of the other by card points (card-values.ts),
 * eligibility (verified email, account age, counted online games), daily limits, a fee.
 */

import { Prisma } from "@prisma/client";
import { findCardById } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { AppError, Errors } from "../../middleware/error-handler.js";
import { ECONOMY } from "../economy/config.js";
import { startOfEconomyDay } from "../economy/economy-time.js";
import { countedOnlineGames } from "../matches/matches.service.js";
import { spendCoins, type Db } from "../users/users.service.js";
import { lockUsers } from "../users/xp.service.js";
import { validateDeckForUser, type DeckCardEntry } from "../decks/decks.service.js";
import { cardTradeValue } from "./card-values.js";

export { cardTradeValue } from "./card-values.js";

/** 404 in Spanish (Errors.NotFound says "X not found"). */
const notFound = (what: string) => new AppError(`${what} no encontrado`, 404, "NOT_FOUND");

const DAY_MS = 24 * 60 * 60 * 1000;

export type TradeCard = { cardDefId: string; quantity: number };

// ---------------------------------------------------------------------------
// Cards and values
// ---------------------------------------------------------------------------

export function sideValue(cards: readonly TradeCard[]): number {
  return cards.reduce((sum, c) => sum + (cardTradeValue(c.cardDefId) ?? 0) * c.quantity, 0);
}

/** One entry per card (repeated ids merged), validated: tradable card, 1+ copies, side size. May be empty. */
export function normalizeSide(cards: readonly TradeCard[]): TradeCard[] {
  const merged = new Map<string, number>();
  for (const { cardDefId, quantity } of cards) {
    if (!Number.isInteger(quantity) || quantity < 1) throw Errors.BadRequest("Cantidad inválida");
    if (cardTradeValue(cardDefId) === null) throw Errors.BadRequest("Esa carta no se puede intercambiar");
    merged.set(cardDefId, (merged.get(cardDefId) ?? 0) + quantity);
  }
  const side = [...merged].map(([cardDefId, quantity]) => ({ cardDefId, quantity }));
  if (side.reduce((sum, c) => sum + c.quantity, 0) > ECONOMY.trades.maxCardsPerSide) {
    throw Errors.BadRequest(`Máximo ${ECONOMY.trades.maxCardsPerSide} cartas de cada lado`);
  }
  return side;
}

/** Null when both sides have cards and are close enough in points, otherwise why not. */
export function balanceProblem(aValue: number, bValue: number): string | null {
  if (aValue <= 0 || bValue <= 0) return "Los dos lados deben tener cartas";
  const low = Math.min(aValue, bValue);
  const high = Math.max(aValue, bValue);
  if (low < high * ECONOMY.trades.minValueRatio) {
    return `Intercambio desparejo: el lado de menos puntos debe valer al menos el ${Math.round(ECONOMY.trades.minValueRatio * 100)}% del otro`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Eligibility and what a player can give
// ---------------------------------------------------------------------------

/** Why `userId` can't trade yet, or null. */
export async function tradeIneligibilityReason(userId: string, db: Db = prisma, now = new Date()): Promise<string | null> {
  const cfg = ECONOMY.trades;
  const user = await db.user.findUnique({ where: { id: userId }, select: { emailVerified: true, createdAt: true, status: true } });
  if (!user) return "Usuario no encontrado";
  if (user.status !== "active") return "La cuenta no está activa";
  if (cfg.requireVerifiedEmail && !user.emailVerified) return "Necesitas verificar tu email para intercambiar";
  const ageDays = (now.getTime() - user.createdAt.getTime()) / DAY_MS;
  if (ageDays < cfg.minAccountAgeDays) {
    return `Tu cuenta necesita ${cfg.minAccountAgeDays} días de antigüedad para intercambiar`;
  }
  const games = await countedOnlineGames(db, userId);
  if (games < cfg.minOnlineGames) {
    return `Necesitas ${cfg.minOnlineGames} partidas online para intercambiar (llevas ${games})`;
  }
  return null;
}

export type TradableCount = { owned: number; locked: number; tradable: number; unlockAt: Date | null };

/** Copies of each card `userId` could give now: owned − 1 − locked (received in a recent trade). */
export async function tradableCounts(userId: string, db: Db = prisma, now = new Date()): Promise<Map<string, TradableCount>> {
  const [cards, locks] = await Promise.all([
    db.userCard.findMany({ where: { userId, quantity: { gt: 1 } }, select: { cardDefId: true, quantity: true } }),
    db.cardLock.findMany({ where: { userId, unlockAt: { gt: now } }, select: { cardDefId: true, quantity: true, unlockAt: true } }),
  ]);
  const locked = new Map<string, { quantity: number; unlockAt: Date }>();
  for (const lock of locks) {
    const prev = locked.get(lock.cardDefId);
    locked.set(lock.cardDefId, {
      quantity: (prev?.quantity ?? 0) + lock.quantity,
      unlockAt: prev && prev.unlockAt < lock.unlockAt ? prev.unlockAt : lock.unlockAt,
    });
  }
  const result = new Map<string, TradableCount>();
  for (const { cardDefId, quantity } of cards) {
    if (cardTradeValue(cardDefId) === null) continue;
    const lock = locked.get(cardDefId);
    const lockedQty = lock?.quantity ?? 0;
    result.set(cardDefId, {
      owned: quantity,
      locked: lockedQty,
      tradable: Math.max(0, quantity - 1 - lockedQty),
      unlockAt: lock?.unlockAt ?? null,
    });
  }
  return result;
}

/** The first card of `side` `userId` can't give (as a Spanish reason), or null. */
export async function shortfall(userId: string, side: readonly TradeCard[], db: Db = prisma, now = new Date()): Promise<string | null> {
  const counts = await tradableCounts(userId, db, now);
  for (const { cardDefId, quantity } of side) {
    if ((counts.get(cardDefId)?.tradable ?? 0) < quantity) {
      const name = findCardById(cardDefId)?.name ?? cardDefId;
      return `${name}: no hay suficientes copias repetidas disponibles`;
    }
  }
  return null;
}

/** Trades completed today (economy day) by `userId`, in total and with `otherId`. */
async function completedToday(db: Db, userId: string, otherId: string, now: Date) {
  const where = { status: "completed", completedAt: { gte: startOfEconomyDay(now) } };
  const [total, withOther] = await Promise.all([
    db.trade.count({ where: { ...where, OR: [{ fromUserId: userId }, { toUserId: userId }] } }),
    db.trade.count({
      where: {
        ...where,
        OR: [
          { fromUserId: userId, toUserId: otherId },
          { fromUserId: otherId, toUserId: userId },
        ],
      },
    }),
  ]);
  return { total, withOther };
}

/** Null when both players can still trade today (and with each other), otherwise why not. */
export async function dailyLimitProblem(db: Db, userId: string, otherId: string, now = new Date()): Promise<string | null> {
  const cfg = ECONOMY.trades;
  for (const [id, other, who] of [
    [userId, otherId, "Ya hiciste"],
    [otherId, userId, "El otro jugador ya hizo"],
  ] as const) {
    const { total, withOther } = await completedToday(db, id, other, now);
    if (total >= cfg.maxTradesPerDay) return `${who} los ${cfg.maxTradesPerDay} intercambios de hoy`;
    if (withOther >= cfg.maxTradesPerDayWithSamePlayer) return "Ya intercambiaron hoy: prueben mañana";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const tradeSelect = {
  id: true,
  status: true,
  offered: true,
  requested: true,
  offeredValue: true,
  requestedValue: true,
  fee: true,
  createdAt: true,
  completedAt: true,
  revertedAt: true,
  from: { select: { id: true, username: true, activeAvatarId: true } },
  to: { select: { id: true, username: true, activeAvatarId: true } },
} as const;

/** The trades `userId` took part in, newest first. */
export async function listTrades(userId: string) {
  return prisma.trade.findMany({
    where: { OR: [{ fromUserId: userId }, { toUserId: userId }], status: { in: ["completed", "reverted"] } },
    select: tradeSelect,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/** What `userId` can give, by card (also cards locked for a while, with when they unlock). */
export async function getTradableCards(userId: string) {
  const counts = await tradableCounts(userId);
  return [...counts].map(([cardDefId, c]) => ({ cardDefId, ...c, value: cardTradeValue(cardDefId) }));
}

/** Decks of `userId` that would lack copies after giving `gives`. */
export async function deckWarningsFor(userId: string, gives: readonly TradeCard[]): Promise<{ deckId: string; deckName: string; cardDefId: string }[]> {
  if (gives.length === 0) return [];
  const giving = new Map(gives.map((c) => [c.cardDefId, c.quantity]));
  const [decks, owned] = await Promise.all([
    prisma.deck.findMany({ where: { userId }, select: { id: true, name: true, cards: true } }),
    prisma.userCard.findMany({ where: { userId, cardDefId: { in: [...giving.keys()] } }, select: { cardDefId: true, quantity: true } }),
  ]);
  const ownedById = new Map(owned.map((c) => [c.cardDefId, c.quantity]));
  const warnings: { deckId: string; deckName: string; cardDefId: string }[] = [];
  for (const deck of decks) {
    const needed = new Map<string, number>();
    for (const entry of (deck.cards ?? []) as unknown as DeckCardEntry[]) {
      if (giving.has(entry.cardDefId)) needed.set(entry.cardDefId, (needed.get(entry.cardDefId) ?? 0) + entry.quantity);
    }
    for (const [cardDefId, quantity] of needed) {
      if ((ownedById.get(cardDefId) ?? 0) - (giving.get(cardDefId) ?? 0) < quantity) {
        warnings.push({ deckId: deck.id, deckName: deck.name, cardDefId });
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Executing a trade
// ---------------------------------------------------------------------------

/** Move `side` from `giverId` to `receiverId` inside the transaction (giver keeps 1 copy). */
async function moveCards(tx: Db, giverId: string, receiverId: string, side: readonly TradeCard[], lockUntil: Date | null, tradeId: string) {
  for (const { cardDefId, quantity } of side) {
    const { count } = await tx.userCard.updateMany({
      where: { userId: giverId, cardDefId, quantity: { gte: quantity + 1 } },
      data: { quantity: { decrement: quantity } },
    });
    if (count === 0) throw Errors.BadRequest(`${findCardById(cardDefId)?.name ?? cardDefId}: ya no hay copias repetidas`);
    await tx.userCard.upsert({
      where: { userId_cardDefId: { userId: receiverId, cardDefId } },
      update: { quantity: { increment: quantity } },
      create: { userId: receiverId, cardDefId, quantity },
    });
    if (lockUntil) await tx.cardLock.create({ data: { userId: receiverId, cardDefId, quantity, tradeId, unlockAt: lockUntil } });
  }
}

export type TradeParty = { userId: string; cards: readonly TradeCard[]; ip: string | null };

/**
 * Both players agreed: `a` (who opened the table) gives a.cards, `b` gives b.cards. Everything is
 * checked again and done in one transaction (see the file header). Returns the trade id; throws a
 * Spanish reason (nothing changed) otherwise.
 */
export async function executeTrade(a: TradeParty, b: TradeParty, now = new Date()): Promise<string> {
  const cfg = ECONOMY.trades;
  if (a.userId === b.userId) throw Errors.BadRequest("No puedes intercambiar contigo mismo");
  const aCards = normalizeSide(a.cards);
  const bCards = normalizeSide(b.cards);
  const aValue = sideValue(aCards);
  const bValue = sideValue(bCards);
  const balance = balanceProblem(aValue, bValue);
  if (balance) throw Errors.BadRequest(balance);

  const tradeId = await prisma.$transaction(
    async (tx) => {
      await lockUsers(tx, [a.userId, b.userId]);
      for (const party of [a, b]) {
        const reason = await tradeIneligibilityReason(party.userId, tx, now);
        if (reason) throw Errors.BadRequest(reason);
      }
      const limit = await dailyLimitProblem(tx, a.userId, b.userId, now);
      if (limit) throw Errors.BadRequest(limit);
      for (const [party, cards] of [
        [a, aCards],
        [b, bCards],
      ] as const) {
        const short = await shortfall(party.userId, cards, tx, now);
        if (short) throw Errors.BadRequest(short);
      }

      const trade = await tx.trade.create({
        data: {
          fromUserId: a.userId,
          toUserId: b.userId,
          status: "completed",
          offered: aCards,
          requested: bCards,
          offeredValue: aValue,
          requestedValue: bValue,
          fee: cfg.feeCoins,
          fromIp: a.ip,
          acceptIp: b.ip,
          // Same connection on both ends: allowed (a family), flagged for the backoffice
          flags: a.ip && b.ip && a.ip === b.ip ? ["same_ip"] : [],
          expiresAt: now,
          respondedAt: now,
          completedAt: now,
        },
        select: { id: true },
      });

      const lockUntil = cfg.lockDays > 0 ? new Date(now.getTime() + cfg.lockDays * DAY_MS) : null;
      await moveCards(tx, a.userId, b.userId, aCards, lockUntil, trade.id);
      await moveCards(tx, b.userId, a.userId, bCards, lockUntil, trade.id);

      if (cfg.feeCoins > 0) {
        for (const party of [a, b]) {
          await spendCoins(party.userId, cfg.feeCoins, "trade_fee", "Comisión de intercambio de cartas", tx).catch(() => {
            throw Errors.BadRequest(`Cada jugador necesita ${cfg.feeCoins} monedas para la comisión del intercambio`);
          });
        }
      }
      return trade.id;
    },
    { timeout: 15_000, maxWait: 10_000 },
  );

  // Decks left without enough copies show as invalid (the game also checks when it starts)
  await Promise.all([revalidateDecks(a.userId, aCards), revalidateDecks(b.userId, bCards)]).catch((err) =>
    console.error("[trades] deck revalidation failed:", err),
  );
  return tradeId;
}

async function revalidateDecks(userId: string, gave: readonly TradeCard[]) {
  const ids = new Set(gave.map((c) => c.cardDefId));
  const decks = await prisma.deck.findMany({ where: { userId, isValid: true }, select: { id: true, cards: true } });
  for (const deck of decks) {
    const cards = (deck.cards ?? []) as unknown as DeckCardEntry[];
    if (!cards.some((c) => ids.has(c.cardDefId))) continue;
    const { valid } = await validateDeckForUser(userId, cards);
    if (!valid) await prisma.deck.update({ where: { id: deck.id }, data: { isValid: false } });
  }
}

// ---------------------------------------------------------------------------
// Backoffice
// ---------------------------------------------------------------------------

export async function adminListTrades(params: { page: number; limit: number; status?: string; username?: string; flagged?: boolean }) {
  const where: Prisma.TradeWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.flagged ? { NOT: { flags: { equals: [] } } } : {}),
    ...(params.username
      ? {
          OR: [
            { from: { username: { contains: params.username, mode: "insensitive" } } },
            { to: { username: { contains: params.username, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [data, total] = await Promise.all([
    prisma.trade.findMany({
      where,
      select: { ...tradeSelect, flags: true, fromIp: true, acceptIp: true, revertedBy: true },
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
    prisma.trade.count({ where }),
  ]);
  return { data, total, page: params.page, limit: params.limit };
}

/**
 * Undo a completed trade (within ECONOMY.trades.revertDays): each player gives back what they
 * received, if they still have it. The fees are not refunded.
 */
export async function revertTrade(adminId: string, tradeId: string, now = new Date()) {
  const pre = await prisma.trade.findUnique({ where: { id: tradeId }, select: { fromUserId: true, toUserId: true } });
  if (!pre) throw notFound("Intercambio");
  await prisma.$transaction(
    async (tx) => {
      await lockUsers(tx, [pre.fromUserId, pre.toUserId]);
      const row = await tx.trade.findUniqueOrThrow({ where: { id: tradeId } });
      if (row.status !== "completed" || !row.completedAt) throw Errors.BadRequest("Solo se revierte un intercambio realizado");
      if (now.getTime() - row.completedAt.getTime() > ECONOMY.trades.revertDays * DAY_MS) {
        throw Errors.BadRequest(`Solo se revierte dentro de ${ECONOMY.trades.revertDays} días`);
      }
      for (const [receiverId, giverId, side] of [
        [row.toUserId, row.fromUserId, row.offered as TradeCard[]],
        [row.fromUserId, row.toUserId, row.requested as TradeCard[]],
      ] as const) {
        for (const { cardDefId, quantity } of side) {
          const { count } = await tx.userCard.updateMany({
            where: { userId: receiverId, cardDefId, quantity: { gte: quantity } },
            data: { quantity: { decrement: quantity } },
          });
          if (count === 0) throw Errors.BadRequest(`Un jugador ya no tiene ${findCardById(cardDefId)?.name ?? cardDefId}`);
          await tx.userCard.upsert({
            where: { userId_cardDefId: { userId: giverId, cardDefId } },
            update: { quantity: { increment: quantity } },
            create: { userId: giverId, cardDefId, quantity },
          });
        }
      }
      await tx.cardLock.deleteMany({ where: { tradeId } });
      await tx.trade.update({ where: { id: tradeId }, data: { status: "reverted", revertedAt: now, revertedBy: adminId } });
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
  return prisma.trade.findUniqueOrThrow({ where: { id: tradeId }, select: tradeSelect });
}
