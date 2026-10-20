/**
 * Draft matches as best-of-3 series (config.matchFormat "bo3"): the first to 2 game wins takes
 * the match, a game without a winner is replayed (5 games at most, then most wins; a tie = no
 * winner), a withdrawal mid-series is a walkover of the whole series, standings and prizes use
 * the series. bo1 keeps one game per match. Last block: the socket flow (next game = a new
 * draft:matchReady).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_CARDS, type GameCard } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { DraftRoomManager, type DraftRoom, type MatchPairing } from "../src/socket/draft-rooms.js";
import { draftSchemas } from "../src/socket/schemas.js";
import { roomManager } from "../src/socket/handlers.js";
import { createMatchGames, draftRoomManager } from "../src/socket/draft-handlers.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

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

/** A 2-player draft in its tournament (one match: p0 vs p1), `matchFormat` given. */
function series(matchFormat?: "bo1" | "bo3", names = ["Ana", "Beto"]) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const manager = new DraftRoomManager();
  managers.push(manager);
  const room = manager.createRoom({ adminPlays: false, entryFee: 0, ...(matchFormat ? { matchFormat } : {}) }, ADMIN, "admin-sock", "Admin");
  names.forEach((name, i) => manager.joinRoom(room.id, `p${i}`, `s${i}`, name));
  for (const p of room.players) p.deck = [];
  (manager as unknown as { startTournament(r: DraftRoom): void }).startTournament(room);
  const round = () => room.tournament!.rounds.find((r) => r.roundNumber === room.tournament!.currentRoundNumber)!;
  let game = 0;
  /** A new game room for `pairing` (as createMatchGame does), returns its id. */
  const newGame = (pairing: MatchPairing) => {
    const id = `G${++game}`;
    manager.registerGameRoom(id, room.id, round().roundNumber, pairing.matchNumber, pairing.player1.id, pairing.player2.id);
    return id;
  };
  /** Play one game of `pairing`: `winner` (null = no winner). Returns the progress. */
  const play = (pairing: MatchPairing, winner: string | null, played = true) => {
    const id = newGame(pairing);
    const loser = winner === null ? null : winner === pairing.player1.id ? pairing.player2.id : pairing.player1.id;
    return manager.reportMatchResult(room.id, round().roundNumber, pairing.matchNumber, winner, loser, id, played);
  };
  return { manager, room, round, play, newGame };
}

const standing = (room: DraftRoom, id: string) => room.tournament!.standings.find((s) => s.playerId === id)!;

describe("config", () => {
  it("matchFormat defaults to bo1, takes bo3, rejects anything else", () => {
    expect(series().room.config.matchFormat).toBe("bo1");
    expect(series("bo3").room.config.matchFormat).toBe("bo3");
    expect(draftSchemas.create.safeParse({ config: { matchFormat: "bo3" } }).success).toBe(true);
    expect(draftSchemas.create.safeParse({ config: { matchFormat: "bo5" } }).success).toBe(false);
  });

  it("prizeCount defaults to 6, takes 4 or 5, rejects anything else", () => {
    const manager = new DraftRoomManager();
    expect(manager.createRoom({ adminPlays: false, entryFee: 0 }, ADMIN, "s", "Admin").config.prizeCount).toBe(6);
    expect(manager.createRoom({ adminPlays: false, entryFee: 0, prizeCount: 4 }, ADMIN, "s", "Admin").config.prizeCount).toBe(4);
    expect(() => manager.createRoom({ adminPlays: false, entryFee: 0, prizeCount: 3 }, ADMIN, "s", "Admin")).toThrow(/4, 5 o 6/);
    expect(draftSchemas.create.safeParse({ config: { prizeCount: 5 } }).success).toBe(true);
    expect(draftSchemas.create.safeParse({ config: { prizeCount: 7 } }).success).toBe(false);
  });

  it("a draft game starts with the draft's Prize cards", async () => {
    const deck = ALL_CARDS.slice(0, 60).map((c, i) => ({ ...c, id: `pc${i}` }) as GameCard);
    for (const prizeCount of [4, 6]) {
      const game = roomManager.createRoom();
      await roomManager.joinRoom(game.id, `p1-${prizeCount}`, "s1");
      await roomManager.joinRoom(game.id, `p2-${prizeCount}`, "s2");
      const state = await roomManager.startGameWithRawDecks(game.id, deck, deck.map((x) => ({ ...x, id: `${x.id}b` })), prizeCount);
      expect([state.playerPrizes.length, state.opponentPrizes.length, game.config.prizeCount]).toEqual([prizeCount, prizeCount, prizeCount]);
    }
  });
});

