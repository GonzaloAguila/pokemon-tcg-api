import { prisma } from "../../lib/prisma.js";

const MESSAGE_SELECT = {
  id: true,
  userId: true,
  content: true,
  type: true,
  createdAt: true,
  user: {
    select: {
      username: true,
      activeAvatarId: true,
      role: true,
    },
  },
} as const;

export type ChatMessageWithUser = Awaited<
  ReturnType<typeof prisma.chatMessage.findFirst<{ select: typeof MESSAGE_SELECT }>>
>;

export async function saveMessage(
  userId: string,
  content: string,
  type: string = "text",
) {
  return prisma.chatMessage.create({
    data: { userId, content, type },
    select: MESSAGE_SELECT,
  });
}

export async function getRecentMessages(limit = 50) {
  const messages = await prisma.chatMessage.findMany({
    select: MESSAGE_SELECT,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return messages.reverse();
}

export async function cleanupOldMessages() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await prisma.chatMessage.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (result.count > 0) {
    console.log(`🧹 Cleaned up ${result.count} chat messages older than 7 days`);
  }
}
