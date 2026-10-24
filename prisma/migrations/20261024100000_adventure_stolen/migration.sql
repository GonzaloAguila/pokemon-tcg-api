-- Modo Aventura 2: cards stolen from the run deck by rivals, and the no-steal clears counter.
-- AlterTable
ALTER TABLE "adventure_runs" ADD COLUMN "stolen" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "cardsStolen" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "adventure_progress" ADD COLUMN "noStealClears" INTEGER NOT NULL DEFAULT 0;
