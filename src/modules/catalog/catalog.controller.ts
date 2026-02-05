/**
 * Catalog Controller
 *
 * REST endpoints for card sets, individual cards, and theme decks.
 */

import { Router, type Request, type Response } from "express";
import { AppError } from "../../middleware/error-handler.js";
import * as catalogService from "./catalog.service.js";

const router = Router();

// =============================================================================
// Sets Endpoints
// =============================================================================

/**
 * GET /api/sets
 * List all available card sets
 */
router.get("/sets", (_req: Request, res: Response) => {
  const sets = catalogService.getAllSets();
  res.json({ sets });
});

/**
 * GET /api/sets/:setId
 * Get set metadata
 */
router.get("/sets/:setId", (req: Request, res: Response) => {
  const { setId } = req.params;
  const set = catalogService.getSetById(setId);

  if (!set) {
    throw new AppError(`Set '${setId}' not found`, 404);
  }

  res.json(set);
});

/**
 * GET /api/sets/:setId/cards
 * Get all cards in a set
 * Query params: kind, type, rarity, stage, search
 */
router.get("/sets/:setId/cards", (req: Request, res: Response) => {
  const { setId } = req.params;
  const { kind, type, rarity, stage, search } = req.query;

  const set = catalogService.getSetById(setId);
  if (!set) {
    throw new AppError(`Set '${setId}' not found`, 404);
  }

  let cards;

  if (search && typeof search === "string") {
    cards = catalogService.searchCards(search, setId);
  } else if (kind || type || rarity || stage) {
    cards = catalogService.filterCards(setId, {
      kind: kind as any,
      type: type as string,
      rarity: rarity as string,
      stage: stage as string,
    });
  } else {
    cards = catalogService.getCardsBySet(setId);
  }

  res.json({
    setId,
    total: cards.length,
    cards,
  });
});

// =============================================================================
// Cards Endpoints
// =============================================================================

/**
 * GET /api/cards/:cardId
 * Get a single card by ID
 */
router.get("/cards/:cardId", (req: Request, res: Response) => {
  const { cardId } = req.params;
  const card = catalogService.getCardById(cardId);

  if (!card) {
    throw new AppError(`Card '${cardId}' not found`, 404);
  }

  res.json(card);
});

/**
 * GET /api/cards/:cardId/image
 * Get image URL for a card
 */
router.get("/cards/:cardId/image", (req: Request, res: Response) => {
  const { cardId } = req.params;
  const card = catalogService.getCardById(cardId);

  if (!card) {
    throw new AppError(`Card '${cardId}' not found`, 404);
  }

  const imageUrl = catalogService.getCardImageUrl(card);
  res.json({ cardId, imageUrl });
});

// =============================================================================
// Decks Endpoints
// =============================================================================

/**
 * GET /api/decks
 * List all theme decks
 */
router.get("/decks", (_req: Request, res: Response) => {
  const decks = catalogService.getAllDecks();
  res.json({ decks });
});

/**
 * GET /api/decks/:deckId
 * Get deck info (card numbers only, not resolved)
 */
router.get("/decks/:deckId", (req: Request, res: Response) => {
  const { deckId } = req.params;
  const deck = catalogService.getDeck(deckId);

  if (!deck) {
    throw new AppError(`Deck '${deckId}' not found`, 404);
  }

  res.json(deck);
});

/**
 * GET /api/decks/:deckId/resolved
 * Get deck with full card objects (for gameplay)
 */
router.get("/decks/:deckId/resolved", (req: Request, res: Response) => {
  const { deckId } = req.params;
  const resolved = catalogService.getDeckResolved(deckId);

  if (!resolved) {
    throw new AppError(`Deck '${deckId}' not found`, 404);
  }

  res.json(resolved);
});

export const catalogRouter = router;
