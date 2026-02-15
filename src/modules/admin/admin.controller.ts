import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireRole, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as adminService from "./admin.service.js";
import { roomManager } from "../../socket/handlers.js";
import { io } from "../../index.js";

const router = Router();

// =============================================================================
// Helpers
// =============================================================================

/**
 * Middleware that prevents an admin from performing actions on their own account.
 * Must be placed AFTER requireAuth so that req.user is populated.
 */
function preventSelfAction(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.userId === req.params.userId) {
    throw Errors.Forbidden("No puedes realizar esta accion sobre tu propia cuenta");
  }
  next();
}

// =============================================================================
// Dashboard
// =============================================================================

// ---------------------------------------------------------------------------
// GET /admin/stats — Dashboard statistics
// ---------------------------------------------------------------------------

router.get(
  "/admin/stats",
  requireAuth,
  requirePermission("dashboard:view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const periodParam = req.query.period as string | undefined;
      const validPeriods = ["day", "week", "month"];
      const period =
        periodParam && validPeriods.includes(periodParam)
          ? (periodParam as adminService.StatsPeriod)
          : undefined;

      const stats = await adminService.getAdminStats(period);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// User Management
// =============================================================================

// ---------------------------------------------------------------------------
// GET /admin/users — Search users (offset pagination + sort + role filter)
// ---------------------------------------------------------------------------

router.get(
  "/admin/users",
  requireAuth,
  requirePermission("users:view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = (req.query.q as string) || "";
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      const role = (req.query.role as string) || undefined;
      const sortBy = (req.query.sortBy as string) || undefined;
      const sortDir = (req.query.sortDir as string) === "asc" ? "asc" as const : "desc" as const;

      const result = await adminService.searchUsers(query, page, limit, role, sortBy, sortDir);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/users/search-brief — Brief user search for autocomplete
// IMPORTANT: Must be BEFORE /admin/users/:userId to avoid matching "search-brief" as a userId
// ---------------------------------------------------------------------------

router.get(
  "/admin/users/search-brief",
  requireAuth,
  requirePermission("messages:send"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = (req.query.q as string) || "";
      const limit = Math.min(Number(req.query.limit) || 10, 20);
      const users = await adminService.searchUsersBrief(query, limit);
      res.json({ users });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/users/:userId — User detail
// ---------------------------------------------------------------------------

router.get(
  "/admin/users/:userId",
  requireAuth,
  requirePermission("users:view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await adminService.getUserDetail(req.params.userId);
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/users/:userId/transactions — Paginated transactions
// ---------------------------------------------------------------------------

router.get(
  "/admin/users/:userId/transactions",
  requireAuth,
  requirePermission("users:view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      const result = await adminService.getUserTransactions(req.params.userId, page, limit);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /admin/users/:userId — Delete user
// ---------------------------------------------------------------------------

router.delete(
  "/admin/users/:userId",
  requireAuth,
  requirePermission("users:delete"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await adminService.deleteUser(req.params.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// Economy Adjustments
// =============================================================================

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/adjust-coins
// ---------------------------------------------------------------------------

router.post(
  "/admin/users/:userId/adjust-coins",
  requireAuth,
  requirePermission("users:economy"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, reason } = req.body;
      if (amount === undefined || reason === undefined) {
        throw Errors.BadRequest("amount y reason son requeridos");
      }
      const result = await adminService.adjustCoins(
        req.params.userId,
        Number(amount),
        String(reason),
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/adjust-coupons
// ---------------------------------------------------------------------------

router.post(
  "/admin/users/:userId/adjust-coupons",
  requireAuth,
  requirePermission("users:economy"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, reason } = req.body;
      if (amount === undefined || reason === undefined) {
        throw Errors.BadRequest("amount y reason son requeridos");
      }
      const result = await adminService.adjustCoupons(
        req.params.userId,
        Number(amount),
        String(reason),
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/adjust-rare-candy
// ---------------------------------------------------------------------------

router.post(
  "/admin/users/:userId/adjust-rare-candy",
  requireAuth,
  requirePermission("users:economy"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, reason } = req.body;
      if (amount === undefined || reason === undefined) {
        throw Errors.BadRequest("amount y reason son requeridos");
      }
      const result = await adminService.adjustRareCandy(
        req.params.userId,
        Number(amount),
        String(reason),
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// Collection Adjustments
// =============================================================================

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/adjust-cards
// ---------------------------------------------------------------------------

router.post(
  "/admin/users/:userId/adjust-cards",
  requireAuth,
  requirePermission("users:cards"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cards } = req.body;
      if (!Array.isArray(cards) || cards.length === 0) {
        throw Errors.BadRequest("cards debe ser un array no vacio");
      }
      const result = await adminService.adjustCards(
        req.params.userId,
        cards,
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// Stats Adjustments
// =============================================================================

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/adjust-stats
// ---------------------------------------------------------------------------

router.post(
  "/admin/users/:userId/adjust-stats",
  requireAuth,
  requirePermission("users:stats"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { field, amount } = req.body;
      if (!field || amount === undefined) {
        throw Errors.BadRequest("field y amount son requeridos");
      }
      const result = await adminService.adjustStats(
        req.params.userId,
        String(field),
        Number(amount),
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// Moderation (Ban / Suspend)
// =============================================================================

// ---------------------------------------------------------------------------
// PATCH /admin/users/:userId/ban — Toggle user ban
// ---------------------------------------------------------------------------

router.patch(
  "/admin/users/:userId/ban",
  requireAuth,
  requirePermission("users:moderate"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { banned, reason } = req.body;
      if (typeof banned !== "boolean") {
        throw Errors.ValidationError("El campo 'banned' es requerido (true/false)");
      }
      const result = await adminService.toggleUserBan(req.params.userId, banned, reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /admin/users/:userId/suspend — Suspend user for a duration
// ---------------------------------------------------------------------------

router.post(
  "/admin/users/:userId/suspend",
  requireAuth,
  requirePermission("users:moderate"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { hours, reason } = req.body;
      const h = Number(hours);
      if (!h || h < 1 || h > 8760) {
        throw Errors.ValidationError("Las horas deben estar entre 1 y 8760 (1 anio)");
      }
      const result = await adminService.suspendUser(req.params.userId, h, reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// Room Management
// =============================================================================

// ---------------------------------------------------------------------------
// GET /admin/rooms — List all game rooms
// ---------------------------------------------------------------------------

router.get(
  "/admin/rooms",
  requireAuth,
  requirePermission("rooms:view"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const allRooms = roomManager.getAllRooms();
      const rooms: unknown[] = [];

      for (const [, room] of allRooms) {
        rooms.push({
          id: room.id,
          status: room.status,
          player1: room.player1Id
            ? { id: room.player1Id, username: room.creator.username }
            : null,
          player2: room.player2Id
            ? { id: room.player2Id, username: room.joiner.username }
            : null,
          betAmount: room.config.betAmount,
          friendly: room.config.friendly,
          createdAt: room.createdAt,
        });
      }

      res.json({ rooms });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /admin/rooms/:roomId — Force close a game room
// ---------------------------------------------------------------------------

router.delete(
  "/admin/rooms/:roomId",
  requireAuth,
  requirePermission("rooms:close"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { roomId } = req.params;
      const room = roomManager.getRoom(roomId);
      if (!room) {
        throw Errors.NotFound("Sala");
      }

      // Capture player socket IDs before deleting the room
      const socketIds: string[] = [];
      if (room.player1SocketId) socketIds.push(room.player1SocketId);
      if (room.player2SocketId) socketIds.push(room.player2SocketId);

      // Force delete the room
      roomManager.forceDeleteRoom(roomId);

      // Notify players that the room was closed by an admin
      for (const socketId of socketIds) {
        io.to(socketId).emit("gameClosed", {
          reason: "Mesa cerrada por un administrador",
        });
      }

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// =============================================================================
// SuperAdmin-only: Role & Permission Management
// =============================================================================

// ---------------------------------------------------------------------------
// PATCH /admin/users/:userId/role — Change user role (superadmin only)
// ---------------------------------------------------------------------------

router.patch(
  "/admin/users/:userId/role",
  requireAuth,
  requireRole("superadmin"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { role } = req.body;
      if (!role || (role !== "user" && role !== "admin")) {
        throw Errors.BadRequest("role debe ser 'user' o 'admin'");
      }
      const result = await adminService.setUserRole(req.params.userId, role);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /admin/users/:userId/permissions — Set permissions (superadmin only)
// ---------------------------------------------------------------------------

router.patch(
  "/admin/users/:userId/permissions",
  requireAuth,
  requireRole("superadmin"),
  preventSelfAction,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { permissions } = req.body;
      if (!Array.isArray(permissions)) {
        throw Errors.BadRequest("permissions debe ser un array");
      }
      const result = await adminService.setPermissions(
        req.params.userId,
        permissions,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/admins — List all admins (superadmin only, offset pagination + sort)
// ---------------------------------------------------------------------------

router.get(
  "/admin/admins",
  requireAuth,
  requireRole("superadmin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      const sortBy = (req.query.sortBy as string) || undefined;
      const sortDir = (req.query.sortDir as string) === "asc" ? "asc" as const : "desc" as const;

      const result = await adminService.getAdmins(page, limit, sortBy, sortDir);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as adminRouter };
