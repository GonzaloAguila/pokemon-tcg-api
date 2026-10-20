import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Released sets only: a set still in development (game-core inDevelopment) is not listed
import { RELEASED_SETS as CARD_SETS } from "../src/lib/released-sets.js";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { playersRouter } from "../src/modules/players/index.js";
import { summarizeCollection } from "../src/modules/players/players.service.js";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;
let viewerToken: string;

const [firstSet, secondSet] = CARD_SETS;
const PRIVATE_KEYS = [
  "userId", "email", "coins", "coupons", "rareCandy", "exchangeTokens", "loginDays", "freeWheelSpins",
  "permissions", "status", "bannedAt", "bannedReason", "suspendedUntil", "suspendedReason",
  "transactions", "passwordHash", "tokenVersion", "provider", "providerId", "role", "emailVerified",
  "lastLoginAt", "resetToken", "verificationToken", "experience", "maxDeckSlots", "starterColor",
];

/** Every key at any depth of a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      allKeys(child, keys);
    }
  }
  return keys;
}

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", playersRouter));
  const viewer = await createUser();
  viewerToken = tokenFor(viewer);
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

async function createPlayer() {
  const user = await createUser({ coins: 98765, coupons: 56, rareCandy: 7 }, { stats: true });
  await prisma.userStats.update({
    where: { userId: user.id },
    data: { normalWins: 5, normalLosses: 2, draftWins: 1, bestStreak: 3, currentStreak: 1 },
  });
  await prisma.userMedal.create({ data: { userId: user.id, medalId: "boulder" } });
  await prisma.userAchievement.createMany({
    data: [
      { userId: user.id, achievementId: "bronze-1", progress: 1, unlockedAt: new Date() },
      { userId: user.id, achievementId: "silver-16", progress: 5, unlockedAt: new Date() },
      // Complete but not claimed: not earned yet
      { userId: user.id, achievementId: "bronze-6", progress: 10 },
    ],
  });
  await prisma.userCard.createMany({
    data: [
      { userId: user.id, cardDefId: firstSet.cards[0].id, quantity: 3 },
      { userId: user.id, cardDefId: firstSet.cards[1].id, quantity: 1 },
      { userId: user.id, cardDefId: secondSet.cards[0].id, quantity: 2 },
      { userId: user.id, cardDefId: secondSet.cards[1].id, quantity: 0 },
    ],
  });
  await prisma.userCardSkin.create({ data: { userId: user.id, skinId: "charizard-holo-sparkle" } });
  await prisma.user.update({ where: { id: user.id }, data: { activeAvatarId: "pkmn-mew", activeCoinId: "pikachu" } });
  await prisma.transaction.create({
    data: { userId: user.id, type: "test", description: "secret", currency: "coins", amount: 1, balanceAfter: 98765 },
  });
  return user;
}

describe("GET /api/players/:username", () => {
  it("returns the public profile", async () => {
    const player = await createPlayer();
    const res = await http.request("GET", `/api/players/${player.username}`, { token: viewerToken });
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.username).toBe(player.username);
    expect(body.avatarId).toBe("pkmn-mew");
    expect(body.titleId).toBe("novato");
    expect(body.level).toBe(1);
    expect(typeof body.memberSince).toBe("string");
    expect(body.stats).toEqual({
      normalWins: 5, normalLosses: 2, rankedWins: 0, rankedLosses: 0, draftWins: 1, draftLosses: 0,
      currentStreak: 1, bestStreak: 3,
    });
    expect(body.medals.map((m: { medalId: string }) => m.medalId)).toEqual(["boulder"]);
    expect(body.achievements.points).toBe(10 + 25);
    expect(body.achievements.earned.map((a: { id: string }) => a.id).sort()).toEqual(["bronze-1", "silver-16"]);
    expect(body.achievements.earned[0]).toEqual(
      expect.objectContaining({ name: expect.any(String), tier: expect.any(String), points: expect.any(Number), unlockedAt: expect.any(String) }),
    );
    expect(body.collection.owned).toBe(3);
    expect(body.collection.sets[0]).toEqual({ setId: firstSet.id, owned: 2, total: firstSet.cards.length });
    expect(body.collection.sets[1]).toEqual({ setId: secondSet.id, owned: 1, total: secondSet.cards.length });
    expect(body.variants).toEqual(["charizard-holo-sparkle"]);
    expect(body.cosmetics).toEqual({ coinId: "pikachu", cardBackId: "default", playmatId: "field" });
  });

  it("never exposes private fields", async () => {
    const player = await createPlayer();
    const res = await http.request("GET", `/api/players/${player.username}`, { token: viewerToken });
    expect(res.status).toBe(200);
    const keys = allKeys(res.body);
    for (const key of PRIVATE_KEYS) expect(keys.has(key), key).toBe(false);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(player.email);
    expect(text).not.toContain(player.id);
    expect(text).not.toContain("98765");
    expect(text).not.toContain("secret");
  });

  it("matches the username case-insensitively", async () => {
    const player = await createPlayer();
    const res = await http.request("GET", `/api/players/${player.username.toUpperCase()}`, { token: viewerToken });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(player.username);
  });

  it("treats _ as a literal character, not a wildcard", async () => {
    const player = await createPlayer();
    const lookalike = `${player.username.slice(0, -1)}_`;
    if (lookalike === player.username) return;
    const res = await http.request("GET", `/api/players/${lookalike}`, { token: viewerToken });
    expect(res.status).toBe(404);
  });

  it("is 404 for unknown and banned players", async () => {
    const unknown = await http.request("GET", "/api/players/nobody_here_123", { token: viewerToken });
    expect(unknown.status).toBe(404);

    const weird = await http.request("GET", `/api/players/${encodeURIComponent("a b%")}`, { token: viewerToken });
    expect(weird.status).toBe(404);

    const banned = await createPlayer();
    await prisma.user.update({ where: { id: banned.id }, data: { status: "banned", bannedAt: new Date() } });
    clearAccountStateCache();
    const res = await http.request("GET", `/api/players/${banned.username}`, { token: viewerToken });
    expect(res.status).toBe(404);
    const collection = await http.request("GET", `/api/players/${banned.username}/collection`, { token: viewerToken });
    expect(collection.status).toBe(404);
  });

  it("requires a signed-in player", async () => {
    const player = await createPlayer();
    const res = await http.request("GET", `/api/players/${player.username}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/players/:username/collection", () => {
  it("lists the owned cards only, without private fields", async () => {
    const player = await createPlayer();
    const res = await http.request("GET", `/api/players/${player.username.toUpperCase()}/collection`, { token: viewerToken });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(player.username);
    expect(res.body.cards).toHaveLength(3);
    expect(res.body.cards).toContainEqual({ cardDefId: firstSet.cards[0].id, quantity: 3 });
    expect(res.body.cards.some((c: { quantity: number }) => c.quantity <= 0)).toBe(false);
    const keys = allKeys(res.body);
    for (const key of PRIVATE_KEYS) expect(keys.has(key), key).toBe(false);
  });
});

describe("summarizeCollection", () => {
  it("counts distinct catalog cards per set and skips unknown ids", () => {
    const summary = summarizeCollection([
      { cardDefId: firstSet.cards[0].id, quantity: 2 },
      { cardDefId: "not-a-card", quantity: 4 },
      { cardDefId: firstSet.cards[2].id, quantity: 0 },
    ]);
    expect(summary.owned).toBe(1);
    expect(summary.total).toBe(CARD_SETS.reduce((sum, set) => sum + set.cards.length, 0));
    expect(summary.sets).toHaveLength(CARD_SETS.length);
  });
});
