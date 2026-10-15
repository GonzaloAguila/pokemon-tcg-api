/**
 * Trade table socket events (tables: trade-tables.ts; the trade itself: trades.service.ts).
 *
 * trade:getTables                 → trade:tableList [open tables] (also broadcast on changes)
 *                                   + trade:myTable { tableId } | null (the table you sit at)
 * trade:create                    → trade:state (eligible players, one table each)
 * trade:join { tableId }          → trade:state to both (also to come back after a reload)
 * trade:setCards { tableId, cards } your side; must be duplicates you can give
 * trade:confirm { tableId, version } / trade:unconfirm { tableId }
 * trade:leave { tableId }         creator: closes it (trade:closed to the other); joiner: frees the seat
 * Both confirmed → trade:completed { tableId, tradeId } to both, or trade:error and back to negotiating.
 * Errors: trade:error { message }. A disconnected seat has TABLE_GRACE_MS to come back.
 */

import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ECONOMY } from "../modules/economy/config.js";
import {
  dailyLimitProblem,
  executeTrade,
  normalizeSide,
  shortfall,
  tradeIneligibilityReason,
} from "../modules/trades/trades.service.js";
import { requireSocketUser } from "./session-guard.js";
import { TradeTableManager, type TradeTable } from "./trade-tables.js";

export const tradeTableManager = new TradeTableManager();

/** Time a player who lost the connection (reload, tab closed) has to come back to their seat. */
export const TABLE_GRACE_MS = 20_000;
const leaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const tableRef = z.object({ tableId: z.string().uuid() });
const setCardsSchema = tableRef.extend({
  cards: z
    .array(z.object({ cardDefId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(ECONOMY.trades.maxCardsPerSide) }))
    .max(ECONOMY.trades.maxCardsPerSide),
});
const confirmSchema = tableRef.extend({ version: z.number().int().min(0) });

/** The client's address (behind Nginx: X-Forwarded-For), for the same-connection flag. */
function socketIp(socket: Socket): string | null {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || socket.handshake.address || null;
}

function sendTable(io: Server, table: TradeTable): void {
  for (const seat of [table.creator, table.joiner]) {
    if (seat?.socketId) io.to(seat.socketId).emit("trade:state", tradeTableManager.clientState(table, seat.userId));
  }
}

function broadcastTableList(io: Server): void {
  io.emit("trade:tableList", tradeTableManager.list());
}

function cancelLeaveTimer(tableId: string, userId: string): void {
  const key = `${tableId}:${userId}`;
  const timer = leaveTimers.get(key);
  if (timer) clearTimeout(timer);
  leaveTimers.delete(key);
}

/** `userId` leaves `table` (on request or after the grace period); tells whoever stays. */
function leaveTable(io: Server, table: TradeTable, userId: string, reason: string): void {
  cancelLeaveTimer(table.id, userId);
  const { closed } = tradeTableManager.leave(table.id, userId);
  if (closed) {
    const other = table.joiner;
    if (other) {
      cancelLeaveTimer(table.id, other.userId);
      if (other.socketId) io.to(other.socketId).emit("trade:closed", { tableId: table.id, reason });
    }
  } else {
    sendTable(io, table);
  }
  broadcastTableList(io);
}

async function playerIdentity(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, activeAvatarId: true } });
  if (!user) throw new Error("Usuario no encontrado");
  return { username: user.username, avatarId: user.activeAvatarId ?? null };
}

function parse<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.output<S> {
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error("Solicitud inválida");
  return result.data;
}

