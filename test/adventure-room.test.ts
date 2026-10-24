/**
 * Adventure battle rooms over real sockets (production handlers), on a minimal engine
 * (adventure-stub-engine.ts: an AI that only sets up and ends its turns) so the room plumbing is
 * tested fast and predictably — AI seat without a socket, masking, privacy, lucky coin, snapshots
 * and restore, the end applied once, no match rows. adventure-room-engine.test.ts runs the same
 * room on game-core's real adventure engine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import type { GameState } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import * as adventure from "../src/modules/adventure/adventure.service.js";
import { adventureRooms, roomManager } from "../src/socket/handlers.js";
import { setAdventureEngine } from "../src/socket/adventure-engine.js";
import { coinAnimationMs, type AdventurePacing } from "../src/socket/adventure-room.js";
import { createStubEngine } from "./adventure-stub-engine.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

const ADVENTURE = "pueblo-paleta-bosque-verde";
const ADVENTURE_2 = "ciudad-plateada-ciudad-celeste";
let server: Awaited<ReturnType<typeof startSocketServer>>;
let pacing: AdventurePacing;

beforeAll(async () => {
  setAdventureEngine(createStubEngine());
  // No real waits after coins (the pacing tests record them instead)
  pacing = adventureRooms.setPacing({ coinPauseScale: 0 });
  server = await startSocketServer();
});

afterAll(async () => {
  adventureRooms.setPacing(pacing);
  setAdventureEngine(null);
  await server.close();
  await prisma.$disconnect();
});

type Masked = GameState & { awaitingUserId: string | null };

/** A player with a run in battle 1 (optionally: a fixed seed, passives, deck) and its room. */
async function battleFor(
  options: { seed?: string; passives?: string[]; deck?: { cardId: string; qty: number }[]; difficulty?: "normal" | "hard"; battle?: number; adventureId?: string } = {},
) {
  const user = await createUser({}, { stats: true });
  const adventureId = options.adventureId ?? ADVENTURE;
  if (adventureId === ADVENTURE_2) {
    // Adventure 2 asks for the Boulder Badge and an entry fee
    await prisma.user.update({ where: { id: user.id }, data: { coins: { increment: 100 } } });
    await prisma.userMedal.create({ data: { userId: user.id, medalId: "boulder" } });
  }
  const run = await adventure.createRun(user.id, { adventureId, difficulty: options.difficulty ?? "normal", starterId: "charmander" });
  await prisma.adventureRun.update({
    where: { id: run.id },
    data: {
      ...(options.seed ? { seed: options.seed } : {}),
      ...(options.passives ? { passives: options.passives } : {}),
      ...(options.deck ? { deck: options.deck } : {}),
      ...(options.battle ? { currentBattle: options.battle } : {}),
    },
  });
  const { roomId } = await adventure.startRunBattle(user.id, run.id);
  await adventureRooms.aiIdle(roomId);
  return { user, runId: run.id, roomId, token: tokenFor(user) };
}

/** A connected client seated in its adventure room, tracking the last state it got. */
async function join(token: string, roomId: string) {
  const socket = await server.connect(token);
  const client = { socket, state: null as Masked | null, coins: [] as { results: string[] }[], results: [] as any[] };
  socket.on("gameState", (p: { gameState: Masked }) => { client.state = p.gameState; });
  socket.on("showCoinFlip", (p: { results: string[] }) => client.coins.push(p));
  socket.on("adventureBattleResult", (p: unknown) => client.results.push(p));
  const start = nextEvent<{ gameState: Masked; adventure: any; opponentInfo: any; isPlayer1: boolean }>(socket, "gameStart");
  socket.emit("joinRoom", { roomId });
  const payload = await start;
  client.state = payload.gameState;
  return { ...client, start: payload };
}

async function act(client: { socket: ClientSocket }, roomId: string, type: string, payload?: unknown) {
  const result = nextEvent<{ success: boolean; error?: string }>(client.socket, "actionResult");
  client.socket.emit("action", { roomId, action: { type, ...(payload !== undefined ? { payload } : {}) } });
  const res = await result;
  await adventureRooms.aiIdle(roomId);
  return res;
}

const room = (roomId: string) => roomManager.getRoom(roomId)!;

