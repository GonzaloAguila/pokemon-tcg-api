/**
 * Battle Pass Controller
 *
 * REST endpoints for battle pass listing, enrollment, upgrade, and reward claims.
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { requireAuth, optionalAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as battlePassService from "./battle-pass.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const claimRewardSchema = z.object({
  track: z.enum(["standard", "premium"]),
});

// ---------------------------------------------------------------------------
// GET /battle-pass — List available passes
// ---------------------------------------------------------------------------

router.get(
  "/battle-pass",
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const passes = await battlePassService.getAvailablePasses(
        req.user?.userId,
      );
      res.json({ passes });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /battle-pass/:id — Pass details with user progress
// ---------------------------------------------------------------------------

router.get(
  "/battle-pass/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await battlePassService.getPassWithProgress(
        req.params.id,
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /battle-pass/:id/activate — Enroll (free)
// ---------------------------------------------------------------------------

router.post(
  "/battle-pass/:id/activate",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await battlePassService.activatePass(
        req.params.id,
        req.user!.userId,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /battle-pass/:id/upgrade — Buy premium track
// ---------------------------------------------------------------------------

router.post(
  "/battle-pass/:id/upgrade",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await battlePassService.upgradeToPremium(
        req.params.id,
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /battle-pass/:id/claim/:day — Claim reward
// ---------------------------------------------------------------------------

router.post(
  "/battle-pass/:id/claim/:day",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const day = parseInt(req.params.day, 10);
      if (isNaN(day) || day < 1) {
        throw Errors.BadRequest("Dia invalido");
      }

      const parsed = claimRewardSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError("Track requerido: standard o premium");
      }

      const result = await battlePassService.claimReward(
        req.params.id,
        req.user!.userId,
        day,
        parsed.data.track,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export const battlePassRouter = router;
