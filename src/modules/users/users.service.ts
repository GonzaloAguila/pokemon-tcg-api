import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { getStarterDeck } from "../decks/starter-decks.js";
import { createDeck, setActiveDeck } from "../decks/decks.service.js";

// ---------------------------------------------------------------------------
// Full profile select (reused across queries)
// ---------------------------------------------------------------------------

const fullProfileSelect = {
  id: true,
  email: true,
  username: true,
  role: true,
  provider: true,
  avatarUrl: true,
  avatarPresetId: true,
  coins: true,
  coupons: true,
  rareCandy: true,
  exchangeTokens: true,
  loginDays: true,
  freeWheelSpins: true,
  level: true,
  experience: true,
  stats: {
    select: {
      normalWins: true,
      normalLosses: true,
      rankedWins: true,
      rankedLosses: true,
      draftWins: true,
      draftLosses: true,
      currentStreak: true,
      bestStreak: true,
    },
  },
  lastDailyCoinsAt: true,
  lastWheelSpinAt: true,
  lastSlotSpinAt: true,
  permissions: true,
  medals: {
    select: {
      medalId: true,
      unlockedAt: true,
    },
  },
  achievements: {
    select: {
      achievementId: true,
      progress: true,
      unlockedAt: true,
    },
  },
  activeCoinId: true,
  activeCardBackId: true,
  activeAvatarId: true,
  activePlaymatId: true,
  maxDeckSlots: true,
  starterColor: true,
  emailVerified: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

// ---------------------------------------------------------------------------
// Get profile
// ---------------------------------------------------------------------------

export async function getUserProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: fullProfileSelect,
  });

  if (!user) throw Errors.NotFound("Usuario");

  return user;
}

// ---------------------------------------------------------------------------
// Update profile
// ---------------------------------------------------------------------------

export async function updateUserProfile(
  userId: string,
  data: { username?: string; avatarUrl?: string; avatarPresetId?: string; acceptedTerms?: true },
) {
  if (data.username) {
    const existing = await prisma.user.findFirst({
      where: { username: data.username, NOT: { id: userId } },
    });
    if (existing) {
      throw Errors.Conflict("El nombre de usuario ya está en uso");
    }
  }

  const { acceptedTerms, ...profileData } = data;

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...profileData,
      ...(acceptedTerms ? { termsAcceptedAt: new Date() } : {}),
    },
    select: fullProfileSelect,
  });

  return user;
}

// ---------------------------------------------------------------------------
// Update cosmetics
// ---------------------------------------------------------------------------

export async function updateCosmetics(
  userId: string,
  data: { activeCoinId?: string; activeCardBackId?: string; activeAvatarId?: string; activePlaymatId?: string },
) {
  // Verify the user owns the coin/card back/avatar/playmat
  if (data.activeCoinId) {
    const owned = await prisma.userCoin.findUnique({
      where: { userId_coinId: { userId, coinId: data.activeCoinId } },
    });
    if (!owned && data.activeCoinId !== "eevee") {
      throw Errors.BadRequest("No posees esa moneda");
    }
  }

  if (data.activeCardBackId) {
    const owned = await prisma.userCardBack.findUnique({
      where: { userId_cardBackId: { userId, cardBackId: data.activeCardBackId } },
    });
    if (!owned && data.activeCardBackId !== "default") {
      throw Errors.BadRequest("No posees ese reverso de carta");
    }
  }

  if (data.activeAvatarId) {
    // "collector" and "girl" are starter avatars — always owned
    const STARTER_AVATARS = ["collector", "girl"];
    if (!STARTER_AVATARS.includes(data.activeAvatarId)) {
      const owned = await prisma.userAvatar.findUnique({
        where: { userId_avatarId: { userId, avatarId: data.activeAvatarId } },
      });
      if (!owned) {
        throw Errors.BadRequest("No posees ese avatar");
      }
    }
  }

  if (data.activePlaymatId) {
    if (data.activePlaymatId !== "field") {
      const owned = await prisma.userPlaymat.findUnique({
        where: { userId_playmatId: { userId, playmatId: data.activePlaymatId } },
      });
      if (!owned) {
        throw Errors.BadRequest("No posees ese tapete");
      }
    }
  }

  return prisma.user.update({
    where: { id: userId },
    data,
    select: { activeCoinId: true, activeCardBackId: true, activeAvatarId: true, activePlaymatId: true },
  });
}