/** Place an Active (mulligan while the hand has no Basic) and get ready. */
async function setUp(client: { socket: ClientSocket }, roomId: string) {
  for (let i = 0; i < 20; i++) {
    const state = room(roomId).gameState!;
    const basic = state.playerHand.find((c) => c.kind === "pokemon" && c.stage === "basic");
    if (basic) {
      expect((await act(client, roomId, "playBasicToActive", { cardId: basic.id })).success).toBe(true);
      break;
    }
    expect((await act(client, roomId, "mulligan")).success).toBe(true);
  }
  expect((await act(client, roomId, "playerReady")).success).toBe(true);
}

/** End every human turn until the game is over (the stub AI only ends its turns). */
async function endTurnsUntilOver(client: { socket: ClientSocket }, roomId: string, maxTurns = 60) {
  for (let i = 0; i < maxTurns && room(roomId).gameState!.gamePhase !== "GAME_OVER"; i++) {
    expect(room(roomId).gameState!.isPlayerTurn).toBe(true);
    expect((await act(client, roomId, "endTurn")).success).toBe(true);
  }
}

/** The parts of a state that must replay identically (events carry timestamps). */
function essence(state: GameState) {
  const ids = (cards: { id: string }[]) => cards.map((c) => c.id);
  return {
    phase: state.gamePhase,
    result: state.gameResult,
    turn: state.turnNumber,
    playerHand: ids(state.playerHand),
    playerDeck: ids(state.playerDeck),
    playerPrizes: ids(state.playerPrizes),
    opponentHand: ids(state.opponentHand),
    opponentDeck: ids(state.opponentDeck),
    opponentPrizes: ids(state.opponentPrizes),
    actives: [state.playerActivePokemon?.pokemon.id, state.opponentActivePokemon?.pokemon.id],
    log: state.events.map((e) => e.message),
  };
}

