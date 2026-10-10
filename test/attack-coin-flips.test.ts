/**
 * Multiplayer attacks with coin flips: the server rolls exactly getAttackCoinFlipCount coins,
 * broadcasts them (coinFlipInfo → showCoinFlip) and the engine resolves every coin effect.
 * Each scenario runs for both players: P2 acts on a swapped copy of the state.
 */
import { describe, expect, it } from "vitest";
import {
  baseSetCards,
  getDeckById,
  initializeMultiplayerGame,
  jungleCards,
  type GameCard,
  type GameModifier,
  type GameState,
  type PokemonInPlay,
} from "@gonzaloaguila/game-core";
import { GameRoomManager } from "../src/socket/rooms.js";

type Coin = "heads" | "tails";
type Side = "p1" | "p2";

const allCards = [...baseSetCards, ...jungleCards] as GameCard[];
function card(id: string): GameCard {
  const found = allCards.find((c) => c.id === id);
  if (!found) throw new Error(`card ${id} not in catalog`);
  return found;
}

const JOLTEON = "jungle-004-jolteon"; // 0: Quick Attack 10+ (20 on heads), 1: Pin Missile 20× (4 coins)
const RAICHU = "base-set-014-raichu"; // 1: Thunder 60, tails 30 to itself
const MEOWTH = "jungle-056-meowth"; // 0: Pay Day 10, heads: draw 1
const ELECTABUZZ = "base-set-020-electabuzz"; // 0: Thundershock 10, heads: Paralyzed
const SNORLAX = "jungle-011-snorlax"; // Thick Skinned: no special conditions
const CLEFAIRY = "base-set-005-clefairy"; // 1: Metronome
const RATTATA = "base-set-061-rattata"; // 30 HP
const LIGHTNING = "base-set-100-lightning-energy";
const chansey = allCards.find((c) => c.name === "Chansey")!; // 120 HP, no weakness to Lightning/Colorless
const plusPower = allCards.find((c) => c.name === "PlusPower")!;

function inPlay(cardId: GameCard | string, id: string, energy = 4): PokemonInPlay {
  const base = typeof cardId === "string" ? card(cardId) : cardId;
  return {
    pokemon: { ...base, id },
    attachedEnergy: Array.from({ length: energy }, (_, i) => ({ ...card(LIGHTNING), id: `${id}-e${i}` })),
    currentDamage: 0,
    statusConditions: [],
    turnPlayed: 0,
  } as unknown as PokemonInPlay;
}

/** Coins handed out in order; fails the test on an unexpected extra flip. */
function scriptedCoins(coins: Coin[]) {
  const queue = [...coins];
  const source = () => {
    const next = queue.shift();
    if (!next) throw new Error("the server flipped more coins than scripted");
    return next;
  };
  return { source, remaining: () => queue.length };
}

/** Field names (P1 perspective storage) for the acting side and its opponent. */
function fields(actor: Side) {
  const me = actor === "p1" ? "player" : "opponent";
  const them = actor === "p1" ? "opponent" : "player";
  return {
    myActive: `${me}ActivePokemon`,
    theirActive: `${them}ActivePokemon`,
    myBench: `${me}Bench`,
    theirBench: `${them}Bench`,
    myHand: `${me}Hand`,
    myDeck: `${me}Deck`,
    myPrizes: `${me}Prizes`,
    myCanTakePrize: `${me}CanTakePrize`,
    theirNeedsToPromote: `${them}NeedsToPromote`,
  } as const;
}

interface Setup {
  attacker: PokemonInPlay;
  defender: PokemonInPlay;
  defenderBench?: PokemonInPlay[];
  coins: Coin[];
  modifiers?: GameModifier[];
  myHandExtra?: GameCard[];
}

