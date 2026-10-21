/**
 * Production pm2 logs showed "MaxListenersExceededWarning: 11 finish listeners added to
 * [ServerResponse]". Cause: Sentry's Express integration opened a span per layer, each with a
 * res.once("finish"), and a request crosses every router mounted on /api (~25) with all of them
 * open at once (~30 listeners). instrument.ts turns those spans off (tracing is off anyway).
 * The app runs in a child process because Sentry has to load before Express.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Sentry + the /api routers", () => {
  it("a request through every router adds no pile of 'finish' listeners (no MaxListenersExceededWarning)", () => {
    const fixture = path.resolve(__dirname, "fixtures/express-finish-listeners.ts");
    const run = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const line = run.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    expect(line, `fixture output:\n${run.stdout}\n${run.stderr}`).toBeDefined();
    const result = JSON.parse(line!) as { status: number; maxFinishListeners: number; warnings: string[]; expressIntegration: boolean };
    expect(result.expressIntegration).toBe(true); // Sentry really instruments Express here
    expect(result.status).toBe(404);
    expect(result.warnings.filter((w) => w.includes("MaxListenersExceeded"))).toEqual([]);
    expect(result.maxFinishListeners).toBeLessThanOrEqual(2);
  }, 120_000);
});
