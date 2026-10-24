/**
 * A set game-core flags `inDevelopment` (simulated here by flagging Gym Challenge, released in
 * game-core 0.9.0): the set is cataloged in the engine, but the API neither lists, sells, grants,
 * drafts nor accepts it in a deck until the engine release clears the flag
 * (gym-challenge-catalog.test.ts covers the released set).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@gonzaloaguila/game-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@gonzaloaguila/game-core")>();
  return {
    ...core,
    CARD_SETS: core.CARD_SETS.map((set) => (set.id === "gym-challenge" ? { ...set, inDevelopment: true } : set)),
  };
});

// The adventure content uses Gym Challenge cards (Brock's help treasures): with the set flagged
// in development it would fail validation at boot. Adventures aren't what this file checks.
vi.mock("../src/modules/adventure/content/load.js", async (importOriginal) => {
  const load = await importOriginal<typeof import("../src/modules/adventure/content/load.js")>();
  return { ...load, getAdventures: () => new Map(), getAdventure: () => undefined };
});

import { CARD_SETS } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { catalogRouter } from "../src/modules/catalog/index.js";
import { boostersRouter } from "../src/modules/boosters/index.js";
import { economyRouter } from "../src/modules/economy/index.js";
import { getAllSets, getCardById, getCardsBySet, searchCards } from "../src/modules/catalog/catalog.service.js";
import {
  STANDARD_BOOSTER_IDS,
  GYM_TRAINER_BOOSTER_ID,
  boosterIdForSet,
  getPackById,
  getPackOdds,
  openPack,
} from "../src/modules/boosters/boosters.service.js";
import { exchangeCost } from "../src/modules/economy/economy.service.js";
import { checkDeckPlayable, validateDeckCards } from "../src/modules/decks/decks.service.js";
import { DRAFT_PACK_SETS, draftPool } from "../src/socket/draft-rooms.js";
import { RELEASED_CARDS, RELEASED_SETS, isReleasedCard } from "../src/lib/released-sets.js";
import { startHttpApp } from "./http-helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

const GC = CARD_SETS.find((s) => s.id === "gym-challenge")!;
const gcIds = new Set(GC.cards.map((c) => c.id));

describe("a set in development (Gym Challenge flagged): hidden everywhere", () => {
  it("the flagged set is out of the released sets and cards", () => {
    expect(GC.inDevelopment).toBe(true);
    expect(GC.cards).toHaveLength(122);
    expect(RELEASED_SETS.map((s) => s.id)).not.toContain("gym-challenge");
    expect(RELEASED_CARDS.some((c) => gcIds.has(c.id))).toBe(false);
    expect(isReleasedCard(GC.cards[0])).toBe(false);
  });

  it("the catalog neither lists the set nor serves its cards", async () => {
    expect(getAllSets().map((s) => s.id)).not.toContain("gym-challenge");
    expect(getCardsBySet("gym-challenge")).toEqual([]);
    expect(getCardById("gym-challenge-001-blaines-arcanine")).toBeUndefined();
    expect(searchCards("blaine").some((c) => gcIds.has(c.id))).toBe(false);

    const app = await startHttpApp((a) => a.use("/api", catalogRouter));
    try {
      const sets = await app.request("GET", "/api/sets");
      expect(JSON.stringify(sets.body)).not.toContain("gym-challenge");
      expect((await app.request("GET", "/api/sets/gym-challenge")).status).toBe(404);
      expect((await app.request("GET", "/api/sets/gym-challenge/cards")).status).toBe(404);
      expect((await app.request("GET", "/api/cards/gym-challenge-001-blaines-arcanine")).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("no booster is sold or listed, and no pack, prize or draft gives its cards", async () => {
    expect(STANDARD_BOOSTER_IDS).not.toContain("gym-challenge-booster");
    expect(getPackById("gym-challenge-booster")).toBeUndefined();
    expect(boosterIdForSet("gym-challenge")).toBeNull();
    expect(() => openPack("gym-challenge-booster")).toThrow();

    const app = await startHttpApp((a) => {
      a.use("/api", boostersRouter);
      a.use("/api", economyRouter);
    });
    try {
      const packs = await app.request("GET", "/api/packs");
      expect(JSON.stringify(packs.body)).not.toContain("gym-challenge");
      expect((await app.request("GET", "/api/packs/gym-challenge-booster")).status).toBe(404);
      const config = await app.request("GET", "/api/economy/config");
      expect(config.body.packs.boosterIds).not.toContain("gym-challenge-booster");
      expect(JSON.stringify(config.body.setMilestones.sets)).not.toContain("gym-challenge");
    } finally {
      await app.close();
    }

    // Gym Trainer booster (still sold for Gym Heroes): none of the set's Trainers
    const trainerOdds = getPackOdds(GYM_TRAINER_BOOSTER_ID)!;
    expect(Object.keys(trainerOdds.cardChances).some((id) => gcIds.has(id))).toBe(false);
    for (let i = 0; i < 100; i++) expect(openPack(GYM_TRAINER_BOOSTER_ID).cards.some((c) => gcIds.has(c.card.id))).toBe(false);

    // Drafts and Fichas de canje
    expect(draftPool.some((c) => gcIds.has(c.id))).toBe(false);
    expect(DRAFT_PACK_SETS).not.toContain("gym-challenge");
    expect(exchangeCost("gym-challenge-001-blaines-arcanine")).toBeNull();
  });

  it("decks: a user deck or a theme deck with one of its cards is refused", async () => {
    const deck = [
      { cardDefId: "base-set-058-pikachu", quantity: 4 },
      { cardDefId: "gym-challenge-001-blaines-arcanine", quantity: 1 },
      { cardDefId: "base-set-100-lightning-energy", quantity: 55 },
    ];
    const result = validateDeckCards(deck);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("todavía no está disponible");

    expect(await checkDeckPlayable("anyone", "gym-challenge-giovanni")).toMatch(/todavía no está disponible/);
    expect(await checkDeckPlayable("anyone", "gym-heroes-brock")).toBeNull();
  });
});
