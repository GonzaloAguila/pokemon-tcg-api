-- CreateTable
CREATE TABLE "adventure_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adventureId" TEXT NOT NULL,
    "adventureVersion" INTEGER NOT NULL,
    "difficulty" TEXT NOT NULL,
    "starterId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "currentBattle" INTEGER NOT NULL DEFAULT 1,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "hearts" INTEGER NOT NULL,
    "maxHearts" INTEGER NOT NULL,
    "heartsLost" INTEGER NOT NULL DEFAULT 0,
    "deck" JSONB NOT NULL,
    "passives" TEXT[],
    "treasuresTaken" TEXT[],
    "treasuresSkipped" INTEGER NOT NULL DEFAULT 0,
    "pendingOffer" TEXT[],
    "offTypeUsed" BOOLEAN NOT NULL DEFAULT false,
    "seed" TEXT NOT NULL,
    "battle" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "adventure_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adventure_battle_results" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "battleIndex" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "victory" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "turns" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_battle_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adventure_progress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adventureId" TEXT NOT NULL,
    "clearsNormal" INTEGER NOT NULL DEFAULT 0,
    "clearsHard" INTEGER NOT NULL DEFAULT 0,
    "clearedStartersNormal" TEXT[],
    "clearedStartersHard" TEXT[],
    "runsPlayed" INTEGER NOT NULL DEFAULT 0,
    "flawlessClears" INTEGER NOT NULL DEFAULT 0,
    "puristClears" INTEGER NOT NULL DEFAULT 0,
    "monotypeClears" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "adventure_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_starter_unlocks" (
    "userId" TEXT NOT NULL,
    "starterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_starter_unlocks_pkey" PRIMARY KEY ("userId","starterId")
);

-- CreateIndex
CREATE INDEX "adventure_runs_userId_status_idx" ON "adventure_runs"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "adventure_battle_results_runId_battleIndex_attempt_key" ON "adventure_battle_results"("runId", "battleIndex", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "adventure_progress_userId_adventureId_key" ON "adventure_progress"("userId", "adventureId");

-- AddForeignKey
ALTER TABLE "adventure_runs" ADD CONSTRAINT "adventure_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adventure_battle_results" ADD CONSTRAINT "adventure_battle_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "adventure_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adventure_progress" ADD CONSTRAINT "adventure_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_starter_unlocks" ADD CONSTRAINT "user_starter_unlocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One active run per user (hand-written: Prisma can't declare a partial index).
CREATE UNIQUE INDEX "adventure_runs_one_active" ON "adventure_runs"("userId") WHERE "status" = 'active';
