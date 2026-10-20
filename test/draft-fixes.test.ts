/**
 * Regression tests for the 2026-10-14 draft bugs (DraftRoomManager level, short timers):
 * 5  bonus-pick / building can't hang: deadlines with random bonus picks and automatic decks
 *    (or removal), disconnected players don't block, a room closed unplayed reports it
 *    (refund), a player rejoins by room id
 * 12 the masked state tells the admin (isAdminViewer); start / close by user id, any socket
 * 15 no auto-pick while players are only momentarily disconnected (grace period)
 * 6  a draft deck needs a Basic Pokémon
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_CARDS, isPlayableAsBasic, type GameCard } from "@gonzaloaguila/game-core";
import { DraftRoomManager, buildAutoDeck, type DraftClosedInfo, type DraftRoom } from "../src/socket/draft-rooms.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ADMIN = "admin-user";

const managers: DraftRoomManager[] = [];
afterEach(() => {
  // Close every room so no timer outlives its test
  for (const m of managers) {
    for (const id of [...(m as unknown as { rooms: Map<string, DraftRoom> }).rooms.keys()]) {
      try { m.deleteRoom(id, ADMIN, true); } catch { /* already gone */ }
    }
  }
  managers.length = 0;
});

function setup(opts: { grace?: number; bonus?: number; building?: number; config?: Record<string, unknown> } = {}) {
  const manager = new DraftRoomManager({
    disconnectGraceMs: opts.grace ?? 40,
    bonusPickSeconds: opts.bonus ?? 60,
    buildingSeconds: opts.building ?? 60,
  });
  managers.push(manager);
  const events = {
    started: [] as DraftRoom[],
    closed: [] as [DraftRoom, DraftClosedInfo][],
    finished: [] as DraftRoom[],
    removed: [] as [string, number][],
  };
  manager.setHooks({
    onTournamentStart: (r) => events.started.push(r),
    onRoomClosed: (r, info) => events.closed.push([r, info]),
    onFinished: (r) => events.finished.push(r),
    onPlayerRemoved: (_r, player, info) => events.removed.push([player.id, info.refund]),
  });
  const room = manager.createRoom(
    { adminPlays: false, entryFee: 0, packsPerPlayer: 1, cardsPerPack: 5, pickTimeSeconds: 45, minDeckSize: 20, bonusPicks: 3, ...opts.config },
    ADMIN,
    "admin-sock",
    "Admin",
  );
  manager.joinRoom(room.id, "pa", "sa", "Ana");
  manager.joinRoom(room.id, "pb", "sb", "Beto");
  return { manager, room, events };
}

/** Both players pick the first card of their pack until the bonus-pick phase. */
function draftAllPicks(manager: DraftRoomManager, room: DraftRoom, sockets: Record<string, string> = { pa: "sa", pb: "sb" }) {
  while (room.phase === "drafting") {
    for (const p of room.players) {
      if (!p.isReady && p.currentPack.length > 0) manager.pickCard(room.id, sockets[p.id], p.currentPack[0].id);
    }
  }
}

const basicCard = (id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === "Pikachu")!), id });
const trainerCard = (id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === "Bill")!), id });

describe("bug 12: the admin is told and acts by user id", () => {
  it("isAdminViewer is true only for the admin; start works for the admin from any socket, not for players", () => {
    const { manager, room } = setup();
    expect(manager.getMaskedState(room.id, "admin-sock")!.isAdminViewer).toBe(true);
    expect(manager.getMaskedState(room.id, "sa")!.isAdminViewer).toBe(false);

    expect(() => manager.assertCanStart(room.id, "pa")).toThrow("Solo el admin puede iniciar el draft");
    // The admin from the backoffice tab (another socket): authorized by user id
    expect(manager.assertCanStart(room.id, ADMIN)).toBe(room);
    manager.startDraft(room.id, ADMIN);
    expect(room.phase).toBe("drafting");
  });

  it("close: the admin or a site admin; a player can't", () => {
    const { manager, room, events } = setup();
    expect(() => manager.deleteRoom(room.id, "pa")).toThrow("Solo el admin puede cerrar el draft");
    expect(manager.getRoom(room.id)).toBe(room);
    manager.deleteRoom(room.id, "some-site-admin", true);
    expect(manager.getRoom(room.id)).toBeUndefined();
    expect(events.closed[0][1]).toEqual({ unplayed: true, cancelled: false, reason: "La sala fue cerrada por el admin", gameRoomIds: [] });
    expect(() => manager.deleteRoom(room.id, ADMIN)).toThrow("Sala no encontrada");
  });
});

