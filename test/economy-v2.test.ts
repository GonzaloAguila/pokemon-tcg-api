import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { getSetById, isBasicEnergy } from "@gonzaloaguila/game-core";
// Released sets only: a set still in development (game-core inDevelopment) gives nothing
import { RELEASED_CARDS as ALL_CARDS, RELEASED_SETS as CARD_SETS } from "../src/lib/released-sets.js";
import { prisma } from "../src/lib/prisma.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import {
  economyCalendar,
  economyDay,
  economyWeek,
  nextEconomyDayStart,
  startOfEconomyDay,
  startOfEconomyWeek,
  timeZoneOffsetMinutes,
} from "../src/modules/economy/economy-time.js";
import * as economy from "../src/modules/economy/economy.service.js";
import { openOwnedPack, grantPacks } from "../src/modules/economy/pack-inventory.js";
import { recordMissionEvent } from "../src/modules/economy/missions.service.js";
import { getOdds } from "../src/modules/economy/odds.js";
import { economyRouter } from "../src/modules/economy/index.js";
import * as battlePass from "../src/modules/battle-pass/battle-pass.service.js";
import * as marketService from "../src/modules/market/market.service.js";
import * as achievements from "../src/modules/achievements/achievements.service.js";
import {
  SECOND_RARE_CHANCE,
  STANDARD_BOOSTER_IDS,
  TRAINER_BOOSTER_ID,
  openPack,
  getPackOdds,
} from "../src/modules/boosters/boosters.service.js";
import { registerUser } from "../src/modules/auth/auth.service.js";
import { handleOAuthCallback } from "../src/modules/auth/oauth.service.js";
import { usersRouter } from "../src/modules/users/index.js";
import { ALL_VARIANTS } from "../src/modules/prizes/catalog.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60_000;
const at = (iso: string) => new Date(iso);

async function txRows(userId: string, type?: string) {
  const rows = await prisma.transaction.findMany({ where: { userId, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => [r.type, r.currency, r.amount]);
}

async function unopened(userId: string) {
  return prisma.userPack.findMany({ where: { userId, openedAt: null }, orderBy: { createdAt: "asc" } });
}

/** A new account that went through the v2 welcome (first-steps eligible). */
async function newAccount() {
  const user = await createUser();
  await prisma.$transaction((tx) => economy.grantWelcomePackage(tx, user.id));
  return user;
}

async function giveCards(userId: string, ids: string[]) {
  await prisma.userCard.createMany({ data: ids.map((cardDefId) => ({ userId, cardDefId, quantity: 1 })), skipDuplicates: true });
}

// ---------------------------------------------------------------------------

describe("economy day (00:00 Argentina = 03:00 UTC)", () => {
  it("uses the Argentina offset", () => {
    expect(timeZoneOffsetMinutes(at("2026-10-14T12:00:00Z"))).toBe(-180);
  });

  it("changes day at 03:00 UTC", () => {
    expect(economyDay(at("2026-10-14T02:59:59Z"))).toBe("2026-10-13");
    expect(economyDay(at("2026-10-14T03:00:00Z"))).toBe("2026-10-14");
    expect(startOfEconomyDay(at("2026-10-14T02:00:00Z")).toISOString()).toBe("2026-10-13T03:00:00.000Z");
    expect(nextEconomyDayStart(at("2026-10-14T05:00:00Z")).toISOString()).toBe("2026-10-15T03:00:00.000Z");
  });

  it("weeks start on Monday 00:00 Argentina", () => {
    // 2026-10-12 is a Monday
    expect(economyWeek(at("2026-10-12T03:00:00Z"))).toBe("2026-10-12");
    expect(economyWeek(at("2026-10-12T02:59:00Z"))).toBe("2026-10-05");
    expect(economyWeek(at("2026-10-18T23:00:00Z"))).toBe("2026-10-12");
    expect(startOfEconomyWeek(at("2026-10-15T10:00:00Z")).toISOString()).toBe("2026-10-12T03:00:00.000Z");
  });

  it("the month follows the economy day", () => {
    expect(economyCalendar(at("2026-11-01T02:00:00Z"))).toMatchObject({ year: 2026, month: 10, dayOfMonth: 31, daysInMonth: 31 });
    expect(economyCalendar(at("2026-11-01T03:00:00Z"))).toMatchObject({ year: 2026, month: 11, dayOfMonth: 1, daysInMonth: 30 });
  });
});

// ---------------------------------------------------------------------------

describe("welcome grant (new accounts)", () => {
  it("email signup: 1000 coins, 100 coupons, one unopened pack per set; starterColor grants the starter (P15)", async () => {
    const tag = Math.random().toString(36).slice(2, 10);
    const { user } = await registerUser({
      email: `reg-${tag}@example.com`,
      username: `reg_${tag}`,
      password: "Sup3r-secret-pass!",
      starterColor: "fire",
      acceptedTerms: true,
    } as any);
    expect(user).toMatchObject({ coins: ECONOMY.welcome.coins, coupons: ECONOMY.welcome.coupons, starterColor: "fire" });
    const packs = await unopened(user.id);
    expect(packs.map((p) => p.packId).sort()).toEqual([...STANDARD_BOOSTER_IDS].sort());
    expect(packs.every((p) => p.source === "welcome")).toBe(true);
    expect(await txRows(user.id)).toEqual([
      ["welcome_grant", "coins", ECONOMY.welcome.coins],
      ["welcome_grant", "coupons", ECONOMY.welcome.coupons],
    ]);
    // Starter deck: cards in the collection and an active deck
    expect(await prisma.userCard.count({ where: { userId: user.id } })).toBeGreaterThan(0);
    expect(await prisma.deck.count({ where: { userId: user.id, isActive: true } })).toBe(1);
  });

  it("OAuth signup gets the same package; logging in again grants nothing", async () => {
    const tag = Math.random().toString(36).slice(2, 10);
    const oauthUser = { id: `g-${tag}`, email: `oauth-${tag}@example.com`, emailVerified: true, name: `oauth_${tag}` };
    const first = await handleOAuthCallback(oauthUser, "google");
    expect(first.isNewUser).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: oauthUser.email } });
    expect([user.coins, user.coupons]).toEqual([ECONOMY.welcome.coins, ECONOMY.welcome.coupons]);
    expect(await unopened(user.id)).toHaveLength(STANDARD_BOOSTER_IDS.length);

    await handleOAuthCallback(oauthUser, "google");
    expect((await getBalances(user.id)).coins).toBe(ECONOMY.welcome.coins);
    expect(await unopened(user.id)).toHaveLength(STANDARD_BOOSTER_IDS.length);
  });

  it("is granted once, and never to existing accounts by itself", async () => {
    const user = await createUser({ coins: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => prisma.$transaction((tx) => economy.grantWelcomePackage(tx, user.id))),
    );
    expect(results.filter((r) => r.status === "fulfilled" && r.value === true)).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(5 + ECONOMY.welcome.coins);
  });
});

