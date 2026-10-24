/**
 * Gym Leader battles (docs/gym-leaders.md): a challenge is a SERIES of up to 3 games (first to 2
 * wins), each its own GameRoomManager room (`gym-…`) whose player 1 is the challenger and player 2
 * the leader, played by the game-core AI through the shared AI seat driver (ai-seat.ts, like Modo
 * Aventura). The challenger plays with the usual `joinRoom` / `action` / `requestCoinFlip`; every
 * coin and engine call of a room comes from one seeded generator per game (seeded from the CSPRNG;
 * nothing is persisted: an API restart ends the series).
 *
 * The first game's room is built when the challenge is accepted (challengeGym); each next one when
 * the previous game ends undecided. Every game starts with the version's fixed Stadium in play
 * (Pewter City Gym). The challenger has a clock: `turnClockMs` per turn (the opening, each of their
 * turns, and an answer they owe on the leader's turn: one clock per such turn) — running out loses
 * that game — and `disconnectGraceMs` away from a game (no seat socket, also before entering it
 * the first time) — running out forfeits the series. The end of the series: `gymSeries` finished,
 * then `gymBattleResult` (score + the version's first-victory rewards, once), and the table is
 * freed (`onBattleEnd`). A series that ends with an error (no winner) refunds the entry cost and
 * gives its daily attempt back.
 * Each game ends as a match row of the admin's match history (mode "gym", nothing settled); no
 * settlement, XP, chat, spectators or bets.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import { answerOpponentTrainerStepForAI, createGameEvent, GamePhase, type GameState, type SelectionStep } from "@gonzaloaguila/game-core";
import type { CardEntry, GymLeaderDef, GymMode } from "../modules/gym/content/types.js";
import { leaderRules, versionLabel } from "../modules/gym/content/index.js";
import { GYM_BEST_OF, GYM_TIMING } from "../modules/gym/gym.config.js";
import { battleDeck } from "../modules/gym/gym-decks.js";
import { withFixedStadium } from "../modules/gym/fixed-stadium.js";
import { grantGymVictoryRewards, type GrantedGymRewards } from "../modules/gym/rewards.js";
import type { GymScore, GymSeriesState } from "../modules/gym/gym.service.js";
import { addCoins } from "../modules/users/users.service.js";
import { attemptsOf, giveBackAttempt } from "../modules/gym/attempts.js";
import { recordGymGame, type GymGameOutcome } from "../modules/gym/history.js";
import { challengerDeckSource } from "../modules/gym/challenger-deck.js";
import { checkAndUpdateProgress } from "../modules/achievements/achievements.service.js";
import { createChallengeTracker, matchChallengeData } from "./challenge-tracker.js";
import { awaitedSide, defaultSelection, neutralizeEvents, withRoomRandom, type ActionResult, type GameRoom, type GameRoomManager } from "./rooms.js";
import { maskRoomState } from "./room-state.js";
import { DEFAULT_COSMETICS, loadSeatCosmetics, type SeatCosmetics } from "./room-cosmetics.js";
import { userRoom } from "./io-registry.js";
import type { AdventureEngine } from "./adventure-engine.js";
import { gameCoreAdventureEngine } from "./adventure-engine-game-core.js";
import { AISeatDriver, actionCoinBatches, rngCoin, type AISeat, type AISeatHooks, type AISeatPacing } from "./ai-seat.js";

/** How long a finished game's room stays (game-over screen), like rooms.ts FINISHED_ROOM_TTL_MS. */
const FINISHED_ROOM_MS = 120_000;
/** Games needed to win the series. */
const WINS_NEEDED = Math.floor(GYM_BEST_OF / 2) + 1;
/** Drawn games don't count: a series still undecided after this many games goes to the score (a tie to the leader). */
const MAX_GAMES = GYM_BEST_OF + 2;
/**
 * Each outcome's winner seat for the challenge tracker (player 1 = the challenger): a lost game on
 * time or away from it is the leader's, a broken or admin-closed game has none.
 */
