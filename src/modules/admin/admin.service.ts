import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { ALL_PERMISSIONS } from "./permissions.js";

// =============================================================================
// User Management
// =============================================================================

// ---------------------------------------------------------------------------
// Search users by username, email, or id
// ---------------------------------------------------------------------------

export async function searchUsers(query: string, limit = 20, cursor?: string) {
  const where = {
    ...(query
      ? {
          OR: [
            { username: { contains: query, mode: "insensitive" as const } },
            { email: { contains: query, mode: "insensitive" as const } },
            { id: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
  };

  return prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      coins: true,
      coupons: true,
      rareCandy: true,
      level: true,
      createdAt: true,
      lastLoginAt: true,
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
    },
  });
}

// ---------------------------------------------------------------------------
// Get full user detail (for admin inspection)
// ---------------------------------------------------------------------------

export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      permissions: true,
      coins: true,
      coupons: true,
      rareCandy: true,
      level: true,
      experience: true,
      avatarPresetId: true,
      createdAt: true,
      lastLoginAt: true,
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
      _count: {
        select: {
          cards: true,
          decks: true,
        },
      },
    },
  });

  if (!user) throw Errors.NotFound("Usuario");

  // Fetch recent transactions separately
  const recentTransactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      type: true,
      description: true,
      amount: true,
      balanceAfter: true,
      createdAt: true,
    },
  });

  return {
    ...user,
    avatarId: user.avatarPresetId,
    collectionCount: user._count.cards,
    deckCount: user._count.decks,
    recentTransactions,
  };
}

// ---------------------------------------------------------------------------
// Delete user (refuse if admin or superadmin)
// ---------------------------------------------------------------------------

export async function deleteUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) throw Errors.NotFound("Usuario");

  if (user.role === "admin" || user.role === "superadmin") {
    throw Errors.Forbidden("No se puede eliminar a un administrador");
  }

  await prisma.user.delete({ where: { id: userId } });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Set user role (superadmin only)
// ---------------------------------------------------------------------------

export async function setUserRole(userId: string, role: "user" | "admin") {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) throw Errors.NotFound("Usuario");

  if (user.role === "superadmin") {
    throw Errors.Forbidden("No se puede cambiar el rol de un superadmin");
  }

  // When demoting to user, clear permissions
  return prisma.user.update({
    where: { id: userId },
    data: {
      role,
      ...(role === "user" ? { permissions: [] } : {}),
    },
    select: {
      id: true,
      username: true,
      role: true,
      permissions: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Set permissions (superadmin only)
// ---------------------------------------------------------------------------

export async function setPermissions(userId: string, permissions: string[]) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) throw Errors.NotFound("Usuario");

  if (user.role !== "admin") {
    throw Errors.BadRequest("Solo se pueden asignar permisos a usuarios con rol admin");
  }

  // Validate that all permissions are valid
  const invalidPerms = permissions.filter((p) => !ALL_PERMISSIONS.includes(p as typeof ALL_PERMISSIONS[number]));
  if (invalidPerms.length > 0) {
    throw Errors.BadRequest(`Permisos invalidos: ${invalidPerms.join(", ")}`);
  }

  return prisma.user.update({
    where: { id: userId },
    data: { permissions },
    select: {
      id: true,
      username: true,
      role: true,
      permissions: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Get all admins
// ---------------------------------------------------------------------------

export async function getAdmins() {
  return prisma.user.findMany({
    where: {
      role: { in: ["admin", "superadmin"] },
    },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      permissions: true,
      createdAt: true,
      lastLoginAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

// =============================================================================
// Economy
// =============================================================================

// ---------------------------------------------------------------------------
// Adjust coins
// ---------------------------------------------------------------------------

export async function adjustCoins(userId: string, amount: number, reason: string, adminId: string) {
  if (!Number.isInteger(amount) || amount === 0) {
    throw Errors.BadRequest("amount debe ser un entero diferente de cero");
  }
  if (!reason || reason.trim().length === 0) {
    throw Errors.BadRequest("reason es requerido");
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });
    if (!user) throw Errors.NotFound("Usuario");

    if (amount < 0 && user.coins < Math.abs(amount)) {
      throw Errors.BadRequest(`Saldo insuficiente. Tiene ${user.coins} monedas`);
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } },
      select: { coins: true },
    });

    await tx.transaction.create({
      data: {
        userId,
        type: "admin_adjustment",
        description: `[Admin: ${adminId}] Coins: ${amount > 0 ? "+" : ""}${amount}. Razon: ${reason.trim()}`,
        amount,
        balanceAfter: updated.coins,
      },
    });

    return { coins: updated.coins };
  });
}

// ---------------------------------------------------------------------------
// Adjust coupons
// ---------------------------------------------------------------------------

export async function adjustCoupons(userId: string, amount: number, reason: string, adminId: string) {
  if (!Number.isInteger(amount) || amount === 0) {
    throw Errors.BadRequest("amount debe ser un entero diferente de cero");
  }
  if (!reason || reason.trim().length === 0) {
    throw Errors.BadRequest("reason es requerido");
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coupons: true },
    });
    if (!user) throw Errors.NotFound("Usuario");

    if (amount < 0 && user.coupons < Math.abs(amount)) {
      throw Errors.BadRequest(`Saldo insuficiente. Tiene ${user.coupons} cupones`);
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { coupons: { increment: amount } },
      select: { coupons: true },
    });

    await tx.transaction.create({
      data: {
        userId,
        type: "admin_adjustment",
        description: `[Admin: ${adminId}] Coupons: ${amount > 0 ? "+" : ""}${amount}. Razon: ${reason.trim()}`,
        amount,
        balanceAfter: updated.coupons,
      },
    });

    return { coupons: updated.coupons };
  });
}

