/**
 * Backoffice "Mesas activas" (GET /admin/rooms): every room shows its players by username, the
 * server AI seat of adventure and gym battles by its rival's name, and what kind of table it is.
 */
import { describe, it, expect } from "vitest";
import type { GameState } from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";
import { listAdminRooms } from "../src/modules/admin/admin-rooms.js";
import { createUser } from "./helpers.js";

const state = { playerPrizes: [] } as unknown as GameState;
const serverRoom = { engineRandom: Math.random, coinSource: {} as never };

describe("admin rooms listing", () => {
  it("names both seats and the kind of table, with the AI seat shown by its rival's name", async () => {
    const challenger = await createUser();
    const traveller = await createUser();
    const host = await createUser();
    const guest = await createUser();
    const rooms = new GameRoomManager();

    rooms.createGymRoom({
      roomId: "gym-1", leaderId: "brock", mode: "normal", userId: challenger.id, deckId: "d1",
      rival: { username: "Brock", avatarId: null, titleId: null }, gameState: state, turnTimerSeconds: 180, ...serverRoom,
    });
    rooms.createAdventureRoom({
      roomId: "adv-1", runId: "run-1", userId: traveller.id,
      rival: { username: "Gary", avatarId: null, titleId: null }, gameState: state, ...serverRoom,
    });
    const table = rooms.createRoom("table-1", { betAmount: 50 });
    table.player1Id = host.id;
    table.player2Id = guest.id;

    const listed = await listAdminRooms(rooms.getAllRooms().values());
    const byId = new Map(listed.map((r) => [r.id, r]));

    expect(byId.get("gym-1")).toMatchObject({
      kind: "gym",
      player1: { id: challenger.id, username: challenger.username },
      player2: { id: null, username: "Brock", ai: true },
    });
    expect(byId.get("adv-1")).toMatchObject({
      kind: "adventure",
      player1: { id: traveller.id, username: traveller.username },
      player2: { id: null, username: "Gary", ai: true },
    });
    expect(byId.get("table-1")).toMatchObject({
      kind: "ranked",
      betAmount: 50,
      player1: { id: host.id, username: host.username },
      player2: { id: guest.id, username: guest.username },
    });
  });
});