// ---------------------------------------------------------------------------

describe("daily check-in", () => {
  it("counts one login day per economy day, even under concurrency", async () => {
    const user = await createUser();
    const now = at("2026-10-14T15:00:00Z");
    const { fulfilled } = await race(6, () => economy.checkIn(user.id, now));
    expect(fulfilled.filter((r) => !r.value.alreadyCheckedIn)).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).loginDays).toBe(1);

    // 02:00 UTC next day is still the same economy day
    expect((await economy.checkIn(user.id, at("2026-10-15T02:00:00Z"))).alreadyCheckedIn).toBe(true);
    const next = await economy.checkIn(user.id, at("2026-10-15T03:00:00Z"));
    expect(next).toMatchObject({ alreadyCheckedIn: false, loginDays: 2 });
  });

  it("first steps: one extra pack on each of the first 7 login days of a new account", async () => {
    const user = await newAccount();
    const start = at("2026-10-01T12:00:00Z").getTime();
    const extra: number[] = [];
    for (let d = 0; d < 8; d++) {
      extra.push((await economy.checkIn(user.id, new Date(start + d * DAY))).granted.firstStepsPacks);
    }
    expect(extra).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
    expect(await prisma.userPack.count({ where: { userId: user.id, source: "first_steps" } })).toBe(7);
  });

  it("accounts from before economy v2 don't get first-steps packs", async () => {
    const user = await createUser();
    const res = await economy.checkIn(user.id, at("2026-10-02T12:00:00Z"));
    expect(res.granted.firstStepsPacks).toBe(0);
    expect(await unopened(user.id)).toHaveLength(0);
  });

  it("login calendar: every 7 login days (not consecutive) gives a pack and 10 coupons", async () => {
    const user = await createUser();
    const start = at("2026-09-01T12:00:00Z").getTime();
    const rewards: (object | null)[] = [];
    for (let i = 0; i < 14; i++) {
      // every other day: login days don't need to be consecutive
      rewards.push((await economy.checkIn(user.id, new Date(start + i * 2 * DAY))).granted.calendar);
    }
    expect(rewards.map((r, i) => (r ? i + 1 : 0)).filter(Boolean)).toEqual([7, 14]);
    expect(rewards[6]).toEqual({ packs: 1, coupons: 10 });
    expect((await getBalances(user.id)).coupons).toBe(20);
    expect(await prisma.userPack.count({ where: { userId: user.id, source: "login_calendar" } })).toBe(2);
    expect(await txRows(user.id, "login_calendar")).toEqual([
      ["login_calendar", "coupons", 10],
      ["login_calendar", "coupons", 10],
    ]);
  });

  it("each login day advances the battle pass one step", async () => {
    const user = await createUser();
    const r1 = await economy.checkIn(user.id);
    expect(r1.granted.battlePassStep).toBe(1);
    const pass = await battlePass.getCurrentPassWithProgress(user.id);
    expect(pass.enrollment).toMatchObject({ steps: 1, steppedToday: true });
  });
});

