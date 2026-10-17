/**
 * Battle emotes: ownership (starters always owned), the 5-emote loadout, every acquisition path
 * (market by rarity, prizes, battle pass, admin grants, draft prizes) and `sendEmote` over real
 * sockets (seated players only, loadout only, rate limit, broadcast to players and spectators).
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
import { grantCosmetic } from "../src/modules/admin/admin.service.js";
import { isGrantableCosmetic } from "../src/modules/admin/grantable-cosmetics.js";
import { buildRewards } from "../src/modules/battle-pass/battle-pass.service.js";
import { draftRewardsSchema } from "../src/socket/draft-rewards.js";
import {
  EMOTE_COOLDOWN_MS,
  EMOTE_MAX_PER_WINDOW,
  allowEmote,
  resetEmoteLimits,
} from "../src/socket/room-emotes.js";
import { roomManager } from "../src/socket/handlers.js";
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
    const prize = resolveEmote();
    expect(prize.type).toBe("emote");
    if (prize.type !== "emote") return;
    expect(EMOTE_BY_ID.get(prize.emoteId)?.starter).toBeFalsy();
    await prisma.$transaction((tx) => grantPrize(tx, user.id, prize, { type: "wheel_spin", label: "Ruleta" }));
    await prisma.$transaction((tx) => grantPrize(tx, user.id, prize, { type: "wheel_spin", label: "Ruleta" }));
    expect(await prisma.userEmote.count({ where: { userId: user.id } })).toBe(1);
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
