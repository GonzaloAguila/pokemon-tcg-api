/**
 * Challenge achievements (frontend repo docs/superpowers/specs/2026-10-23-challenge-achievements-design.md):
 * advanced goals for multiplayer games, computed from the user's settled match rows — both decks
 * as played, how the game ended and what each seat did (socket/challenge-tracker.ts).
 *
 * A game qualifies when it is the user's counted normal or draft game, standard rules (no Lucky
 * Duel), played with their own deck (source "user" or "draft": not a theme deck nor the fallback),
 * and has its challenge data (games from before the challenges don't). Every challenge but Golpe
 * brutal needs a PLAYED WIN: the user won by Prizes, by leaving the rival without Pokémon or by
 * the rival's deck running out — never by a surrender, a disconnect, a clock or a no-show.
 * They don't count for "Leyenda Viviente" (achievements.service.ts countsForMeta).
 */
import { prisma } from "../../lib/prisma.js";
import type { EndKind, SeatFeats } from "../../socket/challenge-tracker.js";
import {
  baseName,
  basicEnergyTypes,
  isBasicsOnly,
  isBudget,
  isDarkEvolutions,
  isMonotype,
  isNoTrainers,
  leadersWithAtLeast,
  pokemonTypeCount,
  setCount,
  singleSetOf,
  type DeckSnapshot,
} from "./challenge-decks.js";

/** One of the user's multiplayer games, from their seat. */
export interface ChallengeGame {
  won: boolean;
  endKind: EndKind;
  deck: DeckSnapshot;
  feats: SeatFeats;
  finalTurn: number;
}

export type ChallengeId =
  | "challenge-no-trainers"
  | "challenge-monotype"
  | "challenge-basics-only"
  | "challenge-budget"
  | "challenge-purist"
  | "challenge-dark-side"
  | "challenge-leader-duo"
  | "challenge-gym-tour"
  | "challenge-two-colors"
  | "challenge-rainbow"
  | "challenge-set-salad"
  | "challenge-parasect"
  | "challenge-magikarp"
  | "challenge-forgotten"
  | "challenge-comeback"
  | "challenge-shutout"
  | "challenge-blitz"
  | "challenge-lone-wolf"
  | "challenge-big-hit"
  | "challenge-deck-out";

export interface ChallengeDef {
  id: ChallengeId;
  name: string;
  description: string;
  tier: "silver" | "gold" | "platinum";
  progressTarget: number;
}

export const CHALLENGE_DEFS: ChallengeDef[] = [
  // Deck challenges
  { id: "challenge-no-trainers", name: "Sin ayuda", description: "Gana con un deck sin Entrenadores", tier: "gold", progressTarget: 1 },
  { id: "challenge-monotype", name: "Monotipo", description: "Gana con un deck de un solo tipo", tier: "silver", progressTarget: 1 },
  { id: "challenge-basics-only", name: "Sin evolucionar", description: "Gana con un deck de solo Pokémon Básicos", tier: "silver", progressTarget: 1 },
  { id: "challenge-budget", name: "Presupuesto", description: "Gana con un deck sin cartas raras", tier: "silver", progressTarget: 1 },
  { id: "challenge-purist", name: "Purista", description: "Gana con un deck de un solo set, en los 6 sets", tier: "platinum", progressTarget: 6 },
  { id: "challenge-dark-side", name: "Lado oscuro", description: "Gana con un deck donde todas las evoluciones sean Dark", tier: "gold", progressTarget: 1 },
  // Mixes
  { id: "challenge-leader-duo", name: "Dúo de líderes", description: "Gana con Pokémon de dos Líderes de Gimnasio", tier: "silver", progressTarget: 1 },
  { id: "challenge-gym-tour", name: "Gira de gimnasios", description: "Gana con Pokémon de cada Líder de Gimnasio", tier: "platinum", progressTarget: 8 },
  { id: "challenge-two-colors", name: "Bicolor", description: "Gana con 5 combinaciones de dos tipos", tier: "gold", progressTarget: 5 },
  { id: "challenge-rainbow", name: "Arcoíris", description: "Gana con Pokémon de 4 tipos distintos", tier: "silver", progressTarget: 1 },
  { id: "challenge-set-salad", name: "Ensalada de sets", description: "Gana con cartas de 4 sets distintos", tier: "silver", progressTarget: 1 },
  // Forgotten heroes
  { id: "challenge-parasect", name: "Hongo letal", description: "Gana dando el último KO con Parasect", tier: "gold", progressTarget: 1 },
  { id: "challenge-magikarp", name: "El que ríe último", description: "Gana dando el último KO con Magikarp", tier: "gold", progressTarget: 1 },
  { id: "challenge-forgotten", name: "Colección de olvidados", description: "Gana dando el último KO con 5 Pokémon olvidados distintos", tier: "platinum", progressTarget: 5 },
  // Feats
  { id: "challenge-comeback", name: "Remontada", description: "Gana estando 4 premios abajo", tier: "gold", progressTarget: 1 },
  { id: "challenge-shutout", name: "Paliza", description: "Gana sin que el rival tome premios", tier: "silver", progressTarget: 1 },
  { id: "challenge-blitz", name: "Relámpago", description: "Gana antes del turno 8", tier: "silver", progressTarget: 1 },
  { id: "challenge-lone-wolf", name: "Lobo solitario", description: "Gana sin poner nunca un Pokémon en la Banca", tier: "gold", progressTarget: 1 },
  { id: "challenge-big-hit", name: "Golpe brutal", description: "Haz 100 o más de daño en un solo ataque", tier: "silver", progressTarget: 1 },
  { id: "challenge-deck-out", name: "Sin mazo", description: "Gana porque al rival se le acabaron las cartas", tier: "silver", progressTarget: 1 },
];

