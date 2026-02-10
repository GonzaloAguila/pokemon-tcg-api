import {
  baseSetCards,
  jungleCards,
  isPokemonCard,
  isEnergyCard,
  isTrainerCard,
  CardRarity,
  EnergyType,
  getCardImageUrl,
} from "@gonzaloaguila/game-core";
import type { Card } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";
import type {
  DailyCardOffer,
  DailyCosmeticOffer,
  EnergyOffer,
  DailyOffersResponse,
} from "./market.types.js";

// ---------------------------------------------------------------------------
// Catalog pools
// ---------------------------------------------------------------------------

const allCards: Card[] = [...baseSetCards, ...jungleCards];

const rareCards = allCards.filter(
  (c) => isPokemonCard(c) && c.rarity === CardRarity.RareHolo,
);
const uncommonCards = allCards.filter(
  (c) => isPokemonCard(c) && c.rarity === CardRarity.Uncommon,
);
const commonCards = allCards.filter(
  (c) => isPokemonCard(c) && c.rarity === CardRarity.Common,
);
const allPokemonCards = allCards.filter((c) => isPokemonCard(c));

const basicEnergyCards = allCards.filter(
  (c) => isEnergyCard(c) && c.isBasic,
);

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const CARD_PRICES: Record<string, number> = {
  rare: 200,
  uncommon: 100,
  common: 50,
  mystery: 200,
};

const COSMETIC_PRICES: Record<string, number> = {
  coin: 15,
  cardBack: 15,
  avatar: 5,
  variant: 50,
};

const ENERGY_PRICE = 10;

// Rare Candy conversion rates
const CANDY_TO_COINS = 2000;
const CANDY_TO_COUPONS = 10;

// ---------------------------------------------------------------------------
// Deterministic daily seed (same picks for all users on the same day)
// ---------------------------------------------------------------------------

