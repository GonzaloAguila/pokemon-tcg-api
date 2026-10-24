import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { backfillAchievementCosmetics, checkAndUpdateProgress, claimAchievement, listAchievements } from "../src/modules/achievements/achievements.service.js";
import { AVAILABLE_PLAYMATS } from "../src/modules/prizes/catalog.js";
import * as adventure from "../src/modules/adventure/adventure.service.js";
import { validateAdventure } from "../src/modules/adventure/content/load.js";
import { isGrantableCosmetic } from "../src/modules/admin/grantable-cosmetics.js";
import { updateCosmetics } from "../src/modules/users/users.service.js";
import { createUser, getBalances } from "./helpers.js";

const ADVENTURE = "pueblo-paleta-bosque-verde";

afterAll(async () => {
  await prisma.$disconnect();
});

type Progress = Partial<{
  clearsNormal: number;
  clearsHard: number;
  clearedStartersNormal: string[];
  clearedStartersHard: string[];
  flawlessClears: number;
  puristClears: number;
  monotypeClears: number;
}>;

/** A user with a hand-built AdventureProgress, achievements checked. */
async function withProgress(progress: Progress, options: { stats?: boolean } = { stats: true }) {
  const user = await createUser({}, { stats: options.stats });
  await prisma.adventureProgress.create({ data: { userId: user.id, adventureId: ADVENTURE, ...progress } });
  await checkAndUpdateProgress(user.id);
  const list = await listAchievements(user.id);
  const state = (id: string) => list.find((a) => a.id === id)!;
  return { user, state };
}

describe("adventure achievements", () => {
  const cases: [string, Progress, Progress][] = [
    ["adventure-1-clear-normal", { clearsNormal: 1 }, { clearsHard: 1 }],
    ["adventure-1-clear-hard", { clearsHard: 1 }, { clearsNormal: 3 }],
    ["adventure-1-flawless", { clearsNormal: 1, flawlessClears: 1 }, { clearsNormal: 2 }],
    [
      "adventure-1-all-starters",
      { clearedStartersNormal: ["charmander", "squirtle"], clearedStartersHard: ["bulbasaur"] },
      { clearedStartersNormal: ["charmander", "squirtle"], clearedStartersHard: ["squirtle"] },
    ],
    [
      "adventure-1-all-starters-hard",
      { clearedStartersHard: ["charmander", "squirtle", "bulbasaur"] },
      { clearedStartersNormal: ["charmander", "squirtle", "bulbasaur"], clearedStartersHard: ["charmander", "squirtle"] },
    ],
    ["adventure-1-purist", { clearsNormal: 1, puristClears: 1 }, { clearsNormal: 1 }],
    ["adventure-1-monotype", { clearsHard: 1, monotypeClears: 1 }, { clearsHard: 1 }],
  ];

  it.each(cases)("%s: met by one progress, not by the other", async (id, meets, misses) => {
    const yes = await withProgress(meets);
    expect(yes.state(id)).toMatchObject({ status: "active", claimable: true, claimed: false });
    const no = await withProgress(misses);
    expect(no.state(id).claimable).toBe(false);
  });

  it("all starters shows partial progress (2 of 3)", async () => {
    const { state } = await withProgress({ clearedStartersNormal: ["charmander"], clearedStartersHard: ["charmander", "squirtle"] });
    expect(state("adventure-1-all-starters")).toMatchObject({ progress: 2, progressTarget: 3 });
    expect(state("adventure-1-all-starters-hard")).toMatchObject({ progress: 2, progressTarget: 3 });
  });

  it("progresses for an account without a UserStats row too", async () => {
    const { state } = await withProgress({ clearsNormal: 1 }, { stats: false });
    expect(state("adventure-1-clear-normal").claimable).toBe(true);
  });

  it("is claimed through the existing claim with the tier's reward", async () => {
    const { user } = await withProgress({ clearsNormal: 1, flawlessClears: 1 });
    expect(await claimAchievement(user.id, "adventure-1-clear-normal")).toEqual({ achievementId: "adventure-1-clear-normal", coins: 200, coupons: 0, cosmetic: null });
    expect(await claimAchievement(user.id, "adventure-1-flawless")).toEqual({ achievementId: "adventure-1-flawless", coins: 500, coupons: 0, cosmetic: null });
    expect((await getBalances(user.id)).coins).toBe(700);
    await expect(claimAchievement(user.id, "adventure-1-clear-hard")).rejects.toThrow("todavía no está completo");
  });

  it("doesn't move the Legend meta target, nor count for it", async () => {
    const { user, state } = await withProgress({ clearsNormal: 1 });
    expect(state("legend-50").progressTarget).toBe(26);
    await claimAchievement(user.id, "adventure-1-clear-normal");
    await checkAndUpdateProgress(user.id);
    expect((await listAchievements(user.id)).find((a) => a.id === "legend-50")!.progress).toBe(0);
  });

  it("a won run built by hand meets flawless, purist and monotype; another doesn't", async () => {
    const user = await createUser({}, { stats: true });
    async function winRun(data: { heartsLost: number; treasuresTaken: string[]; offTypeUsed: boolean }) {
      const run = await adventure.createRun(user.id, { adventureId: ADVENTURE, difficulty: "hard", starterId: "squirtle" });
      await prisma.adventureRun.update({
        where: { id: run.id },
        data: { ...data, currentBattle: 10, phase: "in_battle", battle: { roomId: "adv-test", startedAt: new Date().toISOString() } },
      });
      return adventure.applyRunBattleResult(run.id, { victory: true, reason: "prizes", turns: 22 });
    }
    await winRun({ heartsLost: 1, treasuresTaken: ["t1-bill"], offTypeUsed: true });
    let list = await listAchievements(user.id);
    const claimable = (id: string) => list.find((a) => a.id === id)!.claimable;
    expect(claimable("adventure-1-clear-hard")).toBe(true);
    expect([claimable("adventure-1-flawless"), claimable("adventure-1-purist"), claimable("adventure-1-monotype")]).toEqual([false, false, false]);

    await winRun({ heartsLost: 0, treasuresTaken: [], offTypeUsed: false });
    list = await listAchievements(user.id);
    expect([claimable("adventure-1-flawless"), claimable("adventure-1-purist"), claimable("adventure-1-monotype")]).toEqual([true, true, true]);
  });
});

