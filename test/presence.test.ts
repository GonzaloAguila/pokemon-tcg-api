import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache, invalidateAccountState } from "../src/lib/account-state.js";
import { presenceRouter } from "../src/modules/presence/presence.controller.js";
import { clearRegisteredCountCache } from "../src/modules/presence/presence.service.js";
import {
  getChatPresence,
  getOnlineCount,
  joinChatPresence,
  leaveChatPresence,
  resetPresence,
  trackOnline,
  untrackOnline,
  type ChatPresencePayload,
} from "../src/socket/presence.js";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { nextEvent, startSocketServer, tokenFor, waitForDisconnect } from "./socket-helpers.js";

let server: Awaited<ReturnType<typeof startSocketServer>>;
let http: Awaited<ReturnType<typeof startHttpApp>>;
const open: ClientSocket[] = [];

beforeAll(async () => {
  server = await startSocketServer();
  http = await startHttpApp((app) => app.use("/api", presenceRouter));
});

afterAll(async () => {
  await server.close();
  await http.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Disconnect what the previous test left and wait for the server to see it
  for (const s of open.splice(0)) s.disconnect();
  await waitFor(() => server.io.sockets.sockets.size === 0);
  resetPresence();
  clearAccountStateCache();
  clearRegisteredCountCache();
});

async function connect(token?: string) {
  const socket = await server.connect(token);
  open.push(socket);
  return socket;
}

/** Poll until `check` holds (server-side disconnects are asynchronous). */
async function waitFor(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Resolve with the first chat:presence payload that satisfies `match`. */
function presenceWhere(socket: ClientSocket, match: (p: ChatPresencePayload) => boolean, ms = 3000) {
  return new Promise<ChatPresencePayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("chat:presence", handler);
      reject(new Error("timed out waiting for chat:presence"));
    }, ms);
    const handler = (payload: ChatPresencePayload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off("chat:presence", handler);
      resolve(payload);
    };
    socket.on("chat:presence", handler);
  });
}

const ids = (p: ChatPresencePayload) => p.users.map((u) => u.id).sort();

describe("presence registry", () => {
  it("counts a user once across sockets and removes them on the last disconnect", () => {
    trackOnline("u1", "s1");
    trackOnline("u1", "s2");
    trackOnline("u2", "s3");
    expect(getOnlineCount()).toBe(2);
    untrackOnline("u1", "s1");
    expect(getOnlineCount()).toBe(2);
    untrackOnline("u1", "s2");
    expect(getOnlineCount()).toBe(1);
    untrackOnline("u1", "s2"); // twice is a no-op
    expect(getOnlineCount()).toBe(1);
  });

  it("chat list: changes only on the first join, a new identity and the last leave", () => {
    const user = { id: "u1", username: "ash", activeAvatarId: null, role: "user" as const };
    expect(joinChatPresence("s1", user)).toBe(true);
    expect(joinChatPresence("s2", user)).toBe(false);
    expect(joinChatPresence("s2", { ...user, activeAvatarId: "pikachu" })).toBe(true);
    expect(getChatPresence()).toEqual({ users: [{ ...user, activeAvatarId: "pikachu" }], count: 1 });
    expect(leaveChatPresence("u1", "s1")).toBe(false);
    expect(leaveChatPresence("u1", "s1")).toBe(false);
    expect(leaveChatPresence("u1", "s2")).toBe(true);
    expect(getChatPresence()).toEqual({ users: [], count: 0 });
  });
});

describe("online users over sockets", () => {
  it("a user with two sockets counts once; leaves on the last disconnect", async () => {
    const user = await createUser();
    const other = await createUser();
    const a1 = await connect(tokenFor(user));
    const a2 = await connect(tokenFor(user));
    await connect(tokenFor(other));
    await connect(); // anonymous: never counted
    await waitFor(() => getOnlineCount() === 2);

    a1.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(getOnlineCount()).toBe(2);
    a2.disconnect();
    await waitFor(() => getOnlineCount() === 1);
  });

  it("a banned account's token connects anonymously and isn't counted", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "banned" } });
    await connect(tokenFor(user));
    await new Promise((r) => setTimeout(r, 100));
    expect(getOnlineCount()).toBe(0);
  });
});