const GYM_WINNER: Record<GymGameOutcome, "player1" | "player2" | "draw" | null> = {
  victory: "player1",
  defeat: "player2",
  timeout: "player2",
  disconnect: "player2",
  draw: "draw",
  error: null,
  admin: null,
};
/** Transaction log types of the entry cost's refund. */
export const GYM_ENTRY_REFUND_TRANSACTION = "gym_entry_refund";

/** `gameStart.gym` (contract, + the series' game and score so a reconnect can show them). */
export interface GymGameStartInfo {
  leaderId: string;
  name: string;
  title: string;
  mode: GymMode;
  medalId: string;
  avatarId: string;
  game: number;
  bestOf: number;
  score: GymScore;
}

/**
 * `gymBattleResult` (contract), once per series: `victory` = won the series; `medalGranted` = this
 * victory gave the medal for the first time; `rewards` = what the version's first series victory
 * granted now (null otherwise).
 */
export interface GymBattleResultPayload {
  leaderId: string;
  mode: GymMode;
  victory: boolean;
  medalId: string;
  medalGranted: boolean;
  rewards: GrantedGymRewards | null;
  score: GymScore;
}

/** How a game ended. */
export type GymBattleEnd = "game" | "timeout" | "disconnect" | "error";

interface Series {
  id: string;
  userId: string;
  leader: GymLeaderDef;
  mode: GymMode;
  deckId: string;
  playerDeck: CardEntry[];
  /** Coins the challenge cost (refunded if the series ends with an error). */
  entryCost: number;
  /** The daily attempt it used (given back if the series ends with an error). */
  attemptId: string | null;
  game: number;
  score: GymScore;
  finished: boolean;
}

interface Runtime extends AISeat {
  series: Series;
  /** This room's game of the series. */
  game: number;
  info: GymGameStartInfo;
  aiLoop: Promise<void> | null;
  finished: boolean;
  /** The challenger's clock: one per turn (`key`), ends at `deadline`. */
  clock: { key: string; deadline: number } | null;
  clockTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** The challenger's seat socket was in this room once. */
  entered: boolean;
  /** What the leader's emotes react to: the battle started, its Prizes left (a drop = a Knock Out). */
  reactions: { started: boolean; leaderPrizes: number | null };
  /** When this game's room was built (its match row's start). */
  startedAt: Date;
}

export interface GymTiming {
  turnClockMs: number;
  disconnectGraceMs: number;
  emoteDelayMs: number;
}

export interface GymSeriesCallbacks {
  /** Broadcast an action the server took for the leader (handlers.ts broadcastActionResult). */
  broadcast?: (roomId: string, actionType: string, result: ActionResult) => void;
  /** A game ended undecided: the series goes on in `nextRoomId` (gymService.nextGame). */
  onNextGame?: (roomId: string, nextRoomId: string, game: number, score: GymScore) => void;
  /** The challenger entered a game created after the previous one (gymService.gameEntered). */
  onGameEntered?: (roomId: string) => void;
  /** The series ended (its result is out); `roomId` = its last game: the table is free. */
  onBattleEnd?: (roomId: string) => void;
}

export interface GymRoomsOptions extends GymSeriesCallbacks {
  manager: GameRoomManager;
  io: () => Server | null;
  engine?: () => AdventureEngine;
  /** Writes a finished game's match row (tests replace it). */
  recordGame?: typeof recordGymGame;
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
  private readonly recordGame: typeof recordGymGame;
  private callbacks: GymSeriesCallbacks;
  private timing: GymTiming = {
    turnClockMs: GYM_TIMING.turnClockMs,
    disconnectGraceMs: GYM_TIMING.disconnectGraceMs,
    emoteDelayMs: GYM_TIMING.emoteDelayMs,
  };

  constructor(options: GymRoomsOptions) {
    this.manager = options.manager;
    this.io = options.io;
    this.engine = options.engine ?? (() => gameCoreAdventureEngine);
    this.recordGame = options.recordGame ?? recordGymGame;
    this.driver = new AISeatDriver(this.manager, this.io, this.engine);
    this.callbacks = { broadcast: options.broadcast, onNextGame: options.onNextGame, onGameEntered: options.onGameEntered, onBattleEnd: options.onBattleEnd };
  }

