import { execSync } from "node:child_process";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://ptcg:ptcg@127.0.0.1:55432/ptcg_test";

export default function setup() {
  if (!/127\.0\.0\.1|localhost/.test(TEST_DATABASE_URL)) {
    throw new Error(`Refusing to reset a non-local database: ${TEST_DATABASE_URL}`);
  }
  // Recreate the schema from prisma/schema.prisma on every run.
  execSync("npx prisma db push --force-reset --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
