/**
 * Card trades between players.
 *
 * A proposal says which cards each side gives. Accepting it runs everything in ONE transaction
 * with both players' rows locked (lockUsers, id order): the trade row is claimed with a
 * conditional update (pending -> completed: two accepts at once, only one wins), both
 * collections are checked again (what they own now, not when it was proposed), the copies move
 * with conditional decrements (a player always keeps 1 copy), the fee is charged and the
 * received copies are locked for ECONOMY.trades.lockDays. Any failure rolls all of it back.
 *
 * Rules (ECONOMY.trades): cards only, duplicates only, no basic Energy, both sides non-empty,
 * the cheaper side worth at least minValueRatio of the other, eligibility (verified email,
 * account age, counted online games), daily limits, a fee in coins.
 */

import { Prisma } from "@prisma/client";
import { findCardById, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { AppError, Errors } from "../../middleware/error-handler.js";

/** 404 in Spanish (Errors.NotFound says "X not found"). */
const notFound = (what: string) => new AppError(`${what} no encontrado`, 404, "NOT_FOUND");
import { ECONOMY } from "../economy/config.js";
import { startOfEconomyDay } from "../economy/economy-time.js";
import { countedOnlineGames } from "../matches/matches.service.js";
import { spendCoins, type Db } from "../users/users.service.js";
import { lockUsers } from "../users/xp.service.js";
import { validateDeckForUser, type DeckCardEntry } from "../decks/decks.service.js";
import { createPersonalMessage } from "../messaging/messaging.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TradeStatus = "pending" | "completed" | "rejected" | "cancelled" | "expired" | "reverted";
export type TradeCard = { cardDefId: string; quantity: number };

// ---------------------------------------------------------------------------
// Cards and values
// ---------------------------------------------------------------------------

/** Trade value of one copy, or null when the card can't be traded (unknown, basic Energy). */
export function cardTradeValue(cardDefId: string): number | null {
  const card = findCardById(cardDefId);
  if (!card || isBasicEnergy(card)) return null;
  return ECONOMY.trades.valueByRarity[card.rarity] ?? null;
}

export function sideValue(cards: TradeCard[]): number {
  return cards.reduce((sum, c) => sum + (cardTradeValue(c.cardDefId) ?? 0) * c.quantity, 0);
}

/** One entry per card (repeated ids merged), validated: tradable kind, 1+ copies, side size. */
export function normalizeSide(cards: TradeCard[], label: string): TradeCard[] {
  const merged = new Map<string, number>();
  for (const { cardDefId, quantity } of cards) {
    if (!Number.isInteger(quantity) || quantity < 1) throw Errors.BadRequest("Cantidad inválida");
    if (cardTradeValue(cardDefId) === null) throw Errors.BadRequest("Esa carta no se puede intercambiar");
    merged.set(cardDefId, (merged.get(cardDefId) ?? 0) + quantity);
  }
  const side = [...merged].map(([cardDefId, quantity]) => ({ cardDefId, quantity }));
  const total = side.reduce((sum, c) => sum + c.quantity, 0);
  if (total === 0) throw Errors.BadRequest(`Elige al menos una carta ${label}`);
  if (total > ECONOMY.trades.maxCardsPerSide) {
    throw Errors.BadRequest(`Máximo ${ECONOMY.trades.maxCardsPerSide} cartas de cada lado`);
  }
  return side;
}

/** Null when both sides are close enough in value, otherwise why not. */
export function balanceProblem(offeredValue: number, requestedValue: number): string | null {
  const low = Math.min(offeredValue, requestedValue);
  const high = Math.max(offeredValue, requestedValue);
  if (low < high * ECONOMY.trades.minValueRatio) {
    return "El intercambio está muy desparejo: el lado de menor valor debe valer al menos el 70% del otro";
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

/** Copies of each card `userId` could give now: owned − 1 − locked (received in a recent trade). */
export async function tradableCounts(userId: string, db: Db = prisma, now = new Date()): Promise<Map<string, { owned: number; locked: number; tradable: number; unlockAt: Date | null }>> {
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
  const result = new Map<string, { owned: number; locked: number; tradable: number; unlockAt: Date | null }>();
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

/** The cards `userId` can't give from `side` (as a Spanish reason), or null. */
async function shortfall(userId: string, side: TradeCard[], db: Db, now: Date): Promise<string | null> {
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
async function completedToday(db: Db, userId: string, otherId: string, now: Date, exceptTradeId?: string) {
  const where = {
    status: "completed",
    completedAt: { gte: startOfEconomyDay(now) },
    ...(exceptTradeId ? { id: { not: exceptTradeId } } : {}),
  };
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

async function dailyLimitProblem(db: Db, userId: string, otherId: string, now: Date, exceptTradeId?: string): Promise<string | null> {
  const cfg = ECONOMY.trades;
  for (const [id, other, who] of [
    [userId, otherId, "Ya hiciste"],
    [otherId, userId, "El otro jugador ya hizo"],
  ] as const) {
    const { total, withOther } = await completedToday(db, id, other, now, exceptTradeId);
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
  expiresAt: true,
  respondedAt: true,
  completedAt: true,
  revertedAt: true,
  from: { select: { id: true, username: true, activeAvatarId: true } },
  to: { select: { id: true, username: true, activeAvatarId: true } },
} as const;

/** Pending proposals past their time become "expired". */
export async function expireStaleTrades(now = new Date()): Promise<void> {
  await prisma.trade.updateMany({ where: { status: "pending", expiresAt: { lte: now } }, data: { status: "expired" } });
}

export async function listTrades(userId: string, box: "incoming" | "outgoing" | "history") {
  await expireStaleTrades();
  const where: Prisma.TradeWhereInput =
    box === "incoming"
      ? { toUserId: userId, status: "pending" }
      : box === "outgoing"
        ? { fromUserId: userId, status: "pending" }
        : { OR: [{ fromUserId: userId }, { toUserId: userId }], status: { not: "pending" } };
  return prisma.trade.findMany({ where, select: tradeSelect, orderBy: { createdAt: "desc" }, take: 50 });
}

/**
 * One trade as `userId` sees it (they must be one of its players), with `deckWarnings`: the
 * viewer's decks that would lack copies of a card they give.
 */
export async function getTrade(userId: string, tradeId: string) {
  await expireStaleTrades();
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, select: tradeSelect });
  if (!trade || (trade.from.id !== userId && trade.to.id !== userId)) throw notFound("Intercambio");
  const gives = (trade.from.id === userId ? trade.offered : trade.requested) as TradeCard[];
  const deckWarnings = trade.status === "pending" ? await deckWarningsFor(userId, gives) : [];
  return { ...trade, deckWarnings };
}

/** Decks of `userId` that would lack copies after giving `gives`. */
async function deckWarningsFor(userId: string, gives: TradeCard[]): Promise<{ deckId: string; deckName: string; cardDefId: string }[]> {
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

/** What `userId` can give, by card (also cards locked for a while, with when they unlock). */
export async function getTradableCards(userId: string) {
  const counts = await tradableCounts(userId);
  return [...counts].map(([cardDefId, c]) => ({ cardDefId, ...c, value: cardTradeValue(cardDefId) }));
}

/** A player's cards others can ask for, by username (only what they could give now). */
export async function getTradableCardsOf(username: string) {
  const user = await findUserByUsername(username);
  const cards = await getTradableCards(user.id);
  return { user: { id: user.id, username: user.username }, cards: cards.filter((c) => c.tradable > 0) };
}

async function findUserByUsername(username: string) {
  const user = await prisma.user.findFirst({
    where: { username: { equals: username.trim(), mode: "insensitive" } },
    select: { id: true, username: true },
  });
  if (!user) throw notFound("Jugador");
  return user;
}

// ---------------------------------------------------------------------------
// Proposal, answer
// ---------------------------------------------------------------------------

export async function createTrade(
  fromUserId: string,
  input: { toUsername: string; offered: TradeCard[]; requested: TradeCard[] },
  ip: string | null,
  now = new Date(),
) {
  const cfg = ECONOMY.trades;
  const to = await findUserByUsername(input.toUsername);
  if (to.id === fromUserId) throw Errors.BadRequest("No puedes intercambiar contigo mismo");

  const offered = normalizeSide(input.offered, "para dar");
  const requested = normalizeSide(input.requested, "para pedir");
  const offeredValue = sideValue(offered);
  const requestedValue = sideValue(requested);
  const balance = balanceProblem(offeredValue, requestedValue);
  if (balance) throw Errors.BadRequest(balance);

  const mine = await tradeIneligibilityReason(fromUserId, prisma, now);
  if (mine) throw Errors.Forbidden(mine);
  if (await tradeIneligibilityReason(to.id, prisma, now)) {
    throw Errors.BadRequest(`${to.username} todavía no puede intercambiar`);
  }

  const pending = await prisma.trade.count({ where: { fromUserId, status: "pending", expiresAt: { gt: now } } });
  if (pending >= cfg.maxPendingSent) throw Errors.BadRequest(`Ya tienes ${cfg.maxPendingSent} propuestas esperando respuesta`);

  const limit = await dailyLimitProblem(prisma, fromUserId, to.id, now);
  if (limit) throw Errors.BadRequest(limit);

  const myShortfall = await shortfall(fromUserId, offered, prisma, now);
  if (myShortfall) throw Errors.BadRequest(myShortfall);
  const theirShortfall = await shortfall(to.id, requested, prisma, now);
  if (theirShortfall) throw Errors.BadRequest(`${to.username} no puede darte eso: ${theirShortfall}`);

  const me = await prisma.user.findUnique({ where: { id: fromUserId }, select: { username: true, coins: true } });
  if (!me) throw notFound("Usuario");
  if (me.coins < cfg.feeCoins) throw Errors.BadRequest(`Necesitas ${cfg.feeCoins} monedas para la comisión del intercambio`);

  const trade = await prisma.trade.create({
    data: {
      fromUserId,
      toUserId: to.id,
      offered,
      requested,
      offeredValue,
      requestedValue,
      fee: cfg.feeCoins,
      fromIp: ip,
      expiresAt: new Date(now.getTime() + cfg.offerHours * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  await createPersonalMessage(
    fromUserId,
    to.id,
    "Propuesta de intercambio",
    `${me.username} te propone un intercambio. Revísalo en Intercambios antes de ${cfg.offerHours} horas.`,
    "trade",
    { tradeId: trade.id },
  ).catch((err) => console.error("[trades] notify failed:", err));

  return getTrade(fromUserId, trade.id);
}

/** Move `side` from `giverId` to `receiverId` inside the transaction (giver keeps 1 copy). */
async function moveCards(tx: Db, giverId: string, receiverId: string, side: TradeCard[], lockUntil: Date | null, tradeId: string) {
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

export async function acceptTrade(userId: string, tradeId: string, ip: string | null, now = new Date()) {
  const cfg = ECONOMY.trades;
  const pre = await prisma.trade.findUnique({ where: { id: tradeId }, select: { fromUserId: true, toUserId: true } });
  if (!pre || pre.toUserId !== userId) throw notFound("Intercambio");

  const trade = await prisma.$transaction(
    async (tx) => {
      await lockUsers(tx, [pre.fromUserId, pre.toUserId]);
      // Claim it: only one accept can move it out of "pending"
      const claimed = await tx.trade.updateMany({
        where: { id: tradeId, toUserId: userId, status: "pending", expiresAt: { gt: now } },
        data: { status: "completed", completedAt: now, respondedAt: now, acceptIp: ip },
      });
      if (claimed.count === 0) {
        const current = await tx.trade.findUnique({ where: { id: tradeId }, select: { status: true, expiresAt: true } });
        if (current?.status === "pending" && current.expiresAt <= now) throw Errors.BadRequest("La propuesta venció");
        throw Errors.BadRequest("La propuesta ya no está pendiente");
      }
      const row = await tx.trade.findUniqueOrThrow({ where: { id: tradeId } });
      const offered = row.offered as TradeCard[];
      const requested = row.requested as TradeCard[];

      for (const [id, who] of [
        [row.fromUserId, "El otro jugador"],
        [row.toUserId, "Tú"],
      ] as const) {
        const reason = await tradeIneligibilityReason(id, tx, now);
        if (reason) throw Errors.BadRequest(who === "Tú" ? reason : `${who} ya no puede intercambiar`);
      }
      const limit = await dailyLimitProblem(tx, row.toUserId, row.fromUserId, now, tradeId);
      if (limit) throw Errors.BadRequest(limit);

      // What each one owns now (not when it was proposed)
      const fromShort = await shortfall(row.fromUserId, offered, tx, now);
      if (fromShort) throw Errors.BadRequest(`El otro jugador ya no tiene lo que ofreció (${fromShort})`);
      const toShort = await shortfall(row.toUserId, requested, tx, now);
      if (toShort) throw Errors.BadRequest(toShort);

      const lockUntil = cfg.lockDays > 0 ? new Date(now.getTime() + cfg.lockDays * DAY_MS) : null;
      await moveCards(tx, row.fromUserId, row.toUserId, offered, lockUntil, tradeId);
      await moveCards(tx, row.toUserId, row.fromUserId, requested, lockUntil, tradeId);

      if (row.fee > 0) {
        const description = "Comisión de intercambio de cartas";
        await spendCoins(row.toUserId, row.fee, "trade_fee", description, tx).catch(() => {
          throw Errors.BadRequest(`Necesitas ${row.fee} monedas para la comisión del intercambio`);
        });
        await spendCoins(row.fromUserId, row.fee, "trade_fee", description, tx).catch(() => {
          throw Errors.BadRequest("El otro jugador no tiene monedas para la comisión");
        });
      }

      // Same connection on both ends: allowed (a family), but flagged for the backoffice
      if (row.fromIp && ip && row.fromIp === ip) {
        await tx.trade.update({ where: { id: tradeId }, data: { flags: ["same_ip"] } });
      }
      return row;
    },
    { timeout: 15_000, maxWait: 10_000 },
  );

  // Decks left without enough copies show as invalid (the game also checks when it starts)
  await Promise.all([
    revalidateDecks(trade.fromUserId, trade.offered as TradeCard[]),
    revalidateDecks(trade.toUserId, trade.requested as TradeCard[]),
  ]).catch((err) => console.error("[trades] deck revalidation failed:", err));

  const accepter = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
  await createPersonalMessage(
    userId,
    trade.fromUserId,
    "Intercambio realizado",
    `${accepter?.username ?? "El otro jugador"} aceptó tu intercambio: las cartas ya están en tu colección.`,
    "trade",
    { tradeId },
  ).catch((err) => console.error("[trades] notify failed:", err));

  return getTrade(userId, tradeId);
}

async function revalidateDecks(userId: string, gave: TradeCard[]) {
  const ids = new Set(gave.map((c) => c.cardDefId));
  const decks = await prisma.deck.findMany({ where: { userId, isValid: true }, select: { id: true, cards: true } });
  for (const deck of decks) {
    const cards = (deck.cards ?? []) as unknown as DeckCardEntry[];
    if (!cards.some((c) => ids.has(c.cardDefId))) continue;
    const { valid } = await validateDeckForUser(userId, cards);
    if (!valid) await prisma.deck.update({ where: { id: deck.id }, data: { isValid: false } });
  }
}

/** The receiver rejects, or the proposer cancels, a pending proposal. */
export async function closeTrade(userId: string, tradeId: string, as: "reject" | "cancel", now = new Date()) {
  const owner = as === "reject" ? { toUserId: userId } : { fromUserId: userId };
  const { count } = await prisma.trade.updateMany({
    where: { id: tradeId, status: "pending", ...owner },
    data: { status: as === "reject" ? "rejected" : "cancelled", respondedAt: now },
  });
  if (count === 0) throw Errors.BadRequest("La propuesta ya no está pendiente");
  if (as === "reject") {
    const trade = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId }, select: { fromUserId: true, to: { select: { username: true } } } });
    await createPersonalMessage(userId, trade.fromUserId, "Intercambio rechazado", `${trade.to.username} rechazó tu propuesta de intercambio.`, "trade", { tradeId }).catch(
      (err) => console.error("[trades] notify failed:", err),
    );
  }
  return getTrade(userId, tradeId);
}

// ---------------------------------------------------------------------------
// Backoffice
// ---------------------------------------------------------------------------

export async function adminListTrades(params: { page: number; limit: number; status?: string; username?: string; flagged?: boolean }) {
  await expireStaleTrades();
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
