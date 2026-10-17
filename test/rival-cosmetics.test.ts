/**
 * Rival cosmetics over real sockets: `gameStart` carries both players' playmat, coin, card back
 * and deck variants (`playerCosmetics` / `opponentCosmetics`, `playerVariantMap` /
 * `opponentVariantMap`), read from the DB when the game starts, owned items only. The same
 * snapshot goes to a rejoining player and to spectators (player 1 = "player", the bottom side).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
import { buildOwnedVariantMap, loadSeatCosmetics, skinSlug } from "../src/socket/room-cosmetics.js";
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

const HITMONCHAN = "base-set-007-hitmonchan";
const FIGHTING = "base-set-097-fighting-energy";

/** A playable 60-card deck of `user` (cards granted) with Hitmonchan in `variantId`. */
async function deckWithVariant(userId: string, variantId: string) {
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
        { cardDefId: HITMONCHAN, quantity: 4, variantId },
        { cardDefId: FIGHTING, quantity: 56 },
      ],
    },
  });
}

/**
 * p1 owns and uses the Night City playmat, the Charizard coin, the Pikachu back and a Holo
 * Hitmonchan. p2's profile points at items it doesn't own (a Rainbow Hitmonchan, the Stadium
 * playmat, the Lucario coin, the Draw back): it plays with the defaults.
 */
async function startTable() {
  const [p1, p2] = await Promise.all([createUser({}, { stats: true }), createUser({}, { stats: true })]);
  await Promise.all([
    prisma.userPlaymat.create({ data: { userId: p1.id, playmatId: "night-city" } }),
    prisma.userCoin.create({ data: { userId: p1.id, coinId: "charizard" } }),
    prisma.userCardBack.create({ data: { userId: p1.id, cardBackId: "pikachu" } }),
    prisma.userCardSkin.create({ data: { userId: p1.id, skinId: skinSlug("Hitmonchan", "holo-sparkle") } }),
  ]);
  await prisma.user.update({
    where: { id: p1.id },
    data: { activePlaymatId: "night-city", activeCoinId: "charizard", activeCardBackId: "pikachu" },
  });
  await prisma.user.update({
    where: { id: p2.id },
    data: { activePlaymatId: "stadium", activeCoinId: "lucario", activeCardBackId: "draw" },
  });
  const [deck1, deck2] = await Promise.all([deckWithVariant(p1.id, "holo-sparkle"), deckWithVariant(p2.id, "rainbow")]);

  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  s1.emit("createRoom", { deckId: deck1.id, prizeCount: 6, betAmount: 0, friendly: false });
  const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
  const started1 = nextEvent<any>(s1, "gameStart");
  const started2 = nextEvent<any>(s2, "gameStart");
  s2.emit("joinRoom", { roomId, deckId: deck2.id });
  const [start1, start2] = await Promise.all([started1, started2]);
  return { roomId, p1, p2, s1, s2, start1, start2 };
}

const P1_COSMETICS = { playmatId: "night-city", coinId: "charizard", cardBackId: "pikachu" };
const DEFAULTS = { playmatId: "field", coinId: "eevee", cardBackId: "default" };

describe("gameStart cosmetics", () => {
  it("each player gets its own cosmetics and the rival's, owned only", async () => {
    const t = await startTable();
    expect(t.start1).toMatchObject({
      playerCosmetics: P1_COSMETICS,
      opponentCosmetics: DEFAULTS,
      playerVariantMap: { Hitmonchan: "holo-sparkle" },
      opponentVariantMap: {},
    });
    expect(t.start2).toMatchObject({
      playerCosmetics: DEFAULTS,
      opponentCosmetics: P1_COSMETICS,
      playerVariantMap: {},
      opponentVariantMap: { Hitmonchan: "holo-sparkle" },
    });
    // Only the public ids go out, nothing else of the profile
    expect(Object.keys(t.start1.opponentCosmetics).sort()).toEqual(["cardBackId", "coinId", "playmatId"]);
  });

  it("is the snapshot taken at the start: a rejoin gets the same even after a profile change", async () => {
    const t = await startTable();
    await prisma.user.update({ where: { id: t.p1.id }, data: { activePlaymatId: "field", activeCoinId: "eevee" } });
    t.s2.disconnect();
    const s2 = await server.connect(tokenFor(t.p2));
    const rejoined = nextEvent<any>(s2, "gameStart");
    s2.emit("joinRoom", { roomId: t.roomId });
    const start = await rejoined;
    expect(start).toMatchObject({
      isPlayer1: false,
      playerCosmetics: DEFAULTS,
      opponentCosmetics: P1_COSMETICS,
      opponentVariantMap: { Hitmonchan: "holo-sparkle" },
    });
    expect(roomManager.getRoom(t.roomId)!.cosmetics!.player1.playmatId).toBe("night-city");
  });

  it("spectators get player 1 as the bottom side and player 2 as the top side", async () => {
    const t = await startTable();
    const viewer = await createUser();
    const sv = await server.connect(tokenFor(viewer));
    const watching = nextEvent<any>(sv, "gameStart");
    sv.emit("spectateRoom", { roomId: t.roomId });
    const start = await watching;
    expect(start).toMatchObject({
      isSpectator: true,
      playerCosmetics: P1_COSMETICS,
      opponentCosmetics: DEFAULTS,
      playerVariantMap: { Hitmonchan: "holo-sparkle" },
      opponentVariantMap: {},
    });
  });
});

describe("seat cosmetics", () => {
  it("falls back to the free items for a missing user or unowned ids", async () => {
    expect(await loadSeatCosmetics(null, null)).toEqual({ ...DEFAULTS, variantMap: {} });
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { activePlaymatId: "kanto-sky", activeCoinId: "golem" } });
    expect(await loadSeatCosmetics(user.id, "brushfire")).toEqual({ ...DEFAULTS, variantMap: {} });
  });

  it("only maps variants whose skin is owned, by card name", () => {
    const owned = new Set([skinSlug("Hitmonchan", "gold")]);
    expect(
      buildOwnedVariantMap(
        [
          { cardDefId: HITMONCHAN, quantity: 2, variantId: "gold" },
          { cardDefId: "base-set-002-blastoise", quantity: 1, variantId: "gold" },
          { cardDefId: FIGHTING, quantity: 10 },
          { cardDefId: "not-a-card", quantity: 1, variantId: "gold" },
        ],
        owned,
      ),
    ).toEqual({ Hitmonchan: "gold" });
  });
});
