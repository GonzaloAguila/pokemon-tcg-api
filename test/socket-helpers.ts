import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { setupSocketHandlers } from "../src/socket/handlers.js";
import { generateAccessToken } from "../src/lib/jwt.js";

/** A real Socket.io server running the production handlers on an ephemeral port. */
export async function startSocketServer() {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  setupSocketHandlers(io);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  const clients: ClientSocket[] = [];

  return {
    io,
    url: `http://127.0.0.1:${port}`,
    /** Connect like the frontend does (websocket transport, token in handshake auth). */
    async connect(token?: string): Promise<ClientSocket> {
      const socket = connectClient(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
        ...(token ? { auth: { token } } : {}),
      });
      clients.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", reject);
      });
      return socket;
    },
    async close() {
      for (const c of clients) c.disconnect();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

export function tokenFor(user: { id: string; email: string; role: "user" | "admin" | "superadmin"; tokenVersion: number }) {
  return generateAccessToken({ userId: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion });
}

/** Resolve with the first payload of `event`, or reject after `ms`. */
export function nextEvent<T = unknown>(socket: ClientSocket, event: string, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, ms);
    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

/** Resolve true if the socket is disconnected by the server within `ms`. */
export function waitForDisconnect(socket: ClientSocket, ms = 3000): Promise<boolean> {
  if (!socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("disconnect", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
