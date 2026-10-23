import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { matchesRouter } from "../src/modules/matches/index.js";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", matchesRouter));
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("GET /api/matches/history", () => {
  it("lists the player's settled games from their side, newest first", async () => {
    const me = await createUser();
    const rival = await createUser();
    const stranger = await createUser();
    const settled = { status: "finished", counted: true };
    await prisma.match.createMany({
      data: [
        // Online win, rival surrendered (me as player 2)
        { ...settled, mode: "normal", player1Id: rival.id, player2Id: me.id, winnerId: me.id, winReason: `${rival.username} se ha rendido`, betAmount: 50, player2Xp: 30, player2Coins: 20, settledAt: minutesAgo(1) },
        // Online loss on the turn clock
        { ...settled, mode: "draft", player1Id: me.id, player2Id: rival.id, winnerId: rival.id, winReason: "Tiempo agotado", player1Xp: 10, settledAt: minutesAgo(2) },
        // A disconnect forfeit (its text mentions "tiempo" too)
        { ...settled, mode: "normal", player1Id: rival.id, player2Id: me.id, winnerId: me.id, winReason: "Oponente desconectado (tiempo de espera agotado)", settledAt: minutesAgo(3) },
        // vs the AI: a Lucky Duel loss and a too-quick win (a draw)
        { ...settled, mode: "ai", gameMode: "lucky-duel", player1Id: me.id, winReason: "lucky-duel: defeat", settledAt: minutesAgo(4) },
        { ...settled, mode: "ai", gameMode: "lucky-duel", player1Id: me.id, winReason: "lucky-duel: draw (quick victory)", settledAt: minutesAgo(5) },
        // Interrupted by a restart: no result
        { status: "abandoned", mode: "normal", player1Id: me.id, player2Id: rival.id, winReason: "Partida interrumpida por un reinicio del servidor", settledAt: minutesAgo(6) },
        // A gym game won
        { ...settled, counted: false, mode: "gym", player1Id: me.id, winnerId: me.id, winReason: "Ganó el retador", gym: { leaderId: "brock", leaderName: "Brock", mode: "normal", game: 2, bestOf: 3, score: { challenger: 2, leader: 0 } }, settledAt: minutesAgo(7) },
        // Not settled yet (in progress), and someone else's game: not listed
        { status: "playing", mode: "normal", player1Id: me.id, player2Id: rival.id },
        { ...settled, mode: "normal", player1Id: rival.id, player2Id: stranger.id, winnerId: rival.id, settledAt: minutesAgo(1) },
      ],
    });

    const res = await http.request("GET", "/api/matches/history?limit=20", { token: tokenFor(me) });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    const rows = res.body.data.map((e: { result: string; end: string; mode: string; opponent: { kind: string } }) => [e.mode, e.result, e.end, e.opponent.kind]);
    expect(rows).toEqual([
      ["normal", "victory", "surrender", "player"],
      ["draft", "defeat", "timeout", "player"],
      ["normal", "victory", "disconnect", "player"],
      ["ai", "defeat", "game", "ai"],
      ["ai", "draw", "game", "ai"],
      ["normal", "interrupted", "game", "player"],
      ["gym", "victory", "game", "gym"],
    ]);
    // My seat's rewards, the rival's name
    expect(res.body.data[0]).toMatchObject({ xp: 30, coins: 20, betAmount: 50, counted: true, opponent: { username: rival.username } });
    expect(res.body.data[1]).toMatchObject({ xp: 10, opponent: { username: rival.username } });
    expect(res.body.data[6].opponent).toMatchObject({ leaderName: "Brock", game: 2, bestOf: 3 });
  });

  it("pages 10 at a time and needs a session", async () => {
    const me = await createUser();
    await prisma.match.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({ status: "finished", mode: "ai", player1Id: me.id, winReason: "victory", settledAt: minutesAgo(i) })),
    });
    const second = await http.request("GET", "/api/matches/history?page=2", { token: tokenFor(me) });
    expect(second.body).toMatchObject({ total: 12, page: 2, limit: 10 });
    expect(second.body.data).toHaveLength(2);
    expect((await http.request("GET", "/api/matches/history?page=0", { token: tokenFor(me) })).status).toBe(422);
    expect((await http.request("GET", "/api/matches/history")).status).toBe(401);
  });
});

