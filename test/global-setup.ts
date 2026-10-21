import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://ptcg:ptcg@127.0.0.1:55432/ptcg_test";

/**
 * Partial unique indexes (`CREATE UNIQUE INDEX … WHERE …`) of prisma/migrations: Prisma can't
 * declare them in schema.prisma, so `db push` doesn't create them (e.g. adventure_runs_one_active).
 */
function partialIndexStatements(): string[] {
  const dir = path.resolve(__dirname, "../prisma/migrations");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sql = readFileSync(path.join(dir, entry.name, "migration.sql"), "utf8");
      return sql.match(/CREATE UNIQUE INDEX[^;]*\bWHERE\b[^;]*;/g) ?? [];
    });
}

export default function setup() {
  if (!/127\.0\.0\.1|localhost/.test(TEST_DATABASE_URL)) {
    throw new Error(`Refusing to reset a non-local database: ${TEST_DATABASE_URL}`);
  }
  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  // Recreate the schema from prisma/schema.prisma on every run.
  execSync("npx prisma db push --force-reset --skip-generate", { stdio: "inherit", env });
  const partial = partialIndexStatements();
  if (partial.length > 0) {
    execSync(`npx prisma db execute --url "${TEST_DATABASE_URL}" --stdin`, { input: partial.join("\n"), stdio: ["pipe", "ignore", "inherit"], env });
  }
}