  /** Wire the callbacks (handlers.ts, once the io server and the gym state exist). */
  setCallbacks(callbacks: GymSeriesCallbacks): void {
    for (const [key, value] of Object.entries(callbacks)) if (value) (this.callbacks as Record<string, unknown>)[key] = value;
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
    const runtime = this.runtimes.get(roomId);
    return runtime ? { ...runtime.info, score: { ...runtime.series.score } } : null;
  }

  // ---------------------------------------------------------------------------
  // Building the games
  // ---------------------------------------------------------------------------

  /**
   * Start the series (the challenge was accepted: deck checked, entry cost paid): its first game's
   * room, `roomId` (gymService.reserve's).
   */
  async startSeries(input: {
    roomId: string;
    userId: string;
    deckId: string;
    leader: GymLeaderDef;
    mode: GymMode;
    playerDeck: CardEntry[];
    entryCost: number;
    attemptId?: string | null;
  }): Promise<GameRoom> {
    const series: Series = {
      id: randomUUID(),
      userId: input.userId,
      leader: input.leader,
      mode: input.mode,
      deckId: input.deckId,
      playerDeck: input.playerDeck.map((e) => ({ ...e })),
      entryCost: input.entryCost,
      attemptId: input.attemptId ?? null,
      game: 1,
      score: { challenger: 0, leader: 0 },
      finished: false,
    };
    console.log(`[gym ${input.roomId}] ${input.userId} challenges ${versionLabel(input.leader, input.mode)} (best of ${GYM_BEST_OF})`);
    return this.buildGame(input.roomId, series);
  }

  /**
   * Build a game's room (its opening: MULLIGAN). The leader plays the version's saved deck
   * (backoffice), else its content default; the version's fixed Stadium is in play from the start.
   * Standard rules: 6 Prizes, 7-card hand, no adventure modifiers or passives.
   */
  private async buildGame(roomId: string, series: Series): Promise<GameRoom> {
    const { userId, deckId, leader, mode } = series;
    const opponentDeck = await battleDeck(leader, mode);
    if (!opponentDeck) throw new Error(`${leader.id} has no ${mode} deck`);
    const engine = this.engine();
    const rng = engine.createRng(engine.hashSeed(`${roomId}:${randomUUID()}`));
    const created = withRoomRandom(
      () => rng.next(),
      () =>
        engine.createGame({
          playerDeck: series.playerDeck.map((e) => ({ ...e })),
          opponentDeck: opponentDeck.map((e) => ({ ...e })),
          prizeCount: 6,
          openingHand: 7,
          playerPassives: [],
          modifiers: [],
        }),
    );
    // createAdventureGame opens the log with an adventure line: a gym battle names its leader instead
    const events = created.events.map((e) =>
      e.message === "Batalla de aventura inicializada"
        ? { ...e, message: `Comienza la batalla contra ${leader.name} (partida ${series.game} de ${GYM_BEST_OF})` }
        : e,
    );
    const opening = withFixedStadium({ ...created, events }, leaderRules(leader, mode)?.fixedStadiumId, roomId);
    const state: GameState = { ...opening, events: neutralizeEvents(opening.events, 0, "Jugador 1", "Jugador 2") };

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
    // Challenge achievements: the challenger's deck as played (the leader's is the server's)
    room.challengeTracker = createChallengeTracker(state, { player1: challengerDeckSource(deckId), player2: "theme" });

    const runtime: Runtime = {
      roomId,
      room,
      rng,
      plan: null,
      coinsShownUntil: 0,
      aiErrors: 0,
      series,
      game: series.game,
      info: {
        leaderId: leader.id,
        name: leader.name,
        title: leader.title,
        mode,
        medalId: leader.medalId,
        avatarId: leader.avatarId,
        game: series.game,
        bestOf: GYM_BEST_OF,
        score: { ...series.score },
      },
      aiLoop: null,
      finished: false,
      clock: null,
      entered: false,
      // The battle-start emote is the series' (its first game only)
      reactions: { started: series.game > 1, leaderPrizes: null },
      startedAt: new Date(),
    };
    this.runtimes.set(roomId, runtime);
    console.log(`[gym ${roomId}] game ${series.game} of ${userId} vs ${leader.id} (${mode})`);
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
    this.leaderReacts(runtime);
    this.scheduleAI(roomId);
  }

