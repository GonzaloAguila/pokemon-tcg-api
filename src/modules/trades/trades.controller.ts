/**
 * Card trades over HTTP (the tables themselves are Socket.io: socket/trade-handlers.ts).
 *
 * GET  /api/trades/eligibility            { eligible, reason, config }
 * GET  /api/trades/tradable               my cards that can be given (with locks and points)
 * GET  /api/trades                        my trades (history)
 * POST /api/trades/deck-warnings          { cards } → my decks left short by giving them
 * GET  /api/admin/trades                  (users:view) ?page&limit&status&username&flagged
 * POST /api/admin/trades/:id/revert       (users:cards)
 * GET  /api/admin/card-values/sets        (users:economy) the sets
 * GET  /api/admin/card-values?set=id      (users:economy) every tradable card of a set and its points
 * PATCH /api/admin/card-values            (users:economy) { values: [{ cardDefId, points | null }] }
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { ADMIN_PERMISSIONS } from "../admin/permissions.js";
import { ECONOMY } from "../economy/config.js";
import * as tradesService from "./trades.service.js";
import { MAX_CARD_POINTS, listCardValueSets, listSetCardValues, setCardValues } from "./card-values.js";

const router = Router();

const cardList = z
  .array(z.object({ cardDefId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(ECONOMY.trades.maxCardsPerSide) }))
  .max(ECONOMY.trades.maxCardsPerSide);
const idSchema = z.string().uuid();

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "body";
  throw Errors.BadRequest(`Datos inválidos (${field}): ${issue?.message ?? "formato incorrecto"}`);
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

router.get(
  "/trades/eligibility",
  requireAuth,
  handle(async (req, res) => {
    const reason = await tradesService.tradeIneligibilityReason(req.user!.userId);
    const cfg = ECONOMY.trades;
    res.json({
      eligible: reason === null,
      reason,
      config: {
        feeCoins: cfg.feeCoins,
        maxCardsPerSide: cfg.maxCardsPerSide,
        minValueRatio: cfg.minValueRatio,
        lockDays: cfg.lockDays,
        maxTradesPerDay: cfg.maxTradesPerDay,
        minAccountAgeDays: cfg.minAccountAgeDays,
        minOnlineGames: cfg.minOnlineGames,
      },
    });
  }),
);

router.get(
  "/trades/tradable",
  requireAuth,
  handle(async (req, res) => {
    res.json({ cards: await tradesService.getTradableCards(req.user!.userId) });
  }),
);

router.get(
  "/trades",
  requireAuth,
  handle(async (req, res) => {
    res.json({ trades: await tradesService.listTrades(req.user!.userId) });
  }),
);

router.post(
  "/trades/deck-warnings",
  requireAuth,
  handle(async (req, res) => {
    const { cards } = parse(z.object({ cards: cardList }).strict(), req.body);
    res.json({ warnings: await tradesService.deckWarningsFor(req.user!.userId, cards) });
  }),
);

// -----------------------------------------------------------------------------
// Backoffice
// -----------------------------------------------------------------------------

const adminListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["completed", "reverted"]).optional(),
  username: z.string().trim().min(1).max(40).optional(),
  flagged: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

router.get(
  "/admin/trades",
  requireAuth,
  requirePermission(ADMIN_PERMISSIONS.USERS_VIEW),
  handle(async (req, res) => {
    res.json(await tradesService.adminListTrades(parse(adminListSchema, req.query)));
  }),
);

router.post(
  "/admin/trades/:id/revert",
  requireAuth,
  requirePermission(ADMIN_PERMISSIONS.USERS_EDIT_CARDS),
  handle(async (req, res) => {
    res.json(await tradesService.revertTrade(req.user!.userId, parse(idSchema, req.params.id)));
  }),
);

router.get(
  "/admin/card-values/sets",
  requireAuth,
  requirePermission(ADMIN_PERMISSIONS.USERS_EDIT_ECONOMY),
  handle(async (_req, res) => {
    res.json({ sets: listCardValueSets(), maxPoints: MAX_CARD_POINTS, defaults: ECONOMY.trades.valueByRarity });
  }),
);

router.get(
  "/admin/card-values",
  requireAuth,
  requirePermission(ADMIN_PERMISSIONS.USERS_EDIT_ECONOMY),
  handle(async (req, res) => {
    const setId = parse(z.string().min(1).max(40), req.query.set);
    res.json({ cards: listSetCardValues(setId) });
  }),
);

router.patch(
  "/admin/card-values",
  requireAuth,
  requirePermission(ADMIN_PERMISSIONS.USERS_EDIT_ECONOMY),
  handle(async (req, res) => {
    const { values } = parse(
      z
        .object({
          values: z
            .array(z.object({ cardDefId: z.string().min(1).max(80), points: z.number().int().min(1).max(MAX_CARD_POINTS).nullable() }))
            .min(1)
            .max(500),
        })
        .strict(),
      req.body,
    );
    await setCardValues(req.user!.userId, values);
    res.json({ ok: true });
  }),
);

export { router as tradesRouter };
