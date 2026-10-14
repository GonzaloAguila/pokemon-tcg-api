/**
 * Regression tests over real sockets for the 2026-10-14 draft bugs:
 * 12 isAdminViewer in draft:state; start from another socket of the admin; backoffice delete
 *    by a site admin with real errors (draft:error / ack) for anyone else
 * 5  entry fees refunded when the room closes before its tournament
 * 13 keepInCollection credits the drafted cards once, at the end
 * 14 draft:forfeit only by a player of that game
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_CARDS, type GameCard } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { openRoomMatch } from "../src/socket/match-settlement.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { creditDraftedCards, draftRoomManager } from "../src/socket/draft-handlers.js";
import type { DraftRoom } from "../src/socket/draft-rooms.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = (name: string, id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === name && c.set === "Base Set")!), id });

async function createDraft(config: Record<string, unknown>) {
  const admin = await createUser({}, { role: "admin" });
  const adminSocket = await server.connect(tokenFor(admin));
  adminSocket.emit("draft:create", { config: { adminPlays: false, ...config } });
  const { roomId } = await nextEvent<{ roomId: string }>(adminSocket, "draft:created");
  return { admin, adminSocket, roomId };
}

describe("bug 12: draft admin by user id; backoffice delete with real errors", () => {
  it("isAdminViewer, start from the admin's other socket, delete: player rejected, site admin accepted", async () => {
    const { admin, adminSocket, roomId } = await createDraft({ entryFee: 0 });

    const [pa, pb] = [await createUser(), await createUser()];
    const sa = await server.connect(tokenFor(pa));
    const sb = await server.connect(tokenFor(pb));
    const stateA = nextEvent<any>(sa, "draft:state");
    sa.emit("draft:join", { roomId });
    expect((await stateA).isAdminViewer).toBe(false);
    const adminSees = nextEvent<any>(adminSocket, "draft:state");
    sb.emit("draft:join", { roomId });
    expect((await adminSees).isAdminViewer).toBe(true);

    // A player can't start nor close it; the error is real
    sa.emit("draft:start", { roomId });
    expect((await nextEvent<{ message: string }>(sa, "draft:error")).message).toBe("Solo el admin puede iniciar el draft");
    const refused = await sa.timeout(2000).emitWithAck("draft:delete", { roomId });
    expect(refused).toEqual({ success: false, error: "Solo el admin puede cerrar el draft" });
    expect(draftRoomManager.getRoom(roomId)).toBeDefined();

    // The admin from another tab (backoffice) starts it
    const adminTab2 = await server.connect(tokenFor(admin));
    const started = nextEvent<any>(sa, "draft:state");
    adminTab2.emit("draft:start", { roomId });
    expect((await started).phase).toBe("drafting");

    // Another site admin closes it from the backoffice: ack + draft:roomDeleted; players told
    const otherAdmin = await createUser({}, { role: "superadmin" });
    const backoffice = await server.connect(tokenFor(otherAdmin));
    const closedForA = nextEvent<any>(sa, "draft:roomClosed");
    const deletedEvent = nextEvent<any>(backoffice, "draft:roomDeleted");
    const ack = await backoffice.timeout(2000).emitWithAck("draft:delete", { roomId });
    expect(ack).toEqual({ success: true });
    expect(await deletedEvent).toEqual({ roomId });
    expect((await closedForA).roomId).toBe(roomId);
    expect(draftRoomManager.getRoom(roomId)).toBeUndefined();

    const gone = await backoffice.timeout(2000).emitWithAck("draft:delete", { roomId });
    expect(gone).toEqual({ success: false, error: "Sala no encontrada" });
  });
});

describe("bug 5: entry fees come back when the draft closes before its tournament", () => {
  it("charged at start, refunded once on close", async () => {
    const { adminSocket, roomId } = await createDraft({ entryFee: 300 });
    const [pa, pb] = [await createUser({ coins: 1000 }), await createUser({ coins: 1000 })];
    const sa = await server.connect(tokenFor(pa));
    const sb = await server.connect(tokenFor(pb));
    for (const s of [sa, sb]) {
      const joined = nextEvent<any>(s, "draft:state");
      s.emit("draft:join", { roomId });
      await joined;
    }
    const started = nextEvent<any>(sa, "draft:state");
    adminSocket.emit("draft:start", { roomId });
    expect((await started).phase).toBe("drafting");
    expect((await getBalances(pa.id)).coins).toBe(700);

    const ack = await adminSocket.timeout(2000).emitWithAck("draft:delete", { roomId });
    expect(ack).toEqual({ success: true });
    await sleep(300);
    expect((await getBalances(pa.id)).coins).toBe(1000);
    expect((await getBalances(pb.id)).coins).toBe(1000);
    const refunds = await prisma.transaction.count({ where: { userId: { in: [pa.id, pb.id] }, type: "draft_refund" } });
    expect(refunds).toBe(2);
  });
});

/** A draft in its (single-match) tournament: A vs B in a real game room, C is the third player. */
async function draftMatch(keepInCollection: boolean) {
  const [admin, a, b, c] = await Promise.all([
    createUser({}, { role: "admin" }),
    createUser({}, { stats: true }),
    createUser({}, { stats: true }),
    createUser({}, { stats: true }),
  ]);
  const room = draftRoomManager.createRoom({ adminPlays: false, entryFee: 0, keepInCollection }, admin.id, "admin-x", "Admin");
  for (const [u, name] of [[a, "A"], [b, "B"], [c, "C"]] as const) draftRoomManager.joinRoom(room.id, u.id, `draft-${name}`, name);
  room.phase = "matching";
  room.players[0].draftedCards = [card("Pikachu", "d1"), card("Pikachu", "d2"), card("Bill", "d3")];
  room.players[1].draftedCards = [card("Charmander", "d4")];
  room.tournament = {
    rounds: [{ roundNumber: 1, pairings: [{ matchNumber: 1, player1: { id: a.id, name: "A" }, player2: { id: b.id, name: "B" } }], byePlayerId: null, status: "in_progress", results: [] }],
    standings: [a, b, c].map((u, i) => ({ playerId: u.id, playerName: "ABC"[i], wins: 0, losses: 0, byes: 0 })),
    currentRoundNumber: 1,
    totalRounds: 1,
  };
  const game = roomManager.createRoom();
  await roomManager.joinRoom(game.id, a.id, "game-a");
  await roomManager.joinRoom(game.id, b.id, "game-b");
  const deck = Array.from({ length: 60 }, (_, i) => card(i % 3 === 0 ? "Pikachu" : "Lightning Energy", `g${i}`));
  await roomManager.startGameWithRawDecks(game.id, deck, deck.map((x) => ({ ...x, id: `${x.id}b` })));
  // The match row createMatchGames opens, made to count (economy v2: turn >= 3, >= 2 minutes)
  await openRoomMatch(game, "draft");
  await prisma.match.update({ where: { id: game.matchId! }, data: { startedAt: new Date(Date.now() - 10 * 60_000) } });
  game.gameState = { ...game.gameState!, turnNumber: 5 };
  draftRoomManager.registerGameRoom(game.id, room.id, 1, 1, a.id, b.id);
  return { room: room as DraftRoom, game, a, b, c };
}

