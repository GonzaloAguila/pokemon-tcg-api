import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as wheelService from "./wheel.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// Prize schema — mirrors frontend ResolvedPrize (only fields we need)
// ---------------------------------------------------------------------------

const prizeSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("coins"), amount: z.number() }),
    z.object({ type: z.literal("card"), cardDefId: z.string() }),
    z.object({ type: z.literal("overlay"), skinId: z.string() }),
    z.object({ type: z.literal("card_back"), cardBackId: z.string() }),
    z.object({ type: z.literal("collectible_coin"), coinId: z.string() }),
    z.object({ type: z.literal("avatar"), avatarId: z.string() }),
    z.object({ type: z.literal("playmat"), playmatId: z.string() }),
    z.object({ type: z.literal("free_pack") }),
    z.object({ type: z.literal("spin_again"), bonusCoins: z.number() }),
    z.object({
      type: z.literal("jackpot"),
      prizes: z.array(prizeSchema),
    }),
    z.object({ type: z.literal("nothing") }),
  ]),
);

const claimSchema = z.object({ prize: prizeSchema });

// ---------------------------------------------------------------------------
// POST /wheel/spin — Pay for a wheel spin (deduct coins)
// ---------------------------------------------------------------------------

router.post(
  "/wheel/spin",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await wheelService.payWheelSpin(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /wheel/claim — Persist a wheel prize to the user's collection
// ---------------------------------------------------------------------------

router.post(
  "/wheel/claim",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const result = await wheelService.claimWheelPrize(
        req.user!.userId,
        parsed.data.prize,
      );

      res.json({
        success: true,
        ...(result.packResult && { packResult: result.packResult }),
      });
    } catch (err) {
      next(err);
    }
  },
);

export const wheelRouter = router;
