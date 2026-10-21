/**
 * Spectator mode over real sockets (production handlers).
 *
 * Tables: any signed-in user watches a game in progress (spectateRoom): the neutral masked
 * state, the room chat (history + live, their messages labelled isSpectator), the spectator
 * count for everyone (spectatorUpdate, roomList), and every player-only event refused.
 *
 * Drafts: any signed-in user watches a started draft (draft:spectate): the table without a card
 * of anyone's pack or pool while picking, the pools after it, the decks once the tournament
 * started, the draft chat, the "En curso" list (draft:liveRooms), and every draft action refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { ALL_CARDS, type GameCard } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { draftRoomManager } from "../src/socket/draft-handlers.js";
import { maskGameStateForPlayer } from "../src/socket/state-masking.js";
import { chatFloodEntryCount, pruneChatTimestamps } from "../src/socket/room-chat.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  server = await startSocketServer();
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

const SPECTATOR_ONLY = "Los espectadores solo pueden mirar y chatear";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isHidden = (cards: unknown) =>
  Array.isArray(cards) && cards.every((c: Record<string, unknown>) => c.hidden === true && !("name" in c));
const card = (name: string, id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === name && c.set === "Base Set")!), id });

/** The first payload of `event` that matches `predicate`. */
function waitFor<T = any>(socket: ClientSocket, event: string, predicate: (payload: T) => boolean, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for a matching "${event}"`));
    }, ms);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** True when `event` arrives within `ms` (to check something did NOT happen). */
function arrives(socket: ClientSocket, event: string, ms = 400): Promise<boolean> {
  return nextEvent(socket, event, ms).then(
    () => true,
    () => false,
  );
}

/** A public table in progress (`friendly` / `reserve`: a private one): two players with theme decks. */
async function startTable(options: { friendly?: boolean; reserve?: boolean } = {}) {
  const [p1, p2] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  s1.emit("createRoom", {
    deckId: "brushfire",
    prizeCount: 6,
    betAmount: 0,
    friendly: options.friendly ?? false,
    ...(options.reserve ? { reservedUserId: p2.id } : {}),
  });
  const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
  const started1 = nextEvent(s1, "gameStart");
  const started2 = nextEvent(s2, "gameStart");
  s2.emit("joinRoom", { roomId, deckId: "overgrowth" });
  await Promise.all([started1, started2]);
  return { roomId, p1, p2, s1, s2 };
}

/** A spectator watching `roomId`: its gameStart and chatHistory. */
async function spectate(socket: ClientSocket, roomId: string) {
  const start = nextEvent<any>(socket, "gameStart");
  const history = nextEvent<any>(socket, "chatHistory");
  socket.emit("spectateRoom", { roomId });
  return { start: await start, history: await history };
}

describe("watching a table", () => {
  it("gets the neutral masked state, both players' names, the chat history and the count", async () => {
    const t = await startTable();
    const said = nextEvent<any>(t.s2, "chatMessage");
    t.s1.emit("chatMessage", { roomId: t.roomId, message: { content: "suerte" } });
    expect((await said).isSpectator).toBe(false);

    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    const p1Hears = nextEvent<any>(t.s1, "spectatorUpdate");
    const lobbyHears = waitFor<any>(t.s2, "roomList", (d) => d.rooms.some((r: any) => r.id === t.roomId && r.spectatorCount === 1));
    const { start, history } = await spectate(sv, t.roomId);

    expect(start).toMatchObject({ roomId: t.roomId, isSpectator: true, isPlayer1: true, spectatorCount: 1, draftRoomId: null });
    expect((await lobbyHears).rooms.find((r: any) => r.id === t.roomId).watchable).toBe(true);
    expect(start.creatorInfo.username).toBe(t.p1.username);
    expect(start.opponentInfo.username).toBe(t.p2.username);
    const state = start.gameState;
    for (const zone of ["playerHand", "playerDeck", "playerPrizes", "opponentHand", "opponentDeck", "opponentPrizes"]) {
      expect(isHidden(state[zone]), zone).toBe(true);
    }
    expect(state.playerHand.length).toBe(roomManager.getRoom(t.roomId)!.gameState!.playerHand.length);
    expect(history.messages.map((m: any) => [m.content, m.isSpectator])).toEqual([["suerte", false]]);
    expect(await p1Hears).toEqual({ roomId: t.roomId, count: 1 });
    await lobbyHears;

    // A second tab of the same user is still one person watching
    const sv2 = await server.connect(tokenFor(viewer));
    const again = nextEvent<any>(t.s1, "spectatorUpdate");
    await spectate(sv2, t.roomId);
    expect((await again).count).toBe(1);

    // Later states reach the spectator masked too
    const update = nextEvent<any>(sv, "gameState");
    const over = nextEvent<any>(sv, "gameOver");
    t.s2.emit("action", { roomId: t.roomId, action: { type: "surrender" } });
    const after = await update;
    expect(isHidden(after.gameState.playerHand) && isHidden(after.gameState.opponentHand)).toBe(true);
    expect((await over).winner).toBe("player1");
  });

  it("can't play, ready, kick or flip: every player-only event is refused and the game goes on", async () => {
    const t = await startTable();
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    await spectate(sv, t.roomId);
    const room = roomManager.getRoom(t.roomId)!;
    const before = JSON.stringify(room.gameState);

    for (const action of [{ type: "surrender" }, { type: "endTurn" }, { type: "mulligan" }, { type: "playerReady" }, { type: "promote", payload: { benchIndex: 0 } }]) {
      const refused = nextEvent<any>(sv, "actionResult");
      sv.emit("action", { roomId: t.roomId, action });
      expect(await refused).toEqual({ success: false, error: SPECTATOR_ONLY });
    }
    for (const event of ["ready", "requestKick"]) {
      const refused = nextEvent<any>(sv, "error");
      sv.emit(event, { roomId: t.roomId });
      expect((await refused).message).toBe(SPECTATOR_ONLY);
    }
    const coins = await sv.timeout(2000).emitWithAck("requestCoinFlip", { roomId: t.roomId, purpose: "stadium" });
    expect(coins).toEqual({ success: false, error: SPECTATOR_ONLY });
    // Not a seat: joining it is refused too
    const joinRefused = nextEvent<any>(sv, "error");
    sv.emit("joinRoom", { roomId: t.roomId, deckId: "brushfire" });
    expect((await joinRefused).message).toBe("La mesa está llena");

    expect(room.status).toBe("playing");
    expect(JSON.stringify(room.gameState)).toBe(before);

    // Leaving only stops watching: no forfeit, the count goes down
    const down = waitFor<any>(t.s1, "spectatorUpdate", (u) => u.count === 0);
    sv.emit("leaveRoom", { roomId: t.roomId });
    expect(await down).toEqual({ roomId: t.roomId, count: 0 });
    expect(room.status).toBe("playing");
    expect(await arrives(t.s1, "gameOver")).toBe(false);
  });

  it("chats with the players both ways, labelled as a spectator; outsiders can't write in", async () => {
    const t = await startTable();
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    await spectate(sv, t.roomId);

    const p1Reads = nextEvent<any>(t.s1, "chatMessage");
    const p2Reads = nextEvent<any>(t.s2, "chatMessage");
    sv.emit("chatMessage", { roomId: t.roomId, message: { content: "¡buena jugada!" } });
    for (const msg of [await p1Reads, await p2Reads]) {
      expect(msg).toMatchObject({ roomId: t.roomId, userId: viewer.id, username: viewer.username, content: "¡buena jugada!", isSpectator: true });
    }

    const viewerReads = waitFor<any>(sv, "chatMessage", (m) => m.content === "gracias");
    t.s2.emit("chatMessage", { roomId: t.roomId, message: { content: "gracias" } });
    expect(await viewerReads).toMatchObject({ userId: t.p2.id, content: "gracias", isSpectator: false });

    // Someone not in the room can't write into it
    const outsider = await server.connect(tokenFor(await createUser()));
    const leaked = arrives(t.s1, "chatMessage");
    outsider.emit("chatMessage", { roomId: t.roomId, message: { content: "spam" } });
    expect(await leaked).toBe(false);
    expect(roomManager.getRoom(t.roomId)!.chat.map((m) => m.content)).toEqual(["¡buena jugada!", "gracias"]);
  });

  it("players can't watch their own table, signed-out sockets can't watch, a missing table is not found", async () => {
    const t = await startTable();
    const p1OtherTab = await server.connect(tokenFor(t.p1));
    const seated = nextEvent<any>(p1OtherTab, "error");
    p1OtherTab.emit("spectateRoom", { roomId: t.roomId });
    expect((await seated).code).toBe("SEATED_IN_ROOM");

    const anonymous = await server.connect();
    const refused = nextEvent<any>(anonymous, "error");
    anonymous.emit("spectateRoom", { roomId: t.roomId });
    expect((await refused).message).toBe("Autenticación requerida");

    const viewer = await server.connect(tokenFor(await createUser()));
    const missing = nextEvent<any>(viewer, "error");
    viewer.emit("spectateRoom", { roomId: "NOPE00" });
    expect((await missing).code).toBe("ROOM_NOT_FOUND");
    expect(roomManager.spectatorCount(roomManager.getRoom(t.roomId)!)).toBe(0);
  });

  it("friendly and reserved (invite) tables can't be watched and aren't watchable in the list", async () => {
    for (const options of [{ friendly: true }, { reserve: true }]) {
      const t = await startTable(options);
      const sv = await server.connect(tokenFor(await createUser()));
      const refused = nextEvent<any>(sv, "error");
      sv.emit("spectateRoom", { roomId: t.roomId });
      expect(await refused).toEqual({ code: "PRIVATE_TABLE", message: "Esta mesa es privada: no se puede mirar" });
      expect(roomManager.spectatorCount(roomManager.getRoom(t.roomId)!)).toBe(0);
      const list = nextEvent<any>(sv, "roomList");
      sv.emit("getRooms");
      expect((await list).rooms.find((r: any) => r.id === t.roomId).watchable).toBe(false);
    }
  });

  it("watching is throttled per socket and the lobby list follows spectators at most once a second", async () => {
    const t = await startTable();
    const sv = await server.connect(tokenFor(await createUser()));
    const lobby = await server.connect(tokenFor(await createUser()));
    let lists = 0;
    lobby.on("roomList", () => lists++);
    for (let i = 0; i < 5; i++) {
      await spectate(sv, t.roomId);
      sv.emit("stopSpectating", { roomId: t.roomId });
    }
    const refused = nextEvent<any>(sv, "error");
    sv.emit("spectateRoom", { roomId: t.roomId });
    expect((await refused).code).toBe("SPECTATE_RATE_LIMITED");
    await sleep(1300);
    expect(lists).toBeGreaterThan(0);
    expect(lists).toBeLessThanOrEqual(2);
    expect(roomManager.spectatorCount(roomManager.getRoom(t.roomId)!)).toBe(0);
  });

  it("the chat flood control forgets users who stopped writing", () => {
    pruneChatTimestamps(Date.now() + 60_000);
    expect(chatFloodEntryCount()).toBe(0);
  });

  it("a spectator who disconnects is no longer counted", async () => {
    const t = await startTable();
    const sv = await server.connect(tokenFor(await createUser()));
    await spectate(sv, t.roomId);
    const down = waitFor<any>(t.s2, "spectatorUpdate", (u) => u.count === 0);
    sv.disconnect();
    expect(await down).toEqual({ roomId: t.roomId, count: 0 });
  });
});

describe("spectator masking", () => {
  it("hides hands, decks, prizes, set-aside hands, duel picks and every pending choice's private part", () => {
    const c = (id: string) => ({ id, name: `Card ${id}` });
    const state = {
      playerHand: [c("h1")], playerDeck: [c("d1")], playerPrizes: [c("p1")], playerDiscard: [c("x1")],
      opponentHand: [c("h2")], opponentDeck: [c("d2")], opponentPrizes: [c("p2")], opponentDiscard: [c("x2")],
      isPlayerTurn: true,
      events: [],
      setAsideHands: [{ side: "player", cards: [c("s1"), c("s2")], returnsAfterTurn: 5 }],
      pendingDuel: { playerPick: "rock", opponentPick: "paper", round: 1 },
      pendingPeek: { peekType: "playerDeck", revealedCards: [c("d1")] },
      pendingDeckSearch: { filter: { basicOnly: true } },
      pendingAttackChoice: {
        effect: { type: "x" },
        step: { title: "¿Huir?", description: "d", chooser: "opponent", options: [{ id: "o" }], maxSelections: 1, minSelections: 0 },
        context: { secret: true },
        reaction: { answers: "flee", powerName: "Flee", pokemonId: "p", side: "opponent", resume: { coins: ["heads"] } },
      },
      pendingTrainerChoice: { cardId: "t", trainerName: "Challenge!", chooser: "opponent", step: { title: "t", description: "d", options: [{ id: "o" }], maxSelections: 1, minSelections: 1, cards: [c("h2")] } },
      pendingPowerChoice: { pokemonId: "p", powerName: "Summon Minions", step: { title: "t", description: "d", options: [{ id: "o" }], maxSelections: 1, minSelections: 0 } },
    };
    const view = maskGameStateForPlayer(state, "spectator") as any;
    for (const zone of ["playerHand", "playerDeck", "playerPrizes", "opponentHand", "opponentDeck", "opponentPrizes"]) {
      expect(isHidden(view[zone]), zone).toBe(true);
    }
    expect(view.playerDiscard).toEqual([c("x1")]);
    expect(isHidden(view.setAsideHands[0].cards)).toBe(true);
    expect(view.setAsideHands[0].cards).toHaveLength(2);
    expect(view.pendingDuel.playerPick).toBeNull();
    expect(view.pendingDuel.opponentPick).toBeNull();
    expect(view.pendingPeek).toBeUndefined();
    expect(view.pendingDeckSearch).toBeUndefined();
    expect(view.pendingAttackChoice).toEqual({
      effect: { type: "x" },
      step: { title: "¿Huir?", description: "d", chooser: "opponent", options: [], maxSelections: 1, minSelections: 0 },
      waiting: true,
    });
    expect(JSON.stringify(view)).not.toContain("resume");
    expect(view.pendingTrainerChoice.step.options).toEqual([]);
    expect(view.pendingTrainerChoice.step.cards).toBeUndefined();
    expect(view.pendingTrainerChoice.waiting).toBe(true);
    expect(view.pendingPowerChoice.step.options).toEqual([]);
    expect(view.pendingPowerChoice.waiting).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A free draft in its picking phase: admin (not playing) + players A and B. */
async function startDraft() {
  const admin = await createUser({}, { role: "admin", permissions: ["rooms:close"] });
  const adminSocket = await server.connect(tokenFor(admin));
  adminSocket.emit("draft:create", { config: { adminPlays: false, entryFee: 0 } });
  const { roomId } = await nextEvent<{ roomId: string }>(adminSocket, "draft:created");
  const [a, b] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
  const sa = await server.connect(tokenFor(a));
  const sb = await server.connect(tokenFor(b));
  for (const s of [sa, sb]) {
    const joined = nextEvent(s, "draft:state");
    s.emit("draft:join", { roomId });
    await joined;
  }
  const drafting = waitFor<any>(sa, "draft:state", (d) => d.phase === "drafting");
  adminSocket.emit("draft:start", { roomId });
  await drafting;
  return { roomId, admin, adminSocket, a, b, sa, sb };
}

async function closeDraft(d: { roomId: string; adminSocket: ClientSocket }) {
  await d.adminSocket.timeout(2000).emitWithAck("draft:delete", { roomId: d.roomId });
}

async function spectateDraft(socket: ClientSocket, roomId: string) {
  const state = waitFor<any>(socket, "draft:state", (s) => s.isSpectator === true);
  const history = nextEvent<any>(socket, "draft:chatHistory");
  socket.emit("draft:spectate", { roomId });
  return { state: await state, history: await history };
}

describe("watching a draft", () => {
  it("shows the table, who picked and the timer, never a card of anyone's pack or pool while picking", async () => {
    const d = await startDraft();
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    const playersHear = waitFor<any>(d.sa, "draft:state", (s) => s.spectatorCount === 1);
    const listed = waitFor<any[]>(d.sb, "draft:liveRooms", (list) => list.some((r) => r.id === d.roomId && r.spectatorCount === 1));
    const { state, history } = await spectateDraft(sv, d.roomId);

    expect(state).toMatchObject({ phase: "drafting", isSpectator: true, isAdminViewer: false, spectatorCount: 1, bonusPickPool: [] });
    expect(state.pickDeadline).toBeGreaterThan(Date.now());
    expect(state.players.map((p: any) => p.name).sort()).toEqual([d.a.username, d.b.username].sort());
    for (const p of state.players) {
      expect(p).toMatchObject({ isYou: false, currentPack: null, draftedCards: null, deck: null });
      expect(p.currentPackSize).toBeGreaterThan(0);
    }
    expect(history).toEqual({ roomId: d.roomId, messages: [] });
    expect((await playersHear).isSpectator).toBe(false);
    const live = (await listed).find((r) => r.id === d.roomId)!;
    expect(live).toMatchObject({ phase: "drafting", spectatorCount: 1, currentRound: 1 });
    expect(live.players.map((p: any) => p.name).sort()).toEqual([d.a.username, d.b.username].sort());

    // A picks: the spectator sees that A picked (and how many cards A has), not what
    const aState = draftRoomManager.getMaskedState(d.roomId, d.sa.id)!;
    const pickedId = aState.players.find((p) => p.isYou)!.currentPack![0].id;
    const seen = waitFor<any>(sv, "draft:state", (s) => s.players.some((p: any) => p.id === d.a.id && p.isReady));
    d.sa.emit("draft:pick", { roomId: d.roomId, cardId: pickedId });
    const afterPick = (await seen).players.find((p: any) => p.id === d.a.id);
    expect(afterPick).toMatchObject({ isReady: true, draftedCardsCount: 1, draftedCards: null, currentPack: null });
    expect(JSON.stringify(await Promise.resolve(draftRoomManager.getMaskedState(d.roomId, sv.id)))).not.toContain(pickedId);

    // draft:getLiveRooms answers the same list on request
    const asked = nextEvent<any[]>(sv, "draft:liveRooms");
    sv.emit("draft:getLiveRooms");
    expect((await asked).some((r) => r.id === d.roomId)).toBe(true);
    await closeDraft(d);
  });

  it("can't pick, bonus-pick, build, edit, start, withdraw or forfeit", async () => {
    const d = await startDraft();
    const sv = await server.connect(tokenFor(await createUser()));
    await spectateDraft(sv, d.roomId);
    const packCard = draftRoomManager.getRoom(d.roomId)!.players[0].currentPack[0].id;
    const attempts: [string, Record<string, unknown>][] = [
      ["draft:pick", { roomId: d.roomId, cardId: packCard }],
      ["draft:bonusPick", { roomId: d.roomId, cardDefIds: ["a", "b", "c"] }],
      ["draft:submitDeck", { roomId: d.roomId, deckCardIds: [], energyCards: [] }],
      ["draft:editDeck", { roomId: d.roomId }],
      ["draft:start", { roomId: d.roomId }],
      ["draft:withdraw", { roomId: d.roomId }],
      ["draft:forfeit", { draftRoomId: d.roomId, gameRoomId: "GAME01" }],
    ];
    for (const [event, payload] of attempts) {
      const refused = nextEvent<any>(sv, "draft:error");
      sv.emit(event, payload);
      expect((await refused).message, event).toBe(SPECTATOR_ONLY);
    }
    const room = draftRoomManager.getRoom(d.roomId)!;
    expect(room.players.every((p) => p.draftedCards.length === 0)).toBe(true);
    expect(room.players[0].currentPack.some((c) => c.id === packCard)).toBe(true);

    // Leaving only stops watching
    const down = waitFor<any>(d.sa, "draft:state", (s) => s.spectatorCount === 0);
    sv.emit("draft:leave", { roomId: d.roomId });
    await down;
    expect(draftRoomManager.getRoom(d.roomId)!.players).toHaveLength(2);
    await closeDraft(d);
  });

  it("players and the admin join instead of watching; a draft still in its lobby can't be watched", async () => {
    const d = await startDraft();
    for (const s of [d.sa, d.adminSocket]) {
      const refused = nextEvent<any>(s, "draft:error");
      s.emit("draft:spectate", { roomId: d.roomId });
      expect((await refused).code).toBe("DRAFT_MEMBER");
    }
    await closeDraft(d);

    const admin = await createUser({}, { role: "admin", permissions: ["rooms:close"] });
    const adminSocket = await server.connect(tokenFor(admin));
    adminSocket.emit("draft:create", { config: { adminPlays: false, entryFee: 0 } });
    const { roomId } = await nextEvent<{ roomId: string }>(adminSocket, "draft:created");
    const sv = await server.connect(tokenFor(await createUser()));
    const refused = nextEvent<any>(sv, "draft:error");
    sv.emit("draft:spectate", { roomId });
    expect((await refused).message).toMatch(/todavía no empezó/);
    await closeDraft({ roomId, adminSocket });
  });

  it("chats in the draft's chat labelled as a spectator; outsiders can't write in", async () => {
    const d = await startDraft();
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    await spectateDraft(sv, d.roomId);

    const aReads = nextEvent<any>(d.sa, "draft:chatMessage");
    sv.emit("draft:chat", { roomId: d.roomId, content: "¡vamos!" });
    expect(await aReads).toMatchObject({ roomId: d.roomId, userId: viewer.id, username: viewer.username, content: "¡vamos!", isSpectator: true });

    const viewerReads = waitFor<any>(sv, "draft:chatMessage", (m) => m.content === "hola");
    d.sb.emit("draft:chat", { roomId: d.roomId, content: "hola" });
    expect(await viewerReads).toMatchObject({ userId: d.b.id, content: "hola", isSpectator: false });

    const outsider = await server.connect(tokenFor(await createUser()));
    const leaked = arrives(d.sa, "draft:chatMessage");
    outsider.emit("draft:chat", { roomId: d.roomId, content: "spam" });
    expect(await leaked).toBe(false);

    // Whoever comes in later reads the history
    const late = await server.connect(tokenFor(await createUser()));
    const { history } = await spectateDraft(late, d.roomId);
    expect(history.messages.map((m: any) => [m.content, m.isSpectator])).toEqual([["¡vamos!", true], ["hola", false]]);
    await closeDraft(d);
  });

  it("shows no pool or deck while building or during the tournament, every one once it finished; lists its games", async () => {
    const d = await startDraft();
    const sv = await server.connect(tokenFor(await createUser()));
    await spectateDraft(sv, d.roomId);
    const room = draftRoomManager.getRoom(d.roomId)!;
    if (room.pickTimer) clearTimeout(room.pickTimer);
    room.players[0].draftedCards = [card("Pikachu", "pool-a1")];
    room.players[1].draftedCards = [card("Charmander", "pool-b1")];

    room.phase = "bonus-pick";
    room.bonusPickPool = [card("Bill", "bonus-1")];
    let view = draftRoomManager.getMaskedState(d.roomId, sv.id)!;
    expect(view.players.every((p) => p.draftedCards === null)).toBe(true);
    expect(view.bonusPickPool).toEqual([]);

    room.phase = "building";
    room.players[0].deck = [card("Pikachu", "deck-a1")];
    view = draftRoomManager.getMaskedState(d.roomId, sv.id)!;
    expect(view.players.every((p) => p.draftedCards === null && p.deck === null)).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/pool-a1|pool-b1|deck-a1/);
    // A player still sees only their own pool
    const aView = draftRoomManager.getMaskedState(d.roomId, d.sa.id)!;
    expect(aView.players.find((p) => !p.isYou)!.draftedCards).toBeNull();

    room.phase = "matching";
    room.tournament = {
      rounds: [{ roundNumber: 1, pairings: [{ matchNumber: 1, player1: { id: d.a.id, name: "A" }, player2: { id: d.b.id, name: "B" }, games: [], wins: { [d.a.id]: 0, [d.b.id]: 0 } }], byePlayerId: null, status: "in_progress", results: [] }],
      standings: [],
      currentRoundNumber: 1,
      totalRounds: 1,
    };
    // A game of the tournament in progress: listed, and watchable like any table
    const game = roomManager.createRoom(undefined, undefined, { username: d.a.username });
    game.isDraft = true;
    await roomManager.joinRoom(game.id, d.a.id, "");
    await roomManager.joinRoom(game.id, d.b.id, "", { username: d.b.username });
    const deck = Array.from({ length: 60 }, (_, i) => card(i % 3 === 0 ? "Pikachu" : "Lightning Energy", `g${i}`));
    await roomManager.startGameWithRawDecks(game.id, deck, deck.map((x) => ({ ...x, id: `${x.id}b` })));
    draftRoomManager.registerGameRoom(game.id, d.roomId, 1, 1, d.a.id, d.b.id);

    view = draftRoomManager.getMaskedState(d.roomId, sv.id)!;
    expect(view.players.every((p) => p.draftedCards === null && p.deck === null)).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/pool-a1|pool-b1|deck-a1/);
    expect(view.liveGames).toEqual([
      { gameRoomId: game.id, roundNumber: 1, matchNumber: 1, player1Name: d.a.username, player2Name: d.b.username },
    ]);
    const { start } = await spectate(sv, game.id);
    expect(start).toMatchObject({ isSpectator: true, draftRoomId: d.roomId });
    expect(isHidden(start.gameState.playerHand)).toBe(true);
    // Draft games aren't in the lobby's table list
    expect(roomManager.getActiveRooms().some((r) => r.id === game.id)).toBe(false);

    // The tournament is over: every pool and deck
    room.phase = "finished";
    view = draftRoomManager.getMaskedState(d.roomId, sv.id)!;
    expect(view.players.map((p) => p.draftedCards?.map((c) => c.id))).toEqual([["pool-a1"], ["pool-b1"]]);
    expect(view.players[0].deck?.map((c) => c.id)).toEqual(["deck-a1"]);
    // Players still see only their own
    expect(draftRoomManager.getMaskedState(d.roomId, d.sa.id)!.players.find((p) => !p.isYou)!.deck).toBeNull();
    await sleep(50);
    await closeDraft(d);
  });
});