describe("bug 14: only a player of that game can forfeit it", () => {
  it("a third draft player's forfeit is rejected; the loser's is recorded once", async () => {
    const m = await draftMatch(true);
    const sc = await server.connect(tokenFor(m.c));
    sc.emit("draft:forfeit", { draftRoomId: m.room.id, gameRoomId: m.game.id });
    expect((await nextEvent<{ message: string }>(sc, "draft:error")).message).toBe("No juegas esta partida");
    expect(m.game.status).toBe("playing");
    expect(m.room.tournament!.rounds[0].results).toHaveLength(0);

    const sa = await server.connect(tokenFor(m.a));
    sa.emit("draft:forfeit", { draftRoomId: m.room.id, gameRoomId: m.game.id });
    await sleep(400);
    expect(m.game.status).toBe("finished");
    expect(m.room.tournament!.rounds[0].results).toMatchObject([{ winnerId: m.b.id, loserId: m.a.id }]);
    expect(m.room.phase).toBe("finished");

    // Again (or by the winner): the game is over
    sa.emit("draft:forfeit", { draftRoomId: m.room.id, gameRoomId: m.game.id });
    expect((await nextEvent<{ message: string }>(sa, "draft:error")).message).toBe("Partida de draft no encontrada");
    const surrender = nextEvent<any>(sa, "actionResult");
    sa.emit("action", { roomId: m.game.id, action: { type: "surrender", payload: {} } });
    expect((await surrender).success).toBe(false);

    await sleep(200);
    const [statsA, statsB, statsC] = await Promise.all(
      [m.a, m.b, m.c].map((u) => prisma.userStats.findUniqueOrThrow({ where: { userId: u.id } })),
    );
    expect(statsA).toMatchObject({ draftLosses: 1, draftWins: 0 });
    expect(statsB).toMatchObject({ draftWins: 1, draftLosses: 0 });
    expect(statsC).toMatchObject({ draftWins: 0, draftLosses: 0 });

    // bug 13: the tournament ended -> drafted cards credited (keepInCollection)
    const cardsA = await prisma.userCard.findMany({ where: { userId: m.a.id }, orderBy: { cardDefId: "asc" } });
    expect(cardsA.map((c) => [c.cardDefId, c.quantity])).toEqual([
      ["base-set-058-pikachu", 2],
      ["base-set-091-bill", 1],
    ]);
    const cardsB = await prisma.userCard.findMany({ where: { userId: m.b.id } });
    expect(cardsB.map((c) => [c.cardDefId, c.quantity])).toEqual([["base-set-046-charmander", 1]]);
  });
});

describe("bug 13: keepInCollection credits drafted cards once", () => {
  it("a second credit call (or another end path) adds nothing; without the option nothing is credited", async () => {
    const m = await draftMatch(true);
    await creditDraftedCards(m.room);
    await creditDraftedCards(m.room);
    const pikachu = await prisma.userCard.findUnique({ where: { userId_cardDefId: { userId: m.a.id, cardDefId: "base-set-058-pikachu" } } });
    expect(pikachu?.quantity).toBe(2);

    const off = await draftMatch(false);
    await creditDraftedCards(off.room);
    expect(await prisma.userCard.count({ where: { userId: off.a.id } })).toBe(0);
  });
});
