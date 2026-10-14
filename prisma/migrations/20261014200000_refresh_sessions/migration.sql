-- One refresh session per logged-in device (was a single users.refreshToken: logging in on
-- another device ended the previous session at its next refresh).

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_tokenHash_key" ON "refresh_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_sessions_userId_idx" ON "refresh_sessions"("userId");

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep the sessions that exist now: each stored refresh token becomes a session (the token's
-- own 7-day expiry still applies when it is verified)
INSERT INTO "refresh_sessions" ("id", "userId", "tokenHash", "expiresAt")
SELECT gen_random_uuid()::text, "id", encode(sha256(convert_to("refreshToken", 'UTF8')), 'hex'), CURRENT_TIMESTAMP + INTERVAL '7 days'
FROM "users"
WHERE "refreshToken" IS NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "refreshToken";
