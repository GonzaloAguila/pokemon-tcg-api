import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { ECONOMY } from "../src/modules/economy/config.js";
import { PUZZLES, TUTORIAL_LESSONS } from "../src/modules/progress/catalog.js";
import * as progress from "../src/modules/progress/progress.service.js";
import { progressRouter } from "../src/modules/progress/index.js";
import { economyRouter } from "../src/modules/economy/index.js";
import { createUser, getBalances, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

let app: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  app = await startHttpApp((a) => {
    a.use("/api", progressRouter);
    a.use("/api", economyRouter);
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function completeLessons(userId: string, count = TUTORIAL_LESSONS.length) {
  for (const id of TUTORIAL_LESSONS.slice(0, count)) await progress.completeTutorialLesson(userId, id);
}

async function rewardRows(userId: string, type: string) {
  return prisma.transaction.findMany({ where: { userId, type } });
}

describe("catalog", () => {
  it("has 4 lessons and 12 puzzles with their tiers", () => {
    expect(TUTORIAL_LESSONS).toEqual(["basics", "evolution", "trainers", "status"]);
    expect(PUZZLES.map((p) => p.id)).toEqual(Array.from({ length: 12 }, (_, i) => `puzzle-${String(i + 1).padStart(2, "0")}`));
    expect(PUZZLES.map((p) => p.tier)).toEqual([
      "easy", "easy", "easy", "easy", "medium", "medium", "medium", "medium", "hard", "hard", "hard", "hard",
    ]);
    expect(ECONOMY.progress).toEqual({ tutorialReward: { coins: 300, packs: 1 }, puzzleCoins: { easy: 50, medium: 100, hard: 200 } });
  });
});

describe("GET /api/progress", () => {
  it("needs a session", async () => {
    expect((await app.request("GET", "/api/progress")).status).toBe(401);
  });

  it("starts empty and lists completions in catalog order", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect((await app.request("GET", "/api/progress", { token })).body).toEqual({
      tutorial: { completed: [], rewardClaimed: false },
      puzzles: { completed: [] },
    });
    await completeLessons(user.id, 2);
    await progress.completePuzzle(user.id, "puzzle-01");
    const res = await app.request("GET", "/api/progress", { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tutorial: { completed: ["basics", "evolution"], rewardClaimed: false },
      puzzles: { completed: ["puzzle-01"] },
    });
  });
});

describe("tutorial lessons", () => {
  it("go in order, are idempotent and pay nothing by themselves", async () => {
    const user = await createUser();
    const token = tokenFor(user);

    const early = await app.request("POST", "/api/progress/tutorial/evolution", { token });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toBe("Completá la lección anterior");

    const first = await app.request("POST", "/api/progress/tutorial/basics", { token });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ tutorial: { completed: ["basics"], rewardClaimed: false }, puzzles: { completed: [] } });

    const again = await app.request("POST", "/api/progress/tutorial/basics", { token });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await prisma.userProgress.count({ where: { userId: user.id } })).toBe(1);

    expect((await app.request("POST", "/api/progress/tutorial/evolution", { token })).status).toBe(200);
    expect((await getBalances(user.id)).coins).toBe(0);
  });

  it("unknown lesson → 404, no session → 401, unverified email → 403", async () => {
    const user = await createUser();
    expect((await app.request("POST", "/api/progress/tutorial/advanced", { token: tokenFor(user) })).status).toBe(404);
    expect((await app.request("POST", "/api/progress/tutorial/basics")).status).toBe(401);

    const unverified = await createUser({}, { emailVerified: false });
    const res = await app.request("POST", "/api/progress/tutorial/basics", { token: tokenFor(unverified) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await prisma.userProgress.count({ where: { userId: unverified.id } })).toBe(0);
  });

  it("concurrent completions of the same lesson insert one row", async () => {
    const user = await createUser();
    const { fulfilled, rejected } = await race(6, () => progress.completeTutorialLesson(user.id, "basics"));
    expect(rejected).toHaveLength(0);
    expect(fulfilled).toHaveLength(6);
    expect(await prisma.userProgress.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("tutorial reward", () => {
  it("requires every lesson", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await completeLessons(user.id, 3);
    const res = await app.request("POST", "/api/progress/tutorial/claim", { token });
    expect(res.status).toBe(409);
    expect(await prisma.economyClaim.count({ where: { userId: user.id } })).toBe(0);
    expect((await getBalances(user.id)).coins).toBe(0);
  });

  it("pays 300 coins + one choose-your-set pack once", async () => {
    const user = await createUser({ coins: 10 });
    const token = tokenFor(user);
    await completeLessons(user.id);

    const res = await app.request("POST", "/api/progress/tutorial/claim", { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      coins: 300,
      packs: 1,
      progress: { tutorial: { completed: [...TUTORIAL_LESSONS], rewardClaimed: true }, puzzles: { completed: [] } },
    });
    expect((await getBalances(user.id)).coins).toBe(310);
    const packs = await prisma.userPack.findMany({ where: { userId: user.id } });
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ source: "tutorial", packId: null, openedAt: null });
    const rows = await rewardRows(user.id, "tutorial_reward");
    expect(rows.map((r) => [r.currency, r.amount, r.description])).toEqual([["coins", 300, "Tutorial completado"]]);

    expect((await app.request("POST", "/api/progress/tutorial/claim", { token })).status).toBe(409);
    expect((await app.request("GET", "/api/progress", { token })).body.tutorial.rewardClaimed).toBe(true);
    expect((await getBalances(user.id)).coins).toBe(310);

    // The stored pack shows up in the inventory with its label
    const inventory = await app.request("GET", "/api/economy/packs", { token });
    expect(inventory.body.packs).toEqual([
      expect.objectContaining({ source: "tutorial", sourceLabel: "Tutorial completado", chooseSet: true }),
    ]);
  });

  it("pays once under concurrent claims", async () => {
    const user = await createUser();
    await completeLessons(user.id);
    const { fulfilled, rejected } = await race(8, () => progress.claimTutorialReward(user.id));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect((await getBalances(user.id)).coins).toBe(300);
    expect(await prisma.userPack.count({ where: { userId: user.id } })).toBe(1);
    expect(await rewardRows(user.id, "tutorial_reward")).toHaveLength(1);
  });

  it("no session → 401, unverified email → 403", async () => {
    expect((await app.request("POST", "/api/progress/tutorial/claim")).status).toBe(401);
    const user = await createUser({}, { emailVerified: false });
    await completeLessons(user.id);
    const res = await app.request("POST", "/api/progress/tutorial/claim", { token: tokenFor(user) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect((await getBalances(user.id)).coins).toBe(0);
  });
});

describe("puzzles", () => {
  it("go in order and pay their tier's coins on the first solve only", async () => {
    const user = await createUser();
    const token = tokenFor(user);

    const early = await app.request("POST", "/api/progress/puzzles/puzzle-02", { token });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toBe("Resolvé el puzzle anterior");

    const first = await app.request("POST", "/api/progress/puzzles/puzzle-01", { token });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      firstTime: true,
      coins: 50,
      progress: { tutorial: { completed: [], rewardClaimed: false }, puzzles: { completed: ["puzzle-01"] } },
    });
    const repeat = await app.request("POST", "/api/progress/puzzles/puzzle-01", { token });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ firstTime: false, coins: 0, progress: { puzzles: { completed: ["puzzle-01"] } } });
    expect((await getBalances(user.id)).coins).toBe(50);

    // Every tier, in order
    let total = 50;
    for (const puzzle of PUZZLES.slice(1)) {
      const res = await progress.completePuzzle(user.id, puzzle.id);
      expect(res.firstTime).toBe(true);
      expect(res.coins).toBe({ easy: 50, medium: 100, hard: 200 }[puzzle.tier]);
      total += res.coins;
    }
    expect(total).toBe(4 * 50 + 4 * 100 + 4 * 200);
    expect((await getBalances(user.id)).coins).toBe(total);
    const rows = await rewardRows(user.id, "puzzle_reward");
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.description)).toContain("Puzzle 3 resuelto");
  });

  it("pays once per puzzle under concurrent reports", async () => {
    const user = await createUser();
    const { fulfilled, rejected } = await race(8, () => progress.completePuzzle(user.id, "puzzle-01"));
    expect(rejected).toHaveLength(0);
    expect(fulfilled.filter((r) => r.value.firstTime)).toHaveLength(1);
    expect(fulfilled.filter((r) => r.value.coins > 0)).toHaveLength(1);
    expect((await getBalances(user.id)).coins).toBe(50);
    expect(await rewardRows(user.id, "puzzle_reward")).toHaveLength(1);
    expect(await prisma.userProgress.count({ where: { userId: user.id, track: "puzzles" } })).toBe(1);
  });

  it("unknown puzzle → 404, no session → 401, unverified email → 403", async () => {
    const user = await createUser();
    expect((await app.request("POST", "/api/progress/puzzles/puzzle-13", { token: tokenFor(user) })).status).toBe(404);
    expect((await app.request("POST", "/api/progress/puzzles/basics", { token: tokenFor(user) })).status).toBe(404);
    expect((await app.request("POST", "/api/progress/puzzles/puzzle-01")).status).toBe(401);

    const unverified = await createUser({}, { emailVerified: false });
    const res = await app.request("POST", "/api/progress/puzzles/puzzle-01", { token: tokenFor(unverified) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect((await getBalances(unverified.id)).coins).toBe(0);
  });
});
