import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { spinWheel } from "../src/modules/wheel/wheel.service.js";
import { WHEEL_SEGMENTS, WHEEL_SPIN_COST } from "../src/modules/wheel/wheel.config.js";
import { spinSlots, SLOTS_SPIN_COST } from "../src/modules/slots/slots.service.js";
import { pickWeighted } from "../src/modules/prizes/prizes.js";
import { createUser, getBalances, race } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

async function ownedItemCount(userId: string) {
  const [cards, skins, backs, coins, avatars, playmats] = await Promise.all([
    prisma.userCard.count({ where: { userId } }),
    prisma.userCardSkin.count({ where: { userId } }),
    prisma.userCardBack.count({ where: { userId } }),
    prisma.userCoin.count({ where: { userId } }),
    prisma.userAvatar.count({ where: { userId } }),
    prisma.userPlaymat.count({ where: { userId } }),
  ]);
  return cards + skins + backs + coins + avatars + playmats;
}

describe("pickWeighted", () => {
  it("follows the weights", () => {
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 20000; i++) counts[pickWeighted([{ weight: 1, value: "a" as const }, { weight: 3, value: "b" as const }])]++;
    expect(counts.b / counts.a).toBeGreaterThan(2.6);
    expect(counts.b / counts.a).toBeLessThan(3.4);
  });
});

describe("wheel", () => {
  it("rejects a spin without coins and grants nothing", async () => {
    const user = await createUser({ coins: WHEEL_SPIN_COST - 1 });
    await expect(spinWheel(user.id)).rejects.toThrow();
    expect((await getBalances(user.id)).coins).toBe(WHEEL_SPIN_COST - 1);
    expect(await ownedItemCount(user.id)).toBe(0);
  });

  it("charges the spin and returns a known segment with its prize granted", async () => {
    const user = await createUser({ coins: 10_000 });
    for (let i = 0; i < 25; i++) {
      const result = await spinWheel(user.id);
      expect(WHEEL_SEGMENTS.some((s) => s.id === result.segmentId)).toBe(true);
      const after = await getBalances(user.id);
      expect(result.balances).toEqual(after);
    }
    const spins = await prisma.transaction.count({ where: { userId: user.id, description: "Giro de ruleta" } });
    const freeUsed = 25 - spins;
    expect(freeUsed).toBeGreaterThanOrEqual(0);
  });

  it("uses a free spin before charging coins", async () => {
    const user = await createUser({ coins: 0 });
    await prisma.user.update({ where: { id: user.id }, data: { freeWheelSpins: 1 } });
    const result = await spinWheel(user.id);
    expect(result.usedFreeSpin).toBe(true);
    expect(await prisma.transaction.count({ where: { userId: user.id, description: "Giro de ruleta" } })).toBe(0);
  });

  it("never overspends under concurrency", async () => {
    const user = await createUser({ coins: WHEEL_SPIN_COST });
    await race(6, () => spinWheel(user.id));
    expect((await getBalances(user.id)).coins).toBeGreaterThanOrEqual(0);
    const charged = await prisma.transaction.count({ where: { userId: user.id, description: "Giro de ruleta" } });
    expect(charged).toBe(1);
  });
});

describe("slots", () => {
  it("charges the spin, returns a consistent grid and grants the prize", async () => {
    const user = await createUser({ coins: 10_000 });
    for (let i = 0; i < 40; i++) {
      const result = await spinSlots(user.id);
      expect(result.grid).toHaveLength(9);
      if (result.matchedCells.length > 0) {
        const symbol = result.grid[result.matchedCells[0]];
        expect(result.matchedCells.every((c) => result.grid[c] === symbol)).toBe(true);
        expect(symbol).not.toBe("nothing");
      }
      if (result.pattern === "none") expect(result.prize.type).toBe("nothing");
      else expect(result.prize.type).not.toBe("nothing");
      expect(result.balances).toEqual(await getBalances(user.id));
    }
    const charged = await prisma.transaction.count({ where: { userId: user.id, type: "slot_spin", amount: -SLOTS_SPIN_COST } });
    expect(charged).toBe(40);
  });

  it("rejects a spin without coins", async () => {
    const user = await createUser({ coins: SLOTS_SPIN_COST - 1 });
    await expect(spinSlots(user.id)).rejects.toThrow();
    expect(await ownedItemCount(user.id)).toBe(0);
  });
});
