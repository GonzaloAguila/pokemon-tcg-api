/**
 * Backoffice fixes from the 2026-10 admin review: pack CRUD removed, moderation hierarchy,
 * deleting users (welcome message FK, live games), ban vs suspension, dashboard windows, wallet
 * rows of admin adjustments, message validation, user search validation, card / stat / cosmetic
 * adjustments, trade revert cleanup, force-closing rooms.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_CARDS } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { adminRouter } from "../src/modules/admin/admin.controller.js";
import { messagingRouter } from "../src/modules/messaging/messaging.controller.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import * as adminService from "../src/modules/admin/admin.service.js";
import * as trades from "../src/modules/trades/trades.service.js";
import { registerUser } from "../src/modules/auth/auth.service.js";
import { startOfEconomyDay, startOfEconomyWeek } from "../src/modules/economy/economy-time.js";
import { closeRoomByAdmin, roomManager } from "../src/socket/handlers.js";
import { draftRoomManager } from "../src/socket/draft-handlers.js";
import { createUser, race } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;
let superadmin: Awaited<ReturnType<typeof createUser>>;
let moderator: Awaited<ReturnType<typeof createUser>>;
let superToken: string;
let modToken: string;

const ALL_USER_PERMS = ["users:view", "users:moderate", "users:economy", "users:cards", "users:stats", "users:delete", "messages:send", "messages:view", "dashboard:view"];

beforeAll(async () => {
  http = await startHttpApp((app) => {
    app.use("/api", adminRouter);
    app.use("/api", messagingRouter);
    app.use("/api", boostersRouter);
  });
  superadmin = await createUser({}, { role: "superadmin" });
  moderator = await createUser({}, { role: "admin", permissions: ALL_USER_PERMS });
  superToken = tokenFor(superadmin);
  modToken = tokenFor(moderator);
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

const req = (token: string) => ({
  get: (path: string) => http.request("GET", path, { token }),
  post: (path: string, body: unknown) => http.request("POST", path, { token, body }),
  patch: (path: string, body: unknown) => http.request("PATCH", path, { token, body }),
  put: (path: string, body: unknown) => http.request("PUT", path, { token, body }),
  del: (path: string) => http.request("DELETE", path, { token }),
});

async function registered() {
  const tag = Math.random().toString(36).slice(2, 10);
  const { user } = await registerUser({
    email: `adm-${tag}@example.com`,
    username: `adm_${tag}`,
    password: "Sup3r-secret-pass!",
  });
  return user;
}

describe("pack definitions are read-only", () => {
  it("the admin CRUD routes are gone, the read routes stay", async () => {
    const api = req(superToken);
    expect((await api.post("/api/packs", { id: "x", name: "x", setId: "base-set", slots: [] })).status).toBe(404);
    expect((await api.put("/api/packs/base-set-booster", { price: 0 })).status).toBe(404);
    expect((await api.del("/api/packs/base-set-booster")).status).toBe(404);
    const pack = await api.get("/api/packs/base-set-booster");
    expect(pack.status).toBe(200);
    expect(pack.body.price).toBeGreaterThan(0);
    expect((await api.get("/api/packs")).status).toBe(200);
  });
});

describe("moderation hierarchy", () => {
  it("nobody bans, suspends or adjusts the superadmin", async () => {
    const other = await createUser({}, { role: "superadmin" });
    for (const api of [req(modToken), req(superToken)]) {
      expect((await api.patch(`/api/admin/users/${other.id}/ban`, { banned: true })).status).toBe(403);
      expect((await api.post(`/api/admin/users/${other.id}/suspend`, { hours: 1 })).status).toBe(403);
      expect((await api.post(`/api/admin/users/${other.id}/adjust-coins`, { amount: 5, reason: "x" })).status).toBe(403);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("active");
  });

  it("an admin can't act on another admin; the superadmin can", async () => {
    const target = await createUser({ coins: 10 }, { role: "admin" });
    const mod = req(modToken);
    const res = await mod.patch(`/api/admin/users/${target.id}/ban`, { banned: true });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/superadmin/);
    expect((await mod.post(`/api/admin/users/${target.id}/suspend`, { hours: 1 })).status).toBe(403);
    expect((await mod.post(`/api/admin/users/${target.id}/adjust-coins`, { amount: -5, reason: "x" })).status).toBe(403);
    expect((await mod.post(`/api/admin/users/${target.id}/adjust-cards`, { cards: [{ cardDefId: "base-set-058-pikachu", quantity: 1 }] })).status).toBe(403);
    expect((await mod.post(`/api/admin/users/${target.id}/adjust-stats`, { field: "normalWins", amount: 1 })).status).toBe(403);
    expect((await mod.post(`/api/admin/users/${target.id}/grant-cosmetic`, { type: "coin", itemId: "charizard" })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).coins).toBe(10);

    expect((await req(superToken).patch(`/api/admin/users/${target.id}/ban`, { banned: true })).status).toBe(200);
  });

  it("an admin still moderates regular players", async () => {
    const player = await createUser();
    expect((await req(modToken).patch(`/api/admin/users/${player.id}/ban`, { banned: true })).status).toBe(200);
  });
});

describe("deleting a user", () => {
  it("deletes an account created through registration (its welcome message points at itself)", async () => {
    const user = await registered();
    expect(await prisma.systemMessage.count({ where: { senderId: user.id, recipientId: user.id } })).toBe(1);
    await adminService.adjustCoins(user.id, 5, "regalo", superadmin.id); // an admin notice to them too
    await expect(adminService.deleteUser(superadmin.id, user.id)).resolves.toEqual({ success: true });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.systemMessage.count({ where: { recipientId: user.id } })).toBe(0);
  });

  it("over HTTP too (was a 500)", async () => {
    const user = await registered();
    expect((await req(superToken).del(`/api/admin/users/${user.id}`)).status).toBe(200);
  });

  it("keeps an ex-admin's broadcasts, attributed to the admin deleting the account", async () => {
    const exAdmin = await createUser();
    const msg = await prisma.systemMessage.create({
      data: { type: "broadcast", title: "t", content: "c", senderId: exAdmin.id },
    });
    await adminService.deleteUser(superadmin.id, exAdmin.id);
    expect((await prisma.systemMessage.findUniqueOrThrow({ where: { id: msg.id } })).senderId).toBe(superadmin.id);
  });

  it("refuses while the user holds a seat in a game room", async () => {
    const user = await createUser();
    const room = roomManager.createRoom();
    room.player1Id = user.id;
    try {
      const res = await req(superToken).del(`/api/admin/users/${user.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe("El usuario está en una partida o draft en curso");
    } finally {
      roomManager.forceDeleteRoom(room.id);
    }
    expect((await req(superToken).del(`/api/admin/users/${user.id}`)).status).toBe(200);
  });

  it("refuses while the user is in a draft", async () => {
    const user = await createUser();
    const draft = draftRoomManager.createRoom({ adminPlays: true }, user.id, "sock-x", user.username);
    try {
      await expect(adminService.deleteUser(superadmin.id, user.id)).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      draftRoomManager.deleteRoom(draft.id, superadmin.id, true);
    }
  });
});

describe("ban vs suspension", () => {
  it("a banned user can't be suspended (the ban would become a timed suspension)", async () => {
    const user = await createUser();
    const api = req(superToken);
    expect((await api.patch(`/api/admin/users/${user.id}/ban`, { banned: true })).status).toBe(200);
    expect((await api.post(`/api/admin/users/${user.id}/suspend`, { hours: 1 })).status).toBe(409);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe("banned");
    expect(row.suspendedUntil).toBeNull();
  });
});

describe("dashboard stats", () => {
  it("day and week follow the economy calendar, month is 30 days, no period is all-time", async () => {
    const api = req(superToken);
    const day = await api.get("/api/admin/stats?period=day");
    expect(day.status).toBe(200);
    expect(day.body.period).toBe("day");
    expect(new Date(day.body.since).getTime()).toBe(startOfEconomyDay().getTime());
    const week = await api.get("/api/admin/stats?period=week");
    expect(new Date(week.body.since).getTime()).toBe(startOfEconomyWeek().getTime());
    const month = await api.get("/api/admin/stats?period=month");
    expect(Date.now() - new Date(month.body.since).getTime()).toBeGreaterThanOrEqual(30 * 86_400_000 - 60_000);

    const all = await api.get("/api/admin/stats");
    expect(all.body).toMatchObject({ period: "all", since: null });
    expect(all.body.activeUsers).toBe(
      await prisma.user.count({ where: { OR: [{ lastLoginAt: { not: null } }, { refreshSessions: { some: {} } }] } }),
    );
    expect((await api.get("/api/admin/stats?period=all")).body.period).toBe("all");
    expect((await api.get("/api/admin/stats?period=year")).status).toBe(400);
  });

  it("active users: whoever logged in OR came back with a saved session in the period, once each", async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    const session = (userId: string, lastUsedAt: Date) =>
      prisma.refreshSession.create({ data: { userId, tokenHash: `hash-${userId}-${lastUsedAt.getTime()}`, lastUsedAt, expiresAt: daysAgo(-30) } });
    const before = (await adminService.getAdminStats("day")).activeUsers;
    // Logged in days ago, back today with the saved session: active today
    const returning = await createUser();
    await prisma.user.update({ where: { id: returning.id }, data: { lastLoginAt: daysAgo(3) } });
    await session(returning.id, new Date());
    // Logged in today and used the session today too: counted once
    const fresh = await createUser();
    await prisma.user.update({ where: { id: fresh.id }, data: { lastLoginAt: new Date() } });
    await session(fresh.id, new Date());
    // Only came back two days ago: not active today
    const away = await createUser();
    await session(away.id, daysAgo(2));
    expect((await adminService.getAdminStats("day")).activeUsers).toBe(before + 2);
  });

  it("'Mensajes enviados' and the admin list leave out welcome messages", async () => {
    const user = await registered();
    const welcome = await prisma.systemMessage.findFirstOrThrow({ where: { senderId: user.id, recipientId: user.id } });
    const sent = await adminService.getAdminStats();
    const welcomes = await prisma.systemMessage.count({
      where: { recipientId: { not: null }, senderId: { equals: prisma.systemMessage.fields.recipientId } },
    });
    expect(sent.totalMessages).toBe((await prisma.systemMessage.count()) - welcomes);
    const list = await req(superToken).get("/api/admin/messages?limit=100");
    expect(list.body.data.some((m: { id: string }) => m.id === welcome.id)).toBe(false);
    expect(list.body.total).toBe(sent.totalMessages);
  });
});

describe("player-visible wallet rows", () => {
  it("balance adjustments say 'Ajuste del equipo', never the admin's id", async () => {
    const user = await createUser({ coins: 50 });
    await adminService.adjustCoins(user.id, -20, "corrección", superadmin.id);
    const [row] = await prisma.transaction.findMany({ where: { userId: user.id } });
    expect(row.description).toBe("Ajuste del equipo: -20 monedas. Razón: corrección");
    expect(row.description).not.toContain(superadmin.id);
  });

  it("card and stat adjustments write no wallet row", async () => {
    const user = await createUser();
    await adminService.adjustCards(user.id, [{ cardDefId: "base-set-058-pikachu", quantity: 2 }], superadmin.id);
    await adminService.adjustStats(user.id, "normalWins", 2, superadmin.id);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("admin messages", () => {
  it("validates the body and drops client metadata", async () => {
    const api = req(superToken);
    const player = await createUser();
    const ok = { type: "personal", title: "Hola", content: "Texto", category: "info", recipientId: player.id };
    expect((await api.post("/api/admin/messages", { ...ok, category: "spam" })).status).toBe(400);
    expect((await api.post("/api/admin/messages", { ...ok, type: "everyone" })).status).toBe(400);
    expect((await api.post("/api/admin/messages", { ...ok, title: "" })).status).toBe(400);
    expect((await api.post("/api/admin/messages", { ...ok, title: "x".repeat(201) })).status).toBe(400);
    expect((await api.post("/api/admin/messages", { ...ok, content: "x".repeat(2001) })).status).toBe(400);
    expect((await api.post("/api/admin/messages", { ...ok, recipientId: "not-a-uuid" })).status).toBe(400);
    expect((await api.post("/api/admin/messages", { ...ok, recipientId: undefined })).status).toBe(400);
    const created = await api.post("/api/admin/messages", { ...ok, metadata: { coins: 99999 } });
    expect(created.status).toBe(200);
    expect((await prisma.systemMessage.findUniqueOrThrow({ where: { id: created.body.id } })).metadata).toBeNull();
    const broadcast = await api.post("/api/admin/messages", { type: "broadcast", title: "Aviso", content: "Texto" });
    expect(broadcast.status).toBe(200);
    expect(broadcast.body.category).toBe("info");
    await prisma.systemMessage.deleteMany({ where: { id: broadcast.body.id } });
    expect((await api.patch(`/api/admin/messages/${created.body.id}`, { category: "spam" })).status).toBe(400);
    expect((await api.patch(`/api/admin/messages/${created.body.id}`, {})).status).toBe(400);
    expect((await api.patch(`/api/admin/messages/${created.body.id}`, { title: "Nuevo" })).status).toBe(200);
  });

  it("welcome messages can't be edited or deleted", async () => {
    const user = await registered();
    const welcome = await prisma.systemMessage.findFirstOrThrow({ where: { senderId: user.id, recipientId: user.id } });
    const api = req(superToken);
    expect((await api.patch(`/api/admin/messages/${welcome.id}`, { title: "x" })).status).toBe(403);
    expect((await api.del(`/api/admin/messages/${welcome.id}`)).status).toBe(403);
    expect(await prisma.systemMessage.findUnique({ where: { id: welcome.id } })).not.toBeNull();
  });

  it("deleting a news notice un-notifies its post", async () => {
    const msg = await prisma.systemMessage.create({
      data: { type: "broadcast", title: "Novedad", content: "c", category: "news", senderId: superadmin.id },
    });
    const post = await prisma.newsPost.create({ data: { title: "Post", body: "b", notificationId: msg.id } });
    expect((await req(superToken).del(`/api/admin/messages/${msg.id}`)).status).toBe(200);
    expect((await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } })).notificationId).toBeNull();
  });
});

describe("admin user search", () => {
  it.each([
    "role=owner",
    "q=a&q=b",
    `q=${"a".repeat(101)}`,
    "page=0",
    "page=10001",
    "page=abc",
    "limit=0",
    "limit=51",
    "sortBy=passwordHash",
    "sortDir=up",
  ])("?%s is a 400", async (query) => {
    expect((await req(superToken).get(`/api/admin/users?${query}`)).status).toBe(400);
  });

  it("accepts what the panel sends", async () => {
    const res = await req(superToken).get("/api/admin/users?q=&page=1&limit=10&role=user&sortBy=coins&sortDir=asc");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 10 });
    expect((await req(superToken).get("/api/admin/users")).body).toMatchObject({ page: 1, limit: 20 });
  });
});

describe("card adjustments", () => {
  it("rejects unknown cards", async () => {
    const user = await createUser();
    const res = await req(superToken).post(`/api/admin/users/${user.id}/adjust-cards`, {
      cards: [{ cardDefId: "base-set-999-missingno", quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(await prisma.userCard.count({ where: { userId: user.id } })).toBe(0);
  });

  it("removals delete empty rows and revalidate the decks that used the card", async () => {
    const user = await createUser();
    await prisma.userCard.create({ data: { userId: user.id, cardDefId: "base-set-058-pikachu", quantity: 2 } });
    const deck = await prisma.deck.create({
      data: { userId: user.id, name: "d", isValid: true, cards: [{ cardDefId: "base-set-058-pikachu", quantity: 2 }] },
    });
    const { results } = await adminService.adjustCards(user.id, [{ cardDefId: "base-set-058-pikachu", quantity: -5 }], superadmin.id);
    expect(results).toEqual([{ cardDefId: "base-set-058-pikachu", newQuantity: 0 }]);
    expect(await prisma.userCard.count({ where: { userId: user.id } })).toBe(0);
    expect((await prisma.deck.findUniqueOrThrow({ where: { id: deck.id } })).isValid).toBe(false);
  });
});

describe("stat adjustments", () => {
  it("concurrent decrements never go below zero", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.userStats.update({ where: { userId: user.id }, data: { normalWins: 3 } });
    const { fulfilled, rejected } = await race(8, () => adminService.adjustStats(user.id, "normalWins", -1, superadmin.id));
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    expect((await prisma.userStats.findUniqueOrThrow({ where: { userId: user.id } })).normalWins).toBe(0);
  });
});

describe("cosmetic grants", () => {
  it.each([
    ["coin", "pokeball"],
    ["coin", "eevee"],
    ["cardBack", "default"],
    ["avatar", "pkmn-pikachu"],
    ["avatar", "collector"],
    ["skin", "pikachu-holo"],
    ["playmat", "field"],
  ])("rejects %s %s", async (type, itemId) => {
    const user = await createUser();
    const res = await req(superToken).post(`/api/admin/users/${user.id}/grant-cosmetic`, { type, itemId });
    expect(res.status).toBe(400);
    expect(await prisma.systemMessage.count({ where: { recipientId: user.id } })).toBe(0);
  });

  it.each([
    ["coin", "charizard"],
    ["coin", "golem"],
    ["cardBack", "haymaker"],
    ["cardBack", "set-jungle"],
    ["avatar", "snorlax"],
    ["skin", "charizard-gold"],
    ["playmat", "stadium"],
  ])("grants %s %s with its notice", async (type, itemId) => {
    const user = await createUser();
    const res = await req(superToken).post(`/api/admin/users/${user.id}/grant-cosmetic`, { type, itemId });
    expect(res.status).toBe(200);
    expect(await prisma.systemMessage.count({ where: { recipientId: user.id } })).toBe(1);
    const again = await req(superToken).post(`/api/admin/users/${user.id}/grant-cosmetic`, { type, itemId });
    expect(again.status).toBe(400);
    expect(await prisma.systemMessage.count({ where: { recipientId: user.id } })).toBe(1);
  });

  it("the superadmin grants a cosmetic to their own account (no notice)", async () => {
    const res = await req(superToken).post(`/api/admin/users/${superadmin.id}/grant-cosmetic`, { type: "coin", itemId: "red" });
    expect(res.status).toBe(200);
    expect(await prisma.userCoin.count({ where: { userId: superadmin.id, coinId: "red" } })).toBe(1);
    expect(await prisma.systemMessage.count({ where: { recipientId: superadmin.id, title: "Nuevo cosmético concedido" } })).toBe(0);
  });

  it("an admin still can't grant cosmetics to themselves", async () => {
    const res = await req(modToken).post(`/api/admin/users/${moderator.id}/grant-cosmetic`, { type: "coin", itemId: "red" });
    expect(res.status).toBe(403);
    expect(await prisma.userCoin.count({ where: { userId: moderator.id } })).toBe(0);
  });

  // Owner decision 2026-10-20: the superadmin may adjust their own balances (test/admin-self-adjust.test.ts), never moderate themselves
  it("the superadmin still can't ban or suspend themselves", async () => {
    expect((await req(superToken).patch(`/api/admin/users/${superadmin.id}/ban`, { banned: true })).status).toBe(403);
    expect((await req(superToken).post(`/api/admin/users/${superadmin.id}/suspend`, { hours: 1 })).status).toBe(403);
  });
});

describe("trade revert", () => {
  it("deletes the rows it empties and revalidates the decks", async () => {
    const pokemonOf = (rarity: string) => ALL_CARDS.find((c) => c.kind === "pokemon" && c.rarity === rarity)!.id;
    const RARE = pokemonOf("rare");
    const HOLO = pokemonOf("rare-holo");
    const trader = async (cards: Record<string, number>) => {
      const user = await createUser({ coins: 500 }, { stats: true });
      await prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
      await prisma.userStats.update({ where: { userId: user.id }, data: { normalWins: 20 } });
      for (const [cardDefId, quantity] of Object.entries(cards)) {
        await prisma.userCard.create({ data: { userId: user.id, cardDefId, quantity } });
      }
      return user;
    };
    const a = await trader({ [HOLO]: 2 });
    const b = await trader({ [RARE]: 4 });
    const tradeId = await trades.executeTrade(
      { userId: a.id, cards: [{ cardDefId: HOLO, quantity: 1 }], ip: null },
      { userId: b.id, cards: [{ cardDefId: RARE, quantity: 3 }], ip: null },
    );
    const deck = await prisma.deck.create({
      data: { userId: b.id, name: "d", isValid: true, cards: [{ cardDefId: HOLO, quantity: 1 }] },
    });
    await trades.revertTrade(superadmin.id, tradeId);
    expect(await prisma.userCard.findUnique({ where: { userId_cardDefId: { userId: b.id, cardDefId: HOLO } } })).toBeNull();
    expect(await prisma.userCard.findUnique({ where: { userId_cardDefId: { userId: a.id, cardDefId: RARE } } })).toBeNull();
    expect((await prisma.deck.findUniqueOrThrow({ where: { id: deck.id } })).isValid).toBe(false);
  });
});

describe("force-closing a room", () => {
  it("tells the whole socket room (spectators too), empties it and refreshes the lobbies", () => {
    const calls: unknown[][] = [];
    const io = {
      to: (target: string) => ({ emit: (event: string, payload: unknown) => calls.push(["to", target, event, payload]) }),
      in: (target: string) => ({ socketsLeave: (room: string) => calls.push(["leave", target, room]) }),
      emit: (event: string) => calls.push(["all", event]),
    };
    const room = roomManager.createRoom();
    expect(closeRoomByAdmin(io as never, room.id)).toBe(true);
    expect(roomManager.getRoom(room.id)).toBeUndefined();
    expect(calls).toEqual([
      ["to", room.id, "gameClosed", { roomId: room.id, reason: "Mesa cerrada por un administrador" }],
      ["to", room.id, "roomDeleted", { roomId: room.id }],
      ["leave", room.id, room.id],
      ["all", "roomList"],
    ]);
    expect(closeRoomByAdmin(io as never, room.id)).toBe(false);
  });
});

describe("match history (GET /admin/matches)", () => {
  it("lists played games newest first with players, winner and bet, filtered by player and mode", async () => {
    const ash = await createUser();
    const misty = await createUser();
    await prisma.match.create({
      data: { mode: "normal", status: "finished", player1Id: ash.id, player2Id: misty.id, winnerId: misty.id, winReason: "prizes", betAmount: 50, player1Xp: 10, player2Xp: 30, createdAt: new Date("2026-10-18T12:00:00Z") },
    });
    await prisma.match.create({
      data: { mode: "ai", gameMode: "lucky-duel", status: "finished", player1Id: ash.id, winnerId: ash.id, betAmount: 20, createdAt: new Date("2026-10-19T12:00:00Z") },
    });

    const res = await req(superToken).get(`/api/admin/matches?q=${ash.username}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, limit: 10 });
    expect(res.body.data[0]).toMatchObject({ mode: "ai", gameMode: "lucky-duel", betAmount: 20, winner: { username: ash.username } });
    expect(res.body.data[1]).toMatchObject({
      mode: "normal",
      player1: { username: ash.username },
      player2: { username: misty.username },
      winner: { username: misty.username },
      winReason: "prizes",
      betAmount: 50,
    });

    const luckyOnly = await req(superToken).get(`/api/admin/matches?q=${ash.username}&mode=lucky-duel`);
    expect(luckyOnly.body.total).toBe(1);
    const before19 = await req(superToken).get(`/api/admin/matches?q=${ash.username}&to=2026-10-19`);
    expect(before19.body.data.map((m: { mode: string }) => m.mode)).toEqual(["normal"]);
  });

  it("needs rooms:view and rejects unknown modes", async () => {
    expect((await req(modToken).get("/api/admin/matches")).status).toBe(403);
    expect((await req(superToken).get("/api/admin/matches?mode=ranked")).status).toBe(400);
  });
});
