/**
 * Gym Heroes over real sockets (production handlers): a mid-attack question asked to the
 * defending player (Flee) switches the clock to them (state.clock), the attacker's opponent hint
 * says the attack is paused, and when the answer clock runs out the server answers by default
 * and tells everyone (answerTimedOut + the new states, clock back to a turn clock).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { ALL_CARDS, GamePhase, toInPlayCard, type GameCard, type GameState, type PokemonInPlay } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { roomManager } from "../src/socket/handlers.js";
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

function card(name: string, set: string, id: string): GameCard {
  const found = ALL_CARDS.find((c) => c.name === name && c.set === set);
  if (!found) throw new Error(`${name} (${set}) not in catalog`);
  return { ...found, id } as GameCard;
}

function inPlay(c: GameCard, energy: GameCard[] = []): PokemonInPlay {
  return {
    pokemon: toInPlayCard(c),
    attachedEnergy: energy,
    attachedTrainers: [],
    previousEvolutions: [],
    currentDamage: 0,
    statusConditions: [],
    playedOnTurn: 0,
  } as unknown as PokemonInPlay;
}

/** Every payload of `event` on `socket`. */
function collect<T = any>(socket: ClientSocket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => seen.push(payload));
  return seen;
}

describe("the answer clock over sockets", () => {
  it("Flee: clock switches to the defender, opponentAction paused, default answer on timeout with answerTimedOut", async () => {
    const p1 = await createUser({}, { stats: true });
    const p2 = await createUser({}, { stats: true });
    const s1 = await server.connect(tokenFor(p1));
    const s2 = await server.connect(tokenFor(p2));
    s1.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 0, friendly: true });
    const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
    const started = nextEvent(s2, "gameStart");
    s2.emit("joinRoom", { roomId, deckId: "overgrowth" });
    await started;

    // Player 1 attacks a Misty's Tentacruel (Flee) with a Benched Pokémon behind it
    const room = roomManager.getRoom(roomId)!;
    const opening = room.gameState!;
    room.gameState = {
      ...opening,
      gamePhase: GamePhase.Playing,
      gameStarted: true,
      turnNumber: 3,
      isPlayerTurn: true,
      startingPlayer: "player",
      playerReady: true,
      opponentReady: true,
      playerHand: [],
      opponentHand: [],
      playerActivePokemon: inPlay(card("Pikachu", "Base Set", "p1-pikachu"), [card("Lightning Energy", "Base Set", "p1-l")]),
      playerBench: [],
      opponentActivePokemon: inPlay(card("Misty's Tentacruel", "Gym Heroes", "p2-tentacruel")),
      opponentBench: [inPlay(card("Bulbasaur", "Base Set", "p2-bulba"))],
      playerPrizes: opening.playerDeck.slice(0, 6),
      opponentPrizes: opening.opponentDeck.slice(0, 6),
      playerDeck: opening.playerDeck.slice(6, 30),
      opponentDeck: opening.opponentDeck.slice(6, 30),
    } as GameState;
    room.turnTimerDuration = 0.3;

    const states1 = collect<any>(s1, "gameState");
    const states2 = collect<any>(s2, "gameState");
    const hints2 = collect<any>(s2, "opponentAction");
    const timedOut1 = nextEvent<any>(s1, "answerTimedOut", 3000);
    const timedOut2 = nextEvent<any>(s2, "answerTimedOut", 3000);

    s1.emit("action", { roomId, action: { type: "attack", payload: { attackIndex: 0 } } });
    expect(await nextEvent<any>(s1, "actionResult")).toEqual({ success: true });
    expect(hints2[0]).toEqual({ type: "attack", paused: true });
    const paused2 = states2.at(-1)!.gameState;
    expect(paused2.pendingAttackChoice.reaction).toMatchObject({ answers: "flee" });
    expect(paused2.awaitingUserId).toBe(p2.id);
    expect(paused2.clock).toMatchObject({ kind: "answer", userId: p2.id, pausedUserId: p1.id, durationSeconds: 0.3 });
    expect(states1.at(-1)!.gameState.clock).toEqual(paused2.clock);
    expect(states1.at(-1)!.gameState.pendingAttackChoice).toMatchObject({ waiting: true });

    // Nobody answers: the server answers for player 2 (Flee not used) and everyone is told
    expect(await timedOut1).toEqual({ userId: p2.id, actionType: "resolveAttackChoice" });
    expect(await timedOut2).toEqual({ userId: p2.id, actionType: "resolveAttackChoice" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after1 = states1.at(-1)!.gameState;
    expect(after1.pendingAttackChoice).toBeUndefined();
    expect(after1.opponentActivePokemon.pokemon.id).toBe("p2-tentacruel");
    expect(after1.opponentActivePokemon.currentDamage).toBeGreaterThan(0);
    expect(after1.isPlayerTurn).toBe(false); // the attack happened and the turn passed
    expect(after1.clock).toMatchObject({ kind: "turn", userId: p2.id });
    expect(room.answerClock).toBeUndefined();
  });
});
