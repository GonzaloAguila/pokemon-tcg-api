/**
 * Gym Leader deck tuning (docs/gym-leaders.md "Deck tuning"): a leader's deck against every
 * game-core theme deck that passes the leader's banned-type rule (the composition rule is ignored
 * for the opponents), smart AI vs smart AI, fixed seeds, the leader on each side half the games.
 *
 *   npx tsx scripts/gym-deck-sim.ts                      # Brock's shipped normal deck, 100 games per pairing
 *   npx tsx scripts/gym-deck-sim.ts --games 200 --deck original
 *   npx tsx scripts/gym-deck-sim.ts --deck all           # every candidate below
 *
 * Games run through game-core's headless runner on createAdventureGame with no modifiers
 * (playAdventureAIGame: standard rules, 6 Prizes, 7-card hand) — the same game creation the gym
 * battle rooms use — with both seats played by the smart AI (policyPair("smart")).
 */
import {
  decks as themeDecks,
  findCardById,
  findCardDefinition,
  gymLeaderDecks,
  hashSeed,
  mulberry32,
  playAdventureAIGame,
  policyPair,
  type CardEntry,
  type Deck,
} from "@gonzaloaguila/game-core";
import { BROCK } from "../src/modules/gym/content/brock.js";
import { gymRuleErrors } from "../src/modules/gym/rules.js";

/** The deck game-core ships as the Gym Heroes Brock theme deck (the starting point). */
const ORIGINAL: CardEntry[] = [
  { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 2 },
  { cardId: "gym-heroes-022-brocks-rhyhorn", qty: 1 },
  { cardId: "gym-heroes-002-brocks-rhydon", qty: 2 },
  { cardId: "gym-heroes-038-brocks-geodude", qty: 2 },
  { cardId: "gym-heroes-066-brocks-geodude", qty: 2 },
  { cardId: "gym-heroes-040-brocks-graveler", qty: 3 },
  { cardId: "gym-heroes-020-brocks-golem", qty: 2 },
  { cardId: "gym-heroes-069-brocks-onix", qty: 2 },
  { cardId: "gym-heroes-072-brocks-sandshrew", qty: 2 },
  { cardId: "gym-heroes-071-brocks-sandshrew", qty: 1 },
  { cardId: "gym-heroes-023-brocks-sandslash", qty: 2 },
  { cardId: "gym-heroes-041-brocks-lickitung", qty: 1 },
  { cardId: "gym-heroes-015-brock", qty: 2 },
  { cardId: "gym-heroes-115-pewter-city-gym", qty: 2 },
  { cardId: "gym-heroes-106-brocks-training-method", qty: 3 },
  { cardId: "gym-heroes-111-good-manners", qty: 2 },
  { cardId: "gym-heroes-118-secret-mission", qty: 1 },
  { cardId: "gym-heroes-116-recall", qty: 1 },
  { cardId: "gym-heroes-019-the-rockets-trap", qty: 1 },
  { cardId: "base-set-097-fighting-energy", qty: 26 },
];

const without = (deck: CardEntry[], ids: string[]) => deck.filter((e) => !ids.includes(e.cardId));

/** B: the original Pokémon; weak Trainers and 4 Energy out, Trainers the smart AI plays well in. */
const TRAINERS_B: CardEntry[] = [
  { cardId: "gym-heroes-015-brock", qty: 2 },
  { cardId: "gym-heroes-115-pewter-city-gym", qty: 2 },
  { cardId: "gym-heroes-106-brocks-training-method", qty: 3 },
  { cardId: "base-set-084-pluspower", qty: 3 },
  { cardId: "base-set-093-gust-of-wind", qty: 2 },
  { cardId: "base-set-091-bill", qty: 2 },
  { cardId: "base-set-092-energy-removal", qty: 2 },
];
const POKEMON_ORIGINAL = ORIGINAL.filter((e) => findCardById(e.cardId)?.kind === "pokemon");
const B: CardEntry[] = [...POKEMON_ORIGINAL, ...TRAINERS_B, { cardId: "base-set-097-fighting-energy", qty: 22 }];

/** C: B with the slow Sandshrew line swapped for Gym Challenge's Diglett / Dugtrio and 4 Rhyhorn #70. */
const C: CardEntry[] = [
  ...without(POKEMON_ORIGINAL, [
    "gym-heroes-072-brocks-sandshrew",
    "gym-heroes-071-brocks-sandshrew",
    "gym-heroes-023-brocks-sandslash",
    "gym-heroes-070-brocks-rhyhorn",
    "gym-heroes-022-brocks-rhyhorn",
  ]),
  { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 4 },
  { cardId: "gym-challenge-067-brocks-diglett", qty: 3 },
  { cardId: "gym-challenge-022-brocks-dugtrio", qty: 2 },
  ...TRAINERS_B,
  { cardId: "base-set-097-fighting-energy", qty: 21 },
];

