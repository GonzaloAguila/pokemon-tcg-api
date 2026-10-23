/**
 * Gym state (src/modules/gym/gym.service.ts): one table per leader and version, opened / closed on
 * its own, a free table challenged (first one wins), in battle for the whole best-of-3 series (its
 * games, score, the next game waiting to be entered), one gym series per user, closing, the
 * scheduler. In memory, fake timers, no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GYM_ERRORS, GymError, GymService } from "../src/modules/gym/gym.service.js";

let gym: GymService;
let changes: string[][];

const ash = { username: "ash", avatarId: "pikachu" };
const misty = { username: "misty", avatarId: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  gym = new GymService();
  changes = [];
  gym.setListeners({ onChange: (users) => changes.push(users) });
});

afterEach(() => {
  gym.reset();
  vi.useRealTimers();
});

/** Challenge and build at once (what challengeGym does once the deck passed). */
function play(userId: string, mode: "normal" | "expert" = "normal", who = ash): string {
  const roomId = gym.reserve(userId, "brock", mode, who);
  gym.battleStarted(roomId);
  return roomId;
}

describe("gym state", () => {
  it("a closed gym is not listed and takes nobody", () => {
    expect(gym.tables()).toEqual([]);
    expect(gym.challengeError("u1", "brock", "normal")).toBe(GYM_ERRORS.closed);
    expect(() => gym.reserve("u1", "brock", "normal", ash)).toThrow(GymError);
  });

  it("unknown leaders are refused", () => {
    gym.open("brock");
    expect(gym.challengeError("u1", "misty", "normal")).toBe(GYM_ERRORS.unknownLeader);
    expect(() => gym.open("misty")).toThrow(GYM_ERRORS.unknownLeader);
  });

  it("opening lists the table with this version's data, rules, rewards and close time", () => {
    const status = gym.open("brock", "normal", 30);
    expect(status).toMatchObject({ mode: "normal", modes: ["normal", "expert"], status: "open", closesAt: Date.now() + 30 * 60_000, schedule: { enabled: false, nextOpenAt: null } });
    expect(gym.tables()).toEqual([
      {
        leaderId: "brock",
        name: "Brock",
        title: "Líder del Gimnasio de Ciudad Plateada",
        avatarId: "gym-brock",
        medalId: "boulder",
        mode: "normal",
        rules: {
          bannedPokemonTypes: ["grass", "psychic", "fighting"],
          bannedOwners: ["Brock"],
          noStadiums: true,
          maxTrainers: 20,
          maxTrainerCopies: 2,
          fixedStadium: { cardId: "gym-heroes-115-pewter-city-gym", name: "Pewter City Gym" },
        },
        rewards: { medalId: "boulder", coins: 1500, coinId: "golem", cardBackId: "cardback-brock" },
        entryCost: 100,
        bestOf: 3,
        status: "open",
        closesAt: Date.now() + 30 * 60_000,
        inBattle: false,
        challenger: null,
        series: null,
      },
    ]);
  });

  it("normal and expert open and close on their own: two tables, each with its battle", () => {
    gym.open("brock", "expert", 20);
    expect(gym.tables()).toEqual([
      expect.objectContaining({
        mode: "expert",
        rules: expect.objectContaining({ maxTrainerCopies: 1, maxTrainers: 20 }),
        rewards: { medalId: null, coins: 3000, coinId: null, cardBackId: "cardback-brock-expert" },
      }),
    ]);
    expect(gym.challengeError("u1", "brock", "normal")).toBe(GYM_ERRORS.closed);
    gym.open("brock", "normal");
    expect(gym.tables().map((t) => t.mode)).toEqual(["normal", "expert"]);
    const normalRoom = play("u1", "normal");
    const expertRoom = play("u2", "expert", misty);
    expect(gym.tables().map((t) => [t.mode, t.inBattle, t.challenger?.username])).toEqual([
      ["normal", true, "ash"],
      ["expert", true, "misty"],
    ]);
    expect(gym.mySeries("u2")).toEqual({ leaderId: "brock", mode: "expert", game: 1, score: { challenger: 0, leader: 0 }, roomId: expertRoom, status: "playing" });
    expect(gym.battleFor(normalRoom)).toMatchObject({ userId: "u1", mode: "normal", leader: { id: "brock" } });
    expect(gym.close("brock", "expert")).toMatchObject({ mode: "expert", status: "closing" });
    expect(gym.tables().find((t) => t.mode === "normal")?.status).toBe("open");
    expect(gym.adminStatus().map((r) => [r.mode, r.status])).toEqual([
      ["normal", "open"],
      ["expert", "closing"],
    ]);
  });

  it("challenging a free table: in battle (Brock vs the challenger) until it ends, then free again", () => {
    gym.open("brock");
    expect(gym.challengeError("u1", "brock", "normal")).toBeNull();
    const roomId = gym.reserve("u1", "brock", "normal", ash);
    expect(roomId).toMatch(/^gym-/);
    // Reserved (room being built): the next challenger is refused, the card doesn't show it yet
    expect(gym.challengeError("u2", "brock", "normal")).toBe("Brock está en batalla: esperá a que termine");
    expect(() => gym.reserve("u2", "brock", "normal", misty)).toThrow("Brock está en batalla: esperá a que termine");
    expect(gym.tables()[0]).toMatchObject({ inBattle: false, challenger: null });
    expect(gym.mySeries("u1")).toBeNull();

    gym.battleStarted(roomId);
    expect(gym.tables()[0]).toMatchObject({ inBattle: true, challenger: { username: "ash", avatarId: "pikachu" }, series: { game: 1, score: { challenger: 0, leader: 0 } } });
    expect(gym.mySeries("u1")).toEqual({ leaderId: "brock", mode: "normal", game: 1, score: { challenger: 0, leader: 0 }, roomId, status: "playing" });
    expect(changes.at(-1)).toEqual(["u1"]);
    expect(gym.adminStatus()[0].current).toEqual({ userId: "u1", username: "ash", roomId, startedAt: Date.now(), game: 1, score: { challenger: 0, leader: 0 } });

    gym.battleEnded(roomId);
    expect(gym.tables()[0]).toMatchObject({ inBattle: false, challenger: null, series: null });
    expect(gym.mySeries("u1")).toBeNull();
    expect(gym.challengeError("u2", "brock", "normal")).toBeNull();
  });

  it("a series goes on game after game in new rooms: next (not entered yet), then playing; the table stays in battle", () => {
    gym.open("brock");
    const first = play("u1");
    gym.nextGame(first, "gym-second", 2, { challenger: 1, leader: 0 });
    expect(changes.at(-1)).toEqual(["u1"]);
    expect(gym.mySeries("u1")).toEqual({ leaderId: "brock", mode: "normal", game: 2, score: { challenger: 1, leader: 0 }, roomId: "gym-second", status: "next" });
    expect(gym.tables()[0]).toMatchObject({ inBattle: true, series: { game: 2, score: { challenger: 1, leader: 0 } } });
    expect(gym.battleFor(first)).toBeNull();
    expect(gym.battleFor("gym-second")).toMatchObject({ userId: "u1", game: 2 });
    expect(gym.challengeError("u2", "brock", "normal")).toBe("Brock está en batalla: esperá a que termine");
    gym.gameEntered("gym-second");
    expect(gym.mySeries("u1")?.status).toBe("playing");
    gym.gameEntered("gym-second");
    expect(changes.filter((c) => c.length > 0)).toHaveLength(3);
    // Ending an old game's room does nothing; the current one ends the series
    gym.battleEnded(first);
    expect(gym.tables()[0].inBattle).toBe(true);
    gym.battleEnded("gym-second");
    expect(gym.tables()[0].inBattle).toBe(false);
  });

  it("a battle that couldn't be built frees the table", () => {
    gym.open("brock");
    const roomId = gym.reserve("u1", "brock", "normal", ash);
    gym.battleFailed(roomId);
    expect(gym.battleFor(roomId)).toBeNull();
    expect(gym.challengeError("u2", "brock", "normal")).toBeNull();
  });

  it("one gym battle per user, across tables", () => {
    gym.open("brock", "normal");
    gym.open("brock", "expert");
    play("u1", "normal");
    expect(gym.challengeError("u1", "brock", "expert")).toBe(GYM_ERRORS.alreadyInBattle);
    expect(gym.challengeError("u1", "brock", "normal")).toBe(GYM_ERRORS.alreadyInBattle);
  });

  it("closing stops new challengers, keeps the battle listed, then the table closes", () => {
    gym.open("brock", "normal", 10);
    const roomId = play("u1");
    vi.advanceTimersByTime(10 * 60_000);
    expect(gym.tables()[0]).toMatchObject({ status: "closing", inBattle: true });
    expect(gym.challengeError("u2", "brock", "normal")).toBe(GYM_ERRORS.closed);
    gym.battleEnded(roomId);
    expect(gym.tables()).toEqual([]);
    expect(gym.adminStatus()[0]).toMatchObject({ status: "closed", closesAt: null, current: null });
  });

  it("an empty table closes at once; reopening extends it", () => {
    gym.open("brock", "normal", 10);
    expect(gym.close("brock")).toMatchObject({ status: "closed" });
    gym.open("brock", "normal", 10);
    play("u1");
    expect(gym.close("brock", "normal")).toMatchObject({ status: "closing" });
    expect(gym.open("brock", "normal", 20)).toMatchObject({ status: "open", closesAt: Date.now() + 20 * 60_000 });
    expect(gym.challengeError("u2", "brock", "normal")).toBe("Brock está en batalla: esperá a que termine");
  });

  it("the scheduler (when enabled) opens each closed table 2–6 h later for 45 min, and again after it closes", () => {
    const scheduled = new GymService({ schedule: { enabled: true }, random: () => 0.5 });
    scheduled.start();
    const status = scheduled.adminStatus()[0];
    expect(status.schedule).toMatchObject({ enabled: true, minGapMinutes: 120, maxGapMinutes: 360, openMinutes: 45 });
    expect(status.schedule.nextOpenAt).toBe(Date.now() + 4 * 3_600_000);
    vi.advanceTimersByTime(4 * 3_600_000);
    expect(scheduled.adminStatus().map((r) => r.status)).toEqual(["open", "open"]);
    expect(scheduled.adminStatus()[0]).toMatchObject({ closesAt: Date.now() + 45 * 60_000 });
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
