import { type UserRole, Prisma } from "@prisma/client";
import { findCardById } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { endAllRefreshSessions } from "../auth/refresh-sessions.js";
import { Errors } from "../../middleware/error-handler.js";
import { ALL_PERMISSIONS } from "./permissions.js";
import * as usersService from "../users/users.service.js";
import { FREE_AVATAR_IDS, type Db } from "../users/users.service.js";
import { recordCardChange, type CardChange } from "../users/card-ledger.js";
import { revalidateDecks } from "../trades/trades.service.js";
import { refreshProgressInBackground } from "../achievements/achievements.service.js";
import { SENT_MESSAGE_FILTER } from "../messaging/messaging.service.js";
import { COSMETIC_TYPE_LABELS, GRANTABLE_COSMETICS, type CosmeticType } from "./grantable-cosmetics.js";
import { startOfEconomyDay, startOfEconomyWeek } from "../economy/economy-time.js";
import { invalidateAccountState } from "../../lib/account-state.js";
import { disconnectUserSockets } from "../../socket/io-registry.js";
import { roomManager } from "../../socket/handlers.js";
import { draftRoomManager } from "../../socket/draft-handlers.js";

/**
 * Apply a moderation change right away: drop the cached account state (HTTP tokens and
 * sockets re-read it) and, when the user lost access, close their open sockets.
 */
function applySessionChange(userId: string, kickMessage?: string) {
  invalidateAccountState(userId);
  if (kickMessage) disconnectUserSockets(userId, kickMessage);
}

/**
 * Who an admin may moderate or adjust: never a superadmin, and another admin only when the
 * actor is the superadmin. Both roles come from the DB (`db`: the caller's transaction, if any).
 * Nobody acts on their own account, except the superadmin with `allowSuperadminSelf` (economy
 * and collection adjustments, cosmetic grants: never moderation, role or deletion).
 */
async function assertCanActOn(
  db: Db,
  actorId: string,
  targetId: string,
  opts: { allowSuperadminSelf?: boolean } = {},
): Promise<{ role: UserRole; status: string }> {
  const rows = await db.user.findMany({
    where: { id: { in: [actorId, targetId] } },
    select: { id: true, role: true, status: true },
  });
  const target = rows.find((u) => u.id === targetId);
  if (!target) throw Errors.NotFound("Usuario");
  if (actorId === targetId) {
    if (opts.allowSuperadminSelf && target.role === "superadmin") return target;
    throw Errors.Forbidden("No puedes realizar esta acción sobre tu propia cuenta");
  }
  if (target.role === "superadmin") {
    throw Errors.Forbidden("No se puede aplicar esta acción a un superadmin");
  }
  if (target.role === "admin" && rows.find((u) => u.id === actorId)?.role !== "superadmin") {
    throw Errors.Forbidden("Solo el superadmin puede aplicar esta acción a un administrador");
  }
  return target;
}

/** "+5" / "-5" for player-visible descriptions. */
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

// =============================================================================
// User Management
// =============================================================================

// ---------------------------------------------------------------------------
// Search users by username, email, or id
// ---------------------------------------------------------------------------

export const SEARCH_USERS_SORT_ALLOWLIST = ["username", "email", "level", "coins", "createdAt"] as const;

export async function searchUsers(
  query: string,
  page: number,
  limit: number,
  roleFilter?: UserRole,
  sortBy?: string,
  sortDir?: "asc" | "desc",
) {
  const skip = (page - 1) * limit;

  const validSort = SEARCH_USERS_SORT_ALLOWLIST.includes(sortBy as typeof SEARCH_USERS_SORT_ALLOWLIST[number])
    ? (sortBy as string)
    : "createdAt";
  const direction = sortDir === "asc" ? "asc" : "desc";

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
    ...(roleFilter ? { role: roleFilter as UserRole } : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { [validSort]: direction },
      skip,
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
        status: true,
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
    }),
    prisma.user.count({ where }),
  ]);

  return { data: users, total, page, limit };
}

// ---------------------------------------------------------------------------
// Match history (finished and abandoned games, newest first)
// ---------------------------------------------------------------------------