export function registerTradeEvents(io: Server, socket: Socket): void {
  /** Run a handler for an authenticated player; errors go back as trade:error. */
  const on = (event: string, handler: (userId: string, payload: unknown) => Promise<void>) => {
    socket.on(event, async (payload: unknown) => {
      try {
        const userId = await requireSocketUser(socket, "trade:error");
        if (!userId) return;
        await handler(userId, payload);
      } catch (error) {
        socket.emit("trade:error", { message: (error as Error).message });
      }
    });
  };

  // Also tells a player sitting at a table which one (the way back from the lobby)
  socket.on("trade:getTables", () => {
    socket.emit("trade:tableList", tradeTableManager.list());
    const userId: string | undefined = socket.data.user?.userId;
    const mine = userId ? tradeTableManager.getTableOf(userId) : undefined;
    socket.emit("trade:myTable", mine ? { tableId: mine.id } : null);
  });

  on("trade:create", async (userId) => {
    const reason = await tradeIneligibilityReason(userId);
    if (reason) throw new Error(reason);
    const table = tradeTableManager.create({ userId, ...(await playerIdentity(userId)), socketId: socket.id, ip: socketIp(socket) });
    sendTable(io, table);
    broadcastTableList(io);
  });

  on("trade:join", async (userId, payload) => {
    const { tableId } = parse(tableRef, payload);
    const existing = tradeTableManager.getTable(tableId);
    if (!existing) throw new Error("La mesa ya no existe");
    if (!tradeTableManager.seatOf(existing, userId)) {
      const reason = await tradeIneligibilityReason(userId);
      if (reason) throw new Error(reason);
      const limit = await dailyLimitProblem(prisma, userId, existing.creator.userId);
      if (limit) throw new Error(limit);
    }
    const { table } = tradeTableManager.join(tableId, { userId, ...(await playerIdentity(userId)), socketId: socket.id, ip: socketIp(socket) });
    cancelLeaveTimer(tableId, userId);
    sendTable(io, table);
    broadcastTableList(io);
  });

  on("trade:setCards", async (userId, payload) => {
    const { tableId, cards } = parse(setCardsSchema, payload);
    const side = normalizeSide(cards);
    const short = await shortfall(userId, side);
    if (short) throw new Error(short);
    sendTable(io, tradeTableManager.setCards(tableId, userId, side));
  });

  on("trade:unconfirm", async (userId, payload) => {
    const { tableId } = parse(tableRef, payload);
    sendTable(io, tradeTableManager.unconfirm(tableId, userId));
  });

  on("trade:confirm", async (userId, payload) => {
    const { tableId, version } = parse(confirmSchema, payload);
    const both = tradeTableManager.confirm(tableId, userId, version);
    const table = tradeTableManager.getTable(tableId)!;
    if (!both) {
      sendTable(io, table);
      return;
    }
    tradeTableManager.beginExecution(tableId);
    sendTable(io, table);
    const joiner = table.joiner!;
    try {
      const tradeId = await executeTrade(
        { userId: table.creator.userId, cards: table.creator.cards, ip: table.creator.ip },
        { userId: joiner.userId, cards: joiner.cards, ip: joiner.ip },
      );
      tradeTableManager.close(tableId);
      for (const seat of [table.creator, joiner]) {
        cancelLeaveTimer(tableId, seat.userId);
        if (seat.socketId) io.to(seat.socketId).emit("trade:completed", { tableId, tradeId });
      }
      console.log(`🔁 Trade ${tradeId}: ${table.creator.username} ↔ ${joiner.username}`);
    } catch (error) {
      const failed = tradeTableManager.executionFailed(tableId);
      for (const seat of [table.creator, joiner]) {
        if (seat.socketId) io.to(seat.socketId).emit("trade:error", { message: (error as Error).message });
      }
      if (failed) sendTable(io, failed);
    }
    broadcastTableList(io);
  });

  on("trade:leave", async (userId, payload) => {
    const { tableId } = parse(tableRef, payload);
    const table = tradeTableManager.getTable(tableId);
    if (!table) return;
    const seat = tradeTableManager.seatOf(table, userId);
    if (!seat) throw new Error("No estás en esta mesa");
    leaveTable(io, table, userId, `${seat.username} cerró la mesa`);
  });

  socket.on("disconnect", () => {
    const gone = tradeTableManager.markDisconnected(socket.id);
    if (!gone) return;
    const { table, userId } = gone;
    sendTable(io, table);
    const key = `${table.id}:${userId}`;
    leaveTimers.set(
      key,
      setTimeout(() => {
        leaveTimers.delete(key);
        const current = tradeTableManager.getTable(table.id);
        const seat = current && tradeTableManager.seatOf(current, userId);
        if (!current || !seat || seat.socketId !== null || current.status === "executing") return;
        leaveTable(io, current, userId, `${seat.username} se desconectó`);
      }, TABLE_GRACE_MS),
    );
  });
}
