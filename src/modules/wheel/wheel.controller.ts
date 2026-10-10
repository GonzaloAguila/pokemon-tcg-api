import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import * as wheelService from "./wheel.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /wheel/spin — Charge (or use a free spin), roll and grant the prize.
// The client only animates to the returned segmentId.
// ---------------------------------------------------------------------------

router.post(
  "/wheel/spin",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await wheelService.spinWheel(req.user!.userId);
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
