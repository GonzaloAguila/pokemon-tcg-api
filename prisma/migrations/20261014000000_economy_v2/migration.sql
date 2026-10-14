-- AlterTable
ALTER TABLE "users" ADD COLUMN     "exchangeTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "counted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "player1Coins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "player2Coins" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "user_battle_passes" ADD COLUMN     "lastStepDay" TEXT,
ADD COLUMN     "steps" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "economy_claims" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_packs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packId" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "openedPackId" TEXT,

    CONSTRAINT "user_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_missions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "user_missions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "economy_claims_userId_kind_idx" ON "economy_claims"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "economy_claims_userId_kind_key_key" ON "economy_claims"("userId", "kind", "key");

-- CreateIndex
CREATE INDEX "user_packs_userId_openedAt_idx" ON "user_packs"("userId", "openedAt");

-- CreateIndex
CREATE INDEX "user_missions_userId_period_idx" ON "user_missions"("userId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "user_missions_userId_missionId_period_key" ON "user_missions"("userId", "missionId", "period");

-- AddForeignKey
ALTER TABLE "economy_claims" ADD CONSTRAINT "economy_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_packs" ADD CONSTRAINT "user_packs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_missions" ADD CONSTRAINT "user_missions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: battle pass by activity. Under the old calendar pass a user could claim every day up to
-- today; treat the highest day already claimed (either track) as the steps already reached, so
-- nobody loses a reward: claimed (day, track) rows stay claimed, unclaimed steps up to that point
-- become claimable with the new rewards, and later steps need login days.
UPDATE "user_battle_passes" AS ubp
SET "steps" = LEAST(30, claimed.max_day)
FROM (
  SELECT "userBattlePassId", MAX("day") AS max_day
  FROM "user_battle_pass_rewards"
  GROUP BY "userBattlePassId"
) AS claimed
WHERE claimed."userBattlePassId" = ubp."id";
