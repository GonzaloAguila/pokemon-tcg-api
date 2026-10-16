import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import * as progressService from "./progress.service.js";

const router = Router();

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    next(err);
  }
};

// Ids are checked against the catalog (unknown → 404); no request body.
router.get("/progress", requireAuth, wrap((req) => progressService.getProgress(req.user!.userId)));

// Before "/progress/tutorial/:lessonId" so "claim" is never read as a lesson id.
router.post(
  "/progress/tutorial/claim",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => progressService.claimTutorialReward(req.user!.userId)),
);
router.post(
  "/progress/tutorial/:lessonId",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => progressService.completeTutorialLesson(req.user!.userId, req.params.lessonId)),
);
router.post(
  "/progress/puzzles/:puzzleId",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => progressService.completePuzzle(req.user!.userId, req.params.puzzleId)),
);

export { router as progressRouter };
