/**
 * Persistent lobby tables (owner, 2026-10-21: "cuando doy refresh o salgo de ese lugar se cierran;
 * deberíamos mantenerlas"):
 * - a waiting table survives its creator's lobby socket (reload, another page, dropped
 *   connection); it is listed and joinable while the creator is online anywhere (any socket:
 *   the frontend's presence socket), hidden while they are offline, and closes after
 *   WAITING_TABLE_OFFLINE_TTL_MS offline or WAITING_TABLE_IDLE_TTL_MS without being opened
 * - a rival who sits while the creator is away waits for them: the creator gets `tableJoined` on
 *   every socket and the game (and the bet) starts when they open the table; after
 *   CREATOR_RESPONSE_MS the rival may claim the victory (`claimNoShowVictory`, a no-show forfeit)
 * - a rival who sits while the creator is at the table starts the game at once (+ `tableJoined`)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import {
  CREATOR_RESPONSE_MS,
  GameRoomManager,
  NoShowClaimError,
  WAITING_TABLE_IDLE_TTL_MS,
  WAITING_TABLE_OFFLINE_TTL_MS,
} from "../src/socket/rooms.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { createUser, getBalances } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

type Any = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── GameRoomManager level ────────────────────────────────────────────────────

describe("waiting table TTLs (sweepRooms)", () => {
  it("an offline creator's table closes after the offline TTL, not before", async () => {
    const manager = new GameRoomManager(undefined, { isUserOnline: () => false });
    const closed: [string, string][] = [];
    manager.setOnRoomClosed((id, _room, reason) => closed.push([id, reason]));
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    await manager.handleDisconnect("lobby-1");
    const left = room.creatorSeenAt!;

    manager.sweepRooms(left + WAITING_TABLE_OFFLINE_TTL_MS - 1000);
    expect(manager.getRoom(room.id)).toBeDefined();
    manager.sweepRooms(left + WAITING_TABLE_OFFLINE_TTL_MS + 1000);
    expect(manager.getRoom(room.id)).toBeUndefined();
    expect(closed).toEqual([[room.id, "offline"]]);
  });

  it("an online creator's table stays past the offline TTL and closes after the idle TTL; opening it restarts that", async () => {
    const manager = new GameRoomManager(undefined, { isUserOnline: () => true });
    const closed: [string, string][] = [];
    manager.setOnRoomClosed((id, _room, reason) => closed.push([id, reason]));
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    await manager.handleDisconnect("lobby-1"); // on another page: still online
    const t0 = room.touchedAt!;

    manager.sweepRooms(t0 + WAITING_TABLE_OFFLINE_TTL_MS + 1000);
    expect(manager.getRoom(room.id)).toBeDefined();
    expect(manager.getActiveRooms().map((r) => r.id)).toEqual([room.id]);

    // The creator opens it again: the idle TTL counts from now
    await manager.joinRoom(room.id, "creator", "lobby-2");
    const t1 = room.touchedAt!;
    expect(t1).toBeGreaterThanOrEqual(t0);
    manager.sweepRooms(t1 + WAITING_TABLE_IDLE_TTL_MS - 1000);
    expect(manager.getRoom(room.id)).toBeDefined();
    manager.sweepRooms(t1 + WAITING_TABLE_IDLE_TTL_MS + 1000);
    expect(manager.getRoom(room.id)).toBeUndefined();
    expect(closed).toEqual([[room.id, "idle"]]);
  });

  it("a table whose rival waits for the creator is spared during the creator's window", async () => {
    const manager = new GameRoomManager(undefined, { isUserOnline: () => true, creatorResponseMs: 60_000 });
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    await manager.handleDisconnect("lobby-1");
    room.touchedAt = Date.now() - WAITING_TABLE_IDLE_TTL_MS - 1000; // idle long ago
    await manager.joinRoom(room.id, "joiner", "sock-j");
    expect(manager.isAwaitingCreator(room)).toBe(true);
    manager.sweepRooms();
    expect(manager.getRoom(room.id)).toBeDefined();
    manager.expireAwaitingCreator(room.id);
    manager.sweepRooms();
    expect(manager.getRoom(room.id)).toBeUndefined();
  });
});

describe("a rival at an away creator's table (GameRoomManager)", () => {
  it("waits (not listed, no start), may claim only after the window, and the creator's arrival ends the wait", async () => {
    const manager = new GameRoomManager(undefined, { isUserOnline: () => true, creatorResponseMs: 60_000 });
    const claimable: string[] = [];
    manager.setOnNoShowClaimable((r) => claimable.push(r.id));
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    await manager.handleDisconnect("lobby-1");
    await manager.joinRoom(room.id, "joiner", "sock-j");

    expect(manager.isAwaitingCreator(room)).toBe(true);
    expect(room.awaitingCreator!.expiresAt - room.awaitingCreator!.joinedAt).toBe(60_000);
    expect(manager.getActiveRooms()).toHaveLength(0);
    expect(() => manager.claimNoShow(room.id, "joiner")).toThrow(NoShowClaimError);
    expect(() => manager.claimNoShow(room.id, "creator")).toThrow("No estás esperando en esta mesa");
    await expect(manager.joinRoom(manager.createRoom().id, "joiner", "sock-j")).rejects.toThrow("Ya estás esperando al creador de otra mesa");

    // The creator opens the table in time: no more waiting, nothing to claim
    await manager.joinRoom(room.id, "creator", "lobby-2");
    expect(manager.isAwaitingCreator(room)).toBe(false);
    expect(manager.isRoomReady(room.id)).toBe(true);
    expect(manager.expireAwaitingCreator(room.id)).toBe(false);
    expect(claimable).toEqual([]);
    expect(() => manager.claimNoShow(room.id, "joiner")).toThrow("El creador ya llegó a la mesa");
  });

  it("the window's end makes it claimable; a rival who disconnects frees the seat instead", async () => {
    const manager = new GameRoomManager(undefined, { isUserOnline: () => true, creatorResponseMs: 60_000 });
    const claimable: string[] = [];
    const cancelled: string[] = [];
    manager.setOnNoShowClaimable((r) => claimable.push(r.id));
    manager.setOnJoinCancelled((r, joiner) => cancelled.push(`${r.id}:${joiner}`));
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    await manager.handleDisconnect("lobby-1");
    await manager.joinRoom(room.id, "joiner", "sock-j");
    expect(manager.expireAwaitingCreator(room.id)).toBe(true);
    expect(claimable).toEqual([room.id]);
    expect(manager.claimNoShow(room.id, "joiner")).toBe(room);
    expect(room.startPending).toBe(true);
    manager.finishNoShow(room);
    expect(manager.getRoom(room.id)).toBeUndefined();

    const other = manager.createRoom();
    await manager.joinRoom(other.id, "creator", "lobby-3");
    await manager.handleDisconnect("lobby-3");
    await manager.joinRoom(other.id, "joiner2", "sock-j2");
    await manager.handleDisconnect("sock-j2");
    expect(cancelled).toEqual([`${other.id}:joiner2`]);
    expect(other.player2Id).toBeNull();
    expect(other.awaitingCreator).toBeUndefined();
    expect(manager.getActiveRooms().map((r) => r.id)).toEqual([other.id]);
  });
});

// ── Over real sockets (production handlers) ──────────────────────────────────

let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  server = await startSocketServer();
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

/** A player allowed to bet at Lucky Duel tables: verified email and 20 online games. */
async function veteran(coins = 100) {
  const user = await createUser({ coins });
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  await prisma.userStats.create({ data: { userId: user.id, normalWins: 10, normalLosses: 10 } });
  return user;
}

