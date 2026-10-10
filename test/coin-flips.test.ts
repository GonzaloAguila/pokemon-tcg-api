import { describe, expect, it } from "vitest";
import { GameRoomManager } from "../src/socket/rooms.js";

function roomWithGame(manager: GameRoomManager) {
  const room = manager.createRoom();
  Object.assign(room, {
    player1SocketId: "s1",
    player2SocketId: "s2",
    status: "playing",
    gameState: { isPlayerTurn: true, turnNumber: 3, events: [] },
  });
  return room;
}

describe("server-rolled client coin flips", () => {
  it("only the player whose turn it is can request one", () => {
    const manager = new GameRoomManager();
    const room = roomWithGame(manager);
    expect(manager.requestCoinFlip(room.id, "s2", "trainer")).toEqual({ success: false, error: "Not your turn" });
    expect(manager.requestCoinFlip(room.id, "intruder", "trainer").success).toBe(false);
    expect(manager.requestCoinFlip(room.id, "s1", "trainer").success).toBe(true);
  });

  it("asking again in the same turn returns the same result (no re-rolls)", () => {
    const manager = new GameRoomManager();
    const room = roomWithGame(manager);
    const first = manager.requestCoinFlip(room.id, "s1", "healFlip");
    for (let i = 0; i < 20; i++) {
      expect(manager.requestCoinFlip(room.id, "s1", "healFlip")).toEqual(first);
    }
  });

  it("rolls a fresh coin in a later turn", () => {
    const manager = new GameRoomManager();
    const room = roomWithGame(manager);
    const results = new Set<string>();
    for (let turn = 0; turn < 40; turn++) {
      (room.gameState as { turnNumber: number }).turnNumber = turn * 2; // still player 1's turn
      const res = manager.requestCoinFlip(room.id, "s1", "trainer");
      if (res.success) results.add(res.result);
    }
    expect(results).toEqual(new Set(["heads", "tails"]));
  });
});
