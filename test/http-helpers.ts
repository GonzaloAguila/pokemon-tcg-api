import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Router } from "express";
import { errorHandler } from "../src/middleware/error-handler.js";

/** Mount routers in a minimal Express app (same JSON parser + error handler as index.ts). */
export async function startHttpApp(mount: (app: express.Express) => void) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mount(app);
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    async request(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: res.status, body: json };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type { Router };