function getUtcDateString(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function getDailySeed(): number {
  const dateStr = getUtcDateString();
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
// Available cosmetics (hardcoded list — extend as new items are added)
// ---------------------------------------------------------------------------

const AVAILABLE_COINS = [
  { itemId: "charizard", name: "Charizard", imageUrl: "/coins/TCGP_Coin_Charizard.png" },
  { itemId: "lucario", name: "Lucario", imageUrl: "/coins/TCGP_Coin_Lucario.png" },
  { itemId: "venusaur", name: "Venusaur", imageUrl: "/coins/TCGP_Coin_Venusaur.png" },
  { itemId: "vulpix-alola", name: "Vulpix Alola", imageUrl: "/coins/vulpix-alola-coin.png" },
];

const AVAILABLE_CARD_BACKS = [
  { itemId: "haymaker", name: "Haymaker", imageUrl: "/card-backs/haymakerBKC.jpeg" },
  { itemId: "draw", name: "Draw", imageUrl: "/card-backs/card-back-draw.jpg" },
  { itemId: "pikachu", name: "Pikachu", imageUrl: "/card-backs/card-back-pikachu.jpg" },
];

const AVAILABLE_AVATARS = [
  { itemId: "bellsprout", name: "Bellsprout", imageUrl: "/avatars/darius-dan/bellsprout.png" },
  { itemId: "pikachu", name: "Pikachu", imageUrl: "/avatars/darius-dan/pikachu.png" },
  { itemId: "poliwhirl", name: "Poliwhirl", imageUrl: "/avatars/darius-dan/poliwhirl.png" },
  { itemId: "sandshrew", name: "Sandshrew", imageUrl: "/avatars/darius-dan/sandshew.png" },
  { itemId: "snorlax", name: "Snorlax", imageUrl: "/avatars/darius-dan/snorlax.png" },
  { itemId: "voltorb", name: "Voltorb", imageUrl: "/avatars/darius-dan/voltorb.png" },
];

// Variants — card skins with overlays (paired: card + overlay effect)
const AVAILABLE_VARIANTS = [
  { itemId: "alakazam-glitch", name: "Alakazam Glitch", cardDefId: "base-set-001-alakazam", overlayId: "negative", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "base-set-001-alakazam")!) },
  { itemId: "wigglytuff-rainbow", name: "Wigglytuff Arcoíris", cardDefId: "jungle-016-wigglytuff", overlayId: "rainbow", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-016-wigglytuff")!) },
  { itemId: "wigglytuff-gold", name: "Wigglytuff Dorado", cardDefId: "jungle-016-wigglytuff", overlayId: "gold", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-016-wigglytuff")!) },
  { itemId: "clefable-galaxy", name: "Clefable Galaxia", cardDefId: "jungle-001-clefable", overlayId: "galaxy", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-001-clefable")!) },
  { itemId: "clefable-crystal", name: "Clefable Cristal", cardDefId: "jungle-001-clefable", overlayId: "crystal", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-001-clefable")!) },
  { itemId: "mr-mime-neon", name: "Mr. Mime Neón", cardDefId: "jungle-006-mr-mime", overlayId: "neon", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-006-mr-mime")!) },
  { itemId: "mr-mime-prism", name: "Mr. Mime Prisma", cardDefId: "jungle-006-mr-mime", overlayId: "prism", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-006-mr-mime")!) },
  { itemId: "scyther-frost", name: "Scyther Escarcha", cardDefId: "jungle-010-scyther", overlayId: "frost", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-010-scyther")!) },
  { itemId: "scyther-fire", name: "Scyther Ígneo", cardDefId: "jungle-010-scyther", overlayId: "fire", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-010-scyther")!) },
  { itemId: "eevee-holo-sparkle", name: "Eevee Destello", cardDefId: "jungle-051-eevee", overlayId: "holo-sparkle", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-051-eevee")!) },
  { itemId: "eevee-rainbow", name: "Eevee Arcoíris", cardDefId: "jungle-051-eevee", overlayId: "rainbow", imageUrl: getCardImageUrl(allCards.find((c) => c.id === "jungle-051-eevee")!) },
];

// ---------------------------------------------------------------------------
// Get daily offers (with user-specific purchase/ownership status)
// ---------------------------------------------------------------------------

export async function getDailyOffers(userId?: string): Promise<DailyOffersResponse> {
  const seed = getDailySeed();

  // Card offers (4 daily rotating cards)
  const rareCard = seededPick(rareCards, seed, 1);
  const uncommonCard = seededPick(uncommonCards, seed, 2);
  const commonCard = seededPick(commonCards, seed, 3);
  const mysteryCard = seededPick(allPokemonCards, seed, 4);

  const cardOffers: DailyCardOffer[] = [
    {
      cardDefId: rareCard.id,
      name: isPokemonCard(rareCard) ? rareCard.name : rareCard.id,
      number: rareCard.number,
      set: rareCard.set,
      rarity: "rare-holo",
      kind: "pokemon",
      price: CARD_PRICES.rare,
    },
    {
      cardDefId: uncommonCard.id,
      name: isPokemonCard(uncommonCard) ? uncommonCard.name : uncommonCard.id,
      number: uncommonCard.number,
      set: uncommonCard.set,
      rarity: "uncommon",
      kind: "pokemon",
      price: CARD_PRICES.uncommon,
    },
    {
      cardDefId: commonCard.id,
      name: isPokemonCard(commonCard) ? commonCard.name : commonCard.id,
      number: commonCard.number,
      set: commonCard.set,
      rarity: "common",
      kind: "pokemon",
      price: CARD_PRICES.common,
    },
    {
      cardDefId: mysteryCard.id,
      name: "???",
      number: 0,
      set: "unknown",
      rarity: "mystery",
      kind: "pokemon",
      price: CARD_PRICES.mystery,
      isMystery: true,
    },
  ];

  // Cosmetic offers
  const dailyCoin = seededPick(AVAILABLE_COINS, seed, 10);
  const dailyCardBack = seededPick(AVAILABLE_CARD_BACKS, seed, 11);
  const dailyAvatar = seededPick(AVAILABLE_AVATARS, seed, 12);
  const dailyVariant = seededPick(AVAILABLE_VARIANTS, seed, 13);

  const cosmeticOffers: DailyCosmeticOffer[] = [
    { type: "coin", itemId: dailyCoin.itemId, name: dailyCoin.name, imageUrl: dailyCoin.imageUrl, price: COSMETIC_PRICES.coin },
    { type: "cardBack", itemId: dailyCardBack.itemId, name: dailyCardBack.name, imageUrl: dailyCardBack.imageUrl, price: COSMETIC_PRICES.cardBack },
    { type: "avatar", itemId: dailyAvatar.itemId, name: dailyAvatar.name, imageUrl: dailyAvatar.imageUrl, price: COSMETIC_PRICES.avatar },
    { type: "variant", itemId: dailyVariant.itemId, name: dailyVariant.name, imageUrl: dailyVariant.imageUrl, overlayId: dailyVariant.overlayId, price: COSMETIC_PRICES.variant },
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
    const today = getUtcDateString();

    // Get today's purchases
    const purchases = await prisma.dailyPurchase.findMany({
      where: { userId, date: today },
      select: { itemKey: true },
    });
    purchasedToday = purchases.map((p) => p.itemKey);

    // Check ownership of today's cosmetic offers
    const [ownedCoins, ownedCardBacks, ownedAvatars, ownedSkins] = await Promise.all([
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
  }

  return { cardOffers, cosmeticOffers, energyOffers, purchasedToday, ownedItems };
}

// ---------------------------------------------------------------------------
// Buy a daily card (monedas) — one-time per day
// ---------------------------------------------------------------------------

export async function buyDailyCard(userId: string, cardDefId: string) {
  const offers = await getDailyOffers(userId);
  const offer = offers.cardOffers.find((o) => o.cardDefId === cardDefId);
  if (!offer) {
    throw Errors.BadRequest("Esta carta no esta disponible en la tienda hoy");
  }

  // Check if already purchased today
  const today = getUtcDateString();
  const itemKey = `card:${cardDefId}`;
  const existing = await prisma.dailyPurchase.findUnique({
    where: { userId_itemKey_date: { userId, itemKey, date: today } },
  });
  if (existing) {
    throw Errors.BadRequest("Ya compraste esta carta hoy");
  }

  await usersService.spendCoins(userId, offer.price, "card_purchase", `Compra de carta: ${offer.name}`);

  await prisma.userCard.upsert({
    where: { userId_cardDefId: { userId, cardDefId } },
    update: { quantity: { increment: 1 } },
    create: { userId, cardDefId, quantity: 1 },
  });

  // Record the daily purchase
  await prisma.dailyPurchase.create({
    data: { userId, itemKey, date: today },
  });

  // For mystery card, reveal the real card info
  if (offer.isMystery) {
    const realCard = allCards.find((c) => c.id === cardDefId);
    return {
      cardDefId,
      name: realCard && isPokemonCard(realCard) ? realCard.name : cardDefId,
      number: realCard?.number ?? 0,
      set: realCard?.set ?? "unknown",
      revealed: true,
    };
  }

  return { cardDefId, name: offer.name, number: offer.number, set: offer.set, revealed: false };
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
    throw Errors.BadRequest("Este cosmetico no esta disponible en la tienda hoy");
  }

  // Check if already purchased today
  const today = getUtcDateString();
  const itemKey = `cosmetic:${type}:${itemId}`;
  const existingPurchase = await prisma.dailyPurchase.findUnique({
    where: { userId_itemKey_date: { userId, itemKey, date: today } },
  });
  if (existingPurchase) {
    throw Errors.BadRequest("Ya compraste este cosmetico hoy");
  }

  // Check if already owned (for coins and card backs)
  if (type === "coin") {
    const existing = await prisma.userCoin.findUnique({
      where: { userId_coinId: { userId, coinId: itemId } },
    });
    if (existing) throw Errors.BadRequest("Ya posees esta moneda");

    await usersService.spendCoupons(userId, offer.price, "cosmetic_purchase", `Compra de moneda: ${offer.name}`);
    await prisma.userCoin.create({ data: { userId, coinId: itemId } });
  } else if (type === "cardBack") {
    const existing = await prisma.userCardBack.findUnique({
      where: { userId_cardBackId: { userId, cardBackId: itemId } },
    });
    if (existing) throw Errors.BadRequest("Ya posees este reverso de carta");

    await usersService.spendCoupons(userId, offer.price, "cosmetic_purchase", `Compra de card back: ${offer.name}`);
    await prisma.userCardBack.create({ data: { userId, cardBackId: itemId } });
  } else if (type === "avatar") {
    const existing = await prisma.userAvatar.findUnique({
      where: { userId_avatarId: { userId, avatarId: itemId } },
    });
    if (existing) throw Errors.BadRequest("Ya posees este avatar");

    await usersService.spendCoupons(userId, offer.price, "cosmetic_purchase", `Compra de avatar: ${offer.name}`);
    await prisma.userAvatar.create({ data: { userId, avatarId: itemId } });
  } else if (type === "variant") {
    const existing = await prisma.userCardSkin.findUnique({
      where: { userId_skinId: { userId, skinId: itemId } },
    });
    if (existing) throw Errors.BadRequest("Ya posees esta variante");

    await usersService.spendCoupons(userId, offer.price, "cosmetic_purchase", `Compra de variante: ${offer.name}`);
    await prisma.userCardSkin.create({ data: { userId, skinId: itemId } });
  }

  // Record the daily purchase
  await prisma.dailyPurchase.create({
    data: { userId, itemKey, date: today },
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
    throw Errors.BadRequest("Tipo de energia no valido");
  }

  const totalPrice = offer.price * quantity;
  await usersService.spendCoins(userId, totalPrice, "energy_purchase", `Compra de ${quantity}x ${offer.name}`);

  await prisma.userCard.upsert({
    where: { userId_cardDefId: { userId, cardDefId: offer.cardDefId } },
    update: { quantity: { increment: quantity } },
    create: { userId, cardDefId: offer.cardDefId, quantity },
  });

  return { cardDefId: offer.cardDefId, energyType, quantity };
}

// ---------------------------------------------------------------------------
// Convert Rare Candy
// ---------------------------------------------------------------------------

export async function convertRareCandy(
  userId: string,
  target: "coins" | "coupons",
) {
  await usersService.spendRareCandy(userId, 1, "rare_candy_conversion", `Conversion de Caramelo Raro a ${target}`);

  if (target === "coins") {
    const result = await usersService.addCoins(userId, CANDY_TO_COINS, "rare_candy_conversion", `Conversion: 1 Caramelo Raro → ${CANDY_TO_COINS} monedas`);
    return { target, amount: CANDY_TO_COINS, newBalance: result.coins };
  } else {
    const result = await usersService.addCoupons(userId, CANDY_TO_COUPONS, "rare_candy_conversion", `Conversion: 1 Caramelo Raro → ${CANDY_TO_COUPONS} cupones`);
    return { target, amount: CANDY_TO_COUPONS, newBalance: result.coupons };
  }
}