async function coinsOf(userId: string) {
  return (await getBalances(userId)).coins;
}

async function roomList(socket: ClientSocket): Promise<Any[]> {
  const list = nextEvent<{ rooms: Any[] }>(socket, "roomList");
  socket.emit("getRooms");
  return (await list).rooms;
}

/** Collect every payload of `event` on `socket`. */
function collect<T = Any>(socket: ClientSocket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => seen.push(payload));
  return seen;
}

/** Poll until `check` stops throwing (settlement runs in the background). */
async function eventually(check: () => Promise<void> | void, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > until) throw err;
      await sleep(50);
    }
  }
}

/**
 * A creator with a presence socket (always on, like LayoutWrapper's) and a lobby socket that
 * opens a table and then goes away (reload / another page).
 */
async function awayCreatorTable(payload: Any, creator?: Awaited<ReturnType<typeof createUser>>) {
  const user = creator ?? (await createUser({}, { stats: true }));
  const presence = await server.connect(tokenFor(user));
  const lobby = await server.connect(tokenFor(user));
  const created = nextEvent<{ roomId: string }>(lobby, "roomCreated");
  lobby.emit("createRoom", payload);
  const { roomId } = await created;
  lobby.disconnect();
  await sleep(100);
  return { user, presence, roomId };
}

