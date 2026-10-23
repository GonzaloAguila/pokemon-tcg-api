/**
 * Server-side prize resolution and granting for the prize games (wheel, slots).
 *
 * Prizes are always rolled here with a CSPRNG and granted in the same transaction
 * that charges the spin; clients only animate the result they are sent.
 * The ResolvedPrize shape matches the frontend's src/domain/prizes/types.ts.
 */

import { randomInt } from "crypto";
import { CardRarity, getCardImageUrl } from "@gonzaloaguila/game-core";
import * as usersService from "../users/users.service.js";
import { recordCardChange } from "../users/card-ledger.js";
import * as boosterService from "../boosters/boosters.service.js";
import type { PackOpeningResult } from "../boosters/boosters.types.js";
import {
  allPokemonCards,
  AVAILABLE_AVATARS,
  AVAILABLE_CARD_BACKS,
  AVAILABLE_COINS,
  AVAILABLE_PLAYMATS,
  POOL_VARIANTS,
} from "./catalog.js";
import { POOL_EMOTES, emoteImageUrl } from "../emotes/catalog.js";
import { grantEmote } from "../emotes/emotes.service.js";

export type ResolvedPrize =
  | {
      type: "card";
      cardDefId: string;
      cardName: string;
      cardNumber: number;
      cardImageUrl: string;
      isHolo: boolean;
      rarity: string;
    }
  | { type: "coins"; amount: number }
  | { type: "overlay"; overlayId: string; overlayName: string; skinId: string; skinCardImageUrl?: string }
  | { type: "card_back"; cardBackId: string; cardBackName: string; cardBackImageUrl: string }
  | { type: "collectible_coin"; coinId: string; coinName: string; coinImageUrl: string }
  | { type: "avatar"; avatarId: string; avatarName: string; avatarImageUrl: string }
  | { type: "free_pack" }
  | { type: "spin_again"; bonusCoins: number }
  | { type: "jackpot"; prizes: ResolvedPrize[] }
  | { type: "playmat"; playmatId: string; playmatName: string; playmatImageUrl: string }
  | { type: "emote"; emoteId: string; emoteName: string; emoteImageUrl: string; emoteRarity: string }
  | { type: "nothing" };

// ---------------------------------------------------------------------------
// Randomness (CSPRNG)
// ---------------------------------------------------------------------------

const RANDOM_RANGE = 2 ** 47;

/** Uniform float in [0, 1) from crypto.randomInt. */
export function random(): number {
  return randomInt(0, RANDOM_RANGE) / RANDOM_RANGE;
}

export function pick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length)];
}

