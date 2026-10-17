import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { EMOTE_LOADOUT_SIZE } from "./catalog.js";
import * as emotesService from "./emotes.service.js";

const router = Router();

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    next(err);
  }
};

// Bounds only; the service checks repeats, catalog ids and ownership (Spanish 400s).
const loadoutSchema = z.object({
  emoteIds: z.array(z.string().trim().min(1).max(40)).max(EMOTE_LOADOUT_SIZE, `Puedes llevar hasta ${EMOTE_LOADOUT_SIZE} emotes`),
});

// GET /users/me/emotes → { emotes: [{ emoteId, obtainedAt, starter }], loadout: string[] }
router.get("/me/emotes", requireAuth, wrap((req) => emotesService.getUserEmotes(req.user!.userId)));

// PATCH /users/me/emotes/loadout { emoteIds } → { loadout } (choosing emotes is not an economy action)
router.patch(
  "/me/emotes/loadout",
  requireAuth,
  wrap(async (req) => {
    const parsed = loadoutSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.ValidationError(parsed.error.errors.map((e) => e.message).join(". "));
    return { loadout: await emotesService.setEmoteLoadout(req.user!.userId, parsed.data.emoteIds) };
  }),
);

export { router as emotesRouter };
