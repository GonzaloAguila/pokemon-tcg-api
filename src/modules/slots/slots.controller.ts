import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import * as slotsService from "./slots.service.js";
import { refreshProgressInBackground } from "../achievements/achievements.service.js";

const router = Router();

// POST /slots/spin — Charge, roll the grid and grant the prize server-side.
router.post(
  "/slots/spin",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await slotsService.spinSlots(req.user!.userId);
      // A free pack was opened ("Primer Sobre")
      if (result.packResult) refreshProgressInBackground(req.user!.userId, "slots pack");
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as slotsRouter };
