/**
 * Prize wheel segments (authoritative). Order, ids, weights and payloads must
 * match the frontend's visual config in src/domain/wheel/config.ts — the client
 * finds the segment to land on by `id`.
 */

import { CardRarityPool } from "../prizes/prizes.js";

export type WheelPayload =
  | { type: "card"; rarityPool: CardRarityPool }
  | { type: "coins"; amount: number }
  | { type: "card_back" }
  | { type: "collectible_coin" }
  | { type: "avatar" }
  | { type: "free_pack" }
  | { type: "spin_again"; bonusCoins: number }
  | { type: "jackpot" }
  | { type: "nothing" };

export interface WheelSegment {
  id: string;
  weight: number;
  payload: WheelPayload;
}

export const WHEEL_SPIN_COST = 100;

export const WHEEL_SEGMENTS: WheelSegment[] = [
  { id: "card-common-1", weight: 14, payload: { type: "card", rarityPool: CardRarityPool.Common } },
  { id: "money-200", weight: 8, payload: { type: "coins", amount: 200 } },
  { id: "nothing-1", weight: 12, payload: { type: "nothing" } },
  { id: "coin-1", weight: 6, payload: { type: "collectible_coin" } },
  { id: "card-uncommon-1", weight: 10, payload: { type: "card", rarityPool: CardRarityPool.Uncommon } },
  { id: "spin-again-1", weight: 8, payload: { type: "spin_again", bonusCoins: 50 } },
  { id: "back-1", weight: 6, payload: { type: "card_back" } },
  { id: "nothing-2", weight: 12, payload: { type: "nothing" } },
  { id: "card-rare", weight: 5, payload: { type: "card", rarityPool: CardRarityPool.Rare } },
  { id: "money-500", weight: 4, payload: { type: "coins", amount: 500 } },
  { id: "avatar-1", weight: 4, payload: { type: "avatar" } },
  { id: "nothing-3", weight: 12, payload: { type: "nothing" } },
  { id: "free-pack", weight: 3, payload: { type: "free_pack" } },
  { id: "nothing-4", weight: 12, payload: { type: "nothing" } },
  { id: "nothing-5", weight: 12, payload: { type: "nothing" } },
  { id: "jackpot", weight: 1, payload: { type: "jackpot" } },
];
