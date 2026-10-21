/**
 * Adventure battle rooms on game-core's real adventure engine (createAdventureGame, the AI
 * driver, seeded RNG, lucky coin, battle modifiers) over real sockets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import type { GameState } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import * as adventure from "../src/modules/adventure/adventure.service.js";
import { adventureRooms, roomManager } from "../src/socket/handlers.js";
import { setAdventureEngine } from "../src/socket/adventure-engine.js";
import { gameCoreAdventureEngine } from "../src/socket/adventure-engine-game-core.js";
import { createUser } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

const ADVENTURE = "pueblo-paleta-bosque-verde";
let server: Awaited<ReturnType<typeof startSocketServer>>;
let pacing: ReturnType<typeof adventureRooms.setPacing>;

beforeAll(async () => {
  setAdventureEngine(gameCoreAdventureEngine);
  // The AI keeps its step pauses but doesn't wait for coin animations (adventure-room.test.ts)
  pacing = adventureRooms.setPacing({ coinPauseScale: 0 });
  server = await startSocketServer();
});

afterAll(async () => {
  adventureRooms.setPacing(pacing);
  setAdventureEngine(null);
  await server.close();
  await prisma.$disconnect();
});

const room = (roomId: string) => roomManager.getRoom(roomId)!;
const state = (roomId: string) => room(roomId).gameState!;

async function battleFor(options: { battle?: number; seed?: string; passives?: string[]; deck?: { cardId: string; qty: number }[] } = {}) {
  const user = await createUser({}, { stats: true });
  const run = await adventure.createRun(user.id, { adventureId: ADVENTURE, difficulty: "normal", starterId: "charmander" });
  await prisma.adventureRun.update({
    where: { id: run.id },
    data: {
      ...(options.battle ? { currentBattle: options.battle } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
      ...(options.passives ? { passives: options.passives } : {}),
      ...(options.deck ? { deck: options.deck } : {}),
    },
  });
  const { roomId } = await adventure.startRunBattle(user.id, run.id);
  await adventureRooms.aiIdle(roomId);
  return { user, runId: run.id, roomId, token: tokenFor(user) };
}

async function join(token: string, roomId: string) {
  const socket = await server.connect(token);
  const client = { socket, coins: [] as { attackName: string; results: string[] }[], results: [] as any[] };
  socket.on("showCoinFlip", (p: { attackName: string; results: string[] }) => client.coins.push(p));
  socket.on("adventureBattleResult", (p: unknown) => client.results.push(p));
  const start = nextEvent<{ gameState: GameState; adventure: any }>(socket, "gameStart");
  socket.emit("joinRoom", { roomId });
  return { ...client, start: await start };
}

async function act(client: { socket: ClientSocket }, roomId: string, type: string, payload?: unknown) {
  const result = nextEvent<{ success: boolean; error?: string }>(client.socket, "actionResult");
  client.socket.emit("action", { roomId, action: { type, ...(payload !== undefined ? { payload } : {}) } });
  const res = await result;
  await adventureRooms.aiIdle(roomId);
  return res;
}

async function setUp(client: { socket: ClientSocket }, roomId: string) {
  for (let i = 0; i < 30; i++) {
    const basic = state(roomId).playerHand.find((c) => c.kind === "pokemon" && c.stage === "basic");
    if (basic) {
      expect((await act(client, roomId, "playBasicToActive", { cardId: basic.id })).success).toBe(true);
      break;
    }
    expect((await act(client, roomId, "mulligan")).success).toBe(true);
  }
  expect((await act(client, roomId, "playerReady")).success).toBe(true);
  expect(state(roomId).gamePhase).toBe("PLAYING");
}

/** A passive human: answers what it owes with the first option, otherwise ends its turns. */
async function passiveTurn(client: { socket: ClientSocket }, roomId: string) {
  const s = state(roomId);
  const choice = s.pendingAttackChoice;
  if (choice && (choice.step.chooser === "opponent") === !s.isPlayerTurn) {
    const first = choice.step.options[0];
    return act(client, roomId, "resolveAttackChoice", { selection: first && (choice.step.minSelections ?? 1) > 0 ? [first.id] : [] });
  }
  if (s.playerNeedsToPromote) return act(client, roomId, "promote", { benchIndex: 0 });
  if (s.playerCanTakePrize) return act(client, roomId, "takePrize", { prizeIndex: 0 });
  expect(s.isPlayerTurn).toBe(true);
  return act(client, roomId, "endTurn");
}

