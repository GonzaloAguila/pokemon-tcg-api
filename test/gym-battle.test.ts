/**
 * Gym Leader battles end to end over real sockets (docs/gym-leaders.md, v2.1): gymTables /
 * gymSeries, challengeGym on a free table (its checks, the 100-coin entry cost, the first of two
 * challenges wins), best of 3 (each game its own room, entered with joinRoom; gameStart + gym info
 * + Brock's fixed cosmetics; Pewter City Gym in play from the start), the battle on game-core's
 * real engine and AI (no pauses), the result once per series (gymBattleResult with the score and
 * the version's first-victory rewards, once), the table free again, normal and expert at once,
 * the challenger's clock (a lost game) and disconnect grace (the series forfeited, also never
 * entering), reconnecting, privacy (not listed, nobody else may join or watch, no chat), Brock's
 * emotes, the admin close (entry cost back).
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
  gymService.reset();
});

afterAll(async () => {
  gymRooms.setPacing(pacing);
  await server.close();
  await prisma.$disconnect();
});

/** 20 different Basic Pokémon (Fire / Water / Lightning / Colorless, none of Brock's). */
const POKEMON = [
  "base-set-003-chansey", "base-set-005-clefairy", "base-set-016-zapdos", "base-set-020-electabuzz",
  "base-set-026-dratini", "base-set-027-farfetchd", "base-set-028-growlithe", "base-set-035-magikarp",
  "base-set-036-magmar", "base-set-039-porygon", "base-set-041-seel", "base-set-046-charmander",
  "base-set-048-doduo", "base-set-053-magnemite", "base-set-057-pidgey", "base-set-058-pikachu",
  "base-set-059-poliwag", "base-set-060-ponyta", "base-set-061-rattata", "base-set-063-squirtle",
];
/** 20 different Trainers. */
const TRAINERS = [
  "base-set-091-bill", "base-set-088-professor-oak", "base-set-094-potion", "base-set-090-super-potion",
  "base-set-081-energy-retrieval", "base-set-095-switch", "base-set-084-pluspower", "base-set-080-defender",
  "base-set-082-full-heal", "base-set-093-gust-of-wind", "base-set-092-energy-removal", "base-set-079-super-energy-removal",
  "base-set-085-pokemon-center", "base-set-078-scoop-up", "base-set-089-revive", "base-set-083-maintenance",
  "base-set-074-item-finder", "base-set-071-computer-search", "base-set-075-lass", "base-set-087-pokedex",
];

/** One copy of everything but basic Energy: passes both of Brock's versions. */
const LEGAL_DECK = [
  ...POKEMON.map((cardDefId) => ({ cardDefId, quantity: 1 })),
  ...TRAINERS.map((cardDefId) => ({ cardDefId, quantity: 1 })),
  { cardDefId: "base-set-098-fire-energy", quantity: 10 },
  { cardDefId: "base-set-102-water-energy", quantity: 10 },
];

const swapCards = (out: string[], add: { cardDefId: string; quantity: number }[]) => [...LEGAL_DECK.filter((c) => !out.includes(c.cardDefId)), ...add];

async function challenger(cards: { cardDefId: string; quantity: number }[] = LEGAL_DECK, coins = 1000) {
  const user = await createUser({ coins }, { stats: true });
  const owned = new Map<string, number>();
  for (const c of cards) if (!/-energy$/.test(c.cardDefId) || c.cardDefId.includes("double")) owned.set(c.cardDefId, (owned.get(c.cardDefId) ?? 0) + c.quantity);
  await prisma.userCard.createMany({ data: [...owned].map(([cardDefId, quantity]) => ({ userId: user.id, cardDefId, quantity })) });
  const deck = await prisma.deck.create({ data: { name: "Gym", cards: cards, isValid: true, userId: user.id } });
  const socket = await server.connect(tokenFor(user));
  const client = { user, deckId: deck.id, socket, series: [] as any[], results: [] as any[], attempts: [] as any[] };
  socket.on("gymSeries", (p: unknown) => client.series.push(p));
  socket.on("gymAttempts", (p: unknown) => client.attempts.push(p));
  socket.on("gymBattleResult", (p: unknown) => client.results.push(p));
  return client;
}
type Client = Awaited<ReturnType<typeof challenger>>;

function emitAck<T = any>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));
}