/** Base names whose winning Knock Out counts for "Colección de olvidados" (Leaders' versions too). */
export const FORGOTTEN_POKEMON: readonly string[] = [
  "Parasect", "Magikarp", "Farfetch'd", "Dodrio", "Seaking", "Metapod", "Kakuna",
  "Caterpie", "Weedle", "Slowpoke", "Psyduck", "Lickitung", "Spearow", "Raticate",
];

const PLAYED_WIN_ENDS: readonly EndKind[] = ["prizes", "no_pokemon", "deck_out"];
const LEADER_MIN_POKEMON = 4;

const qualifies = (game: ChallengeGame) => game.deck.source === "user" || game.deck.source === "draft";
const isPlayedWin = (game: ChallengeGame) => qualifies(game) && game.won && PLAYED_WIN_ENDS.includes(game.endKind);
const distinct = (values: (string | null)[]) => new Set(values.filter((v): v is string => v !== null)).size;
const anyWin = (games: ChallengeGame[], test: (game: ChallengeGame) => boolean) => (games.some((g) => isPlayedWin(g) && test(g)) ? 1 : 0);
const finalKoName = (game: ChallengeGame) => (game.feats.finalKoBy ? baseName(game.feats.finalKoBy) : null);

/** The user's progress on `id` over their games (uncapped; the caller caps it at the target). */
export function challengeProgress(id: ChallengeId, games: ChallengeGame[]): number {
  const wins = games.filter(isPlayedWin);
  switch (id) {
    case "challenge-no-trainers":
      return anyWin(games, (g) => isNoTrainers(g.deck.cards));
    case "challenge-monotype":
      return anyWin(games, (g) => isMonotype(g.deck.cards));
    case "challenge-basics-only":
      return anyWin(games, (g) => isBasicsOnly(g.deck.cards));
    case "challenge-budget":
      return anyWin(games, (g) => isBudget(g.deck.cards));
    case "challenge-purist":
      return distinct(wins.map((g) => singleSetOf(g.deck.cards)));
    case "challenge-dark-side":
      return anyWin(games, (g) => isDarkEvolutions(g.deck.cards));
    case "challenge-leader-duo":
      return anyWin(games, (g) => leadersWithAtLeast(g.deck.cards, LEADER_MIN_POKEMON).length >= 2);
    case "challenge-gym-tour":
      return new Set(wins.flatMap((g) => leadersWithAtLeast(g.deck.cards, LEADER_MIN_POKEMON))).size;
    case "challenge-two-colors":
      return distinct(wins.map((g) => {
        const types = basicEnergyTypes(g.deck.cards);
        return types.length === 2 ? types.join("+") : null;
      }));
    case "challenge-rainbow":
      return anyWin(games, (g) => pokemonTypeCount(g.deck.cards) >= 4);
    case "challenge-set-salad":
      return anyWin(games, (g) => setCount(g.deck.cards) >= 4);
    case "challenge-parasect":
      return anyWin(games, (g) => finalKoName(g) === "Parasect");
    case "challenge-magikarp":
      return anyWin(games, (g) => finalKoName(g) === "Magikarp");
    case "challenge-forgotten":
      return distinct(wins.map((g) => {
        const name = finalKoName(g);
        return name && FORGOTTEN_POKEMON.includes(name) ? name : null;
      }));
    case "challenge-comeback":
      return anyWin(games, (g) => g.feats.maxPrizeDeficit >= 4);
    case "challenge-shutout":
      return anyWin(games, (g) => g.feats.prizesTakenByRival === 0);
    case "challenge-blitz":
      return anyWin(games, (g) => g.finalTurn <= 7);
    case "challenge-lone-wolf":
      return anyWin(games, (g) => !g.feats.benchUsed);
    case "challenge-big-hit":
      return games.some((g) => qualifies(g) && g.feats.maxAttackDamage >= 100) ? 1 : 0;
    case "challenge-deck-out":
      return anyWin(games, (g) => g.endKind === "deck_out");
  }
}

/** The user's qualifying games: counted normal / draft standard games with their challenge data. */
export async function loadChallengeGames(userId: string): Promise<ChallengeGame[]> {
  const rows = await prisma.match.findMany({
    where: {
      counted: true,
      mode: { in: ["normal", "draft"] },
      gameMode: "standard",
      settledAt: { not: null },
      endKind: { not: null },
      OR: [{ player1Id: userId }, { player2Id: userId }],
    },
    select: { player1Id: true, winnerId: true, endKind: true, finalTurn: true, player1Deck: true, player2Deck: true, feats: true },
  });
  return rows.flatMap((row) => {
    const seat = row.player1Id === userId ? "player1" : "player2";
    const deck = (seat === "player1" ? row.player1Deck : row.player2Deck) as DeckSnapshot | null;
    const feats = (row.feats as Record<string, SeatFeats> | null)?.[seat];
    if (!deck || !feats || !row.endKind) return [];
    return [{ won: row.winnerId === userId, endKind: row.endKind as EndKind, deck, feats, finalTurn: row.finalTurn ?? 0 }];
  });
}
