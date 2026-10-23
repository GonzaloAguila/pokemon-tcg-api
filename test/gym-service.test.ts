/**
 * Gym state (src/modules/gym/gym.service.ts): opening / closing, the queue, ready slots and their
 * expiry, battles, the scheduler. In memory, fake timers, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GYM_ERRORS, GymError, GymService, type GymBattleReady } from "../src/modules/gym/gym.service.js";

let gym: GymService;
let ready: { userId: string; ready: GymBattleReady }[];
let changes: string[][];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  gym = new GymService({ readyWindowMs: 60_000 });
  ready = [];
  changes = [];
  gym.setListeners({
    onReady: (userId, r) => ready.push({ userId, ready: r }),
    onChange: (users) => changes.push(users),
  });
});

afterEach(() => {
  gym.reset();
  vi.useRealTimers();
});

describe("gym state", () => {
  it("a closed gym is not listed and takes nobody", () => {
    expect(gym.tables()).toEqual([]);
    expect(gym.joinError("u1", "brock", "normal")).toBe(GYM_ERRORS.closed);
    expect(() => gym.join("u1", "brock", "normal", "deck")).toThrow(GymError);
  });

  it("unknown leaders and modes without a deck are refused", () => {
    gym.open("brock");
    expect(gym.joinError("u1", "misty", "normal")).toBe(GYM_ERRORS.unknownLeader);
    expect(gym.joinError("u1", "brock", "expert")).toBe(GYM_ERRORS.modeUnavailable);
  });

  it("opening lists the table with Brock's data and the close time", () => {
    const status = gym.open("brock", 30);
    expect(status).toMatchObject({ status: "open", closesAt: Date.now() + 30 * 60_000, schedule: { enabled: false, nextOpenAt: null } });
    expect(gym.tables()).toEqual([
      {
        leaderId: "brock",
        name: "Brock",
        title: "Líder del Gimnasio de Ciudad Plateada",
        avatarId: "gym-brock",
        medalId: "boulder",
        mode: "normal",
        rules: { bannedTypes: ["grass", "water"], composition: { pokemon: 20, trainer: 20, energy: 20 } },
        status: "open",
        closesAt: Date.now() + 30 * 60_000,
        queueLength: 0,
        inBattle: false,
      },
    ]);
  });

  it("the first challenger is ready at once; the others wait in order", () => {
    gym.open("brock");
    expect(gym.join("u1", "brock", "normal", "d1")).toMatchObject({ status: "ready", position: 0 });
    expect(ready).toHaveLength(1);
    const { roomId, expiresAt } = ready[0].ready;
    expect(roomId).toMatch(/^gym-/);
    expect(expiresAt).toBe(Date.now() + 60_000);
    expect(gym.queueStateOf("u1")).toEqual({ leaderId: "brock", mode: "normal", position: 0, status: "ready", roomId, readyExpiresAt: expiresAt });

    gym.join("u2", "brock", "normal", "d2");
    gym.join("u3", "brock", "normal", "d3");
    expect(gym.queueStateOf("u2")).toEqual({ leaderId: "brock", mode: "normal", position: 1, status: "waiting" });
    expect(gym.queueStateOf("u3")).toMatchObject({ position: 2 });
    expect(gym.tables()[0]).toMatchObject({ queueLength: 2, inBattle: false });
    expect(gym.joinError("u2", "brock", "normal")).toBe(GYM_ERRORS.alreadyQueued);
    expect(gym.joinError("u1", "brock", "normal")).toBe(GYM_ERRORS.alreadyQueued);
  });

  it("claiming the ready room starts the battle; its end moves the queue", () => {
    gym.open("brock");
    gym.join("u1", "brock", "normal", "d1");
    gym.join("u2", "brock", "normal", "d2");
    const roomId = ready[0].ready.roomId;

    expect(gym.claimable(roomId, "u2")).toBeNull();
    expect(gym.claimable(roomId, "u1")).toMatchObject({ userId: "u1", deckId: "d1", mode: "normal", leader: { id: "brock" } });
    gym.battleStarted(roomId);
    expect(gym.queueStateOf("u1")).toEqual({ leaderId: "brock", mode: "normal", position: 0, status: "playing", roomId });
    expect(gym.tables()[0]).toMatchObject({ queueLength: 1, inBattle: true });
    expect(gym.claimable(roomId, "u1")).toBeNull();
    // A playing battle never expires
    vi.advanceTimersByTime(5 * 60_000);
    expect(gym.queueStateOf("u1")).toMatchObject({ status: "playing" });
    expect(() => gym.leave("u1", "brock")).toThrow(GYM_ERRORS.battleStarted);

    gym.battleEnded(roomId);
    expect(gym.queueStateOf("u1")).toBeNull();
    expect(gym.queueStateOf("u2")).toMatchObject({ status: "ready" });
    expect(ready.map((r) => r.userId)).toEqual(["u1", "u2"]);
    expect(changes.at(-1)).toEqual(expect.arrayContaining(["u1", "u2"]));
  });

  it("a ready slot not taken in time is skipped", () => {
    gym.open("brock");
    gym.join("u1", "brock", "normal", "d1");
    gym.join("u2", "brock", "normal", "d2");
    const roomId = ready[0].ready.roomId;
    vi.advanceTimersByTime(59_000);
    expect(gym.claimable(roomId, "u1")).not.toBeNull();
    vi.advanceTimersByTime(1_001);
    expect(gym.claimable(roomId, "u1")).toBeNull();
    expect(gym.queueStateOf("u1")).toBeNull();
    expect(gym.queueStateOf("u2")).toMatchObject({ status: "ready" });
  });

  it("leaving: from the queue, or giving up a ready battle", () => {
    gym.open("brock");
    gym.join("u1", "brock", "normal", "d1");
    gym.join("u2", "brock", "normal", "d2");
    gym.join("u3", "brock", "normal", "d3");
    gym.leave("u2", "brock");
    expect(gym.queueStateOf("u2")).toBeNull();
    expect(gym.queueStateOf("u3")).toMatchObject({ position: 1 });
    gym.leave("u1", "brock");
    expect(gym.queueStateOf("u3")).toMatchObject({ status: "ready" });
    expect(() => gym.leave("u2", "brock")).toThrow(GYM_ERRORS.notQueued);
  });

  it("a battle that can't start skips its challenger", () => {
    gym.open("brock");
    gym.join("u1", "brock", "normal", "d1");
    gym.join("u2", "brock", "normal", "d2");
    gym.battleFailed(ready[0].ready.roomId);
    expect(gym.queueStateOf("u1")).toBeNull();
    expect(gym.queueStateOf("u2")).toMatchObject({ status: "ready" });
  });

  it("closing stops new challengers but serves the queue, then the gym closes", () => {
    gym.open("brock", 10);
    gym.join("u1", "brock", "normal", "d1");
    gym.join("u2", "brock", "normal", "d2");
    const first = ready[0].ready.roomId;
    gym.battleStarted(first);
    vi.advanceTimersByTime(10 * 60_000);
    expect(gym.tables()[0]).toMatchObject({ status: "closing", queueLength: 1, inBattle: true });
    expect(gym.joinError("u3", "brock", "normal")).toBe(GYM_ERRORS.closed);
    gym.battleEnded(first);
    const second = ready[1].ready.roomId;
    gym.battleStarted(second);
    expect(gym.tables()).toHaveLength(1);
    gym.battleEnded(second);
    expect(gym.tables()).toEqual([]);
    expect(gym.adminStatus()[0]).toMatchObject({ status: "closed", closesAt: null, queue: [], current: null });
  });

  it("an empty gym closes at once; the admin close too; reopening extends it", () => {
    gym.open("brock", 10);
    expect(gym.close("brock")).toMatchObject({ status: "closed" });
    gym.open("brock", 10);
    gym.join("u1", "brock", "normal", "d1");
    expect(gym.close("brock")).toMatchObject({ status: "closing" });
    expect(gym.open("brock", 20)).toMatchObject({ status: "open", closesAt: Date.now() + 20 * 60_000 });
    expect(gym.joinError("u2", "brock", "normal")).toBeNull();
  });

  it("one queue per user", () => {
    gym.open("brock");
    gym.join("u1", "brock", "normal", "d1");
    expect(() => gym.join("u1", "brock", "normal", "d1")).toThrow(GYM_ERRORS.alreadyQueued);
  });

  it("the scheduler (when enabled) opens a closed gym 2–6 h later for 45 min, and again after it closes", () => {
    const scheduled = new GymService({ schedule: { enabled: true }, random: () => 0.5 });
    scheduled.start();
    const status = scheduled.adminStatus()[0];
    expect(status.schedule).toMatchObject({ enabled: true, minGapMinutes: 120, maxGapMinutes: 360, openMinutes: 45 });
    expect(status.schedule.nextOpenAt).toBe(Date.now() + 4 * 3_600_000);
    vi.advanceTimersByTime(4 * 3_600_000);
    expect(scheduled.adminStatus()[0]).toMatchObject({ status: "open", closesAt: Date.now() + 45 * 60_000 });
    vi.advanceTimersByTime(45 * 60_000);
    const after = scheduled.adminStatus()[0];
    expect(after.status).toBe("closed");
    expect(after.schedule.nextOpenAt).toBe(Date.now() + 4 * 3_600_000);
    scheduled.reset();
  });

  it("the scheduler is disabled by default", () => {
    const plain = new GymService();
    plain.start();
    expect(plain.adminStatus()[0].schedule).toMatchObject({ enabled: false, nextOpenAt: null });
    plain.reset();
  });
});
