/**
 * Gym Leaders over REST (src/modules/gym/gym.controller.ts): the public catalog GET /api/gyms;
 * the backoffice GET /api/admin/gyms, POST /api/admin/gyms/:leaderId/open | close per version,
 * GET | PUT | DELETE /api/admin/gyms/:leaderId/decks/:mode (the deck battles play). Permission
 * users:economy, superadmin always. Plus the first-victory rewards (gym rewards.ts) and the card
 * back catalog entries.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { gymAdminRouter } from "../src/modules/gym/gym.controller.js";
import { gymService } from "../src/modules/gym/gym.service.js";
import { battleDeck } from "../src/modules/gym/gym-decks.js";
import { grantGymVictoryRewards } from "../src/modules/gym/rewards.js";
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

afterEach(async () => {
  gymService.reset();
  await prisma.gymLeaderDeck.deleteMany({});
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

/** A 60-card list for the leader (no challenger rule applies to it: 12 Bill is fine). */
const ADMIN_DECK = [
  { cardId: "gym-heroes-069-brocks-onix", qty: 4 },
  { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 4 },
  { cardId: "base-set-091-bill", qty: 12 },
  { cardId: "base-set-097-fighting-energy", qty: 40 },
];

describe("public gym catalog", () => {
  it("GET /api/gyms (no auth): every leader with its entry cost and both versions' rules and rewards, open or not", async () => {
    const rules = (maxCopies: number) => ({
      bannedPokemonTypes: ["grass", "psychic", "fighting"],
      bannedOwners: ["Brock"],
      noStadiums: true,
      maxTrainers: 25,
      maxCopies,
      fixedStadium: { cardId: "gym-heroes-115-pewter-city-gym", name: "Pewter City Gym" },
    });
    const res = await http.request("GET", "/api/gyms");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      leaders: [
        {
          leaderId: "brock",
          name: "Brock",
          title: "Líder del Gimnasio de Ciudad Plateada",
          avatarId: "gym-brock",
          medalId: "boulder",
          entryCost: 100,
          attemptsPerDay: 2,
          bestOf: 3,
          modes: [
            {
              mode: "normal",
              rules: rules(2),
              rewards: { medalId: "boulder", coins: 1500, coinId: "golem", cardBackId: "cardback-brock" },
            },
            {
              mode: "expert",
              rules: rules(1),
              rewards: { medalId: null, coins: 3000, coinId: null, cardBackId: "cardback-brock-expert" },
            },
          ],
        },
      ],
    });
  });
});