/** Filter values of the match history: Match.mode, or Lucky Duel (Match.gameMode, any mode). */
export const MATCH_HISTORY_MODES = ["normal", "friendly", "draft", "ai", "lucky-duel", "gym"] as const;
export type MatchHistoryMode = (typeof MATCH_HISTORY_MODES)[number];

export async function listMatches(filters: {
  q: string;
  mode?: MatchHistoryMode;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}) {
  const { q, mode, from, to, page, limit } = filters;
  const player = { username: { contains: q, mode: "insensitive" as const } };
  const where: Prisma.MatchWhereInput = {
    ...(q ? { OR: [{ player1: player }, { player2: player }] } : {}),
    ...(mode === "lucky-duel" ? { gameMode: "lucky-duel" } : mode ? { mode } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
  const seat = { select: { id: true, username: true } };
  const [matches, total] = await Promise.all([
    prisma.match.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        status: true,
        mode: true,
        gameMode: true,
        roomId: true,
        betAmount: true,
        player1Xp: true,
        player2Xp: true,
        counted: true,
        winReason: true,
        finalTurn: true,
        gym: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        player1: seat,
        player2: seat,
        winner: seat,
      },
    }),
    prisma.match.count({ where }),
  ]);
  return { data: matches, total, page, limit };
}

// ---------------------------------------------------------------------------
// Brief user search (for autocomplete / recipient picker)
// ---------------------------------------------------------------------------

export async function searchUsersBrief(query: string, limit = 10) {
  if (!query.trim()) return [];
  return prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: { username: "asc" },
    select: { id: true, username: true, email: true, role: true },
  });
}

// ---------------------------------------------------------------------------
// Get user owned cosmetics
// ---------------------------------------------------------------------------

export async function getUserOwnedCosmetics(userId: string) {
  const [coins, cardBacks, avatars, skins, playmats, emotes, trophies] = await Promise.all([
    prisma.userCoin.findMany({ where: { userId }, select: { coinId: true } }),
    prisma.userCardBack.findMany({ where: { userId }, select: { cardBackId: true } }),
    prisma.userAvatar.findMany({ where: { userId }, select: { avatarId: true } }),
    prisma.userCardSkin.findMany({ where: { userId }, select: { skinId: true } }),
    prisma.userPlaymat.findMany({ where: { userId }, select: { playmatId: true } }),
    prisma.userEmote.findMany({ where: { userId }, select: { emoteId: true } }),
    prisma.userMedal.findMany({ where: { userId, medalId: { in: [...GRANTABLE_COSMETICS.trophy] } }, select: { medalId: true } }),
  ]);

  return {
    coinIds: coins.map((c) => c.coinId),
    cardBackIds: cardBacks.map((c) => c.cardBackId),
    avatarIds: avatars.map((a) => a.avatarId),
    skinIds: skins.map((s) => s.skinId),
    playmatIds: playmats.map((p) => p.playmatId),
    emoteIds: emotes.map((e) => e.emoteId),
    trophyIds: trophies.map((t) => t.medalId),
  };
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
      status: true,
      bannedAt: true,
      bannedReason: true,
      suspendedUntil: true,
      suspendedReason: true,
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
      currency: true,
      createdAt: true,
    },
  });

  const ownedCosmetics = await getUserOwnedCosmetics(userId);

  return {
    ...user,
    avatarId: user.avatarPresetId,
    collectionCount: user._count.cards,
    deckCount: user._count.decks,
    recentTransactions,
    ownedCosmetics,
  };
}

// ---------------------------------------------------------------------------
// Delete user (refuse if admin or superadmin, or while they are in a game / draft)
// ---------------------------------------------------------------------------

export async function deleteUser(actorId: string, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) throw Errors.NotFound("Usuario");

  if (user.role === "admin" || user.role === "superadmin") {
    throw Errors.Forbidden("No se puede eliminar a un administrador");
  }

  // Live games and drafts are in memory and reference the user (results, entry fees, drafted cards)
  if (roomManager.isUserSeated(userId) || draftRoomManager.hasActivePlayer(userId)) {
    throw Errors.Conflict("El usuario está en una partida o draft en curso");
  }

  await prisma.$transaction(async (tx) => {
    // Messages addressed to the user (their welcome message, which they "sent" themselves, and
    // admin notices) only concern them; the FK would just null the recipient and leave them orphaned
    await tx.systemMessage.deleteMany({ where: { recipientId: userId } });
    // system_messages.senderId is ON DELETE RESTRICT. Only admins send messages, so this is only
    // ever an ex-admin's broadcasts: keep them, attributed to the admin deleting the account
    await tx.systemMessage.updateMany({ where: { senderId: userId }, data: { senderId: actorId } });
    await tx.user.delete({ where: { id: userId } });
  });
  applySessionChange(userId, "Tu cuenta fue eliminada");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Toggle user ban
