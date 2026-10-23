/**
 * Gym Leader battle rooms (docs/gym-leaders.md): a GameRoomManager room whose player 1 is the
 * challenger and player 2 the leader, played by the game-core AI through the shared AI seat driver
 * (ai-seat.ts, like Modo Aventura). The challenger plays with the usual `joinRoom` / `action` /
 * `requestCoinFlip`; every coin and engine call of the room comes from one seeded generator per
 * battle (seeded from the CSPRNG; nothing is persisted: an API restart ends the battle).
 *
 * Unlike adventure battles the challenger has a clock: `turnClockMs` per turn (the opening, each of
 * their turns, and an answer they owe on the leader's turn: one clock per such turn), and
 * `disconnectGraceMs` away from the battle (no seat socket). Running out of either ends the battle
 * as a loss, so the gym's queue keeps moving. The end: `gameOver`, then `gymBattleResult` to the
 * challenger's sockets, the medal on a victory (once), and the queue advances (`onBattleEnd`).
 * No settlement, match row, coins, XP, chat, spectators or bets.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import { answerOpponentTrainerStepForAI, createGameEvent, GamePhase, type GameState, type SelectionStep } from "@gonzaloaguila/game-core";
import type { CardEntry, GymLeaderDef, GymMode } from "../modules/gym/content/types.js";
import { leaderDeck } from "../modules/gym/content/index.js";
import { GYM_TIMING } from "../modules/gym/gym.config.js";
import { grantMedal } from "../modules/users/users.service.js";
import { awaitedSide, defaultSelection, neutralizeEvents, withRoomRandom, type ActionResult, type GameRoom, type GameRoomManager } from "./rooms.js";
import { maskRoomState } from "./room-state.js";
import { DEFAULT_COSMETICS, loadSeatCosmetics, type SeatCosmetics } from "./room-cosmetics.js";
import { userRoom } from "./io-registry.js";
import type { AdventureEngine } from "./adventure-engine.js";
import { gameCoreAdventureEngine } from "./adventure-engine-game-core.js";
import { AISeatDriver, actionCoinBatches, rngCoin, type AISeat, type AISeatHooks, type AISeatPacing } from "./ai-seat.js";

/** How long a finished battle's room stays (game-over screen), like rooms.ts FINISHED_ROOM_TTL_MS. */
const FINISHED_ROOM_MS = 120_000;

/** `gameStart.gym` (contract). */
export interface GymGameStartInfo {
  leaderId: string;
  name: string;
  title: string;
  mode: GymMode;
  medalId: string;
  avatarId: string;
}

/** `gymBattleResult` (contract): `medalGranted` = this victory gave the medal for the first time. */
export interface GymBattleResultPayload {
  leaderId: string;
  mode: GymMode;
  victory: boolean;
  medalId: string;
  medalGranted: boolean;
}

/** How a battle ended. */
export type GymBattleEnd = "game" | "timeout" | "disconnect" | "error";

interface Runtime extends AISeat {
  userId: string;
  leader: GymLeaderDef;
  mode: GymMode;
  info: GymGameStartInfo;
  aiLoop: Promise<void> | null;
  finished: boolean;
  /** The challenger's clock: one per turn (`key`), ends at `deadline`. */
  clock: { key: string; deadline: number } | null;
  clockTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

export interface GymTiming {
  turnClockMs: number;
  disconnectGraceMs: number;
}

export interface GymRoomsOptions {
  manager: GameRoomManager;
  io: () => Server | null;
  engine?: () => AdventureEngine;
  /** Broadcast an action the server took for the leader (handlers.ts broadcastActionResult). */
  broadcast?: (roomId: string, actionType: string, result: ActionResult) => void;
  /** The battle ended (its result is out): the gym's queue moves. */
  onBattleEnd?: (roomId: string) => void;
}

type RoomTrainerChoice = { cardId: string; step: SelectionStep; chooser?: "self" | "opponent"; playedOffTurn?: boolean };

const pendingTrainerChoiceOf = (state: GameState): RoomTrainerChoice | undefined =>
  (state as GameState & { pendingTrainerChoice?: RoomTrainerChoice }).pendingTrainerChoice;

export class GymRooms {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly manager: GameRoomManager;
  private readonly io: () => Server | null;
  private readonly engine: () => AdventureEngine;
  private readonly driver: AISeatDriver;
  private broadcast?: GymRoomsOptions["broadcast"];
  private onBattleEnd?: GymRoomsOptions["onBattleEnd"];
  private timing: GymTiming = { turnClockMs: GYM_TIMING.turnClockMs, disconnectGraceMs: GYM_TIMING.disconnectGraceMs };

