import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { Errors } from "../../middleware/error-handler.js";
import { checkAndUpdateProgress } from "../achievements/achievements.service.js";
import * as matchesService from "./matches.service.js";
import { getHistorySummary, listUserMatches } from "./history.js";
import { GYM_LEADERS } from "../gym/content/index.js";

const router = Router();

const matchIdSchema = z.string().uuid();
const gameModeSchema = z.enum(["standard", "lucky-duel"]);
// mode (default standard): a Lucky Duel escrows ECONOMY.luckyDuelAi.stake
const startAiSchema = z.object({ mode: gameModeSchema.optional() }).optional();
// turnNumber: last turn the game reached (a game counts from turn 3, like multiplayer)
// result "draw": a Lucky Duel that ended with both Actives Knocked Out (no winner, the loser's
// rewards). mode: accepted from older clients and ignored (the mode is the one the game started
// with). luckyDuel: the Basics both sides drew and who started (Lucky Duel achievements); the ids
// are checked against game-core's LUCKY_DUEL_BASICS in the service (400).
const finishAiSchema = z.object({
  result: z.enum(["victory", "defeat", "draw"]),
  turnNumber: z.number().int().min(0).max(10_000),
  mode: gameModeSchema.optional(),
  luckyDuel: z
    .object({
      playerStarterId: z.string().min(1).max(100),
      opponentStarterId: z.string().min(1).max(100),
      startingPlayer: z.enum(["player", "opponent"]),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// POST /matches/ai — A single-player game vs the AI starts. Body (optional):
// { mode?: "standard" | "lucky-duel" }. Returns { matchId } (+ luckyDuel: { stake, streak }).
// ---------------------------------------------------------------------------

router.post(
  "/matches/ai",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = startAiSchema.safeParse(req.body ?? undefined);
      if (!body.success) throw Errors.ValidationError("Modo de juego inválido");
      res.json(await matchesService.startAiMatch(req.user!.userId, body.data?.mode ?? "standard"));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /matches/ai/lucky-duel — Stake, streak bonus rule and the user's Lucky Duel streaks.
// ---------------------------------------------------------------------------

router.get(
  "/matches/ai/lucky-duel",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await matchesService.getLuckyDuelAiStatus(req.user!.userId));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /matches/ai/:matchId/finish — { result: "victory" | "defeat" | "draw", turnNumber, mode?, luckyDuel? }.
// XP, coins and missions are decided here (never sent by the client); the game must have
// reached turn 3, lasted a few minutes, and only the first games of the day count. A Lucky Duel
// also settles its stake and streak bonus (response `luckyDuel`).
// ---------------------------------------------------------------------------

router.post(
  "/matches/ai/:matchId/finish",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const matchId = matchIdSchema.safeParse(req.params.matchId);
      if (!matchId.success) throw Errors.NotFound("Partida");
      const body = finishAiSchema.safeParse(req.body);
      if (!body.success) throw Errors.ValidationError("Resultado inválido");
      const userId = req.user!.userId;
      const result = await matchesService.finishAiMatch(
        userId,
        matchId.data,
        body.data.result,
        body.data.turnNumber,
        new Date(),
        body.data.luckyDuel,
      );
      // Lucky Duel achievements (and level ones) progress from this result
      checkAndUpdateProgress(userId).catch(console.error);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /matches/history?page&limit — The signed-in player's settled games (online, vs AI, gym),
// newest first, from their side: { data: HistoryEntry[], total, page, limit }.
// ---------------------------------------------------------------------------

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

router.get(
  "/matches/history",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = historyQuerySchema.safeParse(req.query);
      if (!query.success) throw Errors.ValidationError("Página inválida");
      res.json(await listUserMatches(req.user!.userId, query.data.page, query.data.limit));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /matches/history/summary — The profile Historial panel: wins / losses / draws overall and
// per mode (online, draft, vs AI, gym), win rate, streaks and the latest 10 results.
// ---------------------------------------------------------------------------

const GYM_MEDAL_IDS = GYM_LEADERS.map((leader) => leader.medalId);

router.get(
  "/matches/history/summary",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getHistorySummary(req.user!.userId, GYM_MEDAL_IDS));
    } catch (err) {
      next(err);
    }
  },
);

export { router as matchesRouter };
