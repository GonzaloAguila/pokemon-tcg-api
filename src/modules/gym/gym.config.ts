/**
 * Gym Leaders' tunable numbers (docs/gym-leaders.md). The scheduler ships disabled: no gym opens
 * on its own until the owner turns it on; admins open and close gyms from the backoffice.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const GYM_SCHEDULE = {
  /** Open gyms at random moments on their own. */
  enabled: false,
  /** The next opening comes this long after the last one closed (random between both). */
  minGapMs: 2 * HOUR,
  maxGapMs: 6 * HOUR,
  /** How long a gym takes new challengers once open. */
  openMs: 45 * MINUTE,
} as const;

export const GYM_TIMING = {
  /** A challenger whose turn came has this long to enter the battle, else they are skipped. */
  readyWindowMs: 60_000,
  /** The challenger's clock for each of their turns (and for an answer owed on the leader's turn). */
  turnClockMs: 3 * MINUTE,
  /** A challenger away from the battle for this long loses it. */
  disconnectGraceMs: 2 * MINUTE,
  /** Admin "open" without minutes. */
  defaultOpenMinutes: 45,
  maxOpenMinutes: 24 * 60,
} as const;

export interface GymScheduleConfig {
  enabled: boolean;
  minGapMs: number;
  maxGapMs: number;
  openMs: number;
}

export interface GymTimingConfig {
  readyWindowMs: number;
  turnClockMs: number;
  disconnectGraceMs: number;
}
