import { describe, expect, it } from "vitest";
import { GameRoomManager } from "../src/socket/rooms.js";

describe("joinRoom seats", () => {
  it("the creator joining their own waiting room again is a reconnect, not the opponent", async () => {
    const manager = new GameRoomManager();
    const room = manager.createRoom("ROOM01");
    await manager.joinRoom(room.id, "creator", "socket-a");

    const after = await manager.joinRoom(room.id, "creator", "socket-b");

    expect(after.player1Id).toBe("creator");
    expect(after.player1SocketId).toBe("socket-b");
    expect(after.player2Id).toBeNull();
    expect(after.players).toEqual(["creator"]);
  });

  it("a different user still takes the free seat; a third one finds the room full", async () => {
    const manager = new GameRoomManager();
    const room = manager.createRoom("ROOM02");
    await manager.joinRoom(room.id, "creator", "socket-a");

    const after = await manager.joinRoom(room.id, "rival", "socket-b");

    expect(after.player2Id).toBe("rival");
    await expect(manager.joinRoom(room.id, "third", "socket-c")).rejects.toThrow("Room is full");
  });
});