describe("adventure battle room", () => {
  it("player 2 is the server's AI: no socket, rival shown as the opponent, hidden zones masked", async () => {
    const { user, roomId, token, runId } = await battleFor();
    const r = room(roomId);
    expect(r).toMatchObject({ status: "playing", player1Id: user.id, player2Id: null, player2SocketId: null, config: { mode: "adventure" } });
    expect(r.adventure).toEqual({ runId, userId: user.id });
    // The AI already set up its side, with nobody connected
    expect(r.gameState!.opponentReady).toBe(true);
    expect(r.gameState!.opponentActivePokemon).not.toBeNull();

    const client = await join(token, roomId);
    expect(client.start.isPlayer1).toBe(true);
    expect(client.start.opponentInfo).toMatchObject({ username: "Joven Lucas" });
    expect(client.start.adventure).toMatchObject({ runId, battle: 1, battleCount: 10, hearts: 3, maxHearts: 3, rules: [], rival: { name: "Lucas", trainerClass: "Joven" } });
    // Adventure 1's rivals have no sprite: the key is left out
    expect(client.start.adventure.rival).not.toHaveProperty("sprite");
    expect(client.state!.opponentHand.length).toBe(6); // 7 dealt, its Active placed
    expect(client.state!.opponentHand.every((c: any) => c.hidden === true)).toBe(true);
    expect(client.state!.opponentDeck.every((c: any) => c.hidden === true)).toBe(true);
    expect(client.state!.playerHand.some((c: any) => !c.hidden)).toBe(true);

    // The battle snapshot is in the run, never in its API payload
    const row = await prisma.adventureRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.battle).toMatchObject({ roomId, rngState: expect.any(Number), state: expect.any(Object) });
    expect((await adventure.getRun(user.id, runId)).battle).toEqual({ roomId });
    client.socket.disconnect();
  });

  it("the rival carries its trainer sprite when the content has one, also when the room is rebuilt", async () => {
    const { roomId, token } = await battleFor({ adventureId: ADVENTURE_2 });
    const client = await join(token, roomId);
    expect(client.start.adventure.rival).toEqual({ name: "Tomás", trainerClass: "Joven", sprite: "/sprites/adventure/trainers/youngster.png" });
    client.socket.disconnect();

    // Evicted room → rebuilt from the run on joinRoom
    await adventureRooms.evict(roomId);
    const again = await join(token, roomId);
    expect(again.start.adventure.rival).toEqual({ name: "Tomás", trainerClass: "Joven", sprite: "/sprites/adventure/trainers/youngster.png" });
    again.socket.disconnect();
  });

  it("a hard run's room plays the hard rival deck with the hard rules, also when rebuilt from the run", async () => {
    const { roomId, token, runId } = await battleFor({ difficulty: "hard", battle: 5 });
    const names = (state: GameState) =>
      [...state.opponentDeck, ...state.opponentHand, ...state.opponentPrizes, ...(state.opponentActivePokemon ? [state.opponentActivePokemon.pokemon] : [])].map((c) => c.name);
    expect(names(room(roomId).gameState!)).toContain("Venonat"); // only in the hard deck of battle 5
    const rules = ["El rival juega con 2 premios", "El rival empieza con Potion en la mano"];
    let client = await join(token, roomId);
    expect(client.start.adventure).toMatchObject({ runId, battle: 5, hearts: 2, maxHearts: 2, rules });
    client.socket.disconnect();

    await adventureRooms.evict(roomId);
    expect(roomManager.getRoom(roomId)).toBeUndefined();
    client = await join(token, roomId);
    expect(client.start.adventure).toMatchObject({ battle: 5, hearts: 2, rules });
    expect(names(room(roomId).gameState!)).toContain("Venonat");
    client.socket.disconnect();
  });

  it("nobody else may join or watch it; no kick, no lobby listing", async () => {
    const { roomId, token } = await battleFor();
    const owner = await join(token, roomId);
    const stranger = await createUser({}, { stats: true });
    const other = await server.connect(tokenFor(stranger));
    const joinError = nextEvent<{ message: string }>(other, "error");
    other.emit("joinRoom", { roomId });
    expect((await joinError).message).toBeTruthy();
    expect(room(roomId).player2Id).toBeNull();

    const watchError = nextEvent<{ code: string }>(other, "error");
    other.emit("spectateRoom", { roomId });
    expect((await watchError).code).toBe("PRIVATE_TABLE");

    const kickError = nextEvent<{ message: string }>(owner.socket, "error");
    owner.socket.emit("requestKick", { roomId });
    expect((await kickError).message).toBe("No hay tiempo límite en el Modo Aventura");
    expect(roomManager.getActiveRooms().some((r) => r.id === roomId)).toBe(false);
    expect(roomManager.getActiveRoomForUser(room(roomId).player1Id!)).toBeNull();
    owner.socket.disconnect();
    other.disconnect();
  });

  it("a scripted battle replays identically from the same seed (also restored mid-battle) and its end is applied once", async () => {
    const seed = "feedfacefeedfacefeedfacefeedface";

    // 1. Uninterrupted
    const a = await battleFor({ seed });
    const clientA = await join(a.token, a.roomId);
    await setUp(clientA, a.roomId);
    await endTurnsUntilOver(clientA, a.roomId);
    const finalA = essence(room(a.roomId).gameState!);

    // 2. Same line, but the room is evicted from memory after 3 turns and rebuilt on rejoin
    const b = await battleFor({ seed });
    let clientB = await join(b.token, b.roomId);
    await setUp(clientB, b.roomId);
    for (let i = 0; i < 3; i++) await act(clientB, b.roomId, "endTurn");
    const beforeEviction = essence(room(b.roomId).gameState!);
    clientB.socket.disconnect();
    await adventureRooms.evict(b.roomId);
    expect(roomManager.getRoom(b.roomId)).toBeUndefined();
    clientB = await join(b.token, b.roomId);
    expect(essence(room(b.roomId).gameState!)).toEqual({ ...beforeEviction, log: beforeEviction.log.slice(-200) });
    await endTurnsUntilOver(clientB, b.roomId);
    const finalB = essence(room(b.roomId).gameState!);

    expect({ ...finalB, log: undefined }).toEqual({ ...finalA, log: undefined });
    expect(finalA.phase).toBe("GAME_OVER");
    // The rival's 20-card deck runs out before the player's 24
    expect(finalA.result).toBe("victory");

    for (const [battle, client] of [[a, clientA], [b, clientB]] as const) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(client.results).toHaveLength(1);
      expect(client.results[0]).toMatchObject({ runId: battle.runId, victory: true, reason: "deck-out", run: { phase: "choosing_treasure", battle: null } });
      expect(client.results[0].run.offer).toHaveLength(3);
      // Applying again changes nothing
      await adventureRooms.finishBattle(battle.roomId, false);
      expect(await prisma.adventureBattleResult.count({ where: { runId: battle.runId } })).toBe(1);
      expect(await prisma.match.count({ where: { OR: [{ player1Id: battle.user.id }, { player2Id: battle.user.id }] } })).toBe(0);
      expect(room(battle.roomId).status).toBe("finished");
      client.socket.disconnect();
    }
  }, 60_000);

  it("surrendering loses the battle and a heart; the next battle is a new room", async () => {
    const { roomId, token, runId, user } = await battleFor();
    const client = await join(token, roomId);
    const gameOver = nextEvent<{ winner: string }>(client.socket, "gameOver");
    const result = nextEvent<any>(client.socket, "adventureBattleResult");
    await act(client, roomId, "surrender");
    expect((await gameOver).winner).toBe("player2");
    expect(await result).toMatchObject({ victory: false, reason: "surrender", run: { hearts: 2, heartsLost: 1, phase: "pre_battle", attempt: 2, battle: null }, events: [{ type: "heartLost", hearts: 2 }] });
    expect(await prisma.adventureBattleResult.findMany({ where: { runId } })).toMatchObject([{ victory: false, reason: "surrender", attempt: 1 }]);

    const again = await adventure.startRunBattle(user.id, runId);
    expect(again.roomId).not.toBe(roomId);
    expect(room(again.roomId).status).toBe("playing");
    client.socket.disconnect();
  });

  it("the lucky coin makes the first coin of the player's own action heads, once", async () => {
    const deck = [{ cardId: "base-set-048-doduo", qty: 12 }, { cardId: "base-set-097-fighting-energy", qty: 12 }];
    const { roomId, token, runId } = await battleFor({ passives: ["lucky_coin"], deck });
    const client = await join(token, roomId);
    await setUp(client, roomId);

    let attacked = false;
    for (let turn = 0; turn < 6 && !attacked; turn++) {
      const state = room(roomId).gameState!;
      expect(state.isPlayerTurn).toBe(true);
      const energy = state.playerHand.find((c) => c.kind === "energy");
      if (energy && state.playerActivePokemon!.attachedEnergy.length === 0) {
        await act(client, roomId, "attachEnergy", { cardId: energy.id, pokemonId: state.playerActivePokemon!.pokemon.id });
      }
      const coinFlip = nextEvent<{ attackName: string; results: string[] }>(client.socket, "showCoinFlip").catch(() => null);
      const attack = await act(client, roomId, "attack", { attackIndex: 0 });
      if (attack.success) {
        attacked = true;
        const coins = await coinFlip;
        expect(coins).toMatchObject({ attackName: "Ataque furia" });
        expect(coins!.results[0]).toBe("heads");
        expect((room(roomId).gameState as GameState & { passives?: any }).passives.luckyCoinUsed).toEqual({ player: true });
      } else {
        await act(client, roomId, "endTurn");
      }
    }
    expect(attacked).toBe(true);
    // Persisted with the snapshot
    await adventureRooms.flushSnapshot(roomId);
    const row = await prisma.adventureRun.findUniqueOrThrow({ where: { id: runId } });
    expect((row.battle as any).state.passives.luckyCoinUsed).toEqual({ player: true });
    expect((row.battle as any).humanActions.map((a: { type: string }) => a.type)).toContain("attack");
    client.socket.disconnect();
  }, 30_000);

  it("leaving the room keeps the battle; joining again resumes it", async () => {
    const { roomId, token } = await battleFor();
    const client = await join(token, roomId);
    client.socket.emit("leaveRoom", { roomId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(room(roomId).status).toBe("playing");
    expect(room(roomId).player1SocketId).toBeNull();
    const back = await join(token, roomId);
    expect(back.start.adventure.battle).toBe(1);
    client.socket.disconnect();
    back.socket.disconnect();
  });
});

