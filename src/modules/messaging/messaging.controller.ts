import { Router, type Request, type Response, type NextFunction } from "express";
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

// ---------------------------------------------------------------------------
// POST /admin/messages — Create broadcast or personal message
// ---------------------------------------------------------------------------

router.post(
  "/admin/messages",
  requireAuth,
  requirePermission("messages:send"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, title, content, category, recipientId, metadata } = req.body;

      if (!type || !title || !content) {
        throw Errors.BadRequest("type, title y content son requeridos");
      }

      if (type === "personal") {
        if (!recipientId) {
          throw Errors.BadRequest("recipientId es requerido para mensajes personales");
        }
        const message = await messagingService.createPersonalMessage(
          req.user!.userId,
          recipientId,
          title,
          content,
          category || "info",
          metadata,
        );
        res.json(message);
      } else if (type === "broadcast") {
        const message = await messagingService.createBroadcast(
          req.user!.userId,
          title,
          content,
          category || "info",
          metadata,
        );
        res.json(message);
      } else {
        throw Errors.BadRequest("type debe ser 'broadcast' o 'personal'");
      }
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/messages — List all system messages (admin view)
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
// PATCH /admin/messages/:id — Update a system message
// ---------------------------------------------------------------------------

router.patch(
  "/admin/messages/:id",
  requireAuth,
  requirePermission("messages:send"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, content, category } = req.body;
      const result = await messagingService.updateMessage(req.params.id, {
        title,
        content,
        category,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /admin/messages/:id — Delete a system message
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