export function pickWeighted<T>(items: readonly { weight: number; value: T }[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item.value;
  }
  return items[items.length - 1].value;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export const CardRarityPool = {
  Common: "common",
  Uncommon: "uncommon",
  Rare: "rare",
  RareHolo: "rare-holo",
} as const;
export type CardRarityPool = (typeof CardRarityPool)[keyof typeof CardRarityPool];

const RARITY_POOL_MAP: Record<CardRarityPool, string[]> = {
  [CardRarityPool.Common]: [CardRarity.Common],
  [CardRarityPool.Uncommon]: [CardRarity.Uncommon],
  [CardRarityPool.Rare]: [CardRarity.Rare, CardRarity.RareHolo],
  [CardRarityPool.RareHolo]: [CardRarity.RareHolo],
};

export function resolveCard(rarityPool: CardRarityPool): ResolvedPrize {
  const allowed = RARITY_POOL_MAP[rarityPool];
  const pool = allPokemonCards.filter((c) => allowed.includes(c.rarity));
  const card = pick(pool.length > 0 ? pool : allPokemonCards);
  return {
    type: "card",
    cardDefId: card.id,
    cardName: card.name,
    cardNumber: card.number,
    cardImageUrl: getCardImageUrl(card),
    isHolo: card.rarity === CardRarity.RareHolo,
    rarity: card.rarity,
  };
}

export function resolveCoins(amount: number): ResolvedPrize {
  return { type: "coins", amount };
}

export function resolveCardBack(): ResolvedPrize {
  const item = pick(AVAILABLE_CARD_BACKS);
  return { type: "card_back", cardBackId: item.itemId, cardBackName: item.name, cardBackImageUrl: item.imageUrl };
}

export function resolveCollectibleCoin(): ResolvedPrize {
  const item = pick(AVAILABLE_COINS);
  return { type: "collectible_coin", coinId: item.itemId, coinName: item.name, coinImageUrl: item.imageUrl };
}

export function resolveAvatar(): ResolvedPrize {
  const item = pick(AVAILABLE_AVATARS);
  return { type: "avatar", avatarId: item.itemId, avatarName: item.name, avatarImageUrl: item.imageUrl };
}

export function resolvePlaymat(): ResolvedPrize {
  const item = pick(AVAILABLE_PLAYMATS);
  return { type: "playmat", playmatId: item.itemId, playmatName: item.name, playmatImageUrl: item.imageUrl };
}

/**
 * A random battle emote the player doesn't own yet (never a starter: everyone owns those), or
 * null when they own them all: a prize never names an emote that adds nothing.
 */
export function resolveEmote(owned: ReadonlySet<string> = new Set()): (ResolvedPrize & { type: "emote" }) | null {
  const pool = POOL_EMOTES.filter((e) => !owned.has(e.id));
  if (pool.length === 0) return null;
  const emote = pick(pool);
  return { type: "emote", emoteId: emote.id, emoteName: emote.name, emoteImageUrl: emoteImageUrl(emote.id), emoteRarity: emote.rarity };
}

/** A jackpot's emote line: [an unowned emote], or [] when the player owns every emote. */
export function jackpotEmote(owned: ReadonlySet<string>): ResolvedPrize[] {
  const emote = resolveEmote(owned);
  return emote ? [emote] : [];
}

export function resolveRandomOverlay(): ResolvedPrize {
  const skin = pick(POOL_VARIANTS);
  return {
    type: "overlay",
    overlayId: skin.overlayId,
    overlayName: skin.name,
    skinId: skin.itemId,
    skinCardImageUrl: skin.imageUrl,
  };
}

// ---------------------------------------------------------------------------
// Granting (inside the caller's transaction)
// ---------------------------------------------------------------------------

/** Whether a prize puts a card in the collection (a card, or a jackpot with one). */
export function prizeGivesCards(prize: ResolvedPrize): boolean {
  return prize.type === "card" || (prize.type === "jackpot" && prize.prizes.some(prizeGivesCards));
}

export interface GrantResult {
  packResult?: PackOpeningResult;
}

/**
 * Persists a resolved prize. `source` is used for transaction types/descriptions
 * (e.g. "wheel_spin" / "Ruleta"). Idempotent for cosmetics (upserts).
 */
export async function grantPrize(
  tx: usersService.Db,
  userId: string,
  prize: ResolvedPrize,
  source: { type: string; label: string },
): Promise<GrantResult> {
  switch (prize.type) {
    case "coins":
      await usersService.addCoins(userId, prize.amount, source.type, `${source.label}: +${prize.amount} monedas`, tx);
      return {};

    case "spin_again":
      await usersService.addCoins(userId, prize.bonusCoins, source.type, `${source.label}: +${prize.bonusCoins} monedas`, tx);
      return {};

    case "card":
      await tx.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId: prize.cardDefId } },
        update: { quantity: { increment: 1 } },
        create: { userId, cardDefId: prize.cardDefId, quantity: 1 },
      });
      await recordCardChange(tx, userId, "prize_card", `${source.label}: carta`, [{ cardDefId: prize.cardDefId, quantity: 1 }], source.type);
      return {};

    case "overlay":
      await tx.userCardSkin.upsert({
        where: { userId_skinId: { userId, skinId: prize.skinId } },
        update: {},
        create: { userId, skinId: prize.skinId },
      });
      return {};

    case "card_back":
      await tx.userCardBack.upsert({
        where: { userId_cardBackId: { userId, cardBackId: prize.cardBackId } },
        update: {},
        create: { userId, cardBackId: prize.cardBackId },
      });
      return {};

    case "collectible_coin":
      await tx.userCoin.upsert({
        where: { userId_coinId: { userId, coinId: prize.coinId } },
        update: {},
        create: { userId, coinId: prize.coinId },
      });
      return {};

    case "avatar":
      await tx.userAvatar.upsert({
        where: { userId_avatarId: { userId, avatarId: prize.avatarId } },
        update: {},
        create: { userId, avatarId: prize.avatarId },
      });
      return {};

    case "playmat":
      await tx.userPlaymat.upsert({
        where: { userId_playmatId: { userId, playmatId: prize.playmatId } },
        update: {},
        create: { userId, playmatId: prize.playmatId },
      });
      return {};

    case "emote":
      await grantEmote(tx, userId, prize.emoteId);
      return {};

    case "free_pack": {
      const ids = boosterService.STANDARD_BOOSTER_IDS;
      const packId = ids[Math.min(ids.length - 1, Math.floor(random() * ids.length))];
      const packResult = await boosterService.openPackForUser(tx, userId, packId, { reason: "prize_pack", label: `${source.label}: sobre gratis` });
      return { packResult };
    }

    case "jackpot": {
      // Jackpot bonus on top of its sub-prizes: 1 rare candy + 100 coupons
      await usersService.addRareCandy(userId, 1, source.type, `${source.label}: Jackpot — Caramelo Raro`, tx);
      await usersService.addCoupons(userId, 100, source.type, `${source.label}: Jackpot — 100 cupones`, tx);
      let packResult: PackOpeningResult | undefined;
      for (const subPrize of prize.prizes) {
        const sub = await grantPrize(tx, userId, subPrize, source);
        packResult = sub.packResult ?? packResult;
      }
      return { packResult };
    }

    case "nothing":
      return {};
  }
}
