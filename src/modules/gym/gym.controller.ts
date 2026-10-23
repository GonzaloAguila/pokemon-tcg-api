/**
 * Gym Leaders backoffice (docs/gym-leaders.md): see every leader's gym and open / close one on
 * demand (the scheduler ships disabled). Permission `users:economy` (a gym hands out medals);
 * the superadmin always passes.
 *
 *   GET  /api/admin/gyms                    → { gyms: GymAdminStatus[] } (queue entries with usernames)
 *   POST /api/admin/gyms/:leaderId/open     { minutes?: 1–1440, default 45 } → { gym }
 *   POST /api/admin/gyms/:leaderId/close    → { gym } (no new challengers; the queue is still served)
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { prisma } from "../../lib/prisma.js";
import { ADMIN_PERMISSIONS } from "../admin/permissions.js";
import { getGymLeader } from "./content/index.js";
import { GYM_TIMING } from "./gym.config.js";
import { gymService, type GymAdminStatus } from "./gym.service.js";

const router = Router();

const openBody = z
  .object({ minutes: z.number().int().min(1).max(GYM_TIMING.maxOpenMinutes).optional() })
  .nullish()
  .transform((v) => v ?? {});

/** The leader of the route, or 404. */
function leaderParam(req: Request): string {
  const leaderId = String(req.params.leaderId);
  if (!getGymLeader(leaderId)) throw Errors.NotFound("Gimnasio");
  return leaderId;
}

/** Admin rows with the queued / playing users' names (ids alone mean nothing in the panel). */
async function withUsernames(gyms: GymAdminStatus[]) {
  const ids = [...new Set(gyms.flatMap((g) => [...g.queue.map((q) => q.userId), ...(g.current ? [g.current.userId] : [])]))];
  const users = ids.length > 0 ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.username]));
  return gyms.map((g) => ({
    ...g,
    queue: g.queue.map((q) => ({ ...q, username: name.get(q.userId) ?? null })),
    current: g.current ? { ...g.current, username: name.get(g.current.userId) ?? null } : null,
  }));
}

const guard = [requireAuth, requirePermission(ADMIN_PERMISSIONS.USERS_EDIT_ECONOMY)];

router.get("/admin/gyms", ...guard, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ gyms: await withUsernames(gymService.adminStatus()) });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/gyms/:leaderId/open", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leaderId = leaderParam(req);
    const body = openBody.safeParse(req.body);
    if (!body.success) throw Errors.BadRequest(`minutes: entre 1 y ${GYM_TIMING.maxOpenMinutes}`);
    const gym = gymService.open(leaderId, body.data.minutes ?? GYM_TIMING.defaultOpenMinutes);
    console.log(`[admin] ${req.user!.userId} opened the ${leaderId} gym for ${body.data.minutes ?? GYM_TIMING.defaultOpenMinutes} min`);
    res.json({ gym: (await withUsernames([gym]))[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/gyms/:leaderId/close", ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leaderId = leaderParam(req);
    const gym = gymService.close(leaderId);
    console.log(`[admin] ${req.user!.userId} closed the ${leaderId} gym`);
    res.json({ gym: (await withUsernames([gym]))[0] });
  } catch (error) {
    next(error);
  }
});

export const gymAdminRouter = router;
