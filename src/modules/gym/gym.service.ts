/**
 * Gym state (docs/gym-leaders.md): which leaders' tables are open and the series each one is
 * playing. In memory (an API restart closes every gym and drops its series).
 *
 * A table is one leader's version (leader × mode: "Brock" and "Brock EXPERT" are two tables, each
 * opened and closed on its own). It is `closed` (not listed), `open` (takes a challenger until
 * `closesAt`) or `closing` (no new challenges; still listed while its series runs). One series
 * (best of 3 games, each its own room) at a time per table, no queue: a free table is challenged
 * (`reserve`, the first one wins), stays in battle for the whole series and is free again when
 * it ends. A user plays at most one gym series at a time. The deck checks, the entry cost and the
 * rooms (async) are the socket layer's / gym-room.ts's; this class only keeps the state and tells
 * its listeners what changed.
 */
import { randomUUID } from "node:crypto";
import { getGymLeader, GYM_LEADERS, leaderModes, leaderRewards, leaderRules, type GymLeaderDef, type GymMode } from "./content/index.js";
import { GYM_BEST_OF, GYM_SCHEDULE, GYM_TIMING, type GymScheduleConfig } from "./gym.config.js";
import { publicGymRules } from "./rules.js";

export type GymStatus = "closed" | "open" | "closing";

/** A player-facing refusal (Spanish): ack `{ ok: false, error }`, HTTP 409. */
export class GymError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GymError";
  }
}

export const GYM_ERRORS = {
  unknownLeader: "Ese gimnasio no existe",
  modeUnavailable: "Ese desafío todavía no está disponible",
  closed: "El gimnasio está cerrado",
  alreadyInBattle: "Ya estás en una batalla de gimnasio",
  /** "Necesitás 100 monedas para retar a Brock" */
  entryCost: (cost: number, leaderName: string) => `Necesitás ${cost} monedas para retar a ${leaderName}`,
  /** "Brock está en batalla: esperá a que termine" */
  inBattle: (leaderName: string) => `${leaderName} está en batalla: esperá a que termine`,
} as const;

/** Who plays a table's battle (the card says "Brock vs X"). */
export interface GymChallenger {
  username: string;
  avatarId: string | null;
}

export interface GymScore {
  challenger: number;
  leader: number;
}

/** A table's series (its games are rooms: `roomId` is the current one). */
export interface GymBattle {
  userId: string;
  roomId: string;
  challenger: GymChallenger;
  /** starting = reserved, the first game's room being built (not shown yet); playing = a game's room exists. */
  status: "starting" | "playing";
  startedAt: number;
  /** The current game (1–3) and the games won so far. */
  game: number;
  score: GymScore;
  /** The current game was created after the previous one ended and its challenger hasn't entered yet. */
  awaitingEntry: boolean;
}

interface TableState {
  leader: GymLeaderDef;
  mode: GymMode;
  status: GymStatus;
  openedAt: number | null;
  closesAt: number | null;
  battle: GymBattle | null;
  /** Scheduler: when it opens next (null = not scheduled). */
  nextOpenAt: number | null;
  closeTimer?: ReturnType<typeof setTimeout>;
  openTimer?: ReturnType<typeof setTimeout>;
}

/** `gymTables` rows (contract). */
export interface GymTable {
  leaderId: string;
  name: string;
  title: string;
  avatarId: string;
  medalId: string;
  mode: GymMode;
  rules: ReturnType<typeof publicGymRules>;
  rewards: { medalId: string | null; coins: number; coinId: string | null; cardBackId: string | null };
  /** Coins a challenge costs. */
  entryCost: number;
  bestOf: number;
  status: "open" | "closing";
  closesAt: number;
  inBattle: boolean;
  challenger: GymChallenger | null;
  series: { game: number; score: GymScore } | null;
}

/**
 * `gymSeries` / `getGymTables`'s `mySeries` (contract): the user's series in progress.
 * `playing` = `roomId` is the game being played; `next` = the previous game ended and `roomId`
 * is the next one (not entered yet); `finished` (only in the `gymSeries` event) = over, `roomId`
 * = its last game.
 */
export interface GymSeriesState {
  leaderId: string;
  mode: GymMode;
  game: number;
  score: GymScore;
  roomId: string;
  status: "playing" | "next" | "finished";
}