describe("gym admin endpoints", () => {
  it("only the superadmin and admins with users:economy", async () => {
    expect((await http.request("GET", "/api/admin/gyms")).status).toBe(401);
    expect((await http.request("GET", "/api/admin/gyms", { token: userToken })).status).toBe(403);
    expect((await http.request("GET", "/api/admin/gyms", { token: roomsToken })).status).toBe(403);
    expect((await http.request("POST", "/api/admin/gyms/brock/open", { token: roomsToken, body: {} })).status).toBe(403);
    expect((await http.request("GET", "/api/admin/gyms/brock/decks/normal", { token: roomsToken })).status).toBe(403);
    expect((await http.request("PUT", "/api/admin/gyms/brock/decks/normal", { token: userToken, body: { cards: ADMIN_DECK } })).status).toBe(403);
    expect((await http.request("DELETE", "/api/admin/gyms/brock/decks/normal")).status).toBe(401);
    expect((await http.request("GET", "/api/admin/gyms", { token: economyToken })).status).toBe(200);
    expect((await http.request("GET", "/api/admin/gyms", { token: superToken })).status).toBe(200);
  });

  it("GET lists one row per leader and version with its status, deck and the scheduler", async () => {
    const res = await http.request("GET", "/api/admin/gyms", { token: superToken });
    const row = (mode: string) => ({
      leaderId: "brock",
      name: "Brock",
      title: "Líder del Gimnasio de Ciudad Plateada",
      avatarId: "gym-brock",
      mode,
      modes: ["normal", "expert"],
      status: "closed",
      openedAt: null,
      closesAt: null,
      inBattle: false,
      current: null,
      schedule: { enabled: false, nextOpenAt: null, minGapMinutes: 120, maxGapMinutes: 360, openMinutes: 45 },
      deck: { isDefault: true, updatedAt: null },
    });
    expect(res.body.gyms).toEqual([row("normal"), row("expert")]);
  });

  it("open / close each version (default normal, 45 min)", async () => {
    const before = Date.now();
    const opened = await http.request("POST", "/api/admin/gyms/brock/open", { token: economyToken });
    expect(opened.status).toBe(200);
    expect(opened.body.gym).toMatchObject({ mode: "normal", status: "open" });
    expect(opened.body.gym.closesAt).toBeGreaterThanOrEqual(before + 45 * 60_000);

    const expert = await http.request("POST", "/api/admin/gyms/brock/open", { token: superToken, body: { mode: "expert", minutes: 10 } });
    expect(expert.body.gym).toMatchObject({ mode: "expert", status: "open" });
    expect(expert.body.gym.closesAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(gymService.tables().map((t) => t.mode)).toEqual(["normal", "expert"]);

    // A battle at the expert table: closing it leaves it listed until the battle ends
    const a = await createUser();
    const roomId = gymService.reserve(a.id, "brock", "expert", { username: a.username, avatarId: null });
    gymService.battleStarted(roomId);
    const listed = (await http.request("GET", "/api/admin/gyms", { token: superToken })).body.gyms[1];
    expect(listed).toMatchObject({ mode: "expert", inBattle: true, current: { userId: a.id, username: a.username, roomId, game: 1, score: { challenger: 0, leader: 0 } } });

    const closed = await http.request("POST", "/api/admin/gyms/brock/close", { token: superToken, body: { mode: "expert" } });
    expect(closed.body.gym).toMatchObject({ mode: "expert", status: "closing" });
    expect(gymService.challengeError("someone", "brock", "expert")).toBe("El gimnasio está cerrado");
    expect(gymService.challengeError("someone", "brock", "normal")).toBeNull();
    const normalClosed = await http.request("POST", "/api/admin/gyms/brock/close", { token: superToken });
    expect(normalClosed.body.gym).toMatchObject({ mode: "normal", status: "closed", closesAt: null });
    expect(gymService.tables().map((t) => [t.mode, t.status])).toEqual([["expert", "closing"]]);
  });

  it("unknown leaders are 404, invalid minutes or mode 400", async () => {
    expect((await http.request("POST", "/api/admin/gyms/misty/open", { token: superToken, body: {} })).status).toBe(404);
    expect((await http.request("POST", "/api/admin/gyms/misty/close", { token: superToken })).status).toBe(404);
    expect((await http.request("GET", "/api/admin/gyms/misty/decks/normal", { token: superToken })).status).toBe(404);
    for (const minutes of [0, -5, 1.5, 100_000, "10"]) {
      expect((await http.request("POST", "/api/admin/gyms/brock/open", { token: superToken, body: { minutes } })).status).toBe(400);
    }
    expect((await http.request("POST", "/api/admin/gyms/brock/open", { token: superToken, body: { mode: "hard" } })).status).toBe(400);
    expect((await http.request("POST", "/api/admin/gyms/brock/close", { token: superToken, body: { mode: "hard" } })).status).toBe(400);
    expect((await http.request("GET", "/api/admin/gyms/brock/decks/hard", { token: superToken })).status).toBe(400);
    expect(gymService.tables()).toEqual([]);
  });
});

describe("leader decks (backoffice)", () => {
  it("GET: the content default until an admin saves one", async () => {
    for (const mode of ["normal", "expert"] as const) {
      const res = await http.request("GET", `/api/admin/gyms/brock/decks/${mode}`, { token: economyToken });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cards: BROCK.decks[mode], isDefault: true, updatedAt: null });
    }
  });

  it("PUT validates: real cards, positive quantities, exactly 60 (the challenger rules don't apply)", async () => {
    const put = (cards: unknown) => http.request("PUT", "/api/admin/gyms/brock/decks/normal", { token: superToken, body: { cards } });
    const unknown = await put([...ADMIN_DECK.slice(1), { cardId: "base-set-999-nope", qty: 4 }]);
    expect(unknown).toMatchObject({ status: 400, body: { error: { message: "Carta desconocida: base-set-999-nope" } } });
    const short = await put(ADMIN_DECK.map((e) => (e.cardId === "base-set-091-bill" ? { ...e, qty: 11 } : e)));
    expect(short).toMatchObject({ status: 400, body: { error: { message: "El mazo debe tener exactamente 60 cartas (tiene 59)" } } });
    for (const qty of [0, -1, 1.5, "4"]) expect((await put([{ cardId: "base-set-091-bill", qty }])).status).toBe(400);
    expect((await put("nope")).status).toBe(400);
    expect(await prisma.gymLeaderDeck.count()).toBe(0);
  });

  it("PUT saves it (battles play it), GET returns it, DELETE restores the default", async () => {
    const admin = await createUser({}, { role: "superadmin" });
    const saved = await http.request("PUT", "/api/admin/gyms/brock/decks/expert", { token: tokenFor(admin), body: { cards: ADMIN_DECK } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ cards: ADMIN_DECK, isDefault: false, updatedAt: expect.any(String) });
    expect(await prisma.gymLeaderDeck.findFirst({ where: { leaderId: "brock", mode: "expert" } })).toMatchObject({ updatedById: admin.id });
    expect((await http.request("GET", "/api/admin/gyms/brock/decks/expert", { token: superToken })).body).toMatchObject({ cards: ADMIN_DECK, isDefault: false });
    expect(await battleDeck(BROCK, "expert")).toEqual(ADMIN_DECK);
    // The other version is untouched
    expect(await battleDeck(BROCK, "normal")).toEqual(BROCK.decks.normal);
    const rows = (await http.request("GET", "/api/admin/gyms", { token: superToken })).body.gyms;
    expect(rows.map((r: { mode: string; deck: { isDefault: boolean } }) => [r.mode, r.deck.isDefault])).toEqual([
      ["normal", true],
      ["expert", false],
    ]);

    // Saving again replaces it (same card twice in the list: summed)
    const again = await http.request("PUT", "/api/admin/gyms/brock/decks/expert", {
      token: superToken,
      body: { cards: [...ADMIN_DECK.slice(0, 3), { cardId: "base-set-097-fighting-energy", qty: 20 }, { cardId: "base-set-097-fighting-energy", qty: 20 }] },
    });
    expect(again.body.cards).toEqual(ADMIN_DECK);
    expect(await prisma.gymLeaderDeck.count()).toBe(1);

    const reset = await http.request("DELETE", "/api/admin/gyms/brock/decks/expert", { token: superToken });
    expect(reset.body).toEqual({ cards: BROCK.decks.expert, isDefault: true, updatedAt: null });
    expect(await battleDeck(BROCK, "expert")).toEqual(BROCK.decks.expert);
  });

  it("a saved deck that no longer passes (a card gone from game-core) plays the default", async () => {
    await prisma.gymLeaderDeck.create({ data: { leaderId: "brock", mode: "normal", cards: [{ cardId: "base-set-999-gone", qty: 60 }] } });
    expect(await battleDeck(BROCK, "normal")).toEqual(BROCK.decks.normal);
    expect((await http.request("GET", "/api/admin/gyms/brock/decks/normal", { token: superToken })).body).toMatchObject({ isDefault: true });
  });
});

