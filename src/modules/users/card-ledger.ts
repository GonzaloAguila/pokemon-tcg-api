import type { Prisma } from "@prisma/client";
import type { Db } from "./users.service.js";

/** Why a player's cards changed (card_transactions.reason). */
export type CardChangeReason =
  | "pack_purchase"
  | "daily_pack"
  | "stored_pack"
  | "prize_pack"
  | "prize_card"
  | "battle_pass"
  | "exchange_redeem"
  | "card_purchase"
  | "energy_purchase"
  | "starter_deck"
  | "trade"
  | "trade_revert"
  | "draft"
  | "admin_adjustment"
  | "adventure_reward";

/** `quantity` > 0 received, < 0 given away. */
export interface CardChange {
  cardDefId: string;
  quantity: number;
}

/**
 * Record one event that changed `userId`'s cards, inside the transaction that changes them (so the
 * history never disagrees with the collection). Copies of the same card are merged; an event that
 * nets nothing writes no row. Every write to user_cards must call this (card-ledger.test.ts).
 */
export async function recordCardChange(
  tx: Db,
  userId: string,
  reason: CardChangeReason,
  description: string,
  changes: readonly CardChange[],
  refId: string | null = null,
): Promise<void> {
  const byCard = new Map<string, number>();
  for (const { cardDefId, quantity } of changes) byCard.set(cardDefId, (byCard.get(cardDefId) ?? 0) + quantity);
  const cards = [...byCard].filter(([, quantity]) => quantity !== 0).map(([cardDefId, quantity]) => ({ cardDefId, quantity }));
  if (cards.length === 0) return;
  await tx.cardTransaction.create({
    data: { userId, reason, description, cards: cards as unknown as Prisma.InputJsonValue, refId },
  });
}
