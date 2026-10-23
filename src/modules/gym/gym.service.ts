/**
 * Gym state (docs/gym-leaders.md): which leaders are open, their queues and the battle being
 * played. In memory (an API restart closes every gym and drops its queue and battle).
 *
 * A leader is `closed` (not listed), `open` (takes challengers until `closesAt`) or `closing`
 * (no new challengers, still serving the queue). One battle at a time per leader: the head of the
 * queue gets a `ready` slot with a room id (gym-…) and `readyWindowMs` to enter it (joinRoom →
 * `claim`); entering makes it `playing`; a slot that expires is skipped. A user is in at most one
 * queue. The deck checks (async, DB) happen in the socket layer before `join` / `claim`; this
 * class only keeps the state and tells its listeners what changed.
 */
import { randomUUID } from "node:crypto";
import { getGymLeader, GYM_LEADERS, leaderModes, type GymLeaderDef, type GymMode } from "./content/index.js";
import { GYM_SCHEDULE, GYM_TIMING, type GymScheduleConfig } from "./gym.config.js";

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
  alreadyQueued: "Ya estás en la fila",
  notQueued: "No estás en la fila de este gimnasio",
  battleStarted: "Tu batalla ya empezó: termínala o ríndete",
} as const;

export interface GymQueueEntry {
  userId: string;
  deckId: string;
  mode: GymMode;
  joinedAt: number;
}

export interface GymCurrentBattle extends GymQueueEntry {
  roomId: string;
  status: "ready" | "playing";
  /** Until when the challenger may enter (ready only). */
  readyExpiresAt: number | null;
}

interface LeaderState {
  leader: GymLeaderDef;
  status: GymStatus;
  openedAt: number | null;
  closesAt: number | null;
  queue: GymQueueEntry[];
  current: GymCurrentBattle | null;
  /** Scheduler: when it opens next (null = not scheduled). */
  nextOpenAt: number | null;
  closeTimer?: ReturnType<typeof setTimeout>;
  readyTimer?: ReturnType<typeof setTimeout>;
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
  rules: { bannedTypes: string[]; composition: { pokemon: number; trainer: number; energy: number } | null };
  status: "open" | "closing";
  closesAt: number;
  queueLength: number;
  inBattle: boolean;
}

/** `gymQueue` (contract): position 1 = next; 0 while the user's own battle is ready / playing. */
export interface GymQueueState {
  leaderId: string;
  mode: GymMode;
  position: number;
  status: "waiting" | "ready" | "playing";
  roomId?: string;
  readyExpiresAt?: number;
}

/** `gymBattleReady` (contract). */
export interface GymBattleReady {
  leaderId: string;
  mode: GymMode;
  roomId: string;
  expiresAt: number;
}

export interface GymAdminStatus {
  leaderId: string;
  name: string;
  title: string;
  modes: GymMode[];
  status: GymStatus;
  openedAt: number | null;
  closesAt: number | null;
  queue: { userId: string; mode: GymMode; position: number; joinedAt: number }[];
  current: { userId: string; mode: GymMode; status: "ready" | "playing"; roomId: string; readyExpiresAt: number | null } | null;
  inBattle: boolean;
  schedule: { enabled: boolean; nextOpenAt: number | null; minGapMinutes: number; maxGapMinutes: number; openMinutes: number };
}

export interface GymListeners {
  /** Something visible changed: broadcast `gymTables`; `users` get their own `gymQueue`. */
  onChange?: (users: string[]) => void;
  /** The user's battle is ready (`gymBattleReady`). */
  onReady?: (userId: string, ready: GymBattleReady) => void;
}

export interface GymServiceOptions {
  schedule?: Partial<GymScheduleConfig>;
  readyWindowMs?: number;
  now?: () => number;
  random?: () => number;
}

export class GymService {
  private readonly leaders = new Map<string, LeaderState>();
  private listeners: GymListeners = {};
  private schedule: GymScheduleConfig;
  private readyWindowMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private started = false;

  constructor(options: GymServiceOptions = {}) {
    this.schedule = { ...GYM_SCHEDULE, ...options.schedule };
    this.readyWindowMs = options.readyWindowMs ?? GYM_TIMING.readyWindowMs;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    for (const leader of GYM_LEADERS) this.leaders.set(leader.id, this.freshState(leader));
  }

