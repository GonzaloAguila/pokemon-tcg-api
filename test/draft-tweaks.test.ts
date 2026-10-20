/**
 * Draft tweaks (2026-10-16):
 * - draft:editDeck: a player who pressed "Listo" goes back to editing their deck while the room
 *   is still building (the tournament starts the moment every deck is in)
 * - Jungle and Fossil draft packs come without Trainers
 * - the Trainers pack only holds Trainers of the draft's sets, or of the sets the admin chose
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_CARDS, CARD_SETS, type GameCard } from "@gonzaloaguila/game-core";
import { RELEASED_SETS } from "../src/lib/released-sets.js";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { draftRoomManager } from "../src/socket/draft-handlers.js";
import {
  DraftRoomManager,
  bonusPoolFor,
  generatePack,
  normalizeTrainerSets,
  participatingSets,
  setPackPool,
  trainerPackPool,
  type DraftRoom,
} from "../src/socket/draft-rooms.js";
import { draftSchemas, parsePayload } from "../src/socket/schemas.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

const ADMIN = "admin-user";
const setName = (id: string) => CARD_SETS.find((s) => s.id === id)!.name;
const card = (name: string, id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === name && c.set === "Base Set")!), id });
/** 12 drafted cards: 4 Pikachu + 8 Bill; a deck is them + 28 Lightning Energy. */
const draftedCards = (prefix: string) =>
  Array.from({ length: 12 }, (_, i) => card(i < 4 ? "Pikachu" : "Bill", `${prefix}-${i}`));

const managers: DraftRoomManager[] = [];
afterEach(() => {
  for (const m of managers) {
    for (const id of [...(m as unknown as { rooms: Map<string, DraftRoom> }).rooms.keys()]) {
      try { m.deleteRoom(id, ADMIN, true); } catch { /* already gone */ }
    }
  }
  managers.length = 0;
});

/** A room of Ana (sa) and Beto (sb) already in the building phase with their drafted cards. */
function buildingRoom(buildingSeconds = 60) {
  const manager = new DraftRoomManager({ disconnectGraceMs: 40, bonusPickSeconds: 60, buildingSeconds });
  managers.push(manager);
  const started: DraftRoom[] = [];
  manager.setHooks({ onTournamentStart: (r) => started.push(r) });
  const room = manager.createRoom({ adminPlays: false, entryFee: 0, packsPerPlayer: 1, cardsPerPack: 5, minDeckSize: 40 }, ADMIN, "admin-sock", "Admin");
  manager.joinRoom(room.id, "pa", "sa", "Ana");
  manager.joinRoom(room.id, "pb", "sb", "Beto");
  room.phase = "building";
  room.players[0].draftedCards = draftedCards("a");
  room.players[1].draftedCards = draftedCards("b");
  return { manager, room, started };
}
const submit = (manager: DraftRoomManager, room: DraftRoom, socketId: string, energy = 28) => {
  const player = room.players.find((p) => p.socketId === socketId)!;
  manager.submitDeck(room.id, socketId, player.draftedCards.map((c) => c.id), [{ type: "lightning", count: energy }]);
};

