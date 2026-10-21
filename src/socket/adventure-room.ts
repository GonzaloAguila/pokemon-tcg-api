/**
 * Modo Aventura battle rooms (design §5.2): a GameRoomManager room whose player 1 is the human
 * and player 2 the game-core AI driven here. The human plays through the usual `action` /
 * `requestCoinFlip` events (rooms.ts runs them, unchanged rules); after each one the AI takes its
 * steps (AdventureEngine.nextAIStep / applyAIStep) with a pause between them, every state goes to
 * the player masked, and the end of the battle is applied to the run exactly once
 * (adventure.service applyRunBattleResult). Nothing the client sends decides a result, a coin or
 * a seed.
 *
 * Randomness: one seeded generator per battle (hashSeed(run.seed:battle:attempt), its state
 * persisted), used as Math.random for every engine call of the room (withRoomRandom: synchronous
 * only, never across an await) and for every coin (the human's, through the room's coin source;
 * the AI's, through applyAIStep's `flip`). The lucky coin (passive lucky_coin) is the first coin
 * of an action the human takes on their own turn.
 *
 * Persistence: AdventureRun.battle = { roomId, startedAt, state (last 200 events), rngState,
 * aiPlan, humanActions } after every human action and AI step (debounced). A room missing from
 * memory (API restart, idle eviction, admin close) is rebuilt from it on `joinRoom` or
 * `POST …/battle`, and the AI continues where it was.
 */
import type { Server } from "socket.io";
import { Prisma, type AdventureRun } from "@prisma/client";
import type { GameState } from "@gonzaloaguila/game-core";
import { prisma } from "../lib/prisma.js";
import { getAdventure } from "../modules/adventure/content/load.js";
import { describeModifier } from "../modules/adventure/content/modifiers.js";
import type { BattleModifier } from "../modules/adventure/engine-types.js";
import { battleConfig } from "../modules/adventure/run-logic.js";
import {
  applyRunBattleResult,
  runStateOf,
  type AdventureBattleHost,
  type BattleEndReason,
  type BattleResultApplied,
  type BattleSnapshot,
} from "../modules/adventure/adventure.service.js";
import { neutralizeEvents, withRoomRandom, type ActionResult, type CoinFlipRequest, type GameRoom, type GameRoomManager } from "./rooms.js";
import { maskRoomState } from "./room-state.js";
import { userRoom } from "./io-registry.js";
import { getAdventureEngine, type AdventureEngine, type AICoins, type AIPlan, type Coin, type SeededRng } from "./adventure-engine.js";

/** Events kept in the snapshot (the client got the older ones live). */
export const SNAPSHOT_EVENTS = 200;
const SNAPSHOT_DEBOUNCE_MS = 1_000;
/** An adventure room without its player for this long leaves memory (rebuilt on rejoin). */
const IDLE_EVICT_MS = 30 * 60_000;
/** How long a finished battle's room stays (game-over screen), like rooms.ts FINISHED_ROOM_TTL_MS. */
const FINISHED_ROOM_MS = 120_000;
/** Safety net for one AI loop (a turn is a few dozen steps). */
const MAX_AI_STEPS_PER_LOOP = 500;
const MAX_AI_ERRORS = 3;

/** One human input of the battle, in order: with the seed it replays the battle (bug repro). */
export interface HumanInput {
  kind: "action" | "coinRequest";
  type: string;
  payload?: unknown;
  at: number;
}

interface Runtime {
  roomId: string;
  runId: string;
  userId: string;
  room: GameRoom;
  rng: SeededRng;
  plan: AIPlan | null;
  humanInputs: HumanInput[];
  startedAt: string;
  info: AdventureGameStartInfo;
  /** The lucky coin came up in the human's current action / coin request (marked after it). */
  luckyPending: boolean;
  aiLoop: Promise<void> | null;
  aiErrors: number;
  finished: boolean;
  lastActivity: number;
  pendingSnapshot?: BattleSnapshot;
  snapshotTimer?: ReturnType<typeof setTimeout>;
}

/** `gameStart.adventure` (the run bar on the battle screen). */
export interface AdventureGameStartInfo {
  runId: string;
  battle: number;
  battleCount: number;
  hearts: number;
  maxHearts: number;
  passives: string[];
  /** The battle's rules ("Reglas de la mesa"), Spanish lines. */
  rules: string[];
  rival: { name: string; trainerClass: string };
}