// ---------------------------------------------------------------------------

describe("daily free pack", () => {
  it("opens one pack of the chosen set per economy day (race-safe) and completes its mission", async () => {
    const user = await createUser();
    const now = at("2026-10-14T15:00:00Z");
    const { fulfilled, rejected } = await race(5, () => economy.claimDailyPack(user.id, "jungle-booster", now));
    expect(fulfilled).toHaveLength(1);
    expect(rejected.every((r) => (r.reason as { statusCode?: number }).statusCode === 409)).toBe(true);

    const res = fulfilled[0].value;
    expect(res.pack.packId).toBe("jungle-booster");
    expect(res.pack.cards).toHaveLength(11);
    expect(res.missionsCompleted.map((m) => m.missionId)).toEqual(["open_daily_pack"]);
    const owned = await prisma.userCard.aggregate({ where: { userId: user.id }, _sum: { quantity: true } });
    expect(owned._sum.quantity).toBe(11);
    expect((await getBalances(user.id)).coins).toBe(ECONOMY.missions.daily[0].rewardCoins);
    // It also checked the user in
    expect(res.checkIn.loginDays).toBe(1);

    // Next economy day: available again
    const tomorrow = await economy.claimDailyPack(user.id, "fossil-booster", new Date(now.getTime() + DAY));
    expect(tomorrow.pack.packId).toBe("fossil-booster");
  });

  it("rejects packs that aren't standard boosters", async () => {
    const user = await createUser();
    await expect(economy.claimDailyPack(user.id, "base-set-theme-pack")).rejects.toMatchObject({ statusCode: 400 });
    await expect(economy.claimDailyPack(user.id, "nope")).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------

describe("unopened packs", () => {
  it("a choose-your-set pack needs a standard booster; it opens once even under concurrency", async () => {
    const user = await createUser();
    await prisma.$transaction((tx) => grantPacks(tx, user.id, 1, "login_calendar"));
    const [pack] = await unopened(user.id);
    await expect(openOwnedPack(user.id, pack.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(openOwnedPack(user.id, pack.id, "made-up-booster")).rejects.toMatchObject({ statusCode: 400 });

    const { fulfilled } = await race(4, () => openOwnedPack(user.id, pack.id, "team-rocket-booster"));
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.pack.packId).toBe("team-rocket-booster");
    expect(fulfilled[0].value.unopenedPacks).toBe(0);
    const owned = await prisma.userCard.aggregate({ where: { userId: user.id }, _sum: { quantity: true } });
    expect(owned._sum.quantity).toBe(11);
  });

  it("a fixed pack opens its own set; other users can't open it", async () => {
    const user = await newAccount();
    const other = await createUser();
    const [pack] = await unopened(user.id);
    await expect(openOwnedPack(other.id, pack.id, pack.packId!)).rejects.toMatchObject({ statusCode: 404 });
    const otherSet = STANDARD_BOOSTER_IDS.find((id) => id !== pack.packId)!;
    await expect(openOwnedPack(user.id, pack.id, otherSet)).rejects.toMatchObject({ statusCode: 400 });
    const res = await openOwnedPack(user.id, pack.id);
    expect(res.pack.packId).toBe(pack.packId);
    await expect(openOwnedPack(user.id, pack.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------

describe("missions", () => {
  it("weekly mission: 15 completed missions in the week give 1 pack + 1 Ficha de canje, once", async () => {
    const user = await createUser();
    const monday = at("2026-10-12T12:00:00Z").getTime();
    const weekly: string[] = [];
    // 3 daily missions on 6 days = 18 completions
    for (let d = 0; d < 6; d++) {
      const now = new Date(monday + d * DAY);
      await prisma.$transaction(async (tx) => {
        for (const c of [
          ...(await recordMissionEvent(tx, user.id, "daily_pack_opened", now)),
          ...(await recordMissionEvent(tx, user.id, "game_played", now, 2)),
          ...(await recordMissionEvent(tx, user.id, "game_won", now)),
        ]) if (c.kind === "weekly") weekly.push(economyDay(now));
      });
    }
    expect(weekly).toEqual(["2026-10-16"]); // 15th completion on the 5th day
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.exchangeTokens).toBe(1);
    expect(await prisma.userPack.count({ where: { userId: user.id, source: "weekly_mission" } })).toBe(1);
    const daily = ECONOMY.missions.daily.reduce((n, m) => n + m.rewardCoins, 0);
    expect(u.coins).toBe(daily * 6);
    expect(await txRows(user.id, "weekly_mission_reward")).toEqual([["weekly_mission_reward", "exchangeTokens", 1]]);

    // A new week starts from zero
    const status = await import("../src/modules/economy/missions.service.js").then((m) =>
      m.getMissionsStatus(user.id, new Date(monday + 7 * DAY)),
    );
    expect(status.weekly).toMatchObject({ progress: 0, completed: false });
  });

  it("a daily mission pays once per day; progress resets the next economy day", async () => {
    const user = await createUser();
    const now = at("2026-10-20T15:00:00Z");
    const first = await prisma.$transaction((tx) => recordMissionEvent(tx, user.id, "game_won", now));
    const again = await prisma.$transaction((tx) => recordMissionEvent(tx, user.id, "game_won", now));
    expect(first.map((m) => m.missionId)).toEqual(["win_game"]);
    expect(again).toEqual([]);
    const tomorrow = await prisma.$transaction((tx) => recordMissionEvent(tx, user.id, "game_won", new Date(now.getTime() + DAY)));
    expect(tomorrow.map((m) => m.missionId)).toEqual(["win_game"]);
  });
});

// ---------------------------------------------------------------------------

describe("battle pass by activity", () => {
  it("builds 30 steps: 50 coins, packs at 10/20, holo at 30; premium = cosmetics + 4 packs + 1000 coins", () => {
    const rewards = battlePass.buildRewards(30);
    const standard = rewards.filter((r) => r.track === "standard");
    const premium = rewards.filter((r) => r.track === "premium");
    expect(standard).toHaveLength(30);
    expect(standard.filter((r) => r.rewardType === "pack").map((r) => r.day)).toEqual([10, 20]);
    expect(standard.find((r) => r.day === 30)?.rewardType).toBe("unowned_holo");
    expect(standard.filter((r) => r.rewardType === "coins").every((r) => r.amount === 50)).toBe(true);
    expect(premium.filter((r) => r.rewardType === "pack")).toHaveLength(4);
    expect(premium.filter((r) => r.rewardType === "coins").reduce((n, r) => n + (r.amount ?? 0), 0)).toBe(1000);
    // A 28-day month moves the last step's rewards to step 28
    const feb = battlePass.buildRewards(28);
    expect(feb.find((r) => r.day === 28 && r.track === "standard")?.rewardType).toBe("unowned_holo");
    expect(feb.some((r) => r.day > 28)).toBe(false);
  });

  it("steps can't be claimed before they're reached; a reached step pays once under concurrency", async () => {
    const user = await createUser();
    const pass = await battlePass.getCurrentPassWithProgress(user.id);
    await expect(battlePass.claimReward(pass.id, user.id, 1, "standard")).rejects.toMatchObject({ statusCode: 400 });

    await economy.checkIn(user.id);
    const { fulfilled } = await race(5, () => battlePass.claimReward(pass.id, user.id, 1, "standard"));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(ECONOMY.battlePass.standardCoinsPerStep);
    await expect(battlePass.claimReward(pass.id, user.id, 2, "standard")).rejects.toMatchObject({ statusCode: 400 });
    await expect(battlePass.claimReward(pass.id, user.id, 1, "premium")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("pack steps go to the pack inventory; the last step gives a holo the user doesn't own", async () => {
    const user = await createUser();
    const pass = await battlePass.getCurrentPassWithProgress(user.id);
    await prisma.userBattlePass.update({
      where: { userId_battlePassId: { userId: user.id, battlePassId: pass.id } },
      data: { steps: pass.enrollment!.maxSteps },
    });
    const pack = await battlePass.claimReward(pass.id, user.id, 10, "standard");
    expect(pack.granted).toMatchObject({ type: "pack", toInventory: true });
    expect(await unopened(user.id)).toHaveLength(1);

    const holos = ALL_CARDS.filter((c) => c.rarity === "rare-holo");
    const missing = holos[holos.length - 1];
    await giveCards(user.id, holos.slice(0, -1).map((c) => c.id));
    const holo = await battlePass.claimReward(pass.id, user.id, pass.enrollment!.maxSteps, "standard");
    expect(holo.granted).toMatchObject({ type: "card", cardDefId: missing.id });
  });

  it("the migration keeps old claims and treats the highest claimed day as reached", async () => {
    const sql = readFileSync("prisma/migrations/20261014000000_economy_v2/migration.sql", "utf8");
    const dataStep = sql.slice(sql.indexOf("-- Data: battle pass"));
    const user = await createUser();
    const pass = await battlePass.getCurrentPassWithProgress(user.id);
    const enrollment = await prisma.userBattlePass.findUniqueOrThrow({
      where: { userId_battlePassId: { userId: user.id, battlePassId: pass.id } },
    });
    await prisma.userBattlePassReward.createMany({
      data: [1, 2, 5].map((day) => ({ userBattlePassId: enrollment.id, day, track: "standard" })),
    });
    await prisma.$executeRawUnsafe(dataStep);
    const after = await battlePass.getCurrentPassWithProgress(user.id);
    expect(after.enrollment?.steps).toBe(5);
    // Unclaimed steps up to 5 are claimable, claimed ones aren't
    await expect(battlePass.claimReward(pass.id, user.id, 5, "standard")).rejects.toMatchObject({ statusCode: 409 });
    await battlePass.claimReward(pass.id, user.id, 3, "standard");
    await expect(battlePass.claimReward(pass.id, user.id, 6, "standard")).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------

describe("set milestones (replace collection/balance achievements)", () => {
  const jungle = getSetById("jungle")!;
  const jungleIds = jungle.cards.map((c) => c.id);

  it("50% pays 100 coins once (race-safe); 75% isn't reached yet", async () => {
    const user = await createUser();
    await giveCards(user.id, jungleIds.slice(0, Math.ceil(jungleIds.length / 2)));
    const { fulfilled } = await race(4, () => economy.claimSetMilestone(user.id, "jungle", 50));
    expect(fulfilled).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(100);
    await expect(economy.claimSetMilestone(user.id, "jungle", 75)).rejects.toMatchObject({ statusCode: 400 });
    await expect(economy.claimSetMilestone(user.id, "jungle", 60)).rejects.toMatchObject({ statusCode: 404 });
    await expect(economy.claimSetMilestone(user.id, "made-up", 50)).rejects.toMatchObject({ statusCode: 404 });
    expect(await txRows(user.id)).toEqual([["set_milestone", "coins", 100]]);
  });

  it("75% gives the set's card back, 100% the title and the holo variant; the whole catalog gives the collector title", async () => {
    const user = await createUser();
    await giveCards(user.id, jungleIds);
    await economy.claimSetMilestone(user.id, "jungle", 75);
    const full = await economy.claimSetMilestone(user.id, "jungle", 100);
    expect(full).toMatchObject({ coins: 500, titleMedalId: "title-maestro-jungle", skinId: "scyther-holo-sparkle" });
    expect(await prisma.userCardBack.findFirst({ where: { userId: user.id, cardBackId: "set-jungle" } })).not.toBeNull();
    expect(await prisma.userMedal.findFirst({ where: { userId: user.id, medalId: "title-maestro-jungle" } })).not.toBeNull();
    expect(await prisma.userCardSkin.findFirst({ where: { userId: user.id, skinId: "scyther-holo-sparkle" } })).not.toBeNull();

    await expect(economy.claimSetMilestone(user.id, economy.ALL_SETS_KEY, 100)).rejects.toMatchObject({ statusCode: 400 });
    await giveCards(user.id, ALL_CARDS.map((c) => c.id));
    expect(await economy.claimSetMilestone(user.id, economy.ALL_SETS_KEY, 100)).toMatchObject({ titleMedalId: "title-maestro-coleccionista" });

    const view = await economy.getSetMilestones(user.id);
    expect(view.sets.find((s) => s.setId === "jungle")?.tiers.map((t) => t.claimed)).toEqual([false, true, true]);
    expect(view.collector.tiers[0]).toMatchObject({ reached: true, claimed: true });
  });

  it("every configured holo variant exists in the skin catalog", () => {
    const skins = new Set(ALL_VARIANTS.map((v) => v.itemId));
    for (const set of CARD_SETS) {
      expect(skins.has(ECONOMY.setMilestones.holoVariantBySet[set.id])).toBe(true);
    }
  });
});

describe("achievements cleanup", () => {
  it("collection % and coin-balance achievements are retired: no progress, no claim", async () => {
    const user = await createUser({ coins: 50_000 });
    await prisma.userStats.create({ data: { userId: user.id } });
    await giveCards(user.id, ALL_CARDS.slice(0, 110).map((c) => c.id));
    await achievements.checkAndUpdateProgress(user.id);
    for (const id of ["gold-30", "legend-48", "gold-35", "platinum-43"]) {
      expect(await prisma.userAchievement.findFirst({ where: { userId: user.id, achievementId: id } })).toBeNull();
      await expect(achievements.claimAchievement(user.id, id)).rejects.toMatchObject({ statusCode: 400 });
    }
    // Small collection achievements still work
    await expect(achievements.claimAchievement(user.id, "silver-19")).resolves.toMatchObject({ coins: 500 });
  });

  it("a retired achievement already claimed stays claimed", async () => {
    const user = await createUser();
    await prisma.userAchievement.create({ data: { userId: user.id, achievementId: "legend-48", progress: 102, unlockedAt: new Date() } });
    await expect(achievements.claimAchievement(user.id, "legend-48")).rejects.toMatchObject({ statusCode: 409 });
    const list = await achievements.listAchievements(user.id);
    expect(list.find((a) => a.id === "legend-48")).toMatchObject({ status: "retired", claimed: true });
  });

  it("manual achievements are flagged unavailable; Leyenda Viviente only needs the obtainable ones", async () => {
    const user = await createUser();
    const list = await achievements.listAchievements(user.id);
    expect(list.filter((a) => a.status === "unavailable")).toHaveLength(30);
    expect(list.filter((a) => a.status === "retired")).toHaveLength(4);
    const active = list.filter((a) => a.status === "active" && a.id !== "legend-50");
    expect(list.find((a) => a.id === "legend-50")?.progressTarget).toBe(active.length);
    await expect(achievements.claimAchievement(user.id, "bronze-3")).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------

describe("Fichas de canje", () => {
  const common = ALL_CARDS.find((c) => c.rarity === "common" && !isBasicEnergy(c))!;
  const rare = ALL_CARDS.find((c) => c.rarity === "rare")!;
  const holo = ALL_CARDS.find((c) => c.rarity === "rare-holo")!;
  const energy = ALL_CARDS.find((c) => isBasicEnergy(c))!;

  it("1 token for a card up to rare, 2 for a holo; basic Energy and unknown cards are rejected", async () => {
    const user = await createUser();
    await expect(economy.redeemExchangeToken(user.id, common.id)).rejects.toMatchObject({ statusCode: 400 });
    await prisma.user.update({ where: { id: user.id }, data: { exchangeTokens: 3 } });
    await expect(economy.redeemExchangeToken(user.id, energy.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(economy.redeemExchangeToken(user.id, "made-up-card")).rejects.toMatchObject({ statusCode: 404 });

    expect(await economy.redeemExchangeToken(user.id, rare.id)).toMatchObject({ cost: 1, exchangeTokens: 2 });
    expect(await economy.redeemExchangeToken(user.id, holo.id)).toMatchObject({ cost: 2, exchangeTokens: 0 });
    expect(await txRows(user.id, "exchange_redeem")).toEqual([
      ["exchange_redeem", "exchangeTokens", -1],
      ["exchange_redeem", "exchangeTokens", -2],
    ]);
  });

  it("never spends more tokens than the user has under concurrency", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { exchangeTokens: 1 } });
    const { fulfilled } = await race(5, () => economy.redeemExchangeToken(user.id, common.id));
    expect(fulfilled).toHaveLength(1);
    expect((await prisma.userCard.findFirstOrThrow({ where: { userId: user.id, cardDefId: common.id } })).quantity).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("Rare Candy → coins: 2 per economy week", () => {
  it("the third conversion of the week is rejected without spending the candy", async () => {
    const user = await createUser({ rareCandy: 5 });
    const now = at("2026-10-14T15:00:00Z");
    const { fulfilled } = await race(4, () => marketService.convertRareCandy(user.id, "coins", now));
    expect(fulfilled).toHaveLength(2);
    expect(await getBalances(user.id)).toMatchObject({ rareCandy: 3, coins: 4000 });
    // Coupons aren't limited
    await marketService.convertRareCandy(user.id, "coupons", now);
    expect((await getBalances(user.id)).rareCandy).toBe(2);
    // Next Monday 00:00 Argentina resets the limit
    const res = await marketService.convertRareCandy(user.id, "coins", at("2026-10-19T03:00:00Z"));
    expect(res).toMatchObject({ amount: 2000, coinConversionsLeftThisWeek: 1 });
  });
});

// ---------------------------------------------------------------------------

describe("daily market", () => {
  it("the mystery card never reveals its id before purchase; buying it gives a real card", async () => {
    const user = await createUser({ coins: 1000 });
    const offers = await marketService.getDailyOffers(user.id);
    const mystery = offers.cardOffers.find((o) => o.isMystery)!;
    expect(mystery).toMatchObject({ cardDefId: "mystery", name: "???", set: "unknown", number: 0 });
    const json = JSON.stringify({ ...offers, energyOffers: [] }); // basic Energy offers list their ids on purpose
    const realIds = ALL_CARDS.map((c) => c.id).filter((id) => json.includes(`"${id}"`));
    expect(realIds).toHaveLength(3); // only the 3 visible offers

    const bought = await marketService.buyDailyCard(user.id, "mystery");
    expect(bought.revealed).toBe(true);
    expect(ALL_CARDS.some((c) => c.id === bought.cardDefId)).toBe(true);
    // The transaction history names the card that came out
    const purchase = await prisma.transaction.findFirst({ where: { userId: user.id, type: "card_purchase" } });
    expect(purchase?.description).toBe(`Compra de carta: Carta misteriosa (${bought.name})`);
    expect((await marketService.getDailyOffers(user.id)).purchasedToday).toContain("card:mystery");
    await expect(marketService.buyDailyCard(user.id, "mystery")).rejects.toThrow();
  });

  it("offers Trainers and special Energy too, never basic Energy", async () => {
    const kinds = new Set<string>();
    const start = at("2026-10-01T15:00:00Z").getTime();
    for (let d = 0; d < 120; d++) {
      const { cardOffers } = await marketService.getDailyOffers(undefined, new Date(start + d * DAY));
      for (const o of cardOffers.filter((c) => !c.isMystery)) {
        kinds.add(o.kind);
        const card = ALL_CARDS.find((c) => c.id === o.cardDefId)!;
        expect(isBasicEnergy(card)).toBe(false);
      }
    }
    expect(kinds.has("trainer")).toBe(true);
    expect(kinds.has("pokemon")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("odds", () => {
  it("pack odds come from the generator: Base ~66.5% holo, other sets always a holo", () => {
    const base = getPackOdds("base-set-booster")!;
    expect(base.price).toBe(ECONOMY.packs.price);
    // 0.665 in the rare slot, plus the 1% uncommon upgrades and the second rare into rare ∪ holo
    expect(base.holoChance).toBeGreaterThan(0.665);
    expect(base.holoChance).toBeLessThan(0.72);
    for (const id of ["jungle-booster", "fossil-booster", "team-rocket-booster"]) {
      expect(getPackOdds(id)!.holoChance).toBe(1);
    }
    expect(getPackOdds("base-set-theme-pack")).toBeNull();
  });

  it("boosters hold no basic Energy: 1 rare, 4 uncommons (the 4th a second rare with SECOND_RARE_CHANCE), 6 commons", () => {
    const n = 3000;
    let secondRare = 0;
    for (const packId of [...STANDARD_BOOSTER_IDS, TRAINER_BOOSTER_ID]) {
      for (let i = 0; i < 50; i++) {
        const cards = openPack(packId).cards;
        expect(cards).toHaveLength(11);
        expect(cards.some((c) => isBasicEnergy(c.card))).toBe(false);
      }
    }
    for (let i = 0; i < n; i++) {
      const rares = openPack("gym-challenge-booster").cards.filter((c) => c.card.rarity === "rare" || c.card.rarity === "rare-holo");
      if (rares.length >= 2) secondRare++;
    }
    // SECOND_RARE_CHANCE plus the 3 uncommons' 1% upgrades
    const expected = 1 - (1 - SECOND_RARE_CHANCE) * 0.99 ** 3;
    expect(Math.abs(secondRare / n - expected)).toBeLessThan(0.025);
  });

  it("matches a simulation of openPack", () => {
    const n = 4000;
    let holoPacks = 0;
    let beedrill = 0;
    for (let i = 0; i < n; i++) {
      const cards = openPack("base-set-booster").cards;
      if (cards.some((c) => c.card.rarity === "rare-holo")) holoPacks++;
      if (cards.some((c) => c.card.id === "base-set-017-beedrill")) beedrill++;
    }
    const odds = getPackOdds("base-set-booster")!;
    expect(Math.abs(holoPacks / n - odds.holoChance)).toBeLessThan(0.035);
    expect(Math.abs(beedrill / n - odds.cardChances["base-set-017-beedrill"])).toBeLessThan(0.015);
  });

  it("every pack costs the same; wheel and slots probabilities add up to 1", () => {
    const odds = getOdds();
    expect(new Set(odds.packs.map((p) => p.price))).toEqual(new Set([ECONOMY.packs.price]));
    expect(odds.packs.map((p) => p.packId).sort()).toEqual([...STANDARD_BOOSTER_IDS, "trainer-booster"].sort());
    const sum = (xs: { probability: number }[]) => xs.reduce((n, x) => n + x.probability, 0);
    expect(sum(odds.wheel.segments)).toBeCloseTo(1, 5);
    expect(sum(odds.slots.patterns)).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------

describe("HTTP", () => {
  it("validates bodies, exposes status/config/odds and retires the daily coins", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    const app = await startHttpApp((a) => {
      a.use("/api", economyRouter);
      a.use("/api/users", usersRouter);
    });
    try {
      expect((await app.request("GET", "/api/economy/odds")).status).toBe(200);
      const config = await app.request("GET", "/api/economy/config");
      expect(config.body).toMatchObject({ timeZone: "America/Argentina/Buenos_Aires", packs: { price: 200 } });
      expect((await app.request("GET", "/api/economy/status")).status).toBe(401);

      expect((await app.request("POST", "/api/economy/daily-pack", { token, body: {} })).status).toBe(422);
      expect((await app.request("POST", "/api/economy/milestones/claim", { token, body: { setId: "jungle", percent: -5 } })).status).toBe(422);
      expect((await app.request("POST", "/api/economy/exchange", { token, body: { cardDefId: 5 } })).status).toBe(422);
      expect((await app.request("POST", "/api/economy/packs/not-a-uuid/open", { token, body: {} })).status).toBe(404);

      const claimed = await app.request("POST", "/api/economy/daily-pack", { token, body: { packId: "base-set-booster" } });
      expect(claimed.status).toBe(200);
      expect((await app.request("POST", "/api/economy/daily-pack", { token, body: { packId: "base-set-booster" } })).status).toBe(409);

      const status = await app.request("GET", "/api/economy/status", { token });
      expect(status.body).toMatchObject({
        dailyPack: { available: false },
        checkIn: { checkedInToday: true, loginDays: 1 },
        tableBetsEnabled: false,
      });
      expect(status.body.missions.daily.find((m: { id: string }) => m.id === "open_daily_pack")).toMatchObject({ completed: true });

      expect((await app.request("POST", "/api/users/me/claim-daily-coins", { token })).status).toBe(410);
    } finally {
      await app.close();
    }
  });
});

describe("accounts without a verified email (requireVerifiedEmail)", () => {
  it("check-in grants nothing and keeps the day open until the email is verified", async () => {
    const user = await newAccount();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: false } });
    const now = at("2026-10-14T15:00:00Z");

    const blocked = await economy.checkIn(user.id, now);
    expect(blocked).toMatchObject({ alreadyCheckedIn: false, emailVerified: false, loginDays: 0, granted: { firstStepsPacks: 0, calendar: null, battlePassStep: null } });
    expect(await prisma.economyClaim.count({ where: { userId: user.id, kind: "check_in" } })).toBe(0);
    expect(await prisma.userPack.count({ where: { userId: user.id, source: "first_steps" } })).toBe(0);

    // Verified later the same day: that day's check-in still pays
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    const paid = await economy.checkIn(user.id, now);
    expect(paid).toMatchObject({ alreadyCheckedIn: false, emailVerified: true, loginDays: 1, granted: { firstStepsPacks: 1 } });
  });

  it("OAuth accounts count as verified", async () => {
    const user = await createUser({}, { emailVerified: false, provider: "google" });
    expect(await economy.checkIn(user.id, at("2026-10-14T15:00:00Z"))).toMatchObject({ emailVerified: true, loginDays: 1 });
  });

  it("every economy v2 route that grants or spends answers 403 EMAIL_NOT_VERIFIED", async () => {
    const user = await newAccount();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: false, exchangeTokens: 5 } });
    const [pack] = await unopened(user.id);
    const token = tokenFor(user);
    const app = await startHttpApp((a) => a.use("/api", economyRouter));
    try {
      const blocked = [
        await app.request("POST", "/api/economy/daily-pack", { token, body: { packId: "base-set-booster" } }),
        await app.request("POST", `/api/economy/packs/${pack.id}/open`, { token, body: {} }),
        await app.request("POST", "/api/economy/exchange", { token, body: { cardDefId: "base-set-071-computer-search" } }),
        await app.request("POST", "/api/economy/milestones/claim", { token, body: { setId: "jungle", percent: 50 } }),
      ];
      for (const res of blocked) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED", error: { code: "EMAIL_NOT_VERIFIED" } });
      }
      const checkIn = await app.request("POST", "/api/economy/check-in", { token });
      expect(checkIn.status).toBe(200);
      expect(checkIn.body).toMatchObject({ emailVerified: false, granted: { firstStepsPacks: 0 } });
      const status = await app.request("GET", "/api/economy/status", { token });
      expect(status.body).toMatchObject({ emailVerified: false, checkIn: { checkedInToday: false } });
      expect(await prisma.userPack.count({ where: { userId: user.id, openedAt: { not: null } } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).exchangeTokens).toBe(5);
    } finally {
      await app.close();
    }
  });
});
