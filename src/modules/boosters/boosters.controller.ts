/**
 * Booster Pack Controller
 *
 * REST endpoints for pack types (read-only: the definitions are code in boosters.service.ts) and
 * opening packs.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import * as boosterService from "./boosters.service.js";
import * as usersService from "../users/users.service.js";

const router = Router();

// =============================================================================
// Pack Types - Read
// =============================================================================

/**
 * GET /api/packs
 * List all available pack types
 */
router.get("/packs", (_req: Request, res: Response) => {
  const packs = boosterService.getAllPacks();
  res.json({ packs });
});

/**
 * GET /api/packs/:packId
 * Get pack type details
 */
router.get("/packs/:packId", (req: Request, res: Response) => {
  const { packId } = req.params;
  const pack = boosterService.getPackById(packId);

  if (!pack) {
    throw new AppError(`Pack '${packId}' not found`, 404);
  }

  res.json(pack);
});

// =============================================================================
// Pack Opening (Authenticated, charges coins)
// =============================================================================

/**
 * POST /api/packs/:packId/open
 * Open a pack — requires auth, charges coins, persists cards to collection.
 */
router.post(
  "/packs/:packId/open",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    const { packId } = req.params;
    const userId = req.user!.userId;

    const pack = boosterService.getPackById(packId);
    if (!pack) {
      return next(new AppError(`Pack '${packId}' not found`, 404));
    }

    const price = pack.price ?? 0;

    try {
      // Charge and persist in one transaction: no coins lost without cards, no cards without paying
      const result = await prisma.$transaction(async (tx) => {
        if (price > 0) {
          await usersService.spendCoins(
            userId,
            price,
            "pack_purchase",
            `Apertura de sobre: ${pack.name}`,
            tx,
          );
        }
        return boosterService.openPackForUser(tx, userId, packId, { reason: "pack_purchase", label: "Sobre comprado" });
      });

      res.json(result);
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AppError((error as Error).message, 400),
      );
    }
  },
);

export const boostersRouter = router;