describe("draft:editDeck (un-ready while building)", () => {
  it("a player who sent their deck can edit it again and send another until every deck is in", () => {
    const { manager, room, started } = buildingRoom();
    submit(manager, room, "sa");
    expect(room.players[0].isReady).toBe(true);

    manager.unreadyDeck(room.id, "sa");
    expect(room.players[0].isReady).toBe(false);
    expect(room.phase).toBe("building");
    expect(room.events.at(-1)?.message).toBe("Ana está editando su mazo");
    // Their own masked state still carries the last deck (the builder restores it)
    expect(manager.getMaskedState(room.id, "sa")!.players.find((p) => p.isYou)!.deck).toHaveLength(40);

    // Beto finishing doesn't start the tournament: Ana is editing
    submit(manager, room, "sb");
    expect(room.phase).toBe("building");
    expect(started).toHaveLength(0);

    submit(manager, room, "sa", 30);
    expect(room.phase).toBe("matching");
    expect(room.players[0].deck).toHaveLength(42);
    expect(started).toHaveLength(1);
  });

  it("refused when the deck wasn't sent, outside building, after the tournament started, or for an unknown socket", () => {
    const { manager, room } = buildingRoom();
    expect(() => manager.unreadyDeck(room.id, "sa")).toThrow("Tu mazo todavía no estaba listo");
    expect(() => manager.unreadyDeck(room.id, "nobody")).toThrow("Jugador no encontrado");
    expect(() => manager.unreadyDeck("NOPE", "sa")).toThrow("Sala no encontrada");

    room.phase = "drafting";
    expect(() => manager.unreadyDeck(room.id, "sa")).toThrow("No es fase de construcción");
    room.phase = "building";

    // Both decks in: the tournament starts at once and decks are final
    submit(manager, room, "sa");
    submit(manager, room, "sb");
    expect(room.phase).toBe("matching");
    expect(() => manager.unreadyDeck(room.id, "sa")).toThrow("El torneo ya comenzó");
    expect(room.players[0].isReady).toBe(true);
  });

  it("at the deadline a player still editing plays their last deck, not an automatic one", async () => {
    const { manager, room, started } = buildingRoom(0.05);
    // The building deadline (finishBonusPick starts it; this room skipped the draft)
    (manager as unknown as { startPhaseTimer: (r: DraftRoom, s: number) => void }).startPhaseTimer(room, 0.05);
    submit(manager, room, "sa", 30);
    manager.unreadyDeck(room.id, "sa");
    submit(manager, room, "sb");
    await new Promise((r) => setTimeout(r, 120));
    expect(room.phase).toBe("matching");
    expect(started).toHaveLength(1);
    expect(room.players[0].deck).toHaveLength(42);
    expect(room.events.some((e) => e.message === "Se usa el último mazo de Ana")).toBe(true);
    expect(room.events.some((e) => e.message === "Mazo automático para Ana")).toBe(false);
  });
});

describe("draft:editDeck over sockets", () => {
  let server: Awaited<ReturnType<typeof startSocketServer>>;
  beforeAll(async () => {
    server = await startSocketServer();
  });
  afterAll(async () => {
    await server.close();
    await prisma.$disconnect();
  });
  beforeEach(() => clearAccountStateCache());

  it("broadcasts the change to everyone and is refused once the tournament started", async () => {
    const admin = await createUser({}, { role: "admin", permissions: ["rooms:close"] });
    const adminSocket = await server.connect(tokenFor(admin));
    adminSocket.emit("draft:create", { config: { adminPlays: false, entryFee: 0, packsPerPlayer: 1, cardsPerPack: 5 } });
    const { roomId } = await nextEvent<{ roomId: string }>(adminSocket, "draft:created");

    const [a, b] = [await createUser(), await createUser()];
    const sa = await server.connect(tokenFor(a));
    const sb = await server.connect(tokenFor(b));
    for (const s of [sa, sb]) {
      const joined = nextEvent(s, "draft:state");
      s.emit("draft:join", { roomId });
      await joined;
    }
    const room = draftRoomManager.getRoom(roomId)!;
    room.phase = "building";
    room.players[0].draftedCards = draftedCards("a");
    room.players[1].draftedCards = draftedCards("b");
    const deckOf = (i: number) => ({
      roomId,
      deckCardIds: room.players[i].draftedCards.map((c) => c.id),
      energyCards: [{ type: "lightning", count: 28 }],
    });

    let seenByB = nextEvent<any>(sb, "draft:state");
    sa.emit("draft:submitDeck", deckOf(0));
    expect((await seenByB).players.find((p: { id: string }) => p.id === a.id).isReady).toBe(true);

    seenByB = nextEvent<any>(sb, "draft:state");
    const seenByA = nextEvent<any>(sa, "draft:state");
    sa.emit("draft:editDeck", { roomId });
    expect((await seenByB).players.find((p: { id: string }) => p.id === a.id).isReady).toBe(false);
    const own = (await seenByA).players.find((p: { isYou: boolean }) => p.isYou);
    expect(own.isReady).toBe(false);
    expect(own.deck).toHaveLength(40);

    // Invalid payload
    sa.emit("draft:editDeck", { roomId: "bad id!" });
    expect((await nextEvent<{ message: string }>(sa, "draft:error")).message).toBeTruthy();

    // Every deck in: the tournament starts, editing is refused
    sa.emit("draft:submitDeck", deckOf(0));
    const matching = nextEvent<any>(sb, "draft:matchReady", 5000);
    sb.emit("draft:submitDeck", deckOf(1));
    const ready = await matching;
    expect(room.phase).toBe("matching");
    sa.emit("draft:editDeck", { roomId });
    expect((await nextEvent<{ message: string }>(sa, "draft:error")).message).toBe("El torneo ya comenzó: el mazo no se puede cambiar");

    roomManager.forceDeleteRoom(ready.gameRoomId);
    await new Promise((r) => setTimeout(r, 300)); // the abandoned game settles before the DB disconnects
    draftRoomManager.deleteRoom(roomId, admin.id, true);
  });
});

