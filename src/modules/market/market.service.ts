import {
  ALL_CARDS,
  isPokemonCard,
  isEnergyCard,
  isTrainerCard,
  CardRarity,
} from "@gonzaloaguila/game-core";
import type { Card } from "@gonzaloaguila/game-core";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";
import { ECONOMY } from "../economy/config.js";
import { economyDay, economyWeek } from "../economy/economy-time.js";
import { claimOnce } from "../economy/claims.js";
import {
  AVAILABLE_AVATARS,
  AVAILABLE_CARD_BACKS,
  AVAILABLE_COINS,
  AVAILABLE_PLAYMATS,
  MARKET_VARIANTS,
} from "../prizes/catalog.js";
import type {
  DailyCardOffer,
  DailyCosmeticOffer,
  EnergyOffer,
  DailyOffersResponse,
} from "./market.types.js";

// ---------------------------------------------------------------------------
// Catalog pools
// ---------------------------------------------------------------------------

const allCards: Card[] = [...ALL_CARDS];

// Every card but basic Energy (Pokémon, Trainers and special Energy). "Rare" offers come from
// rare ∪ rare-holo, so the Base Set rares (Computer Search, Item Finder, ...) can show up.
const sellableCards = allCards.filter((c) => !(isEnergyCard(c) && c.isBasic));
const rareCards = sellableCards.filter((c) => c.rarity === CardRarity.Rare || c.rarity === CardRarity.RareHolo);
const uncommonCards = sellableCards.filter((c) => c.rarity === CardRarity.Uncommon);
const commonCards = sellableCards.filter((c) => c.rarity === CardRarity.Common);

function cardKind(card: Card): "pokemon" | "trainer" | "energy" {
  if (isPokemonCard(card)) return "pokemon";
  if (isTrainerCard(card)) return "trainer";
  return "energy";
}

/** Id the mystery offer is listed and bought with; the real card is only revealed after buying. */
export const MYSTERY_OFFER_ID = "mystery";

const basicEnergyCards = allCards.filter(
  (c) => isEnergyCard(c) && c.isBasic,
);

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const CARD_PRICES: Record<string, number> = ECONOMY.market.cardPrices;

const COSMETIC_PRICES: Record<string, number> = {
  coin: 15,
  cardBack: 15,
  avatar: 5,
  variant: 50,
  playmat: 20,
};

const ENERGY_PRICE = 10;
export const MAX_ENERGY_PER_PURCHASE = 99;

// Rare Candy conversion rates (coins conversions are capped per economy week)
const CANDY_TO_COINS = ECONOMY.rareCandy.toCoins;
const CANDY_TO_COUPONS = ECONOMY.rareCandy.toCoupons;

// ---------------------------------------------------------------------------
// Deterministic daily seed (same picks for all users on the same economy day, 00:00 Argentina)
// ---------------------------------------------------------------------------

function getEconomyDateString(now = new Date()): string {
  return economyDay(now);
}

/**
 * Claims today's purchase slot for `itemKey`. The unique (userId, itemKey, date)
 * constraint makes a concurrent duplicate fail, rolling back its whole transaction.
 */
