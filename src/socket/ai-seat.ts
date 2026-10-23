/**
 * The server's AI seat (player 2 of a GameRoomManager room, no user, no socket), shared by Modo
 * Aventura battles (adventure-room.ts) and Gym Leader battles (gym-room.ts): the game-core AI's
 * steps one at a time (AdventureEngine.nextAIStep / applyAIStep) with a pause between them, every
 * engine call inside the room's seeded Math.random (withRoomRandom, synchronous only), each step
 * sent to the human masked, and the game over when the AI's step ends the game.
 *
 * What a room does around the steps (snapshots, clocks, results) comes from its AISeatHooks.
 */
import type { Server } from "socket.io";
import { GamePhase, startPlayingPhase, type GameState } from "@gonzaloaguila/game-core";
import { neutralizeEvents, withRoomRandom, type ActionResult, type GameRoom, type GameRoomManager } from "./rooms.js";
import { maskRoomState } from "./room-state.js";
import type { AdventureEngine, AICoins, AIPlan, Coin, SeededRng } from "./adventure-engine.js";

/** Safety net for one AI loop (a turn is a few dozen steps). */
const MAX_AI_STEPS_PER_LOOP = 500;
export const MAX_AI_ERRORS = 3;

/**
 * How long the battle screen takes to show one `showCoinFlip` batch: the coin modal opens and
 * starts (~1 s), each coin spins (~300 ms), then the results stay up (~1.5 s).
 */
export const COIN_ANIMATION = { startMs: 1_000, perCoinMs: 300, holdMs: 1_500 } as const;

/**
 * Pause the AI keeps after coins were shown (the AI's own step, or the human's action) before its
 * next step or the game over: the batches play one after another. No coins = no pause.
 */
export function coinAnimationMs(batches: readonly number[]): number {
  return batches
    .filter((coins) => coins > 0)
    .reduce((total, coins) => total + COIN_ANIMATION.startMs + COIN_ANIMATION.perCoinMs * coins + COIN_ANIMATION.holdMs, 0);
}

/** Coins of each showCoinFlip the room got from a human action (rooms.ts ActionResult). */
export function actionCoinBatches(result: ActionResult): number[] {
  return [result.confusionCoinFlipInfo, result.coinFlipInfo].map((info) => (info ? info.results.length + (info.defenderResults?.length ?? 0) : 0));
}

export const rngCoin = (rng: SeededRng): Coin => (rng.next() < 0.5 ? "heads" : "tails");

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The AI seat's pauses, changeable at runtime (tests). */
export interface AISeatPacing {
  /** Multiplies every AI step's pause (tests: 0). */
  aiDelayScale: number;
  /** Multiplies the pause after coins (coinAnimationMs; tests: 0). */
  coinPauseScale: number;
  /** How the AI waits (tests record the pauses). */
  sleep: (ms: number) => Promise<void>;
}

/** What the driver keeps per room (adventure / gym runtimes extend it). */
export interface AISeat {
  roomId: string;
  room: GameRoom;
  rng: SeededRng;
  plan: AIPlan | null;
  /** The AI waits until then (ms epoch) for the coins last shown to finish animating. */
  coinsShownUntil: number;
  aiErrors: number;
}

export interface AISeatHooks<S extends AISeat> {
  /** Log prefix, e.g. "adventure adv-…". */
  label: string;
  /** The battle still runs here (not finished, the room is still this one and playing). */
  isLive(seat: S): boolean;
  /** After each AI step the room applied (and after the battle's start), before it is sent. */
  afterStep(seat: S): void;
  /** The AI's step ended the game: `gameOver` was sent; apply the result. */
  onGameOver(seat: S): Promise<void>;
  /**
   * The AI has no step now (the human must act, or something only the room can answer for the
   * AI). Return true when the room changed the state for the AI and the loop should look again.
   */
  onIdle?(seat: S): boolean | Promise<boolean>;
}

export class AISeatDriver {
  private pacingNow: AISeatPacing;

  constructor(
    private readonly manager: GameRoomManager,
    private readonly io: () => Server | null,
    private readonly engine: () => AdventureEngine,
    pacing: Partial<AISeatPacing> = {},
  ) {
    this.pacingNow = { aiDelayScale: pacing.aiDelayScale ?? 1, coinPauseScale: pacing.coinPauseScale ?? 1, sleep: pacing.sleep ?? defaultSleep };
  }

  get pacing(): AISeatPacing {
    return this.pacingNow;
  }

  /** Change the AI's pauses (tests); returns the previous ones, to restore them. */
  setPacing(pacing: Partial<AISeatPacing>): AISeatPacing {
    const previous = this.pacingNow;
    this.pacingNow = { ...previous, ...pacing };
    return previous;
  }

  /** The coins just shown in the room hold the AI until they finish animating. */
  holdForCoins(seat: AISeat, batches: readonly number[]): void {
    const ms = coinAnimationMs(batches) * this.pacingNow.coinPauseScale;
    if (ms > 0) seat.coinsShownUntil = Math.max(seat.coinsShownUntil, Date.now() + ms);
  }