describe("draft set packs come without Trainers", () => {
  it("their packs never hold a Trainer, keep their size, have no repeats and bring a rare", () => {
    for (const setId of ["jungle", "fossil"] as const) {
      expect(setPackPool(setId).some((c) => c.kind === "trainer")).toBe(false);
      for (const size of [5, 11, 15]) {
        for (let i = 0; i < 30; i++) {
          const pack = generatePack(size, setId);
          expect(pack).toHaveLength(size);
          expect(pack.filter((c) => c.kind === "trainer")).toEqual([]);
          expect(pack.every((c) => c.set === setName(setId))).toBe(true);
          expect(new Set(pack.map((c) => c.name + c.number)).size).toBe(size);
          expect(pack.some((c) => c.rarity === "rare" || c.rarity === "rare-holo")).toBe(true);
        }
      }
    }
  });

  it("no set pack and no mixed pack holds a Trainer: they only come in the Trainers pack", () => {
    for (const setId of ["base-set", "team-rocket", "gym-heroes"] as const) {
      expect(setPackPool(setId).length).toBeGreaterThan(0);
      expect(setPackPool(setId).some((c) => c.kind === "trainer")).toBe(false);
    }
    for (let i = 0; i < 30; i++) {
      expect(generatePack(11, "mixed").filter((c) => c.kind === "trainer")).toEqual([]);
      expect(generatePack(11, "base-set").filter((c) => c.kind === "trainer")).toEqual([]);
    }
    expect(generatePack(11, "trainers").every((c) => c.kind === "trainer")).toBe(true);
  });

  it("bonus picks of a Jungle/Fossil draft without a Trainers pack hold no Trainer", () => {
    const pool = bonusPoolFor(["jungle", "fossil"]);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.some((c) => c.kind === "trainer")).toBe(false);
  });
});