export interface GymAdminStatus {
  leaderId: string;
  name: string;
  title: string;
  avatarId: string;
  /** This row's version (one row per leader and version); `modes` = every version the leader has. */
  mode: GymMode;
  modes: GymMode[];
  status: GymStatus;
  openedAt: number | null;
  closesAt: number | null;
  inBattle: boolean;
  current: { userId: string; username: string; roomId: string; startedAt: number; game: number; score: GymScore } | null;
  schedule: { enabled: boolean; nextOpenAt: number | null; minGapMinutes: number; maxGapMinutes: number; openMinutes: number };
}

export interface GymListeners {
  /** Something visible changed: broadcast `gymTables`; `users` get their own `gymSeries` (in progress). */
  onChange?: (users: string[]) => void;
}

export interface GymServiceOptions {
  schedule?: Partial<GymScheduleConfig>;
  now?: () => number;
  random?: () => number;
}

const tableKey = (leaderId: string, mode: GymMode) => `${leaderId}:${mode}`;

export class GymService {
  private readonly tablesByKey = new Map<string, TableState>();
  private listeners: GymListeners = {};
  private schedule: GymScheduleConfig;
  private readonly now: () => number;
  private readonly random: () => number;
  private started = false;

  constructor(options: GymServiceOptions = {}) {
    this.schedule = { ...GYM_SCHEDULE, ...options.schedule };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.fresh();
  }

  private fresh(): void {
    this.tablesByKey.clear();
    for (const leader of GYM_LEADERS) {
      for (const mode of leaderModes(leader)) {
        this.tablesByKey.set(tableKey(leader.id, mode), { leader, mode, status: "closed", openedAt: null, closesAt: null, battle: null, nextOpenAt: null });
      }
    }
  }

  setListeners(listeners: GymListeners): void {
    this.listeners = listeners;
  }

  /** Change the scheduler (tests, or the owner turning it on). */
  configure(options: { schedule?: Partial<GymScheduleConfig> }): void {
    if (options.schedule) this.schedule = { ...this.schedule, ...options.schedule };
    if (this.started) for (const state of this.tablesByKey.values()) this.scheduleNextOpen(state);
  }

  /** Start the scheduler (server boot). Does nothing while GYM_SCHEDULE.enabled is false. */
  start(): void {
    this.started = true;
    for (const state of this.tablesByKey.values()) this.scheduleNextOpen(state);
  }

  /** Every gym closed, battles dropped, timers cleared (tests). */
  reset(): void {
    for (const state of this.tablesByKey.values()) this.clearTimers(state);
    this.fresh();
    this.started = false;
  }

  private clearTimers(state: TableState): void {
    for (const timer of [state.closeTimer, state.openTimer]) if (timer) clearTimeout(timer);
    state.closeTimer = state.openTimer = undefined;
  }

  /** The table, or a GymError (unknown leader / version it doesn't have). */
  private stateOf(leaderId: string, mode: GymMode): TableState {
    const state = this.tablesByKey.get(tableKey(leaderId, mode));
    if (state) return state;
    throw new GymError(getGymLeader(leaderId) ? GYM_ERRORS.modeUnavailable : GYM_ERRORS.unknownLeader);
  }

  private changed(users: string[] = []): void {
    this.listeners.onChange?.(users);
  }

  // ---------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------