/** `adventureBattleResult`, to the player once the battle's result is applied. */
export interface AdventureBattleResultPayload {
  runId: string;
  victory: boolean;
  reason: BattleEndReason;
  run: BattleResultApplied["run"];
  events: BattleResultApplied["events"];
  reward: BattleResultApplied["reward"];
}

export interface AdventureRoomsOptions {
  manager: GameRoomManager;
  io: () => Server | null;
  engine?: () => AdventureEngine | null;
  /** Multiplies every AI step's pause (tests: 0). */
  aiDelayScale?: number;
  snapshotDebounceMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const rngCoin = (rng: SeededRng): Coin => (rng.next() < 0.5 ? "heads" : "tails");

function trimEvents(state: GameState): GameState {
  return state.events.length > SNAPSHOT_EVENTS ? { ...state, events: state.events.slice(-SNAPSHOT_EVENTS) } : state;
}

/** How the battle ended, from the engine's last victory line (neutralized by rooms.ts). */
export function battleEndReason(state: GameState, surrendered: boolean): BattleEndReason {
  if (surrendered) return "surrender";
  for (let i = state.events.length - 1; i >= 0; i--) {
    const message = state.events[i].message;
    if (!message.includes("Victoria")) continue;
    if (/no tiene más Pokémon/.test(message)) return "no-pokemon";
    if (/no tiene cartas para robar|mazo/i.test(message)) return "deck-out";
    return "prizes";
  }
  return "prizes";
}

export class AdventureRooms implements AdventureBattleHost {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly building = new Map<string, Promise<GameRoom | null>>();
  private readonly manager: GameRoomManager;
  private readonly io: () => Server | null;
  private readonly engineOf: () => AdventureEngine | null;
  private readonly aiDelayScale: number;
  private readonly snapshotDebounceMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: AdventureRoomsOptions) {
    this.manager = options.manager;
    this.io = options.io;
    this.engineOf = options.engine ?? getAdventureEngine;
    this.aiDelayScale = options.aiDelayScale ?? 1;
    this.snapshotDebounceMs = options.snapshotDebounceMs ?? SNAPSHOT_DEBOUNCE_MS;
  }

