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
  data: { username?: string; avatarUrl?: string; avatarPresetId?: string },
) {
  if (data.username) {
    const existing = await prisma.user.findFirst({
      where: { username: data.username, NOT: { id: userId } },
    });
    if (existing) {
      throw Errors.Conflict("El nombre de usuario ya esta en uso");
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: fullProfileSelect,
  });

  return user;
}

// ---------------------------------------------------------------------------
// Update cosmetics
// ---------------------------------------------------------------------------

export async function updateCosmetics(
  userId: string,
  data: { activeCoinId?: string; activeCardBackId?: string; activeAvatarId?: string },
) {
  // Verify the user owns the coin/card back/avatar
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

  return prisma.user.update({
    where: { id: userId },
    data,
    select: { activeCoinId: true, activeCardBackId: true, activeAvatarId: true },
  });
}

// ---------------------------------------------------------------------------
// Coins — add / spend (atomic with transaction log)
// ---------------------------------------------------------------------------

export async function addCoins(
  userId: string,
  amount: number,
  type: string,
  description: string,
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    const newBalance = user.coins + amount;

    await tx.user.update({
      where: { id: userId },
      data: { coins: newBalance },
    });

    await tx.transaction.create({
      data: {
        userId,
        type,
        description,
        amount,
        balanceAfter: newBalance,
      },
    });

    return { coins: newBalance };
  });
}

export async function spendCoins(
  userId: string,
  amount: number,
  type: string,
  description: string,
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    if (user.coins < amount) {
      throw Errors.BadRequest("No tienes suficientes monedas");
    }

    const newBalance = user.coins - amount;

    await tx.user.update({
      where: { id: userId },
      data: { coins: newBalance },
    });

    await tx.transaction.create({
      data: {
        userId,
        type,
        description,
        amount: -amount,
        balanceAfter: newBalance,
      },
    });

    return { coins: newBalance };
  });
}

// ---------------------------------------------------------------------------
// Coupons — add / spend (atomic with transaction log)
// ---------------------------------------------------------------------------

export async function addCoupons(
  userId: string,
  amount: number,
  type: string,
  description: string,
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coupons: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    const newBalance = user.coupons + amount;

    await tx.user.update({
      where: { id: userId },
      data: { coupons: newBalance },
    });

    await tx.transaction.create({
      data: {
        userId,
        type,
        description,
        amount,
        balanceAfter: newBalance,
      },
    });

    return { coupons: newBalance };
  });
}

export async function spendCoupons(
  userId: string,
  amount: number,
  type: string,
  description: string,
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coupons: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    if (user.coupons < amount) {
      throw Errors.BadRequest("No tienes suficientes cupones");
    }

    const newBalance = user.coupons - amount;

    await tx.user.update({
      where: { id: userId },
      data: { coupons: newBalance },
    });

    await tx.transaction.create({
      data: {
        userId,
        type,
        description,
        amount: -amount,
        balanceAfter: newBalance,
      },
    });

    return { coupons: newBalance };
  });
}

// ---------------------------------------------------------------------------
// Rare Candy — add / spend (atomic with transaction log)
// ---------------------------------------------------------------------------

export async function addRareCandy(
  userId: string,
  amount: number,
  type: string,
  description: string,
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { rareCandy: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    const newBalance = user.rareCandy + amount;

    await tx.user.update({
      where: { id: userId },
      data: { rareCandy: newBalance },
    });

    await tx.transaction.create({
      data: {
        userId,
        type,
        description,
        amount,
        balanceAfter: newBalance,
      },
    });

    return { rareCandy: newBalance };
  });
}

export async function spendRareCandy(
  userId: string,
  amount: number,
  type: string,
  description: string,
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { rareCandy: true },
    });

    if (!user) throw Errors.NotFound("Usuario");

    if (user.rareCandy < amount) {
      throw Errors.BadRequest("No tienes suficientes Caramelos Raros");
    }

    const newBalance = user.rareCandy - amount;

    await tx.user.update({
      where: { id: userId },
      data: { rareCandy: newBalance },
    });

    await tx.transaction.create({
      data: {
        userId,
        type,
        description,
        amount: -amount,
        balanceAfter: newBalance,
      },
    });

    return { rareCandy: newBalance };
  });
}

// ---------------------------------------------------------------------------
// Match result recording
// ---------------------------------------------------------------------------

type GameMode = "normal" | "ranked" | "draft";

export async function recordMatchResult(
  userId: string,
  mode: GameMode,
  isWin: boolean,
) {
  const winsField = `${mode}Wins` as const;
  const lossesField = `${mode}Losses` as const;

  const stats = await prisma.userStats.findUnique({
    where: { userId },
    select: { currentStreak: true, bestStreak: true },
  });

  if (!stats) throw Errors.NotFound("Usuario");

  const newStreak = isWin ? stats.currentStreak + 1 : 0;
  const newBestStreak = Math.max(stats.bestStreak, newStreak);

  return prisma.userStats.update({
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
// Permissions (admin-only)
// ---------------------------------------------------------------------------

export async function updatePermissions(userId: string, permissions: string[]) {
  return prisma.user.update({
    where: { id: userId },
    data: { permissions },
    select: { id: true, username: true, permissions: true },
  });
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

// ---------------------------------------------------------------------------
// Starter deck — choose color, create deck + add to collection
// ---------------------------------------------------------------------------

type StarterColor = "fire" | "water" | "grass" | "electric" | "psychic" | "fighting";

export async function setStarterDeck(userId: string, starterColor: StarterColor) {
  // Verify user exists and hasn't already picked
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { starterColor: true },
  });
  if (!user) throw Errors.NotFound("Usuario");
  if (user.starterColor) {
    throw Errors.BadRequest("Ya elegiste tu color de inicio");
  }

  // Get starter deck definition
  const starter = getStarterDeck(starterColor);

  // Update user's starterColor
  await prisma.user.update({
    where: { id: userId },
    data: { starterColor },
  });

  // Create the deck
  const deck = await createDeck(userId, { name: starter.name, cards: starter.cards });

  // Set it as active
  await setActiveDeck(userId, deck.id);

  // Add all cards to the user's collection (single transaction)
  await prisma.$transaction(async (tx) => {
    for (const entry of starter.cards) {
      await tx.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId: entry.cardDefId } },
        update: { quantity: { increment: entry.quantity } },
        create: { userId, cardDefId: entry.cardDefId, quantity: entry.quantity },
      });
    }
  });

  // Return updated profile
  return getUserProfile(userId);
}
