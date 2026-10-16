import { Router, type Request, type Response, type NextFunction } from "express";
import * as presenceService from "./presence.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /presence — public: { online, registered } (homepage "Online 12/340")
// ---------------------------------------------------------------------------

router.get("/presence", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await presenceService.getPresenceSummary();
    res.set("Cache-Control", "no-store");
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

export { router as presenceRouter };