function challenge(client: Client, mode: "normal" | "expert" = "normal", deckId = client.deckId) {
  return emitAck(client.socket, "challengeGym", { leaderId: "brock", mode, deckId });
}

/** Challenge (must be accepted): the first game's room id. */
async function challenged(client: Client, mode: "normal" | "expert" = "normal"): Promise<string> {
  const res = await challenge(client, mode);
  expect(res).toEqual({ ok: true, roomId: expect.stringMatching(/^gym-/) });
  return res.roomId;
}

async function enter(client: Client, roomId: string, socket: ClientSocket = client.socket) {
  const start = nextEvent<any>(socket, "gameStart", 5000);
  socket.emit("joinRoom", { roomId });
  const payload = await start;
  await gymRooms.aiIdle(roomId);
  return payload;
}

const state = (roomId: string) => roomManager.getRoom(roomId)!.gameState!;
const coinsOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).coins;

async function act(socket: ClientSocket, roomId: string, type: string, payload?: unknown) {
  const result = nextEvent<{ success: boolean; error?: string }>(socket, "actionResult");
  socket.emit("action", { roomId, action: { type, ...(payload !== undefined ? { payload } : {}) } });
  const res = await result;
  await gymRooms.aiIdle(roomId);
  return res;
}

/**
 * Opening: a Chansey (120 HP) as Active and another on the Bench, then ready; the game starts.
 * Deterministic: a random hand's lone 30–50 HP Basic could be knocked out on Brock's first turn
 * (no Bench: the game would end at once), while nothing Brock can do on one turn (one Energy,
 * Double Colorless included, two PlusPower, Weakness) reaches 120.
 */
let tankIds = 0;
async function setUp(socket: ClientSocket, roomId: string) {
  const room = roomManager.getRoom(roomId)!;
  const chansey = () => ({ ...findCardById("base-set-003-chansey")!, id: `tank-${++tankIds}` }) as GameState["playerHand"][number];
  const [active, benched] = [chansey(), chansey()];
  room.gameState = { ...room.gameState!, playerHand: [...room.gameState!.playerHand, active, benched] };
  expect((await act(socket, roomId, "playBasicToActive", { cardId: active.id })).success).toBe(true);
  expect((await act(socket, roomId, "playBasicToBench", { cardId: benched.id })).success).toBe(true);
  expect((await act(socket, roomId, "playerReady")).success).toBe(true);
  await gymRooms.aiIdle(roomId);
  expect(state(roomId).gamePhase).toBe("PLAYING");
}

/** The challenger's next gymSeries after `trigger` (next / finished). */
async function seriesAfter(client: Client, trigger: () => Promise<unknown>) {
  const update = nextEvent<any>(client.socket, "gymSeries", 8000);
  await trigger();
  return update;
}

/** Enter the game and win it on the leader's next draw (its deck emptied): the next gymSeries. */
async function winGame(client: Client, roomId: string) {
  await enter(client, roomId);
  await setUp(client.socket, roomId);
  for (let i = 0; i < 10 && !state(roomId).isPlayerTurn; i++) await gymRooms.aiIdle(roomId);
  const room = roomManager.getRoom(roomId)!;
  if (state(roomId).playerNeedsToPromote) await act(client.socket, roomId, "promote", { benchIndex: 0 });
  expect(state(roomId).isPlayerTurn).toBe(true);
  room.gameState = { ...room.gameState!, opponentDeck: [] } as GameState;
  return seriesAfter(client, () => act(client.socket, roomId, "endTurn"));
}

/** Enter the game and surrender it: the next gymSeries. */
async function loseGame(client: Client, roomId: string) {
  await enter(client, roomId);
  return seriesAfter(client, async () => expect((await act(client.socket, roomId, "surrender")).success).toBe(true));
}

async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const NORMAL_REWARDS = { medalId: "boulder", coins: 1500, coinId: "golem", cardBackId: "cardback-brock" };
const EXPERT_REWARDS = { medalId: null, coins: 3000, coinId: null, cardBackId: "cardback-brock-expert" };
const score = (challengerWins: number, leaderWins: number) => ({ challenger: challengerWins, leader: leaderWins });

