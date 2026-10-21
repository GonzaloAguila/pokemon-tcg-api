import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { ECONOMY } from "../src/modules/economy/config.js";
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

/** A player allowed to bet when bets are on: verified email and 20 online games (title "joven", max bet 50). */
async function veteran(coinsAmount: number) {
  const user = await createUser({ coins: coinsAmount });
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  await prisma.userStats.create({ data: { userId: user.id, normalWins: 10, normalLosses: 10 } });
  return user;
}

/** Two connected players; `a` opens a table with `bet`, `b` takes the seat and the game starts. */
async function startBetGame(bet: number, coinsA = 100, coinsB = 100) {
  const a = await veteran(coinsA);
  const b = await veteran(coinsB);
  const sa = await server.connect(tokenFor(a));
  const sb = await server.connect(tokenFor(b));
  sa.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: bet, friendly: false });
  const { roomId } = await nextEvent<{ roomId: string }>(sa, "roomCreated");
  const started = Promise.all([nextEvent(sa, "gameStart"), nextEvent(sb, "gameStart")]);
  sb.emit("joinRoom", { roomId, deckId: "brushfire" });
  await started;
  return { a, b, sa, sb, roomId };
}

/** Make the running game look like it reached `turn` and lasted a few minutes. */
async function playedUntil(roomId: string, turn: number) {
  const room = roomManager.getRoom(roomId)!;
  room.gameState!.turnNumber = turn;
  await prisma.match.updateMany({ where: { roomId }, data: { startedAt: new Date(Date.now() - 5 * 60_000) } });
}

function surrender(socket: ClientSocket, roomId: string) {
  socket.emit("action", { roomId, action: { type: "surrender", payload: {} } });
}

describe("table bets are off (default)", () => {
  it("the server forces the bet to 0: nobody is charged", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(20);
    expect(roomManager.getRoom(roomId)?.config.betAmount).toBe(0);
    expect(await coins(a.id)).toBe(100);
    expect(await coins(b.id)).toBe(100);

    const settled = nextEvent<Record<string, unknown>>(sb, "matchSettled");
    surrender(sa, roomId);
    expect(await settled).toMatchObject({ betAmount: 0, coinsDelta: 0 });
    expect((await prisma.match.findFirstOrThrow({ where: { roomId } })).betAmount).toBe(0);
  });

  it("a surrender in the mulligan by a new account doesn't count as a win (no stats, coins or XP for the winner)", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(0);
    // Not established (ECONOMY.antiFarming.forfeit.establishedMinOnlineGames)
    await prisma.userStats.update({ where: { userId: a.id }, data: { normalWins: 1, normalLosses: 1 } });
    const settled = nextEvent<Record<string, unknown>>(sb, "matchSettled");
    surrender(sa, roomId);
    expect(await settled).toMatchObject({
      outcome: "win",
      counted: false,
      earlyForfeit: true,
      forfeitBlockedBy: "forfeiter_not_established",
      rewardCoins: 0,
      xpGained: 0,
      missionsCompleted: [],
    });
    const stats = await prisma.userStats.findUniqueOrThrow({ where: { userId: b.id } });
    expect(stats).toMatchObject({ normalWins: 10, normalLosses: 10, currentStreak: 0 });
    expect(await coins(b.id)).toBe(100);
    // The forfeiter's loss is recorded anyway
    await eventually(async () => {
      expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: a.id } })).toMatchObject({ normalLosses: 2 });
    });
  });

  it("a surrender in the mulligan by an established account pays the winner a counted win", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(0);
    const settled = nextEvent<Record<string, unknown>>(sb, "matchSettled");
    const loserSettled = nextEvent<Record<string, unknown>>(sa, "matchSettled");
    surrender(sa, roomId);
    expect(await settled).toMatchObject({ outcome: "win", counted: true, earlyForfeit: true, rewardCoins: ECONOMY.matchCoins.online.win });
    expect(await loserSettled).toMatchObject({ outcome: "loss", earlyForfeit: true, rewardCoins: 0, xpGained: 0 });
    expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: b.id } })).toMatchObject({ normalWins: 11, currentStreak: 1 });
    expect(await prisma.userStats.findUniqueOrThrow({ where: { userId: a.id } })).toMatchObject({ normalLosses: 11 });
    expect(await coins(a.id)).toBe(100);
  });

  it("a game played past turn 3 for 2+ minutes counts: stats, match coins and missions", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(0);
    await playedUntil(roomId, 5);
    const settled = nextEvent<Record<string, unknown>>(sb, "matchSettled");
    const loserSettled = nextEvent<Record<string, unknown>>(sa, "matchSettled");
    surrender(sa, roomId);
    expect(await settled).toMatchObject({ outcome: "win", counted: true, rewardCoins: ECONOMY.matchCoins.online.win });
    expect(await loserSettled).toMatchObject({ outcome: "loss", counted: true, rewardCoins: ECONOMY.matchCoins.online.loss });
    const stats = await prisma.userStats.findUniqueOrThrow({ where: { userId: b.id } });
    expect(stats).toMatchObject({ normalWins: 11, currentStreak: 1 });
    expect(await coins(a.id)).toBe(100 + ECONOMY.matchCoins.online.loss);
  });
});

