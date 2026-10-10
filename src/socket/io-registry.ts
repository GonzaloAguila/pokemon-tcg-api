/**
 * Holds the Socket.io server so HTTP code (admin moderation) can reach connected sockets
 * without importing src/index.ts (which starts the server and creates an import cycle).
 */
import type { Server } from "socket.io";

let ioRef: Server | null = null;

export function setIo(io: Server): void {
  ioRef = io;
}

export function getIo(): Server | null {
  return ioRef;
}

/** Private room every authenticated socket joins on connect. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Tell every socket of `userId` why, then disconnect them all. No-op before the server exists. */
export function disconnectUserSockets(userId: string, message?: string): void {
  if (!ioRef) return;
  if (message) ioRef.to(userRoom(userId)).emit("error", { message });
  ioRef.in(userRoom(userId)).disconnectSockets(true);
}