describe("bug 15: momentary disconnects don't auto-pick", () => {
  it("everybody drops (lobby -> table) and comes back within the grace period: nobody is auto-picked", async () => {
    const { manager, room } = setup({ grace: 60 });
    manager.startDraft(room.id, ADMIN);
    manager.handleDisconnect("sa");
    manager.handleDisconnect("sb");
    expect(room.players.every((p) => p.draftedCards.length === 0)).toBe(true);

    manager.joinRoom(room.id, "pa", "sa2", "Ana");
    manager.joinRoom(room.id, "pb", "sb2", "Beto");
    await sleep(120);
    expect(room.currentPick).toBe(1);
    expect(room.players.every((p) => p.draftedCards.length === 0)).toBe(true);
    expect(room.events.some((e) => e.message.startsWith("Auto-pick"))).toBe(false);

    const [a, b] = room.players;
    manager.pickCard(room.id, "sa2", a.currentPack[0].id);
    manager.pickCard(room.id, "sb2", b.currentPack[0].id);
    expect(room.currentPick).toBe(2);
  });

  it("a player who stays away doesn't block: after the grace period their pick is made", async () => {
    const { manager, room } = setup({ grace: 40 });
    manager.startDraft(room.id, ADMIN);
    manager.handleDisconnect("sb");
    manager.pickCard(room.id, "sa", room.players[0].currentPack[0].id);
    expect(room.currentPick).toBe(1); // grace running
    await sleep(100);
    expect(room.currentPick).toBe(2);
    expect(room.players[1].draftedCards).toHaveLength(1);
  });
});

describe("bug 5: bonus-pick and building always end", () => {
  it("bonus-pick deadline: 3 random bonus cards for whoever didn't pick, then building", async () => {
    const { manager, room } = setup({ bonus: 0.05 });
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    expect(room.phase).toBe("bonus-pick");
    expect(room.pickDeadline).toBeGreaterThan(Date.now());
    const pool = room.bonusPickPool;
    manager.bonusPick(room.id, "sa", pool.slice(0, 3).map((c) => c.id));
    expect(room.phase).toBe("bonus-pick"); // Beto is connected and still choosing
    await sleep(150);
    expect(room.phase).toBe("building");
    expect(room.players.map((p) => p.draftedCards.length)).toEqual([8, 8]);
  });

  it("a disconnected builder doesn't block: the others' decks start the tournament with an automatic deck for them", async () => {
    const { manager, room, events } = setup({ grace: 40 });
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    for (const s of ["sa", "sb"]) manager.bonusPick(room.id, s, room.bonusPickPool.slice(0, 3).map((c) => c.id));
    expect(room.phase).toBe("building");

    const [ana, beto] = room.players;
    ana.draftedCards.push(basicCard("ana-basic"));
    beto.draftedCards.push(basicCard("beto-basic"));
    manager.handleDisconnect("sb"); // Beto closed the tab
    manager.submitDeck(room.id, "sa", ana.draftedCards.map((c) => c.id), [{ type: "lightning", count: 20 }]);
    expect(room.phase).toBe("building"); // grace for Beto
    await sleep(100);
    expect(room.phase).toBe("matching");
    expect(beto.deck!.some((c) => isPlayableAsBasic(c))).toBe(true);
    expect(beto.deck!.length).toBeGreaterThanOrEqual(20);
    expect(events.started).toEqual([room]);
  });

  it("building deadline: no Basic Pokémon -> out of the tournament; with fewer than 2 players the room closes unplayed", async () => {
    const { manager, room, events } = setup({ building: 0.05 });
    manager.startDraft(room.id, ADMIN, ["pa", "pb"]);
    draftAllPicks(manager, room);
    for (const s of ["sa", "sb"]) manager.bonusPick(room.id, s, room.bonusPickPool.slice(0, 3).map((c) => c.id));
    room.players[0].draftedCards = [basicCard("a1"), trainerCard("a2")];
    room.players[1].draftedCards = [trainerCard("b1")];
    await sleep(150);
    expect(manager.getRoom(room.id)).toBeUndefined();
    expect(events.started).toHaveLength(0);
    const [closedRoom, info] = events.closed[0];
    expect(info).toEqual({ unplayed: true, cancelled: false, reason: "No quedan jugadores suficientes para el torneo", gameRoomIds: [] });
    // Beto (no Basic) was told and refunded on his own; the room closing refunds the rest
    expect(events.removed).toEqual([["pb", 0]]);
    expect(closedRoom.entryPaidIds).toEqual(["pa"]); // refunded by the socket layer
  });

  it("a player rejoins by room id (new socket) and gets their drafted cards back", () => {
    const { manager, room } = setup();
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    manager.handleDisconnect("sa");
    manager.joinRoom(room.id, "pa", "sa-new-tab", "Ana");
    const state = manager.getMaskedState(room.id, "sa-new-tab")!;
    const me = state.players.find((p) => p.isYou)!;
    expect(me.id).toBe("pa");
    expect(me.draftedCards).toHaveLength(5);
    expect(state.bonusPickPool.length).toBeGreaterThan(0);
  });
});

describe("bug 6 (draft): a deck needs a Basic Pokémon", () => {
  it("submitDeck without one is rejected; the automatic deck refuses too", () => {
    const { manager, room } = setup();
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    for (const s of ["sa", "sb"]) manager.bonusPick(room.id, s, room.bonusPickPool.slice(0, 3).map((c) => c.id));
    room.players[0].draftedCards = [trainerCard("t1")];
    expect(() => manager.submitDeck(room.id, "sa", ["t1"], [{ type: "water", count: 30 }])).toThrow(
      "El mazo necesita al menos un Pokémon básico",
    );
    expect(buildAutoDeck([trainerCard("t1")], 20, () => trainerCard("x"))).toBeNull();
  });
});

