import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import * as wheelService from "./wheel.service.js";
import { refreshProgressInBackground } from "../achievements/achievements.service.js";
import { prizeGivesCards } from "../prizes/prizes.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /wheel/spin — Charge (or use a free spin), roll and grant the prize.
// The client only animates to the returned segmentId.
// ---------------------------------------------------------------------------

router.post(
  "/wheel/spin",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await wheelService.spinWheel(req.user!.userId);
      // A free pack was opened ("Primer Sobre"), or a card won ("Holo Completo")
      if (result.packResult || prizeGivesCards(result.prize)) refreshProgressInBackground(req.user!.userId, "wheel prize");
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /wheel/claim was removed: prizes are rolled and granted by /wheel/spin.
router.post("/wheel/claim", (_req: Request, res: Response) => {
  res.status(410).json({
    error: { message: "Endpoint retirado: el premio se entrega en /wheel/spin", code: "GONE" },
  });
});

export { router as wheelRouter };
