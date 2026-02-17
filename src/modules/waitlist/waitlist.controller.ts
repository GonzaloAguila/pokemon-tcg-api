import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { Errors } from "../../middleware/error-handler.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

// ---------------------------------------------------------------------------
// Rate limiting: max 5 submissions per IP per hour
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(ip, recent);
  return recent.length < RATE_LIMIT_MAX;
}

function recordUsage(ip: string): void {
  const timestamps = rateLimitMap.get(ip) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(ip, timestamps);
}

const emailSchema = z.object({
  email: z.string().email("Email invalido").max(255),
});

// ---------------------------------------------------------------------------
// POST /waitlist — Add email to waitlist (no auth required)
// ---------------------------------------------------------------------------
router.post(
  "/waitlist",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";

      if (!checkRateLimit(ip)) {
        throw Errors.BadRequest(
          "Demasiados intentos. Intenta de nuevo mas tarde.",
        );
      }

      const parsed = emailSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const { email } = parsed.data;

      // Upsert — if email already exists, just return success
      await prisma.waitlistEntry.upsert({
        where: { email: email.toLowerCase() },
        update: {}, // no-op if exists
        create: { email: email.toLowerCase() },
      });

      recordUsage(ip);

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export { router as waitlistRouter };