describe("a table survives a refresh / leaving the lobby", () => {
  it("stays listed while the creator is online elsewhere; a reloaded lobby gets it back (myRooms, attachMyRooms)", async () => {
    const watcherUser = await createUser({}, { stats: true });
    const watcher = await server.connect(tokenFor(watcherUser));
    const { user, presence, roomId } = await awayCreatorTable({ deckId: "brushfire", prizeCount: 6 });

    expect(roomManager.getRoom(roomId)).toBeDefined();
    expect((await roomList(watcher)).map((r) => r.id)).toContain(roomId);

    // The page reloads: the new socket gets its tables (sent on connect, and on getMyRooms)
    const lobby2 = await server.connect(tokenFor(user));
    const asked = nextEvent<{ rooms: Any[] }>(lobby2, "myRooms");
    lobby2.emit("getMyRooms");
    expect((await asked).rooms).toEqual([expect.objectContaining({ id: roomId, attached: false, opponent: null, joinExpiresAt: null })]);

    const attached = nextEvent<{ rooms: Any[] }>(lobby2, "myRooms");
    lobby2.emit("attachMyRooms");
    expect((await attached).rooms).toEqual([expect.objectContaining({ id: roomId, attached: true })]);
    expect(roomManager.getRoom(roomId)!.player1SocketId).toBe(lobby2.id);

    // The creator goes fully offline: hidden, kept; back online: listed again
    presence.disconnect();
    lobby2.disconnect();
    await sleep(150);
    expect(roomManager.getRoom(roomId)).toBeDefined();
    expect((await roomList(watcher)).map((r) => r.id)).not.toContain(roomId);
    const back = await server.connect(tokenFor(user));
    await sleep(100);
    expect((await roomList(watcher)).map((r) => r.id)).toContain(roomId);

    // Only the creator closes it
    const deleted = nextEvent<{ roomId: string }>(back, "roomDeleted");
    back.emit("deleteRoom", { roomId });
    expect(await deleted).toEqual({ roomId });
    expect(roomManager.getRoom(roomId)).toBeUndefined();
  });

  it("the idle TTL closes it and tells the creator on every socket (tableClosed)", async () => {
    const { presence, roomId } = await awayCreatorTable({ mode: "lucky-duel" });
    const closed = nextEvent<Any>(presence, "tableClosed");
    const room = roomManager.getRoom(roomId)!;
    roomManager.sweepRooms(room.touchedAt! + WAITING_TABLE_IDLE_TTL_MS + 1000);
    expect(await closed).toEqual({ roomId, mode: "lucky-duel", reason: "idle", message: "Tu mesa se cerró: pasaron 60 minutos sin rival" });
    expect(roomManager.getRoom(roomId)).toBeUndefined();
  });
});

