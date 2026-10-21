/**
 * Regression tests for the 2026-10-14 multiplayer bugs (GameRoomManager level):
 * 1  the awaited player (kick target) is whoever owes the pending promotion / Prize / answer
 * 3  mulligan only in MULLIGAN, without an Active nor Basics in hand; ready only before PLAYING
 * 4  a finished game takes no more actions
 * 9  joinRoom never creates a room
 * 10 a waiting room whose creator left is hidden while they are offline (kept: persistent tables);
 *    the creator deletes it by user id from any socket
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  GamePhase,
  getDeckById,
  initializeMultiplayerGame,
  isPlayableAsBasic,
  swapSides,
  type GameCard,
  type GameState,
  type PokemonInPlay,
} from "@gonzaloaguila/game-core";
import { GameRoomManager, RoomNotFoundError, awaitedSide } from "../src/socket/rooms.js";

const S1 = "sock-1";
const S2 = "sock-2";

function byName(name: string): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === "Base Set") ?? ALL_CARDS.find((c) => c.name === name);
  if (!found) throw new Error(`card ${name} not in catalog`);
  return found as GameCard;
}
const cardAs = (name: string, id: string): GameCard => ({ ...byName(name), id });

function inPlay(name: string, id: string, opts: { energy?: number; damage?: number } = {}): PokemonInPlay {
  return {
    pokemon: cardAs(name, id),
    attachedEnergy: Array.from({ length: opts.energy ?? 0 }, (_, i) => cardAs("Lightning Energy", `${id}-e${i}`)),
    attachedTrainers: [],
    previousEvolutions: [],
    currentDamage: opts.damage ?? 0,
    statusConditions: [],
    playedOnTurn: 0,
  } as unknown as PokemonInPlay;
}

/** A PLAYING game in player 1's perspective where it is player 1's turn (P1 = "p1", P2 = "p2"). */
function playingRoom(board: Partial<GameState> = {}) {
  const manager = new GameRoomManager(() => "heads");
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const state = {
    ...base,
    gamePhase: GamePhase.Playing,
    gameStarted: true,
    turnNumber: 5,
    isPlayerTurn: true,
    startingPlayer: "player",
    playerReady: true,
    opponentReady: true,
    playerActivePokemon: inPlay("Pikachu", "p1-active", { energy: 1 }),
    playerBench: [],
    playerHand: [],
    playerDeck: base.playerDeck.slice(0, 20),
    playerPrizes: base.playerDeck.slice(20, 26),
    playerDiscard: [],
    opponentActivePokemon: inPlay("Pikachu", "p2-active", { damage: 30 }),
    opponentBench: [inPlay("Pikachu", "p2-bench")],
    opponentHand: base.opponentDeck.slice(0, 5),
    opponentDeck: base.opponentDeck.slice(5, 25),
    opponentPrizes: base.opponentDeck.slice(25, 31),
    opponentDiscard: [],
    energyAttachedThisTurn: true,
    activeModifiers: [],
    events: [],
    ...board,
  } as unknown as GameState;
  const room = manager.createRoom();
  Object.assign(room, {
    player1Id: "p1",
    player2Id: "p2",
    players: ["p1", "p2"],
    player1SocketId: S1,
    player2SocketId: S2,
    status: "playing",
    gameState: state,
    turnStartedAt: Date.now(),
  });
  const act = (socket: string, type: string, payload: unknown = {}) => manager.executeAction(room.id, socket, { type, payload });
  return { manager, room, act };
}

