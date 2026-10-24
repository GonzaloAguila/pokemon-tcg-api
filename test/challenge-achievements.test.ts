/**
 * Challenge achievements (modules/achievements/challenges.ts): computed from the user's settled
 * multiplayer games (decks as played, end kind, feats). Only counted normal/draft standard games
 * with the player's own deck, and — except Golpe brutal — played wins (prizes, no Pokémon, deck out).
 */
import { afterAll, describe, expect, it } from "vitest";
import { ALL_CARDS } from "@gonzaloaguila/game-core";
import { prisma } from "../src/lib/prisma.js";
import { CHALLENGE_DEFS, challengeProgress, loadChallengeGames, type ChallengeGame, type ChallengeId } from "../src/modules/achievements/challenges.js";
import { checkAndUpdateProgress, listAchievements } from "../src/modules/achievements/achievements.service.js";
import type { DeckEntry, DeckSource } from "../src/modules/achievements/challenge-decks.js";
import type { SeatFeats } from "../src/socket/challenge-tracker.js";
import { createUser } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

function id(name: string, setId: string): string {
  const card = ALL_CARDS.find((c) => c.name === name && c.id.startsWith(`${setId}-`));
  if (!card) throw new Error(`no ${name} in ${setId}`);
  return card.id;
}
const e = (name: string, setId: string, qty = 1): DeckEntry => ({ cardId: id(name, setId), qty });
const energy = (type: string, qty = 10): DeckEntry => ({ cardId: id(`${type} Energy`, "base-set"), qty });

const NO_FEATS: SeatFeats = { maxPrizeDeficit: 0, benchUsed: true, maxAttackDamage: 0, prizesTakenByRival: 2, finalKoBy: null };
/** A Water deck with an evolution line, a Trainer and a rare: matches none of the deck challenges. */
const PLAIN: DeckEntry[] = [e("Squirtle", "base-set", 4), e("Wartortle", "base-set", 3), e("Blastoise", "base-set", 1), e("Bill", "base-set", 2), e("Charmander", "base-set", 2), energy("Water", 8), energy("Fire", 4)];

function game(over: { cards?: DeckEntry[]; source?: DeckSource; feats?: Partial<SeatFeats> } & Partial<Omit<ChallengeGame, "deck" | "feats">> = {}): ChallengeGame {
  const { cards = PLAIN, source = "user", feats = {}, ...rest } = over;
  return { won: true, endKind: "prizes", finalTurn: 20, deck: { source, cards }, feats: { ...NO_FEATS, ...feats }, ...rest };
}
const progress = (challenge: ChallengeId, ...games: ChallengeGame[]) => challengeProgress(challenge, games);

describe("challenge definitions", () => {
  it("are the 20 of the design, with their targets", () => {
    expect(CHALLENGE_DEFS).toHaveLength(20);
    const targets = Object.fromEntries(CHALLENGE_DEFS.map((d) => [d.id, d.progressTarget]));
    expect(targets).toMatchObject({ "challenge-purist": 6, "challenge-gym-tour": 8, "challenge-two-colors": 5, "challenge-forgotten": 5, "challenge-blitz": 1 });
    expect(CHALLENGE_DEFS.find((d) => d.id === "challenge-no-trainers")).toMatchObject({ name: "Sin ayuda", description: "Gana con un deck sin Entrenadores", tier: "gold" });
  });
});

