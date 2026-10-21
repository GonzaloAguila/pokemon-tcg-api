/**
 * Activity achievements (first batch activated 2026-10-21, data already stored): "Primer Sobre"
 * (packs-opened), "Semana Activa" / "Mes Dedicado" (login-streak over check-in economy days),
 * "Año Activo" (login-days = User.loginDays), "Sin Derrotas" / "Invencible" (stats-streak), and the
 * check-in / pack-opening routes that re-check achievements without a match.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import * as achievements from "../src/modules/achievements/achievements.service.js";
import { longestDayStreak } from "../src/modules/achievements/achievements.service.js";
import * as economy from "../src/modules/economy/economy.service.js";
import { grantPacks } from "../src/modules/economy/pack-inventory.js";
import { economyRouter } from "../src/modules/economy/index.js";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api", economyRouter));
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

async function progressOf(userId: string, achievementId: string) {
  const list = await achievements.listAchievements(userId);
  return list.find((a) => a.id === achievementId)!;
}

async function checkIns(userId: string, days: string[]) {
  await prisma.economyClaim.createMany({ data: days.map((key) => ({ userId, kind: "check_in", key })) });
}

/** The row checkAndUpdateProgress stored (null = never checked). */
async function storedProgress(userId: string, achievementId: string) {
  const row = await prisma.userAchievement.findUnique({ where: { userId_achievementId: { userId, achievementId } } });
  return row?.progress ?? null;
}

describe("definitions", () => {
  it("the first batch is active (with what it measures); Holo Completo stays unavailable", async () => {
    const user = await createUser();
    const list = await achievements.listAchievements(user.id);
    const byId = new Map(list.map((a) => [a.id, a]));
    expect(byId.get("bronze-5")).toMatchObject({ status: "active", progressTarget: 1, description: "Abre tu primer sobre de cartas" });
    expect(byId.get("silver-17")).toMatchObject({ status: "active", progressTarget: 7, description: "Entra 7 días seguidos" });
    expect(byId.get("gold-31")).toMatchObject({ status: "active", progressTarget: 30, description: "Entra 30 días seguidos" });
    expect(byId.get("platinum-41")).toMatchObject({ status: "active", progressTarget: 100, description: "Entra 100 días distintos" });
    expect(byId.get("platinum-44")).toMatchObject({ status: "active", progressTarget: 30, description: "Gana 30 partidas online seguidas" });
    expect(byId.get("legend-49")).toMatchObject({ status: "active", progressTarget: 100, description: "Gana 100 partidas online seguidas" });
    expect(byId.get("platinum-40")).toMatchObject({ status: "unavailable" });
    // Their rewards are the tier's, like any active achievement
    expect(byId.get("bronze-5")!.reward).toEqual({ coins: 200, coupons: 0 });
  });
});

