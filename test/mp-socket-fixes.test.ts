/**
 * Regression tests over real sockets (production handlers) for the 2026-10-14 multiplayer bugs:
 * 1  every game state carries awaitingUserId
 * 4  after the game is over no action is accepted and the result is recorded once
 * 9  joinRoom on a missing room answers ROOM_NOT_FOUND and creates nothing; a seat needs a deck
 * 10 a waiting room disappears from the list when its creator leaves; the creator deletes it
 *    from a new lobby socket
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { ALL_CARDS } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { createUser } from "./helpers.js";
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

/** Collect every payload of `event` on `socket`. */
function collect<T = any>(socket: ClientSocket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => seen.push(payload));
  return seen;
}

async function roomList(socket: ClientSocket): Promise<{ id: string }[]> {
  socket.emit("getRooms");
  return (await nextEvent<{ rooms: { id: string }[] }>(socket, "roomList")).rooms;
}

async function startGame() {
  const p1 = await createUser({}, { stats: true });
  const p2 = await createUser({}, { stats: true });
  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  s1.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 0 });
  const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
  const start1 = nextEvent<any>(s1, "gameStart");
  const start2 = nextEvent<any>(s2, "gameStart");
  s2.emit("joinRoom", { roomId, deckId: "overgrowth" });
  return { p1, p2, s1, s2, roomId, start1: await start1, start2: await start2 };
}

describe("bug 9: joinRoom never creates a room; a seat needs a deck", () => {
  it("an unknown room id answers ROOM_NOT_FOUND and nothing is listed", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    // What MultiplayerGamePage sends on reconnect (no deck)
    socket.emit("joinRoom", { roomId: "GONE11", userId: "spoofed" });
    const err = await nextEvent<{ code?: string; message: string }>(socket, "error");
    expect(err).toEqual({ code: "ROOM_NOT_FOUND", message: "La partida ya no existe" });
    expect(roomManager.getRoom("GONE11")).toBeUndefined();
    expect((await roomList(socket)).find((r) => r.id === "GONE11")).toBeUndefined();
  });

  it("creating or taking a seat without a deck is rejected; reconnecting to your seat needs none", async () => {
    const creator = await createUser();
    const joiner = await createUser();
    const sc = await server.connect(tokenFor(creator));
    const sj = await server.connect(tokenFor(joiner));

    sc.emit("createRoom", { prizeCount: 6 });
    expect((await nextEvent<{ message: string }>(sc, "error")).message).toBe("Debes elegir un mazo");
    sc.emit("createRoom", { deckId: "no-such-theme", prizeCount: 6 });
    expect((await nextEvent<{ message: string }>(sc, "error")).message).toBe("Mazo no encontrado");

    sc.emit("createRoom", { deckId: "brushfire", prizeCount: 6 });
    const { roomId } = await nextEvent<{ roomId: string }>(sc, "roomCreated");
    sj.emit("joinRoom", { roomId });
    expect((await nextEvent<{ message: string }>(sj, "error")).message).toBe("Debes elegir un mazo");
    expect(roomManager.getRoom(roomId)?.player2Id).toBeNull();

    // The creator from another tab: a reconnect, no deck needed
    const sc2 = await server.connect(tokenFor(creator));
    sc2.emit("joinRoom", { roomId });
    expect(await nextEvent<{ isPlayer1: boolean }>(sc2, "roomJoined")).toMatchObject({ isPlayer1: true });
    sc2.emit("deleteRoom", { roomId });
    await nextEvent(sc2, "roomDeleted");
  });
});

