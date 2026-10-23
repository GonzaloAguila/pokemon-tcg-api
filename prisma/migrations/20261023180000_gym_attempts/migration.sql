-- Gym Leaders v2.2 (docs/gym-leaders.md): one row per challenge (series) started, counted per user,
-- leader and economy day for the daily attempts. New table only.

-- CreateTable
CREATE TABLE "gym_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gym_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gym_attempts_userId_leaderId_day_idx" ON "gym_attempts"("userId", "leaderId", "day");

-- AddForeignKey
ALTER TABLE "gym_attempts" ADD CONSTRAINT "gym_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

