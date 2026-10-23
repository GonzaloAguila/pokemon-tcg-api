/**
 * Gym Leaders over REST (docs/gym-leaders.md).
 *
 * Public (no auth):
 *   GET    /api/gyms                                  → { leaders } every leader in content (rules, rewards, entry cost), open or not
 *
 * Backoffice: see every table (leader × version), open / close one on demand (the scheduler ships
 * disabled), edit the decks the leaders play. Permission `users:economy` (a gym hands out medals
 * and coins); the superadmin always passes.
 *   GET    /api/admin/gyms                            → { gyms: GymAdminStatus[] } one row per leader and version
 *   POST   /api/admin/gyms/:leaderId/open             { mode?, minutes?: 1–1440, default 45 } → { gym }
 *   POST   /api/admin/gyms/:leaderId/close            { mode? } → { gym } (no new challengers; a battle on ends normally)
 *   GET    /api/admin/gyms/:leaderId/decks/:mode      → { cards, isDefault, updatedAt }
 *   PUT    /api/admin/gyms/:leaderId/decks/:mode      { cards: { cardId, qty }[] } (60 cards) → same
 *   DELETE /api/admin/gyms/:leaderId/decks/:mode      → same (the content default)
 * `mode` missing = "normal".
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { ADMIN_PERMISSIONS } from "../admin/permissions.js";
import { getGymLeader, GYM_LEADERS, GYM_MODES, leaderModes, leaderRewards, leaderRules, type GymLeaderDef, type GymMode } from "./content/index.js";
import { GYM_BEST_OF, GYM_TIMING } from "./gym.config.js";
import { gymService, type GymAdminStatus } from "./gym.service.js";
import { getLeaderDeck, resetLeaderDeck, saveLeaderDeck, savedDeckDates } from "./gym-decks.js";
import { publicGymRules } from "./rules.js";

const router = Router();

const modeField = z.enum(GYM_MODES).nullish().transform((v) => v ?? "normal");

const openBody = z
  .object({ mode: modeField, minutes: z.number().int().min(1).max(GYM_TIMING.maxOpenMinutes).optional() })
  .nullish()
  .transform((v) => ({ mode: v?.mode ?? ("normal" as GymMode), minutes: v?.minutes }));

const closeBody = z
  .object({ mode: modeField })
  .nullish()
  .transform((v) => ({ mode: v?.mode ?? ("normal" as GymMode) }));

const deckBody = z.object({
  cards: z
    .array(
      z.object({
        cardId: z.string().min(1).max(100),
        qty: z.number().int().positive().max(60),
      }),
    )
    .min(1)
    .max(60),
});

/** The leader of the route, or 404. */
function leaderParam(req: Request): GymLeaderDef {
  const leader = getGymLeader(String(req.params.leaderId));
  if (!leader) throw Errors.NotFound("Gimnasio");
  return leader;
}

/** A version the leader has (route or body), else 404 / 400. */
function modeOf(leader: GymLeaderDef, raw: unknown): GymMode {
  const parsed = z.enum(GYM_MODES).safeParse(raw);
  if (!parsed.success) throw Errors.BadRequest("mode: normal o expert");
  if (!leaderModes(leader).includes(parsed.data)) throw Errors.NotFound("Versión del gimnasio");
  return parsed.data;
}

/** Admin rows with whether each version plays a saved deck. */
async function withDecks(gyms: GymAdminStatus[]) {
  const saved = await savedDeckDates();
  return gyms.map((g) => {
    const updatedAt = saved.get(`${g.leaderId}:${g.mode}`);
    return { ...g, deck: { isDefault: !updatedAt, updatedAt: updatedAt?.toISOString() ?? null } };
  });
}

// ---------------------------------------------------------------------------
// Public catalog
// ---------------------------------------------------------------------------

router.get("/gyms", (_req: Request, res: Response) => {
  res.json({
    leaders: GYM_LEADERS.map((leader) => ({
      leaderId: leader.id,
      name: leader.name,
      title: leader.title,
      avatarId: leader.avatarId,
      medalId: leader.medalId,
      entryCost: leader.entryCost,
      attemptsPerDay: leader.attemptsPerDay,
      bestOf: GYM_BEST_OF,
      modes: leaderModes(leader).map((mode) => ({
        mode,
        rules: publicGymRules(leaderRules(leader, mode)!),
        rewards: { ...leaderRewards(leader, mode)! },
      })),
    })),
  });
});

// ---------------------------------------------------------------------------
// Backoffice
// ---------------------------------------------------------------------------

const guard = [requireAuth, requirePermission(ADMIN_PERMISSIONS.USERS_EDIT_ECONOMY)];

router.get("/admin/gyms", ...guard, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ gyms: await withDecks(gymService.adminStatus()) });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/gyms/:leaderId/open", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leader = leaderParam(req);
    const body = openBody.safeParse(req.body);
    if (!body.success) throw Errors.BadRequest(`mode: normal o expert; minutes: entre 1 y ${GYM_TIMING.maxOpenMinutes}`);
    const mode = modeOf(leader, body.data.mode);
    const minutes = body.data.minutes ?? GYM_TIMING.defaultOpenMinutes;
    const gym = gymService.open(leader.id, mode, minutes);
    console.log(`[admin] ${req.user!.userId} opened the ${leader.id} ${mode} gym for ${minutes} min`);
    res.json({ gym: (await withDecks([gym]))[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/gyms/:leaderId/close", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leader = leaderParam(req);
    const body = closeBody.safeParse(req.body);
    if (!body.success) throw Errors.BadRequest("mode: normal o expert");
    const mode = modeOf(leader, body.data.mode);
    const gym = gymService.close(leader.id, mode);
    console.log(`[admin] ${req.user!.userId} closed the ${leader.id} ${mode} gym`);
    res.json({ gym: (await withDecks([gym]))[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/gyms/:leaderId/decks/:mode", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leader = leaderParam(req);
    res.json(await getLeaderDeck(leader, modeOf(leader, req.params.mode)));
  } catch (error) {
    next(error);
  }
});

router.put("/admin/gyms/:leaderId/decks/:mode", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leader = leaderParam(req);
    const mode = modeOf(leader, req.params.mode);
    const body = deckBody.safeParse(req.body);
    if (!body.success) throw Errors.BadRequest("cards: una lista de { cardId, qty } con cantidades enteras positivas");
    const deck = await saveLeaderDeck(leader, mode, body.data.cards, req.user!.userId);
    console.log(`[admin] ${req.user!.userId} saved the ${leader.id} ${mode} deck`);
    res.json(deck);
  } catch (error) {
    next(error);
  }
});

router.delete("/admin/gyms/:leaderId/decks/:mode", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leader = leaderParam(req);
    const mode = modeOf(leader, req.params.mode);
    const deck = await resetLeaderDeck(leader, mode);
    console.log(`[admin] ${req.user!.userId} restored the ${leader.id} ${mode} default deck`);
    res.json(deck);
  } catch (error) {
    next(error);
  }
});

export const gymAdminRouter = router;
