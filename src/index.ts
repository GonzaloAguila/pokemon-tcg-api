import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";

import cookieParser from "cookie-parser";
import { setupSocketHandlers } from "./socket/handlers.js";
import { errorHandler } from "./middleware/error-handler.js";
import { catalogRouter } from "./modules/catalog/index.js";
import { boostersRouter } from "./modules/boosters/index.js";
import { authRouter } from "./modules/auth/index.js";
import { usersRouter } from "./modules/users/index.js";
import { decksRouter } from "./modules/decks/index.js";
import { battlePassRouter } from "./modules/battle-pass/index.js";
import { marketRouter } from "./modules/market/index.js";
import { wheelRouter } from "./modules/wheel/index.js";
import { achievementsRouter } from "./modules/achievements/index.js";
import { chatRouter } from "./modules/chat/index.js";
import { messagingRouter } from "./modules/messaging/index.js";
import { adminRouter } from "./modules/admin/index.js";
import { bugReportRouter } from "./modules/bug-report/index.js";
import { cleanupOldMessages } from "./modules/chat/chat.service.js";

// Load environment variables
dotenv.config();

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : ["http://localhost:3000"];

const app = express();
const httpServer = createServer(app);

// Socket.io setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api", catalogRouter);
app.use("/api", boostersRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/users", decksRouter);
app.use("/api", battlePassRouter);
app.use("/api", marketRouter);
app.use("/api", wheelRouter);
app.use("/api", achievementsRouter);
app.use("/api", chatRouter);
app.use("/api", messagingRouter);
app.use("/api", adminRouter);
app.use("/api", express.json({ limit: "10mb" }), bugReportRouter);
// app.use("/api/matchmaking", matchmakingRouter);

// Error handler
app.use(errorHandler);

// Socket.io handlers
setupSocketHandlers(io);

// Cleanup old chat messages every 6 hours
setInterval(() => cleanupOldMessages().catch(console.error), 6 * 60 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.io ready for connections`);
});

export { app, io };
