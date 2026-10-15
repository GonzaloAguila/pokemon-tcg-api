-- CreateTable
CREATE TABLE "card_values" (
    "cardDefId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_values_pkey" PRIMARY KEY ("cardDefId")
);