// ---------------------------------------------------------------------------

export async function toggleUserBan(actorId: string, userId: string, banned: boolean, reason?: string) {
  await assertCanActOn(prisma, actorId, userId);
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      status: banned ? "banned" : "active",
      bannedAt: banned ? new Date() : null,
      bannedReason: banned ? (reason || null) : null,
      // Clear suspension if unbanning
      ...(banned ? {} : { suspendedUntil: null, suspendedReason: null }),
      // Increment tokenVersion to invalidate all existing sessions
      ...(banned ? { tokenVersion: { increment: 1 } } : {}),
    },
    select: { status: true },
  });
  if (banned) await endAllRefreshSessions(userId);
  applySessionChange(userId, banned ? "Tu cuenta ha sido deshabilitada" : undefined);
  return user;
}

// ---------------------------------------------------------------------------
// Suspend user for a duration
// ---------------------------------------------------------------------------

export async function suspendUser(actorId: string, userId: string, hours: number, reason?: string) {
  const target = await assertCanActOn(prisma, actorId, userId);
  // A suspension would replace the ban with a timed one (and lift it when it runs out)
  if (target.status === "banned") {
    throw Errors.Conflict("El usuario está baneado: quitale el baneo antes de suspenderlo");
  }
  const suspendedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
  // Guarded so a ban landing between the check and this write isn't overwritten
  const { count } = await prisma.user.updateMany({
    where: { id: userId, status: { not: "banned" } },
    data: {
      status: "suspended",
      suspendedUntil,
      suspendedReason: reason || null,
      tokenVersion: { increment: 1 },
    },
  });
  if (count === 0) throw Errors.Conflict("El usuario está baneado: quitale el baneo antes de suspenderlo");
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { status: true, suspendedUntil: true },
  });
  await endAllRefreshSessions(userId);
  applySessionChange(userId, "Tu cuenta está suspendida");
  return user;
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
  const updated = await prisma.user.update({
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
  // requireAuth reads the role from the account state, so this applies on the next request
  applySessionChange(userId);
  return updated;
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
    throw Errors.BadRequest(`Permisos inválidos: ${invalidPerms.join(", ")}`);
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

const ADMINS_SORT_ALLOWLIST = ["username", "email", "createdAt"] as const;

export async function getAdmins(
  page: number,
  limit: number,
  sortBy?: string,
  sortDir?: "asc" | "desc",
) {
  const skip = (page - 1) * limit;

  const validSort = ADMINS_SORT_ALLOWLIST.includes(sortBy as typeof ADMINS_SORT_ALLOWLIST[number])
    ? (sortBy as string)
    : "createdAt";
  const direction = sortDir === "asc" ? "asc" : "desc";

  const where = { role: { in: ["admin", "superadmin"] as UserRole[] } };

  const [admins, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { [validSort]: direction },
      skip,
      take: limit,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        permissions: true,
        createdAt: true,
        lastLoginAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  return { data: admins, total, page, limit };
}

// =============================================================================
// Economy
// =============================================================================

// ---------------------------------------------------------------------------
// Adjust coins / coupons / rare candy
// ---------------------------------------------------------------------------

const BALANCE_LABELS = {
  coins: { title: "Monedas", unit: "monedas" },
  coupons: { title: "Cupones", unit: "cupones" },
  rareCandy: { title: "Caramelo Raro", unit: "caramelo raro" },
} as const;

/**
 * Credit or debit one balance from the backoffice and notify the player, in one transaction.
 * The wallet row (players see it) says "Ajuste del equipo"; the admin is the notice's senderId.
 */
async function adjustBalance(
  currency: keyof typeof BALANCE_LABELS,
  userId: string,
  amount: number,
  reason: string,
  adminId: string,
) {
  if (!Number.isInteger(amount) || amount === 0) {
    throw Errors.BadRequest("amount debe ser un entero diferente de cero");
  }
  if (!reason || reason.trim().length === 0) {
    throw Errors.BadRequest("reason es requerido");
  }
  const why = reason.trim();
  const { title, unit } = BALANCE_LABELS[currency];

  return prisma.$transaction(async (tx) => {
    await assertCanActOn(tx, adminId, userId, { allowSuperadminSelf: true });
    const balances = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { coins: true, coupons: true, rareCandy: true },
    });
    const current = balances[currency];
    if (amount < 0 && current < -amount) {
      throw Errors.BadRequest(`Saldo insuficiente. Tiene ${current} ${unit}`);
    }

    // Atomic change + Transaction row (debit is guarded against going negative)
    const description = `Ajuste del equipo: ${signed(amount)} ${unit}. Razón: ${why}`;
    const balance = amount > 0
      ? await usersService.creditBalance(userId, currency, amount, "admin_adjustment", description, tx)
      : await usersService.debitBalance(userId, currency, -amount, "admin_adjustment", description, tx);

    // The player's notice (none when the superadmin adjusts their own account: the wallet row is the record)
    if (adminId !== userId) await tx.systemMessage.create({
      data: {
        type: "personal",
        title: `${title}: ${amount > 0 ? "+" : "-"}${Math.abs(amount)}`,
        content: `Se te ha ${amount > 0 ? "acreditado" : "descontado"} **${Math.abs(amount)}** ${unit} desde el panel de administración.\n\nRazón: *${why}*`,
        category: amount > 0 ? "reward" : "penalty",
        senderId: adminId,
        recipientId: userId,
      },
    });

    return balance;
  });
}

export async function adjustCoins(userId: string, amount: number, reason: string, adminId: string) {
  return { coins: await adjustBalance("coins", userId, amount, reason, adminId) };
}

export async function adjustCoupons(userId: string, amount: number, reason: string, adminId: string) {
  return { coupons: await adjustBalance("coupons", userId, amount, reason, adminId) };
}

export async function adjustRareCandy(userId: string, amount: number, reason: string, adminId: string) {
  return { rareCandy: await adjustBalance("rareCandy", userId, amount, reason, adminId) };
}

// =============================================================================
// Collection
// =============================================================================

// ---------------------------------------------------------------------------
// Adjust cards
// ---------------------------------------------------------------------------

/**
 * Add or remove copies of cards. The card history (admin-only, refId = the admin) records what
 * was really applied: a removal stops at the copies the player has. Decks that lost copies are
 * revalidated afterwards. No wallet (Transaction) row: cards are not a currency.
 */
export async function adjustCards(
  userId: string,
  cards: { cardDefId: string; quantity: number }[],
  adminId: string,
) {
  if (!cards || cards.length === 0) {
    throw Errors.BadRequest("cards es requerido");
  }
  const unknown = cards.filter((c) => !findCardById(c.cardDefId)).map((c) => c.cardDefId);
  if (unknown.length > 0) {
    throw Errors.BadRequest(`Cartas inexistentes: ${[...new Set(unknown)].join(", ")}`);
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await assertCanActOn(tx, adminId, userId, { allowSuperadminSelf: true });

    const results: { cardDefId: string; newQuantity: number }[] = [];
    const applied: CardChange[] = [];

    for (const card of cards) {
      if (!Number.isInteger(card.quantity) || card.quantity === 0) continue;
      const where = { userId_cardDefId: { userId, cardDefId: card.cardDefId } };

      if (card.quantity > 0) {
        const row = await tx.userCard.upsert({
          where,
          update: { quantity: { increment: card.quantity } },
          create: { userId, cardDefId: card.cardDefId, quantity: card.quantity },
        });
        results.push({ cardDefId: card.cardDefId, newQuantity: row.quantity });
        applied.push({ cardDefId: card.cardDefId, quantity: card.quantity });
        continue;
      }

      const existing = await tx.userCard.findUnique({ where });
      if (!existing || existing.quantity <= 0) continue;
      const remove = Math.min(existing.quantity, -card.quantity);
      // Guarded decrement: a concurrent change to this row can't be overwritten
      const { count } = await tx.userCard.updateMany({
        where: { id: existing.id, quantity: { gte: remove } },
        data: { quantity: { decrement: remove } },
      });
      if (count === 0) throw Errors.Conflict("La colección del jugador cambió; volvé a intentarlo");
      await tx.userCard.deleteMany({ where: { id: existing.id, quantity: { lte: 0 } } });
      const after = await tx.userCard.findUnique({ where, select: { quantity: true } });
      results.push({ cardDefId: card.cardDefId, newQuantity: after?.quantity ?? 0 });
      applied.push({ cardDefId: card.cardDefId, quantity: -remove });
    }

    await recordCardChange(tx, userId, "admin_adjustment", "Ajuste del equipo", applied, adminId);
    return { results, removed: applied.filter((c) => c.quantity < 0) };
  });

  // Decks left without enough copies show as invalid (the game also checks when it starts)
  if (outcome.removed.length > 0) {
    await revalidateDecks(userId, outcome.removed).catch((err: unknown) =>
      console.error("[admin] deck revalidation failed:", err),
    );
  }
  // Cards given can complete a collection achievement ("Holo Completo")
  if (outcome.results.length > outcome.removed.length) refreshProgressInBackground(userId, "admin card grant");
  return { results: outcome.results };
}

