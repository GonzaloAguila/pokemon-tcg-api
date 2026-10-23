/**
 * Gym Leaders over Socket.io (contract: docs/gym-leaders.md). Server → client: `gymTables`
 * (broadcast on every change, and in reply to getGymTables), `gymSeries` (to one user: their
 * best-of-3 series — playing / next / finished), `gymAttempts` (to one user: their daily attempts per
 * leader, when they change), `gymBattleResult` (once per series, gym-room.ts).
 * Client → server, with an ack: `getGymTables {}` → `{ ok: true, tables, mySeries, myAttempts }`;
 * `challengeGym { leaderId, mode, deckId }` → `{ ok: true, roomId } | { ok: false, error }` (the
 * entry cost is charged then). Each game is entered with the usual `joinRoom { roomId }` (the
 * room already exists, reserved for the challenger).
 */
import type { Server, Socket } from "socket.io";
import { prisma } from "../lib/prisma.js";
import { getGymLeader, leaderRules, versionLabel } from "../modules/gym/content/index.js";
import { checkChallengerDeck } from "../modules/gym/challenger-deck.js";
import { GYM_ERRORS, GymError, gymService } from "../modules/gym/gym.service.js";
import { addCoins, spendCoins } from "../modules/users/users.service.js";
import { attemptsError, attemptsOf, giveBackAttempt, noAttemptsError, takeAttempt } from "../modules/gym/attempts.js";
import { checkSocketSession, kickBlockedUser } from "./session-guard.js";
import { parsePayload, socketSchemas } from "./schemas.js";
import { userRoom } from "./io-registry.js";
import { GYM_ENTRY_REFUND_TRANSACTION, type GymRooms } from "./gym-room.js";

type Ack = (res: unknown) => void;

/** Transaction log type of the entry cost. */
export const GYM_ENTRY_TRANSACTION = "gym_entry";

/** The gym state's changes reach every lobby (`gymTables`) and the users concerned (`gymSeries`). */
export function wireGymService(io: Server, gymRooms: GymRooms): void {
  gymService.setListeners({
    onChange: (users) => {
      io.emit("gymTables", gymService.tables());
      for (const userId of new Set(users)) {
        const series = gymService.mySeries(userId);
        if (series) io.to(userRoom(userId)).emit("gymSeries", series);
      }
    },
  });
  gymRooms.setCallbacks({
    onNextGame: (roomId, nextRoomId, game, score) => gymService.nextGame(roomId, nextRoomId, game, score),
    onGameEntered: (roomId) => gymService.gameEntered(roomId),
    onBattleEnd: (roomId) => gymService.battleEnded(roomId),
  });
  gymService.start();
}

/** `gymAttempts` to every socket of the user (their attempts changed). */
export async function emitAttempts(io: Pick<Server, "to">, userId: string): Promise<void> {
  try {
    io.to(userRoom(userId)).emit("gymAttempts", await attemptsOf(userId));
  } catch (error) {
    console.error(`[gym] Could not send the attempts of ${userId}:`, error);
  }
}

/**
 * challengeGym once the payload is valid: the table must be free and open, the user without
 * another gym series, with an attempt left today against this leader, able to pay the entry cost,
 * with a deck that passes the normal rules and the version's (async); then the table is taken
 * (synchronously: of two challenges the first wins), the attempt used, the entry cost charged and
 * the first game's room built.
 */
