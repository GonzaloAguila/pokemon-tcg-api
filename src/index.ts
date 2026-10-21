import "./instrument.js";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";

import { setupSocketHandlers } from "./socket/handlers.js";
import { createApp, corsOrigins } from "./app.js";
import { loadCardValues } from "./modules/trades/card-values.js";
import { refundUnsettledMatches } from "./modules/matches/matches.service.js";
import { cleanupOldMessages } from "./modules/chat/chat.service.js";
import { getAdventures } from "./modules/adventure/content/load.js";
import { setAdventureEngine } from "./socket/adventure-engine.js";
import { gameCoreAdventureEngine } from "./socket/adventure-engine-game-core.js";

// Load environment variables
dotenv.config();

// Adventure content (content/adventures/*.json): an invalid file stops the boot, every problem listed
getAdventures();
// Adventure battle rooms run game-core's adventure engine (AI driver, seeded RNG)
setAdventureEngine(gameCoreAdventureEngine);

const corsOrigin = corsOrigins();

// Middleware, rate limits, REST routers and the error handler (app.ts)
const app = createApp();
const httpServer = createServer(app);

// Socket.io setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Socket.io handlers
setupSocketHandlers(io);

// Cleanup old chat messages every 6 hours
setInterval(() => cleanupOldMessages().catch(console.error), 6 * 60 * 60 * 1000);

// Games live in memory: a match still unsettled at startup was lost with the previous process.
// Refund its table bets before accepting connections.
const ready = refundUnsettledMatches()
  .then((n) => { if (n > 0) console.log(`💸 Refunded ${n} interrupted match(es)`); })
  .catch((err) => console.error("Could not settle interrupted matches:", err));

// Card points for trades (set from the backoffice) live in memory
const cardValuesReady = loadCardValues().catch((err) => console.error("Could not load card values:", err));

// Start server
const PORT = process.env.PORT || 3001;
Promise.all([ready, cardValuesReady]).finally(() => httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.io ready for connections`);
}));

export { app, io };
