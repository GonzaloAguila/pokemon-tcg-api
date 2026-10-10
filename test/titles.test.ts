import { describe, expect, it } from "vitest";
import { computeTrainerTitleId, titleIdFromStats } from "../src/modules/users/titles.js";

describe("trainer titles (server-side)", () => {
  it("only gives admin titles to admin roles", () => {
    expect(computeTrainerTitleId(0, 0, 0, "superadmin")).toBe("superadmin");
    expect(computeTrainerTitleId(0, 0, 0, "admin")).toBe("admin");
    expect(computeTrainerTitleId(0, 0, 0, "user")).toBe("novato");
  });

  it("follows the games x win-rate matrix and special titles", () => {
    expect(computeTrainerTitleId(30, 70, 0)).toBe("excursionista");
    expect(computeTrainerTitleId(150, 55, 0)).toBe("pokemon-ranger");
    expect(computeTrainerTitleId(600, 72, 16)).toBe("alto-mando");
    expect(computeTrainerTitleId(1200, 80, 25)).toBe("maestro-pokemon");
    expect(computeTrainerTitleId(1200, 65, 0)).toBe("lider-de-gimnasio");
  });

  it("aggregates all modes from stats", () => {
    const stats = { normalWins: 10, normalLosses: 5, rankedWins: 10, rankedLosses: 5, draftWins: 5, draftLosses: 5, bestStreak: 3 };
    expect(titleIdFromStats(stats)).toBe("excursionista"); // 25 wins / 40 games = 62.5%
    expect(titleIdFromStats(null)).toBe("novato");
  });
});