  private freshState(leader: GymLeaderDef): LeaderState {
    return { leader, status: "closed", openedAt: null, closesAt: null, queue: [], current: null, nextOpenAt: null };
  }

  setListeners(listeners: GymListeners): void {
    this.listeners = listeners;
  }

  /** Change the scheduler / ready window (tests, or the owner turning the scheduler on). */
  configure(options: { schedule?: Partial<GymScheduleConfig>; readyWindowMs?: number }): void {
    if (options.schedule) this.schedule = { ...this.schedule, ...options.schedule };
    if (options.readyWindowMs !== undefined) this.readyWindowMs = options.readyWindowMs;
    if (this.started) for (const state of this.leaders.values()) this.scheduleNextOpen(state);
  }

  /** Start the scheduler (server boot). Does nothing while GYM_SCHEDULE.enabled is false. */
  start(): void {
    this.started = true;
    for (const state of this.leaders.values()) this.scheduleNextOpen(state);
  }

  /** Every gym closed, queues and battles dropped, timers cleared (tests). */
  reset(): void {
    for (const state of this.leaders.values()) this.clearTimers(state);
    for (const leader of GYM_LEADERS) this.leaders.set(leader.id, this.freshState(leader));
    this.started = false;
  }

  private clearTimers(state: LeaderState): void {
    for (const timer of [state.closeTimer, state.readyTimer, state.openTimer]) if (timer) clearTimeout(timer);
    state.closeTimer = state.readyTimer = state.openTimer = undefined;
  }

  private stateOf(leaderId: string): LeaderState {
    const state = this.leaders.get(leaderId);
    if (!state) throw new GymError(GYM_ERRORS.unknownLeader);
    return state;
  }

  private changed(users: string[] = []): void {
    this.listeners.onChange?.(users);
  }

  // ---------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------

