import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import * as marketService from "./market.service.js";

const router = Router();

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cardDefId } = req.body;
      if (!cardDefId) {
        return res.status(400).json({ error: "cardDefId es requerido" });
      }
      const result = await marketService.buyDailyCard(req.user!.userId, cardDefId);
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, itemId } = req.body;
      if (!type || !itemId) {
        return res.status(400).json({ error: "type e itemId son requeridos" });
      }
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { energyType, quantity = 1 } = req.body;
      if (!energyType) {
        return res.status(400).json({ error: "energyType es requerido" });
      }
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { target } = req.body;
      if (target !== "coins" && target !== "coupons") {
        return res.status(400).json({ error: 'target debe ser "coins" o "coupons"' });
      }
      const result = await marketService.convertRareCandy(req.user!.userId, target);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as marketRouter };