  /** What is left of the coin animation hold (0 when none). */
  coinHoldLeft(seat: AISeat): number {
    return Math.max(0, seat.coinsShownUntil - Date.now());
  }

  /** The AI's steps while it has one; pauses between them happen outside withRoomRandom. */
  async run<S extends AISeat>(seat: S, hooks: AISeatHooks<S>): Promise<void> {
    const engine = this.engine();
    const random = () => seat.rng.next();
    await Promise.resolve(); // never inside the caller's stack (it may still be broadcasting)
    for (let steps = 0; steps < MAX_AI_STEPS_PER_LOOP; steps++) {
      if (!hooks.isLive(seat) || !seat.room.gameState) return;
      if (this.startIfBothReady(seat)) {
        hooks.afterStep(seat);
        this.emitAIStep(seat, null, []);
        continue;
      }
      const peek = withRoomRandom(random, () => engine.nextAIStep(seat.room.gameState!, seat.plan));
      if (!peek) {
        if (hooks.onIdle && (await hooks.onIdle(seat))) continue;
        return;
      }
      // The step's own pause, or longer while coins shown before it are still animating
      const delay = Math.max(engine.stepDelay(peek.step) * this.pacingNow.aiDelayScale, this.coinHoldLeft(seat));
      // Always yield between steps, so a long AI turn never blocks the event loop
      await (delay > 0 ? this.pacingNow.sleep(delay) : new Promise<void>((resolve) => setImmediate(resolve)));
      if (!hooks.isLive(seat) || !seat.room.gameState) return;

      // The human may have acted during the pause: decide again on the current state
      const before = seat.room.gameState;
      const next = withRoomRandom(random, () => engine.nextAIStep(before, seat.plan));
      if (!next) {
        if (hooks.onIdle && (await hooks.onIdle(seat))) continue;
        return;
      }
      const coins: AICoins[] = [];
      let after: GameState;
      try {
        after = withRoomRandom(random, () =>
          engine.applyAIStep(before, next.step, { flip: () => rngCoin(seat.rng), onCoins: (c) => coins.push(c) }),
        );
      } catch (error) {
        seat.aiErrors += 1;
        console.error(`[${hooks.label}] AI step failed (${seat.aiErrors}/${MAX_AI_ERRORS}):`, error);
        seat.plan = null; // replan from scratch
        if (seat.aiErrors >= MAX_AI_ERRORS) return;
        continue;
      }
      const [self, other] = engine.aiEventsSpeakFor === "ai" ? ["Jugador 2", "Jugador 1"] : ["Jugador 1", "Jugador 2"];
      seat.room.gameState = { ...after, events: neutralizeEvents(after.events, before.events.length, self, other) };
      seat.plan = next.plan;
      hooks.afterStep(seat);
      this.emitAIStep(seat, engine.stepActionType(next.step), coins);
      this.holdForCoins(seat, coins.map((c) => c.results.length));
      if (seat.room.gameState.gamePhase === "GAME_OVER") {
        seat.room.status = "finished"; // GAME_OVER: every human action is rejected meanwhile
        // The coins that decided the game play before the game over
        const hold = this.coinHoldLeft(seat);
        if (hold > 0) await this.pacingNow.sleep(hold);
        const final = seat.room.gameState;
        if (!final) return;
        this.io()?.to(seat.roomId).emit("gameOver", {
          winner: final.gameResult === "victory" ? "player1" : "player2",
          reason: final.events.at(-1)?.message ?? "Fin de la partida",
        });
        await hooks.onGameOver(seat);
        return;
      }
    }
    console.error(`[${hooks.label}] AI loop stopped after ${MAX_AI_STEPS_PER_LOOP} steps`);
  }

  /**
   * Both sides ready in the opening after the AI's setup: the battle starts here (the driver leaves
   * the starting player's coin to the room, like rooms.ts does when the human readies last). The
   * coin comes from the battle's generator; startPlayingPhase applies the room's setup rules.
   */
  private startIfBothReady(seat: AISeat): boolean {
    const state = seat.room.gameState!;
    if (state.gamePhase !== GamePhase.Mulligan || !state.playerReady || !state.opponentReady) return false;
    const coin = rngCoin(seat.rng);
    const started = withRoomRandom(() => seat.rng.next(), () => startPlayingPhase(state, coin));
    seat.room.gameState = { ...started, events: neutralizeEvents(started.events, state.events.length, "Jugador 1", "Jugador 2") };
    return true;
  }

  /** The AI's step to the player: its animation (`opponentAction`, none for the battle's start), coins, state. */
  emitAIStep(seat: AISeat, actionType: string | null, coins: AICoins[]): void {
    const io = this.io();
    const room = seat.room;
    if (!io || !room.gameState) return;
    if (actionType) io.to(seat.roomId).emit("opponentAction", { type: actionType });
    for (const coin of coins) {
      // results: the acting player's (the AI's) coins; flippedBy relative to it, as for any player
      const flippedBy = coin.flippedBy?.map((who) => (who === "self" ? "attacker" : "defender"));
      io.to(seat.roomId).emit("showCoinFlip", {
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
}