describe("joining a table whose creator is away", () => {
  it("the rival waits, the creator is alerted everywhere, and the game (and the bet) starts when the creator opens it", async () => {
    const creator = await veteran(100);
    const joinerUser = await veteran(100);
    const { presence, roomId } = await awayCreatorTable({ mode: "lucky-duel", betAmount: 30 }, creator);
    const joiner = await server.connect(tokenFor(joinerUser));
    const joinerStarts = collect(joiner, "gameStart");

    const alert = nextEvent<Any>(presence, "tableJoined");
    const waiting = nextEvent<Any>(joiner, "waitingForCreator");
    joiner.emit("joinRoom", { roomId });
    const tableJoined = await alert;
    expect(tableJoined).toMatchObject({
      roomId,
      mode: "lucky-duel",
      opponentUsername: joinerUser.username,
      betAmount: 30,
      prizeCount: 0,
      creatorPresent: false,
    });
    expect(tableJoined.expiresAt - Date.now()).toBeGreaterThan(CREATOR_RESPONSE_MS - 5000);
    expect(await waiting).toMatchObject({ roomId, mode: "lucky-duel", creatorUsername: creator.username, betAmount: 30, expiresAt: tableJoined.expiresAt });

    // Nothing started, nobody charged, no match yet; the table left the list
    await sleep(200);
    expect(joinerStarts).toHaveLength(0);
    expect(await coinsOf(creator.id)).toBe(100);
    expect(await coinsOf(joinerUser.id)).toBe(100);
    expect(await prisma.match.count({ where: { roomId } })).toBe(0);
    expect((await roomList(joiner)).map((r) => r.id)).not.toContain(roomId);
    const mine = nextEvent<{ rooms: Any[] }>(presence, "myRooms");
    presence.emit("getMyRooms");
    expect((await mine).rooms[0]).toMatchObject({ id: roomId, opponent: { username: joinerUser.username }, joinExpiresAt: tableJoined.expiresAt });

    // A claim before the window ends is refused
    const early = await new Promise<Any>((resolve) => joiner.emit("claimNoShowVictory", { roomId }, resolve));
    expect(early).toEqual({ success: false, code: "NO_SHOW_CLAIM_REFUSED", error: "Todavía no puedes reclamar la victoria: el creador aún tiene tiempo" });

    // The creator clicks "Ir a la batalla": the game page joins the table
    const gamePage = await server.connect(tokenFor(creator));
    const ended = nextEvent<Any>(presence, "tableJoinEnded");
    const started = Promise.all([nextEvent<Any>(gamePage, "gameStart"), nextEvent<Any>(joiner, "gameStart")]);
    gamePage.emit("joinRoom", { roomId });
    const [s1, s2] = await started;
    expect(s1).toMatchObject({ roomId, isPlayer1: true });
    expect(s2).toMatchObject({ roomId, isPlayer1: false });
    expect(await ended).toEqual({ roomId, reason: "started" });
    expect(await coinsOf(creator.id)).toBe(70);
    expect(await coinsOf(joinerUser.id)).toBe(70);
    expect(roomManager.getRoom(roomId)!.status).toBe("playing");
  });

  it("after the window the rival claims the victory: the creator loses (no-show), the bet goes to the rival, the creator is told", async () => {
    const creator = await veteran(100);
    const joinerUser = await veteran(100);
    const { presence, roomId } = await awayCreatorTable({ mode: "lucky-duel", betAmount: 40 }, creator);
    const joiner = await server.connect(tokenFor(joinerUser));
    const waiting = nextEvent<Any>(joiner, "waitingForCreator");
    joiner.emit("joinRoom", { roomId });
    await waiting;

    const claimable = nextEvent<Any>(joiner, "noShowClaimable");
    roomManager.expireAwaitingCreator(roomId); // the window ran out
    expect(await claimable).toEqual({
      roomId,
      creatorUsername: creator.username,
      betAmount: 40,
      message: `${creator.username} no se presentó: puedes reclamar la victoria`,
    });

    // Someone else can't claim it
    const intruder = await server.connect(tokenFor(await createUser({}, { stats: true })));
    expect(await new Promise<Any>((resolve) => intruder.emit("claimNoShowVictory", { roomId }, resolve))).toMatchObject({
      success: false,
      error: "No estás esperando en esta mesa",
    });

    const forfeited = nextEvent<Any>(presence, "tableForfeited");
    const victory = nextEvent<Any>(joiner, "noShowVictory");
    const joinerSettled = nextEvent<Any>(joiner, "matchSettled");
    const creatorSettled = nextEvent<Any>(presence, "matchSettled");
    const ack = await new Promise<Any>((resolve) => joiner.emit("claimNoShowVictory", { roomId }, resolve));
    expect(ack).toEqual({ success: true });
    expect(await forfeited).toEqual({
      roomId,
      mode: "lucky-duel",
      betAmount: 40,
      opponentUsername: joinerUser.username,
      message: `No te presentaste a tu mesa: ${joinerUser.username} reclamó la victoria`,
    });
    expect(await victory).toMatchObject({ roomId, betAmount: 40, opponentUsername: creator.username });
    expect(await joinerSettled).toMatchObject({ outcome: "win", betAmount: 40, coinsDelta: 40 });
    // The absent creator's loss pays nothing (no match coins, XP or missions)
    expect(await creatorSettled).toMatchObject({ outcome: "loss", betAmount: 40, coinsDelta: -40, rewardCoins: 0, xpGained: 0 });
    expect(roomManager.getRoom(roomId)).toBeUndefined();

    await eventually(async () => {
      const match = await prisma.match.findFirstOrThrow({ where: { roomId } });
      expect(match).toMatchObject({ status: "finished", winnerId: joinerUser.id, betAmount: 40 });
      expect(match.winReason).toContain("no se presentó");
    });
    // The pot, and a counted win for the rival (match coins, win mission); nothing for the creator
    expect(await coinsOf(creator.id)).toBe(60);
    const winMission = ECONOMY.missions.daily.find((m) => m.id === "win_game")!.rewardCoins;
    expect(await coinsOf(joinerUser.id)).toBe(140 + ECONOMY.matchCoins.online.win + winMission);

    // The creator coming back finds nothing
    const late = await server.connect(tokenFor(creator));
    const gone = nextEvent<Any>(late, "error");
    late.emit("joinRoom", { roomId });
    expect(await gone).toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  it("the creator can still come in after the window while the rival hasn't claimed", async () => {
    const { user, presence, roomId } = await awayCreatorTable({ deckId: "brushfire", prizeCount: 6 });
    const joinerUser = await createUser({}, { stats: true });
    const joiner = await server.connect(tokenFor(joinerUser));
    const waiting = nextEvent<Any>(joiner, "waitingForCreator");
    joiner.emit("joinRoom", { roomId, deckId: "overgrowth" });
    await waiting;
    roomManager.expireAwaitingCreator(roomId);

    // From the lobby (attachMyRooms) this time
    const lobby = await server.connect(tokenFor(user));
    const started = Promise.all([nextEvent<Any>(lobby, "gameStart"), nextEvent<Any>(joiner, "gameStart")]);
    lobby.emit("attachMyRooms");
    await started;
    expect(roomManager.getRoom(roomId)!.status).toBe("playing");
    const late = await new Promise<Any>((resolve) => joiner.emit("claimNoShowVictory", { roomId }, resolve));
    expect(late).toMatchObject({ success: false, error: "La mesa ya no existe" });
    void presence;
  });

  it("a rival who leaves reopens the table and the creator's alert is withdrawn", async () => {
    const { presence, roomId } = await awayCreatorTable({ deckId: "brushfire", prizeCount: 6 });
    const joinerUser = await createUser({}, { stats: true });
    const joiner = await server.connect(tokenFor(joinerUser));
    const waiting = nextEvent<Any>(joiner, "waitingForCreator");
    joiner.emit("joinRoom", { roomId, deckId: "overgrowth" });
    await waiting;

    const ended = nextEvent<Any>(presence, "tableJoinEnded");
    joiner.emit("leaveRoom", { roomId });
    expect(await ended).toEqual({ roomId, reason: "opponent-left" });
    const room = roomManager.getRoom(roomId)!;
    expect(room.player2Id).toBeNull();
    expect((await roomList(presence)).map((r) => r.id)).toContain(roomId);
  });

  it("the creator closing the table releases the waiting rival", async () => {
    const { user, roomId } = await awayCreatorTable({ deckId: "brushfire", prizeCount: 6 });
    const joinerUser = await createUser({}, { stats: true });
    const joiner = await server.connect(tokenFor(joinerUser));
    const waiting = nextEvent<Any>(joiner, "waitingForCreator");
    joiner.emit("joinRoom", { roomId, deckId: "overgrowth" });
    await waiting;

    const lobby = await server.connect(tokenFor(user));
    const released = nextEvent<Any>(joiner, "waitingForCreatorEnded");
    lobby.emit("deleteRoom", { roomId });
    expect(await released).toEqual({ roomId, reason: "table-closed", message: "El creador cerró la mesa" });
    expect(roomManager.getRoom(roomId)).toBeUndefined();
  });
});

describe("joining a table whose creator is at it (unchanged flow)", () => {
  it("the game starts at once and the creator's other sockets get tableJoined (creatorPresent)", async () => {
    const creator = await createUser({}, { stats: true });
    const presence = await server.connect(tokenFor(creator));
    const lobby = await server.connect(tokenFor(creator));
    const created = nextEvent<{ roomId: string }>(lobby, "roomCreated");
    lobby.emit("createRoom", { deckId: "brushfire", prizeCount: 6 });
    const { roomId } = await created;

    const joinerUser = await createUser({}, { stats: true });
    const joiner = await server.connect(tokenFor(joinerUser));
    const waitingSeen = collect(joiner, "waitingForCreator");
    const alert = nextEvent<Any>(presence, "tableJoined");
    const started = Promise.all([nextEvent<Any>(lobby, "gameStart"), nextEvent<Any>(joiner, "gameStart")]);
    joiner.emit("joinRoom", { roomId, deckId: "overgrowth" });
    await started;
    expect(await alert).toMatchObject({ roomId, mode: "standard", opponentUsername: joinerUser.username, creatorPresent: true, expiresAt: null });
    expect(waitingSeen).toHaveLength(0);
    expect(await prisma.match.count({ where: { roomId } })).toBe(1);
  });
});
