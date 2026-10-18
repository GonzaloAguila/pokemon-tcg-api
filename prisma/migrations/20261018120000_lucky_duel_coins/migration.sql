-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "finalTurn" INTEGER,
ADD COLUMN     "gameMode" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "player1StarterId" TEXT,
ADD COLUMN     "player2StarterId" TEXT,
ADD COLUMN     "startingSide" TEXT;

-- AlterTable
ALTER TABLE "user_stats" ADD COLUMN     "luckyDuelAiStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "luckyDuelBestStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "luckyDuelStreak" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "matches_winnerId_gameMode_idx" ON "matches"("winnerId", "gameMode");


-- Lucky Duel games played before this column existed were only marked in their winReason
-- (vs AI "lucky-duel: <result>", multiplayer "Lucky Duel: <reason>")
UPDATE "matches" SET "gameMode" = 'lucky-duel'
WHERE "winReason" LIKE 'lucky-duel: %' OR "winReason" LIKE 'Lucky Duel: %';
