/**
 * Run in its own process by test/express-finish-listeners.test.ts (Sentry must load before
 * Express, like in index.ts): Sentry on (a dummy DSN, nothing is sent), the real app, one request
 * that goes through every router mounted on /api. Prints one JSON line:
 *   { status, maxFinishListeners, warnings, expressIntegration }
 */
import "./sentry-dummy-dsn.js";
import "../../src/instrument.js";
import * as Sentry from "@sentry/node";
import express from "express";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";

const warnings: string[] = [];
process.on("warning", (warning) => warnings.push(`${warning.name}: ${warning.message}`));

let maxFinishListeners = 0;
/** Track how many "finish" listeners the response holds at once. */
function track(res: ServerResponse) {
  for (const method of ["on", "once", "addListener", "prependListener", "prependOnceListener"] as const) {
    const original = res[method].bind(res) as (event: string, listener: (...args: unknown[]) => void) => ServerResponse;
    (res as unknown as Record<string, unknown>)[method] = (event: string, listener: (...args: unknown[]) => void) => {
      const out = original(event, listener);
      if (event === "finish") maxFinishListeners = Math.max(maxFinishListeners, res.listenerCount("finish"));
      return out;
    };
  }
}

const outer = express();
outer.use((_req, res, next) => {
  track(res);
  next();
});
outer.use(createApp());

const server = outer.listen(0, "127.0.0.1", async () => {
  const { port } = server.address() as AddressInfo;
  // No route answers it: the request crosses every router on /api and ends in the 404
  const res = await fetch(`http://127.0.0.1:${port}/api/no-such-route`);
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.log(
    JSON.stringify({
      status: res.status,
      maxFinishListeners,
      warnings,
      expressIntegration: Boolean(Sentry.getClient()?.getIntegrationByName("Express")),
    }),
  );
  server.close();
  process.exit(0);
});