describe("bug 10: a waiting room whose creator left the lobby", () => {
  it("leaves the room list at once, can't be joined, and its creator deletes it from a new socket", async () => {
    const creator = await createUser();
    const other = await createUser();
    const lobby1 = await server.connect(tokenFor(creator));
    const watcher = await server.connect(tokenFor(other));
    lobby1.emit("createRoom", { deckId: "brushfire", prizeCount: 6, friendly: true });
    const { roomId } = await nextEvent<{ roomId: string }>(lobby1, "roomCreated");
    expect((await roomList(watcher)).map((r) => r.id)).toContain(roomId);

    lobby1.disconnect(); // the creator closes the lobby tab
    await sleep(150);
    expect((await roomList(watcher)).map((r) => r.id)).not.toContain(roomId);
    watcher.emit("joinRoom", { roomId, deckId: "overgrowth" });
    expect((await nextEvent<{ message: string }>(watcher, "error")).message).toBe("El creador de la mesa no está conectado");

    // Back in the lobby with a new socket: the creator closes it by user id
    const lobby2 = await server.connect(tokenFor(creator));
    lobby2.emit("deleteRoom", { roomId });
    expect(await nextEvent<{ roomId: string }>(lobby2, "roomDeleted")).toEqual({ roomId });
    expect(roomManager.getRoom(roomId)).toBeUndefined();
  });
});

describe("bug 1: game states carry awaitingUserId", () => {
  it("gameStart and gameState include the awaited player's user id", async () => {
    const g = await startGame();
    // Opening: nobody ready yet
    expect(g.start1.gameState).toHaveProperty("awaitingUserId", null);
    expect(g.start2.gameState).toHaveProperty("awaitingUserId", null);

    // P1 places a Basic and gets ready: now the game waits on P2
    const room = roomManager.getRoom(g.roomId)!;
    const charmander = ALL_CARDS.find((c) => c.name === "Charmander")!;
    room.gameState = { ...room.gameState!, playerHand: [{ ...charmander, id: "forced-basic" }, ...room.gameState!.playerHand] };
    g.s1.emit("action", { roomId: g.roomId, action: { type: "playBasicToActive", payload: { cardId: "forced-basic" } } });
    expect((await nextEvent<any>(g.s1, "actionResult")).success).toBe(true);
    const states = nextEvent<any>(g.s2, "gameState");
    g.s1.emit("action", { roomId: g.roomId, action: { type: "playerReady", payload: {} } });
    expect((await nextEvent<any>(g.s1, "actionResult")).success).toBe(true);
    expect((await states).gameState.awaitingUserId).toBe(g.p2.id);
    g.s1.emit("action", { roomId: g.roomId, action: { type: "surrender", payload: {} } });
    await nextEvent(g.s1, "gameOver");
  });
});

describe("bug 4: a finished game takes no more actions and its result is recorded once", () => {
  it("the winner's later surrender and the loser's promote are rejected; one gameOver, one recorded result", async () => {
    const g = await startGame();
    const overs1 = collect(g.s1, "gameOver");
    const overs2 = collect(g.s2, "gameOver");

    g.s2.emit("action", { roomId: g.roomId, action: { type: "surrender", payload: {} } });
    expect((await nextEvent<any>(g.s2, "actionResult")).success).toBe(true);
    await sleep(100);

    for (const [socket, type, payload] of [
      [g.s1, "surrender", {}], // the winner "surrenders" after the end
      [g.s2, "surrender", {}],
      [g.s2, "promote", { benchIndex: 0 }],
    ] as const) {
      socket.emit("action", { roomId: g.roomId, action: { type, payload } });
      expect(await nextEvent<any>(socket, "actionResult")).toEqual({ success: false, error: "La partida ya terminó" });
    }
    await sleep(300);

    expect(overs1).toEqual([{ winner: "player1", reason: "Player 1 wins!" }]);
    expect(overs2).toHaveLength(1);
    const [winner, loser] = await Promise.all([
      prisma.userStats.findUniqueOrThrow({ where: { userId: g.p1.id } }),
      prisma.userStats.findUniqueOrThrow({ where: { userId: g.p2.id } }),
    ]);
    expect(winner).toMatchObject({ normalWins: 1, normalLosses: 0 });
    expect(loser).toMatchObject({ normalWins: 0, normalLosses: 1 });
  });
});
