import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as matchesService from "./matches.service.js";

const router = Router();

const matchIdSchema = z.string().uuid();
const finishAiSchema = z.object({ result: z.enum(["victory", "defeat"]) });

// ---------------------------------------------------------------------------
// POST /matches/ai — A single-player game vs the AI starts. Returns { matchId }.
// ---------------------------------------------------------------------------

router.post(
  "/matches/ai",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await matchesService.startAiMatch(req.user!.userId));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /matches/ai/:matchId/finish — { result: "victory" | "defeat" }.
// The XP amount is decided here (never sent by the client); the game must have
// lasted a few minutes and only the first games of the day earn XP.
// ---------------------------------------------------------------------------

router.post(
  "/matches/ai/:matchId/finish",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const matchId = matchIdSchema.safeParse(req.params.matchId);
      if (!matchId.success) throw Errors.NotFound("Partida");
      const body = finishAiSchema.safeParse(req.body);
      if (!body.success) throw Errors.ValidationError("Resultado inválido");
      res.json(
        await matchesService.finishAiMatch(req.user!.userId, matchId.data, body.data.result === "victory"),
      );
    } catch (err) {
      next(err);
    }
  },
);

export { router as matchesRouter };
