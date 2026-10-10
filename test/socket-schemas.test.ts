import { describe, expect, it } from "vitest";
import {
  socketSchemas,
  draftSchemas,
  parsePayload,
  parseGameAction,
} from "../src/socket/schemas.js";

// Payloads copied from the real frontend senders (pokemon-tcg repo):
// LobbyPage.tsx, MultiplayerGamePage.tsx, ChatPanel.tsx, useChatSocket.ts, useDraftSocket.ts
const USER_ID = "ae902afd-6619-4d21-ba73-16f02115e5a1";
const DECK_UUID = "0b7d3c1e-2f4a-4b5c-8d6e-7f8091a2b3c4";

function ok<T>(res: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!res.ok) throw new Error(`expected valid payload, got: ${res.error}`);
  return res.data;
}

describe("lobby / room event schemas", () => {
  it("accepts createRoom exactly as LobbyPage sends it (legacy identity fields ignored)", () => {
    const data = ok(parsePayload(socketSchemas.createRoom, {
      userId: USER_ID,
      deckId: DECK_UUID,
      prizeCount: 6,
      betAmount: 0,
      friendly: false,
      reservedUserId: undefined,
      username: "Ash",
      avatarId: null,
      titleId: "novato",
    }));
    expect(data).toEqual({ deckId: DECK_UUID, prizeCount: 6, betAmount: 0, friendly: false });
    expect(data).not.toHaveProperty("username");
    // Theme decks and a reserved opponent
    expect(parsePayload(socketSchemas.createRoom, { deckId: "brushfire", prizeCount: 4, betAmount: 50, friendly: false, reservedUserId: "misty" }).ok).toBe(true);
  });

  it("rejects bad createRoom values", () => {
    for (const bad of [
      { deckId: DECK_UUID, prizeCount: "6" },
      { deckId: DECK_UUID, prizeCount: 7 },
      { deckId: DECK_UUID, betAmount: -10 },
      { deckId: DECK_UUID, betAmount: 1.5 },
      { deckId: DECK_UUID, betAmount: 1e9 },
      { deckId: { $ne: null } },
      { deckId: "x".repeat(500) },
      { deckId: DECK_UUID, friendly: "yes" },
      null,
      "createRoom",
    ]) {
      expect(parsePayload(socketSchemas.createRoom, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts joinRoom from the lobby and from the game page", () => {
    expect(ok(parsePayload(socketSchemas.joinRoom, {
      roomId: "AB12CD", userId: USER_ID, deckId: DECK_UUID, username: "Ash", avatarId: "pikachu", titleId: "novato",
    }))).toEqual({ roomId: "AB12CD", deckId: DECK_UUID });
    expect(ok(parsePayload(socketSchemas.joinRoom, { roomId: "AB12CD", userId: USER_ID }))).toEqual({ roomId: "AB12CD" });
  });

  it("rejects room ids that aren't short codes (joinRoom creates missing rooms)", () => {
    for (const roomId of ["", "x".repeat(65), "user:abc", "../../etc", 123, null, ["AB12CD"]]) {
      expect(parsePayload(socketSchemas.joinRoom, { roomId }).ok, String(roomId)).toBe(false);
    }
  });

  it("validates the simple { roomId } events", () => {
    for (const schema of [socketSchemas.roomRef]) {
      expect(parsePayload(schema, { roomId: "AB12CD" }).ok).toBe(true);
      expect(parsePayload(schema, {}).ok).toBe(false);
      expect(parsePayload(schema, undefined).ok).toBe(false);
    }
  });

  it("requestCoinFlip names the Trainer card or the Pokémon using its power", () => {
    const ok = (p: unknown) => parsePayload(socketSchemas.requestCoinFlip, p).ok;
    expect(ok({ roomId: "AB12CD", purpose: "trainer", cardId: "PB-0" })).toBe(true);
    expect(ok({ roomId: "AB12CD", purpose: "power", pokemonId: "vileplume-1" })).toBe(true);
    expect(ok({ roomId: "AB12CD", purpose: "trainer" })).toBe(false);
    expect(ok({ roomId: "AB12CD", purpose: "power", cardId: "x" })).toBe(false);
    expect(ok({ roomId: "AB12CD", purpose: "healFlip", pokemonId: "v" })).toBe(false);
    expect(ok({ roomId: "AB12CD", purpose: "attack" })).toBe(false);
  });

  it("action envelope requires a room and an action type", () => {
    expect(parsePayload(socketSchemas.actionEnvelope, { roomId: "AB12CD", action: { type: "endTurn", payload: {} } }).ok).toBe(true);
    expect(parsePayload(socketSchemas.actionEnvelope, { roomId: "AB12CD" }).ok).toBe(false);
    expect(parsePayload(socketSchemas.actionEnvelope, { roomId: "AB12CD", action: "endTurn" }).ok).toBe(false);
  });

  it("room chat: trimmed content, 1..500 chars", () => {
    expect(ok(parsePayload(socketSchemas.chatMessage, { roomId: "AB12CD", message: { content: "  hola  " } })).message.content).toBe("hola");
    expect(parsePayload(socketSchemas.chatMessage, { roomId: "AB12CD", message: { content: "   " } }).ok).toBe(false);
    expect(parsePayload(socketSchemas.chatMessage, { roomId: "AB12CD", message: { content: "a".repeat(501) } }).ok).toBe(false);
    expect(parsePayload(socketSchemas.chatMessage, { roomId: "AB12CD", message: "hola" }).ok).toBe(false);
  });

  it("global chat: text up to 500, stickers up to 100, type defaults to text", () => {
    expect(ok(parsePayload(socketSchemas.globalChatMessage, { content: "hola", type: "text" }))).toEqual({ content: "hola", type: "text" });
    expect(ok(parsePayload(socketSchemas.globalChatMessage, { content: "hola" })).type).toBe("text");
    expect(parsePayload(socketSchemas.globalChatMessage, { content: "pikachu-wave", type: "sticker" }).ok).toBe(true);
    expect(parsePayload(socketSchemas.globalChatMessage, { content: "s".repeat(101), type: "sticker" }).ok).toBe(false);
    expect(parsePayload(socketSchemas.globalChatMessage, { content: "t".repeat(501), type: "text" }).ok).toBe(false);
    expect(parsePayload(socketSchemas.globalChatMessage, { content: "hola", type: "html" }).ok).toBe(false);
    expect(parsePayload(socketSchemas.globalChatMessage, { content: 42 }).ok).toBe(false);
  });
});

describe("draft event schemas", () => {
  it("draft:create accepts the admin panel's config and rejects out-of-range values", () => {
    const config = {
      maxPlayers: 8, packsPerPlayer: 3, cardsPerPack: 11, pickTimeSeconds: 45,
      keepInCollection: false, minDeckSize: 40, entryFee: 2000, adminPlays: false,
    };
    expect(ok(parsePayload(draftSchemas.create, { config })).config).toEqual(config);
    expect(parsePayload(draftSchemas.create, { config: { maxPlayers: 2, entryFee: 0, adminPlays: true } }).ok).toBe(true);
    expect(parsePayload(draftSchemas.create, {}).ok).toBe(true);
    for (const bad of [{ maxPlayers: 1000 }, { cardsPerPack: 0 }, { entryFee: -500 }, { entryFee: 1e12 }, { pickTimeSeconds: "45" }, { adminPlays: 1 }]) {
      expect(parsePayload(draftSchemas.create, { config: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("draft:pick / bonusPick / submitDeck / forfeit from useDraftSocket", () => {
    expect(parsePayload(draftSchemas.roomRef, { roomId: "K7M2PQ" }).ok).toBe(true);
    expect(parsePayload(draftSchemas.pick, { roomId: "K7M2PQ", cardId: "draft-1700000000000-12-a1b2c3" }).ok).toBe(true);
    expect(parsePayload(draftSchemas.bonusPick, { roomId: "K7M2PQ", cardDefIds: ["a", "b", "c"] }).ok).toBe(true);
    expect(parsePayload(draftSchemas.submitDeck, {
      roomId: "K7M2PQ",
      deckCardIds: Array.from({ length: 25 }, (_, i) => `draft-${i}`),
      energyCards: [{ type: "fire", count: 10 }, { type: "water", count: 5 }],
    }).ok).toBe(true);
    expect(parsePayload(draftSchemas.forfeit, { draftRoomId: "K7M2PQ", gameRoomId: "AB12CD" }).ok).toBe(true);
  });

  it("rejects huge arrays, unknown energy types and bad counts", () => {
    expect(parsePayload(draftSchemas.bonusPick, { roomId: "K7M2PQ", cardDefIds: Array(1000).fill("x") }).ok).toBe(false);
    expect(parsePayload(draftSchemas.submitDeck, { roomId: "K7M2PQ", deckCardIds: Array(100_000).fill("x"), energyCards: [] }).ok).toBe(false);
    expect(parsePayload(draftSchemas.submitDeck, { roomId: "K7M2PQ", deckCardIds: [], energyCards: [{ type: "colorless", count: 5 }] }).ok).toBe(false);
    expect(parsePayload(draftSchemas.submitDeck, { roomId: "K7M2PQ", deckCardIds: [], energyCards: [{ type: "fire", count: 1e9 }] }).ok).toBe(false);
    expect(parsePayload(draftSchemas.submitDeck, { roomId: "K7M2PQ", deckCardIds: [], energyCards: [{ type: "fire", count: -1 }] }).ok).toBe(false);
    expect(parsePayload(draftSchemas.pick, { roomId: "K7M2PQ" }).ok).toBe(false);
  });
});

describe("game action schemas (every executeAction case)", () => {
  // [type, payload] exactly as MultiplayerGamePage's sendAction(type, payload) builds them
  const realClientActions: Array<[string, Record<string, unknown>]> = [
    ["endTurn", {}],
    ["attack", { attackIndex: 0, selectedEnergyIds: undefined }],
    ["attack", { attackIndex: 1, selectedEnergyIds: ["e1", "e2"] }],
    ["attack", { attackIndex: 0, metronomeAttack: { name: "Hydro Pump", index: 1 } }],
    ["attack", { attackIndex: 0, conversionType: "fire", conversionEffect: "changeWeakness" }],
    ["attack", { attackIndex: 1, conversionType: "psychic", conversionEffect: "changeResistance" }],
    ["retreat", { energyIdsToDiscard: ["e1"], benchIndex: 2 }],
    ["retreat", { energyIdsToDiscard: [], benchIndex: 0 }],
    ["playBasicToActive", { cardId: "Pikachu-0-1700000000000-0.123" }],
    ["playBasicToBench", { cardId: "Pikachu-1-1700000000000-0.456" }],
    ["playBasicToBench", { cardId: "Pikachu-1-1700000000000-0.456", benchIndex: 4 }], // legacy, ignored
    ["attachEnergy", { cardId: "e1", pokemonId: "p1" }],
    ["attachEnergy", { cardId: "e1", pokemonId: "p1", isBench: true, benchIndex: 3 }], // legacy, ignored
    ["evolve", { cardId: "Raichu-0", targetPokemonId: "pikachu-1" }],
    ["evolve", { cardId: "Raichu-0", targetIndex: -1 }], // legacy
    ["evolve", { cardId: "Raichu-0", targetIndex: 4 }],
    ["takePrize", { prizeIndex: 5 }],
    ["promote", { benchIndex: 0 }],
    ["deckSearch", { cardId: "Bellsprout-2" }],
    ["deckSearch", { cardId: null }],
    ["forceSwitch", { benchIndex: 1 }],
    ["selfSwitch", { benchIndex: 1 }],
    ["skipSwitch", {}],
    ["benchDamage", { selectedPokemonIds: ["p2", "p3"] }],
    ["clearPeek", {}],
    ["mulligan", {}],
    ["playerReady", {}],
    ["surrender", {}],
    ["usePower", { pokemonId: "blastoise-1", selections: [["w1"], ["p1"]] }], // Rain Dance
    ["usePower", { pokemonId: "venusaur-1", selections: [["p1"], ["g1"], ["p2"]] }], // Energy Trans
    ["usePower", { pokemonId: "alakazam-1", selections: [["p1"], ["p2"], ["10"]] }], // Damage Swap
    ["usePower", { pokemonId: "charizard-1" }], // Energy Burn
    ["usePower", { pokemonId: "charizard-1", selections: [] }],
    ["usePower", { pokemonId: "electrode-1", selections: [["lightning"], ["p1"]] }], // Buzzap
    ["usePower", { pokemonId: "vileplume-1", selections: [["p1"]] }], // Heal, heads
    ["usePower", { pokemonId: "venomoth-1", selections: [["water"]] }], // Shift
    ["usePower", { pokemonId: "mankey-1", selections: [["opponentHand"]] }], // Peek
    ["usePower", { powerType: "energyBurn", pokemonId: "charizard" }], // legacy powerType: stripped
    ["playTrainer", { cardId: "Bill-0", selections: [] }],
    ["playTrainer", { cardId: "Bill-0" }],
    ["playTrainer", { cardId: "Bill-0", trainerName: "Bill", selections: [] }],
    ["playTrainer", { cardId: "Potion-0", trainerName: "Potion", selections: [["p1"]] }],
    ["playTrainer", { cardId: "PB-0", trainerName: "Poké Ball", selections: [], coinResult: "heads" }],
    ["playTrainer", { cardId: "PB-0", trainerName: "Poké Ball", selections: [["Bulbasaur-1"]], coinResult: undefined }],
    ["playTrainer", { cardId: "Dex-0", trainerName: "Pokédex", selections: [["4", "3", "2", "1", "0"]] }],
    ["playTrainer", { cardId: "SER-0", trainerName: "Super Energy Removal", selections: [["p1"], ["e1"], ["o1"], ["oe1", "oe2"]] }],
  ];

  it.each(realClientActions)("accepts %s %j", (type, payload) => {
    const res = parseGameAction({ type, payload: JSON.parse(JSON.stringify(payload)) });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  it("accepts actions sent with no payload at all when none is needed", () => {
    for (const type of ["endTurn", "skipSwitch", "clearPeek", "mulligan", "playerReady", "surrender"]) {
      expect(parseGameAction({ type }).ok, type).toBe(true);
    }
  });

  it("normalizes optional fields (legacy attach fields, missing deckSearch card, selections)", () => {
    const attach = parseGameAction({ type: "attachEnergy", payload: { cardId: "e1", pokemonId: "p1", isBench: false, benchIndex: null } });
    expect(attach.ok && attach.action.payload).toEqual({ cardId: "e1", pokemonId: "p1" });
    const power = parseGameAction({ type: "usePower", payload: { pokemonId: "charizard-1", powerType: "energyBurn" } });
    expect(power.ok && power.action.payload).toEqual({ pokemonId: "charizard-1", selections: [] });
    const search = parseGameAction({ type: "deckSearch", payload: {} });
    expect(search.ok && search.action.type === "deckSearch" && search.action.payload.cardId).toBeNull();
    const trainer = parseGameAction({ type: "playTrainer", payload: { cardId: "Bill-0", trainerName: "Bill" } });
    expect(trainer.ok && trainer.action.type === "playTrainer" && trainer.action.payload.selections).toEqual([]);
  });

  const invalid: Array<[string, unknown]> = [
    ["unknown type", { type: "giveMeCoins", payload: {} }],
    ["not an object", "attack"],
    ["missing type", { payload: { attackIndex: 0 } }],
    ["attackIndex as string", { type: "attack", payload: { attackIndex: "0" } }],
    ["attackIndex negative", { type: "attack", payload: { attackIndex: -1 } }],
    ["attackIndex float", { type: "attack", payload: { attackIndex: 0.5 } }],
    ["attack without index", { type: "attack", payload: {} }],
    ["bad conversion type", { type: "attack", payload: { attackIndex: 0, conversionType: "dragon", conversionEffect: "changeWeakness" } }],
    ["metronome index string", { type: "attack", payload: { attackIndex: 0, metronomeAttack: { name: "x", index: "1" } } }],
    ["retreat energies not array", { type: "retreat", payload: { energyIdsToDiscard: "e1", benchIndex: 0 } }],
    ["retreat huge array", { type: "retreat", payload: { energyIdsToDiscard: Array(10_000).fill("e"), benchIndex: 0 } }],
    ["bench card missing", { type: "playBasicToBench", payload: { benchIndex: 0 } }],
    ["cardId object", { type: "playBasicToActive", payload: { cardId: { $gt: "" } } }],
    ["cardId huge", { type: "playBasicToActive", payload: { cardId: "c".repeat(10_000) } }],
    ["attach without target", { type: "attachEnergy", payload: { cardId: "e", isBench: true, benchIndex: 0 } }],
    ["evolve target -2", { type: "evolve", payload: { cardId: "c", targetIndex: -2 } }],
    ["evolve without target", { type: "evolve", payload: { cardId: "c" } }],
    ["evolve target id object", { type: "evolve", payload: { cardId: "c", targetPokemonId: { $ne: 1 } } }],
    ["prize index 6", { type: "takePrize", payload: { prizeIndex: 6 } }],
    ["promote missing index", { type: "promote", payload: {} }],
    ["benchDamage ids not strings", { type: "benchDamage", payload: { selectedPokemonIds: [1, 2] } }],
    ["benchDamage huge", { type: "benchDamage", payload: { selectedPokemonIds: Array(500).fill("p") } }],
    ["power without pokemon", { type: "usePower", payload: { powerType: "peek", peekType: "playerDeck" } }],
    ["power selections not nested", { type: "usePower", payload: { pokemonId: "m", selections: ["playerDeck"] } }],
    ["power selection not a string", { type: "usePower", payload: { pokemonId: "a", selections: [[10]] } }],
    ["power selection empty string", { type: "usePower", payload: { pokemonId: "a", selections: [[""]] } }],
    ["power too many steps", { type: "usePower", payload: { pokemonId: "a", selections: Array(9).fill(["x"]) } }],
    ["trainer without card", { type: "playTrainer", payload: { trainerName: "Bill", selections: [] } }],
    ["selections not nested", { type: "playTrainer", payload: { cardId: "c", trainerName: "Potion", selections: ["p1"] } }],
    ["selections huge", { type: "playTrainer", payload: { cardId: "c", trainerName: "Maintenance", selections: [Array(5000).fill("x")] } }],
    ["selections too many steps", { type: "playTrainer", payload: { cardId: "c", trainerName: "Maintenance", selections: Array(100).fill(["x"]) } }],
    ["coinResult bogus", { type: "playTrainer", payload: { cardId: "c", trainerName: "Poké Ball", coinResult: "edge" } }],
  ];

  it.each(invalid)("rejects %s", (_label, action) => {
    const res = parseGameAction(action);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid/i);
  });
});
