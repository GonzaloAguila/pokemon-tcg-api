-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "offered" JSONB NOT NULL,
    "requested" JSONB NOT NULL,
    "offeredValue" INTEGER NOT NULL,
    "requestedValue" INTEGER NOT NULL,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "fromIp" TEXT,
    "acceptIp" TEXT,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "revertedBy" TEXT,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_locks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardDefId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "tradeId" TEXT NOT NULL,
    "unlockAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trades_fromUserId_createdAt_idx" ON "trades"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "trades_toUserId_createdAt_idx" ON "trades"("toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "trades_status_createdAt_idx" ON "trades"("status", "createdAt");

-- CreateIndex
CREATE INDEX "card_locks_userId_cardDefId_unlockAt_idx" ON "card_locks"("userId", "cardDefId", "unlockAt");

-- CreateIndex
CREATE INDEX "card_locks_tradeId_idx" ON "card_locks"("tradeId");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_locks" ADD CONSTRAINT "card_locks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