  /** Evict idle rooms every minute (call once at server start). */
  start(): void {
    this.sweepTimer ??= setInterval(() => void this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  /** Whether battles can be played (an engine is registered). */
  isAvailable(): boolean {
    return this.engineOf() !== null;
  }

  private engine(): AdventureEngine {
    const engine = this.engineOf();
    if (!engine) throw new Error("El Modo Aventura no está disponible en este servidor");
    return engine;
  }

  isAdventureRoom(roomId: string): boolean {
    return this.runtimes.has(roomId);
  }

  // ---------------------------------------------------------------------------
  // Building rooms (new battle or restored from the run's snapshot)
  // ---------------------------------------------------------------------------

  /** POST …/battle: the run's battle room exists (built fresh, or from its snapshot). */
  async ensureRoom(runId: string): Promise<void> {
    const row = await prisma.adventureRun.findUnique({ where: { id: runId } });
    const roomId = (row?.battle as unknown as BattleSnapshot | null)?.roomId;
    if (!row || !roomId || row.status !== "active" || row.phase !== "in_battle") return;
    await this.build(roomId, row);
  }

  /**
   * joinRoom on an adventure room id that isn't in memory: rebuild it from the user's run, or
   * null when it isn't the user's live battle.
   */
  async restore(roomId: string, userId: string): Promise<GameRoom | null> {
    const row = await prisma.adventureRun.findFirst({
      where: { userId, status: "active", phase: "in_battle", battle: { path: ["roomId"], equals: roomId } },
    });
    if (!row) return null;
    return this.build(roomId, row);
  }

  private build(roomId: string, row: AdventureRun): Promise<GameRoom | null> {
    const existing = this.manager.getRoom(roomId);
    if (existing?.adventure) return Promise.resolve(existing);
    let pending = this.building.get(roomId);
    if (!pending) {
      pending = this.buildNow(roomId, row).finally(() => this.building.delete(roomId));
      this.building.set(roomId, pending);
    }
    return pending;
  }

  private async buildNow(roomId: string, row: AdventureRun): Promise<GameRoom | null> {
    const engine = this.engine();
    const adventure = getAdventure(row.adventureId);
    if (!adventure) throw new Error(`Unknown adventure ${row.adventureId}`);
    const run = runStateOf(row);
    const battle = adventure.battles.find((b) => b.index === run.currentBattle)!;
    const snapshot = row.battle as unknown as BattleSnapshot;

    const rng = engine.createRng(engine.hashSeed(`${row.seed}:${run.currentBattle}:${run.attempt}`), snapshot.rngState);
    let state = snapshot.state as GameState | undefined;
    const fresh = !state;
    if (!state) {
      const created = withRoomRandom(() => rng.next(), () => engine.createGame(battleConfig(run, adventure)));
      state = { ...created, events: neutralizeEvents(created.events, 0, "Jugador 1", "Jugador 2") };
    }

    const rival = battle.opponent;
    const rivalName = rival.name === rival.trainerClass ? rival.name : `${rival.trainerClass} ${rival.name}`;
    const room = this.manager.createAdventureRoom({
      roomId,
      runId: row.id,
      userId: row.userId,
      rival: { username: rivalName, avatarId: null, titleId: null },
      gameState: state,
      engineRandom: () => rng.next(),
      coinSource: () => this.humanCoin(roomId),
    });
    const runtime: Runtime = {
      roomId,
      runId: row.id,
      userId: row.userId,
      room,
      rng,
      plan: (snapshot.aiPlan as AIPlan | undefined) ?? null,
      humanInputs: (snapshot.humanActions as HumanInput[] | undefined) ?? [],
      startedAt: snapshot.startedAt,
      info: {
        runId: row.id,
        battle: run.currentBattle,
        battleCount: adventure.battles.length,
        hearts: run.hearts,
        maxHearts: run.maxHearts,
        passives: run.passives,
        rules: battle.modifiers.map((m) => describeModifier(m as BattleModifier)),
        rival: { name: rival.name, trainerClass: rival.trainerClass },
      },
      luckyPending: false,
      aiLoop: null,
      aiErrors: 0,
      finished: false,
      lastActivity: Date.now(),
    };
    this.runtimes.set(roomId, runtime);

    if (fresh) {
      this.captureSnapshot(runtime);
      await this.flushSnapshot(roomId);
    }
    if (state.gamePhase === "GAME_OVER") {
      // The battle ended but its result wasn't applied (the DB failed): apply it now
      void this.finishBattle(roomId, false);
    } else {
      this.scheduleAI(roomId);
    }
    return room;
  }

  /** `gameStart.adventure` for the room's player. */
  gameStartInfo(roomId: string): AdventureGameStartInfo | null {
    return this.runtimes.get(roomId)?.info ?? null;
  }

  // ---------------------------------------------------------------------------
  // Human inputs
  // ---------------------------------------------------------------------------

  /**
   * The human's coins (rooms.ts calls this through the room's coin source while it runs their
   * action or coin request). Their lucky coin, if they have it and it's their own turn, is the
   * first one: heads; it is marked used once the action is through (`afterHuman*`).
   */
  private humanCoin(roomId: string): Coin {
    const runtime = this.runtimes.get(roomId)!;
    const state = runtime.room.gameState;
    if (!runtime.luckyPending && state && state.gamePhase === "PLAYING" && state.isPlayerTurn && this.engine().takeLuckyCoin(state, "player")) {
      runtime.luckyPending = true;
      return "heads";
    }
    return rngCoin(runtime.rng);
  }

  /** Mark the lucky coin used in the stored state (it came up in the human's last input). */
  private settleLuckyCoin(runtime: Runtime): void {
    if (!runtime.luckyPending) return;
    runtime.luckyPending = false;
    const state = runtime.room.gameState;
    const taken = state ? this.engine().takeLuckyCoin(state, "player") : null;
    if (taken) runtime.room.gameState = taken.state;
  }

  /**
   * After every human `action` on an adventure room (before its broadcast): the lucky coin, the
   * input log and the snapshot; then the AI's steps, or the end of the battle.
   */
  afterHumanAction(roomId: string, action: { type: string; payload?: unknown }, result: ActionResult): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    if (!result.success) {
      // A rejected action leaves the state (and the unused lucky coin) as they were
      runtime.luckyPending = false;
      return;
    }
    this.settleLuckyCoin(runtime);
    runtime.humanInputs.push({ kind: "action", type: action.type, payload: action.payload, at: Date.now() });
    runtime.lastActivity = Date.now();
    this.captureSnapshot(runtime);
    if (result.gameOver) {
      void this.finishBattle(roomId, action.type === "surrender");
      return;
    }
    this.scheduleAI(roomId);
  }

  /** After the human's `requestCoinFlip` (its coins are stored in the room until the effect resolves). */
  afterCoinRequest(roomId: string, request: CoinFlipRequest, success: boolean): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    if (!success) {
      runtime.luckyPending = false;
      return;
    }
    this.settleLuckyCoin(runtime);
    runtime.humanInputs.push({ kind: "coinRequest", type: request.purpose, payload: request, at: Date.now() });
    runtime.lastActivity = Date.now();
    this.captureSnapshot(runtime);
  }

