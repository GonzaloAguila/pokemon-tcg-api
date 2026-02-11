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
      const newlyUnlocked = await achievementsService.checkAndUpdateProgress(req.user!.userId);
      res.json({ newlyUnlocked });
    } catch (err) {
      next(err);
    }
  },
);

export { router as achievementsRouter };