  /** Open the table for `minutes` from now (also reopens / extends one open or closing). */
  open(leaderId: string, mode: GymMode = "normal", minutes: number = GYM_TIMING.defaultOpenMinutes): GymAdminStatus {
    const state = this.stateOf(leaderId, mode);
    const now = this.now();
    if (state.status !== "open") state.openedAt = now;
    state.status = "open";
    state.closesAt = now + minutes * 60_000;
    state.nextOpenAt = null;
    if (state.openTimer) clearTimeout(state.openTimer);
    state.openTimer = undefined;
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => this.stopChallenges(state), state.closesAt - now);
    state.closeTimer.unref?.();
    console.log(`[gym] ${leaderId} ${mode} open until ${new Date(state.closesAt).toISOString()}`);
    this.changed();
    return this.adminStatusOf(state);
  }

  /** No new challengers from now on; a battle in progress ends normally (closed after it). */
  close(leaderId: string, mode: GymMode = "normal"): GymAdminStatus {
    const state = this.stateOf(leaderId, mode);
    if (state.status === "open") this.stopChallenges(state);
    return this.adminStatusOf(state);
  }

  private stopChallenges(state: TableState): void {
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = undefined;
    if (state.status !== "open") return;
    state.closesAt = Math.min(state.closesAt ?? this.now(), this.now());
    state.status = "closing";
    console.log(`[gym] ${state.leader.id} ${state.mode} stops taking challengers${state.battle ? " (a battle is on)" : ""}`);
    this.closeIfDone(state);
    this.changed();
  }

  /** A closing table without a battle closes (and the scheduler plans the next opening). */
  private closeIfDone(state: TableState): void {
    if (state.status !== "closing" || state.battle) return;
    state.status = "closed";
    state.openedAt = null;
    state.closesAt = null;
    console.log(`[gym] ${state.leader.id} ${state.mode} closed`);
    this.scheduleNextOpen(state);
  }

  private scheduleNextOpen(state: TableState): void {
    if (state.openTimer) clearTimeout(state.openTimer);
    state.openTimer = undefined;
    if (!this.started || !this.schedule.enabled || state.status !== "closed") {
      state.nextOpenAt = null;
      return;
    }
    const { minGapMs, maxGapMs } = this.schedule;
    const gap = minGapMs + Math.floor(this.random() * Math.max(0, maxGapMs - minGapMs));
    state.nextOpenAt = this.now() + gap;
    state.openTimer = setTimeout(() => {
      state.openTimer = undefined;
      if (state.status === "closed") this.open(state.leader.id, state.mode, this.schedule.openMs / 60_000);
    }, gap);
    state.openTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Challenges and battles
  // ---------------------------------------------------------------------------

  /** Why the user can't challenge this table now (before the deck check), or null. */
  challengeError(userId: string, leaderId: string, mode: GymMode): string | null {
    const leader = getGymLeader(leaderId);
    if (!leader) return GYM_ERRORS.unknownLeader;
    const state = this.tablesByKey.get(tableKey(leaderId, mode));
    if (!state) return GYM_ERRORS.modeUnavailable;
    if (this.battleOfUser(userId)) return GYM_ERRORS.alreadyInBattle;
    if (state.status !== "open") return GYM_ERRORS.closed;
    if (state.battle) return GYM_ERRORS.inBattle(leader.name);
    return null;
  }

  /**
   * Take the free table for the user (deck already checked): its battle room id. Synchronous, so
   * of two challenges at once the first one wins and the other gets the in-battle error. The
   * caller builds the room, then `battleStarted` (or `battleFailed`).
   */
  reserve(userId: string, leaderId: string, mode: GymMode, challenger: GymChallenger): string {
    const error = this.challengeError(userId, leaderId, mode);
    if (error) throw new GymError(error);
    const state = this.stateOf(leaderId, mode);
    const roomId = `gym-${randomUUID()}`;
    state.battle = {
      userId,
      roomId,
      challenger: { ...challenger },
      status: "starting",
      startedAt: this.now(),
      game: 1,
      score: { challenger: 0, leader: 0 },
      awaitingEntry: false,
    };
    return roomId;
  }

  /** The first game's room was built: the table shows the series. */
  battleStarted(roomId: string): void {
    const state = this.stateWithRoom(roomId);
    if (!state?.battle || state.battle.status !== "starting") return;
    state.battle = { ...state.battle, status: "playing", startedAt: this.now() };
    console.log(`[gym] ${state.leader.id} ${state.mode}: ${state.battle.userId} plays (${roomId})`);
    this.changed([state.battle.userId]);
  }

  /** The first game couldn't be built: the table is free again. */
  battleFailed(roomId: string): void {
    this.free(roomId);
  }

  /** A game ended undecided: the series goes on in `nextRoomId` (not entered yet). */
  nextGame(roomId: string, nextRoomId: string, game: number, score: GymScore): void {
    const state = this.stateWithRoom(roomId);
    if (!state?.battle) return;
    state.battle = { ...state.battle, roomId: nextRoomId, game, score: { ...score }, awaitingEntry: true };
    this.changed([state.battle.userId]);
  }

  /** The challenger entered the game waiting for them. */
  gameEntered(roomId: string): void {
    const state = this.stateWithRoom(roomId);
    if (!state?.battle?.awaitingEntry) return;
    state.battle = { ...state.battle, awaitingEntry: false };
    this.changed([state.battle.userId]);
  }

  /** The series ended (any way; its `finished` state went out): the table is free (or closes, when closing). */
  battleEnded(roomId: string): void {
    this.free(roomId);
  }

  private free(roomId: string): void {
    const state = this.stateWithRoom(roomId);
    if (!state?.battle) return;
    state.battle = null;
    this.closeIfDone(state);
    this.changed();
  }

  private stateWithRoom(roomId: string): TableState | null {
    for (const state of this.tablesByKey.values()) if (state.battle?.roomId === roomId) return state;
    return null;
  }

  private battleOfUser(userId: string): TableState | null {
    for (const state of this.tablesByKey.values()) if (state.battle?.userId === userId) return state;
    return null;
  }

  /** The battle a gym room id belongs to, or null. */
  battleFor(roomId: string): (GymBattle & { leader: GymLeaderDef; mode: GymMode }) | null {
    const state = this.stateWithRoom(roomId);
    return state?.battle ? { ...state.battle, leader: state.leader, mode: state.mode } : null;
  }

  /** `mySeries`: the user's series whose game room exists (playing / next), or null. */
  mySeries(userId: string): GymSeriesState | null {
    const state = this.battleOfUser(userId);
    const battle = state?.battle;
    if (!state || !battle || battle.status !== "playing") return null;
    return {
      leaderId: state.leader.id,
      mode: state.mode,
      game: battle.game,
      score: { ...battle.score },
      roomId: battle.roomId,
      status: battle.awaitingEntry ? "next" : "playing",
    };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /** `gymTables`: open tables and closing ones whose battle still runs, in content order. */
  tables(): GymTable[] {
    const rows: GymTable[] = [];
    for (const state of this.tablesByKey.values()) {
      if (state.status === "closed") continue;
      const { leader, mode } = state;
      const playing = state.battle?.status === "playing" ? state.battle : null;
      rows.push({
        leaderId: leader.id,
        name: leader.name,
        title: leader.title,
        avatarId: leader.avatarId,
        medalId: leader.medalId,
        mode,
        rules: publicGymRules(leaderRules(leader, mode)!),
        rewards: { ...leaderRewards(leader, mode)! },
        entryCost: leader.entryCost,
        bestOf: GYM_BEST_OF,
        status: state.status,
        closesAt: state.closesAt ?? this.now(),
        inBattle: !!playing,
        challenger: playing ? { ...playing.challenger } : null,
        series: playing ? { game: playing.game, score: { ...playing.score } } : null,
      });
    }
    return rows;
  }

  private adminStatusOf(state: TableState): GymAdminStatus {
    const { leader, battle } = state;
    return {
      leaderId: leader.id,
      name: leader.name,
      title: leader.title,
      avatarId: leader.avatarId,
      mode: state.mode,
      modes: leaderModes(leader),
      status: state.status,
      openedAt: state.openedAt,
      closesAt: state.closesAt,
      inBattle: battle?.status === "playing",
      current:
        battle?.status === "playing"
          ? { userId: battle.userId, username: battle.challenger.username, roomId: battle.roomId, startedAt: battle.startedAt, game: battle.game, score: { ...battle.score } }
          : null,
      schedule: {
        enabled: this.schedule.enabled,
        nextOpenAt: state.nextOpenAt,
        minGapMinutes: this.schedule.minGapMs / 60_000,
        maxGapMinutes: this.schedule.maxGapMs / 60_000,
        openMinutes: this.schedule.openMs / 60_000,
      },
    };
  }

  /** One row per leader and version (content order). */
  adminStatus(): GymAdminStatus[] {
    return [...this.tablesByKey.values()].map((state) => this.adminStatusOf(state));
  }

  hasLeader(leaderId: string): boolean {
    return !!getGymLeader(leaderId);
  }
}

/** The server's gym state (socket handlers and the admin routes share it). */
export const gymService = new GymService();