describe("table bets over the socket (re-enabled with the flag)", () => {
  beforeEach(() => {
    ECONOMY.tableBets.enabled = true;
  });
  afterEach(() => {
    ECONOMY.tableBets.enabled = false;
  });

  it("both stakes are taken when the game starts and the winner gets the pot (turn 3+)", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(20);
    expect(await coins(a.id)).toBe(80);
    expect(await coins(b.id)).toBe(80);
    await playedUntil(roomId, 4);

    const settled = nextEvent<{ outcome: string; coinsDelta: number; coins: number; betAmount: number }>(sb, "matchSettled");
    const over = nextEvent<{ winner: string }>(sa, "gameOver");
    surrender(sa, roomId);
    expect((await over).winner).toBe("player2");
    const winnerTotal = 120 + ECONOMY.matchCoins.online.win + 50; // pot + match coins + "win 1 game" mission
    expect(await settled).toMatchObject({ outcome: "win", coinsDelta: 20, coins: winnerTotal, betAmount: 20 });

    expect(await coins(a.id)).toBe(80 + ECONOMY.matchCoins.online.loss);
    expect(await coins(b.id)).toBe(winnerTotal);
    const match = await prisma.match.findFirstOrThrow({ where: { roomId } });
    expect(match).toMatchObject({ status: "finished", winnerId: b.id, betAmount: 20 });
  });

  it("a surrender before turn 3 refunds both stakes", async () => {
    const { a, b, sa, sb, roomId } = await startBetGame(20);
    const settled = nextEvent<Record<string, unknown>>(sb, "matchSettled");
    surrender(sa, roomId);
    // The stakes go back (standard tables pay from minTurnForPayout); the early forfeit of an
    // established account still counts as a win (match coins + the win mission)
    expect(await settled).toMatchObject({ outcome: "win", coinsDelta: 0, counted: true, earlyForfeit: true });
    expect(await coins(a.id)).toBe(100);
    const winMission = ECONOMY.missions.daily.find((m) => m.id === "win_game")!.rewardCoins;
    expect(await coins(b.id)).toBe(100 + ECONOMY.matchCoins.online.win + winMission);
  });

  it("an inexperienced or unverified creator can't open a bet table", async () => {
    const fresh = await createUser({ coins: 1000 }, { emailVerified: false });
    const sf = await server.connect(tokenFor(fresh));
    sf.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 10, friendly: false });
    expect((await nextEvent<{ message: string }>(sf, "error")).message).toMatch(/verificar tu email/);
  });

  it("a joiner who can't cover the bet can't take the seat", async () => {
    const a = await veteran(100);
    const b = await veteran(5);
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
    const a = await veteran(1000);
    const sa = await server.connect(tokenFor(a));
    sa.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 60, friendly: false });
    expect((await nextEvent<{ message: string }>(sa, "error")).message).toMatch(/hasta 50 monedas/);

    const poor = await veteran(10);
    const sp = await server.connect(tokenFor(poor));
    sp.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 20, friendly: false });
    expect((await nextEvent<{ message: string }>(sp, "error")).message).toMatch(/No tienes suficientes monedas/);
  });

  it("if the creator spent the coins meanwhile, nobody is charged and the table closes", async () => {
    const a = await veteran(100);
    const b = await veteran(100);
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
    await playedUntil(roomId, 3);
    const over = nextEvent<{ winner: string }>(sb, "gameOver");
    sa.emit("leaveRoom", { roomId });
    expect((await over).winner).toBe("player2");
    await eventually(async () => {
      expect(await coins(b.id)).toBe(120 + ECONOMY.matchCoins.online.win + 50);
    });
    expect(await coins(a.id)).toBe(80 + ECONOMY.matchCoins.online.loss);
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