  /** Open the gym for `minutes` from now (also reopens / extends one open or closing). */
  open(leaderId: string, minutes: number = GYM_TIMING.defaultOpenMinutes): GymAdminStatus {
    const state = this.stateOf(leaderId);
    const now = this.now();
    if (state.status !== "open") state.openedAt = now;
    state.status = "open";
    state.closesAt = now + minutes * 60_000;
    state.nextOpenAt = null;
    if (state.openTimer) clearTimeout(state.openTimer);
    state.openTimer = undefined;
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => this.stopJoins(state), state.closesAt - now);
    state.closeTimer.unref?.();
    console.log(`[gym] ${leaderId} open until ${new Date(state.closesAt).toISOString()}`);
    this.changed();
    return this.adminStatusOf(state);
  }

  /** No new challengers from now on; whoever is queued still plays (closed once the queue is done). */
  close(leaderId: string): GymAdminStatus {
    const state = this.stateOf(leaderId);
    if (state.status === "open") this.stopJoins(state);
    return this.adminStatusOf(state);
  }

  private stopJoins(state: LeaderState): void {
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = undefined;
    if (state.status !== "open") return;
    state.closesAt = Math.min(state.closesAt ?? this.now(), this.now());
    state.status = "closing";
    console.log(`[gym] ${state.leader.id} stops taking challengers (${state.queue.length} queued)`);
    this.closeIfDone(state);
    this.changed();
  }

  /** A closing gym with nobody left to serve closes (and the scheduler plans the next opening). */
  private closeIfDone(state: LeaderState): void {
    if (state.status !== "closing" || state.current || state.queue.length > 0) return;
    state.status = "closed";
    state.openedAt = null;
    state.closesAt = null;
    console.log(`[gym] ${state.leader.id} closed`);
    this.scheduleNextOpen(state);
  }

  private scheduleNextOpen(state: LeaderState): void {
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
      if (state.status === "closed") this.open(state.leader.id, this.schedule.openMs / 60_000);
    }, gap);
    state.openTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  /** Why the user can't queue for this leader now (before the deck check), or null. */
  joinError(userId: string, leaderId: string, mode: GymMode): string | null {
    const state = this.leaders.get(leaderId);
    if (!state) return GYM_ERRORS.unknownLeader;
    if (!leaderModes(state.leader).includes(mode)) return GYM_ERRORS.modeUnavailable;
    if (state.status !== "open") return GYM_ERRORS.closed;
    if (this.findUser(userId)) return GYM_ERRORS.alreadyQueued;
    return null;
  }

  /** Queue the user (deck already checked); their battle gets ready at once if nobody plays. */
  join(userId: string, leaderId: string, mode: GymMode, deckId: string): GymQueueState {
    const error = this.joinError(userId, leaderId, mode);
    if (error) throw new GymError(error);
    const state = this.stateOf(leaderId);
    state.queue.push({ userId, deckId, mode, joinedAt: this.now() });
    this.advance(state);
    this.changed([userId]);
    return this.queueStateOf(userId)!;
  }

  /** Leave the queue, or give up a ready battle (the next one gets it). Not once it started. */
  leave(userId: string, leaderId: string): void {
    const state = this.stateOf(leaderId);
    if (state.current?.userId === userId) {
      if (state.current.status === "playing") throw new GymError(GYM_ERRORS.battleStarted);
      this.skipCurrent(state, "left");
      return;
    }
    const index = state.queue.findIndex((entry) => entry.userId === userId);
    if (index < 0) throw new GymError(GYM_ERRORS.notQueued);
    const [removed] = state.queue.splice(index, 1);
    this.closeIfDone(state);
    this.changed([removed.userId, ...state.queue.map((entry) => entry.userId)]);
  }

  /** The head of the queue gets the ready slot when nobody is playing. */
  private advance(state: LeaderState): void {
    if (state.current) return;
    const next = state.queue.shift();
    if (!next) {
      this.closeIfDone(state);
      return;
    }
    const expiresAt = this.now() + this.readyWindowMs;
    state.current = { ...next, roomId: `gym-${randomUUID()}`, status: "ready", readyExpiresAt: expiresAt };
    if (state.readyTimer) clearTimeout(state.readyTimer);
    const roomId = state.current.roomId;
    state.readyTimer = setTimeout(() => {
      state.readyTimer = undefined;
      if (state.current?.roomId === roomId && state.current.status === "ready") this.skipCurrent(state, "expired");
    }, this.readyWindowMs);
    state.readyTimer.unref?.();
    console.log(`[gym] ${state.leader.id}: ${next.userId}'s battle is ready (${roomId})`);
    this.listeners.onReady?.(next.userId, { leaderId: state.leader.id, mode: next.mode, roomId, expiresAt });
  }

  private skipCurrent(state: LeaderState, why: "expired" | "left" | "deck"): void {
    const skipped = state.current;
    if (!skipped) return;
    console.log(`[gym] ${state.leader.id}: ${skipped.userId} skipped (${why})`);
    if (state.readyTimer) clearTimeout(state.readyTimer);
    state.readyTimer = undefined;
    state.current = null;
    this.advance(state);
    this.changed([skipped.userId, ...this.usersOf(state)]);
  }

  private usersOf(state: LeaderState): string[] {
    return [...(state.current ? [state.current.userId] : []), ...state.queue.map((entry) => entry.userId)];
  }

  private findUser(userId: string): { state: LeaderState; current: boolean; index: number } | null {
    for (const state of this.leaders.values()) {
      if (state.current?.userId === userId) return { state, current: true, index: -1 };
      const index = state.queue.findIndex((entry) => entry.userId === userId);
      if (index >= 0) return { state, current: false, index };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Battles
  // ---------------------------------------------------------------------------

  /** The battle a gym room id belongs to (ready or playing), or null. */
  battleFor(roomId: string): (GymCurrentBattle & { leader: GymLeaderDef }) | null {
    for (const state of this.leaders.values()) {
      if (state.current?.roomId === roomId) return { ...state.current, leader: state.leader };
    }
    return null;
  }

  /** joinRoom on a ready gym room by its challenger, in time: the battle to build, else null. */
  claimable(roomId: string, userId: string): (GymCurrentBattle & { leader: GymLeaderDef }) | null {
    const battle = this.battleFor(roomId);
    if (!battle || battle.userId !== userId || battle.status !== "ready") return null;
    if (battle.readyExpiresAt !== null && this.now() > battle.readyExpiresAt) return null;
    return battle;
  }

  /** The battle room was built: the slot is playing (no more expiry). */
  battleStarted(roomId: string): void {
    const state = this.stateWithRoom(roomId);
    if (!state?.current || state.current.status !== "ready") return;
    if (state.readyTimer) clearTimeout(state.readyTimer);
    state.readyTimer = undefined;
    state.current = { ...state.current, status: "playing", readyExpiresAt: null };
    this.changed([state.current.userId]);
  }

  /** The battle couldn't start (the deck no longer passes): skip the challenger. */
  battleFailed(roomId: string): void {
    const state = this.stateWithRoom(roomId);
    if (state) this.skipCurrent(state, "deck");
  }

  /** The battle ended (any way): the next challenger's turn. */
  battleEnded(roomId: string): void {
    const state = this.stateWithRoom(roomId);
    if (!state?.current) return;
    const userId = state.current.userId;
    state.current = null;
    this.advance(state);
    this.changed([userId, ...this.usersOf(state)]);
  }

  private stateWithRoom(roomId: string): LeaderState | null {
    for (const state of this.leaders.values()) if (state.current?.roomId === roomId) return state;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /** `gymTables`: open gyms and closing ones still serving their queue. */
  tables(): GymTable[] {
    const rows: GymTable[] = [];
    for (const state of this.leaders.values()) {
      if (state.status === "closed") continue;
      const { leader } = state;
      rows.push({
        leaderId: leader.id,
        name: leader.name,
        title: leader.title,
        avatarId: leader.avatarId,
        medalId: leader.medalId,
        mode: "normal",
        rules: { bannedTypes: [...leader.rules.bannedTypes], composition: leader.rules.composition ? { ...leader.rules.composition } : null },
        status: state.status,
        closesAt: state.closesAt ?? this.now(),
        queueLength: state.queue.length,
        inBattle: state.current?.status === "playing",
      });
    }
    return rows;
  }

  /** `gymQueue` for the user, or null when they aren't queued. */
  queueStateOf(userId: string): GymQueueState | null {
    const found = this.findUser(userId);
    if (!found) return null;
    const leaderId = found.state.leader.id;
    if (found.current) {
      const current = found.state.current!;
      return {
        leaderId,
        mode: current.mode,
        position: 0,
        status: current.status,
        roomId: current.roomId,
        ...(current.status === "ready" && current.readyExpiresAt !== null ? { readyExpiresAt: current.readyExpiresAt } : {}),
      };
    }
    const entry = found.state.queue[found.index];
    return { leaderId, mode: entry.mode, position: found.index + 1, status: "waiting" };
  }

  private adminStatusOf(state: LeaderState): GymAdminStatus {
    const { leader, current } = state;
    return {
      leaderId: leader.id,
      name: leader.name,
      title: leader.title,
      modes: leaderModes(leader),
      status: state.status,
      openedAt: state.openedAt,
      closesAt: state.closesAt,
      queue: state.queue.map((entry, i) => ({ userId: entry.userId, mode: entry.mode, position: i + 1, joinedAt: entry.joinedAt })),
      current: current
        ? { userId: current.userId, mode: current.mode, status: current.status, roomId: current.roomId, readyExpiresAt: current.readyExpiresAt }
        : null,
      inBattle: current?.status === "playing",
      schedule: {
        enabled: this.schedule.enabled,
        nextOpenAt: state.nextOpenAt,
        minGapMinutes: this.schedule.minGapMs / 60_000,
        maxGapMinutes: this.schedule.maxGapMs / 60_000,
        openMinutes: this.schedule.openMs / 60_000,
      },
    };
  }

  adminStatus(): GymAdminStatus[] {
    return [...this.leaders.values()].map((state) => this.adminStatusOf(state));
  }

  hasLeader(leaderId: string): boolean {
    return !!getGymLeader(leaderId);
  }
}

/** The server's gym state (socket handlers and the admin routes share it). */
export const gymService = new GymService();
