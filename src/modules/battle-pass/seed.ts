/**
 * Battle Pass Seed Script
 *
 * Run: npx tsx src/modules/battle-pass/seed.ts
 */

import { PrismaClient } from "@prisma/client";
import { SEASON_1_REWARDS } from "./seed-data.js";

const prisma = new PrismaClient();

async function main() {
  const pass = await prisma.battlePass.upsert({
    where: { slug: "base-set-season-1" },
    update: {
      rewards: SEASON_1_REWARDS as any,
      premiumPrice: 2,
    },
    create: {
      slug: "base-set-season-1",
      name: "Temporada 1: Base Set",
      description:
        "El primer pase de batalla. 30 dias de recompensas exclusivas del Set Base.",
      imageUrl: "/battle-pass/season-1.png",
      durationDays: 30,
      premiumPrice: 2,
      status: "active",
      rewards: SEASON_1_REWARDS as any,
    },
  });

  console.log(`✅ Battle Pass seeded: ${pass.name} (${pass.id})`);
  console.log(`   Slug: ${pass.slug}`);
  console.log(`   Rewards: ${(pass.rewards as any[]).length} total`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