describe("Esta vez en serio (hard clear): platinum + the Ciudad Plateada playmat", () => {
  const PLAYMAT = "playmat-ciudad-plateada";
  const owns = async (userId: string) => (await prisma.userPlaymat.count({ where: { userId, playmatId: PLAYMAT } })) === 1;

  it("is platinum and shows its cosmetic in GET /achievements", async () => {
    const { state } = await withProgress({ clearsHard: 1 });
    expect(state("adventure-1-clear-hard")).toMatchObject({
      tier: "platinum",
      reward: { coins: 1500, coupons: 10 },
      cosmetic: { type: "playmat", id: PLAYMAT, name: "Tapete Ciudad Plateada", imageUrl: "/bg/bg-ciudad-plateada.jpg" },
      claimable: true,
    });
    expect(state("adventure-1-clear-normal").cosmetic).toBeNull();
  });

  it("the claim grants the playmat with the tier reward, in the same transaction, once (also under concurrency)", async () => {
    const { user } = await withProgress({ clearsHard: 1 });
    await expect(updateCosmetics(user.id, { activePlaymatId: PLAYMAT })).rejects.toThrow("No posees ese tapete");
    const results = await Promise.allSettled([
      claimAchievement(user.id, "adventure-1-clear-hard"),
      claimAchievement(user.id, "adventure-1-clear-hard"),
      claimAchievement(user.id, "adventure-1-clear-hard"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof claimAchievement>>>[];
    expect(ok).toHaveLength(1);
    expect(ok[0].value).toEqual({
      achievementId: "adventure-1-clear-hard",
      coins: 1500,
      coupons: 10,
      cosmetic: { type: "playmat", id: PLAYMAT, name: "Tapete Ciudad Plateada", imageUrl: "/bg/bg-ciudad-plateada.jpg" },
    });
    expect(await prisma.userPlaymat.count({ where: { userId: user.id, playmatId: PLAYMAT } })).toBe(1);
    expect((await getBalances(user.id)).coins).toBe(1500);
    expect(await updateCosmetics(user.id, { activePlaymatId: PLAYMAT })).toMatchObject({ activePlaymatId: PLAYMAT });
  });

  it("a player who already owns it (admin grant) still claims fine", async () => {
    const { user } = await withProgress({ clearsHard: 1 });
    await prisma.userPlaymat.create({ data: { userId: user.id, playmatId: PLAYMAT } });
    await claimAchievement(user.id, "adventure-1-clear-hard");
    expect(await owns(user.id)).toBe(true);
  });

  it("earlier claimers get it from the one-off backfill, once; unclaimed players don't", async () => {
    const early = await withProgress({ clearsHard: 1 });
    const pending = await withProgress({ clearsHard: 1 });
    // Claimed before the achievement had a cosmetic: unlockedAt set, no playmat
    await prisma.userAchievement.update({
      where: { userId_achievementId: { userId: early.user.id, achievementId: "adventure-1-clear-hard" } },
      data: { unlockedAt: new Date() },
    });
    const first = await backfillAchievementCosmetics();
    expect(first["adventure-1-clear-hard"]).toBeGreaterThanOrEqual(1);
    expect(await owns(early.user.id)).toBe(true);
    expect(await owns(pending.user.id)).toBe(false);
    await backfillAchievementCosmetics();
    expect(await prisma.userPlaymat.count({ where: { userId: early.user.id, playmatId: PLAYMAT } })).toBe(1);
  });

  it("admins can grant it; it is never sold", () => {
    expect(isGrantableCosmetic("playmat", PLAYMAT)).toBe(true);
    expect(AVAILABLE_PLAYMATS.some((p) => p.itemId === PLAYMAT)).toBe(false);
  });
});

describe("Bosque Verde card back", () => {
  it("is owned and equippable after a normal clear, not before", async () => {
    const user = await createUser({}, { stats: true });
    await expect(updateCosmetics(user.id, { activeCardBackId: "cardback-bosque-verde" })).rejects.toThrow("No posees ese reverso");
    const run = await adventure.createRun(user.id, { adventureId: ADVENTURE, difficulty: "normal", starterId: "charmander" });
    await prisma.adventureRun.update({ where: { id: run.id }, data: { currentBattle: 10, phase: "in_battle", battle: { roomId: "adv-x", startedAt: new Date().toISOString() } } });
    await adventure.applyRunBattleResult(run.id, { victory: true, reason: "no-pokemon", turns: 12 });
    expect(await updateCosmetics(user.id, { activeCardBackId: "cardback-bosque-verde" })).toMatchObject({ activeCardBackId: "cardback-bosque-verde" });
  });

  it("admins can grant it", () => {
    expect(isGrantableCosmetic("cardBack", "cardback-bosque-verde")).toBe(true);
  });

  it("the content's cosmetic reward must be a known card back", () => {
    const data = JSON.parse(readFileSync(path.resolve(__dirname, "../content/adventures/pueblo-paleta-bosque-verde.json"), "utf8"));
    data.rewards.normal.id = "cardback-nope";
    const result = validateAdventure(data);
    expect(result.ok ? [] : result.problems).toContain("Recompensa normal: dorso de carta desconocido cardback-nope");
  });
});

describe("adventure 2 progress", () => {
  const ADV2 = "ciudad-plateada-ciudad-celeste";

  async function winAdv2(userId: string, stolen: boolean) {
    await prisma.user.update({ where: { id: userId }, data: { coins: { increment: 50 } } });
    await prisma.userMedal.upsert({ where: { userId_medalId: { userId, medalId: "boulder" } }, update: {}, create: { userId, medalId: "boulder" } });
    const run = await adventure.createRun(userId, { adventureId: ADV2, difficulty: "normal", starterId: "charmander" });
    await prisma.adventureRun.update({
      where: { id: run.id },
      data: {
        currentBattle: 10,
        phase: "in_battle",
        cardsStolen: stolen ? 2 : 0,
        stolen: stolen ? [{ cardId: "base-set-004-charizard", qty: 1 }] : [],
        battle: { roomId: "adv-test", startedAt: new Date().toISOString() },
      },
    });
    return adventure.applyRunBattleResult(run.id, { victory: true, reason: "prizes", turns: 20 });
  }

  it("a clear without steals counts for noSteal; a clear with a steal does not", async () => {
    const dirty = await createUser({}, { stats: true });
    await winAdv2(dirty.id, true);
    const dirtyList = await listAchievements(dirty.id);
    expect(dirtyList.find((a) => a.id === "adventure-2-no-steal")!.claimable).toBe(false);
    expect(dirtyList.find((a) => a.id === "adventure-2-clear-normal")!.claimable).toBe(true);

    const clean = await createUser({}, { stats: true });
    await winAdv2(clean.id, false);
    expect((await listAchievements(clean.id)).find((a) => a.id === "adventure-2-no-steal")!.claimable).toBe(true);
    expect(await prisma.adventureProgress.findUniqueOrThrow({ where: { userId_adventureId: { userId: clean.id, adventureId: ADV2 } } })).toMatchObject({ noStealClears: 1 });
  });

  it("all-starters counts only starters without requiresUnlock (3 of 3, Pikachu not required)", async () => {
    const user = await createUser({}, { stats: true });
    await prisma.adventureProgress.create({
      data: { userId: user.id, adventureId: ADV2, clearedStartersNormal: ["charmander", "squirtle", "bulbasaur"] },
    });
    await checkAndUpdateProgress(user.id);
    const list = await listAchievements(user.id);
    expect(list.find((a) => a.id === "adventure-2-all-starters")).toMatchObject({ progress: 3, progressTarget: 3, claimable: true });
    expect(list.find((a) => a.id === "adventure-2-all-starters")!.description).toContain("3 iniciales");
    expect(list.find((a) => a.id === "adventure-2-all-starters-hard")!.description).toContain("3 iniciales");
    const other = await createUser({}, { stats: true });
    await prisma.adventureProgress.create({ data: { userId: other.id, adventureId: ADV2, clearedStartersNormal: ["pikachu", "charmander"] } });
    await checkAndUpdateProgress(other.id);
    expect((await listAchievements(other.id)).find((a) => a.id === "adventure-2-all-starters")).toMatchObject({ progress: 1, progressTarget: 3 });
  });
});
