/**
 * Draft settings the admin chooses when creating a room:
 * - bonusPicks: how many bonus cards each player picks after the last round (0-10, default 5; 0 skips the phase)
 * - packRarities: rare / uncommon / common slots of every pack (sum = cardsPerPack); absent = the old formula
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GameCard } from "@gonzaloaguila/game-core";
import { DraftRoomManager, generatePack, type DraftRoom } from "../src/socket/draft-rooms.js";
import { draftSchemas, parsePayload } from "../src/socket/schemas.js";

const ADMIN = "admin-user";

const managers: DraftRoomManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) {
    for (const id of [...(m as unknown as { rooms: Map<string, DraftRoom> }).rooms.keys()]) m.deleteRoom(id, ADMIN, true);
  }
});

function setup(config: Record<string, unknown> = {}) {
  const manager = new DraftRoomManager({ disconnectGraceMs: 40, bonusPickSeconds: 60, buildingSeconds: 60 });
  managers.push(manager);
  const room = manager.createRoom(
    { adminPlays: false, entryFee: 0, packsPerPlayer: 1, cardsPerPack: 5, minDeckSize: 20, ...config },
    ADMIN,
    "admin-sock",
    "Admin",
  );
  manager.joinRoom(room.id, "pa", "sa", "Ana");
  manager.joinRoom(room.id, "pb", "sb", "Beto");
  return { manager, room };
}

function draftAllPicks(manager: DraftRoomManager, room: DraftRoom) {
  while (room.phase === "drafting") {
    for (const p of room.players) if (!p.isReady && p.currentPack.length > 0) manager.pickCard(room.id, p.socketId, p.currentPack[0].id);
  }
}

const isRare = (c: GameCard) => c.rarity === "rare" || c.rarity === "rare-holo";
function counts(pack: GameCard[]) {
  return {
    rare: pack.filter(isRare).length,
    uncommon: pack.filter((c) => c.rarity === "uncommon").length,
    common: pack.filter((c) => c.rarity === "common").length,
  };
}

const createOk = (config: Record<string, unknown>) => parsePayload(draftSchemas.create, { config }).ok;

describe("draft config: bonus picks", () => {
  it("default is 5 and is part of the state clients receive", () => {
    const { manager, room } = setup();
    expect(room.config.bonusPicks).toBe(5);
    expect(manager.getMaskedState(room.id, "sa")?.config.bonusPicks).toBe(5);

    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    expect(room.phase).toBe("bonus-pick");
    expect(room.events.at(-1)?.message).toContain("Elige 5 cartas bonus");
    expect(() => manager.bonusPick(room.id, "sa", room.bonusPickPool.slice(0, 3).map((c) => c.id))).toThrow(
      "Debes elegir exactamente 5 cartas",
    );
    manager.bonusPick(room.id, "sa", room.bonusPickPool.slice(0, 5).map((c) => c.id));
    expect(room.players[0].draftedCards).toHaveLength(5 + 5);
  });

  it("a custom count is the one asked for, and the deadline gives that many random cards", () => {
    const { manager, room } = setup({ bonusPicks: 2 });
    expect(room.config.bonusPicks).toBe(2);
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    expect(() => manager.bonusPick(room.id, "sa", room.bonusPickPool.slice(0, 5).map((c) => c.id))).toThrow(
      "Debes elegir exactamente 2 cartas",
    );
    manager.bonusPick(room.id, "sa", room.bonusPickPool.slice(0, 2).map((c) => c.id));
    (manager as unknown as { finishBonusPick(r: DraftRoom): void }).finishBonusPick(room);
    expect(room.phase).toBe("building");
    expect(room.players.map((p) => p.draftedCards.length)).toEqual([7, 7]);
  });

  it("0 skips the bonus-pick phase: the last round goes straight to building", () => {
    const { manager, room } = setup({ bonusPicks: 0 });
    manager.startDraft(room.id, ADMIN);
    draftAllPicks(manager, room);
    expect(room.phase).toBe("building");
    expect(room.bonusPickPool).toEqual([]);
    expect(room.players.map((p) => p.draftedCards.length)).toEqual([5, 5]);
    expect(room.events.some((e) => e.message.includes("cartas bonus"))).toBe(false);
  });

  it("the schema takes integers 0-10 only", () => {
    for (const n of [0, 1, 5, 10]) expect(createOk({ bonusPicks: n })).toBe(true);
    for (const n of [-1, 11, 2.5, "3"]) expect(createOk({ bonusPicks: n })).toBe(false);
  });

  it("createRoom refuses more bonus picks than the bonus pool offers", () => {
    const manager = new DraftRoomManager();
    managers.push(manager);
    // A Trainers-only draft of Fossil Trainers: a handful of cards
    expect(() =>
      manager.createRoom({ packsPerPlayer: 1, packSets: ["trainers"], trainerSets: ["fossil"], bonusPicks: 10 }, ADMIN, "s", "Admin"),
    ).toThrow(/cartas bonus/);
    expect(() => manager.createRoom({ bonusPicks: 11 }, ADMIN, "s", "Admin")).toThrow();
  });
});

describe("draft config: pack rarities", () => {
  it("generatePack uses the given composition (first rare slot a plain rare in Base Set)", () => {
    for (let i = 0; i < 30; i++) {
      const pack = generatePack(11, "base-set", undefined, { rare: 3, uncommon: 4, common: 4 });
      expect(pack).toHaveLength(11);
      expect(counts(pack)).toEqual({ rare: 3, uncommon: 4, common: 4 });
      expect(pack.some((c) => c.rarity === "rare")).toBe(true);
    }
  });

  it("holo-only sets (Jungle, Fossil, Team Rocket) keep working: a holo first, packs full", () => {
    for (const set of ["jungle", "fossil", "team-rocket"] as const) {
      for (let i = 0; i < 20; i++) {
        const pack = generatePack(11, set, undefined, { rare: 2, uncommon: 2, common: 7 });
        expect(pack, set).toHaveLength(11);
        expect(pack.some((c) => c.rarity === "rare-holo")).toBe(true);
        expect(counts(pack).common).toBe(7);
      }
    }
  });

  it("absent = the old formula (11 cards: 2 rares, 3 uncommons, 6 commons in Base Set; 1 holo in Jungle)", () => {
    for (let i = 0; i < 20; i++) {
      expect(counts(generatePack(11, "base-set"))).toEqual({ rare: 2, uncommon: 3, common: 6 });
      expect(counts(generatePack(11, "jungle"))).toEqual({ rare: 1, uncommon: 3, common: 7 });
    }
  });

  it("a Trainers pack ignores the composition", () => {
    const pack = generatePack(5, "trainers", undefined, { rare: 5, uncommon: 0, common: 0 });
    expect(pack).toHaveLength(5);
    expect(pack.every((c) => c.kind === "trainer")).toBe(true);
  });

  it("the room's packs use config.packRarities", () => {
    const { manager, room } = setup({ cardsPerPack: 6, packSets: ["base-set"], packRarities: { rare: 1, uncommon: 0, common: 5 } });
    expect(room.config.packRarities).toEqual({ rare: 1, uncommon: 0, common: 5 });
    manager.startDraft(room.id, ADMIN);
    for (const p of room.players) expect(counts(p.currentPack)).toEqual({ rare: 1, uncommon: 0, common: 5 });
  });

  it("validation: integers >= 0, rare >= 1, sum = cardsPerPack (11 by default)", () => {
    expect(createOk({ packRarities: { rare: 2, uncommon: 3, common: 6 } })).toBe(true);
    expect(createOk({ cardsPerPack: 8, packRarities: { rare: 1, uncommon: 2, common: 5 } })).toBe(true);
    expect(createOk({ packRarities: { rare: 2, uncommon: 3, common: 5 } })).toBe(false); // sum 10 != 11
    expect(createOk({ cardsPerPack: 8, packRarities: { rare: 2, uncommon: 3, common: 6 } })).toBe(false);
    expect(createOk({ packRarities: { rare: 0, uncommon: 5, common: 6 } })).toBe(false);
    expect(createOk({ packRarities: { rare: 2, uncommon: -1, common: 10 } })).toBe(false);
    expect(createOk({ packRarities: { rare: 1.5, uncommon: 3.5, common: 6 } })).toBe(false);
    const res = parsePayload(draftSchemas.create, { config: { packRarities: { rare: 2, uncommon: 3, common: 5 } } });
    expect(res.ok ? "" : JSON.stringify(res)).toContain("11");

    const manager = new DraftRoomManager();
    managers.push(manager);
    expect(() =>
      manager.createRoom({ cardsPerPack: 5, packRarities: { rare: 1, uncommon: 1, common: 1 } }, ADMIN, "s", "Admin"),
    ).toThrow(/5/);
  });
});
