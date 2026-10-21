import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { checkAndUpdateProgress, claimAchievement, listAchievements } from "../src/modules/achievements/achievements.service.js";
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
    expect(await claimAchievement(user.id, "adventure-1-clear-normal")).toEqual({ achievementId: "adventure-1-clear-normal", coins: 200, coupons: 0 });
    expect(await claimAchievement(user.id, "adventure-1-flawless")).toEqual({ achievementId: "adventure-1-flawless", coins: 500, coupons: 0 });
    expect((await getBalances(user.id)).coins).toBe(700);
    await expect(claimAchievement(user.id, "adventure-1-clear-hard")).rejects.toThrow("todavía no está completo");
  });

  it("doesn't move the Legend meta target, nor count for it", async () => {
    const { user, state } = await withProgress({ clearsNormal: 1 });
    expect(state("legend-50").progressTarget).toBe(25);
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
