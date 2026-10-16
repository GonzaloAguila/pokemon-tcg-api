import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import * as messagingService from "./messaging.service.js";
import { Errors } from "../../middleware/error-handler.js";

const router = Router();

// =============================================================================
// User endpoints
// =============================================================================

// ---------------------------------------------------------------------------
// GET /messages — Get user's messages (broadcasts + personal)
// ---------------------------------------------------------------------------

router.get(
  "/messages",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const cursor = req.query.cursor as string | undefined;
      const result = await messagingService.getUserMessages(
        req.user!.userId,
        limit,
        cursor,
      );
      res.json({ messages: result.messages, nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /messages/unread-count — Get unread message count
// ---------------------------------------------------------------------------

router.get(
  "/messages/unread-count",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await messagingService.getUnreadCount(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /messages/:id/read — Mark a single message as read
// ---------------------------------------------------------------------------

router.post(
  "/messages/:id/read",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await messagingService.markAsRead(
        req.user!.userId,
        req.params.id,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /messages/read-all — Mark all messages as read
// ---------------------------------------------------------------------------

router.post(
  "/messages/read-all",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await messagingService.markAllAsRead(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// Admin endpoints
// =============================================================================

// Bodies (same shapes as the panel's src/infra/http/admin-api.ts). Lengths match the columns.
// Unknown keys (e.g. a client-sent `metadata`) are dropped.
const messageCategory = z.enum(["info", "reward", "penalty", "news", "maintenance"]);
const messageTitle = z.string().trim().min(1).max(200);
const messageContent = z.string().trim().min(1).max(2000);

const messageBodies = {
  create: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("broadcast"),
      title: messageTitle,
      content: messageContent,
      category: messageCategory.default("info"),
    }),
    z.object({
      type: z.literal("personal"),
      title: messageTitle,
      content: messageContent,
      category: messageCategory.default("info"),
      recipientId: z.string().uuid("recipientId inválido"),
    }),
  ]),
  update: z
    .object({
      title: messageTitle.optional(),
      content: messageContent.optional(),
      category: messageCategory.optional(),
    })
    .refine((u) => u.title !== undefined || u.content !== undefined || u.category !== undefined, "nada que actualizar"),
};

/** Parse a body or throw a 400 with the first issue. */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const res = schema.safeParse(body);
  if (res.success) return res.data;
  const issue = res.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "body";
  throw Errors.BadRequest(`Datos inválidos (${field}): ${issue?.message ?? "formato incorrecto"}`);
}

// ---------------------------------------------------------------------------
// POST /admin/messages — Create broadcast or personal message
// ---------------------------------------------------------------------------

router.post(
  "/admin/messages",
  requireAuth,
  requirePermission("messages:send"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody(messageBodies.create, req.body);
      const message =
        body.type === "personal"
          ? await messagingService.createPersonalMessage(req.user!.userId, body.recipientId, body.title, body.content, body.category)
          : await messagingService.createBroadcast(req.user!.userId, body.title, body.content, body.category);
      res.json(message);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/messages — List the messages admins sent (no automatic welcome messages)
// ---------------------------------------------------------------------------

router.get(
  "/admin/messages",
  requireAuth,
  requirePermission("messages:view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const sortBy = (req.query.sortBy as string) || undefined;
      const sortDir = (req.query.sortDir as string) === "asc" ? "asc" as const : "desc" as const;

      const result = await messagingService.getAdminMessages(page, limit, sortBy, sortDir);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /admin/messages/:id — Update a system message (not an automatic one)
// ---------------------------------------------------------------------------

router.patch(
  "/admin/messages/:id",
  requireAuth,
  requirePermission("messages:send"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updates = parseBody(messageBodies.update, req.body);
      const result = await messagingService.updateMessage(req.params.id, updates);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /admin/messages/:id — Delete a system message (not an automatic one)
// ---------------------------------------------------------------------------

router.delete(
  "/admin/messages/:id",
  requireAuth,
  requirePermission("messages:send"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await messagingService.deleteMessage(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as messagingRouter };