  constructor(options: GymRoomsOptions) {
    this.manager = options.manager;
    this.io = options.io;
    this.engine = options.engine ?? (() => gameCoreAdventureEngine);
    this.driver = new AISeatDriver(this.manager, this.io, this.engine);
    this.broadcast = options.broadcast;
    this.onBattleEnd = options.onBattleEnd;
  }

  /** Wire the callbacks (handlers.ts, once the io server and the gym state exist). */
  setCallbacks(callbacks: Pick<GymRoomsOptions, "broadcast" | "onBattleEnd">): void {
    if (callbacks.broadcast) this.broadcast = callbacks.broadcast;
    if (callbacks.onBattleEnd) this.onBattleEnd = callbacks.onBattleEnd;
  }

  /** Change the AI's pauses (tests); returns the previous ones. */
  setPacing(pacing: Partial<AISeatPacing>): AISeatPacing {
    return this.driver.setPacing(pacing);
  }

  /** Change the challenger's clocks (tests); returns the previous ones. Applies to new clocks. */
  setTiming(timing: Partial<GymTiming>): GymTiming {
    const previous = this.timing;
    this.timing = { ...previous, ...timing };
    return previous;
  }

  isGymRoom(roomId: string): boolean {
    return this.runtimes.has(roomId);
  }

  /** `gameStart.gym` for the room's challenger. */
  gameStartInfo(roomId: string): GymGameStartInfo | null {
    return this.runtimes.get(roomId)?.info ?? null;
  }

  // ---------------------------------------------------------------------------
  // Building the battle
  // ---------------------------------------------------------------------------

  /**
   * Build the battle room (its opening: MULLIGAN) for the challenger, whose deck was just checked.
   * Standard rules: 6 Prizes, 7-card hand, no adventure modifiers or passives.
   */
  async build(input: {
    roomId: string;
    userId: string;
    deckId: string;
    leader: GymLeaderDef;
    mode: GymMode;
    playerDeck: CardEntry[];
  }): Promise<GameRoom> {
    const { roomId, userId, deckId, leader, mode } = input;
    const opponentDeck = leaderDeck(leader, mode);
    if (!opponentDeck) throw new Error(`${leader.id} has no ${mode} deck`);
    const engine = this.engine();
    const rng = engine.createRng(engine.hashSeed(`${roomId}:${randomUUID()}`));
    const created = withRoomRandom(
      () => rng.next(),
      () =>
        engine.createGame({
          playerDeck: input.playerDeck.map((e) => ({ ...e })),
          opponentDeck: opponentDeck.map((e) => ({ ...e })),
          prizeCount: 6,
          openingHand: 7,
          playerPassives: [],
          modifiers: [],
        }),
    );
    const state: GameState = { ...created, events: neutralizeEvents(created.events, 0, "Jugador 1", "Jugador 2") };

    // The challenger's own cosmetics (owned only) are read before the room exists: nothing awaits after
    let player1: SeatCosmetics;
    try {
      player1 = await loadSeatCosmetics(userId, deckId);
    } catch (error) {
      console.error(`[gym ${roomId}] Could not read the cosmetics of ${userId}:`, error);
      player1 = { ...DEFAULT_COSMETICS, variantMap: {} };
    }

    const room = this.manager.createGymRoom({
      roomId,
      leaderId: leader.id,
      mode,
      userId,
      deckId,
      rival: { username: leader.name, avatarId: leader.avatarId, titleId: null },
      gameState: state,
      turnTimerSeconds: this.timing.turnClockMs / 1000,
      engineRandom: () => rng.next(),
      coinSource: () => rngCoin(rng),
    });
    // The leader's side is fixed (never loaded from a user)
    room.cosmetics = { player1, player2: { ...leader.cosmetics, variantMap: {} } };

    const runtime: Runtime = {
      roomId,
      room,
      rng,
      plan: null,
      coinsShownUntil: 0,
      aiErrors: 0,
      userId,
      leader,
      mode,
      info: { leaderId: leader.id, name: leader.name, title: leader.title, mode, medalId: leader.medalId, avatarId: leader.avatarId },
      aiLoop: null,
      finished: false,
      clock: null,
    };
    this.runtimes.set(roomId, runtime);
    console.log(`[gym ${roomId}] ${userId} challenges ${leader.id} (${mode})`);
    this.refreshClock(runtime);
    this.seatChanged(roomId);
    this.scheduleAI(roomId);
    return room;
  }

