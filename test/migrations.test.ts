import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Guards the migrations baseline: prisma/migrations must always rebuild exactly
// prisma/schema.prisma. If this fails after a schema edit, add a migration (see docs/migrations.md).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://ptcg:ptcg@127.0.0.1:55432/ptcg_test";

function withDatabase(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function sql(adminUrl: string, statement: string) {
  execSync(`npx prisma db execute --url "${adminUrl}" --stdin`, { input: statement, stdio: ["pipe", "ignore", "inherit"] });
}

describe("prisma migrations", () => {
  it("replaying prisma/migrations produces exactly schema.prisma", () => {
    if (!/127\.0\.0\.1|localhost/.test(TEST_DATABASE_URL)) throw new Error("refusing a non-local database");
    const adminUrl = withDatabase(TEST_DATABASE_URL, "postgres");
    const shadowUrl = withDatabase(TEST_DATABASE_URL, "ptcg_shadow");
    // Separate calls: CREATE/DROP DATABASE can't share an implicit transaction
    sql(adminUrl, "DROP DATABASE IF EXISTS ptcg_shadow;");
    sql(adminUrl, "CREATE DATABASE ptcg_shadow;");
    try {
      const out = execSync(
        `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "${shadowUrl}" --script --exit-code`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toMatch(/empty migration/i);
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      throw new Error(`schema.prisma and prisma/migrations differ (exit ${e.status}). Missing SQL:\n${e.stdout}`);
    } finally {
      sql(adminUrl, "DROP DATABASE IF EXISTS ptcg_shadow;");
    }
  }, 120_000);
});