// ---------------------------------------------------------------------------
// Grant cosmetic to user
// ---------------------------------------------------------------------------

export async function grantCosmetic(
  adminId: string,
  userId: string,
  type: CosmeticType,
  itemId: string,
) {
  if (type === "avatar" && FREE_AVATAR_IDS.has(itemId)) {
    throw Errors.BadRequest("Ese avatar es gratuito: todos los jugadores ya lo tienen");
  }
  if (!GRANTABLE_COSMETICS[type].has(itemId)) {
    throw Errors.BadRequest(`${COSMETIC_TYPE_LABELS[type]} inexistente: ${itemId}`);
  }
  const typeLabel = COSMETIC_TYPE_LABELS[type];

  try {
    await prisma.$transaction(async (tx) => {
      // The superadmin may grant cosmetics to their own account; nobody else acts on themselves
      const isSelf = adminId === userId;
      await assertCanActOn(tx, adminId, userId, { allowSuperadminSelf: true });
      switch (type) {
        case "coin":
          await tx.userCoin.create({ data: { userId, coinId: itemId } });
          break;
        case "cardBack":
          await tx.userCardBack.create({ data: { userId, cardBackId: itemId } });
          break;
        case "avatar":
          await tx.userAvatar.create({ data: { userId, avatarId: itemId } });
          break;
        case "skin":
          await tx.userCardSkin.create({ data: { userId, skinId: itemId } });
          break;
        case "playmat":
          await tx.userPlaymat.create({ data: { userId, playmatId: itemId } });
          break;
        case "emote":
          await tx.userEmote.create({ data: { userId, emoteId: itemId } });
          break;
        case "trophy":
          await tx.userMedal.create({ data: { userId, medalId: itemId } });
          break;
      }

      // The grant and the player's notice go together (none for a self-grant)
      if (!isSelf) await tx.systemMessage.create({
        data: {
          type: "personal",
          title: "Nuevo cosmético concedido",
          content: `Se te ha concedido un nuevo cosmético desde el panel de administración.\n\nTipo: **${typeLabel}**\nItem: **${itemId}**`,
          category: "reward",
          senderId: adminId,
          recipientId: userId,
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw Errors.BadRequest("El usuario ya posee este cosmético");
    }
    throw err;
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Get paginated transactions for a user
// ---------------------------------------------------------------------------

export async function getUserTransactions(
  userId: string,
  page: number,
  limit: number,
) {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        type: true,
        description: true,
        amount: true,
        balanceAfter: true,
        currency: true,
        createdAt: true,
      },
    }),
    prisma.transaction.count({ where: { userId } }),
  ]);

  return { data: transactions, total, page, limit };
}

// ---------------------------------------------------------------------------
// Get the paginated card history of a user (card_transactions)
// ---------------------------------------------------------------------------

export async function getUserCardHistory(userId: string, page: number, limit: number) {
  const [data, total] = await Promise.all([
    prisma.cardTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, reason: true, description: true, cards: true, refId: true, createdAt: true },
    }),
    prisma.cardTransaction.count({ where: { userId } }),
  ]);
  return { data, total, page, limit };
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
] as const;

