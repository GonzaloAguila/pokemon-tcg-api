/**
 * Superadmin Seed Script
 *
 * Creates the superadmin user, or promotes an existing account with that email.
 *
 *   SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... npx tsx prisma/seed.ts
 *
 * SUPERADMIN_PASSWORD is required to create the account; for an existing account it
 * is optional and, when given, resets the password. SUPERADMIN_USERNAME is optional.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD;
const username = process.env.SUPERADMIN_USERNAME?.trim() || "GonzaloAdmin";

async function main() {
  if (!email) throw new Error("SUPERADMIN_EMAIL is required");
  if (password !== undefined && password.length < 12) {
    throw new Error("SUPERADMIN_PASSWORD must be at least 12 characters");
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;

  if (!existing && !passwordHash) {
    throw new Error("SUPERADMIN_PASSWORD is required to create the superadmin account");
  }

  const user = existing
    ? await prisma.user.update({
        where: { email },
        data: { role: "superadmin", emailVerified: true, ...(passwordHash ? { passwordHash } : {}) },
      })
    : await prisma.user.create({
        data: {
          email,
          username,
          passwordHash,
          role: "superadmin",
          provider: "local",
          emailVerified: true,
          coins: 99999,
          coupons: 99,
          stats: { create: {} },
        },
      });

  console.log(`✅ Superadmin ${existing ? "updated" : "created"}: ${user.username} (${user.id})`);
  if (existing && !passwordHash) console.log("   Password unchanged (SUPERADMIN_PASSWORD not set).");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