describe("hooks", () => {
  it("onFinished fires when the last match is reported", () => {
    const { manager, room, events } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    room.phase = "matching";
    room.tournament = {
      rounds: [{ roundNumber: 1, pairings: [{ matchNumber: 1, player1: { id: "pa", name: "Ana" }, player2: { id: "pb", name: "Beto" }, games: [], wins: { ["pa"]: 0, ["pb"]: 0 } }], byePlayerId: null, status: "in_progress", results: [] }],
      standings: [
        { playerId: "pa", playerName: "Ana", wins: 0, losses: 0, byes: 0, withdrawn: false },
        { playerId: "pb", playerName: "Beto", wins: 0, losses: 0, byes: 0, withdrawn: false },
      ],
      currentRoundNumber: 1,
      totalRounds: 1,
    };
    manager.registerGameRoom("GAME01", room.id, 1, 1, "pa", "pb");
    manager.reportMatchResult(room.id, 1, 1, "pa", "pb", "GAME01");
    expect(room.phase).toBe("finished");
    expect(events.finished).toEqual([room]);
  });
});

describe("lobby lifetime, start lock, admin seat", () => {
  it("an empty lobby whose admin left waits (it isn't deleted at once)", () => {
    const { manager, room } = setup();
    manager.leaveRoom(room.id, "sa");
    manager.leaveRoom(room.id, "sb");
    expect(manager.getRoom(room.id)).toBeDefined(); // the admin is still watching
    manager.handleDisconnect("admin-sock");
    expect(manager.getRoom(room.id)).toBeDefined();
    expect(room.expiryTimer).not.toBeNull(); // closed later unless someone comes back
    manager.joinRoom(room.id, "pc", "sc", "Caro");
    expect(room.expiryTimer).toBeNull();
  });

  it("nobody new sits down while the entry fees are being charged", () => {
    const { manager, room } = setup();
    manager.setStarting(room.id, true);
    expect(() => manager.joinRoom(room.id, "pc", "sc", "Caro")).toThrow("El draft está comenzando");
    manager.joinRoom(room.id, "pa", "sa2", "Ana"); // reconnecting is fine
    manager.setStarting(room.id, false);
    manager.joinRoom(room.id, "pc", "sc", "Caro");
    expect(room.players.map((p) => p.id)).toEqual(["pa", "pb", "pc"]);
  });

  it("the creator of a room they play in gets their seat (and the admin) back", () => {
    const { manager, room } = setup({ config: { adminPlays: true } });
    expect(room.players[0]).toMatchObject({ id: ADMIN, isAdmin: true });
    manager.leaveRoom(room.id, "admin-sock");
    expect(room.players[0]).toMatchObject({ id: "pa", isAdmin: true }); // passed on
    manager.joinRoom(room.id, ADMIN, "admin-sock-2", "Admin");
    expect(room.players.map((p) => [p.id, p.isAdmin, p.seatIndex])).toEqual([
      [ADMIN, true, 0],
      ["pa", false, 1],
      ["pb", false, 2],
    ]);
  });

  it("closing a tournament being played cancels it (entry fees back) and lists its games", () => {
    const { manager, room, events } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    room.phase = "matching";
    manager.registerGameRoom("GAME01", room.id, 1, 1, "pa", "pb");
    manager.deleteRoom(room.id, ADMIN);
    expect(events.closed[0][1]).toEqual({ unplayed: false, cancelled: true, reason: "La sala fue cerrada por el admin", gameRoomIds: ["GAME01"] });
  });

  it("the way back to a draft in progress; the backoffice sees every phase", () => {
    const { manager, room } = setup();
    expect(manager.getActiveRoomOf("pa")).toBeNull(); // still in the lobby
    manager.startDraft(room.id, ADMIN);
    expect(manager.getActiveRoomOf("pa")).toEqual({ roomId: room.id, phase: "drafting" });
    expect(manager.getAvailableRooms()).toEqual([]);
    expect(manager.getAllRooms()).toMatchObject([{ id: room.id, phase: "drafting", adminId: ADMIN, playerCount: 2 }]);
  });

  it("a deck has at most 60 cards", () => {
    const { manager, room } = setup();
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    for (const s of ["sa", "sb"]) manager.bonusPick(room.id, s, room.bonusPickPool.slice(0, 3).map((c) => c.id));
    const ana = room.players[0];
    ana.draftedCards.push(basicCard("ana-basic"));
    const ids = ana.draftedCards.map((c) => c.id);
    expect(() => manager.submitDeck(room.id, "sa", ids, [{ type: "fire", count: 61 - ids.length }])).toThrow("hasta 60 cartas");
    manager.submitDeck(room.id, "sa", ids, [{ type: "fire", count: 60 - ids.length }]);
    expect(ana.deck).toHaveLength(60);
  });
});
