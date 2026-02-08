/**
 * Booster Pack Controller
 *
 * REST endpoints for pack types and opening packs.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireAuth } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import * as boosterService from "./boosters.service.js";
import * as usersService from "../users/users.service.js";
import type { BoosterPackType } from "./boosters.types.js";

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
// Pack Types - Admin CRUD
// =============================================================================

/**
 * POST /api/packs
 * Create a new pack type
 */
router.post("/packs", (req: Request, res: Response) => {
  const packData = req.body as BoosterPackType;

  if (!packData.id || !packData.name || !packData.setId || !packData.slots) {
    throw new AppError("Missing required fields: id, name, setId, slots", 400);
  }

  try {
    const pack = boosterService.createPack(packData);
    res.status(201).json(pack);
  } catch (error) {
    throw new AppError((error as Error).message, 400);
  }
});

/**
 * PUT /api/packs/:packId
 * Update an existing pack type
 */
router.put("/packs/:packId", (req: Request, res: Response) => {
  const { packId } = req.params;
  const updates = req.body as Partial<BoosterPackType>;

  try {
    const pack = boosterService.updatePack(packId, updates);
    res.json(pack);
  } catch (error) {
    throw new AppError((error as Error).message, 404);
  }
});

/**
 * DELETE /api/packs/:packId
 * Delete a pack type
 */
router.delete("/packs/:packId", (req: Request, res: Response) => {
  const { packId } = req.params;
  const deleted = boosterService.deletePack(packId);

  if (!deleted) {
    throw new AppError(`Pack '${packId}' not found`, 404);
  }

  res.status(204).send();
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
  async (req: Request, res: Response, next: NextFunction) => {
    const { packId } = req.params;
    const userId = req.user!.userId;

    const pack = boosterService.getPackById(packId);
    if (!pack) {
      return next(new AppError(`Pack '${packId}' not found`, 404));
    }

    const price = pack.price ?? 0;

    try {
      // Charge coins (throws if insufficient balance)
      if (price > 0) {
        await usersService.spendCoins(
          userId,
          price,
          "pack_purchase",
          `Apertura de sobre: ${pack.name}`,
        );
      }

      // Generate cards
      const result = boosterService.openPack(packId);

      // Persist to user's collection
      for (const pulled of result.cards) {
        await prisma.userCard.upsert({
          where: { userId_cardDefId: { userId, cardDefId: pulled.card.id } },
          update: { quantity: { increment: 1 } },
          create: { userId, cardDefId: pulled.card.id, quantity: 1 },
        });
      }

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
