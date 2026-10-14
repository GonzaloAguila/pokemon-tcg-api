import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { ADMIN_PERMISSIONS } from "../admin/permissions.js";
import * as newsService from "./news.service.js";

const router = Router();

// =============================================================================
// Validation
// =============================================================================

/** Internal path only: "/packs", "/news/abc-123". No scheme, no host, no "//host". */
export const CTA_HREF_PATTERN = /^\/[a-z0-9/_-]*$/;

/** "" from a cleared form field means "none". */
const emptyToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

const dateOrNull = z
  .string()
  .datetime({ offset: true, message: "fecha inválida (ISO 8601)" })
  .transform((value) => new Date(value))
  .nullable();

const newsFields = {
  title: z.string().trim().min(1, "el título es obligatorio").max(120),
  body: z.string().trim().min(1, "el texto es obligatorio").max(10_000),
  category: z.enum(newsService.NEWS_CATEGORIES),
  pinned: z.boolean(),
  pinnedUntil: dateOrNull,
  expiresAt: dateOrNull,
  published: z.boolean(),
  ctaLabel: z.preprocess(emptyToNull, z.string().trim().min(1).max(40).nullable()),
  ctaHref: z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .max(200)
      .regex(CTA_HREF_PATTERN, "el enlace debe ser una ruta interna (/packs, /news/…)")
      .refine((href) => !href.startsWith("//"), "el enlace debe ser una ruta interna")
      .nullable(),
  ),
  showInCarousel: z.boolean(),
  notify: z.boolean(),
};

const createNewsSchema = z
  .object({
    ...newsFields,
    category: newsFields.category.optional(),
    pinned: newsFields.pinned.optional(),
    pinnedUntil: newsFields.pinnedUntil.optional(),
    expiresAt: newsFields.expiresAt.optional(),
    published: newsFields.published.optional(),
    ctaLabel: newsFields.ctaLabel.optional(),
    ctaHref: newsFields.ctaHref.optional(),
    showInCarousel: newsFields.showInCarousel.optional(),
    notify: newsFields.notify.optional(),
  })
  .strict();

const updateNewsSchema = z
  .object(newsFields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, "no hay cambios");

/** Parse req.body or throw a 400 with the first issue. */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "body";
  throw Errors.BadRequest(`Datos inválidos (${field}): ${issue?.message ?? "formato incorrecto"}`);
}

function pageParams(req: Request, maxLimit: number) {
  const page = Math.min(Math.max(Math.trunc(Number(req.query.page)) || 1, 1), 10_000);
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || newsService.NEWS_PAGE_SIZE, 1), maxLimit);
  return { page, limit };
}

/**
 * Public reads are identical for everyone: shared caches (CDN/proxy) may keep them 30 s; browsers
 * always revalidate (ETag -> 304), so a post published, pinned or expired shows up on the next load.
 */
function publicCache(res: Response) {
  res.set("Cache-Control", "public, max-age=0, s-maxage=30");
}

const requireNewsPermission = requirePermission(ADMIN_PERMISSIONS.NEWS);

// =============================================================================
// Public (no auth)
// =============================================================================

// GET /news?page=&limit= — published, not expired; active pins first, then newest
router.get("/news", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = pageParams(req, newsService.NEWS_PAGE_SIZE);
    const result = await newsService.listPublicNews(page, limit);
    publicCache(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /news/carousel — home carousel slides (showInCarousel)
router.get("/news/carousel", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await newsService.listCarouselNews();
    publicCache(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /news/:id — one published, non-expired post (404 otherwise)
router.get("/news/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await newsService.getPublicNews(req.params.id);
    publicCache(res);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// Admin (permission "news"; superadmin always)
// =============================================================================

router.get("/admin/news", requireAuth, requireNewsPermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = pageParams(req, 50);
    res.set("Cache-Control", "no-store");
    res.json(await newsService.listAdminNews(page, limit));
  } catch (err) {
    next(err);
  }
});

router.get("/admin/news/:id", requireAuth, requireNewsPermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await newsService.getAdminNews(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/admin/news", requireAuth, requireNewsPermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(createNewsSchema, req.body);
    res.status(201).json(await newsService.createNews(req.user!.userId, input));
  } catch (err) {
    next(err);
  }
});

router.patch("/admin/news/:id", requireAuth, requireNewsPermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = parseBody(updateNewsSchema, req.body);
    res.json(await newsService.updateNews(req.params.id, req.user!.userId, input));
  } catch (err) {
    next(err);
  }
});

router.delete("/admin/news/:id", requireAuth, requireNewsPermission, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await newsService.deleteNews(req.params.id));
  } catch (err) {
    next(err);
  }
});

export { router as newsRouter };