async function challenge(io: Pick<Server, "to">, gymRooms: GymRooms, userId: string, leaderId: string, mode: "normal" | "expert", deckId: string) {
  const early = gymService.challengeError(userId, leaderId, mode);
  if (early) return { ok: false as const, error: early };
  const leader = getGymLeader(leaderId)!;
  const noAttempts = await attemptsError(userId, leader);
  if (noAttempts) return { ok: false as const, error: noAttempts };
  const rules = leaderRules(leader, mode)!;
  const cost = leader.entryCost;
  const costError = GYM_ERRORS.entryCost(cost, leader.name);
  const [deck, user] = await Promise.all([
    checkChallengerDeck(userId, deckId, rules),
    prisma.user.findUnique({ where: { id: userId }, select: { username: true, activeAvatarId: true, coins: true } }),
  ]);
  if (!user) return { ok: false as const, error: "Usuario no encontrado" };
  if (user.coins < cost) return { ok: false as const, error: costError };
  if (!deck.ok) return { ok: false as const, error: deck.error };
  // Throws the in-battle error when another challenge took the table during the checks
  const roomId = gymService.reserve(userId, leaderId, mode, { username: user.username, avatarId: user.activeAvatarId ?? null });
  const label = versionLabel(leader, mode);
  // The reservation is held: no other series of this user can take an attempt meanwhile
  let attemptId: string | null;
  try {
    attemptId = await takeAttempt(userId, leader, mode);
  } catch (error) {
    gymService.battleFailed(roomId);
    throw error;
  }
  if (!attemptId) {
    gymService.battleFailed(roomId);
    return { ok: false as const, error: noAttemptsError(leader) };
  }
  if (cost > 0) {
    try {
      // Conditional debit: a balance spent meanwhile refuses here
      await spendCoins(userId, cost, GYM_ENTRY_TRANSACTION, `Reto a ${label}: -${cost} monedas`);
    } catch {
      gymService.battleFailed(roomId);
      await giveBackAttempt(attemptId).catch((error) => console.error(`[gym ${roomId}] Could not give the attempt back:`, error));
      return { ok: false as const, error: costError };
    }
  }
  try {
    await gymRooms.startSeries({ roomId, userId, deckId, leader, mode, playerDeck: deck.entries, entryCost: cost, attemptId });
  } catch (error) {
    // Never leave the table taken (nor the coins spent, nor the attempt used) by a series that couldn't start
    console.error(`[gym ${roomId}] Could not build the battle:`, error);
    gymService.battleFailed(roomId);
    await giveBackAttempt(attemptId).catch((attemptError) => console.error(`[gym ${roomId}] Could not give the attempt back:`, attemptError));
    if (cost > 0) {
      await addCoins(userId, cost, GYM_ENTRY_REFUND_TRANSACTION, `Reto a ${label} devuelto: +${cost} monedas`).catch((refundError) =>
        console.error(`[gym ${roomId}] Could not refund the entry cost to ${userId}:`, refundError),
      );
    }
    return { ok: false as const, error: "No se pudo empezar la batalla" };
  }
  gymService.battleStarted(roomId);
  await emitAttempts(io, userId);
  return { ok: true as const, roomId };
}

export function registerGymEvents(socket: Socket, gymRooms: GymRooms): void {
  const replier = (ack: unknown): Ack => (res) => {
    if (typeof ack === "function") (ack as Ack)(res);
  };

  // getGymTables {}: the open tables (gymTables) and, signed in, the user's series (gymSeries);
  // the ack carries both, and the user's daily attempts per leader (myAttempts: {} signed out)
  socket.on("getGymTables", async (payload: unknown, ack?: unknown) => {
    // `emit("getGymTables", ack)` (no payload) works too
    const reply = replier(typeof payload === "function" ? payload : ack);
    const parsed = parsePayload(socketSchemas.getGymTables, typeof payload === "function" ? {} : (payload ?? {}));
    if (!parsed.ok) return reply({ ok: false, error: parsed.error });
    const tables = gymService.tables();
    socket.emit("gymTables", tables);
    const userId: string | undefined = socket.data.user?.userId;
    const mySeries = userId ? gymService.mySeries(userId) : null;
    if (mySeries) socket.emit("gymSeries", mySeries);
    let myAttempts = {};
    if (userId) {
      try {
        myAttempts = await attemptsOf(userId);
      } catch (error) {
        console.error("[getGymTables] attempts", error);
      }
    }
    reply({ ok: true, tables, mySeries, myAttempts });
  });

  // challengeGym { leaderId, mode, deckId }: take a free table (entry cost charged); ack
  // { ok: true, roomId } (the first game's room exists: joinRoom it) or { ok: false, error } (Spanish)
  socket.on("challengeGym", async (payload: unknown, ack?: unknown) => {
    const reply = replier(ack);
    try {
      const session = await checkSocketSession(socket);
      if (!session.ok) {
        reply({ ok: false, error: session.error });
        if (session.blocked) kickBlockedUser(socket);
        return;
      }
      const parsed = parsePayload(socketSchemas.challengeGym, payload);
      if (!parsed.ok) return reply({ ok: false, error: parsed.error });
      const { leaderId, mode, deckId } = parsed.data;
      reply(await challenge(socket.nsp.server, gymRooms, session.userId, leaderId, mode, deckId));
    } catch (error) {
      if (error instanceof GymError) return reply({ ok: false, error: error.message });
      console.error("[challengeGym]", error);
      reply({ ok: false, error: "No se pudo retar al gimnasio" });
    }
  });
}
