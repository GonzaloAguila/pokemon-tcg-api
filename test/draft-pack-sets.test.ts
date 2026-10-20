/**
 * Draft pack sets: the admin picks the set of each pack (round), or "mixed" for every set.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CARD_SETS } from "@gonzaloaguila/game-core";
import { RELEASED_SETS } from "../src/lib/released-sets.js";
import { DraftRoomManager, bonusPoolFor, draftPool, generatePack, normalizePackSets, type DraftRoom } from "../src/socket/draft-rooms.js";
import { draftSchemas, parsePayload } from "../src/socket/schemas.js";

const ADMIN = "admin-user";
const setName = (id: string) => CARD_SETS.find((s) => s.id === id)!.name;

let manager: DraftRoomManager | null = null;
afterEach(() => {
  for (const id of [...((manager as unknown as { rooms: Map<string, DraftRoom> } | null)?.rooms.keys() ?? [])]) {
    manager!.deleteRoom(id, ADMIN, true);
  }
  manager = null;
});

/** Both players pick the first card of their pack until the round changes. */
function finishRound(m: DraftRoomManager, room: DraftRoom) {
  const round = room.currentRound;
  while (room.phase === "drafting" && room.currentRound === round) {
    for (const p of room.players) if (!p.isReady && p.currentPack.length > 0) m.pickCard(room.id, p.socketId, p.currentPack[0].id);
  }
}

describe("draft pack sets", () => {
  it("every round opens packs of the set chosen for it; rounds without a choice are mixed", () => {
    manager = new DraftRoomManager();
    const room = manager.createRoom(
      { adminPlays: false, entryFee: 0, packsPerPlayer: 3, cardsPerPack: 11, packSets: ["jungle", "team-rocket"] },
      ADMIN,
      "admin-sock",
      "Admin",
    );
    expect(room.config.packSets).toEqual(["jungle", "team-rocket", "mixed"]);
    manager.joinRoom(room.id, "pa", "sa", "Ana");
    manager.joinRoom(room.id, "pb", "sb", "Beto");

    manager.startDraft(room.id, ADMIN);
    for (const p of room.players) expect(new Set(p.currentPack.map((c) => c.set))).toEqual(new Set(["Jungle"]));
    expect(room.events.at(-1)?.message).toContain("Sobres de Jungle");

    finishRound(manager, room);
    expect(room.currentRound).toBe(2);
    for (const p of room.players) expect(new Set(p.currentPack.map((c) => c.set))).toEqual(new Set(["Team Rocket"]));
    expect(room.events.at(-1)?.message).toContain("Sobres de Team Rocket");

    finishRound(manager, room);
    expect(room.events.at(-1)?.message).toContain("Sobres de todas las expansiones");
  });

  it("single-set packs keep their size, have no repeats and always bring a rare", () => {
    for (const set of RELEASED_SETS) {
      for (const size of [5, 11, 15]) {
        for (let i = 0; i < 20; i++) {
          const pack = generatePack(size, set.id);
          expect(pack, `${set.id} ${size}`).toHaveLength(size);
          expect(pack.every((c) => c.set === setName(set.id))).toBe(true);
          expect(new Set(pack.map((c) => c.name + c.number)).size).toBe(size);
          expect(pack.some((c) => c.rarity === "rare" || c.rarity === "rare-holo")).toBe(true);
        }
      }
    }
  });

  it("a Trainers pack holds only Trainers, from every set, with no repeats", () => {
    const sets = new Set<string>();
    for (const size of [5, 11, 15]) {
      for (let i = 0; i < 30; i++) {
        const pack = generatePack(size, "trainers");
        expect(pack).toHaveLength(size);
        expect(pack.every((c) => c.kind === "trainer")).toBe(true);
        expect(new Set(pack.map((c) => c.name)).size).toBe(size);
        for (const c of pack) sets.add(c.set);
      }
    }
    expect(sets.size).toBe(RELEASED_SETS.length);
    expect(parsePayload(draftSchemas.create, { config: { packSets: ["trainers", "jungle"] } }).ok).toBe(true);
  });

  it("with a Trainers pack the bonus picks add the Trainers pack's cards (the draft's sets) to the chosen sets", () => {
    const pool = bonusPoolFor(["jungle", "trainers"]);
    expect(pool.every((c) => c.set === "Jungle")).toBe(true);
    expect(pool.filter((c) => c.kind === "trainer").map((c) => c.name)).toEqual(["Poké Ball"]);
    // A mixed pack: every non-Trainer card, plus the Trainers pack's (the chosen sets' Trainers)
    const chosen = bonusPoolFor(["jungle", "mixed", "trainers"], ["base-set", "gym-heroes"]);
    expect(chosen.filter((c) => c.kind !== "trainer")).toEqual(draftPool.filter((c) => c.kind !== "trainer"));
    expect(new Set(chosen.filter((c) => c.kind === "trainer").map((c) => c.set))).toEqual(new Set(["Base Set", "Gym Heroes"]));
    const withBase = bonusPoolFor(["jungle", "base-set", "trainers"], ["base-set"]);
    expect(withBase.filter((c) => c.kind === "trainer").every((c) => c.set === "Base Set")).toBe(true);
  });

  it("bonus picks come from the sets the draft used (all of them when a pack was mixed)", () => {
    expect(new Set(bonusPoolFor(["fossil", "jungle", "fossil"]).map((c) => c.set))).toEqual(new Set(["Fossil", "Jungle"]));
    // A mixed pack without a Trainers pack: every card but the Trainers
    expect(bonusPoolFor(["fossil", "mixed"])).toEqual(draftPool.filter((c) => c.kind !== "trainer"));
  });

  it("packSets are padded/trimmed to the pack count and validated", () => {
    expect(normalizePackSets(undefined, 2)).toEqual(["mixed", "mixed"]);
    expect(normalizePackSets(["fossil", "jungle", "base-set"], 2)).toEqual(["fossil", "jungle"]);
    expect(parsePayload(draftSchemas.create, { config: { packSets: ["base-set", "mixed"] } }).ok).toBe(true);
    expect(parsePayload(draftSchemas.create, { config: { packSets: ["neo-genesis"] } }).ok).toBe(false);
    expect(parsePayload(draftSchemas.create, { config: { packSets: Array(7).fill("mixed") } }).ok).toBe(false);
  });
});
