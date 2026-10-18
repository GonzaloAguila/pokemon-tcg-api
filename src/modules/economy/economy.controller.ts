import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { CARD_SETS } from "@gonzaloaguila/game-core";
import { requireAuth, requireVerifiedEmail } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { STANDARD_BOOSTER_IDS } from "../boosters/boosters.service.js";
import { ECONOMY } from "./config.js";
import * as economyService from "./economy.service.js";
import { listUnopenedPacks, openOwnedPack } from "./pack-inventory.js";
import { getOdds } from "./odds.js";

const router = Router();

const packIdSchema = z.string().min(1).max(64);
const dailyPackSchema = z.object({ packId: packIdSchema });
const openOwnedSchema = z.object({ packId: packIdSchema.optional() }).default({});
const exchangeSchema = z.object({ cardDefId: z.string().min(1).max(100) });
const milestoneSchema = z.object({
  setId: z.string().min(1).max(64),
  percent: z.number().int().positive().max(100),
});
const uuidSchema = z.string().uuid();

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw Errors.ValidationError(parsed.error.errors.map((e) => `${e.path.join(".") || "body"}: ${e.message}`).join(". "));
  }
  return parsed.data;
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    next(err);
  }
};

/** JSON view of ECONOMY (the numbers the UI shows). */
function publicConfig() {
  const cfg = ECONOMY;
  return {
    timeZone: cfg.timeZone,
    resetHourLocal: 0,
    weekStartsOn: "monday",
    welcome: cfg.welcome,
    dailyPack: cfg.dailyPack,
    firstSteps: cfg.firstSteps,
    loginCalendar: cfg.loginCalendar,
    missions: cfg.missions,
    matchCoins: cfg.matchCoins,
    antiFarming: cfg.antiFarming,
    battlePass: {
      maxSteps: cfg.battlePass.maxSteps,
      premiumPriceRareCandy: cfg.battlePass.premiumPriceRareCandy,
      standardCoinsPerStep: cfg.battlePass.standardCoinsPerStep,
      standardPackSteps: cfg.battlePass.standardPackSteps,
      premium: cfg.battlePass.premium,
    },
    setMilestones: {
      tiers: cfg.setMilestones.tiers,
      sets: CARD_SETS.map((set) => ({
        setId: set.id,
        cardBackId: cfg.setMilestones.cardBackId(set.id),
        titleMedalId: cfg.setMilestones.titleMedalId(set.id),
        holoVariantSkinId: cfg.setMilestones.holoVariantBySet[set.id] ?? null,
      })),
      collectorMedalId: cfg.setMilestones.collectorMedalId,
    },
    exchangeTokens: cfg.exchangeTokens,
    market: cfg.market,
    packs: { price: cfg.packs.price, boosterIds: STANDARD_BOOSTER_IDS },
    rareCandy: cfg.rareCandy,
    tableBets: cfg.tableBets,
    progress: cfg.progress,
    luckyDuelAi: {
      stake: cfg.luckyDuelAi.stake,
      streakBonusEvery: cfg.luckyDuelAi.streakBonusEvery,
      streakBonus: cfg.luckyDuelAi.streakBonus,
      dailyStakedGames: cfg.luckyDuelAi.dailyStakedGames,
    },
  };
}

// Public
router.get("/economy/config", wrap(() => publicConfig()));
router.get("/economy/odds", wrap(() => getOdds()));

// Status and daily. Check-in stays open to unverified accounts (it is called on every app load)
// but grants them nothing and doesn't use up the day (economyService.checkIn); every route that
// grants or spends goes through requireVerifiedEmail (403 EMAIL_NOT_VERIFIED).
router.get("/economy/status", requireAuth, wrap((req) => economyService.getEconomyStatus(req.user!.userId)));
router.post("/economy/check-in", requireAuth, wrap((req) => economyService.checkIn(req.user!.userId)));
router.post(
  "/economy/daily-pack",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => economyService.claimDailyPack(req.user!.userId, parseBody(dailyPackSchema, req.body).packId)),
);

// Pack inventory
router.get("/economy/packs", requireAuth, wrap(async (req) => ({ packs: await listUnopenedPacks(req.user!.userId) })));
router.post(
  "/economy/packs/:userPackId/open",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => {
    const id = uuidSchema.safeParse(req.params.userPackId);
    if (!id.success) throw Errors.NotFound("Sobre");
    return openOwnedPack(req.user!.userId, id.data, parseBody(openOwnedSchema, req.body).packId);
  }),
);

// Fichas de canje
router.post(
  "/economy/exchange",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => economyService.redeemExchangeToken(req.user!.userId, parseBody(exchangeSchema, req.body).cardDefId)),
);

// Set milestones
router.get("/economy/milestones", requireAuth, wrap((req) => economyService.getSetMilestones(req.user!.userId)));
router.post(
  "/economy/milestones/claim",
  requireAuth,
  requireVerifiedEmail,
  wrap((req) => {
    const { setId, percent } = parseBody(milestoneSchema, req.body);
    return economyService.claimSetMilestone(req.user!.userId, setId, percent);
  }),
);

export { router as economyRouter };
