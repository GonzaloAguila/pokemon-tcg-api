-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emoteLoadout" TEXT[] DEFAULT ARRAY['pikachu-giggle', 'eevee-cool', 'psyduck-stressed', 'charizard-think', 'bulbasaur-drink']::TEXT[];

-- CreateTable
CREATE TABLE "user_emotes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoteId" TEXT NOT NULL,
    "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_emotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_emotes_userId_emoteId_key" ON "user_emotes"("userId", "emoteId");

-- AddForeignKey
ALTER TABLE "user_emotes" ADD CONSTRAINT "user_emotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