describe("login-streak: longest run of consecutive economy days", () => {
  it("counts runs over the day keys", () => {
    expect(longestDayStreak([])).toBe(0);
    expect(longestDayStreak(["2026-10-14"])).toBe(1);
    expect(longestDayStreak(["2026-10-14", "2026-10-15", "2026-10-16"])).toBe(3);
    // A gap ends a run; the longest one wins, wherever it is
    expect(longestDayStreak(["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-08"])).toBe(3);
    // Order doesn't matter; duplicates count once
    expect(longestDayStreak(["2026-10-16", "2026-10-14", "2026-10-15", "2026-10-15", "2026-10-14"])).toBe(3);
  });

  it("crosses month, year and leap-day boundaries; ignores malformed and impossible keys", () => {
    expect(longestDayStreak(["2026-10-31", "2026-11-01"])).toBe(2);
    expect(longestDayStreak(["2026-12-31", "2027-01-01", "2027-01-02"])).toBe(3);
    expect(longestDayStreak(["2028-02-28", "2028-02-29", "2028-03-01"])).toBe(3);
    expect(longestDayStreak(["2027-02-28", "2027-03-01"])).toBe(2); // 2027 has no Feb 29
    expect(longestDayStreak(["2026-02-28", "2026-02-30", "2026-03-01", "garbage", "2026-3-02"])).toBe(2);
  });

  it("uses the economy day of each check-in (00:00 Argentina = 03:00 UTC), not the UTC date", async () => {
    const user = await createUser({}, { stats: true });
    // 02:30 UTC on the 15th is still the 14th in Argentina; 03:30 UTC is the 15th
    await economy.checkIn(user.id, new Date("2026-10-15T02:30:00Z"));
    await economy.checkIn(user.id, new Date("2026-10-15T03:30:00Z"));
    // Same economy day (the 15th) again: nothing new
    await economy.checkIn(user.id, new Date("2026-10-16T02:59:00Z"));
    const keys = (await prisma.economyClaim.findMany({ where: { userId: user.id, kind: "check_in" } })).map((c) => c.key).sort();
    expect(keys).toEqual(["2026-10-14", "2026-10-15"]);
    await achievements.checkAndUpdateProgress(user.id);
    expect(await storedProgress(user.id, "silver-17")).toBe(2);
  });

  it("Semana Activa completes at 7 days in a row, Mes Dedicado follows; the best run never goes down", async () => {
    const user = await createUser({}, { stats: true });
    const days = Array.from({ length: 7 }, (_, i) => `2026-09-${String(10 + i).padStart(2, "0")}`);
    await checkIns(user.id, days);
    const claimable = await achievements.checkAndUpdateProgress(user.id);
    expect(claimable.map((c) => c.achievementId)).toContain("silver-17");
    expect(await progressOf(user.id, "silver-17")).toMatchObject({ progress: 7, claimable: true });
    expect(await progressOf(user.id, "gold-31")).toMatchObject({ progress: 7, claimable: false });

    // A gap, then a shorter run: still 7
    await checkIns(user.id, ["2026-09-20", "2026-09-21"]);
    await achievements.checkAndUpdateProgress(user.id);
    expect(await storedProgress(user.id, "gold-31")).toBe(7);
    expect(await achievements.claimAchievement(user.id, "silver-17")).toEqual({ achievementId: "silver-17", coins: 500, coupons: 0, cosmetic: null });
  });

  it("only check-ins count (other claims of the same days don't)", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.economyClaim.createMany({
      data: ["2026-09-01", "2026-09-02", "2026-09-03"].map((key) => ({ userId: user.id, kind: "daily_pack", key })),
    });
    await checkIns(user.id, ["2026-09-01"]);
    await achievements.checkAndUpdateProgress(user.id);
    expect(await storedProgress(user.id, "silver-17")).toBe(1);
  });
});

describe("login-days: Año Activo", () => {
  it("reads User.loginDays (one per economy day on a verified check-in)", async () => {
    const user = await createUser({}, { stats: true });
    await economy.checkIn(user.id, new Date("2026-10-14T12:00:00Z"));
    await economy.checkIn(user.id, new Date("2026-10-20T12:00:00Z"));
    await achievements.checkAndUpdateProgress(user.id);
    expect(await storedProgress(user.id, "platinum-41")).toBe(2);

    await prisma.user.update({ where: { id: user.id }, data: { loginDays: 100 } });
    const claimable = await achievements.checkAndUpdateProgress(user.id);
    expect(claimable.map((c) => c.achievementId)).toContain("platinum-41");
  });

  it("an unverified account doesn't check in, so nothing moves", async () => {
    const user = await createUser({}, { stats: true, emailVerified: false });
    await economy.checkIn(user.id, new Date("2026-10-14T12:00:00Z"));
    await achievements.checkAndUpdateProgress(user.id);
    expect(await storedProgress(user.id, "platinum-41")).toBe(0);
    expect(await storedProgress(user.id, "silver-17")).toBe(0);
  });
});

