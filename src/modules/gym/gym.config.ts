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

/** A challenge is a series of games against the leader: first to win a majority of this many. */
export const GYM_BEST_OF = 3;

export const GYM_TIMING = {
  /** The challenger's clock for each of their turns (and for an answer owed on the leader's turn). */
  turnClockMs: 3 * MINUTE,
  /** A challenger away from a game (or who never enters it after it was created) for this long forfeits the series. */
  disconnectGraceMs: 2 * MINUTE,
  /** The leader's emote comes this long after what it reacts to (the board shows the play first). */
  emoteDelayMs: 1_200,
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

