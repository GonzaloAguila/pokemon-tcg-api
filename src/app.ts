/**
 * The Express app: middleware, rate limits, every REST router and the error handler. index.ts
 * wraps it in the HTTP + Socket.io server; tests build it on its own (test/fixtures).
 */
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { errorHandler } from "./middleware/error-handler.js";
import { apiRateLimiter, economyRateLimiter } from "./middleware/rate-limit.js";
import { catalogRouter } from "./modules/catalog/index.js";
import { boostersRouter } from "./modules/boosters/index.js";
import { authRouter } from "./modules/auth/index.js";
import { usersRouter } from "./modules/users/index.js";
import { decksRouter } from "./modules/decks/index.js";
import { battlePassRouter } from "./modules/battle-pass/index.js";
import { marketRouter } from "./modules/market/index.js";
import { wheelRouter } from "./modules/wheel/index.js";
import { slotsRouter } from "./modules/slots/index.js";
import { achievementsRouter } from "./modules/achievements/index.js";
import { chatRouter } from "./modules/chat/index.js";
import { messagingRouter } from "./modules/messaging/index.js";
import { adminRouter } from "./modules/admin/index.js";
import { bugReportRouter } from "./modules/bug-report/index.js";
import { waitlistRouter } from "./modules/waitlist/index.js";
import { matchesRouter } from "./modules/matches/index.js";
import { economyRouter } from "./modules/economy/index.js";
import { newsRouter } from "./modules/news/index.js";
import { tradesRouter } from "./modules/trades/index.js";
import { progressRouter } from "./modules/progress/index.js";
import { presenceRouter } from "./modules/presence/index.js";
import { playersRouter } from "./modules/players/index.js";
import { emotesRouter } from "./modules/emotes/index.js";
import { adventureRouter } from "./modules/adventure/index.js";

/** Origins allowed by CORS (REST and Socket.io): CORS_ORIGIN, comma separated. */
export function corsOrigins(): string[] {
  return process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : ["http://localhost:3000"];
}

export function createApp(): express.Express {
  const app = express();

  // Behind Nginx (one hop): use X-Forwarded-For so req.ip / rate limits see the real client
  app.set("trust proxy", 1);

  // Middleware
  app.use(cors({
    origin: corsOrigins(),
    credentials: true,
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Rate limits
  app.use("/api", apiRateLimiter);
  app.use(
    [
      "/api/market",
      "/api/wheel",
      "/api/slots",
      "/api/packs",
      "/api/battle-pass",
      "/api/achievements",
      "/api/users/me/claim-wheel-spin",
      "/api/users/me/claim-slot-spin",
      "/api/users/me/deck-slots",
      "/api/matches",
      "/api/economy",
      "/api/progress/tutorial",
      "/api/progress/puzzles",
      "/api/adventure",
    ],
    economyRateLimiter,
  );

  // API Routes. Every router mounted on "/api" is a layer each request goes through until one
  // answers: keep Sentry's per-layer spans off (instrument.ts) or each adds a "finish" listener.
  app.use("/api", catalogRouter);
  app.use("/api", boostersRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/users", decksRouter);
  app.use("/api/users", emotesRouter);
  app.use("/api", battlePassRouter);
  app.use("/api", marketRouter);
  app.use("/api", wheelRouter);
  app.use("/api", slotsRouter);
  app.use("/api", achievementsRouter);
  app.use("/api", chatRouter);
  app.use("/api", messagingRouter);
  app.use("/api", adminRouter);
  app.use("/api", express.json({ limit: "10mb" }), bugReportRouter);
  app.use("/api", waitlistRouter);
  app.use("/api", matchesRouter);
  app.use("/api", economyRouter);
  app.use("/api", newsRouter);
  app.use("/api", tradesRouter);
  app.use("/api", progressRouter);
  app.use("/api", presenceRouter);
  app.use("/api", playersRouter);
  app.use("/api", adventureRouter);
  // app.use("/api/matchmaking", matchmakingRouter);

  // Error handler
  app.use(errorHandler);

  return app;
}
