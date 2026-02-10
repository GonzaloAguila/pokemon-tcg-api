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

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

// Socket.io setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json());
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
// app.use("/api/matchmaking", matchmakingRouter);

// Error handler
app.use(errorHandler);

// Socket.io handlers
setupSocketHandlers(io);

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.io ready for connections`);
});

export { app, io };
