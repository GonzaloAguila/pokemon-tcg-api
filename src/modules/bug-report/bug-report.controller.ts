import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { sendBugReportEmail, type BugReportAttachment } from "../../lib/email.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// ---------------------------------------------------------------------------
// Rate limiting: max 3 bug reports per user per hour
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  // Remove old entries
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(userId, recent);
  return recent.length < RATE_LIMIT_MAX;
}

function recordUsage(userId: string): void {
  const timestamps = rateLimitMap.get(userId) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(userId, timestamps);
}

// Max base64 size for a 2MB image (~2.67MB in base64)
const MAX_IMAGE_BASE64_LENGTH = 2.67 * 1024 * 1024;
const MAX_IMAGES = 3;

// ---------------------------------------------------------------------------
// POST /bug-report  — Submit a bug report (sends email to admin)
// ---------------------------------------------------------------------------
router.post(
  "/bug-report",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // Rate limit check
      if (!checkRateLimit(userId)) {
        throw Errors.BadRequest(
          "Has enviado demasiados reportes. Intenta de nuevo mas tarde.",
        );
      }

      const { title, description, images } = req.body as {
        title?: string;
        description?: string;
        images?: { data?: string; filename?: string }[];
      };

      // Validate title
      if (!title || title.trim().length === 0) {
        throw Errors.BadRequest("El titulo es requerido");
      }
      if (title.length > 200) {
        throw Errors.BadRequest("El titulo no puede tener mas de 200 caracteres");
      }

      // Validate description
      if (!description || description.trim().length === 0) {
        throw Errors.BadRequest("La descripcion es requerida");
      }
      if (description.length > 5000) {
        throw Errors.BadRequest(
          "La descripcion no puede tener mas de 5000 caracteres",
        );
      }

      // Validate images
      const validImages: BugReportAttachment[] = [];
      if (images && Array.isArray(images)) {
        if (images.length > MAX_IMAGES) {
          throw Errors.BadRequest(`Maximo ${MAX_IMAGES} imagenes permitidas`);
        }
        for (const img of images) {
          if (!img.data || !img.filename) continue;
          if (img.data.length > MAX_IMAGE_BASE64_LENGTH) {
            throw Errors.BadRequest(
              `La imagen "${img.filename}" es demasiado grande (max 2MB)`,
            );
          }
          validImages.push({
            data: img.data,
            filename: img.filename,
            contentType: guessContentType(img.filename),
          });
        }
      }

      // Fetch username
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      const username = user?.username || "Unknown";

      // Send email
      await sendBugReportEmail(
        username,
        userId,
        title.trim(),
        description.trim(),
        validImages.length > 0 ? validImages : undefined,
      );

      // Record rate limit usage
      recordUsage(userId);

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export { router as bugReportRouter };