function setupRoom(actor: Side, opts: Setup) {
  const coins = scriptedCoins(opts.coins);
  const manager = new GameRoomManager(coins.source);
  const base = initializeMultiplayerGame(getDeckById("zap")!, getDeckById("overgrowth")!);
  const f = fields(actor);
  const state = {
    ...base,
    gamePhase: "PLAYING",
    gameStarted: true,
    turnNumber: 5,
    isPlayerTurn: actor === "p1",
    playerBench: [],
    opponentBench: [],
    playerPrizes: base.playerDeck.slice(0, 6),
    playerDeck: base.playerDeck.slice(6),
    opponentPrizes: base.opponentDeck.slice(0, 6),
    opponentDeck: base.opponentDeck.slice(6),
    activeModifiers: opts.modifiers ?? [],
  } as unknown as Record<string, unknown>;
  state[f.myActive] = opts.attacker;
  state[f.theirActive] = opts.defender;
  state[f.theirBench] = opts.defenderBench ?? [];
  if (opts.myHandExtra) state[f.myHand] = [...(state[f.myHand] as GameCard[]), ...opts.myHandExtra];

  const room = manager.createRoom();
  Object.assign(room, { player1SocketId: "s1", player2SocketId: "s2", status: "playing", gameState: state });
  const actorSocket = actor === "p1" ? "s1" : "s2";
  const otherSocket = actor === "p1" ? "s2" : "s1";
  const get = <T>(key: string) => (room.gameState as unknown as Record<string, T>)[key];
  const attack = (payload: Record<string, unknown>) =>
    manager.executeAction(room.id, actorSocket, { type: "attack", payload });
  const isActorTurn = () => (actor === "p1" ? room.gameState!.isPlayerTurn : !room.gameState!.isPlayerTurn);
  return { manager, room, coins, f, get, attack, actorSocket, otherSocket, isActorTurn };
}

function newCoinTokens(before: number, state: GameState) {
  return state.events.slice(before).map((e) => e.message.match(/\[coin:(heads|tails)\]/g) ?? []).flat();
}

