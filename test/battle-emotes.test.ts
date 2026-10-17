/**
 * Battle emotes: ownership (starters always owned), the 5-emote loadout, every acquisition path
 * (market by rarity, prizes, battle pass, admin grants, draft prizes) and `sendEmote` over real
 * sockets (seated players only, loadout only, rate limit, broadcast to players and spectators), also
 * after the game over while the finished room lives (tables and draft games).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import {
  BATTLE_EMOTES,
  COLLECTIBLE_EMOTES,
  EMOTE_BY_ID,
  STARTER_EMOTE_IDS,
} from "../src/modules/emotes/catalog.js";
import { cleanLoadout, getEmoteLoadout, getOwnedEmoteIds } from "../src/modules/emotes/emotes.service.js";
import { emotesRouter } from "../src/modules/emotes/index.js";
import { EMOTE_PRICES, buyCosmetic, getDailyOffers } from "../src/modules/market/market.service.js";
import { grantPrize, resolveEmote } from "../src/modules/prizes/prizes.js";
import { resolveSegmentPrize } from "../src/modules/wheel/wheel.service.js";
import { WHEEL_SEGMENTS } from "../src/modules/wheel/wheel.config.js";
import { resolvePatternPrize } from "../src/modules/slots/slots.service.js";
import { grantCosmetic } from "../src/modules/admin/admin.service.js";
import { isGrantableCosmetic } from "../src/modules/admin/grantable-cosmetics.js";
import { buildRewards, getCurrentPassWithProgress } from "../src/modules/battle-pass/battle-pass.service.js";
import { draftRewardsSchema } from "../src/socket/draft-rewards.js";
import {
  EMOTE_COOLDOWN_MS,
  EMOTE_MAX_PER_WINDOW,
  allowEmote,
  resetEmoteLimits,
} from "../src/socket/room-emotes.js";
import { roomManager } from "../src/socket/handlers.js";
import { draftRoomManager } from "../src/socket/draft-handlers.js";
import { FINISHED_ROOM_TTL_MS } from "../src/socket/rooms.js";
import { ALL_CARDS, type GameCard } from "@gonzaloaguila/game-core";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

const STARTERS = ["pikachu-giggle", "eevee-cool", "psyduck-stressed", "charizard-think", "bulbasaur-drink"];
const RARE = COLLECTIBLE_EMOTES.find((e) => e.rarity === "rare")!;
const COMMON = COLLECTIBLE_EMOTES.find((e) => e.rarity === "common")!;

let http: Awaited<ReturnType<typeof startHttpApp>>;
let server: Awaited<ReturnType<typeof startSocketServer>>;

beforeAll(async () => {
  http = await startHttpApp((app) => app.use("/api/users", emotesRouter));
  server = await startSocketServer();
});

afterAll(async () => {
  await http.close();
  await server.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  clearAccountStateCache();
  resetEmoteLimits();
});

describe("catalog", () => {
  it("has unique ids, five common static starters and only rare animated emotes", () => {
    expect(new Set(BATTLE_EMOTES.map((e) => e.id)).size).toBe(BATTLE_EMOTES.length);
    expect(STARTER_EMOTE_IDS).toEqual(STARTERS);
    for (const id of STARTERS) expect(EMOTE_BY_ID.get(id)).toMatchObject({ rarity: "common", animated: false });
    for (const e of BATTLE_EMOTES.filter((e) => e.animated)) expect(e.rarity).toBe("rare");
    expect(EMOTE_BY_ID.has("picaweapon")).toBe(false);
  });
});

describe("ownership and loadout", () => {
  it("a new account owns and has equipped the five starters (column default, no rows)", async () => {
    const user = await createUser();
    expect([...(await getOwnedEmoteIds(user.id))].sort()).toEqual([...STARTERS].sort());
    expect(await getEmoteLoadout(user.id)).toEqual(STARTERS);
    const res = await http.request("GET", "/api/users/me/emotes", { token: tokenFor(user) });
    expect(res.status).toBe(200);
    expect(res.body.loadout).toEqual(STARTERS);
    expect(res.body.emotes).toHaveLength(5);
    expect(res.body.emotes.every((e: { starter: boolean; obtainedAt: unknown }) => e.starter && e.obtainedAt === null)).toBe(true);
  });

  it("saves up to five owned emotes, no repeats; rejects unowned, unknown, repeated and a sixth", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    const put = (emoteIds: unknown) => http.request("PATCH", "/api/users/me/emotes/loadout", { token, body: { emoteIds } });

    expect((await put([RARE.id])).status).toBe(400); // not owned
    expect((await put(["picaweapon"])).status).toBe(400); // not in the catalog
    expect((await put(["eevee-cool", "eevee-cool"])).status).toBe(400);
    expect((await put([...STARTERS, RARE.id])).status).toBe(422); // six (body validation)
    expect(await getEmoteLoadout(user.id)).toEqual(STARTERS); // nothing changed

    await prisma.userEmote.create({ data: { userId: user.id, emoteId: RARE.id } });
    const saved = await put([RARE.id, "eevee-cool"]);
    expect(saved.status).toBe(200);
    expect(saved.body.loadout).toEqual([RARE.id, "eevee-cool"]);
    expect((await put([])).body.loadout).toEqual([]);

    const owned = await http.request("GET", "/api/users/me/emotes", { token });
    expect(owned.body.emotes.map((e: { emoteId: string }) => e.emoteId)).toContain(RARE.id);
  });

  it("a NULL stored loadout reads as the starters", () => {
    expect(cleanLoadout(null, new Set(STARTERS))).toEqual(STARTERS);
    expect(cleanLoadout(undefined, new Set(STARTERS))).toEqual(STARTERS);
  });

  it("a stored loadout only keeps known, owned emotes (first five, no repeats)", async () => {
    const owned = new Set([...STARTERS, RARE.id]);
    expect(cleanLoadout(["gone", RARE.id, RARE.id, COMMON.id, ...STARTERS], owned)).toEqual([RARE.id, ...STARTERS.slice(0, 4)]);
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { emoteLoadout: [COMMON.id, "eevee-cool"] } });
    expect(await getEmoteLoadout(user.id)).toEqual(["eevee-cool"]); // COMMON not owned
  });
});

describe("getting emotes", () => {
  it("the market offers one non-starter emote a day, priced by rarity", async () => {
    expect(EMOTE_PRICES.common).toBeLessThan(EMOTE_PRICES.uncommon);
    expect(EMOTE_PRICES.uncommon).toBeLessThan(EMOTE_PRICES.rare);
    const rarities = new Set<string>();
    for (let day = 0; day < 60; day++) {
      const offers = await getDailyOffers(undefined, new Date(Date.UTC(2026, 9, 1 + day, 12)));
      const emotes = offers.cosmeticOffers.filter((o) => o.type === "emote");
      expect(emotes).toHaveLength(1);
      const emote = EMOTE_BY_ID.get(emotes[0].itemId)!;
      expect(emote.starter).toBeFalsy();
      expect(emotes[0]).toMatchObject({ price: EMOTE_PRICES[emote.rarity], rarity: emote.rarity, imageUrl: `/emotes/battle/${emote.id}.webp` });
      rarities.add(emote.rarity);
    }
    expect(rarities.size).toBe(3);
  });

  it("buying today's emote charges its price in coupons once and owns it", async () => {
    const offer = (await getDailyOffers()).cosmeticOffers.find((o) => o.type === "emote")!;
    const user = await createUser({ coupons: 100 });
    await buyCosmetic(user.id, "emote", offer.itemId);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coupons).toBe(100 - offer.price);
    expect((await getOwnedEmoteIds(user.id)).has(offer.itemId)).toBe(true);
    await expect(buyCosmetic(user.id, "emote", offer.itemId)).rejects.toMatchObject({ statusCode: 400 });
    const after = await getDailyOffers(user.id);
    expect(after.ownedItems).toContain(`own:emote:${offer.itemId}`);
  });

  it("prizes grant a random non-starter emote (idempotent)", async () => {
    const user = await createUser();
    const prize = resolveEmote()!;
    expect(prize.type).toBe("emote");
    expect(EMOTE_BY_ID.get(prize.emoteId)?.starter).toBeFalsy();
    await prisma.$transaction((tx) => grantPrize(tx, user.id, prize, { type: "wheel_spin", label: "Ruleta" }));
    await prisma.$transaction((tx) => grantPrize(tx, user.id, prize, { type: "wheel_spin", label: "Ruleta" }));
    expect(await prisma.userEmote.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a jackpot's emote is one the player doesn't own; owning them all leaves the emote out", () => {
    const allButOne = new Set(COLLECTIBLE_EMOTES.slice(1).map((e) => e.id));
    for (let i = 0; i < 20; i++) expect(resolveEmote(allButOne)?.emoteId).toBe(COLLECTIBLE_EMOTES[0].id);
    const all = new Set(COLLECTIBLE_EMOTES.map((e) => e.id));
    expect(resolveEmote(all)).toBeNull();

    const jackpot = WHEEL_SEGMENTS.find((s) => s.payload.type === "jackpot")!;
    const subTypes = (p: ReturnType<typeof resolveSegmentPrize>) => (p.type === "jackpot" ? p.prizes.map((s) => s.type) : []);
    expect(subTypes(resolveSegmentPrize(jackpot, new Set()))).toEqual(["coins", "card", "overlay", "emote"]);
    expect(subTypes(resolveSegmentPrize(jackpot, all))).toEqual(["coins", "card", "overlay"]);
    const mega = resolvePatternPrize("full_grid", "card", all);
    expect(mega.type === "jackpot" && mega.prizes.some((s) => s.type === "emote")).toBe(false);
    const megaNew = resolvePatternPrize("full_grid", "card", allButOne);
    expect(megaNew.type === "jackpot" && megaNew.prizes.find((s) => s.type === "emote")).toMatchObject({ emoteId: COLLECTIBLE_EMOTES[0].id });
  });

  it("passes before November 2026 keep the old premium track; November on has the emotes", async () => {
    const october = buildRewards(31, { year: 2026, month: 10 }).filter((r) => r.track === "premium");
    expect(october.some((r) => r.rewardType === "emote")).toBe(false);
    for (const step of [2, 9, 16, 25]) {
      expect(october.find((r) => r.day === step)).toMatchObject({ rewardType: "coins", amount: 50, label: "50 Monedas" });
    }
    expect(october.filter((r) => r.rewardType === "coins").reduce((n, r) => n + (r.amount ?? 0), 0)).toBe(1000);

    const november = buildRewards(30, { year: 2026, month: 11 }).filter((r) => r.track === "premium");
    expect(november.find((r) => r.day === 9)).toMatchObject({ rewardType: "emote", rewardId: "pachirisu-dance" });
    expect(november.find((r) => r.day === 25)).toMatchObject({ rewardType: "emote", rewardId: "pikachu-shocked" });
    expect(buildRewards(31, { year: 2027, month: 1 }).some((r) => r.rewardType === "emote")).toBe(true);

    // The pass a player sees (rebuilt from the config) follows its own month
    const user = await createUser();
    const oct = await getCurrentPassWithProgress(user.id, new Date(Date.UTC(2026, 9, 20, 15)));
    expect(oct.rewards.find((r) => r.track === "premium" && r.day === 9)).toMatchObject({ rewardType: "coins", amount: 50 });
    const nov = await getCurrentPassWithProgress(user.id, new Date(Date.UTC(2026, 10, 20, 15)));
    expect(nov.rewards.find((r) => r.track === "premium" && r.day === 9)).toMatchObject({ rewardType: "emote" });
  });

  it("the premium battle pass has two emotes and still 1000 coins", () => {
    const premium = buildRewards(30).filter((r) => r.track === "premium");
    const emotes = premium.filter((r) => r.rewardType === "emote");
    expect(emotes).toHaveLength(2);
    for (const r of emotes) expect(EMOTE_BY_ID.has(r.rewardId!)).toBe(true);
    expect(premium.filter((r) => r.rewardType === "coins").reduce((n, r) => n + (r.amount ?? 0), 0)).toBe(1000);
  });

  it("admins grant collectible emotes (not starters, not twice); drafts can give them", async () => {
    const admin = await createUser({}, { role: "admin" });
    const user = await createUser();
    expect(isGrantableCosmetic("emote", RARE.id)).toBe(true);
    expect(isGrantableCosmetic("emote", "eevee-cool")).toBe(false);
    await expect(grantCosmetic(admin.id, user.id, "emote", "eevee-cool")).rejects.toMatchObject({ statusCode: 400 });
    await grantCosmetic(admin.id, user.id, "emote", RARE.id);
    expect((await getOwnedEmoteIds(user.id)).has(RARE.id)).toBe(true);
    await expect(grantCosmetic(admin.id, user.id, "emote", RARE.id)).rejects.toMatchObject({ statusCode: 400 });
    expect(draftRewardsSchema.safeParse([{ target: "all", items: [{ type: "emote", id: RARE.id }] }]).success).toBe(true);
    expect(draftRewardsSchema.safeParse([{ target: "all", items: [{ type: "emote", id: "eevee-cool" }] }]).success).toBe(false);
  });
});

describe("rate limit", () => {
  it("one emote per 3 s and at most ten a minute", () => {
    const t0 = 1_000_000;
    expect(allowEmote("u", t0)).toBe(true);
    expect(allowEmote("u", t0 + EMOTE_COOLDOWN_MS - 1)).toBe(false);
    expect(allowEmote("u", t0 + EMOTE_COOLDOWN_MS)).toBe(true);
    for (let i = 2; i < EMOTE_MAX_PER_WINDOW; i++) expect(allowEmote("u", t0 + i * EMOTE_COOLDOWN_MS)).toBe(true);
    // Ten in 27 s: the eleventh waits until the first leaves the minute window
    expect(allowEmote("u", t0 + 40_000)).toBe(false);
    expect(allowEmote("u", t0 + 60_000)).toBe(true);
    expect(allowEmote("other", t0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendEmote over real sockets
// ---------------------------------------------------------------------------

const HITMONCHAN = "base-set-007-hitmonchan";
const FIGHTING = "base-set-097-fighting-energy";

async function playableDeck(userId: string) {
  await prisma.userCard.createMany({
    data: [
      { userId, cardDefId: HITMONCHAN, quantity: 4 },
      { userId, cardDefId: FIGHTING, quantity: 56 },
    ],
  });
  return prisma.deck.create({
    data: {
      userId,
      name: "Hitmonchan",
      isValid: true,
      cards: [
        { cardDefId: HITMONCHAN, quantity: 4 },
        { cardDefId: FIGHTING, quantity: 56 },
      ],
    },
  });
}

async function startTable() {
  const [p1, p2] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
  const [deck1, deck2] = await Promise.all([playableDeck(p1.id), playableDeck(p2.id)]);
  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  s1.emit("createRoom", { deckId: deck1.id, prizeCount: 6, betAmount: 0, friendly: false });
  const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
  const started = Promise.all([nextEvent(s1, "gameStart"), nextEvent(s2, "gameStart")]);
  s2.emit("joinRoom", { roomId, deckId: deck2.id });
  await started;
  return { roomId, p1, p2, s1, s2 };
}

type Ack = { success: boolean; error?: string; code?: string };
const send = (socket: Awaited<ReturnType<typeof server.connect>>, payload: unknown) =>
  new Promise<Ack>((resolve) => socket.emit("sendEmote", payload, resolve));

describe("sendEmote", () => {
  it("a seated player's emote reaches both players and the spectators, with the sender's side", async () => {
    const t = await startTable();
    expect(roomManager.getRoom(t.roomId)!.emoteLoadouts).toEqual({ player1: STARTERS, player2: STARTERS });
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    const watching = nextEvent(sv, "gameStart");
    sv.emit("spectateRoom", { roomId: t.roomId });
    await watching;

    const got = Promise.all([nextEvent<any>(t.s1, "emote"), nextEvent<any>(t.s2, "emote"), nextEvent<any>(sv, "emote")]);
    expect(await send(t.s2, { roomId: t.roomId, emoteId: "psyduck-stressed" })).toEqual({ success: true });
    for (const payload of await got) {
      expect(payload).toMatchObject({ roomId: t.roomId, side: "player2", userId: t.p2.id, emoteId: "psyduck-stressed" });
    }

    // Spectators can't send
    expect(await send(sv, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, error: "Los espectadores solo pueden mirar y chatear" });
  });

  it("only emotes of the sender's loadout, at most one every 3 s", async () => {
    const t = await startTable();
    expect(await send(t.s1, { roomId: t.roomId, emoteId: RARE.id })).toMatchObject({ success: false, code: "EMOTE_NOT_EQUIPPED" });
    resetEmoteLimits();
    expect(await send(t.s1, { roomId: t.roomId, emoteId: "eevee-cool" })).toEqual({ success: true });
    expect(await send(t.s1, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, code: "EMOTE_RATE_LIMITED" });
    // The other player has their own limit
    expect(await send(t.s2, { roomId: t.roomId, emoteId: "eevee-cool" })).toEqual({ success: true });
    // Invalid payloads and other rooms are refused
    expect((await send(t.s2, { roomId: t.roomId, emoteId: "<script>" })).success).toBe(false);
    expect(await send(t.s2, { roomId: "NOPE01", emoteId: "eevee-cool" })).toMatchObject({ success: false, code: "NOT_IN_GAME" });
  });

  it("a loadout changed during the game works on the next emote (re-read on a miss)", async () => {
    const t = await startTable();
    await prisma.userEmote.create({ data: { userId: t.p1.id, emoteId: RARE.id } });
    await prisma.user.update({ where: { id: t.p1.id }, data: { emoteLoadout: [RARE.id] } });
    const got = nextEvent<any>(t.s2, "emote");
    expect(await send(t.s1, { roomId: t.roomId, emoteId: RARE.id })).toEqual({ success: true });
    expect(await got).toMatchObject({ side: "player1", emoteId: RARE.id });
    expect(roomManager.getRoom(t.roomId)!.emoteLoadouts!.player1).toEqual([RARE.id]);
  });

  it("someone who doesn't sit at the table can't send", async () => {
    const t = await startTable();
    const stranger = await createUser();
    const s = await server.connect(tokenFor(stranger));
    expect(await send(s, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, code: "NOT_IN_GAME" });
    const anon = await server.connect();
    expect((await send(anon, { roomId: t.roomId, emoteId: "eevee-cool" })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// After the game over ("gg")
// ---------------------------------------------------------------------------

const surrender = (socket: Awaited<ReturnType<typeof server.connect>>, roomId: string) =>
  socket.emit("action", { roomId, action: { type: "surrender", payload: {} } });

/** A draft's (single-match) tournament game, A vs B, both connected to the game room. */
async function draftGame() {
  const [admin, a, b] = await Promise.all([
    createUser({}, { role: "admin" }),
    createUser({}, { stats: true }),
    createUser({}, { stats: true }),
  ]);
  const draft = draftRoomManager.createRoom({ adminPlays: false, entryFee: 0 }, admin.id, "admin-emotes", "Admin");
  for (const [u, name] of [[a, "A"], [b, "B"]] as const) draftRoomManager.joinRoom(draft.id, u.id, `draft-${name}`, name);
  draft.phase = "matching";
  draft.tournament = {
    rounds: [{ roundNumber: 1, pairings: [{ matchNumber: 1, player1: { id: a.id, name: "A" }, player2: { id: b.id, name: "B" } }], byePlayerId: null, status: "in_progress", results: [] }],
    standings: [a, b].map((u, i) => ({ playerId: u.id, playerName: "AB"[i], wins: 0, losses: 0, byes: 0, withdrawn: false })),
    currentRoundNumber: 1,
    totalRounds: 1,
  };
  const game = roomManager.createRoom();
  game.isDraft = true;
  await roomManager.joinRoom(game.id, a.id, "");
  await roomManager.joinRoom(game.id, b.id, "");
  const card = (name: string, id: string): GameCard => ({ ...(ALL_CARDS.find((c) => c.name === name && c.set === "Base Set")!), id });
  const deck = Array.from({ length: 60 }, (_, i) => card(i % 3 === 0 ? "Pikachu" : "Lightning Energy", `e${i}`));
  await roomManager.startGameWithRawDecks(game.id, deck, deck.map((x) => ({ ...x, id: `${x.id}b` })));
  draftRoomManager.registerGameRoom(game.id, draft.id, 1, 1, a.id, b.id);

  const sa = await server.connect(tokenFor(a));
  const sb = await server.connect(tokenFor(b));
  for (const s of [sa, sb]) {
    const back = nextEvent(s, "gameStart");
    s.emit("joinRoom", { roomId: game.id });
    await back;
  }
  return { draft, game, a, b, sa, sb };
}

