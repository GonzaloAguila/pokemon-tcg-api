import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import * as chatService from "./chat.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /chat/messages — Get recent chat messages (initial load)
// ---------------------------------------------------------------------------

router.get(
  "/chat/messages",
  requireAuth,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const messages = await chatService.getRecentMessages();
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  },
);

export { router as chatRouter };
