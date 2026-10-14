/**
 * 3×3 pattern slot machine (authoritative server port of the frontend's
 * src/domain/slots/slot-resolver.ts). The server picks the pattern, builds a grid
 * that shows it, resolves and grants the prize, and charges the spin in one
 * transaction. Grid indices:
 *   [0] [1] [2]
 *   [3] [4] [5]
 *   [6] [7] [8]
 */

import { prisma } from "../../lib/prisma.js";
import * as usersService from "../users/users.service.js";
import type { PackOpeningResult } from "../boosters/boosters.types.js";
import {
  CardRarityPool,
  grantPrize,
  pick,
  pickWeighted,
  random,
  resolveCard,
  resolveCardBack,
  resolveCoins,
  resolveCollectibleCoin,
  resolvePlaymat,
  resolveRandomOverlay,
  type ResolvedPrize,
} from "../prizes/prizes.js";

export const SLOTS_SPIN_COST = 50;

export type SlotSymbol = "card" | "coins" | "card_back" | "overlay" | "playmat" | "nothing";
export type SlotPattern =
  | "full_grid"
  | "pokeball"
  | "cross"
  | "x_pattern"
  | "corners"
  | "diagonal"
  | "horizontal"
  | "vertical"
  | "none";

export const PATTERN_WEIGHTS: { value: SlotPattern; weight: number }[] = [
  { value: "full_grid", weight: 0.5 },
  { value: "pokeball", weight: 1.5 },
  { value: "cross", weight: 4 },
  { value: "x_pattern", weight: 3 },
  { value: "corners", weight: 5 },
  { value: "diagonal", weight: 6 },
  { value: "horizontal", weight: 15 },
  { value: "vertical", weight: 10 },
  { value: "none", weight: 55 },
];

export const SYMBOL_WEIGHTS: { value: SlotSymbol; weight: number }[] = [
  { value: "card", weight: 30 },
  { value: "coins", weight: 30 },
  { value: "card_back", weight: 20 },
  { value: "overlay", weight: 5 },
  { value: "playmat", weight: 3 },
  { value: "nothing", weight: 12 },
];

const PATTERN_CELLS: Record<Exclude<SlotPattern, "none" | "pokeball">, number[][]> = {
  full_grid: [[0, 1, 2, 3, 4, 5, 6, 7, 8]],
  cross: [[1, 3, 4, 5, 7]],
  x_pattern: [[0, 2, 4, 6, 8]],
  corners: [[0, 2, 6, 8]],
  diagonal: [[0, 4, 8], [2, 4, 6]],
  horizontal: [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
  vertical: [[0, 3, 6], [1, 4, 7], [2, 5, 8]],
};

const POKEBALL_RING = [0, 1, 2, 3, 5, 6, 7, 8];

function pickSymbol(exclude?: SlotSymbol): SlotSymbol {
  return pickWeighted(SYMBOL_WEIGHTS.filter((w) => w.value !== exclude));
}

function buildGrid(pattern: SlotPattern): { grid: SlotSymbol[]; matchedCells: number[]; matchedSymbol: SlotSymbol } {
  const grid: SlotSymbol[] = new Array(9);

  if (pattern === "none") {
    for (let i = 0; i < 9; i++) grid[i] = pickSymbol();
    return { grid, matchedCells: [], matchedSymbol: "nothing" };
  }

  if (pattern === "pokeball") {
    const ringSymbol = pickSymbol("nothing");
    for (const idx of POKEBALL_RING) grid[idx] = ringSymbol;
    grid[4] = pickSymbol(ringSymbol);
    return { grid, matchedCells: POKEBALL_RING, matchedSymbol: ringSymbol };
  }

  const cells = pick(PATTERN_CELLS[pattern]);
  const mainSymbol = pickSymbol("nothing");
  for (const idx of cells) grid[idx] = mainSymbol;
  for (let i = 0; i < 9; i++) {
    if (grid[i] === undefined) grid[i] = pickSymbol(mainSymbol);
  }
  return { grid, matchedCells: cells, matchedSymbol: mainSymbol };
}

function resolvePatternPrize(pattern: SlotPattern, matchedSymbol: SlotSymbol): ResolvedPrize {
  switch (pattern) {
    case "full_grid":
      // MEGA JACKPOT: one of each prize type
      return {
        type: "jackpot",
        prizes: [
          resolveCard(CardRarityPool.RareHolo),
          resolveCoins(300),
          resolveCardBack(),
          resolveCollectibleCoin(),
          resolveRandomOverlay(),
          { type: "free_pack" },
        ],
      };
    case "pokeball":
      return { type: "free_pack" };
    case "cross":
      return resolveCard(pick([CardRarityPool.Rare, CardRarityPool.Rare, CardRarityPool.RareHolo]));
    case "x_pattern":
      return resolveCoins(pick([200, 250, 300]));
    case "corners":
      return resolveCollectibleCoin();
    case "diagonal":
      return resolveCard(pick([CardRarityPool.Uncommon, CardRarityPool.Uncommon, CardRarityPool.Rare]));
    case "horizontal":
      if (matchedSymbol === "coins") return resolveCoins(pick([75, 100, 150]));
      if (matchedSymbol === "card_back") return resolveCardBack();
      if (matchedSymbol === "overlay") return resolveRandomOverlay();
      if (matchedSymbol === "playmat") return resolvePlaymat();
      return resolveCard(pick([CardRarityPool.Common, CardRarityPool.Common, CardRarityPool.Uncommon]));
    case "vertical":
      if (matchedSymbol === "coins") return resolveCoins(pick([50, 75, 100]));
      if (matchedSymbol === "card_back") return resolveCardBack();
      if (matchedSymbol === "playmat") return resolvePlaymat();
      return random() < 0.5 ? resolveCardBack() : resolveCollectibleCoin();
    case "none":
      return { type: "nothing" };
  }
}

export interface SlotsSpinResult {
  grid: SlotSymbol[];
  pattern: SlotPattern;
  matchedCells: number[];
  prize: ResolvedPrize;
  packResult?: PackOpeningResult;
  balances: { coins: number; coupons: number; rareCandy: number };
}

export async function spinSlots(userId: string): Promise<SlotsSpinResult> {
  const pattern = pickWeighted(PATTERN_WEIGHTS);
  const { grid, matchedCells, matchedSymbol } = buildGrid(pattern);
  const prize = resolvePatternPrize(pattern, matchedSymbol);

  return prisma.$transaction(async (tx) => {
    await usersService.spendCoins(userId, SLOTS_SPIN_COST, "slot_spin", "Tirada de tragamonedas", tx);
    const { packResult } = await grantPrize(tx, userId, prize, { type: "slot_spin", label: "Tragamonedas" });
    const balances = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { coins: true, coupons: true, rareCandy: true },
    });
    return { grid, pattern, matchedCells, prize, packResult, balances };
  });
}
