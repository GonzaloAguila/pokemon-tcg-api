-- CreateTable
CREATE TABLE "news_posts" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(10000) NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'news',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "ctaLabel" VARCHAR(40),
    "ctaHref" VARCHAR(200),
    "showInCarousel" BOOLEAN NOT NULL DEFAULT false,
    "notificationId" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "news_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "news_posts_publishedAt_idx" ON "news_posts"("publishedAt");

-- CreateIndex
CREATE INDEX "news_posts_createdAt_idx" ON "news_posts"("createdAt");

-- AddForeignKey
ALTER TABLE "news_posts" ADD CONSTRAINT "news_posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