type StatField = (typeof VALID_STAT_FIELDS)[number];

// ---------------------------------------------------------------------------
// Adjust stats
// ---------------------------------------------------------------------------

/**
 * Add to / subtract from one win/loss counter, atomically: the decrement is guarded in the same
 * UPDATE, so concurrent adjustments can't take it below 0. No wallet (Transaction) row: stats are
 * not a currency.
 */
export async function adjustStats(userId: string, field: string, amount: number, adminId: string) {
  if (!VALID_STAT_FIELDS.includes(field as StatField)) {
    throw Errors.BadRequest(`Campo inválido. Campos válidos: ${VALID_STAT_FIELDS.join(", ")}`);
  }
  if (!Number.isInteger(amount) || amount === 0) {
    throw Errors.BadRequest("amount debe ser un entero diferente de cero");
  }
  const statField = field as StatField;

  return prisma.$transaction(async (tx) => {
    await assertCanActOn(tx, adminId, userId, { allowSuperadminSelf: true });
    // Ensure UserStats exists
    await tx.userStats.upsert({ where: { userId }, create: { userId }, update: {} });

    const { count } = await tx.userStats.updateMany({
      where: { userId, ...(amount < 0 ? { [statField]: { gte: -amount } } : {}) },
      data: { [statField]: { increment: amount } },
    });
    if (count === 0) {
      const current = await tx.userStats.findUniqueOrThrow({ where: { userId }, select: { [statField]: true } });
      throw Errors.BadRequest(
        `El resultado no puede ser negativo. Valor actual: ${(current as Record<string, number>)[statField]}`,
      );
    }
    return tx.userStats.findUniqueOrThrow({ where: { userId } });
  });
}

