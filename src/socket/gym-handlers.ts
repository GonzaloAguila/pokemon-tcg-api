/**
 * Gym Leaders over Socket.io (contract: docs/gym-leaders.md). Server → client: `gymTables`
 * (broadcast on every change, and in reply to getGymTables), `gymQueue` (to one user: their own
 * queue state, null = not queued), `gymBattleReady`, `gymBattleResult` (gym-room.ts). Client →
 * server, each with an ack `{ ok: true } | { ok: false, error }`: `getGymTables {}`,
 * `joinGymQueue { leaderId, mode, deckId }`, `leaveGymQueue { leaderId }`. The battle itself is
 * entered with the usual `joinRoom { roomId }` (claimGymBattle builds its room).
 */
import type { Server, Socket } from "socket.io";
import { getGymLeader } from "../modules/gym/content/index.js";
import { checkChallengerDeck } from "../modules/gym/challenger-deck.js";
import { GymError, gymService } from "../modules/gym/gym.service.js";
import { checkSocketSession, kickBlockedUser } from "./session-guard.js";
import { parsePayload, socketSchemas } from "./schemas.js";
import { userRoom } from "./io-registry.js";
import type { GymRooms } from "./gym-room.js";
import type { GameRoom } from "./rooms.js";

type GymAck = { ok: true } | { ok: false; error: string };

/** joinRoom on a ready gym room that can't start: the deck no longer passes, or the build failed. */
export interface GymClaimError {
  error: string;
  code: "GYM_DECK_INVALID" | "GYM_BATTLE_FAILED";
}

/** The gym state's changes reach every lobby (`gymTables`) and the users concerned (`gymQueue`). */
export function wireGymService(io: Server, gymRooms: GymRooms): void {
  gymService.setListeners({
    onChange: (users) => {
      io.emit("gymTables", gymService.tables());
      for (const userId of new Set(users)) io.to(userRoom(userId)).emit("gymQueue", gymService.queueStateOf(userId));
    },
    onReady: (userId, ready) => {
      io.to(userRoom(userId)).emit("gymBattleReady", ready);
    },
  });
  gymRooms.setCallbacks({ onBattleEnd: (roomId) => gymService.battleEnded(roomId) });
  gymService.start();
}

/** Battles being built (two tabs entering at once build one room). */
const building = new Map<string, Promise<GameRoom | GymClaimError | null>>();

/**
 * joinRoom on a `gym-…` room that isn't built yet: the user's ready battle, entered in time, with
 * their queued deck checked again (a deck that no longer passes skips them). Null when it isn't
 * their ready battle (the caller answers ROOM_NOT_FOUND).
 */
export function claimGymBattle(gymRooms: GymRooms, roomId: string, userId: string): Promise<GameRoom | GymClaimError | null> {
  let pending = building.get(roomId);
  if (!pending) {
    pending = buildGymBattle(gymRooms, roomId, userId).finally(() => building.delete(roomId));
    building.set(roomId, pending);
  }
  return pending;
}

async function buildGymBattle(gymRooms: GymRooms, roomId: string, userId: string): Promise<GameRoom | GymClaimError | null> {
  const battle = gymService.claimable(roomId, userId);
  if (!battle) return null;
  const deck = await checkChallengerDeck(userId, battle.deckId, battle.leader);
  // The slot may have expired (or been given up) during the check
  if (!gymService.claimable(roomId, userId)) return null;
  if (!deck.ok) {
    gymService.battleFailed(roomId);
    return { error: deck.error, code: "GYM_DECK_INVALID" };
  }
  try {
    const room = await gymRooms.build({ roomId, userId, deckId: battle.deckId, leader: battle.leader, mode: battle.mode, playerDeck: deck.entries });
    gymService.battleStarted(roomId);
    return room;
  } catch (error) {
    // Never leave the gym waiting on a battle that couldn't be built: the next challenger plays
    console.error(`[gym ${roomId}] Could not build the battle:`, error);
    gymService.battleFailed(roomId);
    return { error: "No se pudo empezar la batalla", code: "GYM_BATTLE_FAILED" };
  }
}

export function registerGymEvents(socket: Socket): void {
  const replier = (ack: unknown) => (res: GymAck) => {
    if (typeof ack === "function") ack(res);
  };

  // getGymTables {}: the open gyms (gymTables) and, signed in, the user's own queue (gymQueue)
  socket.on("getGymTables", (payload: unknown, ack?: unknown) => {
    // `emit("getGymTables", ack)` (no payload) works too
    const reply = replier(typeof payload === "function" ? payload : ack);
    const parsed = parsePayload(socketSchemas.getGymTables, typeof payload === "function" ? {} : (payload ?? {}));
    if (!parsed.ok) return reply({ ok: false, error: parsed.error });
    socket.emit("gymTables", gymService.tables());
    const userId: string | undefined = socket.data.user?.userId;
    if (userId) socket.emit("gymQueue", gymService.queueStateOf(userId));
    reply({ ok: true });
  });

  // joinGymQueue { leaderId, mode, deckId }: the gym must be open, the deck must pass the normal
  // rules and the leader's (checked again when the battle starts), one queue per user
  socket.on("joinGymQueue", async (payload: unknown, ack?: unknown) => {
    const reply = replier(ack);
    try {
      const session = await checkSocketSession(socket);
      if (!session.ok) {
        reply({ ok: false, error: session.error });
        if (session.blocked) kickBlockedUser(socket);
        return;
      }
      const parsed = parsePayload(socketSchemas.joinGymQueue, payload);
      if (!parsed.ok) return reply({ ok: false, error: parsed.error });
      const { leaderId, mode, deckId } = parsed.data;
      const early = gymService.joinError(session.userId, leaderId, mode);
      if (early) return reply({ ok: false, error: early });
      const deck = await checkChallengerDeck(session.userId, deckId, getGymLeader(leaderId)!);
      if (!deck.ok) return reply({ ok: false, error: deck.error });
      gymService.join(session.userId, leaderId, mode, deckId);
      reply({ ok: true });
    } catch (error) {
      if (error instanceof GymError) return reply({ ok: false, error: error.message });
      console.error("[joinGymQueue]", error);
      reply({ ok: false, error: "No se pudo entrar en la fila" });
    }
  });

  // leaveGymQueue { leaderId }: out of the queue, or give up a ready battle (not a started one)
  socket.on("leaveGymQueue", async (payload: unknown, ack?: unknown) => {
    const reply = replier(ack);
    try {
      const session = await checkSocketSession(socket);
      if (!session.ok) return reply({ ok: false, error: session.error });
      const parsed = parsePayload(socketSchemas.leaveGymQueue, payload);
      if (!parsed.ok) return reply({ ok: false, error: parsed.error });
      gymService.leave(session.userId, parsed.data.leaderId);
      reply({ ok: true });
    } catch (error) {
      if (error instanceof GymError) return reply({ ok: false, error: error.message });
      console.error("[leaveGymQueue]", error);
      reply({ ok: false, error: "No se pudo salir de la fila" });
    }
  });
}