describe("sendEmote after the game over", () => {
  it("both seated players of a finished table can still send (same loadout and rate limit); spectators can't", async () => {
    const t = await startTable();
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    const watching = nextEvent(sv, "gameStart");
    sv.emit("spectateRoom", { roomId: t.roomId });
    await watching;

    const over = Promise.all([nextEvent<any>(t.s1, "gameOver"), nextEvent<any>(t.s2, "gameOver")]);
    surrender(t.s1, t.roomId);
    expect((await over)[0]).toMatchObject({ winner: "player2" });
    const room = roomManager.getRoom(t.roomId)!;
    expect(room.status).toBe("finished");
    expect(room.gameState!.gamePhase).toBe("GAME_OVER");

    // The loser says gg: the winner and the spectator get it
    const got = Promise.all([nextEvent<any>(t.s2, "emote"), nextEvent<any>(sv, "emote")]);
    expect(await send(t.s1, { roomId: t.roomId, emoteId: "pikachu-giggle" })).toEqual({ success: true });
    for (const payload of await got) {
      expect(payload).toMatchObject({ roomId: t.roomId, side: "player1", userId: t.p1.id, emoteId: "pikachu-giggle" });
    }
    // The winner answers
    const back = nextEvent<any>(t.s1, "emote");
    expect(await send(t.s2, { roomId: t.roomId, emoteId: "eevee-cool" })).toEqual({ success: true });
    expect(await back).toMatchObject({ side: "player2", emoteId: "eevee-cool" });

    // Same checks as during the game
    expect(await send(t.s1, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, code: "EMOTE_RATE_LIMITED" });
    resetEmoteLimits();
    expect(await send(t.s1, { roomId: t.roomId, emoteId: RARE.id })).toMatchObject({ success: false, code: "EMOTE_NOT_EQUIPPED" });
    expect(await send(sv, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, error: "Los espectadores solo pueden mirar y chatear" });

    // A player who left the finished room can't send any more
    t.s2.emit("leaveRoom", { roomId: t.roomId });
    await new Promise((r) => setTimeout(r, 100));
    expect(await send(t.s2, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, code: "NOT_IN_GAME" });
  });

  it("a finished room lives FINISHED_ROOM_TTL_MS after the end, even when the game took more than 5 minutes", async () => {
    const t = await startTable();
    const room = roomManager.getRoom(t.roomId)!;
    // A long game: the room was created 30 minutes ago (the old sweep deleted it within a minute)
    room.createdAt = new Date(Date.now() - 30 * 60_000);
    const over = nextEvent(t.s2, "gameOver");
    surrender(t.s1, t.roomId);
    await over;

    const end = Date.now();
    roomManager.sweepRooms(end);
    roomManager.sweepRooms(end + FINISHED_ROOM_TTL_MS - 1);
    expect(roomManager.getRoom(t.roomId)).toBeDefined();
    expect(await send(t.s2, { roomId: t.roomId, emoteId: "eevee-cool" })).toEqual({ success: true });

    roomManager.sweepRooms(end + FINISHED_ROOM_TTL_MS);
    expect(roomManager.getRoom(t.roomId)).toBeUndefined();
    expect(await send(t.s1, { roomId: t.roomId, emoteId: "eevee-cool" })).toMatchObject({ success: false, code: "NOT_IN_GAME" });
  });

  it("both players of a finished draft game can still send", async () => {
    const m = await draftGame();
    const over = Promise.all([nextEvent<any>(m.sa, "gameOver"), nextEvent<any>(m.sb, "gameOver")]);
    surrender(m.sb, m.game.id);
    await over;
    expect(m.game.status).toBe("finished");

    const toB = nextEvent<any>(m.sb, "emote");
    expect(await send(m.sa, { roomId: m.game.id, emoteId: "charizard-think" })).toEqual({ success: true });
    expect(await toB).toMatchObject({ roomId: m.game.id, side: "player1", userId: m.a.id, emoteId: "charizard-think" });
    const toA = nextEvent<any>(m.sa, "emote");
    expect(await send(m.sb, { roomId: m.game.id, emoteId: "bulbasaur-drink" })).toEqual({ success: true });
    expect(await toA).toMatchObject({ side: "player2", userId: m.b.id, emoteId: "bulbasaur-drink" });
  });
});
