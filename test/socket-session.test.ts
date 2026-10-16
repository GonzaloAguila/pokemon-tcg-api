import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache, invalidateAccountState } from "../src/lib/account-state.js";
import * as adminService from "../src/modules/admin/admin.service.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor, waitForDisconnect } from "./socket-helpers.js";

let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  server = await startSocketServer();
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

// Exactly what LobbyPage emits (with a public theme deck so no DB deck is needed)
const lobbyCreateRoom = (userId: string) => ({
  userId,
  deckId: "brushfire",
  prizeCount: 6,
  betAmount: 0,
  friendly: true,
  reservedUserId: undefined,
  username: "spoofed-name",
  avatarId: null,
  titleId: "novato",
});

describe("socket payload validation over the wire", () => {
  it("the real lobby createRoom payload creates a room", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    socket.emit("createRoom", lobbyCreateRoom(user.id));
    const created = await nextEvent<{ roomId: string; isPlayer1: boolean }>(socket, "roomCreated");
    expect(created.isPlayer1).toBe(true);
    socket.emit("deleteRoom", { roomId: created.roomId });
    await nextEvent(socket, "roomDeleted");
  });

  it("a malformed createRoom gets an error instead of throwing deep inside", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    socket.emit("createRoom", { deckId: "brushfire", prizeCount: "6" });
    const err = await nextEvent<{ message: string }>(socket, "error");
    expect(err.message).toMatch(/inválid/i);
    socket.emit("createRoom", null);
    expect((await nextEvent<{ message: string }>(socket, "error")).message).toMatch(/inválid/i);
  });

  it("a malformed game action gets actionResult { success:false }", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    socket.emit("action", { roomId: "NOPE01", action: { type: "attack", payload: { attackIndex: "0" } } });
    const res = await nextEvent<{ success: boolean; error: string }>(socket, "actionResult");
    expect(res).toEqual({ success: false, error: expect.stringMatching(/inválid/i) });
    socket.emit("action", { roomId: "NOPE01" });
    expect((await nextEvent<{ success: boolean }>(socket, "actionResult")).success).toBe(false);
  });

  it("requestCoinFlip validates and always acks", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    const res = await socket.timeout(2000).emitWithAck("requestCoinFlip", { roomId: "NOPE01", purpose: "steal" });
    expect(res).toEqual({ success: false, error: expect.stringMatching(/inválid/i) });
  });

  it("draft events reject bad payloads with draft:error", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    socket.emit("draft:submitDeck", { roomId: "K7M2PQ", deckCardIds: Array(5000).fill("x"), energyCards: [] });
    expect((await nextEvent<{ message: string }>(socket, "draft:error")).message).toMatch(/inválid/i);
    socket.emit("draft:pick", { roomId: 42 });
    expect((await nextEvent<{ message: string }>(socket, "draft:error")).message).toMatch(/inválid/i);
  });
});

describe("session freshness on sockets", () => {
  it("a user banned by an admin is disconnected immediately", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    const gone = waitForDisconnect(socket);
    const admin = await createUser({}, { role: "admin" });
    await adminService.toggleUserBan(admin.id, user.id, true, "test");
    expect(await gone).toBe(true);
  });

  it("a banned account (changed outside the admin panel) is rejected and kicked on its next action", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    await prisma.user.update({ where: { id: user.id }, data: { status: "banned" } });
    invalidateAccountState(user.id); // what the cache TTL does on its own after a few seconds
    const gone = waitForDisconnect(socket);
    socket.emit("createRoom", lobbyCreateRoom(user.id));
    expect((await nextEvent<{ message: string }>(socket, "error")).message).toMatch(/deshabilitada/);
    expect(await gone).toBe(true);
  });

  it("a suspended account is rejected on game actions and chat", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "suspended", suspendedUntil: new Date(Date.now() + 3600_000) },
    });
    invalidateAccountState(user.id);
    const gone = waitForDisconnect(socket);
    socket.emit("action", { roomId: "NOPE01", action: { type: "endTurn", payload: {} } });
    const res = await nextEvent<{ success: boolean; error: string }>(socket, "actionResult");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/suspendida/);
    expect(await gone).toBe(true);
  });

  it("an admin suspension disconnects the user's sockets", async () => {
    const user = await createUser();
    const a = await server.connect(tokenFor(user));
    const b = await server.connect(tokenFor(user));
    const goneA = waitForDisconnect(a);
    const goneB = waitForDisconnect(b);
    const admin = await createUser({}, { role: "admin" });
    await adminService.suspendUser(admin.id, user.id, 24, "test");
    expect(await goneA).toBe(true);
    expect(await goneB).toBe(true);
  });

  it("an expired suspension doesn't block", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "suspended", suspendedUntil: new Date(Date.now() - 1000) },
    });
    const socket = await server.connect(tokenFor(user));
    socket.emit("createRoom", lobbyCreateRoom(user.id));
    const created = await nextEvent<{ roomId: string }>(socket, "roomCreated");
    socket.emit("deleteRoom", { roomId: created.roomId });
    await nextEvent(socket, "roomDeleted");
  });

  it("a deleted account is rejected on draft events and kicked", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    await prisma.user.delete({ where: { id: user.id } });
    invalidateAccountState(user.id);
    const gone = waitForDisconnect(socket);
    socket.emit("draft:join", { roomId: "K7M2PQ" });
    expect((await nextEvent<{ message: string }>(socket, "draft:error")).message).toMatch(/no encontrado/i);
    expect(await gone).toBe(true);
  });

  it("a deleted account is kicked on global chat", async () => {
    const user = await createUser();
    const socket = await server.connect(tokenFor(user));
    socket.emit("globalChat:join");
    await prisma.user.delete({ where: { id: user.id } });
    invalidateAccountState(user.id);
    const gone = waitForDisconnect(socket);
    socket.emit("globalChat:message", { content: "hola", type: "text" });
    expect(await gone).toBe(true);
  });

  it("does NOT kick a player whose access token expired mid-game", async () => {
    const user = await createUser();
    const shortToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion },
      process.env.JWT_SECRET!,
      { expiresIn: 1 },
    );
    const socket = await server.connect(shortToken);
    await new Promise((r) => setTimeout(r, 1500)); // token is now expired
    socket.emit("createRoom", lobbyCreateRoom(user.id));
    const created = await nextEvent<{ roomId: string }>(socket, "roomCreated");
    expect(socket.connected).toBe(true);
    socket.emit("deleteRoom", { roomId: created.roomId });
    await nextEvent(socket, "roomDeleted");
  });

  it("a revoked token (old tokenVersion) can't authenticate a new socket", async () => {
    const user = await createUser();
    const oldToken = tokenFor(user);
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    invalidateAccountState(user.id);
    const socket = await server.connect(oldToken);
    socket.emit("createRoom", lobbyCreateRoom(user.id));
    expect((await nextEvent<{ message: string }>(socket, "error")).message).toMatch(/Autenticación requerida/);
  });
});
