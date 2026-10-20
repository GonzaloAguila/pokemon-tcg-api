/**
 * Lobby tables:
 * - a user may have one waiting table per mode ("standard", "lucky-duel"); a second one of the
 *   same mode is refused
 * - when a table gets a rival (or the user takes a seat elsewhere) the user's other waiting
 *   tables close (`roomDeleted`)
 * - joining your own table is a reconnect to your seat, never the rival's seat
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { ALL_CARDS, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { deckAveragePoints, rankForAverage, rankForCards } from "../src/modules/decks/deck-rank.js";
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

type Any = Record<string, any>;

async function player() {
  const user = await createUser({}, { stats: true });
  return { user, socket: await server.connect(tokenFor(user)) };
}

async function createTable(socket: ClientSocket, payload: Any): Promise<string> {
  const created = nextEvent<{ roomId: string }>(socket, "roomCreated");
  socket.emit("createRoom", payload);
  return (await created).roomId;
}

const STANDARD = { deckId: "brushfire", prizeCount: 6 };
const LUCKY = { mode: "lucky-duel" };

describe("one waiting table per mode", () => {
  it("a standard and a Lucky Duel table at once; a second one of a mode is refused", async () => {
    const a = await player();
    const standard = await createTable(a.socket, STANDARD);
    const lucky = await createTable(a.socket, LUCKY);
    expect(roomManager.findWaitingRoomsByUser(a.user.id).map((r) => r.id).sort()).toEqual([standard, lucky].sort());

    const refused = nextEvent<{ message: string }>(a.socket, "error");
    a.socket.emit("createRoom", { ...STANDARD, deckId: "overgrowth" });
    expect((await refused).message).toBe("Ya tienes una mesa esperando rival");

    const refusedLucky = nextEvent<{ message: string }>(a.socket, "error");
    a.socket.emit("createRoom", LUCKY);
    expect((await refusedLucky).message).toBe("Ya tienes una mesa de Lucky Duel esperando rival");
    expect(roomManager.findWaitingRoomsByUser(a.user.id)).toHaveLength(2);

    // Deleting one frees its mode
    const deleted = nextEvent<{ roomId: string }>(a.socket, "roomDeleted");
    a.socket.emit("deleteRoom", { roomId: standard });
    expect((await deleted).roomId).toBe(standard);
    const again = await createTable(a.socket, STANDARD);
    expect(roomManager.getRoom(again)?.config.mode).toBe("standard");
  });

  it("a rival at one table closes the creator's other one", async () => {
    const a = await player();
    const b = await player();
    const standard = await createTable(a.socket, STANDARD);
    const lucky = await createTable(a.socket, LUCKY);

    const closed = nextEvent<{ roomId: string }>(a.socket, "roomDeleted");
    const started = Promise.all([nextEvent<Any>(a.socket, "gameStart"), nextEvent<Any>(b.socket, "gameStart")]);
    b.socket.emit("joinRoom", { roomId: lucky });
    expect((await closed).roomId).toBe(standard);
    await started;
    expect(roomManager.getRoom(standard)).toBeUndefined();
    expect(roomManager.getRoom(lucky)?.status).toBe("playing");
    expect(roomManager.findWaitingRoomsByUser(a.user.id)).toEqual([]);
  });

  it("taking a seat at someone else's table closes the joiner's own waiting tables", async () => {
    const a = await player();
    const b = await player();
    const bTable = await createTable(b.socket, STANDARD);
    const aLucky = await createTable(a.socket, LUCKY);

    const closed = nextEvent<{ roomId: string }>(b.socket, "roomDeleted");
    const started = Promise.all([nextEvent<Any>(a.socket, "gameStart"), nextEvent<Any>(b.socket, "gameStart")]);
    b.socket.emit("joinRoom", { roomId: aLucky });
    expect((await closed).roomId).toBe(bTable);
    await started;
    expect(roomManager.getRoom(bTable)).toBeUndefined();
  });

  it("the creator never takes the rival's seat of their own table", async () => {
    const a = await player();
    const lucky = await createTable(a.socket, LUCKY);
    const otherTab = await server.connect(tokenFor(a.user));

    const joined = nextEvent<Any>(otherTab, "roomJoined");
    otherTab.emit("joinRoom", { roomId: lucky });
    expect(await joined).toMatchObject({ roomId: lucky, isPlayer1: true });
    const room = roomManager.getRoom(lucky)!;
    expect(room.status).toBe("waiting");
    expect(room.player2Id).toBeNull();
    expect(room.players).toEqual([a.user.id]);
  });

  it("a creator who leaves the lobby leaves both tables (hidden, then deleted)", async () => {
    const a = await player();
    const standard = await createTable(a.socket, STANDARD);
    const lucky = await createTable(a.socket, LUCKY);
    a.socket.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    const listed = roomManager.getActiveRooms().map((r) => r.id);
    expect(listed).not.toContain(standard);
    expect(listed).not.toContain(lucky);
  });
});

describe("deck rank F–S", () => {
  it("average points per card without basic Energy, against ECONOMY.lobby.deckRank", () => {
    const commons = ALL_CARDS.filter((c) => c.rarity === "common" && !isBasicEnergy(c)).slice(0, 20).map((c) => c.id);
    const holos = ALL_CARDS.filter((c) => c.rarity === "rare-holo").slice(0, 20).map((c) => c.id);
    const energy = ALL_CARDS.find((c) => isBasicEnergy(c))!.id;
    expect(deckAveragePoints([...commons, ...Array(20).fill(energy)])).toBe(3);
    expect(rankForCards(commons)).toBe("F");
    expect(rankForCards(holos)).toBe("S");
    expect(rankForCards([energy])).toBeNull();
    expect(rankForAverage(4.5)).toBe("D");
    expect(rankForAverage(11)).toBe("A");
  });

  it("the lobby lists a low and a high theme deck's rank (Lucky Duel: null), never the deck", async () => {
    const a = await player();
    const b = await player();
    const low = await createTable(a.socket, { deckId: "blackout", prizeCount: 6 });
    const listed = nextEvent<{ rooms: Any[] }>(a.socket, "roomList");
    const high = await createTable(b.socket, { deckId: "thunderstorm", prizeCount: 6 });
    const lucky = await createTable(a.socket, LUCKY);
    const rooms = (await listed).rooms;
    expect(rooms.find((r) => r.id === low)?.deckRank).toBe("D");
    expect(rooms.find((r) => r.id === high)?.deckRank).toBe("A");
    const list = nextEvent<{ rooms: Any[] }>(a.socket, "roomList");
    a.socket.emit("getRooms");
    const all = (await list).rooms;
    expect(all.find((r) => r.id === lucky)?.deckRank).toBeNull();
    for (const r of all) {
      expect(r).not.toHaveProperty("deckId");
      expect(r).not.toHaveProperty("deckName");
    }
  });
});

describe("myRooms: the creator's own tables with their deck", () => {
  it("after create and delete, on getMyRooms, and empty once a game starts", async () => {
    const a = await player();
    const b = await player();
    const first = nextEvent<{ rooms: Any[] }>(a.socket, "myRooms");
    const standard = await createTable(a.socket, { deckId: "blackout", prizeCount: 5 });
    expect((await first).rooms).toEqual([
      { id: standard, mode: "standard", deckId: "blackout", deckName: expect.any(String), prizeCount: 5, betAmount: 0, deckRank: "D" },
    ]);

    const both = nextEvent<{ rooms: Any[] }>(a.socket, "myRooms");
    const lucky = await createTable(a.socket, LUCKY);
    expect((await both).rooms.map((r) => r.id).sort()).toEqual([standard, lucky].sort());

    // A reloaded lobby (another socket) asks for them
    const reloaded = await server.connect(tokenFor(a.user));
    const asked = nextEvent<{ rooms: Any[] }>(reloaded, "myRooms");
    reloaded.emit("getMyRooms");
    expect((await asked).rooms.find((r) => r.id === lucky)).toEqual({
      id: lucky, mode: "lucky-duel", deckId: null, deckName: null, prizeCount: 0, betAmount: 0, deckRank: null,
    });
    // The deck name is the theme deck's
    expect((await asked).rooms.find((r) => r.id === standard)?.deckName).toBe("Blackout");

    // A rival at the Lucky Duel table: the standard one closes, nothing is left
    const started = Promise.all([nextEvent<Any>(a.socket, "gameStart"), nextEvent<Any>(b.socket, "gameStart")]);
    const lists: Any[][] = [];
    a.socket.on("myRooms", (p: { rooms: Any[] }) => lists.push(p.rooms));
    b.socket.emit("joinRoom", { roomId: lucky });
    await started;
    await new Promise((r) => setTimeout(r, 100));
    expect(lists.at(-1)).toEqual([]);
    a.socket.off("myRooms");
  });
});