describe("bug 1: the awaited player is whoever owes the pending promotion / Prize / answer", () => {
  it("after a Knock Out the defender who doesn't promote is awaited; the attacker can kick them, not the reverse", async () => {
    const t = playingRoom();
    // Pikachu's Gnaw (10) Knocks Out the damaged Defending Pikachu (40 HP, 30 damage)
    const attack = await t.act(S1, "attack", { attackIndex: 0 });
    expect(attack.success, attack.error).toBe(true);
    const afterKo = t.room.gameState!;
    expect(afterKo.opponentNeedsToPromote).toBe(true);
    expect(afterKo.playerCanTakePrize).toBe(true);
    // Both owe something (P1 a Prize, P2 a promotion): nobody may kick
    expect(awaitedSide(afterKo)).toBeNull();
    expect(t.manager.getAwaitingUserId(t.room)).toBeNull();

    const prize = await t.act(S1, "takePrize", { prizeIndex: 0 });
    expect(prize.success, prize.error).toBe(true);
    // Only P2's promotion is left; it is still P1's turn
    expect(t.room.gameState!.isPlayerTurn).toBe(true);
    expect(awaitedSide(t.room.gameState)).toBe("player2");
    expect(t.manager.getAwaitingUserId(t.room)).toBe("p2");

    // The turn timer ran out: the AFK player (P2) can't kick the waiting one, the waiting one (P1) can
    t.room.turnStartedAt = Date.now() - 181_000;
    const byAfk = t.manager.requestKick(t.room.id, S2);
    expect(byAfk.success).toBe(false);
    expect(byAfk.error).toMatch(/esperando/);
    expect(t.room.status).toBe("playing");

    const byWaiting = t.manager.requestKick(t.room.id, S1);
    expect(byWaiting).toEqual({ success: true, winner: "player1" });
    expect(t.room.status).toBe("finished");
    expect(t.manager.getAwaitingUserId(t.room)).toBeNull();
  });

  it("before the timer runs out nobody is kicked; on a plain turn the turn's player is awaited", async () => {
    const t = playingRoom();
    expect(awaitedSide(t.room.gameState)).toBe("player1");
    expect(t.manager.getAwaitingUserId(t.room)).toBe("p1");
    expect(t.manager.requestKick(t.room.id, S1).success).toBe(false); // can't kick yourself
    expect(t.manager.requestKick(t.room.id, S2).error).toBe("El rival aún tiene tiempo");
    t.room.turnStartedAt = Date.now() - 181_000;
    expect(t.manager.requestKick(t.room.id, S2)).toEqual({ success: true, winner: "player2" });
  });

  it("player 2 owing a promotion is awaited in player 2's own perspective too (stored state is P1's)", () => {
    const t = playingRoom({ opponentNeedsToPromote: true, opponentActivePokemon: null } as Partial<GameState>);
    expect(awaitedSide(t.room.gameState)).toBe("player2");
    // Swapped (P2's view): the "player" side owes, but awaitedSide always reads the stored P1 view
    expect(swapSides(t.room.gameState!).playerNeedsToPromote).toBe(true);
  });

  it("opening: the only player not ready is awaited", () => {
    const t = playingRoom({ gamePhase: GamePhase.Mulligan, playerReady: true, opponentReady: false } as Partial<GameState>);
    expect(awaitedSide(t.room.gameState)).toBe("player2");
    t.room.gameState = { ...t.room.gameState!, playerReady: false };
    expect(awaitedSide(t.room.gameState)).toBeNull();
  });
});

describe("bug 3: mulligan and ready only during the opening", () => {
  const energyHand = (prefix: string) => Array.from({ length: 7 }, (_, i) => cardAs("Water Energy", `${prefix}-w${i}`));

  function openingRoom() {
    const t = playingRoom({
      gamePhase: GamePhase.Mulligan,
      gameStarted: false,
      turnNumber: 0,
      isPlayerTurn: false,
      startingPlayer: null,
      playerReady: false,
      opponentReady: false,
      playerActivePokemon: null,
      opponentActivePokemon: null,
      opponentBench: [],
    } as unknown as Partial<GameState>);
    return t;
  }

  it("a hand with a Basic can't mulligan; a hand without one can (7 new cards)", async () => {
    const t = openingRoom();
    t.room.gameState = { ...t.room.gameState!, playerHand: [cardAs("Pikachu", "basic"), ...energyHand("p1").slice(1)] };
    const refused = await t.act(S1, "mulligan");
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/Pokémon básico en la mano/);

    t.room.gameState = { ...t.room.gameState!, opponentHand: energyHand("p2") };
    const ok = await t.act(S2, "mulligan");
    expect(ok.success, ok.error).toBe(true);
    expect(t.room.gameState!.opponentHand).toHaveLength(7);
  });

  it("no mulligan once the Active is placed or the player is ready; ready needs an Active", async () => {
    const t = openingRoom();
    t.room.gameState = { ...t.room.gameState!, playerHand: [cardAs("Pikachu", "basic"), ...energyHand("p1").slice(1)] };
    const notReady = await t.act(S1, "playerReady");
    expect(notReady.success).toBe(false);
    expect(notReady.error).toBe("Primero coloca tu Pokémon activo");

    expect((await t.act(S1, "playBasicToActive", { cardId: "basic" })).success).toBe(true);
    t.room.gameState = { ...t.room.gameState!, playerHand: energyHand("p1b") };
    const afterActive = await t.act(S1, "mulligan");
    expect(afterActive.success).toBe(false);
    expect(afterActive.error).toBe("Ya colocaste tu Pokémon activo");

    expect((await t.act(S1, "playerReady")).success).toBe(true);
    expect((await t.act(S1, "playerReady")).error).toBe("Ya estás listo");
  });

  it("during PLAYING neither player can mulligan (on or off turn) nor send ready", async () => {
    const t = playingRoom({ playerHand: energyHand("p1"), opponentHand: energyHand("p2") });
    const before = t.room.gameState;
    for (const socket of [S1, S2]) {
      const mulligan = await t.act(socket, "mulligan");
      expect(mulligan.success).toBe(false);
      expect(mulligan.error).toBe("La preparación de la partida ya terminó");
      const ready = await t.act(socket, "playerReady");
      expect(ready.success).toBe(false);
    }
    expect(t.room.gameState).toBe(before);
    expect(t.room.gameState!.opponentHand.map((c) => c.id)).toEqual(energyHand("p2").map((c) => c.id));
  });

  it("game-core's hasBasicPokemon semantics: a Mysterious Fossil counts as a Basic", async () => {
    const fossil = ALL_CARDS.find((c) => c.name === "Mysterious Fossil");
    expect(fossil && isPlayableAsBasic(fossil)).toBe(true);
    const t = openingRoom();
    t.room.gameState = { ...t.room.gameState!, playerHand: [{ ...(fossil as GameCard), id: "fossil" }, ...energyHand("p1").slice(1)] };
    expect((await t.act(S1, "mulligan")).success).toBe(false);
  });
});

