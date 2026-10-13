import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { createUser, getBalances } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  server = await startSocketServer();
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

/** Poll until `check` stops throwing (settlement runs in the background after gameOver). */
async function eventually(check: () => Promise<void>, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function coins(userId: string) {
  return (await getBalances(userId)).coins;
}

/** Two connected players; `a` opens a table with `bet`, `b` takes the seat and the game starts. */
async function startBetGame(bet: number, coinsA = 100, coinsB = 100) {
  const a = await createUser({ coins: coinsA });
  const b = await createUser({ coins: coinsB });
  const sa = await server.connect(tokenFor(a));
  const sb = await server.connect(tokenFor(b));
  sa.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: bet, friendly: false });
  const { roomId } = await nextEvent<{ roomId: string }>(sa, "roomCreated");
  const started = Promise.all([nextEvent(sa, "gameStart"), nextEvent(sb, "gameStart")]);
  sb.emit("joinRoom", { roomId, deckId: "brushfire" });
  await started;
  return { a, b, sa, sb, roomId };
}

function surrender(socket: ClientSocket, roomId: string) {
  socket.emit("action", { roomId, action: { type: "surrender", payload: {} } });
}

describe("table bets over the socket", () => {
  it("both stakes are taken when the game starts and the winner gets the pot", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(20);
    expect(await coins(a.id)).toBe(80);
    expect(await coins(b.id)).toBe(80);

    const settled = nextEvent<{ outcome: string; coinsDelta: number; coins: number; betAmount: number }>(sb, "matchSettled");
    const over = nextEvent<{ winner: string }>(sa, "gameOver");
    surrender(sa, roomId);
    expect((await over).winner).toBe("player2");
    expect(await settled).toMatchObject({ outcome: "win", coinsDelta: 20, coins: 120, betAmount: 20 });

    expect(await coins(a.id)).toBe(80);
    expect(await coins(b.id)).toBe(120);
    const match = await prisma.match.findFirstOrThrow({ where: { roomId } });
    expect(match).toMatchObject({ status: "finished", winnerId: b.id, betAmount: 20 });
  });

  it("a joiner who can't cover the bet can't take the seat", async () => {
    const a = await createUser({ coins: 100 });
    const b = await createUser({ coins: 5 });
    const sa = await server.connect(tokenFor(a));
    const sb = await server.connect(tokenFor(b));
    sa.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 20, friendly: false });
    const { roomId } = await nextEvent<{ roomId: string }>(sa, "roomCreated");

    sb.emit("joinRoom", { roomId, deckId: "brushfire" });
    const err = await nextEvent<{ message: string }>(sb, "error");
    expect(err.message).toMatch(/No tienes suficientes monedas/);
    expect(roomManager.getRoom(roomId)).toMatchObject({ status: "waiting", player2Id: null });
    expect(await coins(a.id)).toBe(100);
    expect(await coins(b.id)).toBe(5);
    roomManager.forceDeleteRoom(roomId);
  });

  it("the bet is capped by the creator's title and must be covered", async () => {
    const a = await createUser({ coins: 1000 });
    const sa = await server.connect(tokenFor(a));
    sa.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 50, friendly: false });
    expect((await nextEvent<{ message: string }>(sa, "error")).message).toMatch(/hasta 20 monedas/);

    const poor = await createUser({ coins: 10 });
    const sp = await server.connect(tokenFor(poor));
    sp.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 20, friendly: false });
    expect((await nextEvent<{ message: string }>(sp, "error")).message).toMatch(/No tienes suficientes monedas/);
  });

  it("if the creator spent the coins meanwhile, nobody is charged and the table closes", async () => {
    const a = await createUser({ coins: 100 });
    const b = await createUser({ coins: 100 });
    const sa = await server.connect(tokenFor(a));
    const sb = await server.connect(tokenFor(b));
    sa.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 20, friendly: false });
    const { roomId } = await nextEvent<{ roomId: string }>(sa, "roomCreated");
    await prisma.user.update({ where: { id: a.id }, data: { coins: 10 } });

    const closed = nextEvent(sa, "roomDeleted");
    sb.emit("joinRoom", { roomId, deckId: "brushfire" });
    expect((await nextEvent<{ message: string }>(sb, "error")).message).toMatch(/creador de la mesa/);
    await closed;
    expect(roomManager.getRoom(roomId)).toBeUndefined();
    expect(await coins(a.id)).toBe(10);
    expect(await coins(b.id)).toBe(100);
  });

  it("leaving a game in progress forfeits it: the other player takes the pot", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(20);
    const over = nextEvent<{ winner: string }>(sb, "gameOver");
    sa.emit("leaveRoom", { roomId });
    expect((await over).winner).toBe("player2");
    await eventually(async () => {
      expect(await coins(b.id)).toBe(120);
    });
    expect(await coins(a.id)).toBe(80);
  });

  it("a game closed without a result (admin) refunds both stakes", async () => {
    const { a, b, roomId } = await startBetGame(20);
    roomManager.forceDeleteRoom(roomId);
    await eventually(async () => {
      expect(await coins(a.id)).toBe(100);
      expect(await coins(b.id)).toBe(100);
    });
    const match = await prisma.match.findFirstOrThrow({ where: { roomId } });
    expect(match.status).toBe("abandoned");
  });
});
