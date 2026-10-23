/**
 * Daily attempts (docs/gym-leaders.md, v2.2): a user may start `attemptsPerDay` challenges
 * (best-of-3 series) per leader per economy day (economy-time.ts: 00:00 Argentina, the wheel's
 * reset), both versions together. One GymAttempt row per series started; a series refunded for an
 * error gives it back (`refunded`). Persisted: an API restart keeps the count.
 *
 * Concurrency: `takeAttempt` runs while the user's table reservation is held (gymService.reserve
 * refuses a second series of the same user synchronously), so two attempts of one user are never
 * taken at once and count-then-insert can't overshoot.
 */
import { prisma } from "../../lib/prisma.js";
import { economyDay, nextEconomyDayStart } from "../economy/economy-time.js";
import { GYM_LEADERS } from "./content/index.js";
import type { GymLeaderDef, GymMode } from "./content/types.js";

/** `myAttempts[leaderId]` / `gymAttempts` (contract). */
export interface GymAttemptsState {
  used: number;
  perDay: number;
  /** Epoch ms: the next economy day (when `used` goes back to 0). */
  resetsAt: number;
}

/** "Ya usaste tus 2 intentos de hoy contra Brock. Vuelve mañana." */
export function noAttemptsError(leader: GymLeaderDef): string {
  return `Ya usaste tus ${leader.attemptsPerDay} intentos de hoy contra ${leader.name}. Vuelve mañana.`;
}

async function usedToday(userId: string, leaderId: string, now: Date): Promise<number> {
  return prisma.gymAttempt.count({ where: { userId, leaderId, day: economyDay(now), refunded: false } });
}

/** Every leader's attempts of the user today. */
export async function attemptsOf(userId: string, now = new Date()): Promise<Record<string, GymAttemptsState>> {
  const rows = await prisma.gymAttempt.groupBy({
    by: ["leaderId"],
    where: { userId, day: economyDay(now), refunded: false },
    _count: { _all: true },
  });
  const used = new Map(rows.map((r) => [r.leaderId, r._count._all]));
  const resetsAt = nextEconomyDayStart(now).getTime();
  return Object.fromEntries(GYM_LEADERS.map((leader) => [leader.id, { used: used.get(leader.id) ?? 0, perDay: leader.attemptsPerDay, resetsAt }]));
}

/** The refusal when the user has no attempt left today against `leader`, else null. */
export async function attemptsError(userId: string, leader: GymLeaderDef, now = new Date()): Promise<string | null> {
  return (await usedToday(userId, leader.id, now)) >= leader.attemptsPerDay ? noAttemptsError(leader) : null;
}

/** Use one of today's attempts: its id, or null when none is left. */
export async function takeAttempt(userId: string, leader: GymLeaderDef, mode: GymMode, now = new Date()): Promise<string | null> {
  if ((await usedToday(userId, leader.id, now)) >= leader.attemptsPerDay) return null;
  const row = await prisma.gymAttempt.create({ data: { userId, leaderId: leader.id, mode, day: economyDay(now) }, select: { id: true } });
  return row.id;
}

/** A series that ended with an error (refunded) gives its attempt back. */
export async function giveBackAttempt(attemptId: string): Promise<void> {
  await prisma.gymAttempt.updateMany({ where: { id: attemptId, refunded: false }, data: { refunded: true } });
}