describe("challenge progress", () => {
  it("deck challenges count a played win with a matching deck", () => {
    expect(progress("challenge-no-trainers", game({ cards: [e("Squirtle", "base-set", 4), energy("Water")] }))).toBe(1);
    expect(progress("challenge-no-trainers", game())).toBe(0);
    expect(progress("challenge-monotype", game({ cards: [e("Squirtle", "base-set", 4), energy("Water")] }))).toBe(1);
    expect(progress("challenge-basics-only", game({ cards: [e("Squirtle", "base-set", 4), e("Bill", "base-set"), energy("Water")] }))).toBe(1);
    expect(progress("challenge-budget", game({ cards: [e("Squirtle", "base-set", 4), e("Wartortle", "base-set"), energy("Water")] }))).toBe(1);
    expect(progress("challenge-dark-side", game({ cards: [e("Charmander", "team-rocket", 4), e("Dark Charmeleon", "team-rocket", 2), energy("Fire")] }))).toBe(1);
    expect(progress("challenge-rainbow", game({ cards: [e("Charmander", "base-set"), e("Squirtle", "base-set"), e("Paras", "jungle"), e("Pikachu", "base-set"), energy("Fire")] }))).toBe(1);
    expect(progress("challenge-set-salad", game({ cards: [e("Squirtle", "base-set"), e("Paras", "jungle"), e("Psyduck", "fossil"), e("Dark Charmeleon", "team-rocket")] }))).toBe(1);
    expect(progress("challenge-leader-duo", game({ cards: [e("Brock's Geodude", "gym-heroes", 4), e("Misty's Psyduck", "gym-heroes", 4)] }))).toBe(1);
    expect(progress("challenge-leader-duo", game({ cards: [e("Brock's Geodude", "gym-heroes", 4), e("Misty's Psyduck", "gym-heroes", 3)] }))).toBe(0);
  });

  it("a forfeit win, a loss or a draw counts for nothing", () => {
    const noTrainers = [e("Squirtle", "base-set", 4), energy("Water")];
    expect(progress("challenge-no-trainers", game({ cards: noTrainers, endKind: "forfeit" }))).toBe(0);
    expect(progress("challenge-no-trainers", game({ cards: noTrainers, won: false }))).toBe(0);
    expect(progress("challenge-no-trainers", game({ cards: noTrainers, won: false, endKind: "draw" }))).toBe(0);
    expect(progress("challenge-blitz", game({ finalTurn: 2, endKind: "forfeit" }))).toBe(0);
    expect(progress("challenge-shutout", game({ endKind: "forfeit", feats: { prizesTakenByRival: 0 } }))).toBe(0);
  });

  it("theme and fallback decks count for nothing", () => {
    const noTrainers = [e("Squirtle", "base-set", 4), energy("Water")];
    expect(progress("challenge-no-trainers", game({ cards: noTrainers, source: "theme" }))).toBe(0);
    expect(progress("challenge-no-trainers", game({ cards: noTrainers, source: "fallback" }))).toBe(0);
    expect(progress("challenge-no-trainers", game({ cards: noTrainers, source: "draft" }))).toBe(1);
  });

  it("Purista counts distinct sets", () => {
    const jungle = game({ cards: [e("Paras", "jungle", 4), energy("Grass")] });
    const fossil = game({ cards: [e("Psyduck", "fossil", 4), energy("Water")] });
    expect(progress("challenge-purist", jungle, jungle)).toBe(1);
    expect(progress("challenge-purist", jungle, fossil)).toBe(2);
  });

  it("Gira de gimnasios counts distinct Leaders with 4+ Pokémon", () => {
    const brockMisty = game({ cards: [e("Brock's Geodude", "gym-heroes", 4), e("Misty's Psyduck", "gym-heroes", 4)] });
    const erika = game({ cards: [e("Erika's Oddish", "gym-heroes", 4)] });
    expect(progress("challenge-gym-tour", brockMisty, erika, brockMisty)).toBe(3);
  });

  it("Bicolor counts distinct pairs, in any order", () => {
    const wl = game({ cards: [energy("Water"), energy("Lightning")] });
    const lw = game({ cards: [energy("Lightning"), energy("Water")] });
    const wf = game({ cards: [energy("Water"), energy("Fire")] });
    const mono = game({ cards: [energy("Water")] });
    expect(progress("challenge-two-colors", wl, lw, mono)).toBe(1);
    expect(progress("challenge-two-colors", wl, wf)).toBe(2);
  });

  it("forgotten heroes: the winning KO's Pokémon, Leaders' versions included", () => {
    expect(progress("challenge-parasect", game({ feats: { finalKoBy: "Parasect" } }))).toBe(1);
    expect(progress("challenge-magikarp", game({ feats: { finalKoBy: "Misty's Magikarp" } }))).toBe(1);
    expect(progress("challenge-magikarp", game({ feats: { finalKoBy: "Gyarados" } }))).toBe(0);
    const ko = (name: string) => game({ feats: { finalKoBy: name } });
    expect(progress("challenge-forgotten", ko("Parasect"), ko("Magikarp"), ko("Giovanni's Magikarp"), ko("Farfetch'd"), ko("Pikachu"))).toBe(3);
  });

  it("feats: comeback, shutout, blitz, lone wolf, deck out", () => {
    expect(progress("challenge-comeback", game({ feats: { maxPrizeDeficit: 4 } }))).toBe(1);
    expect(progress("challenge-comeback", game({ feats: { maxPrizeDeficit: 3 } }))).toBe(0);
    expect(progress("challenge-shutout", game({ feats: { prizesTakenByRival: 0 } }))).toBe(1);
    expect(progress("challenge-blitz", game({ finalTurn: 7 }))).toBe(1);
    expect(progress("challenge-blitz", game({ finalTurn: 8 }))).toBe(0);
    expect(progress("challenge-lone-wolf", game({ endKind: "no_pokemon", feats: { benchUsed: false } }))).toBe(1);
    expect(progress("challenge-deck-out", game({ endKind: "deck_out" }))).toBe(1);
    expect(progress("challenge-deck-out", game({ endKind: "prizes" }))).toBe(0);
  });

  it("Golpe brutal also counts a lost game", () => {
    expect(progress("challenge-big-hit", game({ won: false, endKind: "prizes", feats: { maxAttackDamage: 120 } }))).toBe(1);
    expect(progress("challenge-big-hit", game({ feats: { maxAttackDamage: 90 } }))).toBe(0);
    expect(progress("challenge-big-hit", game({ source: "theme", feats: { maxAttackDamage: 120 } }))).toBe(0);
  });
});

