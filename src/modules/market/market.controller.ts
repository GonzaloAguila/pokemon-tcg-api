import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as marketService from "./market.service.js";
import { refreshProgressInBackground } from "../achievements/achievements.service.js";

const router = Router();

const buyCardSchema = z.object({ cardDefId: z.string().min(1).max(100) });
const buyCosmeticSchema = z.object({
  type: z.enum(["coin", "cardBack", "avatar", "variant", "playmat", "emote"]),
  itemId: z.string().min(1).max(100),
});
const buyEnergySchema = z.object({
  energyType: z.string().min(1).max(30),
  quantity: z.number().int().min(1).max(marketService.MAX_ENERGY_PER_PURCHASE).default(1),
});
const convertCandySchema = z.object({ target: z.enum(["coins", "coupons"]) });

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw Errors.ValidationError(parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(". "));
  }
  return parsed.data;
}

// GET /market/daily-offers
router.get(
  "/market/daily-offers",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const offers = await marketService.getDailyOffers(req.user!.userId);
      res.json(offers);
    } catch (err) {
      next(err);
    }
  },
);

// POST /market/buy-card
router.post(
  "/market/buy-card",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cardDefId } = parseBody(buyCardSchema, req.body);
      const result = await marketService.buyDailyCard(req.user!.userId, cardDefId);
      // A new card can complete a collection achievement ("Holo Completo")
      refreshProgressInBackground(req.user!.userId, "card purchase");
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /market/buy-cosmetic
router.post(
  "/market/buy-cosmetic",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, itemId } = parseBody(buyCosmeticSchema, req.body);
      const result = await marketService.buyCosmetic(req.user!.userId, type, itemId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /market/buy-energy
router.post(
  "/market/buy-energy",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { energyType, quantity } = parseBody(buyEnergySchema, req.body);
      const result = await marketService.buyEnergy(req.user!.userId, energyType, quantity);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /market/convert-candy
router.post(
  "/market/convert-candy",
  requireAuth,
  requireVerifiedEmail,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { target } = parseBody(convertCandySchema, req.body);
      const result = await marketService.convertRareCandy(req.user!.userId, target);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as marketRouter };
