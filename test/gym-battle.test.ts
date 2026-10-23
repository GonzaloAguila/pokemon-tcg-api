/**
 * Gym Leader battles end to end over real sockets (docs/gym-leaders.md): gymTables / gymQueue /
 * gymBattleReady, joinGymQueue checks, entering the battle with joinRoom (gameStart + gym info +
 * Brock's fixed cosmetics), the battle on game-core's real engine and AI (no pauses), the result
 * (gymBattleResult, the medal once), the queue moving on, the challenger's clock and disconnect
 * grace, reconnecting, privacy (not listed, not watchable, no chat).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { findCardById, type GameState } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { closeRoomByAdmin, gymRooms, roomManager } from "../src/socket/handlers.js";
import { gymService } from "../src/modules/gym/gym.service.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

let server: Awaited<ReturnType<typeof startSocketServer>>;
let pacing: ReturnType<typeof gymRooms.setPacing>;
let timing: ReturnType<typeof gymRooms.setTiming>;

beforeAll(async () => {
  pacing = gymRooms.setPacing({ aiDelayScale: 0, coinPauseScale: 0 });
  timing = gymRooms.setTiming({});
  server = await startSocketServer();
});

afterEach(() => {
  gymRooms.setTiming(timing);
  gymService.configure({ readyWindowMs: 60_000 });
  gymService.reset();
});

afterAll(async () => {
  gymRooms.setPacing(pacing);
  await server.close();
  await prisma.$disconnect();
});

/** 20 Pokémon / 20 Trainers / 20 Energy without Grass or Water (passes Brock's rules). */
const LEGAL_DECK = [
  { cardDefId: "base-set-052-machop", quantity: 4 },
  { cardDefId: "base-set-046-charmander", quantity: 4 },
  { cardDefId: "gym-heroes-069-brocks-onix", quantity: 4 },
  { cardDefId: "gym-heroes-070-brocks-rhyhorn", quantity: 4 },
  { cardDefId: "team-rocket-059-machop", quantity: 4 },
  { cardDefId: "base-set-091-bill", quantity: 4 },
  { cardDefId: "base-set-088-professor-oak", quantity: 4 },
  { cardDefId: "base-set-094-potion", quantity: 4 },
  { cardDefId: "base-set-090-super-potion", quantity: 4 },
  { cardDefId: "base-set-081-energy-retrieval", quantity: 4 },
  { cardDefId: "base-set-097-fighting-energy", quantity: 12 },
  { cardDefId: "base-set-098-fire-energy", quantity: 8 },
];

async function challenger(cards: { cardDefId: string; quantity: number }[] = LEGAL_DECK) {
  const user = await createUser({}, { stats: true });
  const owned = cards.filter((c) => !/-energy$/.test(c.cardDefId) || c.cardDefId.includes("double"));
  await prisma.userCard.createMany({ data: owned.map((c) => ({ userId: user.id, cardDefId: c.cardDefId, quantity: c.quantity })) });
  const deck = await prisma.deck.create({ data: { name: "Gym", cards: cards, isValid: true, userId: user.id } });
  const socket = await server.connect(tokenFor(user));
  const client = {
    user,
    deckId: deck.id,
    socket,
    queue: [] as unknown[],
    results: [] as any[],
    ready: [] as any[],
  };
  socket.on("gymQueue", (p: unknown) => client.queue.push(p));
  socket.on("gymBattleResult", (p: unknown) => client.results.push(p));
  socket.on("gymBattleReady", (p: unknown) => client.ready.push(p));
  return client;
}
type Client = Awaited<ReturnType<typeof challenger>>;

function emitAck<T = any>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));
}

async function queueUp(client: Client) {
  return emitAck(client.socket, "joinGymQueue", { leaderId: "brock", mode: "normal", deckId: client.deckId });
}

async function enter(client: Client, roomId: string, socket: ClientSocket = client.socket) {
  const start = nextEvent<any>(socket, "gameStart", 5000);
  socket.emit("joinRoom", { roomId });
  const payload = await start;
  await gymRooms.aiIdle(roomId);
  return payload;
}