describe("challenge achievements in the catalog", () => {
  it("checkAndUpdateProgress progresses a challenge from a settled row and ignores legacy rows", async () => {
    const me = await createUser({}, { stats: true });
    const rival = await createUser({}, { stats: true });
    const now = new Date();
    const feats = { player1: { ...NO_FEATS, prizesTakenByRival: 0 }, player2: NO_FEATS };
    await prisma.match.createMany({
      data: [
        {
          status: "finished", mode: "normal", gameMode: "standard", counted: true, player1Id: me.id, player2Id: rival.id, winnerId: me.id,
          settledAt: now, finishedAt: now, finalTurn: 15, endKind: "prizes", feats,
          player1Deck: { source: "user", cards: [e("Squirtle", "base-set", 4), energy("Water", 56)] },
          player2Deck: { source: "user", cards: PLAIN },
        },
        // Before the challenges: no deck, no end kind
        { status: "finished", mode: "normal", counted: true, player1Id: me.id, player2Id: rival.id, winnerId: me.id, settledAt: now, finishedAt: now },
      ],
    });
    // Other triggers (a pack, a check-in, a vs-AI game) leave the challenges alone: only a
    // settlement or the explicit check reads the match rows
    await checkAndUpdateProgress(me.id);
    expect(await prisma.userAchievement.count({ where: { userId: me.id, achievementId: { startsWith: "challenge-" } } })).toBe(0);
    await checkAndUpdateProgress(me.id, { challenges: true });
    const rows = await prisma.userAchievement.findMany({ where: { userId: me.id, achievementId: { startsWith: "challenge-" } } });
    const byId = Object.fromEntries(rows.map((r) => [r.achievementId, r.progress]));
    expect(byId).toMatchObject({ "challenge-no-trainers": 1, "challenge-monotype": 1, "challenge-basics-only": 1, "challenge-shutout": 1, "challenge-budget": 1, "challenge-blitz": 0 });
    // The rival lost: nothing but Golpe brutal could move
    await checkAndUpdateProgress(rival.id, { challenges: true });
    expect(await prisma.userAchievement.count({ where: { userId: rival.id, achievementId: { startsWith: "challenge-" }, progress: { gt: 0 } } })).toBe(0);
  });

  it("finished Gym Leader games count too (counted: false, player 2 = the leader); abandoned ones and legacy gym rows don't", async () => {
    const me = await createUser({}, { stats: true });
    const now = new Date();
    const noTrainers = { source: "user", cards: [e("Squirtle", "base-set", 4), energy("Water", 56)] };
    const leaderDeck = { source: "theme", cards: PLAIN };
    const gymRow = { mode: "gym", gameMode: "standard", counted: false, player1Id: me.id, player2Id: null, settledAt: now, finishedAt: now, gym: { leaderId: "brock" } };
    await prisma.match.createMany({
      data: [
        // A played win with a no-Trainer deck, a shutout
        { ...gymRow, status: "finished", winnerId: me.id, endKind: "deck_out", finalTurn: 9, player1Deck: noTrainers, player2Deck: leaderDeck, feats: { player1: { ...NO_FEATS, prizesTakenByRival: 0 }, player2: NO_FEATS } },
        // The leader won (Golpe brutal still counts the hit)
        { ...gymRow, status: "finished", winnerId: null, endKind: "prizes", finalTurn: 4, player1Deck: noTrainers, player2Deck: leaderDeck, feats: { player1: { ...NO_FEATS, maxAttackDamage: 120 }, player2: NO_FEATS } },
        // Abandoned (disconnect / error / admin): never
        { ...gymRow, status: "abandoned", winnerId: null, endKind: "forfeit", finalTurn: 2, player1Deck: noTrainers, player2Deck: leaderDeck, feats: { player1: { ...NO_FEATS, maxAttackDamage: 200 }, player2: NO_FEATS } },
        // Before the gym games kept their challenge data
        { ...gymRow, status: "finished", winnerId: me.id, finalTurn: 3 },
      ],
    });
    const games = await loadChallengeGames(me.id);
    expect(games.map((g) => ({ won: g.won, endKind: g.endKind, finalTurn: g.finalTurn }))).toEqual(
      expect.arrayContaining([
        { won: true, endKind: "deck_out", finalTurn: 9 },
        { won: false, endKind: "prizes", finalTurn: 4 },
      ]),
    );
    expect(games).toHaveLength(2);

    await checkAndUpdateProgress(me.id, { challenges: true });
    const rows = await prisma.userAchievement.findMany({ where: { userId: me.id, achievementId: { startsWith: "challenge-" } } });
    const byId = Object.fromEntries(rows.map((r) => [r.achievementId, r.progress]));
    expect(byId).toMatchObject({ "challenge-no-trainers": 1, "challenge-deck-out": 1, "challenge-shutout": 1, "challenge-big-hit": 1, "challenge-blitz": 0 });
  });

  it("the Próximamente achievements are gone and the challenges don't raise Leyenda Viviente's target", async () => {
    const me = await createUser({}, { stats: true });
    const list = await listAchievements(me.id);
    expect(list.some((a) => a.status === "unavailable")).toBe(false);
    expect(list.some((a) => a.id === "bronze-3")).toBe(false);
    expect(list.filter((a) => a.id.startsWith("challenge-"))).toHaveLength(20);
    expect(list.find((a) => a.id === "legend-50")?.progressTarget).toBe(26);
  });
});