describe("GET /api/presence", () => {
  it("returns { online, registered } without caching headers", async () => {
    const user = await createUser();
    await connect(tokenFor(user));
    await connect(tokenFor(user));
    await waitFor(() => getOnlineCount() === 1);

    const registered = await prisma.user.count({ where: { status: { not: "banned" } } });
    const res = await http.request("GET", "/api/presence");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: 1, registered });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("registered excludes banned accounts and is cached", async () => {
    const before = (await http.request("GET", "/api/presence")).body.registered as number;
    const banned = await createUser();
    await prisma.user.update({ where: { id: banned.id }, data: { status: "banned" } });
    await createUser();
    // Cached: the new account isn't counted yet
    expect((await http.request("GET", "/api/presence")).body.registered).toBe(before);
    clearRegisteredCountCache();
    expect((await http.request("GET", "/api/presence")).body.registered).toBe(before + 1);
  });
});

describe("global chat presence", () => {
  it("lists users on join, once per user, and broadcasts leaves", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await prisma.user.update({ where: { id: bob.id }, data: { activeAvatarId: "pikachu" } });

    const a = await connect(tokenFor(alice));
    const aJoined = presenceWhere(a, (p) => p.count === 1);
    a.emit("globalChat:join");
    expect(ids(await aJoined)).toEqual([alice.id]);

    // Bob joins: everyone gets the new list
    const b1 = await connect(tokenFor(bob));
    const aSeesBob = presenceWhere(a, (p) => p.count === 2);
    const bJoined = presenceWhere(b1, () => true);
    b1.emit("globalChat:join");
    const list = await aSeesBob;
    expect(ids(list)).toEqual([alice.id, bob.id].sort());
    expect(ids(await bJoined)).toEqual([alice.id, bob.id].sort());
    const bobEntry = list.users.find((u) => u.id === bob.id)!;
    // Public identity only
    expect(bobEntry).toEqual({ id: bob.id, username: bob.username, activeAvatarId: "pikachu", role: "user" });

    // A second tab of Bob: it gets the list, Bob isn't listed twice, Alice gets nothing new
    let aliceUpdates = 0;
    a.on("chat:presence", () => aliceUpdates++);
    const b2 = await connect(tokenFor(bob));
    const b2Joined = presenceWhere(b2, () => true);
    b2.emit("globalChat:join");
    expect((await b2Joined).count).toBe(2);

    // Closing one tab keeps Bob listed; closing the last removes him
    b1.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    expect(aliceUpdates).toBe(0);
    expect(getChatPresence().count).toBe(2);

    const aSeesBobLeave = presenceWhere(a, (p) => p.count === 1);
    b2.emit("globalChat:leave");
    expect(ids(await aSeesBobLeave)).toEqual([alice.id]);
  });

  it("an anonymous reader gets the list but isn't in it", async () => {
    const alice = await createUser();
    const a = await connect(tokenFor(alice));
    const aJoined = presenceWhere(a, () => true);
    a.emit("globalChat:join");
    await aJoined;

    const anon = await connect();
    const anonJoined = presenceWhere(anon, () => true);
    anon.emit("globalChat:join");
    expect(ids(await anonJoined)).toEqual([alice.id]);
    expect(getChatPresence().count).toBe(1);
  });

  it("a user banned after connecting is kicked on join and never listed", async () => {
    const watcher = await createUser();
    const w = await connect(tokenFor(watcher));
    const wJoined = presenceWhere(w, () => true);
    w.emit("globalChat:join");
    await wJoined;

    const user = await createUser();
    const socket = await connect(tokenFor(user));
    await prisma.user.update({ where: { id: user.id }, data: { status: "banned" } });
    invalidateAccountState(user.id);
    const gone = waitForDisconnect(socket);
    socket.emit("globalChat:join");
    expect((await nextEvent<{ message: string }>(socket, "error")).message).toMatch(/deshabilitada/);
    expect(await gone).toBe(true);
    expect(ids(getChatPresence())).toEqual([watcher.id]);
    await waitFor(() => getOnlineCount() === 1);
  });

  it("a listed user who disconnects (e.g. kicked by a ban) leaves the list", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const a = await connect(tokenFor(alice));
    const aJoined = presenceWhere(a, () => true);
    a.emit("globalChat:join");
    await aJoined;
    const b = await connect(tokenFor(bob));
    const aSeesBob = presenceWhere(a, (p) => p.count === 2);
    b.emit("globalChat:join");
    await aSeesBob;

    const aSeesBobGone = presenceWhere(a, (p) => p.count === 1);
    server.io.in(`user:${bob.id}`).disconnectSockets(true);
    expect(ids(await aSeesBobGone)).toEqual([alice.id]);
  });
});
