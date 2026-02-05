/**
 * Booster Pack Controller
 *
 * REST endpoints for pack types, opening packs, and daily limits.
 */

import { Router, type Request, type Response } from "express";
import { AppError } from "../../middleware/error-handler.js";
import * as boosterService from "./boosters.service.js";
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
// Pack Opening
// =============================================================================

/**
 * POST /api/packs/:packId/open
 * Open a pack and get random cards
 * Body: { userId: string }
 */
router.post("/packs/:packId/open", (req: Request, res: Response) => {
  const { packId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    throw new AppError("userId is required", 400);
  }

  const pack = boosterService.getPackById(packId);
  if (!pack) {
    throw new AppError(`Pack '${packId}' not found`, 404);
  }

  try {
    const result = boosterService.openPackWithLimit(packId, userId);
    const limitStatus = boosterService.getDailyLimitStatus(userId);

    res.json({
      ...result,
      dailyLimit: {
        packsOpened: limitStatus.packsOpened,
        packsRemaining: limitStatus.packsRemaining,
        dailyLimit: limitStatus.dailyLimit,
      },
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("Daily pack limit")) {
      throw new AppError(message, 429);
    }
    throw new AppError(message, 400);
  }
});

/**
 * POST /api/packs/:packId/preview
 * Preview pack opening without using daily limit (for testing/demo)
 */
router.post("/packs/:packId/preview", (req: Request, res: Response) => {
  const { packId } = req.params;

  const pack = boosterService.getPackById(packId);
  if (!pack) {
    throw new AppError(`Pack '${packId}' not found`, 404);
  }

  try {
    const result = boosterService.openPack(packId);
    res.json({ ...result, isPreview: true });
  } catch (error) {
    throw new AppError((error as Error).message, 400);
  }
});

// =============================================================================
// Daily Limits
// =============================================================================

/**
 * GET /api/packs/daily-limit/:userId
 * Check daily limit status for a user
 */
router.get("/packs/daily-limit/:userId", (req: Request, res: Response) => {
  const { userId } = req.params;
  const status = boosterService.getDailyLimitStatus(userId);
  res.json(status);
});

export const boostersRouter = router;
