import { defineConfig } from "vitest/config";

// Integration tests run against a disposable Postgres (see test/README.md).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://ptcg:ptcg@127.0.0.1:55432/ptcg_test";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: "test",
      JWT_SECRET: "test-secret",
    },
    // Tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