describe("bug 4: a finished game takes no more actions", () => {
  it("after a surrender nobody can surrender again, promote, end the turn or flip coins", async () => {
    const t = playingRoom({ opponentNeedsToPromote: true, opponentActivePokemon: null } as Partial<GameState>);
    const surrender = await t.act(S1, "surrender");
    expect(surrender).toMatchObject({ success: true, gameOver: true, winner: "player2" });
    expect(t.room.status).toBe("finished");
    const finalState = t.room.gameState;

    for (const [socket, type, payload] of [
      [S2, "surrender", {}],
      [S1, "surrender", {}],
      [S2, "promote", { benchIndex: 0 }],
      [S1, "endTurn", {}],
    ] as const) {
      const res = await t.act(socket, type, payload);
      expect(res.success).toBe(false);
      expect(res.error).toBe("La partida ya terminó");
      expect(res.gameOver).toBeUndefined();
    }
    expect(t.room.gameState).toBe(finalState);
    expect(t.manager.requestCoinFlip(t.room.id, S1, { purpose: "trainer", cardId: "x" })).toEqual({
      success: false,
      error: "La partida ya terminó",
    });
    expect(t.manager.requestKick(t.room.id, S1).success).toBe(false);
  });

  it("a GAME_OVER state is closed even if the room status lagged behind", async () => {
    const t = playingRoom({ gamePhase: GamePhase.GameOver, gameResult: "victory" } as Partial<GameState>);
    const res = await t.act(S2, "surrender");
    expect(res).toEqual({ success: false, error: "La partida ya terminó" });
  });
});

describe("bug 9: joinRoom never creates a room", () => {
  it("rejects an unknown room id with RoomNotFoundError and leaves nothing behind", async () => {
    const manager = new GameRoomManager();
    const join = manager.joinRoom("GONE11", "user-a", "sock-a");
    await expect(join).rejects.toBeInstanceOf(RoomNotFoundError);
    await expect(manager.joinRoom("GONE11", "user-a", "sock-a")).rejects.toMatchObject({ code: "ROOM_NOT_FOUND", message: "La partida ya no existe" });
    expect(manager.getRoom("GONE11")).toBeUndefined();
    expect(manager.getActiveRooms()).toHaveLength(0);
  });
});

describe("bug 10: a waiting room whose creator left (persistent tables since 2026-10-21)", () => {
  it("is kept: hidden and not joinable while the creator is offline, listed again once online", async () => {
    let online = false;
    const manager = new GameRoomManager(undefined, { isUserOnline: () => online });
    const closed: string[] = [];
    manager.setOnRoomClosed((id) => closed.push(id));
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    expect(manager.getActiveRooms().map((r) => r.id)).toEqual([room.id]);

    await manager.handleDisconnect("lobby-1");
    expect(manager.getActiveRooms()).toHaveLength(0);
    expect(manager.getAvailableRooms()).toHaveLength(0);
    await expect(manager.joinRoom(room.id, "joiner", "sock-j")).rejects.toThrow("El creador de la mesa no está conectado");
    expect(manager.getRoom(room.id)).toBeDefined();
    expect(closed).toEqual([]);

    online = true; // the creator is on another page (presence socket)
    expect(manager.getActiveRooms().map((r) => r.id)).toEqual([room.id]);
  });

  it("the creator takes their seat back from a new socket", async () => {
    const manager = new GameRoomManager(undefined, { isUserOnline: () => false });
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    await manager.handleDisconnect("lobby-1");
    await manager.joinRoom(room.id, "creator", "lobby-2");
    expect(manager.getRoom(room.id)?.player1SocketId).toBe("lobby-2");
    expect(manager.getActiveRooms().map((r) => r.id)).toEqual([room.id]);
  });

  it("the creator deletes it by user id from another socket; nobody else can, nor once it started", async () => {
    const manager = new GameRoomManager();
    const room = manager.createRoom();
    await manager.joinRoom(room.id, "creator", "lobby-1");
    expect(manager.deleteRoom(room.id, "someone-else")).toBe(false);
    expect(manager.deleteRoom(room.id, "creator")).toBe(true);
    expect(manager.getRoom(room.id)).toBeUndefined();

    const started = manager.createRoom();
    await manager.joinRoom(started.id, "creator", "lobby-1");
    started.status = "playing";
    expect(manager.deleteRoom(started.id, "creator")).toBe(false);
  });
});
