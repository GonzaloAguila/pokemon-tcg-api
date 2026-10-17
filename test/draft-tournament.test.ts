/**
 * Draft tournament (DraftRoomManager level): byes are rests (not wins), a player can leave the
 * tournament (every match of theirs not played is a walkover, rounds decided that way move on
 * by themselves), a game without a winner still decides its match, the final standings carry
 * the prizes (entry fees + penalties), and a three-way tie doesn't depend on input order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftRoomManager, computeDraftPrizes, type DraftRoom, type PlayerStanding } from "../src/socket/draft-rooms.js";

const ADMIN = "admin-user";
const managers: DraftRoomManager[] = [];
afterEach(() => {
  for (const m of managers) {
    for (const id of [...(m as unknown as { rooms: Map<string, DraftRoom> }).rooms.keys()]) {
      try { m.deleteRoom(id, ADMIN, true); } catch { /* already gone */ }
    }
  }
  managers.length = 0;
  vi.restoreAllMocks();
});

/** A room of `names.length` players already in the tournament (round 1 started). */
function tournament(names: string[], entryFee = 0) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const manager = new DraftRoomManager();
  managers.push(manager);
  const finished: DraftRoom[] = [];
  manager.setHooks({ onFinished: (r) => finished.push(r) });
  const room = manager.createRoom({ adminPlays: false, entryFee }, ADMIN, "admin-sock", "Admin");
  names.forEach((name, i) => manager.joinRoom(room.id, `p${i}`, `s${i}`, name));
  room.entryPaidIds = entryFee > 0 ? room.players.map((p) => p.id) : [];
  room.prizePool = entryFee * room.entryPaidIds.length;
  for (const p of room.players) p.deck = [];
  (manager as unknown as { startTournament(r: DraftRoom): void }).startTournament(room);
  // Each pending match gets a game room, as createMatchGames does
  let game = 0;
  const registerRound = () => {
    const round = room.tournament!.rounds.find((r) => r.roundNumber === room.tournament!.currentRoundNumber)!;
    for (const pairing of round.pairings) {
      if (manager.isMatchDecided(room.id, round.roundNumber, pairing.matchNumber)) continue;
      manager.registerGameRoom(`G${++game}`, room.id, round.roundNumber, pairing.matchNumber, pairing.player1.id, pairing.player2.id);
    }
  };
  registerRound();
  /** Play the current round: `winnerOf(pairing)` wins each pending match. */
  const playRound = (winnerOf: (p1: string, p2: string) => string | null) => {
    const round = room.tournament!.rounds.find((r) => r.roundNumber === room.tournament!.currentRoundNumber)!;
    for (const pairing of round.pairings) {
      const gameRoomId = [...(manager as unknown as { gameRoomToDraft: Map<string, { matchNumber: number }> }).gameRoomToDraft]
        .find(([, info]) => info.matchNumber === pairing.matchNumber)?.[0];
      if (!gameRoomId) continue;
      const winner = winnerOf(pairing.player1.id, pairing.player2.id);
      const loser = winner === null ? null : winner === pairing.player1.id ? pairing.player2.id : pairing.player1.id;
      const { newRoundStarted } = manager.reportMatchResult(room.id, round.roundNumber, pairing.matchNumber, winner, loser, gameRoomId);
      if (newRoundStarted) registerRound();
    }
  };
  return { manager, room, finished, playRound, registerRound };
}

/** No admin prizes configured (config.rewards: []). */
const noRewards = { coins: 0, packs: [], items: [] };

const standing = (room: DraftRoom, id: string) => room.tournament!.standings.find((s) => s.playerId === id)!;

describe("byes", () => {
  it("3 players: everyone rests one round and a bye is not a win", () => {
    const { room, playRound } = tournament(["Ana", "Beto", "Caro"]);
    expect(room.tournament!.totalRounds).toBe(3);
    const byes = room.tournament!.rounds.map((r) => r.byePlayerId);
    expect(new Set(byes).size).toBe(3);

    // Ana wins every game she plays
    for (let i = 0; i < 3; i++) playRound((a, b) => (a === "p0" || b === "p0" ? "p0" : a));
    expect(room.phase).toBe("finished");
    const totals = room.tournament!.standings.map((s) => s.wins + s.losses);
    expect(totals).toEqual([2, 2, 2]); // two real games each, the bye counted as neither
    expect(standing(room, "p0")).toMatchObject({ wins: 2, losses: 0, byes: 1 });
    expect(room.tournament!.rounds.flatMap((r) => r.results).filter((r) => r.isBye).every((r) => r.winnerId === null)).toBe(true);
  });
});