/** A: hard hitters only (Rhyhorn #70 / Rhydon, Onix, Diglett / Dugtrio, Mankey / Primeape). */
const A: CardEntry[] = [
  { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 4 },
  { cardId: "gym-heroes-002-brocks-rhydon", qty: 3 },
  { cardId: "gym-heroes-069-brocks-onix", qty: 3 },
  { cardId: "gym-challenge-067-brocks-diglett", qty: 3 },
  { cardId: "gym-challenge-022-brocks-dugtrio", qty: 2 },
  { cardId: "gym-heroes-068-brocks-mankey", qty: 2 },
  { cardId: "gym-challenge-035-brocks-primeape", qty: 2 },
  { cardId: "gym-heroes-038-brocks-geodude", qty: 2 },
  { cardId: "gym-heroes-041-brocks-lickitung", qty: 1 },
  { cardId: "gym-heroes-106-brocks-training-method", qty: 3 },
  { cardId: "gym-heroes-115-pewter-city-gym", qty: 2 },
  { cardId: "base-set-084-pluspower", qty: 3 },
  { cardId: "base-set-093-gust-of-wind", qty: 2 },
  { cardId: "base-set-091-bill", qty: 2 },
  { cardId: "base-set-092-energy-removal", qty: 2 },
  { cardId: "base-set-097-fighting-energy", qty: 24 },
];

/** Replace `qty` copies of `from` with `to` (same count), or add `to` when `from` is null. */
function swap(deck: CardEntry[], from: string | null, to: string, qty: number): CardEntry[] {
  const out = deck.map((e) => ({ ...e }));
  if (from) {
    const entry = out.find((e) => e.cardId === from);
    if (!entry || entry.qty < qty) throw new Error(`swap: not enough ${from}`);
    entry.qty -= qty;
  }
  const target = out.find((e) => e.cardId === to);
  if (target) target.qty += qty;
  else out.push({ cardId: to, qty });
  return out.filter((e) => e.qty > 0);
}

const FIGHTING = "base-set-097-fighting-energy";
/** B2: Brock's Protection (Gym Challenge) instead of Brock: Energy Removal can't touch that Pokémon. */
const B2 = swap(B, "gym-heroes-015-brock", "gym-challenge-101-brocks-protection", 2);
/** B3: B with the bigger Basics (3 Rhyhorn #70 instead of #22, a 3rd Onix #69 instead of Lickitung). */
const B3 = swap(swap(B, "gym-heroes-022-brocks-rhyhorn", "gym-heroes-070-brocks-rhyhorn", 1), "gym-heroes-041-brocks-lickitung", "gym-heroes-069-brocks-onix", 1);
/** B4: B2 with a Super Energy Removal for an Energy. */
const B4 = swap(B2, FIGHTING, "base-set-079-super-energy-removal", 1);
/** B5: B with a 3rd Energy Removal for a PlusPower. */
const B5 = swap(B, "base-set-084-pluspower", "base-set-092-energy-removal", 1);

/** B6: B5 with a 4th Energy Removal for another PlusPower. */
const B6 = swap(B5, "base-set-084-pluspower", "base-set-092-energy-removal", 1);
/** B7: B5 with B3's bigger Basics. */
const B7 = swap(swap(B5, "gym-heroes-022-brocks-rhyhorn", "gym-heroes-070-brocks-rhyhorn", 1), "gym-heroes-041-brocks-lickitung", "gym-heroes-069-brocks-onix", 1);
/** B8: B5 with a Super Energy Removal for an Energy. */
const B8 = swap(B5, FIGHTING, "base-set-079-super-energy-removal", 1);
/** B9: B5 with a Professor Oak for an Energy. */
const B9 = swap(B5, FIGHTING, "base-set-088-professor-oak", 1);

/** B10: B6 with a Professor Oak for an Energy. */
const B10 = swap(B6, FIGHTING, "base-set-088-professor-oak", 1);
/** B11: B6 with a Super Energy Removal for an Energy. */
const B11 = swap(B6, FIGHTING, "base-set-079-super-energy-removal", 1);

/** B12 (shipped 2026-10-23): B11 with a Professor Oak for an Energy (20 Energy). */
const B12 = swap(B11, FIGHTING, "base-set-088-professor-oak", 1);