const state = (roomId: string) => roomManager.getRoom(roomId)!.gameState!;

async function act(socket: ClientSocket, roomId: string, type: string, payload?: unknown) {
  const result = nextEvent<{ success: boolean; error?: string }>(socket, "actionResult");
  socket.emit("action", { roomId, action: { type, ...(payload !== undefined ? { payload } : {}) } });
  const res = await result;
  await gymRooms.aiIdle(roomId);
  return res;
}

/** Opening: an Active (mulligans as needed), then ready; the battle starts. */
async function setUp(socket: ClientSocket, roomId: string) {
  for (let i = 0; i < 30; i++) {
    const basic = state(roomId).playerHand.find((c) => c.kind === "pokemon" && c.stage === "basic");
    if (basic) {
      expect((await act(socket, roomId, "playBasicToActive", { cardId: basic.id })).success).toBe(true);
      break;
    }
    expect((await act(socket, roomId, "mulligan")).success).toBe(true);
  }
  expect((await act(socket, roomId, "playerReady")).success).toBe(true);
  await gymRooms.aiIdle(roomId);
  expect(state(roomId).gamePhase).toBe("PLAYING");
}

/** Win on the leader's next draw: its deck is emptied, then the challenger ends their turn. */
async function winByDeckOut(client: Client, roomId: string) {
  await setUp(client.socket, roomId);
  for (let i = 0; i < 10 && !state(roomId).isPlayerTurn; i++) await gymRooms.aiIdle(roomId);
  const room = roomManager.getRoom(roomId)!;
  if (state(roomId).playerNeedsToPromote) await act(client.socket, roomId, "promote", { benchIndex: 0 });
  expect(state(roomId).isPlayerTurn).toBe(true);
  room.gameState = { ...room.gameState!, opponentDeck: [] } as GameState;
  const result = nextEvent<any>(client.socket, "gymBattleResult", 8000);
  await act(client.socket, roomId, "endTurn");
  return result;
}