describe("packs-opened: Primer Sobre", () => {
  async function ledgerRow(userId: string, reason: string) {
    await prisma.cardTransaction.create({ data: { userId, reason, description: "test", cards: [{ cardDefId: "base-set-058-pikachu", quantity: 1 }] } });
  }

  it("counts the card-history rows of an opened pack (bought, daily, inventory, prize), not other card changes", async () => {
    const user = await createUser({}, { stats: true });
    await ledgerRow(user.id, "trade");
    await ledgerRow(user.id, "prize_card");
    await ledgerRow(user.id, "battle_pass");
    await achievements.checkAndUpdateProgress(user.id);
    expect(await storedProgress(user.id, "bronze-5")).toBe(0);

    for (const reason of ["pack_purchase", "daily_pack", "stored_pack", "prize_pack"]) {
      const other = await createUser({}, { stats: true });
      await ledgerRow(other.id, reason);
      const claimable = await achievements.checkAndUpdateProgress(other.id);
      expect(claimable.map((c) => c.achievementId)).toContain("bronze-5");
    }
  });

  it("counts legacy pack purchases (coin rows from before the card history)", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.transaction.create({ data: { userId: user.id, type: "pack_purchase", description: "Apertura de sobre", amount: -100, balanceAfter: 0 } });
    await achievements.checkAndUpdateProgress(user.id);
    expect(await progressOf(user.id, "bronze-5")).toMatchObject({ progress: 1, claimable: true });
  });

  it("once claimed it stays complete, whatever the count says later", async () => {
    const user = await createUser({}, { stats: true });
    await ledgerRow(user.id, "daily_pack");
    await achievements.checkAndUpdateProgress(user.id);
    await achievements.claimAchievement(user.id, "bronze-5");
    // Removing the row would drop the count to 0: a claimed achievement stays complete
    await prisma.cardTransaction.deleteMany({ where: { userId: user.id } });
    await achievements.checkAndUpdateProgress(user.id);
    expect(await progressOf(user.id, "bronze-5")).toMatchObject({ progress: 1, claimed: true });
  });
});

describe("stats-streak: Sin Derrotas (30) and Invencible (100)", () => {
  it("read the best online win streak", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.userStats.update({ where: { userId: user.id }, data: { bestStreak: 30, currentStreak: 0 } });
    const claimable = (await achievements.checkAndUpdateProgress(user.id)).map((c) => c.achievementId);
    expect(claimable).toEqual(expect.arrayContaining(["silver-16", "gold-28", "platinum-38", "platinum-44"]));
    expect(claimable).not.toContain("legend-49");
    expect(await storedProgress(user.id, "legend-49")).toBe(30);
  });
});

describe("activity triggers (no match needed)", () => {
  it("a check-in that records a new day re-checks the achievements", async () => {
    const user = await createUser({}, { stats: true });
    const res = await http.request("POST", "/api/economy/check-in", { token: tokenFor(user) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyCheckedIn: false, emailVerified: true, loginDays: 1 });
    await vi.waitFor(async () => {
      expect(await storedProgress(user.id, "silver-17")).toBe(1);
      expect(await storedProgress(user.id, "platinum-41")).toBe(1);
    });
  });

  it("an unverified account's check-in records nothing and checks nothing", async () => {
    const user = await createUser({}, { stats: true, emailVerified: false });
    const res = await http.request("POST", "/api/economy/check-in", { token: tokenFor(user) });
    expect(res.body).toMatchObject({ emailVerified: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await storedProgress(user.id, "silver-17")).toBeNull();
  });

  it("opening an inventory pack re-checks the achievements", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.$transaction((tx) => grantPacks(tx, user.id, 1, "login_calendar"));
    const pack = await prisma.userPack.findFirstOrThrow({ where: { userId: user.id, openedAt: null } });
    const res = await http.request("POST", `/api/economy/packs/${pack.id}/open`, { token: tokenFor(user), body: { packId: "base-set-booster" } });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await storedProgress(user.id, "bronze-5")).toBe(1);
    });
  });

  it("the daily pack re-checks the achievements (pack opened and day checked in)", async () => {
    const user = await createUser({}, { stats: true });
    const res = await http.request("POST", "/api/economy/daily-pack", { token: tokenFor(user), body: { packId: "base-set-booster" } });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await storedProgress(user.id, "bronze-5")).toBe(1);
      expect(await storedProgress(user.id, "silver-17")).toBe(1);
    });
  });
});