  /**
   * The challenger's seat socket came or went (joinRoom, leaveRoom, disconnect): away from the
   * game, the disconnect grace runs; back, it stops. Entering a next game makes it "playing".
   */
  seatChanged(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.finished) return;
    if (runtime.room.player1SocketId) {
      if (runtime.graceTimer) clearTimeout(runtime.graceTimer);
      runtime.graceTimer = undefined;
      if (!runtime.entered) {
        runtime.entered = true;
        this.callbacks.onGameEntered?.(roomId);
      }
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

  /** Whether the game waits on the challenger now (opening not ready, their turn, an answer they owe). */
  private challengerAwaited(state: GameState): boolean {
    if (state.gamePhase === GamePhase.GameOver) return false;
    if (state.gamePhase === GamePhase.Mulligan || state.gamePhase === GamePhase.Setup) return !state.playerReady;
    return awaitedSide(state) === "player1";
  }

  /**
   * The clock runs while the game waits on the challenger: a new one (full time) for each turn,
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
      afterStep: (rt) => {
        this.refreshClock(rt);
        this.leaderReacts(rt);
      },
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
   * The AI driver has no step but the game waits on the leader: a step of the challenger's
   * Trainer that the leader answers (Challenge!, Blaine's Quiz, Chaos Gym's offer...: rooms.ts
   * pendingTrainerChoice, which the driver doesn't see). Answered with game-core's AI answer (the
   * Chaos Gym offer: declined), sent like an action. A game still stuck on the leader ends the
   * series without a winner rather than blocking the gym.
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
        this.callbacks.broadcast?.(runtime.roomId, action.type, result);
        this.driver.holdForCoins(runtime, actionCoinBatches(result));
        if (result.gameOver) {
          await this.finishBattle(runtime.roomId, "game");
          return false;
        }
        return true;
      }
      console.error(`[gym ${runtime.roomId}] The leader could not answer the Trainer step: ${result.error}`);
    }
    console.error(`[gym ${runtime.roomId}] The game waits on the leader but its AI has nothing to do: the series ends without a winner`);
    await this.forfeit(runtime.roomId, "error");
    return false;
  }

  // ---------------------------------------------------------------------------
  // The leader's emotes
  // ---------------------------------------------------------------------------

  /**
   * After every state change: the leader's emote when the series starts (the first game's first
   * PLAYING state) and when it takes a Prize (it knocked out a challenger's Pokémon). Its victory
   * (of the series) is in finishSeries.
   */
  private leaderReacts(runtime: Runtime): void {
    const state = runtime.room.gameState;
    const emotes = runtime.series.leader.emotes;
    if (!state || !emotes || runtime.finished || state.gamePhase !== GamePhase.Playing) return;
    // The challenger is "player": the leader's Prizes are the opponent's
    const leaderPrizes = state.opponentPrizes.length;
    const previous = runtime.reactions.leaderPrizes;
    runtime.reactions.leaderPrizes = leaderPrizes;
    if (!runtime.reactions.started) {
      runtime.reactions.started = true;
      this.leaderEmote(runtime, emotes.battleStart);
    } else if (previous !== null && leaderPrizes < previous) {
      this.leaderEmote(runtime, emotes.knockOut);
    }
  }

  /** `emote` on the leader's side (player2), like a player's (handlers.ts sendEmote), a moment later. */
  private leaderEmote(runtime: Runtime, emoteId: string | undefined): void {
    if (!emoteId) return;
    const send = () => {
      if (this.manager.getRoom(runtime.roomId) !== runtime.room) return;
      this.io()?.to(runtime.roomId).emit("emote", {
        roomId: runtime.roomId,
        side: "player2",
        userId: `gym:${runtime.series.leader.id}`,
        emoteId,
        sentAt: Date.now(),
      });
    };
    const timer = setTimeout(send, this.timing.emoteDelayMs);
    timer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // End of a game, end of the series
  // ---------------------------------------------------------------------------

  /**
   * The challenger ran out of time (a lost game) / stayed away (the series is forfeited), or the
   * game broke (no winner): the state ends here, the room gets it and `gameOver`, then the result.
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
   * A game ended (`gameOver` is out or about to be): the score, then the next game's room when
   * the series is undecided, else the end of the series. Once per game.
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
    // A challenger's action that ended the game is broadcast (gameOver) right after this call
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.forgetLater(roomId);

    const { series } = runtime;
    if (series.finished) return;
    // A lost game on time counts as a lost game; away too long forfeits the series
    if (how === "game" && state.gameResult === "victory") series.score.challenger += 1;
    else if (how === "timeout" || (how === "game" && state.gameResult === "defeat")) series.score.leader += 1;
    console.log(`[gym ${roomId}] game ${runtime.game} ended (${how}${how === "game" ? `: ${state.gameResult}` : ""}), ${series.score.challenger}-${series.score.leader}`);
    const result = state.gameResult;
    this.record(runtime, how !== "game" ? how : result === "victory" || result === "defeat" ? result : "draw", state.turnNumber ?? 0);

    if (how === "error") return this.finishSeries(runtime, "error");
    if (how === "disconnect") return this.finishSeries(runtime, "leader");
    if (series.score.challenger >= WINS_NEEDED) return this.finishSeries(runtime, "challenger");
    if (series.score.leader >= WINS_NEEDED) return this.finishSeries(runtime, "leader");
    if (series.game >= MAX_GAMES) return this.finishSeries(runtime, series.score.challenger > series.score.leader ? "challenger" : "leader");

    // Undecided: the next game's room (its disconnect grace runs from now: the challenger enters it)
    series.game += 1;
    const nextRoomId = `gym-${randomUUID()}`;
    try {
      await this.buildGame(nextRoomId, series);
    } catch (error) {
      console.error(`[gym ${roomId}] Could not build game ${series.game}:`, error);
      series.game -= 1;
      return this.finishSeries(runtime, "error");
    }
    try {
      this.callbacks.onNextGame?.(roomId, nextRoomId, series.game, { ...series.score });
    } catch (error) {
      console.error(`[gym ${roomId}] onNextGame failed:`, error);
    }
  }

  /**
   * The series is decided (or broke: `error`, no winner): `gymSeries` finished, the rewards on the
   * challenger's first series victory in this version (idempotent), `gymBattleResult`, the entry
   * cost back after an error, the table freed. Once per series.
   */
  private async finishSeries(runtime: Runtime, winner: "challenger" | "leader" | "error"): Promise<void> {
    const { series } = runtime;
    if (series.finished) return;
    series.finished = true;
    const { leader, mode, userId } = series;
    const victory = winner === "challenger";
    let rewards: GrantedGymRewards | null = null;
    if (victory) {
      try {
        rewards = await grantGymVictoryRewards(userId, leader, mode);
      } catch (error) {
        console.error(`[gym ${runtime.roomId}] Could not grant the ${leader.id} ${mode} rewards to ${userId}:`, error);
      }
    }
    if (winner === "error") await this.refund(series, runtime.roomId);
    // The leader celebrates a series it won (not one that broke)
    if (winner === "leader") this.leaderEmote(runtime, leader.emotes?.victory);
    console.log(
      `[gym ${runtime.roomId}] series of ${userId} vs ${leader.id} ${mode}: ${winner} (${series.score.challenger}-${series.score.leader})${rewards ? `: first victory ${JSON.stringify(rewards)}` : ""}`,
    );
    const io = this.io();
    io?.to(userRoom(userId)).emit("gymSeries", this.seriesState(series, runtime.roomId, "finished"));
    const payload: GymBattleResultPayload = {
      leaderId: leader.id,
      mode,
      victory,
      medalId: leader.medalId,
      medalGranted: !!rewards?.medalId,
      rewards,
      score: { ...series.score },
    };
    io?.to(userRoom(userId)).emit("gymBattleResult", payload);
    this.endSeries(runtime.roomId);
  }

  /**
   * The game's match row (admin match history + the challenger's challenge data), in the
   * background: a failure is only logged. Then the challenger's challenge achievements are
   * re-checked, like after a settlement (match-settlement.ts notifySettlement).
   */
  private record(runtime: Runtime, outcome: GymGameOutcome, finalTurn: number): void {
    const { series } = runtime;
    const tracker = runtime.room.challengeTracker;
    const challenge = tracker ? matchChallengeData(tracker, runtime.room.gameState, GYM_WINNER[outcome]) : undefined;
    void this.recordGame({
      roomId: runtime.roomId,
      userId: series.userId,
      outcome,
      finalTurn,
      startedAt: runtime.startedAt,
      info: { leaderId: series.leader.id, leaderName: series.leader.name, mode: series.mode, game: runtime.game, bestOf: GYM_BEST_OF, score: { ...series.score } },
      ...(challenge ? { challenge } : {}),
    })
      .then(() => {
        if (!challenge) return;
        checkAndUpdateProgress(series.userId, { challenges: true }).catch((error) =>
          console.error(`[gym ${runtime.roomId}] Could not check the challenges of ${series.userId}:`, error),
        );
      })
      .catch((error) => console.error(`[gym ${runtime.roomId}] Could not record game ${runtime.game} of ${series.userId}:`, error));
  }

  private seriesState(series: Series, roomId: string, status: GymSeriesState["status"]): GymSeriesState {
    return { leaderId: series.leader.id, mode: series.mode, game: series.game, score: { ...series.score }, roomId, status };
  }

  /** The entry cost and the daily attempt back (a series that ended without a winner), then `gymAttempts`. */
  private async refund(series: Series, roomId: string): Promise<void> {
    if (series.entryCost > 0) {
      try {
        await addCoins(series.userId, series.entryCost, GYM_ENTRY_REFUND_TRANSACTION, `Reto a ${versionLabel(series.leader, series.mode)} devuelto: +${series.entryCost} monedas`);
      } catch (error) {
        console.error(`[gym ${roomId}] Could not refund the entry cost to ${series.userId}:`, error);
      }
    }
    if (series.attemptId) {
      try {
        await giveBackAttempt(series.attemptId);
        this.io()?.to(userRoom(series.userId)).emit("gymAttempts", await attemptsOf(series.userId));
      } catch (error) {
        console.error(`[gym ${roomId}] Could not give the attempt back to ${series.userId}:`, error);
      }
    }
  }

  private endSeries(roomId: string): void {
    try {
      this.callbacks.onBattleEnd?.(roomId);
    } catch (error) {
      console.error(`[gym ${roomId}] onBattleEnd failed:`, error);
    }
  }

  /**
   * The room was closed from the backoffice (closeRoomByAdmin already told the challenger and
   * dropped it): the series ends without a result (no gymBattleResult; the entry cost back) and
   * the table is free.
   */
  closedByAdmin(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.finished) return;
    runtime.finished = true;
    for (const timer of [runtime.clockTimer, runtime.graceTimer]) if (timer) clearTimeout(timer);
    runtime.clockTimer = runtime.graceTimer = undefined;
    this.runtimes.delete(roomId);
    console.log(`[gym ${roomId}] closed by an admin`);
    this.record(runtime, "admin", runtime.room.gameState?.turnNumber ?? 0);
    const { series } = runtime;
    if (series.finished) return;
    series.finished = true;
    this.io()?.to(userRoom(series.userId)).emit("gymSeries", this.seriesState(series, roomId, "finished"));
    void this.refund(series, roomId);
    this.endSeries(roomId);
  }

  private forgetLater(roomId: string): void {
    const timer = setTimeout(() => this.forget(roomId), FINISHED_ROOM_MS);
    timer.unref?.();
  }

  private forget(roomId: string): void {
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return;
    for (const timer of [runtime.clockTimer, runtime.graceTimer]) if (timer) clearTimeout(timer);
    this.runtimes.delete(roomId);
    if (this.manager.getRoom(roomId) === runtime.room) this.manager.removeGymRoom(roomId);
  }
}

