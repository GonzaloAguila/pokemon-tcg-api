import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as matchesService from "./matches.service.js";

const router = Router();

const matchIdSchema = z.string().uuid();
// turnNumber: last turn the game reached (a game counts from turn 3, like multiplayer)
// result "draw": a Lucky Duel that ended with both Actives Knocked Out (no winner, the loser's
// rewards). mode (optional, default standard) is recorded on the match row.
const finishAiSchema = z.object({
  result: z.enum(["victory", "defeat", "draw"]),
  turnNumber: z.number().int().min(0).max(10_000),
  mode: z.enum(["standard", "lucky-duel"]).optional(),
});

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
// POST /matches/ai/:matchId/finish — { result: "victory" | "defeat" | "draw", turnNumber, mode? }.
// XP, coins and missions are decided here (never sent by the client); the game must have
// reached turn 3, lasted a few minutes, and only the first games of the day count.
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
        await matchesService.finishAiMatch(req.user!.userId, matchId.data, body.data.result, body.data.turnNumber, new Date(), body.data.mode),
      );
    } catch (err) {
      next(err);
    }
  },
);

export { router as matchesRouter };
