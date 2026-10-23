/**
 * Gym Leaders' daily attempts (src/modules/gym/attempts.ts, v2.2): attemptsPerDay series per user
 * per leader per economy day (00:00 Argentina = 03:00 UTC), normal and expert together, a refunded
 * series gives its attempt back, persisted (GymAttempt rows).
 */
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { attemptsError, attemptsOf, giveBackAttempt, takeAttempt } from "../src/modules/gym/attempts.js";
import { BROCK } from "../src/modules/gym/content/brock.js";
import { createUser } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const NO_ATTEMPTS = "Ya usaste tus 2 intentos de hoy contra Brock. Vuelve mañana.";

describe("gym daily attempts", () => {
  it("2 per day against Brock, normal and expert together", async () => {
    const user = await createUser();
    const now = new Date("2026-10-23T15:00:00Z");
    expect(await attemptsOf(user.id, now)).toEqual({ brock: { used: 0, perDay: 2, resetsAt: Date.parse("2026-10-24T03:00:00Z") } });
    expect(await attemptsError(user.id, BROCK, now)).toBeNull();
    expect(await takeAttempt(user.id, BROCK, "normal", now)).toEqual(expect.any(String));
    expect(await takeAttempt(user.id, BROCK, "expert", now)).toEqual(expect.any(String));
    expect(await takeAttempt(user.id, BROCK, "normal", now)).toBeNull();
    expect(await attemptsError(user.id, BROCK, now)).toBe(NO_ATTEMPTS);
    expect((await attemptsOf(user.id, now)).brock).toMatchObject({ used: 2, perDay: 2 });
    expect(await prisma.gymAttempt.findMany({ where: { userId: user.id }, select: { mode: true, day: true, refunded: true }, orderBy: { mode: "desc" } })).toEqual([
      { mode: "normal", day: "2026-10-23", refunded: false },
      { mode: "expert", day: "2026-10-23", refunded: false },
    ]);
  });

  it("the day is the economy's: they come back at 00:00 Argentina (03:00 UTC)", async () => {
    const user = await createUser();
    const lateNight = new Date("2026-10-24T02:59:59Z"); // 23:59:59 of the 23rd in Buenos Aires
    await takeAttempt(user.id, BROCK, "normal", lateNight);
    await takeAttempt(user.id, BROCK, "normal", lateNight);
    expect(await attemptsError(user.id, BROCK, lateNight)).toBe(NO_ATTEMPTS);
    expect((await attemptsOf(user.id, lateNight)).brock.resetsAt).toBe(Date.parse("2026-10-24T03:00:00Z"));
    const midnight = new Date("2026-10-24T03:00:00Z");
    expect(await attemptsOf(user.id, midnight)).toEqual({ brock: { used: 0, perDay: 2, resetsAt: Date.parse("2026-10-25T03:00:00Z") } });
    expect(await takeAttempt(user.id, BROCK, "expert", midnight)).toEqual(expect.any(String));
  });

  it("a refunded series gives its attempt back (once)", async () => {
    const user = await createUser();
    const now = new Date("2026-10-23T15:00:00Z");
    const first = (await takeAttempt(user.id, BROCK, "normal", now))!;
    await takeAttempt(user.id, BROCK, "normal", now);
    expect(await attemptsError(user.id, BROCK, now)).toBe(NO_ATTEMPTS);
    await giveBackAttempt(first);
    await giveBackAttempt(first);
    expect((await attemptsOf(user.id, now)).brock.used).toBe(1);
    expect(await takeAttempt(user.id, BROCK, "expert", now)).toEqual(expect.any(String));
    expect(await takeAttempt(user.id, BROCK, "expert", now)).toBeNull();
  });

  it("counted per user", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const now = new Date("2026-10-23T15:00:00Z");
    await takeAttempt(a.id, BROCK, "normal", now);
    await takeAttempt(a.id, BROCK, "normal", now);
    expect(await attemptsError(b.id, BROCK, now)).toBeNull();
  });
});
