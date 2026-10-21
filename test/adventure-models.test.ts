import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

function runData(userId: string, status = "active") {
  return {
    userId,
    adventureId: "pueblo-paleta-bosque-verde",
    adventureVersion: 1,
    difficulty: "normal",
    starterId: "charmander",
    status,
    phase: status === "active" ? "pre_battle" : "finished",
    hearts: 3,
    maxHearts: 3,
    deck: [{ cardId: "base-set-046-charmander", qty: 4 }],
    passives: [],
    treasuresTaken: [],
    pendingOffer: [],
    seed: "00",
  };
}

describe("adventure models", () => {
  it("allows one active run per user (adventure_runs_one_active)", async () => {
    const user = await createUser();
    await prisma.adventureRun.create({ data: runData(user.id) });
    const second = prisma.adventureRun.create({ data: runData(user.id) });
    await expect(second).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(prisma.adventureRun.create({ data: runData(user.id) })).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps any number of finished runs next to the active one", async () => {
    const user = await createUser();
    await prisma.adventureRun.create({ data: runData(user.id, "won") });
    await prisma.adventureRun.create({ data: runData(user.id, "lost") });
    await prisma.adventureRun.create({ data: runData(user.id) });
    expect(await prisma.adventureRun.count({ where: { userId: user.id } })).toBe(3);
  });

  it("deleting the user removes runs, results, progress and unlocks", async () => {
    const user = await createUser();
    const run = await prisma.adventureRun.create({ data: runData(user.id) });
    await prisma.adventureBattleResult.create({
      data: { runId: run.id, battleIndex: 1, attempt: 1, victory: true, reason: "prizes", turns: 7, startedAt: new Date() },
    });
    await prisma.adventureProgress.create({ data: { userId: user.id, adventureId: "pueblo-paleta-bosque-verde" } });
    await prisma.userStarterUnlock.create({ data: { userId: user.id, starterId: "pikachu" } });
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.adventureRun.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.adventureBattleResult.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.adventureProgress.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.userStarterUnlock.count({ where: { userId: user.id } })).toBe(0);
  });
});
