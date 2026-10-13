-- DropForeignKey
ALTER TABLE "matches" DROP CONSTRAINT "matches_player1Id_fkey";

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "betAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "player1Xp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "player2Xp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "roomId" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ALTER COLUMN "player1Id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "matches_player1Id_settledAt_idx" ON "matches"("player1Id", "settledAt");

-- CreateIndex
CREATE INDEX "matches_player2Id_settledAt_idx" ON "matches"("player2Id", "settledAt");

-- CreateIndex
CREATE INDEX "matches_status_settledAt_idx" ON "matches"("status", "settledAt");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_player1Id_fkey" FOREIGN KEY ("player1Id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