// =============================================================================
// Dashboard
// =============================================================================

// ---------------------------------------------------------------------------
// Get admin dashboard stats
// ---------------------------------------------------------------------------

export type StatsPeriod = "day" | "week" | "month";

/**
 * Start of a dashboard period: "day" and "week" follow the economy calendar (00:00 Argentina,
 * weeks from Monday) like every other daily/weekly number; "month" is the last 30 days.
 */
function getPeriodStart(period: StatsPeriod, now = new Date()): Date {
  switch (period) {
    case "day":
      return startOfEconomyDay(now);
    case "week":
      return startOfEconomyWeek(now);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
}

/**
 * Dashboard numbers. With a period, active users / games / messages are counted from its start
 * (`since`); without one ("all"), games and messages are all-time and active users are the
 * accounts that ever logged in or kept a session. Active = logged in or came back with a saved
 * session in the window. `period` and `since` say which window was used.
 */
export async function getAdminStats(period?: StatsPeriod) {
  const since = period ? getPeriodStart(period) : null;

  const [totalUsers, activeUsers, totalGamesPlayed, totalMessages] = await Promise.all([
    prisma.user.count(),
    // Logging in sets lastLoginAt, but most visits come back with a saved session (its refresh
    // stamps the device's lastUsedAt): either one makes the user active, counted once
    prisma.user.count({
      where: since
        ? { OR: [{ lastLoginAt: { gte: since } }, { refreshSessions: { some: { lastUsedAt: { gte: since } } } }] }
        : { OR: [{ lastLoginAt: { not: null } }, { refreshSessions: { some: {} } }] },
    }),
    prisma.match.count({
      where: {
        status: "finished",
        ...(since ? { finishedAt: { gte: since } } : {}),
      },
    }),
    prisma.systemMessage.count({
      where: { AND: [SENT_MESSAGE_FILTER, ...(since ? [{ createdAt: { gte: since } }] : [])] },
    }),
  ]);

  return {
    period: period ?? ("all" as const),
    since: since ? since.toISOString() : null,
    totalUsers,
    activeUsers,
    totalGamesPlayed,
    totalMessages,
  };
}
