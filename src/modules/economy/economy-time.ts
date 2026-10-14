/**
 * The "economy day": every daily / weekly / monthly reset (daily pack, missions, market offers,
 * battle-pass step, login calendar, daily caps, Rare Candy weekly limit) happens at 00:00 in
 * ECONOMY.timeZone (Argentina, 03:00 UTC). Weeks start on Monday 00:00 in that zone.
 *
 * Days and weeks are identified by "YYYY-MM-DD" strings (the week by its Monday), which are
 * what the DB stores (DailyPurchase.date, EconomyClaim.key, UserMission.period, ...).
 */

import { ECONOMY } from "./config.js";

const DAY_MS = 24 * 60 * 60_000;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset of `timeZone` at `at`, in minutes (Argentina: -180). */
export function timeZoneOffsetMinutes(at: Date, timeZone = ECONOMY.timeZone): number {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatters.set(timeZone, fmt);
  }
  const name = fmt.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0; // "GMT" = UTC
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** The wall-clock date in the economy time zone, as a Date at UTC midnight of that date. */
function localDate(now: Date): Date {
  const shifted = new Date(now.getTime() + timeZoneOffsetMinutes(now) * 60_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Economy day of `now`, e.g. "2026-10-14". */
export function economyDay(now = new Date()): string {
  return toKey(localDate(now));
}

/** Instant at which the economy day of `now` started (00:00 local). */
export function startOfEconomyDay(now = new Date()): Date {
  const local = localDate(now);
  return new Date(local.getTime() - timeZoneOffsetMinutes(now) * 60_000);
}

/** Instant at which the next economy day starts. */
export function nextEconomyDayStart(now = new Date()): Date {
  const start = startOfEconomyDay(now);
  return startOfEconomyDay(new Date(start.getTime() + DAY_MS + 60 * 60_000));
}

/** Economy week of `now`, identified by its Monday ("2026-10-12"). */
export function economyWeek(now = new Date()): string {
  const local = localDate(now);
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return toKey(new Date(local.getTime() - sinceMonday * DAY_MS));
}

/** Instant at which the current economy week started (Monday 00:00 local). */
export function startOfEconomyWeek(now = new Date()): Date {
  const local = localDate(now);
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return startOfEconomyDay(new Date(startOfEconomyDay(now).getTime() - sinceMonday * DAY_MS + 60 * 60_000));
}

/** Instant at which the next economy week starts. */
export function nextEconomyWeekStart(now = new Date()): Date {
  return startOfEconomyDay(new Date(startOfEconomyWeek(now).getTime() + 7 * DAY_MS + 60 * 60_000));
}

/** Year, month (1-12) and day of month of the economy day. */
export function economyCalendar(now = new Date()): { year: number; month: number; dayOfMonth: number; daysInMonth: number } {
  const local = localDate(now);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  return {
    year,
    month,
    dayOfMonth: local.getUTCDate(),
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}
