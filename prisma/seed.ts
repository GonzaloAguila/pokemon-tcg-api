/**
 * Superadmin Seed Script
 *
 * Creates or updates the superadmin user.
 * Run: npx tsx prisma/seed.ts
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const SUPERADMIN = {
  email: "aguilagonzalo1@gmail.com",
  username: "GonzaloAdmin",
  password: "14781817Nostalgic.!",
  role: "superadmin" as const,
};

async function main() {
  const passwordHash = await bcrypt.hash(SUPERADMIN.password, 10);

  const user = await prisma.user.upsert({
    where: { email: SUPERADMIN.email },
    update: {
      role: SUPERADMIN.role,
      passwordHash,
      emailVerified: true,
    },
    create: {
      email: SUPERADMIN.email,
      username: SUPERADMIN.username,
      passwordHash,
      role: SUPERADMIN.role,
      provider: "local",
      emailVerified: true,
      coins: 99999,
      coupons: 99,
      stats: { create: {} },
    },
  });

  console.log(`\u2705 Superadmin seeded:`);
  console.log(`   Email: ${user.email}`);
  console.log(`   Username: ${user.username}`);
  console.log(`   Role: ${user.role}`);
  console.log(`   ID: ${user.id}`);
}

main()
  .catch((e) => {
    console.error("\u274C Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
