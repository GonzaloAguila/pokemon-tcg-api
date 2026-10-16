/**
 * Public player profiles (signed-in players only, like the leaderboard).
 *
 * GET /api/players/:username             profile: record, medals, achievements, collection per set, variants, cosmetics
 * GET /api/players/:username/collection  { username, cards: [{ cardDefId, quantity }] }
 *
 * Banned and unknown players are 404. The username match is case-insensitive.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { playerProfileRateLimiter } from "../../middleware/rate-limit.js";
import * as playersService from "./players.service.js";

const router = Router();

router.get(
  "/players/:username",
  playerProfileRateLimiter,
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await playersService.getPublicProfile(req.params.username));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/players/:username/collection",
  playerProfileRateLimiter,
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await playersService.getPublicCollection(req.params.username));
    } catch (err) {
      next(err);
    }
  },
);

export { router as playersRouter };