  // ---------------------------------------------------------------------------
  // Challenger inputs and presence
  // ---------------------------------------------------------------------------

  /** After every challenger `action` on a gym room (before its broadcast): the clock, then the AI or the end. */
  afterHumanAction(roomId: string, result: ActionResult): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || !result.success || runtime.finished) return;
    if (result.gameOver) {
      void this.finishBattle(roomId, "game");
      return;
    }
    this.driver.holdForCoins(runtime, actionCoinBatches(result));
    this.refreshClock(runtime);
    this.scheduleAI(roomId);
  }

  /**
   * The challenger's seat socket came or went (joinRoom, leaveRoom, disconnect): away from the
   * battle, the disconnect grace runs; back, it stops.
   */
  seatChanged(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.finished) return;
    if (runtime.room.player1SocketId) {
      if (runtime.graceTimer) clearTimeout(runtime.graceTimer);
      runtime.graceTimer = undefined;
      return;
    }
    if (runtime.graceTimer) return;
    runtime.graceTimer = setTimeout(() => {
      runtime.graceTimer = undefined;
      if (!runtime.room.player1SocketId) void this.forfeit(roomId, "disconnect");
    }, this.timing.disconnectGraceMs);
    runtime.graceTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // The challenger's clock
  // ---------------------------------------------------------------------------

  /** Whether the battle waits on the challenger now (opening not ready, their turn, an answer they owe). */
  private challengerAwaited(state: GameState): boolean {
    if (state.gamePhase === GamePhase.GameOver) return false;
    if (state.gamePhase === GamePhase.Mulligan || state.gamePhase === GamePhase.Setup) return !state.playerReady;
    return awaitedSide(state) === "player1";
  }

  /**
   * The clock runs while the battle waits on the challenger: a new one (full time) for each turn,
   * kept across the moments the leader acts in the middle of it (an answer it owes).
   */
  private refreshClock(runtime: Runtime): void {
    const state = runtime.room.gameState;
    if (runtime.clockTimer) clearTimeout(runtime.clockTimer);
    runtime.clockTimer = undefined;
    if (!state || runtime.finished || !this.challengerAwaited(state)) return;
    const opening = state.gamePhase === GamePhase.Mulligan || state.gamePhase === GamePhase.Setup;
    const key = opening ? "opening" : `${state.turnNumber}:${state.isPlayerTurn ? "own" : "answer"}`;
    const now = Date.now();
    if (!runtime.clock || runtime.clock.key !== key) {
      runtime.clock = { key, deadline: now + this.timing.turnClockMs };
      runtime.room.turnStartedAt = now;
      runtime.room.turnTimerDuration = this.timing.turnClockMs / 1000;
    }
    runtime.clockTimer = setTimeout(() => {
      runtime.clockTimer = undefined;
      const current = runtime.room.gameState;
      if (current && runtime.clock?.key === key && this.challengerAwaited(current)) void this.forfeit(runtime.roomId, "timeout");
    }, Math.max(0, runtime.clock.deadline - now));
    runtime.clockTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // The leader (AI seat)
  // ---------------------------------------------------------------------------

  private scheduleAI(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.aiLoop || runtime.finished) return;
    const hooks: AISeatHooks<Runtime> = {
      label: `gym ${roomId}`,
      isLive: (rt) => this.isLive(rt),
      afterStep: (rt) => this.refreshClock(rt),
      onGameOver: (rt) => this.finishBattle(rt.roomId, "game"),
      onIdle: (rt) => this.answerForLeader(rt),
    };
    runtime.aiLoop = this.driver
      .run(runtime, hooks)
      .catch((error) => console.error(`[gym ${roomId}] AI loop failed:`, error))
      .finally(() => {
        runtime.aiLoop = null;
        this.refreshClock(runtime);
      });
  }

  /** Resolves once the leader has nothing more to do for now (tests). */
  async aiIdle(roomId: string): Promise<void> {
    for (let runtime = this.runtimes.get(roomId); runtime?.aiLoop; runtime = this.runtimes.get(roomId)) {
      await runtime.aiLoop;
    }
  }

  private isLive(runtime: Runtime): boolean {
    return !runtime.finished && this.manager.getRoom(runtime.roomId) === runtime.room && runtime.room.status === "playing";
  }

  /**
   * The AI driver has no step but the battle waits on the leader: a step of the challenger's
   * Trainer that the leader answers (Challenge!, Blaine's Quiz, Chaos Gym's offer...: rooms.ts
   * pendingTrainerChoice, which the driver doesn't see). Answered with game-core's AI answer (the
   * Chaos Gym offer: declined), sent like an action. A battle still stuck on the leader ends
   * without a winner rather than blocking the gym.
   */
  private async answerForLeader(runtime: Runtime): Promise<boolean> {
    const state = runtime.room.gameState;
    if (!state || state.gamePhase !== GamePhase.Playing || awaitedSide(state) !== "player2") return false;
    const choice = pendingTrainerChoiceOf(state);
    if (choice) {
      const chaosOffer = runtime.room.pendingTrainer?.kind === "chaosOffer";
      let selection: string[] | null;
      try {
        selection = chaosOffer ? defaultSelection(choice.step) : withRoomRandom(() => runtime.rng.next(), () => answerOpponentTrainerStepForAI(state, choice.cardId, choice.step));
      } catch (error) {
        console.error(`[gym ${runtime.roomId}] AI answer to the Trainer step failed:`, error);
        selection = defaultSelection(choice.step);
      }
      const action = { type: "answerTrainerChoice", payload: { selection: selection ?? [] } };
      let result = await this.manager.executeServerAction(runtime.roomId, "player2", action);
      if (!result.success) {
        const fallback = defaultSelection(choice.step);
        if (fallback) result = await this.manager.executeServerAction(runtime.roomId, "player2", { ...action, payload: { selection: fallback } });
      }
      if (result.success) {
        this.broadcast?.(runtime.roomId, action.type, result);
        this.driver.holdForCoins(runtime, actionCoinBatches(result));
        if (result.gameOver) {
          await this.finishBattle(runtime.roomId, "game");
          return false;
        }
        return true;
      }
      console.error(`[gym ${runtime.roomId}] The leader could not answer the Trainer step: ${result.error}`);
    }
    console.error(`[gym ${runtime.roomId}] The battle waits on the leader but its AI has nothing to do: ended without a winner`);
    await this.forfeit(runtime.roomId, "error");
    return false;
  }

  // ---------------------------------------------------------------------------
  // End of the battle
  // ---------------------------------------------------------------------------

  /**
   * The challenger ran out of time / stayed away (a loss), or the battle broke (no winner): the
   * state ends here, the room gets it and `gameOver`, then the result.
   */
  private async forfeit(roomId: string, how: Exclude<GymBattleEnd, "game">): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    const state = runtime?.room.gameState;
    if (!runtime || !state || runtime.finished || state.gamePhase === GamePhase.GameOver) return;
    const message =
      how === "timeout" ? "Jugador 1 se quedó sin tiempo" : how === "disconnect" ? "Jugador 1 abandonó la batalla" : "La batalla se interrumpió";
    runtime.room.gameState = {
      ...state,
      gamePhase: GamePhase.GameOver,
      gameResult: "defeat",
      events: [...state.events, createGameEvent(message, "system")],
    };
    runtime.room.status = "finished";
    const io = this.io();
    if (io && runtime.room.player1SocketId) {
      io.to(runtime.room.player1SocketId).emit("gameState", {
        gameState: maskRoomState(this.manager, runtime.room, runtime.room.gameState!, "player1"),
        turnStartedAt: runtime.room.turnStartedAt,
        turnTimerDuration: runtime.room.turnTimerDuration,
      });
    }
    const reason =
      how === "timeout" ? "Se acabó tu tiempo" : how === "disconnect" ? "Abandonaste la batalla (desconexión)" : "La batalla se interrumpió por un error";
    io?.to(roomId).emit("gameOver", { winner: how === "error" ? null : "player2", reason });
    await this.finishBattle(roomId, how);
  }

  /**
   * The battle ended (`gameOver` is out or about to be): the medal on a victory (idempotent),
   * `gymBattleResult` to the challenger, the queue moves. Once per battle.
   */
  async finishBattle(roomId: string, how: GymBattleEnd): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    const state = runtime?.room.gameState;
    if (!runtime || !state || runtime.finished) return;
    runtime.finished = true;
    runtime.room.resultSettled = true;
    runtime.room.status = "finished";
    for (const timer of [runtime.clockTimer, runtime.graceTimer]) if (timer) clearTimeout(timer);
    runtime.clockTimer = runtime.graceTimer = undefined;
    // A challenger's action that ended the battle is broadcast (gameOver) right after this call
    await new Promise<void>((resolve) => setImmediate(resolve));

    const victory = how === "game" && state.gameResult === "victory";
    let medalGranted = false;
    if (victory) {
      try {
        medalGranted = (await grantMedal(runtime.userId, runtime.leader.medalId)).granted;
      } catch (error) {
        console.error(`[gym ${roomId}] Could not grant the medal ${runtime.leader.medalId} to ${runtime.userId}:`, error);
      }
    }
    console.log(`[gym ${roomId}] ${runtime.userId} ${victory ? "beat" : "lost to"} ${runtime.leader.id} (${how})${medalGranted ? `: medal ${runtime.leader.medalId}` : ""}`);
    const payload: GymBattleResultPayload = {
      leaderId: runtime.leader.id,
      mode: runtime.mode,
      victory,
      medalId: runtime.leader.medalId,
      medalGranted,
    };
    this.io()?.to(userRoom(runtime.userId)).emit("gymBattleResult", payload);
    try {
      this.onBattleEnd?.(roomId);
    } catch (error) {
      console.error(`[gym ${roomId}] onBattleEnd failed:`, error);
    }
    const timer = setTimeout(() => this.forget(roomId), FINISHED_ROOM_MS);
    timer.unref?.();
  }

  /**
   * The room was closed from the backoffice (closeRoomByAdmin already told the challenger and
   * dropped it): the battle ends without a result and the queue moves on.
   */
  closedByAdmin(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.finished) return;
    runtime.finished = true;
    for (const timer of [runtime.clockTimer, runtime.graceTimer]) if (timer) clearTimeout(timer);
    runtime.clockTimer = runtime.graceTimer = undefined;
    this.runtimes.delete(roomId);
    console.log(`[gym ${roomId}] closed by an admin`);
    try {
      this.onBattleEnd?.(roomId);
    } catch (error) {
      console.error(`[gym ${roomId}] onBattleEnd failed:`, error);
    }
  }

  private forget(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    for (const timer of [runtime.clockTimer, runtime.graceTimer]) if (timer) clearTimeout(timer);
    this.runtimes.delete(roomId);
    if (this.manager.getRoom(roomId) === runtime.room) this.manager.removeGymRoom(roomId);
  }
}
