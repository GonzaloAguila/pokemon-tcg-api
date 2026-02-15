import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Create broadcast message (visible to all users)
// ---------------------------------------------------------------------------

export async function createBroadcast(
  senderId: string,
  title: string,
  content: string,
  category: string,
  metadata?: Record<string, unknown>,
) {
  if (!title || title.trim().length === 0) throw Errors.BadRequest("El titulo es requerido");
  if (!content || content.trim().length === 0) throw Errors.BadRequest("El contenido es requerido");

  return prisma.systemMessage.create({
    data: {
      type: "broadcast",
      title: title.trim(),
      content: content.trim(),
      category: category || "info",
      senderId,
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Create personal message (visible to one user)
// ---------------------------------------------------------------------------

export async function createPersonalMessage(
  senderId: string,
  recipientId: string,
  title: string,
  content: string,
  category: string,
  metadata?: Record<string, unknown>,
) {
  if (!title || title.trim().length === 0) throw Errors.BadRequest("El titulo es requerido");
  if (!content || content.trim().length === 0) throw Errors.BadRequest("El contenido es requerido");

  // Verify recipient exists
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { id: true },
  });
  if (!recipient) throw Errors.NotFound("Destinatario");

  return prisma.systemMessage.create({
    data: {
      type: "personal",
      title: title.trim(),
      content: content.trim(),
      category: category || "info",
      senderId,
      recipientId,
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Get user messages (broadcasts + personal messages for this user)
// ---------------------------------------------------------------------------

export async function getUserMessages(userId: string, limit = 50, cursor?: string) {
  const where = {
    OR: [
      { type: "broadcast" },
      { type: "personal", recipientId: userId },
    ],
    ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
  };

  const messages = await prisma.systemMessage.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      type: true,
      title: true,
      content: true,
      category: true,
      metadata: true,
      recipientId: true,
      createdAt: true,
      sender: {
        select: {
          id: true,
          username: true,
        },
      },
      reads: {
        where: { userId },
        select: { id: true },
      },
    },
  });

  return messages.map((msg) => ({
    id: msg.id,
    type: msg.type,
    title: msg.title,
    content: msg.content,
    category: msg.category,
    metadata: msg.metadata,
    recipientId: msg.recipientId,
    createdAt: msg.createdAt,
    senderUsername: msg.sender.username,
    isRead: msg.reads.length > 0,
  }));
}

// ---------------------------------------------------------------------------
// Mark a single message as read
// ---------------------------------------------------------------------------

export async function markAsRead(userId: string, messageId: string) {
  // Verify message exists and user can see it
  const message = await prisma.systemMessage.findUnique({
    where: { id: messageId },
    select: { type: true, recipientId: true },
  });
  if (!message) throw Errors.NotFound("Mensaje");

  // Check access: broadcast is visible to all, personal only to recipient
  if (message.type === "personal" && message.recipientId !== userId) {
    throw Errors.Forbidden("No tienes acceso a este mensaje");
  }

  await prisma.messageRead.upsert({
    where: {
      messageId_userId: { messageId, userId },
    },
    create: { messageId, userId },
    update: {},
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Mark all unread messages as read
// ---------------------------------------------------------------------------

export async function markAllAsRead(userId: string) {
  // Find all messages visible to this user that they haven't read
  const unreadMessages = await prisma.systemMessage.findMany({
    where: {
      OR: [
        { type: "broadcast" },
        { type: "personal", recipientId: userId },
      ],
      NOT: {
        reads: {
          some: { userId },
        },
      },
    },
    select: { id: true },
  });

  if (unreadMessages.length === 0) {
    return { markedCount: 0 };
  }

  // Create MessageRead entries for all unread messages
  await prisma.messageRead.createMany({
    data: unreadMessages.map((msg) => ({
      messageId: msg.id,
      userId,
    })),
    skipDuplicates: true,
  });

  return { markedCount: unreadMessages.length };
}

// ---------------------------------------------------------------------------
// Get unread count
// ---------------------------------------------------------------------------

export async function getUnreadCount(userId: string) {
  const count = await prisma.systemMessage.count({
    where: {
      OR: [
        { type: "broadcast" },
        { type: "personal", recipientId: userId },
      ],
      NOT: {
        reads: {
          some: { userId },
        },
      },
    },
  });

  return { count };
}

// ---------------------------------------------------------------------------
// Admin: list all system messages with read counts
// ---------------------------------------------------------------------------

const ADMIN_MESSAGES_SORT_ALLOWLIST = ["createdAt", "type", "category", "title"] as const;

export async function getAdminMessages(
  page: number,
  limit: number,
  sortBy?: string,
  sortDir?: "asc" | "desc",
) {
  const skip = (page - 1) * limit;

  const validSort = ADMIN_MESSAGES_SORT_ALLOWLIST.includes(sortBy as typeof ADMIN_MESSAGES_SORT_ALLOWLIST[number])
    ? (sortBy as string)
    : "createdAt";
  const direction = sortDir === "asc" ? "asc" : "desc";

  const [messages, total] = await Promise.all([
    prisma.systemMessage.findMany({
      orderBy: { [validSort]: direction },
      skip,
      take: limit,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        category: true,
        metadata: true,
        recipientId: true,
        createdAt: true,
        sender: {
          select: {
            id: true,
            username: true,
          },
        },
        _count: {
          select: { reads: true },
        },
      },
    }),
    prisma.systemMessage.count(),
  ]);

  const data = messages.map((msg) => ({
    id: msg.id,
    type: msg.type,
    title: msg.title,
    content: msg.content,
    category: msg.category,
    recipientId: msg.recipientId,
    createdAt: msg.createdAt,
    senderUsername: msg.sender.username,
    readCount: msg._count.reads,
  }));

  return { data, total, page, limit };
}
