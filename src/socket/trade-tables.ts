/**
 * Trade tables (in memory, like game rooms): a player opens a table and waits; another sits
 * down; each puts duplicates on their own side (both see both sides and the points live); both
 * confirm the same version of the table and the trade runs (trades.service executeTrade).
 *
 * Any change to a side bumps `version` and clears both confirmations, and a confirmation names
 * the version it agrees to: nobody can swap cards after the other confirmed.
 */

import { randomUUID } from "node:crypto";
import { ECONOMY } from "../modules/economy/config.js";
import { cardTradeValue } from "../modules/trades/card-values.js";
import { balanceProblem, normalizeSide, sideValue, type TradeCard } from "../modules/trades/trades.service.js";

export type TradeSeat = {
  userId: string;
  username: string;
  avatarId: string | null;
  socketId: string | null;
  cards: TradeCard[];
  confirmed: boolean;
  ip: string | null;
};

export type TradeTableStatus = "waiting" | "negotiating" | "executing";

export type TradeTable = {
  id: string;
  status: TradeTableStatus;
  creator: TradeSeat;
  joiner: TradeSeat | null;
  version: number;
  createdAt: Date;
};

export type ClientTradeSeat = {
  userId: string;
  username: string;
  avatarId: string | null;
  cards: (TradeCard & { points: number })[];
  points: number;
  confirmed: boolean;
  connected: boolean;
};

export type ClientTradeTable = {
  id: string;
  status: TradeTableStatus;
  version: number;
  creator: ClientTradeSeat;
  joiner: ClientTradeSeat | null;
  /** Which seat the viewer holds */
  youAre: "creator" | "joiner" | null;
  /** Null when the table can be confirmed (both sides with cards, close enough in points) */
  balanceProblem: string | null;
  feeCoins: number;
  minValueRatio: number;
  maxCardsPerSide: number;
};

/** Lobby list entry (open tables only). */
export type TradeTableInfo = { id: string; creator: { username: string; avatarId: string | null }; createdAt: string };

export type NewSeat = Pick<TradeSeat, "userId" | "username" | "avatarId" | "socketId" | "ip">;

export class TradeTableManager {
  private tables = new Map<string, TradeTable>();
  private tableOfUser = new Map<string, string>();

  getTable(tableId: string): TradeTable | undefined {
    return this.tables.get(tableId);
  }

  getTableOf(userId: string): TradeTable | undefined {
    const id = this.tableOfUser.get(userId);
    return id ? this.tables.get(id) : undefined;
  }

  /** Open a table (one per player at a time). */
  create(seat: NewSeat): TradeTable {
    const current = this.getTableOf(seat.userId);
    if (current) throw new Error("Ya estás en una mesa de intercambio");
    const table: TradeTable = {
      id: randomUUID(),
      status: "waiting",
      creator: { ...seat, cards: [], confirmed: false },
      joiner: null,
      version: 1,
      createdAt: new Date(),
    };
    this.tables.set(table.id, table);
    this.tableOfUser.set(seat.userId, table.id);
    return table;
  }

  /** Sit at a table: back to your own seat (new socket), or the free one of an open table. */
  join(tableId: string, seat: NewSeat): { table: TradeTable; rejoined: boolean } {
    const table = this.tables.get(tableId);
    if (!table) throw new Error("La mesa ya no existe");
    const own = this.seatOf(table, seat.userId);
    if (own) {
      own.socketId = seat.socketId;
      own.ip = seat.ip ?? own.ip;
      return { table, rejoined: true };
    }
    if (table.joiner || table.status !== "waiting") throw new Error("La mesa ya tiene dos jugadores");
    if (this.getTableOf(seat.userId)) throw new Error("Ya estás en una mesa de intercambio");
    table.joiner = { ...seat, cards: [], confirmed: false };
    table.status = "negotiating";
    this.touch(table);
    this.tableOfUser.set(seat.userId, table.id);
    return { table, rejoined: false };
  }

  /** Replace what `userId` puts on the table (validated by the caller against their collection). */
  setCards(tableId: string, userId: string, cards: TradeCard[]): TradeTable {
    const table = this.requireTable(tableId);
    if (table.status === "executing") throw new Error("El intercambio se está realizando");
    const seat = this.requireSeat(table, userId);
    seat.cards = normalizeSide(cards);
    this.touch(table);
    return table;
  }

  /**
   * `userId` agrees to `version` of the table. Returns true when both agreed (the caller runs
   * the trade after beginExecution).
   */
  confirm(tableId: string, userId: string, version: number): boolean {
    const table = this.requireTable(tableId);
    if (table.status !== "negotiating" || !table.joiner) throw new Error("Falta el otro jugador");
    if (version !== table.version) throw new Error("La mesa cambió: revisa las cartas antes de confirmar");
    const problem = balanceProblem(sideValue(table.creator.cards), sideValue(table.joiner.cards));
    if (problem) throw new Error(problem);
    this.requireSeat(table, userId).confirmed = true;
    return table.creator.confirmed && table.joiner.confirmed;
  }