  // ---------------------------------------------------------------------------
  // The AI seat
  // ---------------------------------------------------------------------------

  private scheduleAI(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.aiLoop || runtime.finished) return;
    runtime.aiLoop = this.runAI(runtime)
      .catch((error) => console.error(`[adventure ${roomId}] AI loop failed:`, error))
      .finally(() => {
        runtime.aiLoop = null;
      });
  }

  /** Resolves once the AI has nothing more to do for now (tests, shutdown). */
  async aiIdle(roomId: string): Promise<void> {
    for (let runtime = this.runtimes.get(roomId); runtime?.aiLoop; runtime = this.runtimes.get(roomId)) {
      await runtime.aiLoop;
    }
  }

  private isLive(runtime: Runtime): boolean {
    return !runtime.finished && this.manager.getRoom(runtime.roomId) === runtime.room && runtime.room.status === "playing";
  }

  /** The AI's steps while it has one; pauses between them happen outside withRoomRandom. */
  private async runAI(runtime: Runtime): Promise<void> {
    const engine = this.engine();
    const random = () => runtime.rng.next();
    await Promise.resolve(); // never inside the caller's stack (it may still be broadcasting)
    for (let steps = 0; steps < MAX_AI_STEPS_PER_LOOP; steps++) {
      if (!this.isLive(runtime) || !runtime.room.gameState) return;
      const peek = withRoomRandom(random, () => engine.nextAIStep(runtime.room.gameState!, runtime.plan));
      if (!peek) return;
      const delay = engine.stepDelay(peek.step) * this.aiDelayScale;
      // Always yield between steps, so a long AI turn never blocks the event loop
      await (delay > 0 ? sleep(delay) : new Promise<void>((resolve) => setImmediate(resolve)));
      if (!this.isLive(runtime) || !runtime.room.gameState) return;

      // The human may have acted during the pause: decide again on the current state
      const before = runtime.room.gameState;
      const next = withRoomRandom(random, () => engine.nextAIStep(before, runtime.plan));
      if (!next) return;
      const coins: AICoins[] = [];
      let after: GameState;
      try {
        after = withRoomRandom(random, () =>
          engine.applyAIStep(before, next.step, { flip: () => rngCoin(runtime.rng), onCoins: (c) => coins.push(c) }),
        );
      } catch (error) {
        runtime.aiErrors += 1;
        console.error(`[adventure ${runtime.roomId}] AI step failed (${runtime.aiErrors}/${MAX_AI_ERRORS}):`, error);
        runtime.plan = null; // replan from scratch
        if (runtime.aiErrors >= MAX_AI_ERRORS) return;
        continue;
      }
      const [self, other] = engine.aiEventsSpeakFor === "ai" ? ["Jugador 2", "Jugador 1"] : ["Jugador 1", "Jugador 2"];
      runtime.room.gameState = { ...after, events: neutralizeEvents(after.events, before.events.length, self, other) };
      runtime.plan = next.plan;
      runtime.room.turnStartedAt = Date.now();
      runtime.lastActivity = Date.now();
      this.emitAIStep(runtime, engine.stepActionType(next.step), coins);
      this.captureSnapshot(runtime);
      if (runtime.room.gameState.gamePhase === "GAME_OVER") {
        runtime.room.status = "finished";
        this.io()?.to(runtime.roomId).emit("gameOver", {
          winner: runtime.room.gameState.gameResult === "victory" ? "player1" : "player2",
          reason: runtime.room.gameState.events.at(-1)?.message ?? "Fin de la partida",
        });
        await this.finishBattle(runtime.roomId, false);
        return;
      }
    }
    console.error(`[adventure ${runtime.roomId}] AI loop stopped after ${MAX_AI_STEPS_PER_LOOP} steps`);
  }

  private emitAIStep(runtime: Runtime, actionType: string, coins: AICoins[]): void {
    const io = this.io();
    const room = runtime.room;
    if (!io || !room.gameState) return;
    io.to(runtime.roomId).emit("opponentAction", { type: actionType });
    for (const coin of coins) {
      // results: the acting player's (the AI's) coins; flippedBy relative to it, as for any player
      const flippedBy = coin.flippedBy?.map((who) => (who === "self" ? "attacker" : "defender"));
      io.to(runtime.roomId).emit("showCoinFlip", {
        attackName: coin.label,
        results: coin.results,
        count: coin.results.length,
        ...(flippedBy && flippedBy.some((who) => who === "defender") ? { flippedBy } : {}),
      });
    }
    if (room.player1SocketId) {
      io.to(room.player1SocketId).emit("gameState", {
        gameState: maskRoomState(this.manager, room, room.gameState, "player1"),
        turnStartedAt: room.turnStartedAt,
        turnTimerDuration: room.turnTimerDuration,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // End of the battle
  // ---------------------------------------------------------------------------

  /**
   * Apply the battle's end to the run once (`room.resultSettled`), then tell the player
   * (`adventureBattleResult`). The room stays for the game-over screen, then leaves memory.
   */
  async finishBattle(roomId: string, surrendered: boolean): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    const state = runtime?.room.gameState;
    if (!runtime || !state || runtime.finished) return;
    runtime.finished = true;
    runtime.room.resultSettled = true;
    runtime.room.status = "finished";
    if (runtime.snapshotTimer) clearTimeout(runtime.snapshotTimer);
    runtime.snapshotTimer = undefined;

    const victory = state.gameResult === "victory";
    const reason = battleEndReason(state, surrendered);
    try {
      // The final state is kept until the result is in, so a failed apply is retried on rejoin
      runtime.pendingSnapshot = { ...this.snapshotOf(runtime) };
      await this.flushSnapshot(roomId);
      const applied = await applyRunBattleResult(runtime.runId, { victory, reason, turns: state.turnNumber });
      if (applied) {
        const payload: AdventureBattleResultPayload = { runId: runtime.runId, victory, reason, run: applied.run, events: applied.events, reward: applied.reward };
        this.io()?.to(userRoom(runtime.userId)).emit("adventureBattleResult", payload);
      }
    } catch (error) {
      console.error(`[adventure ${roomId}] Could not apply the battle result (retried on rejoin):`, error);
    }
    const timer = setTimeout(() => this.forget(roomId), FINISHED_ROOM_MS);
    timer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Snapshots and memory
  // ---------------------------------------------------------------------------

  private snapshotOf(runtime: Runtime): BattleSnapshot {
    return {
      roomId: runtime.roomId,
      startedAt: runtime.startedAt,
      state: trimEvents(runtime.room.gameState!),
      rngState: runtime.rng.state(),
      aiPlan: runtime.plan,
      humanActions: runtime.humanInputs,
    };
  }

  /** Take the current snapshot now; it is written within `snapshotDebounceMs`. */
  private captureSnapshot(runtime: Runtime): void {
    if (!runtime.room.gameState) return;
    runtime.pendingSnapshot = this.snapshotOf(runtime);
    if (runtime.snapshotTimer) return;
    runtime.snapshotTimer = setTimeout(() => {
      runtime.snapshotTimer = undefined;
      this.flushSnapshot(runtime.roomId).catch((error) => console.error(`[adventure ${runtime.roomId}] snapshot failed:`, error));
    }, this.snapshotDebounceMs);
    runtime.snapshotTimer.unref?.();
  }

  /** Write the pending snapshot (only while the run is still in this battle). */
  async flushSnapshot(roomId: string): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    const snapshot = runtime?.pendingSnapshot;
    if (!runtime || !snapshot) return;
    runtime.pendingSnapshot = undefined;
    if (runtime.snapshotTimer) clearTimeout(runtime.snapshotTimer);
    runtime.snapshotTimer = undefined;
    await prisma.adventureRun.updateMany({
      where: { id: runtime.runId, status: "active", phase: "in_battle", battle: { path: ["roomId"], equals: roomId } },
      data: { battle: snapshot as unknown as Prisma.InputJsonValue },
    });
  }

  /** Drop a room from memory (its run keeps the snapshot). */
  async evict(roomId: string): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    await this.flushSnapshot(roomId);
    this.forget(roomId);
  }

  private forget(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (runtime?.snapshotTimer) clearTimeout(runtime.snapshotTimer);
    this.runtimes.delete(roomId);
    if (this.manager.getRoom(roomId) === runtime?.room) this.manager.removeAdventureRoom(roomId);
  }

  /** Evict rooms whose player has been away for IDLE_EVICT_MS (and whose AI is idle). */
  async sweep(now = Date.now()): Promise<void> {
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.finished || runtime.aiLoop || runtime.room.player1SocketId) continue;
      if (now - runtime.lastActivity < IDLE_EVICT_MS) continue;
      await this.evict(runtime.roomId).catch((error) => console.error(`[adventure ${runtime.roomId}] eviction failed:`, error));
    }
  }
}
