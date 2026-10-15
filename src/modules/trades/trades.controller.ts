/**
 * Card trades (see trades.service.ts).
 *
 * GET  /api/trades/eligibility          { eligible, reason, config }
 * GET  /api/trades/tradable             my cards that can be given (with locks)
 * GET  /api/trades/tradable/:username   a player's cards that can be asked for
 * GET  /api/trades?box=incoming|outgoing|history
 * GET  /api/trades/:id                  with deckWarnings for the viewer
 * POST /api/trades                      { toUsername, offered: [{ cardDefId, quantity }], requested }
 * POST /api/trades/:id/accept | /reject | /cancel
 * GET  /api/admin/trades                (users:view) ?page&limit&status&username&flagged
 * POST /api/admin/trades/:id/revert     (users:cards)
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { ADMIN_PERMISSIONS } from "../admin/permissions.js";
import { ECONOMY } from "../economy/config.js";
import * as tradesService from "./trades.service.js";

const router = Router();

const cardList = z
  .array(z.object({ cardDefId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(ECONOMY.trades.maxCardsPerSide) }))
  .max(ECONOMY.trades.maxCardsPerSide);

const createSchema = z
  .object({
    toUsername: z.string().trim().min(1).max(40),
    offered: cardList,
    requested: cardList,
  })
  .strict();

const boxSchema = z.enum(["incoming", "outgoing", "history"]);
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
        valueByRarity: cfg.valueByRarity,
        minValueRatio: cfg.minValueRatio,
        lockDays: cfg.lockDays,
        offerHours: cfg.offerHours,
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
  "/trades/tradable/:username",
  requireAuth,
  handle(async (req, res) => {
    res.json(await tradesService.getTradableCardsOf(parse(z.string().trim().min(1).max(40), req.params.username)));
  }),
);

router.get(
  "/trades",
  requireAuth,
  handle(async (req, res) => {
    const box = parse(boxSchema, req.query.box ?? "incoming");
    res.json({ trades: await tradesService.listTrades(req.user!.userId, box) });
  }),
);

router.get(
  "/trades/:id",
  requireAuth,
  handle(async (req, res) => {
    res.json(await tradesService.getTrade(req.user!.userId, parse(idSchema, req.params.id)));
  }),
);

router.post(
  "/trades",
  requireAuth,
  handle(async (req, res) => {
    const input = parse(createSchema, req.body);
    res.status(201).json(await tradesService.createTrade(req.user!.userId, input, req.ip ?? null));
  }),
);

router.post(
  "/trades/:id/accept",
  requireAuth,
  handle(async (req, res) => {
    res.json(await tradesService.acceptTrade(req.user!.userId, parse(idSchema, req.params.id), req.ip ?? null));
  }),
);

router.post(
  "/trades/:id/reject",
  requireAuth,
  handle(async (req, res) => {
    res.json(await tradesService.closeTrade(req.user!.userId, parse(idSchema, req.params.id), "reject"));
  }),
);

router.post(
  "/trades/:id/cancel",
  requireAuth,
  handle(async (req, res) => {
    res.json(await tradesService.closeTrade(req.user!.userId, parse(idSchema, req.params.id), "cancel"));
  }),
);

// -----------------------------------------------------------------------------
// Backoffice
// -----------------------------------------------------------------------------

const adminListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["pending", "completed", "rejected", "cancelled", "expired", "reverted"]).optional(),
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

export { router as tradesRouter };
