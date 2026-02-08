import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import * as usersService from "./users.service.js";
import * as rewardsService from "./rewards.service.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const updateProfileSchema = z.object({
  username: z
    .string()
    .min(3, "El nombre de usuario debe tener al menos 3 caracteres")
    .max(20, "El nombre de usuario no puede exceder 20 caracteres")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Solo se permiten letras, numeros y guion bajo",
    )
    .optional(),
  avatarUrl: z.string().url().optional(),
  avatarPresetId: z.string().optional(),
});

const updateCosmeticsSchema = z.object({
  activeCoinId: z.string().optional(),
  activeCardBackId: z.string().optional(),
});

const updatePermissionsSchema = z.object({
  permissions: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// GET /me — Full profile
// ---------------------------------------------------------------------------

router.get(
  "/me",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await usersService.getUserProfile(req.user!.userId);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /me — Update profile
// ---------------------------------------------------------------------------

router.patch(
  "/me",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const profile = await usersService.updateUserProfile(
        req.user!.userId,
        parsed.data,
      );
      res.json(profile);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /me/cosmetics — Update active coin/card back
// ---------------------------------------------------------------------------

router.patch(
  "/me/cosmetics",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateCosmeticsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const result = await usersService.updateCosmetics(
        req.user!.userId,
        parsed.data,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me/rewards — Daily rewards status
// ---------------------------------------------------------------------------

router.get(
  "/me/rewards",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await rewardsService.getDailyRewardsStatus(
        req.user!.userId,
      );
      res.json(status);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/claim-daily-coins
// ---------------------------------------------------------------------------

router.post(
  "/me/claim-daily-coins",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rewardsService.claimDailyCoins(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/claim-wheel-spin
// ---------------------------------------------------------------------------

router.post(
  "/me/claim-wheel-spin",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rewardsService.claimFreeWheelSpin(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/claim-slot-spin
// ---------------------------------------------------------------------------

router.post(
  "/me/claim-slot-spin",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rewardsService.claimFreeSlotSpin(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/starter — Choose starter color + create deck + add to collection
// ---------------------------------------------------------------------------

const starterSchema = z.object({
  starterColor: z.enum([
    "fire",
    "water",
    "grass",
    "electric",
    "psychic",
    "fighting",
  ]),
});

router.post(
  "/me/starter",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = starterSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const profile = await usersService.setStarterDeck(
        req.user!.userId,
        parsed.data.starterColor,
      );
      res.json(profile);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me/collection — Card collection
// ---------------------------------------------------------------------------

router.get(
  "/me/collection",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const collection = await usersService.getUserCollection(req.user!.userId);
      res.json(collection);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me/transactions — Transaction history (paginated)
// ---------------------------------------------------------------------------

router.get(
  "/me/transactions",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const cursor = req.query.cursor as string | undefined;
      const result = await usersService.getUserTransactions(
        req.user!.userId,
        limit,
        cursor,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me/cosmetics — Owned coins & card backs
// ---------------------------------------------------------------------------

router.get(
  "/me/cosmetics",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [coins, cardBacks] = await Promise.all([
        usersService.getUserCoins(req.user!.userId),
        usersService.getUserCardBacks(req.user!.userId),
      ]);
      res.json({ coins, cardBacks });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /:userId/permissions — Admin: update user permissions
// ---------------------------------------------------------------------------

router.patch(
  "/:userId/permissions",
  requireAuth,
  requireRole("admin", "superadmin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updatePermissionsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const result = await usersService.updatePermissions(
        req.params.userId,
        parsed.data.permissions,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export const usersRouter = router;
