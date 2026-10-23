-- Gym Leaders v2 (docs/gym-leaders.md): a leader's deck per version edited from the backoffice.
-- New table only; no row = the content default deck.

-- CreateTable
CREATE TABLE "gym_leader_decks" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "cards" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "gym_leader_decks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gym_leader_decks_leaderId_mode_key" ON "gym_leader_decks"("leaderId", "mode");