describe("adventure AI pacing after coins", () => {
  it("coinAnimationMs: per batch 1 s + 300 ms per coin + 1.5 s, batches one after another; no coins, no pause", () => {
    expect(coinAnimationMs([])).toBe(0);
    expect(coinAnimationMs([0, 0])).toBe(0);
    expect(coinAnimationMs([1])).toBe(2_800);
    expect(coinAnimationMs([4])).toBe(3_700);
    expect(coinAnimationMs([1, 0, 2])).toBe(2_800 + 3_100);
  });

  /** A battle the player loses by deck-out inside the AI's endTurn step, its pauses recorded. */
  async function pacedBattle(endTurnCoins: number) {
    setAdventureEngine(createStubEngine({ endTurnCoins, playerDeckSize: 16 }));
    const pauses: { ms: number; phase: string }[] = [];
    let roomId = "";
    const previous = adventureRooms.setPacing({
      coinPauseScale: 1,
      sleep: async (ms) => {
        pauses.push({ ms, phase: roomManager.getRoom(roomId)?.gameState?.gamePhase ?? "?" });
      },
    });
    try {
      // 16 cards: the player's deck runs out before the rival's 20 (they draw in the AI's endTurn step)
      const battle = await battleFor({ seed: "abcdefabcdefabcdefabcdefabcdef12" });
      roomId = battle.roomId;
      const client = await join(battle.token, roomId);
      const coins: number[] = [];
      client.socket.on("showCoinFlip", (p: { results: string[] }) => coins.push(p.results.length));
      const gameOver = nextEvent<{ winner: string }>(client.socket, "gameOver", 10_000);
      await setUp(client, roomId);
      await endTurnsUntilOver(client, roomId);
      expect((await gameOver).winner).toBe("player2");
      client.socket.disconnect();
      return { pauses, coins };
    } finally {
      adventureRooms.setPacing({ coinPauseScale: previous.coinPauseScale, sleep: previous.sleep });
      setAdventureEngine(createStubEngine());
    }
  }

  it("after an AI step that showed coins, its next step and the game over wait for them", async () => {
    const { pauses, coins } = await pacedBattle(2);
    const expected = coinAnimationMs([2]);
    expect(coins.length).toBeGreaterThan(1);
    expect(coins.every((n) => n === 2)).toBe(true);
    expect(pauses.length).toBeGreaterThan(0);
    // The human answered at once: each wait is (almost) the whole animation, never more
    for (const pause of pauses) {
      expect(pause.ms).toBeGreaterThan(expected - 1_000);
      expect(pause.ms).toBeLessThanOrEqual(expected);
    }
    // The coins of the step that ended the game play before gameOver
    expect(pauses.at(-1)!.phase).toBe("GAME_OVER");
    // Every AI turn but the first waited for the coins of the one before
    expect(pauses.filter((p) => p.phase === "PLAYING").length).toBe(coins.length - 1);
  }, 30_000);

  it("without coins the AI doesn't wait", async () => {
    const { pauses, coins } = await pacedBattle(0);
    expect(coins).toEqual([]);
    expect(pauses).toEqual([]);
  }, 30_000);

  it("the player's own attack coins hold the AI's next step too", async () => {
    const pauses: number[] = [];
    const previous = adventureRooms.setPacing({ coinPauseScale: 1, sleep: async (ms) => { pauses.push(ms); } });
    try {
      const deck = [{ cardId: "base-set-048-doduo", qty: 12 }, { cardId: "base-set-097-fighting-energy", qty: 12 }];
      const { roomId, token } = await battleFor({ deck });
      const client = await join(token, roomId);
      await setUp(client, roomId);
      let attacked = false;
      for (let turn = 0; turn < 6 && !attacked; turn++) {
        const state = room(roomId).gameState!;
        const energy = state.playerHand.find((c) => c.kind === "energy");
        if (energy && state.playerActivePokemon!.attachedEnergy.length === 0) {
          await act(client, roomId, "attachEnergy", { cardId: energy.id, pokemonId: state.playerActivePokemon!.pokemon.id });
        }
        pauses.length = 0;
        attacked = (await act(client, roomId, "attack", { attackIndex: 0 })).success; // Fury Attack: 2 coins, ends the turn
        if (!attacked) await act(client, roomId, "endTurn");
      }
      expect(attacked).toBe(true);
      // The AI's endTurn (no pause of its own in the stub) waited for the 2 coins
      expect(pauses).toHaveLength(1);
      expect(pauses[0]).toBeGreaterThan(coinAnimationMs([2]) - 1_000);
      expect(pauses[0]).toBeLessThanOrEqual(coinAnimationMs([2]));
      client.socket.disconnect();
    } finally {
      adventureRooms.setPacing({ coinPauseScale: previous.coinPauseScale, sleep: previous.sleep });
    }
  }, 30_000);
});