describe("the Trainers pack holds only Trainers of the draft's sets", () => {
  it("by default: the sets of the draft's packs (every set when a pack is mixed)", () => {
    expect(participatingSets(["jungle", "trainers", "base-set"])).toEqual(["base-set", "jungle"]);
    expect(participatingSets(["jungle", "mixed"])).toEqual(RELEASED_SETS.map((s) => s.id));
    expect(participatingSets(["trainers", "trainers"])).toEqual(RELEASED_SETS.map((s) => s.id));

    const manager = new DraftRoomManager();
    managers.push(manager);
    const room = manager.createRoom(
      { adminPlays: false, entryFee: 0, packsPerPlayer: 3, cardsPerPack: 11, packSets: ["base-set", "fossil", "trainers"] },
      ADMIN, "admin-sock", "Admin",
    );
    expect(room.config.trainerSets).toEqual(["base-set", "fossil"]);
    manager.joinRoom(room.id, "pa", "sa", "Ana");
    manager.joinRoom(room.id, "pb", "sb", "Beto");
    manager.startDraft(room.id, ADMIN);
    // Round 3 packs: play rounds 1 and 2 out
    while (room.currentRound < 3) {
      for (const p of room.players) if (!p.isReady && p.currentPack.length > 0) manager.pickCard(room.id, p.socketId!, p.currentPack[0].id);
    }
    for (const p of room.players) {
      expect(p.currentPack).toHaveLength(11);
      expect(p.currentPack.every((c) => c.kind === "trainer" && (c.set === "Base Set" || c.set === "Fossil"))).toBe(true);
    }
  });

  it("never Gym Heroes (or any other set) Trainers in a draft that doesn't play that set", () => {
    for (let i = 0; i < 100; i++) {
      const pack = generatePack(11, "trainers", ["jungle", "fossil", "team-rocket"]);
      expect(pack).toHaveLength(11);
      expect(pack.every((c) => c.kind === "trainer" && ["Jungle", "Fossil", "Team Rocket"].includes(c.set))).toBe(true);
    }
  });

  it("a pool smaller than the pack is completed with repeats, so every pack has the same size", () => {
    expect(trainerPackPool(["jungle"]).map((c) => c.name)).toEqual(["Poké Ball"]);
    const pack = generatePack(11, "trainers", ["jungle", "fossil"]);
    expect(pack).toHaveLength(11);
    expect(new Set(pack.map((c) => c.id)).size).toBe(11); // distinct instances
    expect(new Set(pack.map((c) => c.name)).size).toBe(6); // every card of the pool shows up
    expect(pack.every((c) => c.kind === "trainer" && (c.set === "Jungle" || c.set === "Fossil"))).toBe(true);
  });

  it("the admin's choice: validated against the draft's sets, kept in registry order", () => {
    expect(normalizeTrainerSets(undefined, ["jungle", "fossil", "trainers"])).toEqual(["jungle", "fossil"]);
    expect(normalizeTrainerSets(["fossil", "base-set"], ["fossil", "base-set", "trainers"])).toEqual(["base-set", "fossil"]);
    expect(() => normalizeTrainerSets([], ["fossil", "trainers"])).toThrow("Elige al menos una expansión");
    expect(() => normalizeTrainerSets(["gym-heroes"], ["fossil", "trainers"])).toThrow("Gym Heroes no participa de este draft");
    expect(normalizeTrainerSets(["gym-heroes"], ["fossil", "mixed", "trainers"])).toEqual(["gym-heroes"]);

    const manager = new DraftRoomManager();
    managers.push(manager);
    expect(() =>
      manager.createRoom({ packsPerPlayer: 2, packSets: ["jungle", "trainers"], trainerSets: ["gym-heroes"] }, ADMIN, "s", "Admin"),
    ).toThrow("Gym Heroes no participa de este draft");
    const room = manager.createRoom({ packsPerPlayer: 3, packSets: ["jungle", "base-set", "trainers"], trainerSets: ["base-set"] }, ADMIN, "s2", "Admin");
    expect(room.config.trainerSets).toEqual(["base-set"]);
    // Bonus picks: the sets' packs (Jungle without Poké Ball) + the Trainers pack's cards
    const bonus = bonusPoolFor(room.config.packSets, room.config.trainerSets);
    expect(bonus.filter((c) => c.kind === "trainer").every((c) => c.set === "Base Set")).toBe(true);
    expect(bonus.some((c) => c.set === "Jungle")).toBe(true);
  });

  it("the socket schema accepts known set ids only, at least one", () => {
    expect(parsePayload(draftSchemas.create, { config: { packSets: ["jungle", "trainers"], trainerSets: ["jungle"] } }).ok).toBe(true);
    expect(parsePayload(draftSchemas.create, { config: { trainerSets: [] } }).ok).toBe(false);
    expect(parsePayload(draftSchemas.create, { config: { trainerSets: ["neo-genesis"] } }).ok).toBe(false);
    expect(parsePayload(draftSchemas.create, { config: { trainerSets: ["trainers"] } }).ok).toBe(false);
  });
});