describe("bo3 series", () => {
  it("2-0: the series goes on after game 1 and is decided by game 2", () => {
    const { room, round, play } = series("bo3");
    const pairing = round().pairings[0];
    const first = play(pairing, "p0");
    expect(first).toMatchObject({ newRoundStarted: false, tournamentFinished: false, nextGame: { roundNumber: 1, matchNumber: pairing.matchNumber } });
    expect(round().results).toHaveLength(0);
    expect(pairing.wins).toEqual({ p0: 1, p1: 0 });
    expect(standing(room, "p0")).toMatchObject({ wins: 0, losses: 0 });

    const second = play(pairing, "p0");
    expect(second.nextGame ?? null).toBeNull();
    expect(second.tournamentFinished).toBe(true);
    expect(round().results).toMatchObject([
      { winnerId: "p0", loserId: "p1", walkover: false, wins: { p0: 2, p1: 0 }, games: [{ gameRoomId: "G1", winnerId: "p0" }, { gameRoomId: "G2", winnerId: "p0" }] },
    ]);
    expect(round().results[0].played).toBeUndefined();
    expect(standing(room, "p0")).toMatchObject({ wins: 1, losses: 0 });
    expect(standing(room, "p1")).toMatchObject({ wins: 0, losses: 1 });
    expect(room.prizes!.map((p) => p.playerId)).toEqual(["p0", "p1"]);
  });

  it("2-1: three games, the last one decides", () => {
    const { room, round, play } = series("bo3");
    const pairing = round().pairings[0];
    expect(play(pairing, "p0").nextGame).toBeTruthy();
    expect(play(pairing, "p1").nextGame).toBeTruthy();
    expect(pairing.wins).toEqual({ p0: 1, p1: 1 });
    play(pairing, "p1");
    expect(round().results[0]).toMatchObject({ winnerId: "p1", loserId: "p0", gameRoomId: "G3", wins: { p0: 1, p1: 2 } });
    expect(round().results[0].games.map((g) => g.winnerId)).toEqual(["p0", "p1", "p1"]);
    expect(room.phase).toBe("finished");
    expect(standing(room, "p1").wins).toBe(1);
  });

  it("a game without a winner doesn't count and another one is played", () => {
    const { round, play } = series("bo3");
    const pairing = round().pairings[0];
    play(pairing, "p0");
    expect(play(pairing, null).nextGame).toBeTruthy();
    expect(pairing.wins).toEqual({ p0: 1, p1: 0 });
    expect(play(pairing, "p1").nextGame).toBeTruthy();
    play(pairing, "p0");
    expect(round().results[0]).toMatchObject({ winnerId: "p0", wins: { p0: 2, p1: 1 } });
    expect(round().results[0].games.map((g) => g.winnerId)).toEqual(["p0", null, "p1", "p0"]);
  });

  it("5 games at most: then the most wins take it, a tie is a match without a winner", () => {
    const { room, round, play } = series("bo3");
    const pairing = round().pairings[0];
    for (const w of ["p0", null, null, "p1"]) expect(play(pairing, w).nextGame).toBeTruthy();
    play(pairing, null);
    expect(round().results[0]).toMatchObject({ winnerId: null, loserId: null, wins: { p0: 1, p1: 1 } });
    expect(round().results[0].games).toHaveLength(5);
    expect(standing(room, "p0")).toMatchObject({ wins: 0, losses: 1 });
    expect(standing(room, "p1")).toMatchObject({ wins: 0, losses: 1 });

    const other = series("bo3");
    const p = other.round().pairings[0];
    for (const w of ["p0", null, null, null]) other.play(p, w);
    other.play(p, null);
    expect(other.round().results[0]).toMatchObject({ winnerId: "p0", loserId: "p1", wins: { p0: 1, p1: 0 } });
  });

  it("a stale or repeated game report is ignored", () => {
    const { manager, room, round, play } = series("bo3");
    const pairing = round().pairings[0];
    play(pairing, "p0");
    manager.reportMatchResult(room.id, 1, pairing.matchNumber, "p0", "p1", "G1");
    expect(pairing.wins).toEqual({ p0: 1, p1: 0 });
    expect(round().results).toHaveLength(0);
  });

  it("played: false only when no game of the series left the opening", () => {
    const { round, play } = series("bo3");
    const pairing = round().pairings[0];
    play(pairing, "p0", false);
    play(pairing, "p0", false);
    expect(round().results[0].played).toBe(false);

    const other = series("bo3");
    const p = other.round().pairings[0];
    other.play(p, "p0", true);
    other.play(p, "p0", false);
    expect(other.round().results[0].played).toBeUndefined();
  });

  it("a withdrawal mid-series is a walkover of the whole series; the game in progress is closed", () => {
    const { manager, room, round, play, newGame } = series("bo3", ["Ana", "Beto", "Caro", "Dani"]);
    const pairing = round().pairings.find((p) => p.player1.id === "p1" || p.player2.id === "p1")!;
    const rival = pairing.player1.id === "p1" ? pairing.player2.id : pairing.player1.id;
    play(pairing, "p1"); // Beto leads 1-0
    const inProgress = newGame(pairing);

    const result = manager.withdrawPlayer(room.id, "p1", 0);
    expect(result.gameRoomIds).toEqual([inProgress]);
    const walkover = round().results.find((r) => r.matchNumber === pairing.matchNumber)!;
    expect(walkover).toMatchObject({ walkover: true, winnerId: rival, loserId: "p1", wins: { p1: 1, [rival]: 0 } });
    expect(walkover.games).toHaveLength(2);
    expect(standing(room, rival)).toMatchObject({ wins: 1, losses: 0 });
    expect(standing(room, "p1")).toMatchObject({ wins: 0, losses: 1, withdrawn: true });
    // The closed game's late report changes nothing
    manager.reportMatchResult(room.id, 1, pairing.matchNumber, "p1", rival, inProgress);
    expect(standing(room, rival).wins).toBe(1);
  });
});