describe.each(["p1", "p2"] as const)("attack coin flips as %s", (actor) => {
  it("Nx attack: Pin Missile does 20 per heads, coins broadcast and logged once", async () => {
    const t = setupRoom(actor, {
      attacker: inPlay(JOLTEON, "atk"),
      defender: inPlay(chansey, "def"),
      coins: ["heads", "heads", "tails", "heads"],
    });
    const eventsBefore = t.room.gameState!.events.length;
    const result = await t.attack({ attackIndex: 1 });

    expect(result.success).toBe(true);
    expect(result.coinFlipInfo).toEqual({ attackName: "Misil Aguja", results: ["heads", "heads", "tails", "heads"] });
    expect(t.coins.remaining()).toBe(0);
    expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(60);
    expect(newCoinTokens(eventsBefore, t.room.gameState!)).toEqual([
      "[coin:heads]", "[coin:heads]", "[coin:tails]", "[coin:heads]",
    ]);
    expect(t.isActorTurn()).toBe(false); // the attack ended the turn
  });

  it("N+ attack: Quick Attack is 30 on heads and 10 on tails", async () => {
    for (const [coin, damage] of [["heads", 30], ["tails", 10]] as const) {
      const t = setupRoom(actor, { attacker: inPlay(JOLTEON, "atk"), defender: inPlay(chansey, "def"), coins: [coin] });
      const result = await t.attack({ attackIndex: 0 });
      expect(result.success).toBe(true);
      expect(result.coinFlipInfo?.results).toEqual([coin]);
      expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(damage);
    }
  });

  it("attacks without coins roll none and send no coin info", async () => {
    const t = setupRoom(actor, { attacker: inPlay(RATTATA, "atk"), defender: inPlay(chansey, "def"), coins: [] });
    const result = await t.attack({ attackIndex: 0 });
    expect(result.success).toBe(true);
    expect(result.coinFlipInfo).toBeUndefined();
    expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(20);
    expect(t.isActorTurn()).toBe(false);
  });

  it("tails self-damage: Thunder hits itself for 30 only on tails", async () => {
    for (const [coin, self] of [["tails", 30], ["heads", 0]] as const) {
      const t = setupRoom(actor, { attacker: inPlay(RAICHU, "atk"), defender: inPlay(chansey, "def"), coins: [coin] });
      const result = await t.attack({ attackIndex: 1 });
      expect(result.success).toBe(true);
      expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(60);
      expect(t.get<PokemonInPlay>(t.f.myActive).currentDamage).toBe(self);
    }
  });

  it("Pay Day draws a card on heads (and doesn't damage Meowth)", async () => {
    for (const [coin, drawn] of [["heads", 1], ["tails", 0]] as const) {
      const t = setupRoom(actor, { attacker: inPlay(MEOWTH, "atk"), defender: inPlay(chansey, "def"), coins: [coin] });
      const handBefore = t.get<GameCard[]>(t.f.myHand).length;
      const deckBefore = t.get<GameCard[]>(t.f.myDeck).length;
      const result = await t.attack({ attackIndex: 0 });
      expect(result.success).toBe(true);
      expect(t.get<GameCard[]>(t.f.myHand).length).toBe(handBefore + drawn);
      expect(t.get<GameCard[]>(t.f.myDeck).length).toBe(deckBefore - drawn);
      expect(t.get<PokemonInPlay>(t.f.myActive).currentDamage).toBe(0);
      expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(10);
    }
  });

  it("status on heads: Thundershock paralyzes, but not Thick Skinned Snorlax", async () => {
    const vsChansey = setupRoom(actor, { attacker: inPlay(ELECTABUZZ, "atk"), defender: inPlay(chansey, "def"), coins: ["heads"] });
    expect((await vsChansey.attack({ attackIndex: 0 })).success).toBe(true);
    expect(vsChansey.get<PokemonInPlay>(vsChansey.f.theirActive).statusConditions).toContain("paralyzed");

    const vsSnorlax = setupRoom(actor, { attacker: inPlay(ELECTABUZZ, "atk"), defender: inPlay(SNORLAX, "def"), coins: ["heads"] });
    expect((await vsSnorlax.attack({ attackIndex: 0 })).success).toBe(true);
    const snorlax = vsSnorlax.get<PokemonInPlay>(vsSnorlax.f.theirActive);
    expect(snorlax.currentDamage).toBe(10);
    expect(snorlax.statusConditions).not.toContain("paralyzed");
  });

  it("KO from coin damage: attacker takes a prize, defender promotes, then the turn passes", async () => {
    const t = setupRoom(actor, {
      attacker: inPlay(JOLTEON, "atk"),
      defender: inPlay(RATTATA, "def"), // 30 HP: only Quick Attack with heads knocks it out
      defenderBench: [inPlay(chansey, "def-bench")],
      coins: ["heads"],
    });
    const result = await t.attack({ attackIndex: 0 });
    expect(result.success).toBe(true);
    expect(t.get<PokemonInPlay | null>(t.f.theirActive)).toBeNull();
    expect(t.get<boolean>(t.f.myCanTakePrize)).toBe(true);
    expect(t.get<boolean>(t.f.theirNeedsToPromote)).toBe(true);
    expect(t.isActorTurn()).toBe(true); // waits for the prize and the promotion

    const handBefore = t.get<GameCard[]>(t.f.myHand).length;
    const prize = await t.manager.executeAction(t.room.id, t.actorSocket, { type: "takePrize", payload: { prizeIndex: 0 } });
    expect(prize.success).toBe(true);
    expect(t.get<GameCard[]>(t.f.myPrizes)).toHaveLength(5);
    expect(t.get<GameCard[]>(t.f.myHand).length).toBe(handBefore + 1);

    const promote = await t.manager.executeAction(t.room.id, t.otherSocket, { type: "promote", payload: { benchIndex: 0 } });
    expect(promote.success).toBe(true);
    expect(t.get<PokemonInPlay>(t.f.theirActive).pokemon.id).toBe("def-bench");
    expect(t.isActorTurn()).toBe(false);
    expect(t.room.gameState!.gamePhase).toBe("PLAYING");
  });

  it("no KO on tails: Quick Attack 10 leaves Rattata in play", async () => {
    const t = setupRoom(actor, { attacker: inPlay(JOLTEON, "atk"), defender: inPlay(RATTATA, "def"), coins: ["tails"] });
    expect((await t.attack({ attackIndex: 0 })).success).toBe(true);
    expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(10);
    expect(t.get<boolean>(t.f.myCanTakePrize)).toBe(false);
  });

  it("Metronome copying Pin Missile flips its 4 coins", async () => {
    const t = setupRoom(actor, {
      attacker: inPlay(CLEFAIRY, "atk"),
      defender: inPlay(JOLTEON, "def"),
      coins: ["heads", "heads", "tails", "tails"],
    });
    const result = await t.attack({ attackIndex: 1, metronomeAttack: { name: "Misil Aguja", index: 1 } });
    expect(result.success).toBe(true);
    expect(result.coinFlipInfo).toEqual({ attackName: "Misil Aguja", results: ["heads", "heads", "tails", "tails"] });
    expect(t.coins.remaining()).toBe(0);
    expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(40);
    expect(t.isActorTurn()).toBe(false);
  });

  it("Metronome is rejected on an attack that can't copy", async () => {
    const t = setupRoom(actor, { attacker: inPlay(CLEFAIRY, "atk"), defender: inPlay(JOLTEON, "def"), coins: [] });
    const result = await t.attack({ attackIndex: 0, metronomeAttack: { name: "Misil Aguja", index: 1 } });
    expect(result.success).toBe(false);
    expect(t.get<PokemonInPlay>(t.f.theirActive).currentDamage).toBe(0);
    expect(t.isActorTurn()).toBe(true);
  });
});