  unconfirm(tableId: string, userId: string): TradeTable {
    const table = this.requireTable(tableId);
    if (table.status === "executing") throw new Error("El intercambio se está realizando");
    this.requireSeat(table, userId).confirmed = false;
    return table;
  }

  beginExecution(tableId: string): TradeTable {
    const table = this.requireTable(tableId);
    table.status = "executing";
    return table;
  }

  /** The trade failed (someone lacks a card, coins…): back to negotiating, confirmations cleared. */
  executionFailed(tableId: string): TradeTable | undefined {
    const table = this.tables.get(tableId);
    if (!table) return undefined;
    table.status = table.joiner ? "negotiating" : "waiting";
    this.touch(table);
    return table;
  }

  /** Remove a table (trade done, creator left). */
  close(tableId: string): TradeTable | undefined {
    const table = this.tables.get(tableId);
    if (!table) return undefined;
    this.tables.delete(tableId);
    for (const seat of [table.creator, table.joiner]) {
      if (seat && this.tableOfUser.get(seat.userId) === tableId) this.tableOfUser.delete(seat.userId);
    }
    return table;
  }

  /**
   * `userId` leaves: the creator closes the table; the joiner frees the seat (the creator keeps
   * waiting with their cards, unconfirmed).
   */
  leave(tableId: string, userId: string): { table: TradeTable; closed: boolean } {
    const table = this.requireTable(tableId);
    if (table.status === "executing") throw new Error("El intercambio se está realizando");
    if (table.creator.userId === userId) {
      this.close(tableId);
      return { table, closed: true };
    }
    if (table.joiner?.userId !== userId) throw new Error("No estás en esta mesa");
    this.tableOfUser.delete(userId);
    table.joiner = null;
    table.status = "waiting";
    this.touch(table);
    return { table, closed: false };
  }

  /** The socket went away: its seat is marked disconnected (the caller gives it a grace period). */
  markDisconnected(socketId: string): { table: TradeTable; userId: string } | null {
    for (const table of this.tables.values()) {
      for (const seat of [table.creator, table.joiner]) {
        if (seat && seat.socketId === socketId) {
          seat.socketId = null;
          return { table, userId: seat.userId };
        }
      }
    }
    return null;
  }

  /** Open tables, for the lobby. */
  list(): TradeTableInfo[] {
    return [...this.tables.values()]
      .filter((t) => t.status === "waiting")
      .map((t) => ({ id: t.id, creator: { username: t.creator.username, avatarId: t.creator.avatarId }, createdAt: t.createdAt.toISOString() }));
  }

  /** What `viewerId` sees (both sides are public to both players). */
  clientState(table: TradeTable, viewerId: string): ClientTradeTable {
    const seat = (s: TradeSeat): ClientTradeSeat => ({
      userId: s.userId,
      username: s.username,
      avatarId: s.avatarId,
      cards: s.cards.map((c) => ({ ...c, points: cardTradeValue(c.cardDefId) ?? 0 })),
      points: sideValue(s.cards),
      confirmed: s.confirmed,
      connected: s.socketId !== null,
    });
    return {
      id: table.id,
      status: table.status,
      version: table.version,
      creator: seat(table.creator),
      joiner: table.joiner ? seat(table.joiner) : null,
      youAre: table.creator.userId === viewerId ? "creator" : table.joiner?.userId === viewerId ? "joiner" : null,
      balanceProblem: table.joiner ? balanceProblem(sideValue(table.creator.cards), sideValue(table.joiner.cards)) : "Esperando a otro jugador",
      feeCoins: ECONOMY.trades.feeCoins,
      minValueRatio: ECONOMY.trades.minValueRatio,
      maxCardsPerSide: ECONOMY.trades.maxCardsPerSide,
    };
  }

  seatOf(table: TradeTable, userId: string): TradeSeat | null {
    if (table.creator.userId === userId) return table.creator;
    if (table.joiner?.userId === userId) return table.joiner;
    return null;
  }

  /** A side changed: new version, both confirmations cleared. */
  private touch(table: TradeTable): void {
    table.version++;
    table.creator.confirmed = false;
    if (table.joiner) table.joiner.confirmed = false;
  }

  private requireTable(tableId: string): TradeTable {
    const table = this.tables.get(tableId);
    if (!table) throw new Error("La mesa ya no existe");
    return table;
  }

  private requireSeat(table: TradeTable, userId: string): TradeSeat {
    const seat = this.seatOf(table, userId);
    if (!seat) throw new Error("No estás en esta mesa");
    return seat;
  }
}
