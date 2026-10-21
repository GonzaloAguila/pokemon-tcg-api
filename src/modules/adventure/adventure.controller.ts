import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { DIFFICULTIES } from "./content/schema.js";
import * as adventureService from "./adventure.service.js";

// Playing needs no verified email (owner Q11): achievements already require it to be claimed,
// and the unique reward is cosmetic.
const router = Router();

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(status).json(await fn(req, res));
  } catch (err) {
    next(err);
  }
};

const slug = z.string().min(1).max(64);
const cardId = z.string().min(1).max(100);
const MAX_DECK_LINES = 60;

const createRunSchema = z.object({ adventureId: slug, difficulty: z.enum(DIFFICULTIES), starterId: slug });
const deckEditSchema = z.object({
  remove: z.array(z.object({ cardId, qty: z.number().int().positive().max(60) })).max(MAX_DECK_LINES),
  // Target counts of basic Energy cards (0 takes the type out)
  energies: z.array(z.object({ cardId, qty: z.number().int().min(0).max(60) })).max(10),
});
const treasureSchema = z.union([
  z.object({ treasureId: slug }).strict(),
  z.object({ skip: z.literal(true) }).strict(),
]);

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw Errors.BadRequest(parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

/** Run ids are UUIDs; anything else can't be one of the user's runs. */
function runId(req: Request): string {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) throw Errors.NotFound("Aventura");
  return id;
}

router.get("/adventures", requireAuth, wrap((req) => adventureService.listAdventures(req.user!.userId)));
router.get("/adventures/:id", requireAuth, wrap((req) => adventureService.getAdventureDetail(req.user!.userId, req.params.id)));

router.post(
  "/adventure/runs",
  requireAuth,
  wrap((req) => adventureService.createRun(req.user!.userId, parse(createRunSchema, req.body)), 201),
);
// Before "/adventure/runs/:id" so "active" is never read as a run id.
router.get("/adventure/runs/active", requireAuth, wrap((req) => adventureService.getActiveRun(req.user!.userId)));
router.get("/adventure/runs/:id", requireAuth, wrap((req) => adventureService.getRun(req.user!.userId, runId(req))));
router.patch(
  "/adventure/runs/:id/deck",
  requireAuth,
  wrap((req) => adventureService.editRunDeck(req.user!.userId, runId(req), parse(deckEditSchema, req.body))),
);
router.post("/adventure/runs/:id/battle", requireAuth, wrap((req) => adventureService.startRunBattle(req.user!.userId, runId(req))));
router.post(
  "/adventure/runs/:id/treasure",
  requireAuth,
  wrap((req) => adventureService.chooseRunTreasure(req.user!.userId, runId(req), parse(treasureSchema, req.body))),
);
router.post("/adventure/runs/:id/abandon", requireAuth, wrap((req) => adventureService.abandonRun(req.user!.userId, runId(req))));

export { router as adventureRouter };