async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("gym leader battles", () => {
  it("getGymTables: open gyms only, plus the user's queue", async () => {
    const a = await challenger();
    const tables = nextEvent<any[]>(a.socket, "gymTables");
    const queue = nextEvent<unknown>(a.socket, "gymQueue");
    expect(await emitAck(a.socket, "getGymTables", {})).toEqual({ ok: true });
    expect(await tables).toEqual([]);
    expect(await queue).toBeNull();

    const broadcast = nextEvent<any[]>(a.socket, "gymTables");
    gymService.open("brock", 30);
    expect(await broadcast).toEqual([
      expect.objectContaining({ leaderId: "brock", name: "Brock", avatarId: "gym-brock", medalId: "boulder", mode: "normal", status: "open", queueLength: 0, inBattle: false }),
    ]);
  });

  it("joinGymQueue refuses a closed gym, a deck against the rules and a second queue", async () => {
    const a = await challenger();
    expect(await queueUp(a)).toEqual({ ok: false, error: "El gimnasio está cerrado" });
    gymService.open("brock");
    const water = await challenger([...LEGAL_DECK.filter((c) => c.cardDefId !== "base-set-046-charmander"), { cardDefId: "base-set-063-squirtle", quantity: 4 }]);
    expect(await queueUp(water)).toEqual({ ok: false, error: "Tu mazo no puede tener Pokémon de tipo Agua" });
    const short = await challenger([
      ...LEGAL_DECK.filter((c) => c.cardDefId !== "base-set-081-energy-retrieval"),
      { cardDefId: "base-set-058-pikachu", quantity: 4 },
    ]);
    expect(await queueUp(short)).toEqual({ ok: false, error: "Tu mazo debe tener exactamente 20 Pokémon (tiene 24)" });
    expect(await emitAck(a.socket, "joinGymQueue", { leaderId: "brock", mode: "normal", deckId: "brushfire" })).toEqual({
      ok: false,
      error: "Tu mazo no puede tener Pokémon de tipo Planta",
    });
    expect(await emitAck(a.socket, "joinGymQueue", { leaderId: "brock", mode: "expert", deckId: a.deckId })).toEqual({ ok: false, error: "Ese desafío todavía no está disponible" });
    expect(await queueUp(a)).toEqual({ ok: true });
    expect(await queueUp(a)).toEqual({ ok: false, error: "Ya estás en la fila" });
    expect(await emitAck(a.socket, "joinGymQueue", { leaderId: "x y", deckId: a.deckId })).toMatchObject({ ok: false });
  });

  it("queue → ready → joinRoom → battle with Brock → medal once → the queue moves on", async () => {
    gymService.open("brock");
    const a = await challenger();
    const b = await challenger();

    const readyA = nextEvent<any>(a.socket, "gymBattleReady");
    expect(await queueUp(a)).toEqual({ ok: true });
    const { roomId, expiresAt, leaderId, mode } = await readyA;
    expect({ leaderId, mode }).toEqual({ leaderId: "brock", mode: "normal" });
    expect(roomId).toMatch(/^gym-/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(a.queue.at(-1)).toEqual({ leaderId: "brock", mode: "normal", position: 0, status: "ready", roomId, readyExpiresAt: expiresAt });

    expect(await queueUp(b)).toEqual({ ok: true });
    expect(b.queue.at(-1)).toEqual({ leaderId: "brock", mode: "normal", position: 1, status: "waiting" });

    // Somebody else can't enter A's battle
    const notFound = nextEvent<any>(b.socket, "error");
    b.socket.emit("joinRoom", { roomId });
    expect(await notFound).toMatchObject({ code: "ROOM_NOT_FOUND" });

    const tablesInBattle = nextEvent<any[]>(b.socket, "gymTables");
    const start = await enter(a, roomId);
    expect(start).toMatchObject({
      roomId,
      mode: "gym",
      isPlayer1: true,
      opponentInfo: { username: "Brock", avatarId: "gym-brock" },
      opponentCosmetics: { playmatId: "playmat-ciudad-plateada", coinId: "golem", cardBackId: "cardback-brock" },
      playerCosmetics: { playmatId: "field", coinId: "eevee", cardBackId: "default" },
      gym: { leaderId: "brock", name: "Brock", title: "Líder del Gimnasio de Ciudad Plateada", mode: "normal", medalId: "boulder", avatarId: "gym-brock" },
    });
    expect(start.gameState.gamePhase).toBe("MULLIGAN");
    expect((await tablesInBattle)[0]).toMatchObject({ inBattle: true, queueLength: 1 });
    expect(a.queue.at(-1)).toMatchObject({ status: "playing", roomId });

    // Not listed, not watchable, no chat
    const list = nextEvent<{ rooms: { id: string }[] }>(b.socket, "roomList");
    b.socket.emit("getRooms");
    expect((await list).rooms.map((r) => r.id)).not.toContain(roomId);
    const privateError = nextEvent<any>(b.socket, "error");
    b.socket.emit("spectateRoom", { roomId });
    expect(await privateError).toMatchObject({ code: "PRIVATE_TABLE" });
    let chatted = false;
    a.socket.on("chatMessage", () => (chatted = true));
    a.socket.emit("chatMessage", { roomId, message: { content: "hola" } });

    // The leader played its opening (its Active is placed, hidden) and the challenger's clock runs
    expect(state(roomId).opponentReady).toBe(true);
    expect(start.gameState.clock).toBeDefined();

    const readyB = nextEvent<any>(b.socket, "gymBattleReady", 8000);
    const result = await winByDeckOut(a, roomId);
    expect(result).toEqual({ leaderId: "brock", mode: "normal", victory: true, medalId: "boulder", medalGranted: true });
    expect(await prisma.userMedal.count({ where: { userId: a.user.id, medalId: "boulder" } })).toBe(1);
    expect(chatted).toBe(false);
    // No settlement: no match row, no coins
    expect(await prisma.match.count({ where: { OR: [{ player1Id: a.user.id }, { player2Id: a.user.id }] } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).coins).toBe(0);

    // B's turn: B surrenders (a loss, no medal)
    const roomB = (await readyB).roomId as string;
    await enter(b, roomB);
    const lost = nextEvent<any>(b.socket, "gymBattleResult", 5000);
    const over = nextEvent<any>(b.socket, "gameOver", 5000);
    expect((await act(b.socket, roomB, "surrender")).success).toBe(true);
    expect(await over).toMatchObject({ winner: "player2" });
    expect(await lost).toEqual({ leaderId: "brock", mode: "normal", victory: false, medalId: "boulder", medalGranted: false });
    expect(await prisma.userMedal.count({ where: { userId: b.user.id } })).toBe(0);

    // A beats Brock again: no second medal
    const readyAgain = nextEvent<any>(a.socket, "gymBattleReady");
    expect(await queueUp(a)).toEqual({ ok: true });
    const again = (await readyAgain).roomId as string;
    await enter(a, again);
    expect(await winByDeckOut(a, again)).toMatchObject({ victory: true, medalGranted: false });
    expect(await prisma.userMedal.count({ where: { userId: a.user.id, medalId: "boulder" } })).toBe(1);
  });

  it("a ready battle not entered in time is skipped; the next challenger gets it", async () => {
    gymService.configure({ readyWindowMs: 300 });
    gymService.open("brock");
    const a = await challenger();
    const b = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    const roomA = a.ready[0].roomId;
    const readyB = nextEvent<any>(b.socket, "gymBattleReady");
    expect(await queueUp(b)).toEqual({ ok: true });
    await readyB;
    await waitFor(() => a.queue.length > 0 && a.queue.at(-1) === null);
    const notFound = nextEvent<any>(a.socket, "error");
    a.socket.emit("joinRoom", { roomId: roomA });
    expect(await notFound).toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  it("the challenger's clock running out loses the battle", async () => {
    gymRooms.setTiming({ turnClockMs: 400 });
    gymService.open("brock");
    const a = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    const roomId = a.ready[0].roomId;
    const result = nextEvent<any>(a.socket, "gymBattleResult", 5000);
    const over = nextEvent<any>(a.socket, "gameOver", 5000);
    await enter(a, roomId);
    expect(await over).toEqual({ winner: "player2", reason: "Se acabó tu tiempo" });
    expect(await result).toMatchObject({ victory: false, medalGranted: false });
    expect(state(roomId)).toMatchObject({ gamePhase: "GAME_OVER", gameResult: "defeat" });
    expect(gymService.queueStateOf(a.user.id)).toBeNull();
  });

  it("disconnecting: back within the grace the battle goes on (joinRoom restores it); away too long, it is lost", async () => {
    gymRooms.setTiming({ disconnectGraceMs: 600 });
    gymService.open("brock");
    const a = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    const roomId = a.ready[0].roomId;
    await enter(a, roomId);
    a.socket.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const tab = await server.connect(tokenFor(a.user));
    const results: any[] = [];
    tab.on("gymBattleResult", (p: unknown) => results.push(p));
    const back = await enter(a, roomId, tab);
    expect(back).toMatchObject({ roomId, gym: { leaderId: "brock" }, opponentInfo: { username: "Brock" } });
    await new Promise((r) => setTimeout(r, 700));
    expect(results).toEqual([]);
    expect(state(roomId).gamePhase).not.toBe("GAME_OVER");

    tab.disconnect();
    await waitFor(() => roomManager.getRoom(roomId)?.gameState?.gamePhase === "GAME_OVER", 3000);
    expect(state(roomId).gameResult).toBe("defeat");
    expect(state(roomId).events.at(-1)?.message).toBe("Jugador 1 abandonó la batalla");
    await waitFor(() => gymService.queueStateOf(a.user.id) === null);
  });

  it("a deck that no longer passes when the battle starts skips the challenger", async () => {
    gymService.open("brock");
    const a = await challenger();
    const b = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    expect(await queueUp(b)).toEqual({ ok: true });
    await prisma.userCard.deleteMany({ where: { userId: a.user.id, cardDefId: "base-set-052-machop" } });
    const readyB = nextEvent<any>(b.socket, "gymBattleReady");
    const error = nextEvent<any>(a.socket, "error");
    a.socket.emit("joinRoom", { roomId: a.ready[0].roomId });
    expect(await error).toMatchObject({ code: "GYM_DECK_INVALID", message: expect.stringContaining("Mazo inválido") });
    await readyB;
    expect(gymService.queueStateOf(a.user.id)).toBeNull();
  });

  it("Brock answers a step of the challenger's Trainer (Erika: he draws), the turn goes on", async () => {
    gymService.open("brock");
    const a = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    const roomId = a.ready[0].roomId;
    await enter(a, roomId);
    await setUp(a.socket, roomId);
    if (state(roomId).playerNeedsToPromote) await act(a.socket, roomId, "promote", { benchIndex: 0 });
    expect(state(roomId).isPlayerTurn).toBe(true);
    const room = roomManager.getRoom(roomId)!;
    const erika = { ...findCardById("gym-heroes-016-erika")!, id: "erika-test" } as GameState["playerHand"][number];
    room.gameState = { ...room.gameState!, playerHand: [...room.gameState!.playerHand, erika] };
    const handBefore = state(roomId).opponentHand.length;

    const actions: string[] = [];
    a.socket.on("opponentAction", (p: { type: string }) => actions.push(p.type));
    expect((await act(a.socket, roomId, "startTrainer", { cardId: "erika-test", selections: [["1"]] })).success).toBe(true);
    await waitFor(() => !(state(roomId) as { pendingTrainerChoice?: unknown }).pendingTrainerChoice);
    await gymRooms.aiIdle(roomId);
    await waitFor(() => actions.includes("answerTrainerChoice"));
    expect(state(roomId).events.at(-1)?.message).toBe("Erika: el otro jugador robó 3 cartas");
    expect(state(roomId).playerDiscard.map((c) => c.id)).toContain("erika-test");
    expect(state(roomId).opponentHand.length).toBeGreaterThan(handBefore);
    expect(state(roomId).isPlayerTurn).toBe(true);
    expect(state(roomId).gamePhase).toBe("PLAYING");
  });

  it("a gym battle closed from the backoffice ends without a result and the queue moves on", async () => {
    gymService.open("brock");
    const a = await challenger();
    const b = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    expect(await queueUp(b)).toEqual({ ok: true });
    const roomId = a.ready[0].roomId;
    await enter(a, roomId);
    const closed = nextEvent<any>(a.socket, "gameClosed");
    const readyB = nextEvent<any>(b.socket, "gymBattleReady");
    expect(closeRoomByAdmin(server.io, roomId)).toBe(true);
    expect(await closed).toMatchObject({ roomId });
    await readyB;
    expect(gymService.queueStateOf(a.user.id)).toBeNull();
    expect(a.results).toEqual([]);
  });

  it("leaveGymQueue: out of the queue; refused once the battle started", async () => {
    gymService.open("brock");
    const a = await challenger();
    const b = await challenger();
    expect(await queueUp(a)).toEqual({ ok: true });
    expect(await queueUp(b)).toEqual({ ok: true });
    expect(await emitAck(b.socket, "leaveGymQueue", { leaderId: "brock" })).toEqual({ ok: true });
    expect(b.queue.at(-1)).toBeNull();
    expect(await emitAck(b.socket, "leaveGymQueue", { leaderId: "brock" })).toEqual({ ok: false, error: "No estás en la fila de este gimnasio" });
    await enter(a, a.ready[0].roomId);
    expect(await emitAck(a.socket, "leaveGymQueue", { leaderId: "brock" })).toEqual({ ok: false, error: "Tu batalla ya empezó: termínala o ríndete" });
  });
});