/** Everything that must replay identically (ids and log messages; not event ids / timestamps). */
function essence(s: GameState) {
  const ids = (cards: { id: string }[]) => cards.map((c) => c.id);
  return {
    phase: s.gamePhase,
    result: s.gameResult,
    turn: s.turnNumber,
    zones: [s.playerHand, s.playerDeck, s.playerPrizes, s.playerDiscard, s.opponentHand, s.opponentDeck, s.opponentPrizes, s.opponentDiscard].map(ids),
    active: [s.playerActivePokemon?.pokemon.id, s.playerActivePokemon?.currentDamage, s.opponentActivePokemon?.pokemon.id, s.opponentActivePokemon?.currentDamage],
    bench: [s.playerBench, s.opponentBench].map((bench) => bench.map((p) => p.pokemon.id)),
    log: s.events.map((e) => e.message),
  };
}

describe("adventure rooms on game-core's engine", () => {
  it("the AI's opening placements stay hidden until both are ready (its log lines are neutralized)", async () => {
    const { roomId, token } = await battleFor();
    const raw = state(roomId).events.map((e) => e.message);
    expect(raw.some((m) => /^Jugador 2 colocó .+ como Pokémon activo$/.test(m))).toBe(true);
    expect(raw.some((m) => /^Rival /.test(m))).toBe(false);
    const client = await join(token, roomId);
    const seen = client.start.gameState.events.map((e) => e.message);
    expect(seen).toContain("Jugador 2 colocó un Pokémon como Pokémon activo");
    const active = state(roomId).opponentActivePokemon!.pokemon.name;
    expect(seen.some((m) => m.includes(`colocó ${active}`))).toBe(false);
    client.socket.disconnect();
  });

  it("the Metapod battle starts with the preset board, 1 Prize each, and the bonus cards after setup", async () => {
    const { roomId, token } = await battleFor({ battle: 7 });
    const s = state(roomId);
    expect(s.opponentActivePokemon?.pokemon.name).toBe("Metapod");
    expect(s.opponentActivePokemon?.previousEvolutions?.map((c) => c.name)).toEqual(["Caterpie"]);
    expect(s.opponentBench.map((p) => p.pokemon.name)).toEqual(["Metapod", "Metapod"]);
    expect([s.playerPrizes.length, s.opponentPrizes.length]).toEqual([1, 1]);
    expect(s.playerHand.map((c) => c.name)).not.toContain("Pokémon Flute");

    const client = await join(token, roomId);
    expect(client.start.adventure.rules).toEqual([
      "Mesa a 1 premio por jugador",
      "Los Metapod del rival no dan premios",
      "El rival empieza con Metapod activo y 2 Metapod en la banca",
      "Empiezas con Pokémon Flute, Gust of Wind y PlusPower en la mano",
    ]);
    await setUp(client, roomId);
    const hand = state(roomId).playerHand.map((c) => c.name);
    for (const bonus of ["Pokémon Flute", "Gust of Wind", "PlusPower"]) expect(hand).toContain(bonus);
    client.socket.disconnect();
  }, 30_000);

  it("Knocking Out a Metapod gives no Prize; the AI promotes another", async () => {
    const { roomId, token } = await battleFor({ battle: 7 });
    const client = await join(token, roomId);
    await setUp(client, roomId);

    let knockedOut = false;
    for (let turn = 0; turn < 8 && !knockedOut && state(roomId).gamePhase === "PLAYING"; turn++) {
      if (!state(roomId).isPlayerTurn) { await passiveTurn(client, roomId); continue; }
      const s = state(roomId);
      const energy = s.playerHand.find((c) => c.kind === "energy");
      if (energy && s.playerActivePokemon!.attachedEnergy.length === 0) {
        await act(client, roomId, "attachEnergy", { cardId: energy.id, pokemonId: s.playerActivePokemon!.pokemon.id });
      }
      // One hit from a Knock Out: the Active Metapod (70 HP) at 60 damage, no protection
      const target = state(roomId).opponentActivePokemon!;
      expect(target.pokemon.name).toBe("Metapod");
      target.currentDamage = 60;
      delete target.protection;
      const prizesBefore = state(roomId).playerPrizes.length;
      const attack = await act(client, roomId, "attack", { attackIndex: 0 });
      if (!attack.success) { await act(client, roomId, "endTurn"); continue; }
      knockedOut = true;
      const after = state(roomId);
      expect(after.playerPrizes.length).toBe(prizesBefore);
      expect(after.playerCanTakePrize).toBe(false);
      expect(after.events.some((e) => e.message.includes("no da premio en esta mesa"))).toBe(true);
      expect(after.opponentDiscard.map((c) => c.name)).toEqual(expect.arrayContaining(["Metapod", "Caterpie"]));
      expect(after.gamePhase).toBe("PLAYING");
      expect(after.opponentActivePokemon?.pokemon.name).toBe("Metapod");
    }
    expect(knockedOut).toBe(true);
    client.socket.disconnect();
  }, 60_000);

  it("a battle against the real AI replays identically from the same seed, also restored mid-battle; its end is applied once", async () => {
    const seed = "0badc0de0badc0de0badc0de0badc0de";
    const play = async (evictAfter: number | null) => {
      const battle = await battleFor({ seed });
      let client = await join(battle.token, battle.roomId);
      await setUp(client, battle.roomId);
      for (let i = 0; i < 400 && state(battle.roomId).gamePhase !== "GAME_OVER"; i++) {
        if (i === evictAfter) {
          const before = essence(state(battle.roomId));
          client.socket.disconnect();
          await adventureRooms.evict(battle.roomId);
          client = await join(battle.token, battle.roomId);
          await adventureRooms.aiIdle(battle.roomId);
          expect(essence(state(battle.roomId))).toEqual({ ...before, log: before.log.slice(-200) });
        }
        const res = await passiveTurn(client, battle.roomId);
        expect(res.success, res.error).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { battle, client, final: essence(state(battle.roomId)) };
    };

    const a = await play(null);
    const b = await play(6);
    expect(a.final.phase).toBe("GAME_OVER");
    expect({ ...b.final, log: b.final.log.slice(-50) }).toEqual({ ...a.final, log: a.final.log.slice(-50) });
    // The AI played: its lines are in the log, neutralized (no second person left)
    expect(a.final.log.some((m) => m.includes("Jugador 2"))).toBe(true);

    for (const { battle, client } of [a, b]) {
      expect(client.results).toHaveLength(1);
      expect(client.results[0]).toMatchObject({ runId: battle.runId, victory: a.final.result === "victory" });
      await adventureRooms.finishBattle(battle.roomId, false);
      expect(await prisma.adventureBattleResult.count({ where: { runId: battle.runId } })).toBe(1);
      expect(await prisma.match.count({ where: { OR: [{ player1Id: battle.user.id }, { player2Id: battle.user.id }] } })).toBe(0);
      client.socket.disconnect();
    }
  }, 120_000);

  it("the lucky coin: the first coin of the player's own attack is heads, and only that one is forced", async () => {
    const deck = [{ cardId: "base-set-048-doduo", qty: 12 }, { cardId: "base-set-097-fighting-energy", qty: 12 }];
    const { roomId, token } = await battleFor({ passives: ["lucky_coin"], deck });
    const client = await join(token, roomId);
    await setUp(client, roomId);

    const ownCoins: string[][] = [];
    for (let turn = 0; turn < 12 && ownCoins.length < 2 && state(roomId).gamePhase === "PLAYING"; turn++) {
      if (!state(roomId).isPlayerTurn || state(roomId).playerNeedsToPromote || state(roomId).playerCanTakePrize) {
        await passiveTurn(client, roomId);
        continue;
      }
      const s = state(roomId);
      const energy = s.playerHand.find((c) => c.kind === "energy");
      if (energy && s.playerActivePokemon!.attachedEnergy.length === 0) {
        await act(client, roomId, "attachEnergy", { cardId: energy.id, pokemonId: s.playerActivePokemon!.pokemon.id });
      }
      const coin = nextEvent<{ results: string[] }>(client.socket, "showCoinFlip", 2000).catch(() => null);
      const attack = await act(client, roomId, "attack", { attackIndex: 0 });
      if (attack.success) {
        const flipped = await coin;
        if (flipped) ownCoins.push(flipped.results);
        if (state(roomId).isPlayerTurn && state(roomId).gamePhase === "PLAYING") await passiveTurn(client, roomId);
      } else {
        await act(client, roomId, "endTurn");
      }
    }
    expect(ownCoins.length).toBeGreaterThanOrEqual(1);
    expect(ownCoins[0][0]).toBe("heads");
    const s = state(roomId) as GameState & { passives?: { luckyCoinUsed?: { player?: boolean } } };
    expect(s.passives?.luckyCoinUsed?.player).toBe(true);
    expect(s.events.filter((e) => e.message === "Moneda de la suerte: la moneda sale cara")).toHaveLength(1);
    client.socket.disconnect();
  }, 60_000);
});