// ---------------------------------------------------------------------------
// Balances — coins / coupons / rare candy
//
// Every change is a single atomic UPDATE (increment, or decrement guarded by
// `balance >= amount`) plus a Transaction row, so concurrent requests can't
// lose updates or overspend. Pass `db` (an interactive transaction client) to
// make the balance change part of a larger purchase; otherwise each call runs
// in its own transaction.
// ---------------------------------------------------------------------------

export type Currency = "coins" | "coupons" | "rareCandy" | "exchangeTokens";
export type Db = Prisma.TransactionClient;

const INSUFFICIENT_FUNDS: Record<Currency, string> = {
  coins: "No tienes suficientes monedas",
  coupons: "No tienes suficientes cupones",
  rareCandy: "No tienes suficientes Caramelos Raros",
  exchangeTokens: "No tienes suficientes Fichas de canje",
};

const balanceSelect = { coins: true, coupons: true, rareCandy: true, exchangeTokens: true } as const;

function assertPositiveAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw Errors.BadRequest("Cantidad inválida");
  }
}

function inTransaction<T>(db: Db | undefined, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db ? fn(db) : prisma.$transaction(fn);
}

export function creditBalance(
  userId: string,
  currency: Currency,
  amount: number,
  type: string,
  description: string,
  db?: Db,
) {
  assertPositiveAmount(amount);
  return inTransaction(db, async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId },
      data: { [currency]: { increment: amount } },
    });
    if (count === 0) throw Errors.NotFound("Usuario");

    const balances = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: balanceSelect });
    await tx.transaction.create({
      data: { userId, type, description, currency, amount, balanceAfter: balances[currency] },
    });
    return balances[currency];
  });
}

export function debitBalance(
  userId: string,
  currency: Currency,
  amount: number,
  type: string,
  description: string,
  db?: Db,
) {
  assertPositiveAmount(amount);
  return inTransaction(db, async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId, [currency]: { gte: amount } },
      data: { [currency]: { decrement: amount } },
    });
    if (count === 0) {
      const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      throw exists ? Errors.BadRequest(INSUFFICIENT_FUNDS[currency]) : Errors.NotFound("Usuario");
    }

    const balances = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: balanceSelect });
    await tx.transaction.create({
      data: { userId, type, description, currency, amount: -amount, balanceAfter: balances[currency] },
    });
    return balances[currency];
  });
}

export async function addCoins(userId: string, amount: number, type: string, description: string, db?: Db) {
  return { coins: await creditBalance(userId, "coins", amount, type, description, db) };
}

export async function spendCoins(userId: string, amount: number, type: string, description: string, db?: Db) {
  return { coins: await debitBalance(userId, "coins", amount, type, description, db) };
}

export async function addCoupons(userId: string, amount: number, type: string, description: string, db?: Db) {
  return { coupons: await creditBalance(userId, "coupons", amount, type, description, db) };
}

export async function spendCoupons(userId: string, amount: number, type: string, description: string, db?: Db) {
  return { coupons: await debitBalance(userId, "coupons", amount, type, description, db) };
}

export async function addRareCandy(userId: string, amount: number, type: string, description: string, db?: Db) {
  return { rareCandy: await creditBalance(userId, "rareCandy", amount, type, description, db) };
}