describe("withdrawing", () => {
  it("only while the tournament is played, once, and only a player of the draft", () => {
    const { manager, room } = tournament(["Ana", "Beto", "Caro"]);
    expect(() => manager.withdrawPlayer(room.id, "stranger", 0)).toThrow("No juegas este draft");
    manager.withdrawPlayer(room.id, "p1", 1000);
    expect(() => manager.withdrawPlayer(room.id, "p1", 1000)).toThrow("Ya abandonaste este draft");
  });

  it("the game in progress and every later match of theirs are won by the rival; rounds move on", () => {
    const { manager, room, finished, playRound } = tournament(["Ana", "Beto", "Caro", "Dani"]);
    const round1 = room.tournament!.rounds[0];
    const pairingOfBeto = round1.pairings.find((p) => p.player1.id === "p1" || p.player2.id === "p1")!;

    const result = manager.withdrawPlayer(room.id, "p1", 1000);
    expect(result.gameRoomIds).toHaveLength(1); // Beto's game of this round, to be closed
    const walkover = round1.results.find((r) => r.matchNumber === pairingOfBeto.matchNumber)!;
    expect(walkover).toMatchObject({ walkover: true, loserId: "p1" });
    expect(standing(room, "p1")).toMatchObject({ withdrawn: true, losses: 1 });
    expect(room.prizePool).toBe(1000);

    // The other games are played; Beto's later matches never get a game
    for (let i = 0; i < 3; i++) playRound((a) => a);
    expect(room.phase).toBe("finished");
    expect(finished).toEqual([room]);
    const betoResults = room.tournament!.rounds.flatMap((r) => r.results).filter((r) => r.player1Id === "p1" || r.player2Id === "p1");
    expect(betoResults).toHaveLength(3);
    expect(betoResults.every((r) => r.walkover && r.loserId === "p1")).toBe(true);
    expect(room.tournament!.standings.at(-1)!.playerId).toBe("p1"); // last, whatever the wins
  });

  it("2 players: the one who stays wins at once and the tournament ends", () => {
    const { manager, room, finished } = tournament(["Ana", "Beto"], 2000);
    const result = manager.withdrawPlayer(room.id, "p0", 1000);
    expect(result.tournamentFinished).toBe(true);
    expect(room.phase).toBe("finished");
    expect(finished).toEqual([room]);
    expect(room.prizes).toEqual([
      { playerId: "p1", playerName: "Beto", position: 1, coins: 5000, withdrawn: false, rewards: noRewards },
      { playerId: "p0", playerName: "Ana", position: 2, coins: 0, withdrawn: true, rewards: noRewards },
    ]);
  });

  it("a game reported after its match was decided by a withdrawal is ignored", () => {
    const { manager, room } = tournament(["Ana", "Beto", "Caro", "Dani"]);
    const pairing = room.tournament!.rounds[0].pairings.find((p) => p.player1.id === "p1" || p.player2.id === "p1")!;
    const rival = pairing.player1.id === "p1" ? pairing.player2.id : pairing.player1.id;
    const { gameRoomIds } = manager.withdrawPlayer(room.id, "p1", 0);
    manager.reportMatchResult(room.id, 1, pairing.matchNumber, "p1", rival, gameRoomIds[0]);
    expect(standing(room, rival)).toMatchObject({ wins: 1, losses: 0 });
    expect(standing(room, "p1")).toMatchObject({ wins: 0, losses: 1 });
  });
});

describe("results", () => {
  it("a game without a winner decides its match (both lose) so the round can end", () => {
    const { room, playRound } = tournament(["Ana", "Beto"]);
    playRound(() => null);
    expect(room.phase).toBe("finished");
    expect(room.tournament!.standings.map((s) => [s.wins, s.losses])).toEqual([[0, 1], [0, 1]]);
  });

  it("a three-way cycle is ordered the same whatever the input order", () => {
    const orders = [["Ana", "Beto", "Caro"], ["Caro", "Ana", "Beto"]].map((names) => {
      const { room, playRound } = tournament(names);
      const id = (name: string) => room.players.find((p) => p.name === name)!.id;
      // Ana > Beto > Caro > Ana: everyone 1-1
      const beats: Record<string, string> = { Ana: "Beto", Beto: "Caro", Caro: "Ana" };
      for (let i = 0; i < 3; i++) {
        playRound((a, b) => {
          const nameA = room.players.find((p) => p.id === a)!.name;
          return beats[nameA] === room.players.find((p) => p.id === b)!.name ? a : b;
        });
      }
      expect(room.tournament!.standings.every((s) => s.wins === 1 && s.losses === 1)).toBe(true);
      return room.tournament!.standings.map((s) => s.playerName);
    });
    expect(orders[0]).toEqual(orders[1]);
  });
});

describe("computeDraftPrizes", () => {
  const standings = (n: number, withdrawn: number[] = []): PlayerStanding[] =>
    Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, playerName: `P${i}`, wins: 0, losses: 0, byes: 0, withdrawn: withdrawn.includes(i) }));

  it("splits the pool by position for the number of players; rounding goes to the champion", () => {
    expect(computeDraftPrizes(standings(2), 4000).map((p) => p.coins)).toEqual([4000, 0]);
    expect(computeDraftPrizes(standings(3), 6000).map((p) => p.coins)).toEqual([4200, 1800, 0]);
    expect(computeDraftPrizes(standings(8), 16000).map((p) => p.coins)).toEqual([8000, 4800, 3200, 0, 0, 0, 0, 0]);
    expect(computeDraftPrizes(standings(3), 1001).map((p) => p.coins)).toEqual([701, 300, 0]);
  });

  it("players who left get nothing; the shares of paid positions without a player go to the others", () => {
    // 5 players, 2 left (ranked last): the 50/30/20 split is paid to the 3 who stayed
    expect(computeDraftPrizes(standings(5, [3, 4]), 10000).map((p) => p.coins)).toEqual([5000, 3000, 2000, 0, 0]);
    // 5 players, 3 left: 50/30 renormalized
    expect(computeDraftPrizes(standings(5, [2, 3, 4]), 8000).map((p) => p.coins)).toEqual([5000, 3000, 0, 0, 0]);
  });

  it("a free draft has no coin prizes", () => {
    expect(computeDraftPrizes(standings(4), 0).every((p) => p.coins === 0)).toBe(true);
  });
});
