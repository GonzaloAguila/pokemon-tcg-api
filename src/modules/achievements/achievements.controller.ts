import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import * as achievementsService from "./achievements.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /achievements/check — Check and update achievement progress
// ---------------------------------------------------------------------------

router.post(
  "/achievements/check",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const newlyClaimable = await achievementsService.checkAndUpdateProgress(req.user!.userId);
      res.json({ newlyClaimable });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /achievements/claim/:achievementId — Claim reward for a completed achievement
// ---------------------------------------------------------------------------

router.post(
  "/achievements/claim/:achievementId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await achievementsService.claimAchievement(
        req.user!.userId,
        req.params.achievementId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as achievementsRouter };
