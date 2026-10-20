/**
 * Gym Challenge over real sockets (production handlers): Koga's Ninja Trick is asked to the
 * defending player before any showCoinFlip (answer clock), the coins come with the answer; a
 * Secret Plan face-down card never reaches the opponent in any event until it is flipped.
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

function inPlay(c: GameCard, energy: GameCard[] = [], trainers: GameCard[] = []): PokemonInPlay {
  return {
    pokemon: toInPlayCard(c),
    attachedEnergy: energy,
    attachedTrainers: trainers,
    previousEvolutions: [],
    currentDamage: 0,
    statusConditions: [],
    playedOnTurn: 0,
  } as unknown as PokemonInPlay;
}

/** Two players seated at a table; the game is replaced by `board` (player 1's perspective, their turn). */
async function startTable(board: Partial<GameState>) {
  const p1 = await createUser({}, { stats: true });
  const p2 = await createUser({}, { stats: true });
  const s1 = await server.connect(tokenFor(p1));
  const s2 = await server.connect(tokenFor(p2));
  s1.emit("createRoom", { deckId: "brushfire", prizeCount: 6, betAmount: 0, friendly: true });
  const { roomId } = await nextEvent<{ roomId: string }>(s1, "roomCreated");
  const started = nextEvent(s2, "gameStart");
  s2.emit("joinRoom", { roomId, deckId: "overgrowth" });
  await started;
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
    playerBench: [],
    opponentBench: [],
    playerPrizes: opening.playerDeck.slice(0, 6),
    opponentPrizes: opening.opponentDeck.slice(0, 6),
    playerDeck: opening.playerDeck.slice(6, 30),
    opponentDeck: opening.opponentDeck.slice(6, 30),
    ...board,
  } as GameState;
  const act = async (socket: ClientSocket, type: string, payload: unknown) => {
    const done = nextEvent<any>(socket, "actionResult");
    socket.emit("action", { roomId, action: { type, payload } });
    return done;
  };
  return { p1, p2, s1, s2, roomId, room, act };
}

/** Every event `socket` receives from now on. */
function record(socket: ClientSocket): { event: string; args: any[] }[] {
  const seen: { event: string; args: any[] }[] = [];
  socket.onAny((event: string, ...args: any[]) => seen.push({ event, args }));
  return seen;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("Gym Challenge over sockets", () => {
  it("Ninja Trick: asked to the defender before any showCoinFlip; the attack's coins come with the answer", async () => {
    const t = await startTable({
      playerActivePokemon: inPlay(card("Pikachu", "Base Set", "p1-pika"), [card("Lightning Energy", "Base Set", "p1-l1"), card("Lightning Energy", "Base Set", "p1-l2")]),
      opponentActivePokemon: inPlay(card("Koga's Ekans", "Gym Challenge", "p2-ekans"), [], [card("Koga's Ninja Trick", "Gym Challenge", "p2-ninja")]),
      opponentBench: [inPlay(card("Koga's Grimer", "Gym Challenge", "p2-grimer"))],
    });
    const seen1 = record(t.s1);
    const seen2 = record(t.s2);

    expect(await t.act(t.s1, "attack", { attackIndex: 1 })).toEqual({ success: true });
    await settle();
    expect([...seen1, ...seen2].some((e) => e.event === "showCoinFlip")).toBe(false);
    const asked = seen2.filter((e) => e.event === "gameState").at(-1)!.args[0].gameState;
    expect(asked.pendingAttackChoice.reaction).toMatchObject({ answers: "preAttack" });
    expect(asked.pendingAttackChoice.step.options.map((o: { id: string }) => o.id)).toEqual(["p2-grimer"]);
    expect(asked.clock).toMatchObject({ kind: "answer", userId: t.p2.id });
    expect(seen1.filter((e) => e.event === "gameState").at(-1)!.args[0].gameState.pendingAttackChoice).toMatchObject({ waiting: true });

    const coins1 = nextEvent<any>(t.s1, "showCoinFlip");
    const coins2 = nextEvent<any>(t.s2, "showCoinFlip");
    expect(await t.act(t.s2, "resolveAttackChoice", { selection: ["p2-grimer"] })).toEqual({ success: true });
    expect((await coins1).results).toHaveLength(1);
    expect((await coins2).results).toHaveLength(1);
    await settle();
    expect(t.room.gameState!.opponentActivePokemon?.pokemon.id).toBe("p2-grimer");
  });

  it("Secret Plan: no event to the opponent names the face-down card until it is flipped", async () => {
    const t = await startTable({
      playerActivePokemon: inPlay(card("Pikachu", "Base Set", "p1-pika")),
      opponentActivePokemon: inPlay(card("Bulbasaur", "Base Set", "p2-bulba")),
      playerHand: [card("Lt. Surge's Secret Plan", "Gym Challenge", "p1-plan"), card("Sabrina's Gastly", "Gym Challenge", "p1-gastly")],
    });
    const seen2 = record(t.s2);
    expect(await t.act(t.s1, "playTrainer", { cardId: "p1-plan", selections: [["p1-gastly"]] })).toEqual({ success: true });
    await settle();
    expect(JSON.stringify(seen2)).not.toMatch(/Sabrina's Gastly|p1-gastly/);
    const placeholderId = t.room.gameState!.playerBench[0].pokemon.id;
    expect(await t.act(t.s1, "flipFaceDown", { pokemonId: placeholderId })).toEqual({ success: true });
    await settle();
    const last = seen2.filter((e) => e.event === "gameState").at(-1)!.args[0].gameState;
    expect(last.opponentBench[0].pokemon.name).toBe("Sabrina's Gastly");
  });
});