describe("gym leader battles", () => {
  it("getGymTables: open tables only, plus the user's series (null: no gymSeries)", async () => {
    const a = await challenger();
    const tables = nextEvent<any[]>(a.socket, "gymTables");
    expect(await emitAck(a.socket, "getGymTables", {})).toEqual({
      ok: true,
      tables: [],
      mySeries: null,
      myAttempts: { brock: { used: 0, perDay: 2, resetsAt: expect.any(Number) } },
    });
    expect(await tables).toEqual([]);
    expect(a.series).toEqual([]);

    const broadcast = nextEvent<any[]>(a.socket, "gymTables");
    gymService.open("brock", "normal", 30);
    expect(await broadcast).toEqual([
      expect.objectContaining({
        leaderId: "brock",
        mode: "normal",
        status: "open",
        inBattle: false,
        challenger: null,
        series: null,
        bestOf: 3,
        entryCost: 100,
        rules: {
          bannedPokemonTypes: ["grass", "psychic", "fighting"],
          bannedOwners: ["Brock"],
          noStadiums: true,
          maxTrainers: 20,
          maxTrainerCopies: 2,
          fixedStadium: { cardId: "gym-heroes-115-pewter-city-gym", name: "Pewter City Gym" },
        },
        rewards: NORMAL_REWARDS,
      }),
    ]);
  });

  it("challengeGym refuses a closed table, a deck against the rules, a short balance, a bad payload — charging nothing", async () => {
    const a = await challenger();
    expect(await challenge(a)).toEqual({ ok: false, error: "El gimnasio está cerrado" });
    gymService.open("brock", "normal");
    expect(await challenge(a, "expert")).toEqual({ ok: false, error: "El gimnasio está cerrado" });
    const psychic = await challenger(swapCards(["base-set-003-chansey"], [{ cardDefId: "base-set-043-abra", quantity: 1 }]));
    expect(await challenge(psychic)).toEqual({ ok: false, error: "Tu mazo no puede tener Pokémon de tipo Psíquico (Abra)" });
    const brocks = await challenger(swapCards(["base-set-003-chansey"], [{ cardDefId: "gym-heroes-073-brocks-vulpix", quantity: 1 }]));
    expect(await challenge(brocks)).toEqual({ ok: false, error: "Tu mazo no puede tener Pokémon de Brock (Brock's Vulpix)" });
    const stadium = await challenger(swapCards(["base-set-075-lass"], [{ cardDefId: "gym-heroes-115-pewter-city-gym", quantity: 1 }]));
    expect(await challenge(stadium)).toEqual({ ok: false, error: "Tu mazo no puede tener cartas de Estadio (Pewter City Gym)" });
    const bills = await challenger(swapCards(["base-set-091-bill", "base-set-074-item-finder", "base-set-071-computer-search", "base-set-075-lass"], [{ cardDefId: "base-set-091-bill", quantity: 4 }]));
    expect(await challenge(bills)).toEqual({ ok: false, error: "Tu mazo no puede tener más de 2 copias de Bill (tiene 4)" });
    const poor = await challenger(LEGAL_DECK, 99);
    expect(await challenge(poor)).toEqual({ ok: false, error: "Necesitás 100 monedas para retar a Brock" });
    expect(await challenge(a, "normal", "brushfire")).toEqual({ ok: false, error: "Tu mazo no puede tener Pokémon de tipo Planta (Bellsprout)" });
    expect(await emitAck(a.socket, "challengeGym", { leaderId: "misty", mode: "normal", deckId: a.deckId })).toEqual({ ok: false, error: "Ese gimnasio no existe" });
    expect(await emitAck(a.socket, "challengeGym", { leaderId: "x y", deckId: a.deckId })).toMatchObject({ ok: false });
    expect(await emitAck(a.socket, "challengeGym", { leaderId: "brock", mode: "hard", deckId: a.deckId })).toMatchObject({ ok: false });
    expect(gymService.tables()[0]).toMatchObject({ inBattle: false });
    expect(await coinsOf(a.user.id)).toBe(1000);
    expect(await coinsOf(poor.user.id)).toBe(99);
    expect(await prisma.transaction.count({ where: { userId: { in: [a.user.id, poor.user.id, bills.user.id] } } })).toBe(0);
  });

  it("best of 3: challenge (100 coins) → game 1 → next game → 2-0 → rewards once → the table is free again", async () => {
    gymService.open("brock", "normal");
    const a = await challenger();
    const b = await challenger();
    const lobby = await server.connect(tokenFor(b.user));

    const tablesInBattle = nextEvent<any[]>(lobby, "gymTables");
    const game1 = await challenged(a);
    expect(await coinsOf(a.user.id)).toBe(900);
    expect(await prisma.transaction.findFirst({ where: { userId: a.user.id } })).toMatchObject({ type: "gym_entry", amount: -100, description: "Reto a Brock: -100 monedas" });
    expect(a.series.at(-1)).toEqual({ leaderId: "brock", mode: "normal", game: 1, score: score(0, 0), roomId: game1, status: "playing" });
    expect((await tablesInBattle)[0]).toMatchObject({ inBattle: true, challenger: { username: a.user.username }, series: { game: 1, score: score(0, 0) } });
    expect(await emitAck(a.socket, "getGymTables", {})).toMatchObject({ mySeries: { roomId: game1, status: "playing" } });

    // The table is taken; the challenger can't take another one
    expect(await challenge(b)).toEqual({ ok: false, error: "Brock está en batalla: esperá a que termine" });
    gymService.open("brock", "expert");
    expect(await challenge(a, "expert")).toEqual({ ok: false, error: "Ya estás en una batalla de gimnasio" });
    expect(await coinsOf(a.user.id)).toBe(900);

    const start = await enter(a, game1);
    expect(start).toMatchObject({
      roomId: game1,
      mode: "gym",
      isPlayer1: true,
      opponentInfo: { username: "Brock", avatarId: "gym-brock" },
      opponentCosmetics: { playmatId: "playmat-ciudad-plateada", coinId: "golem", cardBackId: "cardback-brock" },
      playerCosmetics: { playmatId: "field", coinId: "eevee", cardBackId: "default" },
      gym: { leaderId: "brock", name: "Brock", title: "Líder del Gimnasio de Ciudad Plateada", mode: "normal", medalId: "boulder", avatarId: "gym-brock", game: 1, bestOf: 3, score: score(0, 0) },
    });
    expect(start.gameState.gamePhase).toBe("MULLIGAN");
    // Pewter City Gym in play from the start; the log names the leader and the game
    expect(start.gameState.stadium).toMatchObject({ card: { name: "Pewter City Gym" }, playedBy: "opponent" });
    const messages = start.gameState.events.map((e: { message: string }) => e.message);
    expect(messages[0]).toBe("Comienza la batalla contra Brock (partida 1 de 3)");
    expect(messages).toContain("Pewter City Gym está en juego durante toda la batalla");
    expect(messages.join(" ")).not.toMatch(/aventura/i);
    expect(state(game1).opponentReady).toBe(true);
    expect(start.gameState.clock).toBeDefined();
    let chatted = false;
    a.socket.on("chatMessage", () => (chatted = true));
    a.socket.emit("chatMessage", { roomId: game1, message: { content: "hola" } });

    // Game 1 won: the next game's room, not entered yet; no result yet
    const next = await winGame(a, game1);
    expect(next).toEqual({ leaderId: "brock", mode: "normal", game: 2, score: score(1, 0), roomId: expect.stringMatching(/^gym-/), status: "next" });
    const game2 = next.roomId as string;
    expect(game2).not.toBe(game1);
    expect(a.results).toEqual([]);
    expect(gymService.tables()[0]).toMatchObject({ inBattle: true, series: { game: 2, score: score(1, 0) } });
    expect(await emitAck(a.socket, "getGymTables", {})).toMatchObject({ mySeries: { roomId: game2, status: "next", game: 2 } });
    expect(state(game2).stadium?.card.name).toBe("Pewter City Gym");

    // Entering it: playing; winning it wins the series
    const playing = seriesAfter(a, async () => {
      const start2 = nextEvent<any>(a.socket, "gameStart", 5000);
      a.socket.emit("joinRoom", { roomId: game2 });
      expect((await start2).gym).toMatchObject({ game: 2, score: score(1, 0) });
    });
    expect(await playing).toMatchObject({ roomId: game2, status: "playing", game: 2 });
    const result = nextEvent<any>(a.socket, "gymBattleResult", 8000);
    const finished = await winGame(a, game2);
    expect(finished).toEqual({ leaderId: "brock", mode: "normal", game: 2, score: score(2, 0), roomId: game2, status: "finished" });
    expect(await result).toEqual({ leaderId: "brock", mode: "normal", victory: true, medalId: "boulder", medalGranted: true, rewards: NORMAL_REWARDS, score: score(2, 0) });
    expect(a.results).toHaveLength(1);
    // Written before the result went out
    expect(await prisma.userMedal.count({ where: { userId: a.user.id, medalId: "boulder" } })).toBe(1);
    expect(await prisma.userCoin.count({ where: { userId: a.user.id, coinId: "golem" } })).toBe(1);
    expect(await prisma.userCardBack.count({ where: { userId: a.user.id, cardBackId: "cardback-brock" } })).toBe(1);
    expect(await coinsOf(a.user.id)).toBe(2400);
    expect(chatted).toBe(false);
    expect(await prisma.match.count({ where: { OR: [{ player1Id: a.user.id }, { player2Id: a.user.id }] } })).toBe(0);
    expect(gymService.tables().find((t) => t.mode === "normal")).toMatchObject({ inBattle: false, challenger: null, series: null });
    expect(await emitAck(a.socket, "getGymTables", {})).toMatchObject({ mySeries: null });

    // B: lost, won, lost — game 3, a lost series (no rewards, no refund)
    const b1 = await challenged(b);
    const afterB1 = await loseGame(b, b1);
    expect(afterB1).toMatchObject({ game: 2, score: score(0, 1), status: "next" });
    const afterB2 = await winGame(b, afterB1.roomId);
    expect(afterB2).toMatchObject({ game: 3, score: score(1, 1), status: "next" });
    const lost = nextEvent<any>(b.socket, "gymBattleResult", 8000);
    const afterB3 = await loseGame(b, afterB2.roomId);
    expect(afterB3).toMatchObject({ game: 3, score: score(1, 2), status: "finished" });
    expect(await lost).toEqual({ leaderId: "brock", mode: "normal", victory: false, medalId: "boulder", medalGranted: false, rewards: null, score: score(1, 2) });
    expect(await coinsOf(b.user.id)).toBe(900);

    // A beats Brock again: nothing more (the entry cost is paid again)
    const again = await challenged(a);
    const againNext = await winGame(a, again);
    const againResult = nextEvent<any>(a.socket, "gymBattleResult", 8000);
    await winGame(a, againNext.roomId);
    expect(await againResult).toMatchObject({ victory: true, medalGranted: false, rewards: null, score: score(2, 0) });
    expect(await coinsOf(a.user.id)).toBe(2300);
  });

  it("two challenges at once: the first one wins (and pays), the others get the in-battle error", async () => {
    gymService.open("brock", "normal");
    const [a, b, c] = await Promise.all([challenger(), challenger(), challenger()]);
    const results = await Promise.all([challenge(a), challenge(b), challenge(c)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "Brock está en batalla: esperá a que termine" },
      { ok: false, error: "Brock está en batalla: esperá a que termine" },
    ]);
    const balances = await Promise.all([a, b, c].map((x) => coinsOf(x.user.id)));
    expect(balances.sort()).toEqual([1000, 1000, 900]);
  });

  it("normal and expert at once: two tables, two series; the expert victory gives its own rewards", async () => {
    gymService.open("brock", "normal");
    gymService.open("brock", "expert");
    const a = await challenger();
    const b = await challenger();
    const expert1 = await challenged(a, "expert");
    const normal1 = await challenged(b, "normal");
    expect(gymService.tables().map((t) => [t.mode, t.inBattle, t.challenger?.username])).toEqual([
      ["normal", true, b.user.username],
      ["expert", true, a.user.username],
    ]);
    const next = await winGame(a, expert1);
    expect(roomManager.getRoom(next.roomId)?.gym).toMatchObject({ mode: "expert", userId: a.user.id });
    expect(roomManager.getRoom(normal1)?.gym).toMatchObject({ mode: "normal", userId: b.user.id });
    const result = nextEvent<any>(a.socket, "gymBattleResult", 8000);
    await winGame(a, next.roomId);
    expect(await result).toEqual({ leaderId: "brock", mode: "expert", victory: true, medalId: "boulder", medalGranted: false, rewards: EXPERT_REWARDS, score: score(2, 0) });
    expect(await prisma.userCardBack.count({ where: { userId: a.user.id, cardBackId: "cardback-brock-expert" } })).toBe(1);
    expect(await prisma.userMedal.count({ where: { userId: a.user.id } })).toBe(0);
    expect(await coinsOf(a.user.id)).toBe(900 + 3000);
    expect(gymService.tables().find((t) => t.mode === "expert")).toMatchObject({ inBattle: false });
    expect(gymService.tables().find((t) => t.mode === "normal")).toMatchObject({ inBattle: true });
  });

  it("the expert table refuses a deck within the normal copy limit but not the expert one", async () => {
    gymService.open("brock", "expert");
    const twoBills = await challenger(swapCards(["base-set-075-lass"], [{ cardDefId: "base-set-091-bill", quantity: 1 }]));
    expect(await challenge(twoBills, "expert")).toEqual({ ok: false, error: "Tu mazo no puede tener más de 1 copia de Bill (tiene 2)" });
    gymService.open("brock", "normal");
    expect(await challenge(twoBills, "normal")).toMatchObject({ ok: true });
  });

  it("nobody else can join or watch a gym battle (any path), and it is never listed", async () => {
    gymService.open("brock", "normal");
    const a = await challenger();
    const b = await challenger();
    const roomId = await challenged(a);
    // Before the challenger entered, and after
    for (const entered of [false, true]) {
      if (entered) await enter(a, roomId);
      const notFound = nextEvent<any>(b.socket, "error");
      b.socket.emit("joinRoom", { roomId });
      expect(await notFound).toMatchObject({ code: "ROOM_NOT_FOUND" });
      const notFoundWithDeck = nextEvent<any>(b.socket, "error");
      b.socket.emit("joinRoom", { roomId, deckId: b.deckId });
      expect(await notFoundWithDeck).toMatchObject({ code: "ROOM_NOT_FOUND" });
      const privateError = nextEvent<any>(b.socket, "error");
      b.socket.emit("spectateRoom", { roomId });
      expect(await privateError).toMatchObject({ code: "PRIVATE_TABLE" });
      const list = nextEvent<{ rooms: { id: string }[] }>(b.socket, "roomList");
      b.socket.emit("getRooms");
      expect((await list).rooms.map((r) => r.id)).not.toContain(roomId);
    }
    const room = roomManager.getRoom(roomId)!;
    expect(room.spectators.size).toBe(0);
    expect(room.player2Id).toBeFalsy();
    // Nor as a spectator through the manager directly (whatever the table's config says)
    room.config.friendly = false;
    room.config.reservedUserId = undefined;
    expect(() => roomManager.addSpectator(roomId, "socket-x", b.user.id)).toThrow();
  });

  it("a challenger who never enters forfeits the series after the disconnect grace (no refund); the table is free", async () => {
    gymRooms.setTiming({ disconnectGraceMs: 300 });
    gymService.open("brock", "normal");
    const a = await challenger();
    const result = nextEvent<any>(a.socket, "gymBattleResult", 5000);
    const roomId = await challenged(a);
    expect(await result).toMatchObject({ victory: false, rewards: null, score: score(0, 0) });
    expect(a.series.at(-1)).toMatchObject({ status: "finished", roomId });
    expect(state(roomId)).toMatchObject({ gamePhase: "GAME_OVER", gameResult: "defeat" });
    expect(gymService.tables()[0]).toMatchObject({ inBattle: false });
    expect(gymService.mySeries(a.user.id)).toBeNull();
    expect(await coinsOf(a.user.id)).toBe(900);
  });

  it("not entering the next game forfeits the series, whatever the score", async () => {
    gymService.open("brock", "normal");
    const a = await challenger();
    const game1 = await challenged(a);
    gymRooms.setTiming({ disconnectGraceMs: 300 });
    const result = nextEvent<any>(a.socket, "gymBattleResult", 8000);
    const next = await winGame(a, game1);
    expect(next).toMatchObject({ status: "next", score: score(1, 0) });
    expect(await result).toMatchObject({ victory: false, rewards: null, score: score(1, 0) });
    expect(state(next.roomId).events.at(-1)?.message).toBe("Jugador 1 abandonó la batalla");
  });

  it("the challenger's clock running out loses that game (the series goes on), twice loses the series", async () => {
    gymRooms.setTiming({ turnClockMs: 400 });
    gymService.open("brock", "normal");
    const a = await challenger();
    const over = nextEvent<any>(a.socket, "gameOver", 5000);
    const game1 = await challenged(a);
    await enter(a, game1);
    expect(await over).toEqual({ winner: "player2", reason: "Se acabó tu tiempo" });
    expect(state(game1)).toMatchObject({ gamePhase: "GAME_OVER", gameResult: "defeat" });
    await waitFor(() => a.series.some((s) => s.status === "next"));
    expect(a.series.find((s) => s.status === "next")).toMatchObject({ game: 2, score: score(0, 1) });
    // Game 2 times out too (its clock runs from its creation)
    await waitFor(() => a.results.length === 1, 5000);
    expect(a.results[0]).toMatchObject({ victory: false, medalGranted: false, rewards: null, score: score(0, 2) });
    expect(gymService.mySeries(a.user.id)).toBeNull();
  });

  it("Brock's own emotes, on his side: when the series starts (game 1 only), when he takes a Prize, when he wins the series", async () => {
    gymRooms.setTiming({ emoteDelayMs: 0 });
    gymService.open("brock", "normal");
    const a = await challenger();
    const emotes: any[] = [];
    a.socket.on("emote", (e: unknown) => emotes.push(e));
    const game1 = await challenged(a);
    await enter(a, game1);
    await setUp(a.socket, game1);
    await waitFor(() => emotes.length === 1);
    expect(emotes[0]).toMatchObject({ roomId: game1, side: "player2", userId: "gym:brock", emoteId: "brock-smug" });

    // A Knock Out by Brock = one Prize of his fewer, seen after the next action
    for (let i = 0; i < 10 && !state(game1).isPlayerTurn; i++) await gymRooms.aiIdle(game1);
    const room = roomManager.getRoom(game1)!;
    if (state(game1).playerNeedsToPromote) await act(a.socket, game1, "promote", { benchIndex: 0 });
    expect(state(game1).opponentPrizes.length).toBeGreaterThan(0);
    room.gameState = { ...room.gameState!, opponentPrizes: room.gameState!.opponentPrizes.slice(1) } as GameState;
    gymRooms.setTiming({ turnClockMs: 400 });
    const next = nextEvent<any>(a.socket, "gymSeries", 5000);
    await act(a.socket, game1, "endTurn");
    await waitFor(() => emotes.some((e) => e.emoteId === "brock-excited"));

    // Game 1 lost on time: no victory emote yet; game 2 (entered, set up) starts without the start emote
    const update = await next;
    expect(update).toMatchObject({ status: "next", score: score(0, 1) });
    const result = nextEvent<any>(a.socket, "gymBattleResult", 5000);
    await enter(a, update.roomId);
    await result;
    await waitFor(() => emotes.some((e) => e.emoteId === "brock-beach"));
    expect(emotes.filter((e) => e.emoteId === "brock-smug")).toHaveLength(1);
    expect(emotes.filter((e) => e.emoteId === "brock-beach")).toEqual([expect.objectContaining({ roomId: update.roomId })]);
    expect(emotes.every((e) => e.side === "player2" && e.userId === "gym:brock")).toBe(true);
  });

  it("disconnecting: back within the grace the game goes on (joinRoom restores it); away too long, the series is lost", async () => {
    gymRooms.setTiming({ disconnectGraceMs: 600 });
    gymService.open("brock", "normal");
    const a = await challenger();
    const roomId = await challenged(a);
    await enter(a, roomId);
    a.socket.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const tab = await server.connect(tokenFor(a.user));
    const results: any[] = [];
    tab.on("gymBattleResult", (p: unknown) => results.push(p));
    // The lobby tells the new tab where its game is
    expect(await emitAck(tab, "getGymTables", {})).toMatchObject({ mySeries: { roomId, status: "playing" } });
    const back = await enter(a, roomId, tab);
    expect(back).toMatchObject({ roomId, gym: { leaderId: "brock", game: 1 }, opponentInfo: { username: "Brock" } });
    await new Promise((r) => setTimeout(r, 700));
    expect(results).toEqual([]);
    expect(state(roomId).gamePhase).not.toBe("GAME_OVER");

    tab.disconnect();
    await waitFor(() => roomManager.getRoom(roomId)?.gameState?.gamePhase === "GAME_OVER", 3000);
    expect(state(roomId).gameResult).toBe("defeat");
    expect(state(roomId).events.at(-1)?.message).toBe("Jugador 1 abandonó la batalla");
    await waitFor(() => gymService.mySeries(a.user.id) === null);
  });

  it("Brock answers a step of the challenger's Trainer (Erika: he draws), the turn goes on", async () => {
    gymService.open("brock", "normal");
    const a = await challenger();
    const roomId = await challenged(a);
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

  it("2 challenges a day against Brock (normal and expert together), refused before coins and deck; gymAttempts on each", async () => {
    gymRooms.setTiming({ disconnectGraceMs: 200 });
    gymService.open("brock", "normal");
    gymService.open("brock", "expert");
    const a = await challenger();
    // Two series (never entered: lost after the grace) use both attempts
    for (const mode of ["normal", "expert"] as const) {
      const done = nextEvent<any>(a.socket, "gymBattleResult", 5000);
      await challenged(a, mode);
      await done;
      await waitFor(() => gymService.mySeries(a.user.id) === null);
    }
    await waitFor(() => a.attempts.length === 2);
    expect(a.attempts.map((x) => x.brock.used)).toEqual([1, 2]);
    expect(a.attempts[1]).toEqual({ brock: { used: 2, perDay: 2, resetsAt: expect.any(Number) } });
    expect(a.attempts[1].brock.resetsAt).toBeGreaterThan(Date.now());
    expect(await coinsOf(a.user.id)).toBe(800);

    expect(await challenge(a)).toEqual({ ok: false, error: "Ya usaste tus 2 intentos de hoy contra Brock. Vuelve mañana." });
    // Checked before the deck and the coins: a rule-breaking deck / no coins get the same answer
    expect(await challenge(a, "expert", "brushfire")).toEqual({ ok: false, error: "Ya usaste tus 2 intentos de hoy contra Brock. Vuelve mañana." });
    await prisma.user.update({ where: { id: a.user.id }, data: { coins: 0 } });
    expect(await challenge(a)).toEqual({ ok: false, error: "Ya usaste tus 2 intentos de hoy contra Brock. Vuelve mañana." });
    expect(await emitAck(a.socket, "getGymTables", {})).toMatchObject({ myAttempts: { brock: { used: 2, perDay: 2 } } });
    expect(await prisma.gymAttempt.count({ where: { userId: a.user.id } })).toBe(2);
    expect(gymService.tables().every((t) => !t.inBattle)).toBe(true);
  });

  it("a game closed from the backoffice ends the series without a result: the entry cost back, the table free", async () => {
    gymService.open("brock", "normal");
    const a = await challenger();
    const b = await challenger();
    const roomId = await challenged(a);
    await enter(a, roomId);
    expect(await coinsOf(a.user.id)).toBe(900);
    const closed = nextEvent<any>(a.socket, "gameClosed");
    const finished = nextEvent<any>(a.socket, "gymSeries");
    expect(closeRoomByAdmin(server.io, roomId)).toBe(true);
    expect(await closed).toMatchObject({ roomId });
    expect(await finished).toMatchObject({ status: "finished", roomId });
    await waitFor(() => gymService.mySeries(a.user.id) === null && !gymService.tables()[0].inBattle);
    expect(a.results).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await coinsOf(a.user.id)).toBe(1000);
    expect(await prisma.transaction.findFirst({ where: { userId: a.user.id, type: "gym_entry_refund" } })).toMatchObject({ amount: 100 });
    // …and the daily attempt back
    await waitFor(() => a.attempts.length === 2);
    expect(a.attempts.map((x) => x.brock.used)).toEqual([1, 0]);
    expect(await prisma.gymAttempt.findFirst({ where: { userId: a.user.id } })).toMatchObject({ refunded: true });
    expect(await challenge(b)).toMatchObject({ ok: true });
  });

  it("the games play the leader's saved deck (backoffice) when there is one", async () => {
    const saved = [
      { cardId: "gym-heroes-069-brocks-onix", qty: 30 },
      { cardId: "base-set-097-fighting-energy", qty: 30 },
    ];
    await prisma.gymLeaderDeck.create({ data: { leaderId: "brock", mode: "normal", cards: saved } });
    try {
      gymService.open("brock", "normal");
      const a = await challenger();
      const roomId = await challenged(a);
      const s = state(roomId);
      const leaderCards = [...s.opponentDeck, ...s.opponentHand, ...s.opponentPrizes, ...(s.opponentActive ? [s.opponentActive.pokemon] : []), ...s.opponentBench.map((p) => p.pokemon)];
      expect(new Set(leaderCards.map((c) => c.name))).toEqual(new Set([findCardById("gym-heroes-069-brocks-onix")!.name, findCardById("base-set-097-fighting-energy")!.name]));
    } finally {
      await prisma.gymLeaderDeck.deleteMany({});
    }
  });
});
