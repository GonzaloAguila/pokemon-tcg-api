/**
 * Battle Pass Controller
 *
 * REST endpoints for the calendar-based monthly battle pass.
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { requireAuth, requireVerifiedEmail, optionalAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as battlePassService from "./battle-pass.service.js";
import { refreshProgressInBackground } from "../achievements/achievements.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const claimRewardSchema = z.object({
  track: z.enum(["standard", "premium"]),
});

const stepSchema = z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(31));

// ---------------------------------------------------------------------------
// GET /battle-pass/current — Current month's pass with auto-enrollment
// ---------------------------------------------------------------------------

router.get(
  "/battle-pass/current",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await battlePassService.getCurrentPassWithProgress(
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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
// POST /battle-pass/:id/upgrade — Buy premium track
// ---------------------------------------------------------------------------

router.post(
  "/battle-pass/:id/upgrade",
  requireAuth,
  requireVerifiedEmail,
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
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // `day` is the step number (1..30)
      const stepParsed = stepSchema.safeParse(req.params.day);
      if (!stepParsed.success) {
        throw Errors.BadRequest("Paso inválido");
      }
      const day = stepParsed.data;

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
      // An unowned holo can complete "Holo Completo"
      if (result.granted.type === "card") refreshProgressInBackground(req.user!.userId, "battle pass card");
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export const battlePassRouter = router;