/** Candidate decks tried while tuning (kept so the numbers can be reproduced). */
const CANDIDATES: Record<string, CardEntry[]> = {
  original: ORIGINAL,
  A,
  B,
  C,
  B2,
  B3,
  B4,
  B5,
  B6,
  B7,
  B8,
  B9,
  B10,
  B11,
  B12,
  shipped: BROCK.decks.normal,
};

function deckEntries(deck: Deck): CardEntry[] {
  return deck.cards.map((entry) => {
    const card = findCardDefinition(entry.set, entry.cardNumber);
    if (!card) throw new Error(`${deck.id}: card ${entry.set ?? "base-set"} #${entry.cardNumber} not found`);
    return { cardId: card.id, qty: entry.quantity };
  });
}

/** Theme decks (classic + Gym Leaders, not the leader's own) that pass the banned-type rule. */
function opponents(): { id: string; entries: CardEntry[] }[] {
  return [...themeDecks, ...gymLeaderDecks]
    .filter((deck) => deck.id !== "gym-heroes-brock")
    .map((deck) => ({ id: deck.id, entries: deckEntries(deck) }))
    .filter((deck) => gymRuleErrors(deck.entries, { bannedTypes: BROCK.rules.bannedTypes }).length === 0);
}

interface PairingResult {
  opponent: string;
  wins: number;
  losses: number;
  draws: number;
  failures: number;
  turns: number;
}

function playPairing(leaderDeck: CardEntry[], opponent: { id: string; entries: CardEntry[] }, games: number): PairingResult {
  const result: PairingResult = { opponent: opponent.id, wins: 0, losses: 0, draws: 0, failures: 0, turns: 0 };
  for (let i = 0; i < games; i++) {
    const leaderIsA = i % 2 === 0;
    const [policyA, policyB] = policyPair("smart");
    const config = {
      playerDeck: (leaderIsA ? leaderDeck : opponent.entries).map((e) => ({ ...e })),
      opponentDeck: (leaderIsA ? opponent.entries : leaderDeck).map((e) => ({ ...e })),
      prizeCount: 6,
      openingHand: 7,
      playerPassives: [],
      modifiers: [],
    };
    try {
      const outcome = playAdventureAIGame(config, { rng: mulberry32(hashSeed(`gym:${opponent.id}:${i}`)), policyA, policyB, maxTurns: 300 });
      result.turns += outcome.turns;
      if (outcome.winner === null) result.draws += 1;
      else if ((outcome.winner === "A") === leaderIsA) result.wins += 1;
      else result.losses += 1;
    } catch (error) {
      result.failures += 1;
      if (result.failures <= 2) console.error(`  [${opponent.id} #${i}] ${(error as Error).message}`);
    }
  }
  return result;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function run(): void {
  const games = Number(arg("games", "100"));
  const which = arg("deck", "shipped");
  const names = which === "all" ? Object.keys(CANDIDATES) : which.split(",");
  const field = opponents();
  console.log(`Opponents (${field.length}): ${field.map((o) => o.id).join(", ")}`);
  for (const name of names) {
    const deck = CANDIDATES[name];
    if (!deck) throw new Error(`Unknown deck "${name}" (${Object.keys(CANDIDATES).join(", ")})`);
    const total = deck.reduce((sum, e) => sum + e.qty, 0);
    if (total !== 60) throw new Error(`Deck "${name}" has ${total} cards`);
    const started = Date.now();
    const rows = field.map((opponent) => playPairing(deck, opponent, games));
    const sum = rows.reduce((acc, r) => ({ wins: acc.wins + r.wins, played: acc.played + r.wins + r.losses + r.draws }), { wins: 0, played: 0 });
    console.log(`\n== ${name} (${games} games per pairing, ${((Date.now() - started) / 1000).toFixed(0)} s) ==`);
    console.log("| Opponent | W | L | D | Fail | Win % | Avg turns |");
    console.log("|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const played = r.wins + r.losses + r.draws;
      console.log(`| ${r.opponent} | ${r.wins} | ${r.losses} | ${r.draws} | ${r.failures} | ${((100 * r.wins) / Math.max(1, played)).toFixed(0)}% | ${(r.turns / Math.max(1, played)).toFixed(1)} |`);
    }
    console.log(`| **Overall** | ${sum.wins} | | | | **${((100 * sum.wins) / Math.max(1, sum.played)).toFixed(1)}%** | |`);
  }
}

if (process.argv.includes("--print")) console.log(JSON.stringify(CANDIDATES[arg("deck", "shipped")], null, 1));
else run();
