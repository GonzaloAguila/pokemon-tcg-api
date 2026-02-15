import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireRole, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as adminService from "./admin.service.js";
import { roomManager } from "../../socket/handlers.js";
import { io } from "../../index.js";

const router = Router();

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
// GET /admin/users — Search users
// ---------------------------------------------------------------------------

router.get(
  "/admin/users",
  requireAuth,
  requirePermission("users:view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = (req.query.q as string) || "";
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const cursor = req.query.cursor as string | undefined;
      const users = await adminService.searchUsers(query, limit, cursor);
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
// DELETE /admin/users/:userId — Delete user
// ---------------------------------------------------------------------------

router.delete(
  "/admin/users/:userId",
  requireAuth,
  requirePermission("users:delete"),
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
// GET /admin/admins — List all admins (superadmin only)
// ---------------------------------------------------------------------------

router.get(
  "/admin/admins",
  requireAuth,
  requireRole("superadmin"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const admins = await adminService.getAdmins();
      res.json({ admins });
    } catch (err) {
      next(err);
    }
  },
);

export { router as adminRouter };