export async function spendRareCandy(userId: string, amount: number, type: string, description: string, db?: Db) {
  return { rareCandy: await debitBalance(userId, "rareCandy", amount, type, description, db) };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export async function getLeaderboard(limit = 10) {
  const stats = await prisma.userStats.findMany({
    orderBy: [
      { normalWins: "desc" },
    ],
    take: limit,
    select: {
      userId: true,
      normalWins: true,
      normalLosses: true,
      rankedWins: true,
      rankedLosses: true,
      draftWins: true,
      draftLosses: true,
      user: {
        select: {
          username: true,
          activeAvatarId: true,
          role: true,
        },
      },
    },
  });

  return stats.map((s) => {
    const totalWins = s.normalWins + s.rankedWins + s.draftWins;
    const totalLosses = s.normalLosses + s.rankedLosses + s.draftLosses;
    const totalGames = totalWins + totalLosses;
    const winRate = totalGames > 0 ? Math.round((totalWins / totalGames) * 1000) / 10 : 0;
    return {
      userId: s.userId,
      username: s.user.username,
      activeAvatarId: s.user.activeAvatarId,
      role: s.user.role,
      totalWins,
      totalGames,
      winRate,
    };
  }).sort((a, b) => b.totalWins - a.totalWins);
}

// ---------------------------------------------------------------------------
// Match result recording
// ---------------------------------------------------------------------------

type GameMode = "normal" | "ranked" | "draft";

export async function recordMatchResult(
  userId: string,
  mode: GameMode,
  isWin: boolean,
  db: Db = prisma,
) {
  const winsField = `${mode}Wins` as const;
  const lossesField = `${mode}Losses` as const;

  // Accounts get their stats row at signup; create it if it's missing (older accounts)
  const stats = await db.userStats.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { currentStreak: true, bestStreak: true },
  });

  const newStreak = isWin ? stats.currentStreak + 1 : 0;
  const newBestStreak = Math.max(stats.bestStreak, newStreak);

  return db.userStats.update({
    where: { userId },
    data: {
      [winsField]: isWin ? { increment: 1 } : undefined,
      [lossesField]: !isWin ? { increment: 1 } : undefined,
      currentStreak: newStreak,
      bestStreak: newBestStreak,
    },
    select: {
      normalWins: true,
      normalLosses: true,
      rankedWins: true,
      rankedLosses: true,
      draftWins: true,
      draftLosses: true,
      currentStreak: true,
      bestStreak: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Medals
// ---------------------------------------------------------------------------

export async function grantMedal(userId: string, medalId: string) {
  const medal = await prisma.userMedal.upsert({
    where: { userId_medalId: { userId, medalId } },
    update: {},
    create: { userId, medalId },
    select: { medalId: true, unlockedAt: true },
  });

  return { medal };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export async function getUserCollection(userId: string) {
  return prisma.userCard.findMany({
    where: { userId },
    select: { cardDefId: true, quantity: true },
    orderBy: { cardDefId: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Transactions (paginated)
// ---------------------------------------------------------------------------

export async function getUserTransactions(
  userId: string,
  limit = 20,
  cursor?: string,
) {
  const transactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      type: true,
      description: true,
      amount: true,
      balanceAfter: true,
      currency: true,
      createdAt: true,
    },
  });

  const hasMore = transactions.length > limit;
  if (hasMore) transactions.pop();

  return {
    transactions,
    nextCursor: hasMore ? transactions[transactions.length - 1]?.id : null,
  };
}

// ---------------------------------------------------------------------------
// Owned cosmetics
// ---------------------------------------------------------------------------

export async function getUserCoins(userId: string) {
  return prisma.userCoin.findMany({
    where: { userId },
    select: { coinId: true, obtainedAt: true },
    orderBy: { obtainedAt: "desc" },
  });
}

export async function getUserCardBacks(userId: string) {
  return prisma.userCardBack.findMany({
    where: { userId },
    select: { cardBackId: true, obtainedAt: true },
    orderBy: { obtainedAt: "desc" },
  });
}

export async function getUserAvatars(userId: string) {
  return prisma.userAvatar.findMany({
    where: { userId },
    select: { avatarId: true, obtainedAt: true },
    orderBy: { obtainedAt: "desc" },
  });
}

export async function getUserCardSkins(userId: string) {
  return prisma.userCardSkin.findMany({
    where: { userId },
    select: { skinId: true, obtainedAt: true },
    orderBy: { obtainedAt: "desc" },
  });
}

export async function getUserPlaymats(userId: string) {
  return prisma.userPlaymat.findMany({
    where: { userId },
    select: { playmatId: true, obtainedAt: true },
    orderBy: { obtainedAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Starter deck — choose color, create deck + add to collection
// ---------------------------------------------------------------------------

type StarterColor = "fire" | "water" | "grass" | "electric" | "psychic" | "fighting";

export async function setStarterDeck(userId: string, starterColor: StarterColor) {
  // Get starter deck definition
  const starter = getStarterDeck(starterColor);

  // Atomically claim the one-time starter pick and grant its cards; a concurrent
  // second pick matches nothing (starterColor already set) and grants nothing.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId, starterColor: null },
      data: { starterColor },
    });
    if (count === 0) {
      const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      throw exists ? Errors.BadRequest("Ya elegiste tu color de inicio") : Errors.NotFound("Usuario");
    }
    for (const entry of starter.cards) {
      await tx.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId: entry.cardDefId } },
        update: { quantity: { increment: entry.quantity } },
        create: { userId, cardDefId: entry.cardDefId, quantity: entry.quantity },
      });
    }
  });

  // Create the deck after the cards are in the collection, so it validates
  const deck = await createDeck(userId, { name: starter.name, cards: starter.cards });
  await setActiveDeck(userId, deck.id);

  // Return updated profile
  return getUserProfile(userId);
}