// ---------------------------------------------------------------------------
// Adjust rare candy
// ---------------------------------------------------------------------------

export async function adjustRareCandy(userId: string, amount: number, reason: string, adminId: string) {
  if (!Number.isInteger(amount) || amount === 0) {
    throw Errors.BadRequest("amount debe ser un entero diferente de cero");
  }
  if (!reason || reason.trim().length === 0) {
    throw Errors.BadRequest("reason es requerido");
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { rareCandy: true },
    });
    if (!user) throw Errors.NotFound("Usuario");

    if (amount < 0 && user.rareCandy < Math.abs(amount)) {
      throw Errors.BadRequest(`Saldo insuficiente. Tiene ${user.rareCandy} rare candy`);
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { rareCandy: { increment: amount } },
      select: { rareCandy: true },
    });

    await tx.transaction.create({
      data: {
        userId,
        type: "admin_adjustment",
        description: `[Admin: ${adminId}] RareCandy: ${amount > 0 ? "+" : ""}${amount}. Razon: ${reason.trim()}`,
        amount,
        balanceAfter: updated.rareCandy,
      },
    });

    return { rareCandy: updated.rareCandy };
  });
}

// =============================================================================
// Collection
// =============================================================================

// ---------------------------------------------------------------------------
// Adjust cards
// ---------------------------------------------------------------------------

export async function adjustCards(
  userId: string,
  cards: { cardDefId: string; quantity: number }[],
  adminId: string,
) {
  if (!cards || cards.length === 0) {
    throw Errors.BadRequest("cards es requerido");
  }

  return prisma.$transaction(async (tx) => {
    // Verify user exists
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw Errors.NotFound("Usuario");

    const results: { cardDefId: string; newQuantity: number }[] = [];

    for (const card of cards) {
      if (!card.cardDefId || !Number.isInteger(card.quantity) || card.quantity === 0) {
        continue;
      }

      if (card.quantity > 0) {
        // Add cards: upsert with increment
        const existing = await tx.userCard.findUnique({
          where: {
            userId_cardDefId: { userId, cardDefId: card.cardDefId },
          },
        });

        if (existing) {
          const updated = await tx.userCard.update({
            where: { id: existing.id },
            data: { quantity: { increment: card.quantity } },
          });
          results.push({ cardDefId: card.cardDefId, newQuantity: updated.quantity });
        } else {
          await tx.userCard.create({
            data: {
              userId,
              cardDefId: card.cardDefId,
              quantity: card.quantity,
            },
          });
          results.push({ cardDefId: card.cardDefId, newQuantity: card.quantity });
        }
      } else {
        // Remove cards: decrement and delete if reaches 0
        const existing = await tx.userCard.findUnique({
          where: {
            userId_cardDefId: { userId, cardDefId: card.cardDefId },
          },
        });

        if (!existing) continue;

        const newQuantity = existing.quantity + card.quantity; // quantity is negative
        if (newQuantity <= 0) {
          await tx.userCard.delete({ where: { id: existing.id } });
          results.push({ cardDefId: card.cardDefId, newQuantity: 0 });
        } else {
          await tx.userCard.update({
            where: { id: existing.id },
            data: { quantity: newQuantity },
          });
          results.push({ cardDefId: card.cardDefId, newQuantity });
        }
      }
    }

    // Log transaction
    const summary = cards.map((c) => `${c.cardDefId}:${c.quantity > 0 ? "+" : ""}${c.quantity}`).join(", ");
    await tx.transaction.create({
      data: {
        userId,
        type: "admin_adjustment",
        description: `[Admin: ${adminId}] Cards: ${summary}`,
        amount: 0,
        balanceAfter: 0,
      },
    });

    return { results };
  });
}

