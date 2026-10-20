import type { NewsPost, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";

// =============================================================================
// Constants and types
// =============================================================================

export const NEWS_CATEGORIES = ["news", "update", "maintenance", "event"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const NEWS_PAGE_SIZE = 10;
export const NEWS_CAROUSEL_LIMIT = 8;
const EXCERPT_LENGTH = 160;
/** SystemMessage.content is VARCHAR(2000); longer bodies are sent as an excerpt (the message links to the post). */
const NOTIFICATION_BODY_LENGTH = 1990;

/** Admin-facing state of a post (the public endpoints only ever return "published"/"pinned" ones). */
export type NewsStatus = "draft" | "published" | "pinned" | "expired";

/** Fields an admin can set. `published` toggles publishedAt (now / null); `notify` sends a broadcast once. */
export interface NewsInput {
  title?: string;
  body?: string;
  category?: NewsCategory;
  pinned?: boolean;
  pinnedUntil?: Date | null;
  expiresAt?: Date | null;
  published?: boolean;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  showInCarousel?: boolean;
  notify?: boolean;
}

type NewsWithAuthor = NewsPost & { author: { username: string } | null };

// =============================================================================
// Visibility rules
// =============================================================================

/** Published (publishedAt in the past) and not expired. */
function visibleWhere(now: Date): Prisma.NewsPostWhereInput {
  return {
    publishedAt: { not: null, lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/** Pinned and not past pinnedUntil. */
function activePinWhere(now: Date): Prisma.NewsPostWhereInput {
  return { pinned: true, OR: [{ pinnedUntil: null }, { pinnedUntil: { gt: now } }] };
}

export function isPinActive(post: Pick<NewsPost, "pinned" | "pinnedUntil">, now: Date): boolean {
  return post.pinned && (post.pinnedUntil === null || post.pinnedUntil > now);
}

export function newsStatus(
  post: Pick<NewsPost, "publishedAt" | "expiresAt" | "pinned" | "pinnedUntil">,
  now: Date,
): NewsStatus {
  if (!post.publishedAt || post.publishedAt > now) return "draft";
  if (post.expiresAt && post.expiresAt <= now) return "expired";
  return isPinActive(post, now) ? "pinned" : "published";
}

const NEWEST_FIRST: Prisma.NewsPostOrderByWithRelationInput[] = [{ publishedAt: "desc" }, { id: "asc" }];

// =============================================================================
// Text helpers
// =============================================================================

/**
 * The body without its embed lines (`[[torneo-halloween-2026]]`: a block the frontend's news page
 * draws, see src/features/news/embeds). Excerpts and Mensajes only carry the text.
 */
export function stripEmbeds(body: string): string {
  return body.replace(/^[ \t]*\[\[[a-z0-9-]+\]\][ \t]*(\r?\n|$)/gm, "").trim();
}

/** Plain-text preview of a markdown-lite body: embeds and markers removed, whitespace collapsed, cut at a word. */
export function toExcerpt(body: string, length = EXCERPT_LENGTH): string {
  const plain = stripEmbeds(body)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= length) return plain;
  const cut = plain.slice(0, length);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > length * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function newsHref(id: string): string {
  return `/news/${id}`;
}

// =============================================================================
// Serializers
// =============================================================================

function toPublicSummary(post: NewsPost, now: Date) {
  return {
    id: post.id,
    title: post.title,
    excerpt: toExcerpt(post.body),
    category: post.category as NewsCategory,
    pinned: isPinActive(post, now),
    publishedAt: post.publishedAt,
    ctaLabel: post.ctaLabel,
    ctaHref: post.ctaHref,
  };
}

function toPublicDetail(post: NewsPost, now: Date) {
  return { ...toPublicSummary(post, now), body: post.body, updatedAt: post.updatedAt };
}

function toAdminView(post: NewsWithAuthor, now: Date) {
  return {
    id: post.id,
    title: post.title,
    body: post.body,
    category: post.category as NewsCategory,
    pinned: post.pinned,
    pinnedUntil: post.pinnedUntil,
    expiresAt: post.expiresAt,
    publishedAt: post.publishedAt,
    ctaLabel: post.ctaLabel,
    ctaHref: post.ctaHref,
    showInCarousel: post.showInCarousel,
    notified: post.notificationId !== null,
    status: newsStatus(post, now),
    authorUsername: post.author?.username ?? null,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

// =============================================================================
// Public reads
// =============================================================================

/**
 * Published, non-expired posts: active pins first, then newest. The two groups are paged as one
 * list (pins fill the first slots), so the order is stable across pages.
 */
export async function listPublicNews(page: number, limit: number, now = new Date()) {
  const visible = visibleWhere(now);
  const pin = activePinWhere(now);
  const pinnedWhere: Prisma.NewsPostWhereInput = { AND: [visible, pin] };
  const restWhere: Prisma.NewsPostWhereInput = { AND: [visible, { NOT: pin }] };

  const [pinnedCount, restCount] = await Promise.all([
    prisma.newsPost.count({ where: pinnedWhere }),
    prisma.newsPost.count({ where: restWhere }),
  ]);

  const offset = (page - 1) * limit;
  const pinnedItems =
    offset < pinnedCount
      ? await prisma.newsPost.findMany({ where: pinnedWhere, orderBy: NEWEST_FIRST, skip: offset, take: limit })
      : [];
  const remaining = limit - pinnedItems.length;
  const restItems =
    remaining > 0
      ? await prisma.newsPost.findMany({
          where: restWhere,
          orderBy: NEWEST_FIRST,
          skip: Math.max(0, offset - pinnedCount),
          take: remaining,
        })
      : [];

  return {
    data: [...pinnedItems, ...restItems].map((post) => toPublicSummary(post, now)),
    total: pinnedCount + restCount,
    page,
    limit,
  };
}

export async function getPublicNews(id: string, now = new Date()) {
  const post = await prisma.newsPost.findFirst({ where: { AND: [{ id }, visibleWhere(now)] } });
  if (!post) throw Errors.NotFound("Noticia");
  return toPublicDetail(post, now);
}

/** Slides for the home carousel: small payload, active pins first. */
export async function listCarouselNews(now = new Date()) {
  const posts = await prisma.newsPost.findMany({
    where: { AND: [visibleWhere(now), { showInCarousel: true }] },
    orderBy: NEWEST_FIRST,
    take: 50,
  });
  const ordered = [
    ...posts.filter((post) => isPinActive(post, now)),
    ...posts.filter((post) => !isPinActive(post, now)),
  ].slice(0, NEWS_CAROUSEL_LIMIT);
  return {
    items: ordered.map((post) => ({
      id: post.id,
      title: post.title,
      excerpt: toExcerpt(post.body, 120),
      category: post.category as NewsCategory,
      href: post.ctaHref ?? newsHref(post.id),
      ctaLabel: post.ctaLabel,
    })),
  };
}

// =============================================================================
// Admin
// =============================================================================

const WITH_AUTHOR = { author: { select: { username: true } } } as const;

export async function listAdminNews(page: number, limit: number, now = new Date()) {
  const [posts, total] = await Promise.all([
    prisma.newsPost.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: WITH_AUTHOR,
    }),
    prisma.newsPost.count(),
  ]);
  return { data: posts.map((post) => toAdminView(post, now)), total, page, limit };
}

export async function getAdminNews(id: string, now = new Date()) {
  const post = await prisma.newsPost.findUnique({ where: { id }, include: WITH_AUTHOR });
  if (!post) throw Errors.NotFound("Noticia");
  return toAdminView(post, now);
}

/** A CTA needs both its label and its link. */
function assertCta(ctaLabel: string | null, ctaHref: string | null) {
  if ((ctaLabel === null) !== (ctaHref === null)) {
    throw Errors.BadRequest("El botón necesita texto y enlace (o ninguno de los dos)");
  }
}

/** Broadcast "Avisar en Mensajes": maintenance posts use the maintenance category, the rest "news". */
async function createNotification(tx: Prisma.TransactionClient, post: NewsPost, senderId: string) {
  const text = stripEmbeds(post.body);
  const content = text.length > NOTIFICATION_BODY_LENGTH ? toExcerpt(text, NOTIFICATION_BODY_LENGTH) : text;
  const message = await tx.systemMessage.create({
    data: {
      type: "broadcast",
      title: post.title,
      content,
      category: post.category === "maintenance" ? "maintenance" : "news",
      senderId,
      metadata: { newsId: post.id, href: newsHref(post.id) },
    },
  });
  return tx.newsPost.update({ where: { id: post.id }, data: { notificationId: message.id } });
}

export async function createNews(authorId: string, input: NewsInput & { title: string; body: string }) {
  const ctaLabel = input.ctaLabel ?? null;
  const ctaHref = input.ctaHref ?? null;
  assertCta(ctaLabel, ctaHref);
  const published = input.published ?? false;
  if (input.notify && !published) throw Errors.BadRequest("Publica la noticia para avisar en Mensajes");

  const now = new Date();
  const id = await prisma.$transaction(async (tx) => {
    const post = await tx.newsPost.create({
      data: {
        title: input.title,
        body: input.body,
        category: input.category ?? "news",
        pinned: input.pinned ?? false,
        pinnedUntil: input.pinnedUntil ?? null,
        expiresAt: input.expiresAt ?? null,
        publishedAt: published ? now : null,
        ctaLabel,
        ctaHref,
        showInCarousel: input.showInCarousel ?? false,
        authorId,
      },
    });
    if (input.notify) await createNotification(tx, post, authorId);
    return post.id;
  });
  return getAdminNews(id);
}

export async function updateNews(id: string, actorId: string, input: NewsInput) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.newsPost.findUnique({ where: { id } });
    if (!existing) throw Errors.NotFound("Noticia");

    const ctaLabel = input.ctaLabel !== undefined ? input.ctaLabel : existing.ctaLabel;
    const ctaHref = input.ctaHref !== undefined ? input.ctaHref : existing.ctaHref;
    assertCta(ctaLabel, ctaHref);

    // Publishing keeps the original date when the post was already out; unpublishing makes it a draft.
    let publishedAt = existing.publishedAt;
    if (input.published === true && !existing.publishedAt) publishedAt = new Date();
    if (input.published === false) publishedAt = null;
    if (input.notify && !publishedAt) throw Errors.BadRequest("Publica la noticia para avisar en Mensajes");

    const post = await tx.newsPost.update({
      where: { id },
      data: {
        title: input.title,
        body: input.body,
        category: input.category,
        pinned: input.pinned,
        pinnedUntil: input.pinnedUntil,
        expiresAt: input.expiresAt,
        publishedAt,
        ctaLabel,
        ctaHref,
        showInCarousel: input.showInCarousel,
      },
    });
    // One broadcast per post: asking again after it was sent does nothing.
    if (input.notify && !post.notificationId) await createNotification(tx, post, actorId);
  });
  return getAdminNews(id);
}

/** Deletes the post and the broadcast it sent (its link would point to nothing). */
export async function deleteNews(id: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.newsPost.findUnique({ where: { id }, select: { notificationId: true } });
    if (!existing) throw Errors.NotFound("Noticia");
    await tx.newsPost.delete({ where: { id } });
    if (existing.notificationId) {
      await tx.systemMessage.deleteMany({ where: { id: existing.notificationId } });
    }
  });
  return { success: true };
}
