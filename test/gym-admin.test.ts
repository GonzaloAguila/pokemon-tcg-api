/**
 * Gym Leaders backoffice (src/modules/gym/gym.controller.ts): GET /api/admin/gyms, POST
 * /api/admin/gyms/:leaderId/open | close. Permission users:economy, superadmin always; plus the
 * card back catalog entry (not grantable in v1) and grantMedal's first-time flag.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { gymAdminRouter } from "../src/modules/gym/gym.controller.js";
import { gymService } from "../src/modules/gym/gym.service.js";
import { BROCK } from "../src/modules/gym/content/brock.js";
import { GYM_LEADER_CARD_BACKS } from "../src/modules/prizes/catalog.js";
import { GRANTABLE_COSMETICS } from "../src/modules/admin/grantable-cosmetics.js";
import { grantMedal } from "../src/modules/users/users.service.js";
import { createUser } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;
let superToken: string;
let economyToken: string;
let roomsToken: string;
let userToken: string;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", gymAdminRouter));
  superToken = tokenFor(await createUser({}, { role: "superadmin" }));
  economyToken = tokenFor(await createUser({}, { role: "admin", permissions: ["users:economy"] }));
  roomsToken = tokenFor(await createUser({}, { role: "admin", permissions: ["rooms:view", "rooms:close"] }));
  userToken = tokenFor(await createUser());
});

afterEach(() => gymService.reset());

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

describe("gym admin endpoints", () => {
  it("only the superadmin and admins with users:economy", async () => {
    expect((await http.request("GET", "/api/admin/gyms")).status).toBe(401);
    expect((await http.request("GET", "/api/admin/gyms", { token: userToken })).status).toBe(403);
    expect((await http.request("GET", "/api/admin/gyms", { token: roomsToken })).status).toBe(403);
    expect((await http.request("POST", "/api/admin/gyms/brock/open", { token: roomsToken, body: {} })).status).toBe(403);
    expect((await http.request("GET", "/api/admin/gyms", { token: economyToken })).status).toBe(200);
    expect((await http.request("GET", "/api/admin/gyms", { token: superToken })).status).toBe(200);
  });

  it("GET lists every leader with its status and the scheduler", async () => {
    const res = await http.request("GET", "/api/admin/gyms", { token: superToken });
    expect(res.body.gyms).toEqual([
      {
        leaderId: "brock",
        name: "Brock",
        title: "Líder del Gimnasio de Ciudad Plateada",
        avatarId: "gym-brock",
        mode: "normal",
        modes: ["normal"],
        status: "closed",
        openedAt: null,
        closesAt: null,
        queueLength: 0,
        queue: [],
        current: null,
        inBattle: false,
        schedule: { enabled: false, nextOpenAt: null, minGapMinutes: 120, maxGapMinutes: 360, openMinutes: 45 },
      },
    ]);
  });

  it("open (default 45 min or the minutes sent), the queue with usernames, close", async () => {
    const before = Date.now();
    const opened = await http.request("POST", "/api/admin/gyms/brock/open", { token: economyToken });
    expect(opened.status).toBe(200);
    expect(opened.body.gym.status).toBe("open");
    expect(opened.body.gym.closesAt).toBeGreaterThanOrEqual(before + 45 * 60_000);

    const reopened = await http.request("POST", "/api/admin/gyms/brock/open", { token: superToken, body: { minutes: 10 } });
    expect(reopened.body.gym.closesAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(gymService.tables()).toHaveLength(1);

    const a = await createUser();
    const b = await createUser();
    gymService.join(a.id, "brock", "normal", "deck-a");
    gymService.join(b.id, "brock", "normal", "deck-b");
    const listed = (await http.request("GET", "/api/admin/gyms", { token: superToken })).body.gyms[0];
    expect(listed.current).toMatchObject({ userId: a.id, username: a.username, status: "ready", mode: "normal" });
    expect(listed.queue).toEqual([expect.objectContaining({ userId: b.id, username: b.username, position: 1 })]);
    expect(listed.queueLength).toBe(1);

    const closed = await http.request("POST", "/api/admin/gyms/brock/close", { token: superToken });
    expect(closed.status).toBe(200);
    expect(closed.body.gym.status).toBe("closing");
    expect(gymService.joinError("someone", "brock", "normal")).toBe("El gimnasio está cerrado");
  });

  it("an empty gym closes at once", async () => {
    await http.request("POST", "/api/admin/gyms/brock/open", { token: superToken, body: { minutes: 5 } });
    const closed = await http.request("POST", "/api/admin/gyms/brock/close", { token: superToken });
    expect(closed.body.gym).toMatchObject({ status: "closed", closesAt: null });
    expect(gymService.tables()).toEqual([]);
  });

  it("unknown leaders are 404, invalid minutes 400", async () => {
    expect((await http.request("POST", "/api/admin/gyms/misty/open", { token: superToken, body: {} })).status).toBe(404);
    expect((await http.request("POST", "/api/admin/gyms/misty/close", { token: superToken })).status).toBe(404);
    for (const minutes of [0, -5, 1.5, 100_000, "10"]) {
      expect((await http.request("POST", "/api/admin/gyms/brock/open", { token: superToken, body: { minutes } })).status).toBe(400);
    }
    expect(gymService.tables()).toEqual([]);
  });
});

describe("gym rewards and cosmetics", () => {
  it("Brock's card back is a catalog entry nobody can be granted yet", () => {
    expect(GYM_LEADER_CARD_BACKS.map((c) => c.itemId)).toContain(BROCK.cosmetics.cardBackId);
    expect(GRANTABLE_COSMETICS.cardBack.has("cardback-brock")).toBe(false);
  });

  it("grantMedal is idempotent and says when it granted", async () => {
    const user = await createUser();
    const results = await Promise.all([grantMedal(user.id, "boulder"), grantMedal(user.id, "boulder"), grantMedal(user.id, "boulder")]);
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect((await grantMedal(user.id, "boulder")).granted).toBe(false);
    expect(await prisma.userMedal.count({ where: { userId: user.id } })).toBe(1);
  });
});