// =============================================================================
// Stats
// =============================================================================

const VALID_STAT_FIELDS = [
  "normalWins",
  "normalLosses",
  "rankedWins",
  "rankedLosses",
  "draftWins",
  "draftLosses",
];

// ---------------------------------------------------------------------------
// Adjust stats
// ---------------------------------------------------------------------------

export async function adjustStats(userId: string, field: string, amount: number, adminId: string) {
  if (!VALID_STAT_FIELDS.includes(field)) {
    throw Errors.BadRequest(`Campo invalido. Campos validos: ${VALID_STAT_FIELDS.join(", ")}`);
  }
  if (!Number.isInteger(amount) || amount === 0) {
    throw Errors.BadRequest("amount debe ser un entero diferente de cero");
  }

  // Ensure UserStats exists (upsert)
  const stats = await prisma.userStats.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });

  // Check that result won't be negative
  const currentValue = (stats as Record<string, unknown>)[field] as number;
  if (currentValue + amount < 0) {
    throw Errors.BadRequest(`El resultado no puede ser negativo. Valor actual: ${currentValue}`);
  }

  const updated = await prisma.userStats.update({
    where: { userId },
    data: { [field]: { increment: amount } },
  });

  // Log transaction
  await prisma.transaction.create({
    data: {
      userId,
      type: "admin_adjustment",
      description: `[Admin: ${adminId}] Stats: ${field} ${amount > 0 ? "+" : ""}${amount}`,
      amount: 0,
      balanceAfter: 0,
    },
  });

  return updated;
}

// =============================================================================
// Dashboard
// =============================================================================

// ---------------------------------------------------------------------------
// Get admin dashboard stats
// ---------------------------------------------------------------------------

export type StatsPeriod = "day" | "week" | "month";

function getPeriodStart(period: StatsPeriod): Date {
  const now = new Date();
  switch (period) {
    case "day": {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      return start;
    }
    case "week": {
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    case "month": {
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }
}

export async function getAdminStats(period?: StatsPeriod) {
  // When no period: active today + all-time games/messages (original behavior)
  // When period provided: filter active users, games, and messages by that date range
  const periodStart = period ? getPeriodStart(period) : undefined;
  const activityStart = periodStart ?? (() => {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    return todayStart;
  })();

  const [totalUsers, activeUsers, totalGamesPlayed, totalMessages] = await Promise.all([
    // Total users is always unfiltered
    prisma.user.count(),

    // Active users: filtered by period (defaults to today)
    prisma.user.count({
      where: { lastLoginAt: { gte: activityStart } },
    }),

    // Games played: filtered by period when provided, all-time otherwise
    prisma.match.count({
      where: {
        status: "finished",
        ...(periodStart ? { updatedAt: { gte: periodStart } } : {}),
      },
    }),

    // Messages: filtered by period when provided, all-time otherwise
    prisma.systemMessage.count({
      ...(periodStart ? { where: { createdAt: { gte: periodStart } } } : {}),
    }),
  ]);

  return {
    totalUsers,
    activeUsers,
    totalGamesPlayed,
    totalMessages,
  };
}