async function recordDailyPurchase(tx: usersService.Db, userId: string, itemKey: string, alreadyBoughtMessage: string) {
  try {
    await tx.dailyPurchase.create({ data: { userId, itemKey, date: getEconomyDateString() } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw Errors.BadRequest(alreadyBoughtMessage);
    }
    throw err;
  }
}

function getDailySeed(now = new Date()): number {
  const dateStr = getEconomyDateString(now);
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    const char = dateStr.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

function seededPick<T>(arr: T[], seed: number, offset: number): T {
  return arr[((seed + offset * 7919) >>> 0) % arr.length];
}

// ---------------------------------------------------------------------------
// Get daily offers (with user-specific purchase/ownership status)
// ---------------------------------------------------------------------------

export async function getDailyOffers(userId?: string, now = new Date()): Promise<DailyOffersResponse> {
  const seed = getDailySeed(now);

  // Card offers (4 daily rotating cards)
  const rareCard = seededPick(rareCards, seed, 1);
  const uncommonCard = seededPick(uncommonCards, seed, 2);
  const commonCard = seededPick(commonCards, seed, 3);

  const offer = (card: Card, rarity: string, price: number): DailyCardOffer => ({
    cardDefId: card.id,
    name: card.name,
    number: card.number,
    set: card.set,
    rarity,
    kind: cardKind(card),
    price,
  });
  const cardOffers: DailyCardOffer[] = [
    offer(rareCard, rareCard.rarity, CARD_PRICES.rare),
    offer(uncommonCard, "uncommon", CARD_PRICES.uncommon),
    offer(commonCard, "common", CARD_PRICES.common),
    {
      // The real card stays on the server until it's bought
      cardDefId: MYSTERY_OFFER_ID,
      name: "???",
      number: 0,
      set: "unknown",
      rarity: "mystery",
      kind: "mystery",
      price: CARD_PRICES.mystery,
      isMystery: true,
    },
  ];

  // Cosmetic offers
  const dailyCoin = seededPick(AVAILABLE_COINS, seed, 10);
  const dailyCardBack = seededPick(AVAILABLE_CARD_BACKS, seed, 11);
  const dailyAvatar = seededPick(AVAILABLE_AVATARS, seed, 12);
  const dailyVariant = seededPick(MARKET_VARIANTS, seed, 13);
  const dailyPlaymat = seededPick(AVAILABLE_PLAYMATS, seed, 14);

  const cosmeticOffers: DailyCosmeticOffer[] = [
    { type: "coin", itemId: dailyCoin.itemId, name: dailyCoin.name, imageUrl: dailyCoin.imageUrl, price: COSMETIC_PRICES.coin },
    { type: "cardBack", itemId: dailyCardBack.itemId, name: dailyCardBack.name, imageUrl: dailyCardBack.imageUrl, price: COSMETIC_PRICES.cardBack },
    { type: "avatar", itemId: dailyAvatar.itemId, name: dailyAvatar.name, imageUrl: dailyAvatar.imageUrl, price: COSMETIC_PRICES.avatar },
    { type: "variant", itemId: dailyVariant.itemId, name: dailyVariant.name, imageUrl: dailyVariant.imageUrl, overlayId: dailyVariant.overlayId, price: COSMETIC_PRICES.variant },
    { type: "playmat", itemId: dailyPlaymat.itemId, name: dailyPlaymat.name, imageUrl: dailyPlaymat.imageUrl, price: COSMETIC_PRICES.playmat },
  ];

  // Energy offers (static — always the same 6)
  const energyOffers: EnergyOffer[] = basicEnergyCards.map((card) => ({
    cardDefId: card.id,
    energyType: isEnergyCard(card) ? card.energyType : "colorless",
    name: card.name,
    price: ENERGY_PRICE,
  }));

  // User-specific status
  let purchasedToday: string[] = [];
  let ownedItems: string[] = [];

  if (userId) {
    const today = getEconomyDateString(now);

    // Get today's purchases
    const purchases = await prisma.dailyPurchase.findMany({
      where: { userId, date: today },
      select: { itemKey: true },
    });
    purchasedToday = purchases.map((p) => p.itemKey);

    // Check ownership of today's cosmetic offers
    const [ownedCoins, ownedCardBacks, ownedAvatars, ownedSkins, ownedPlaymats] = await Promise.all([
      prisma.userCoin.findMany({
        where: { userId, coinId: { in: cosmeticOffers.filter((o) => o.type === "coin").map((o) => o.itemId) } },
        select: { coinId: true },
      }),
      prisma.userCardBack.findMany({
        where: { userId, cardBackId: { in: cosmeticOffers.filter((o) => o.type === "cardBack").map((o) => o.itemId) } },
        select: { cardBackId: true },
      }),
      prisma.userAvatar.findMany({
        where: { userId, avatarId: { in: cosmeticOffers.filter((o) => o.type === "avatar").map((o) => o.itemId) } },
        select: { avatarId: true },
      }),
      prisma.userCardSkin.findMany({
        where: { userId, skinId: { in: cosmeticOffers.filter((o) => o.type === "variant").map((o) => o.itemId) } },
        select: { skinId: true },
      }),
      prisma.userPlaymat.findMany({
        where: { userId, playmatId: { in: cosmeticOffers.filter((o) => o.type === "playmat").map((o) => o.itemId) } },
        select: { playmatId: true },
      }),
    ]);

    for (const c of ownedCoins) {
      ownedItems.push(`own:coin:${c.coinId}`);
    }
    for (const cb of ownedCardBacks) {
      ownedItems.push(`own:cardBack:${cb.cardBackId}`);
    }
    for (const a of ownedAvatars) {
      ownedItems.push(`own:avatar:${a.avatarId}`);
    }
    for (const s of ownedSkins) {
      ownedItems.push(`own:variant:${s.skinId}`);
    }
    for (const p of ownedPlaymats) {
      ownedItems.push(`own:playmat:${p.playmatId}`);
    }
  }

  return { cardOffers, cosmeticOffers, energyOffers, purchasedToday, ownedItems };
}

// ---------------------------------------------------------------------------
// Buy a daily card (monedas) — one-time per day
// ---------------------------------------------------------------------------

/** Today's mystery card (same for everyone, never sent before purchase). */
function todaysMysteryCard(): Card {
  return seededPick(sellableCards, getDailySeed(), 4);
}

export async function buyDailyCard(userId: string, cardDefId: string) {
  const offers = await getDailyOffers(userId);
  const offer = offers.cardOffers.find((o) => o.cardDefId === cardDefId);
  if (!offer) {
    throw Errors.BadRequest("Esta carta no está disponible en la tienda hoy");
  }

  // The mystery offer is bought by its slot id; the card it gives is resolved here
  const card = offer.isMystery ? todaysMysteryCard() : allCards.find((c) => c.id === cardDefId);
  if (!card) throw Errors.BadRequest("Esta carta no está disponible en la tienda hoy");

  const itemKey = `card:${offer.cardDefId}`;
  await prisma.$transaction(async (tx) => {
    await recordDailyPurchase(tx, userId, itemKey, "Ya compraste esta carta hoy");
    await usersService.spendCoins(
      userId,
      offer.price,
      "card_purchase",
      `Compra de carta: ${offer.isMystery ? `Carta misteriosa (${card.name})` : offer.name}`,
      tx,
    );
    await tx.userCard.upsert({
      where: { userId_cardDefId: { userId, cardDefId: card.id } },
      update: { quantity: { increment: 1 } },
      create: { userId, cardDefId: card.id, quantity: 1 },
    });
  });

  return {
    cardDefId: card.id,
    name: card.name,
    number: card.number,
    set: card.set,
    revealed: !!offer.isMystery,
  };
}

// ---------------------------------------------------------------------------
// Buy cosmetic (cupones) — one-time per day
// ---------------------------------------------------------------------------

export async function buyCosmetic(
  userId: string,
  type: string,
  itemId: string,
) {
  const offers = await getDailyOffers(userId);
  const offer = offers.cosmeticOffers.find(
    (o) => o.type === type && o.itemId === itemId,
  );
  if (!offer) {
    throw Errors.BadRequest("Este cosmético no está disponible en la tienda hoy");
  }

  const itemKey = `cosmetic:${type}:${itemId}`;
  await prisma.$transaction(async (tx) => {
    await recordDailyPurchase(tx, userId, itemKey, "Ya compraste este cosmético hoy");

    // Ownership rows have unique (userId, itemId) constraints, so a duplicate create also rolls back the charge.
    const charge = (label: string) =>
      usersService.spendCoupons(userId, offer.price, "cosmetic_purchase", `Compra de ${label}: ${offer.name}`, tx);

    if (type === "coin") {
      const existing = await tx.userCoin.findUnique({ where: { userId_coinId: { userId, coinId: itemId } } });
      if (existing) throw Errors.BadRequest("Ya posees esta moneda");
      await charge("moneda");
      await tx.userCoin.create({ data: { userId, coinId: itemId } });
    } else if (type === "cardBack") {
      const existing = await tx.userCardBack.findUnique({ where: { userId_cardBackId: { userId, cardBackId: itemId } } });
      if (existing) throw Errors.BadRequest("Ya posees este reverso de carta");
      await charge("card back");
      await tx.userCardBack.create({ data: { userId, cardBackId: itemId } });
    } else if (type === "avatar") {
      const existing = await tx.userAvatar.findUnique({ where: { userId_avatarId: { userId, avatarId: itemId } } });
      if (existing) throw Errors.BadRequest("Ya posees este avatar");
      await charge("avatar");
      await tx.userAvatar.create({ data: { userId, avatarId: itemId } });
    } else if (type === "variant") {
      const existing = await tx.userCardSkin.findUnique({ where: { userId_skinId: { userId, skinId: itemId } } });
      if (existing) throw Errors.BadRequest("Ya posees esta variante");
      await charge("variante");
      await tx.userCardSkin.create({ data: { userId, skinId: itemId } });
    } else if (type === "playmat") {
      const existing = await tx.userPlaymat.findUnique({ where: { userId_playmatId: { userId, playmatId: itemId } } });
      if (existing) throw Errors.BadRequest("Ya posees este tapete");
      await charge("tapete");
      await tx.userPlaymat.create({ data: { userId, playmatId: itemId } });
    } else {
      throw Errors.BadRequest("Tipo de cosmético inválido");
    }
  });

  return { type, itemId, name: offer.name };
}

// ---------------------------------------------------------------------------
// Buy energy (monedas)
// ---------------------------------------------------------------------------

export async function buyEnergy(
  userId: string,
  energyType: string,
  quantity: number = 1,
) {
  const offers = await getDailyOffers();
  const offer = offers.energyOffers.find((o) => o.energyType === energyType);
  if (!offer) {
    throw Errors.BadRequest("Tipo de energía no válido");
  }

  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ENERGY_PER_PURCHASE) {
    throw Errors.BadRequest(`La cantidad debe ser un entero entre 1 y ${MAX_ENERGY_PER_PURCHASE}`);
  }

  const totalPrice = offer.price * quantity;
  await prisma.$transaction(async (tx) => {
    await usersService.spendCoins(userId, totalPrice, "energy_purchase", `Compra de ${quantity}x ${offer.name}`, tx);
    await tx.userCard.upsert({
      where: { userId_cardDefId: { userId, cardDefId: offer.cardDefId } },
      update: { quantity: { increment: quantity } },
      create: { userId, cardDefId: offer.cardDefId, quantity },
    });
  });

  return { cardDefId: offer.cardDefId, energyType, quantity };
}

// ---------------------------------------------------------------------------
// Convert Rare Candy
// ---------------------------------------------------------------------------

export async function convertRareCandy(
  userId: string,
  target: "coins" | "coupons",
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    if (target === "coins") {
      // Take one of this week's conversion slots ("<week>:1", "<week>:2"); none left = rejected
      const week = economyWeek(now);
      const max = ECONOMY.rareCandy.maxCoinConversionsPerWeek;
      let slot = 0;
      for (let n = 1; n <= max && slot === 0; n++) {
        if (await claimOnce(tx, userId, "candy_coins", `${week}:${n}`)) slot = n;
      }
      if (slot === 0) {
        throw Errors.BadRequest(`Solo puedes convertir ${max} Caramelos Raros en monedas por semana`);
      }
      await usersService.spendRareCandy(userId, 1, "rare_candy_conversion", "Conversión de Caramelo Raro a monedas", tx);
      const result = await usersService.addCoins(userId, CANDY_TO_COINS, "rare_candy_conversion", `Conversión: 1 Caramelo Raro → ${CANDY_TO_COINS} monedas`, tx);
      return { target, amount: CANDY_TO_COINS, newBalance: result.coins, coinConversionsLeftThisWeek: max - slot };
    }
    await usersService.spendRareCandy(userId, 1, "rare_candy_conversion", "Conversión de Caramelo Raro a cupones", tx);
    const result = await usersService.addCoupons(userId, CANDY_TO_COUPONS, "rare_candy_conversion", `Conversión: 1 Caramelo Raro → ${CANDY_TO_COUPONS} cupones`, tx);
    return { target, amount: CANDY_TO_COUPONS, newBalance: result.coupons };
  });
}