describe("bo1 unchanged", () => {
  it("one game decides the match (no winner too), the result carries its single game", () => {
    const { room, round, play } = series("bo1");
    const pairing = round().pairings[0];
    const progress = play(pairing, "p1");
    expect(progress.nextGame ?? null).toBeNull();
    expect(progress.tournamentFinished).toBe(true);
    expect(round().results[0]).toMatchObject({ winnerId: "p1", gameRoomId: "G1", games: [{ gameRoomId: "G1", winnerId: "p1" }], wins: { p0: 0, p1: 1 } });
    expect(standing(room, "p1").wins).toBe(1);

    const other = series();
    other.play(other.round().pairings[0], null);
    expect(other.round().results[0]).toMatchObject({ winnerId: null, games: [{ gameRoomId: "G1", winnerId: null }] });
    expect(other.room.phase).toBe("finished");
  });
});

describe("socket flow", () => {
  let server: Awaited<ReturnType<typeof startSocketServer>>;
  beforeAll(async () => {
    server = await startSocketServer();
  });
  afterAll(async () => {
    await server.close();
    await prisma.$disconnect();
  });
  beforeEach(() => clearAccountStateCache());

  const card = (name: string, id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === name && c.set === "Base Set")!), id });

  it("after game 1 both players get draft:matchEnded (seriesFinished false) and draft:matchReady for game 2", async () => {
    const [admin, a, b] = await Promise.all([createUser({}, { role: "admin" }), createUser({}, { stats: true }), createUser({}, { stats: true })]);
    const sa = await server.connect(tokenFor(a));
    const sb = await server.connect(tokenFor(b));
    const room = draftRoomManager.createRoom({ adminPlays: false, entryFee: 0, matchFormat: "bo3" }, admin.id, "admin-x", "Admin");
    draftRoomManager.joinRoom(room.id, a.id, sa.id!, "A");
    draftRoomManager.joinRoom(room.id, b.id, sb.id!, "B");
    room.phase = "matching";
    const deck = Array.from({ length: 40 }, (_, i) => card(i % 3 === 0 ? "Pikachu" : "Lightning Energy", `c${i}`));
    for (const p of room.players) p.deck = deck.map((c) => ({ ...c, id: `${c.id}-${p.id}` }));
    room.tournament = {
      rounds: [{ roundNumber: 1, pairings: [{ matchNumber: 1, player1: { id: a.id, name: "A" }, player2: { id: b.id, name: "B" }, games: [], wins: { [a.id]: 0, [b.id]: 0 } }], byePlayerId: null, status: "in_progress", results: [] }],
      standings: [a, b].map((u, i) => ({ playerId: u.id, playerName: "AB"[i], wins: 0, losses: 0, byes: 0, withdrawn: false })),
      currentRoundNumber: 1,
      totalRounds: 1,
    };

    const ready1 = nextEvent<any>(sa, "draft:matchReady");
    const readyB1 = nextEvent<any>(sb, "draft:matchReady");
    await createMatchGames(server.io, room.id, 1, roomManager);
    const first = await ready1;
    await readyB1;
    expect(first).toMatchObject({ matchFormat: "bo3", gameNumber: 1, wins: { [a.id]: 0, [b.id]: 0 } });

    const ended = nextEvent<any>(sb, "draft:matchEnded");
    const ready2 = nextEvent<any>(sb, "draft:matchReady");
    sa.emit("draft:forfeit", { draftRoomId: room.id, gameRoomId: first.gameRoomId });
    expect(await ended).toMatchObject({ gameRoomId: first.gameRoomId, winnerId: b.id, loserId: a.id, seriesFinished: false, tournamentFinished: false });
    const second = await ready2;
    expect(second).toMatchObject({ matchFormat: "bo3", gameNumber: 2, isPlayer1: false, wins: { [a.id]: 0, [b.id]: 1 } });
    expect(second.gameRoomId).not.toBe(first.gameRoomId);
    expect(draftRoomManager.getPendingMatchInfo(room.id, b.id)).toMatchObject({ gameRoomId: second.gameRoomId, gameNumber: 2 });
    expect(room.tournament.rounds[0].pairings[0].games).toEqual([
      { gameRoomId: first.gameRoomId, winnerId: b.id },
      { gameRoomId: second.gameRoomId, winnerId: null },
    ]);

    // Game 2 also to B: the series and the tournament end
    const final = nextEvent<any>(sb, "draft:matchEnded");
    sa.emit("draft:forfeit", { draftRoomId: room.id, gameRoomId: second.gameRoomId });
    expect(await final).toMatchObject({ winnerId: b.id, seriesFinished: true, tournamentFinished: true });
    expect(room.tournament.rounds[0].results).toMatchObject([{ winnerId: b.id, wins: { [a.id]: 0, [b.id]: 2 } }]);
    await new Promise((r) => setTimeout(r, 500)); // background settlement of the games
    for (const g of room.tournament.rounds[0].pairings[0].games) roomManager.forceDeleteRoom(g.gameRoomId!);
    draftRoomManager.deleteRoom(room.id, admin.id, true);
  });
});