describe("gym rewards and cosmetics", () => {
  it("Brock's card backs are catalog entries, not grantable from the backoffice", () => {
    expect(GYM_LEADER_CARD_BACKS.map((c) => c.itemId)).toEqual(["cardback-brock", "cardback-brock-expert"]);
    expect(GYM_LEADER_CARD_BACKS.find((c) => c.itemId === "cardback-brock-expert")).toMatchObject({ name: "Brock EXPERT", imageUrl: "/gym-leaders/brock/brock_bkc_expert.png" });
    expect(GRANTABLE_COSMETICS.cardBack.has("cardback-brock")).toBe(false);
    expect(GRANTABLE_COSMETICS.cardBack.has("cardback-brock-expert")).toBe(false);
  });

  it("normal: the first victory grants medal, coin, card back and 1500 coins (logged); later ones nothing", async () => {
    const user = await createUser({ coins: 100 });
    expect(await grantGymVictoryRewards(user.id, BROCK, "normal")).toEqual({ medalId: "boulder", coins: 1500, coinId: "golem", cardBackId: "cardback-brock" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coins).toBe(1600);
    expect(await prisma.userMedal.count({ where: { userId: user.id, medalId: "boulder" } })).toBe(1);
    expect(await prisma.userCoin.count({ where: { userId: user.id, coinId: "golem" } })).toBe(1);
    expect(await prisma.userCardBack.count({ where: { userId: user.id, cardBackId: "cardback-brock" } })).toBe(1);
    expect(await prisma.transaction.findMany({ where: { userId: user.id }, select: { type: true, amount: true, balanceAfter: true, description: true } })).toEqual([
      { type: "gym_reward", amount: 1500, balanceAfter: 1600, description: "Victoria contra Brock: +1500 monedas" },
    ]);

    expect(await grantGymVictoryRewards(user.id, BROCK, "normal")).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coins).toBe(1600);
  });

  it("concurrent victories grant once", async () => {
    const user = await createUser();
    const results = await Promise.all([1, 2, 3].map(() => grantGymVictoryRewards(user.id, BROCK, "normal")));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coins).toBe(1500);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("an item the user already had isn't granted again (null in the result); the rest is", async () => {
    const user = await createUser();
    await prisma.userCoin.create({ data: { userId: user.id, coinId: "golem" } });
    expect(await grantGymVictoryRewards(user.id, BROCK, "normal")).toEqual({ medalId: "boulder", coins: 1500, coinId: null, cardBackId: "cardback-brock" });
  });

  it("expert: the first victory (no EXPERT card back yet) grants it and 3000 coins; independent of normal", async () => {
    const user = await createUser();
    await grantMedal(user.id, "boulder");
    expect(await grantGymVictoryRewards(user.id, BROCK, "expert")).toEqual({ medalId: null, coins: 3000, coinId: null, cardBackId: "cardback-brock-expert" });
    expect(await grantGymVictoryRewards(user.id, BROCK, "expert")).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coins).toBe(3000);
    expect(await prisma.transaction.findFirst({ where: { userId: user.id } })).toMatchObject({ type: "gym_reward", description: "Victoria contra Brock EXPERT: +3000 monedas" });
    // The normal version's medal was already there: its first victory never comes
    expect(await grantGymVictoryRewards(user.id, BROCK, "normal")).toBeNull();
  });

  it("grantMedal is idempotent and says when it granted", async () => {
    const user = await createUser();
    const results = await Promise.all([grantMedal(user.id, "boulder"), grantMedal(user.id, "boulder"), grantMedal(user.id, "boulder")]);
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect((await grantMedal(user.id, "boulder")).granted).toBe(false);
    expect(await prisma.userMedal.count({ where: { userId: user.id } })).toBe(1);
  });
});