describe("GET /api/matches/history/summary", () => {
  it("sums the settled games per mode, with streaks and the last 10 results", async () => {
    const me = await createUser();
    const rival = await createUser();
    const at = (n: number) => minutesAgo(100 - n); // n = order of play, 1 = oldest
    const online = (n: number, won: boolean, gameMode = "standard") => ({
      status: "finished", mode: "normal", gameMode, player1Id: me.id, player2Id: rival.id, winnerId: won ? me.id : rival.id, winReason: "Partida finalizada", counted: true, settledAt: at(n),
    });
    await prisma.match.createMany({
      data: [
        online(1, true), online(2, true), online(3, true), online(4, false), online(5, true, "lucky-duel"), online(6, false, "lucky-duel"),
        { ...online(7, true), mode: "draft" },
        { status: "finished", mode: "ai", player1Id: me.id, winReason: "victory", settledAt: at(8) },
        { status: "finished", mode: "ai", gameMode: "lucky-duel", player1Id: me.id, winReason: "lucky-duel: abandoned", settledAt: at(9) },
        { status: "finished", mode: "ai", player1Id: me.id, winReason: "draw", settledAt: at(10) },
        { status: "finished", mode: "gym", player1Id: me.id, winnerId: me.id, winReason: "Ganó el retador", gym: { leaderId: "brock", leaderName: "Brock", mode: "normal", game: 1, bestOf: 3 }, settledAt: at(11) },
        { status: "finished", mode: "ai", player1Id: me.id, winReason: "victory", settledAt: at(12) },
        { status: "finished", mode: "ai", player1Id: me.id, winReason: "victory", settledAt: at(13) },
        // Not counted in the panel: a friendly game and an interrupted one
        { ...online(14, false), mode: "friendly" },
        { status: "abandoned", mode: "normal", player1Id: me.id, player2Id: rival.id, winReason: "Partida interrumpida por un reinicio del servidor", settledAt: at(15) },
      ],
    });
    await prisma.userMedal.create({ data: { userId: me.id, medalId: "boulder" } });

    const res = await http.request("GET", "/api/matches/history/summary", { token: tokenFor(me) });
    expect(res.status).toBe(200);
    const s = res.body;
    // 13 decided games: wins 1,2,3,5,7,8,11,12,13 (9); losses 4,6,9 (3); draw 10
    expect(s).toMatchObject({ wins: 9, losses: 3, draws: 1, winRate: 75, currentStreak: 3, bestStreak: 3 });
    expect(s.last).toEqual(["victory", "victory", "victory", "draw", "defeat", "victory", "victory", "defeat", "victory", "defeat"]);
    expect(s.modes.online).toEqual({ wins: 4, losses: 2, draws: 0, luckyDuel: { wins: 1, losses: 1 } });
    expect(s.modes.draft).toEqual({ wins: 1, losses: 0, draws: 0 });
    expect(s.modes.ai).toEqual({ wins: 3, losses: 1, draws: 1, luckyDuel: { wins: 0, losses: 1 } });
    expect(s.modes.gym).toEqual({ wins: 1, losses: 0, draws: 0, medals: 1 });
  });

  it("is all zeros without games and needs a session", async () => {
    const me = await createUser();
    const res = await http.request("GET", "/api/matches/history/summary", { token: tokenFor(me) });
    expect(res.body).toMatchObject({ wins: 0, losses: 0, draws: 0, winRate: 0, currentStreak: 0, bestStreak: 0, last: [] });
    expect((await http.request("GET", "/api/matches/history/summary")).status).toBe(401);
  });
});
