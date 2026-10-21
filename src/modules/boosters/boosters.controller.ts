/**
 * Booster Pack Controller
 *
 * REST endpoints for pack types (read-only: the definitions are code in boosters.service.ts) and
 * opening packs.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { AppError, Errors } from "../../middleware/error-handler.js";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import * as boosterService from "./boosters.service.js";
import * as usersService from "../users/users.service.js";
import type { PackOpeningResult } from "./boosters.types.js";

const router = Router();

/** Most packs one request may open (one charge for all of them). */
export const MAX_PACKS_PER_OPEN = 10;

const openPacksSchema = z.object({
  quantity: z.number().int().min(1).max(MAX_PACKS_PER_OPEN).default(1),
});

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
 * Body (optional): { quantity?: integer 1-10 } (default 1).
 * Open `quantity` packs — requires auth, charges price × quantity in ONE transaction (all or
 * nothing), persists the cards. Response: the first pack's fields (backward compatible) plus
 * `packs` (every opened pack, same shape).
 */
router.post(
  "/packs/:packId/open",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    const { packId } = req.params;
    const userId = req.user!.userId;

    const parsed = openPacksSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(Errors.BadRequest(`La cantidad de sobres debe ser un entero entre 1 y ${MAX_PACKS_PER_OPEN}`));
    }
    const { quantity } = parsed.data;

    const pack = boosterService.getPackById(packId);
    if (!pack) {
      return next(new AppError(`Pack '${packId}' not found`, 404));
    }

    const total = (pack.price ?? 0) * quantity;

    try {
      // Charge and persist in one transaction: no coins lost without cards, no cards without paying
      const packs = await prisma.$transaction(async (tx) => {
        if (total > 0) {
          await usersService.spendCoins(
            userId,
            total,
            "pack_purchase",
            quantity === 1 ? `Apertura de sobre: ${pack.name}` : `Apertura de ${quantity} sobres: ${pack.name}`,
            tx,
          );
        }
        const opened: PackOpeningResult[] = [];
        for (let i = 0; i < quantity; i++) {
          opened.push(await boosterService.openPackForUser(tx, userId, packId, { reason: "pack_purchase", label: "Sobre comprado" }));
        }
        return opened;
      }, { timeout: 20_000, maxWait: 5_000 }); // up to 10 packs: ~120 queries, Prisma's default 5 s isn't enough under load

      res.json({ ...packs[0], packs });
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
