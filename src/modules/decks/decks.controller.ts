/**
 * Deck Controller
 *
 * REST endpoints for user deck CRUD and slot purchases.
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import * as decksService from "./decks.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const deckCardSchema = z.object({
  cardDefId: z.string().min(1),
  quantity: z.number().int().min(1).max(60),
  variantId: z.string().optional(),
});

const createDeckSchema = z.object({
  name: z
    .string()
    .min(1, "El nombre del mazo es requerido")
    .max(30, "El nombre no puede exceder 30 caracteres"),
  cards: z.array(deckCardSchema),
});

const updateDeckSchema = z.object({
  name: z
    .string()
    .min(1, "El nombre del mazo es requerido")
    .max(30, "El nombre no puede exceder 30 caracteres")
    .optional(),
  cards: z.array(deckCardSchema).optional(),
});

// ---------------------------------------------------------------------------
// GET /me/decks — List all user decks
// ---------------------------------------------------------------------------

router.get(
  "/me/decks",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const decks = await decksService.getUserDecks(req.user!.userId);
      res.json(decks);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me/decks/:deckId — Get a specific deck
// ---------------------------------------------------------------------------

router.get(
  "/me/decks/:deckId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deck = await decksService.getDeckById(
        req.user!.userId,
        req.params.deckId,
      );
      res.json(deck);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/decks — Create a new deck
// ---------------------------------------------------------------------------

router.post(
  "/me/decks",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createDeckSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const deck = await decksService.createDeck(
        req.user!.userId,
        parsed.data,
      );
      res.status(201).json(deck);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /me/decks/:deckId — Update a deck
// ---------------------------------------------------------------------------

router.patch(
  "/me/decks/:deckId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateDeckSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const deck = await decksService.updateDeck(
        req.user!.userId,
        req.params.deckId,
        parsed.data,
      );
      res.json(deck);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /me/decks/:deckId — Delete a deck
// ---------------------------------------------------------------------------

router.delete(
  "/me/decks/:deckId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await decksService.deleteDeck(req.user!.userId, req.params.deckId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/decks/:deckId/activate — Set a deck as active
// ---------------------------------------------------------------------------

router.post(
  "/me/decks/:deckId/activate",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deck = await decksService.setActiveDeck(
        req.user!.userId,
        req.params.deckId,
      );
      res.json(deck);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/deck-slots/purchase — Buy an extra deck slot
// ---------------------------------------------------------------------------

router.post(
  "/me/deck-slots/purchase",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await decksService.purchaseDeckSlot(req.user!.userId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export const decksRouter = router;
