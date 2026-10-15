-- CreateTable
CREATE TABLE "card_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "cards" JSONB NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "card_transactions_userId_createdAt_idx" ON "card_transactions"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
