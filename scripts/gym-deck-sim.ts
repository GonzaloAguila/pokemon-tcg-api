/**
 * Gym Leader deck tuning (docs/gym-leaders.md "Deck tuning"): a leader's deck against every
 * game-core theme deck that passes the leader's type, owner and Stadium rules (v2.1; their Stadium
 * cards are swapped for basic Energy, the Trainer-count and copy rules are ignored for them), with
 * the gym's fixed Stadium (Pewter City Gym) in play from the start, smart AI vs smart AI, fixed
 * seeds, the leader on each side half the games. The v1 / v2 candidates (A … E17) were tuned
 * before v2.1 (no fixed Stadium, Grass / Water banned): kept to reproduce those numbers with
 * `--v1-field`.
 *
 *   npx tsx scripts/gym-deck-sim.ts                      # Brock's shipped normal deck, 100 games per pairing
 *   npx tsx scripts/gym-deck-sim.ts --games 200 --deck original
 *   npx tsx scripts/gym-deck-sim.ts --games 200 --deck shipped,expert   # both shipped decks (v2)
 *   npx tsx scripts/gym-deck-sim.ts --deck all           # every candidate below
 *
 * Games run through game-core's headless runner on createAdventureGame with no modifiers
 * (playAdventureAIGame: standard rules, 6 Prizes, 7-card hand) — the same game creation the gym
 * battle rooms use, the fixed Stadium added the same way (withFixedStadium: game-core's
 * createAdventureGame export is wrapped for the run) — with both seats played by the smart AI.
 */
import { createRequire } from "node:module";
import path from "node:path";
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
import { withFixedStadium } from "../src/modules/gym/fixed-stadium.js";
import { isBasicEnergy, isTrainerCard } from "@gonzaloaguila/game-core";

/** v2.1: the gym's Stadium in play in every simulated game (null with --v1-field). */
const V1_FIELD = process.argv.includes("--v1-field");
const FIXED_STADIUM = V1_FIELD ? undefined : BROCK.rules.normal.fixedStadiumId;
{
  // playAdventureAIGame calls the adventure module's createAdventureGame export: wrap it
  const nodeRequire = createRequire(path.resolve("package.json"));
  const gameModule = nodeRequire(path.join(path.dirname(nodeRequire.resolve("@gonzaloaguila/game-core")), "domain/adventure/game.js"));
  const original = gameModule.createAdventureGame;
  gameModule.createAdventureGame = (config: unknown) => withFixedStadium(original(config), FIXED_STADIUM, "sim");
}

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

/** The deck without those cards (copies: tweaking the result never changes `deck`). */
const without = (deck: CardEntry[], ids: string[]) => deck.filter((e) => !ids.includes(e.cardId)).map((e) => ({ ...e }));

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

// ---------------------------------------------------------------------------
// EXPERT (v2): stronger than the shipped normal deck (B12). The leader's deck follows no challenger
// rule (copies, composition), so it may run 3-4 copies of the denial Trainers.
// ---------------------------------------------------------------------------
const SER = "base-set-079-super-energy-removal";
const HITMONCHAN = "base-set-007-hitmonchan";
const SANDSHREW_LINE = ["gym-heroes-072-brocks-sandshrew", "gym-heroes-071-brocks-sandshrew", "gym-heroes-023-brocks-sandslash"];
/** E1: B12 with 2 more Super Energy Removal for the 2 Pewter City Gym. */
const E1 = swap(B12, "gym-heroes-115-pewter-city-gym", SER, 2);
/** E2: B12 with Hitmonchan ×4 and a 4th Rhyhorn #70 for the slow Sandshrew line. */
const E2: CardEntry[] = [...without(B12, SANDSHREW_LINE), { cardId: HITMONCHAN, qty: 4 }];
E2.find((e) => e.cardId === "gym-heroes-070-brocks-rhyhorn")!.qty += 1;
/** E3: E1 + E2. */
const E3 = swap(E2, "gym-heroes-115-pewter-city-gym", SER, 2);
/** E4: E3 with PlusPower for Brock. */
const E4 = swap(E3, "gym-heroes-015-brock", "base-set-084-pluspower", 2);
/** E5: E3 with a 2nd Professor Oak and a 3rd Gust of Wind for 2 Energy. */
const E5 = swap(swap(E3, FIGHTING, "base-set-088-professor-oak", 1), FIGHTING, "base-set-093-gust-of-wind", 1);
/** E6: hard hitters (Rhyhorn #70 / Rhydon, Hitmonchan, Onix, Diglett / Dugtrio) and heavy denial. */
const E6: CardEntry[] = [
  { cardId: "gym-heroes-070-brocks-rhyhorn", qty: 4 },
  { cardId: "gym-heroes-002-brocks-rhydon", qty: 3 },
  { cardId: HITMONCHAN, qty: 4 },
  { cardId: "gym-heroes-069-brocks-onix", qty: 2 },
  { cardId: "gym-challenge-067-brocks-diglett", qty: 3 },
  { cardId: "gym-challenge-022-brocks-dugtrio", qty: 2 },
  { cardId: "gym-heroes-041-brocks-lickitung", qty: 1 },
  { cardId: "base-set-092-energy-removal", qty: 4 },
  { cardId: SER, qty: 3 },
  { cardId: "base-set-093-gust-of-wind", qty: 2 },
  { cardId: "base-set-084-pluspower", qty: 3 },
  { cardId: "base-set-091-bill", qty: 2 },
  { cardId: "base-set-088-professor-oak", qty: 2 },
  { cardId: "gym-heroes-106-brocks-training-method", qty: 2 },
  { cardId: FIGHTING, qty: 23 },
];

const GOLEM = "gym-heroes-020-brocks-golem";
const GRAVELER = "gym-heroes-040-brocks-graveler";
const RHYHORN_70 = "gym-heroes-070-brocks-rhyhorn";
const RHYDON = "gym-heroes-002-brocks-rhydon";
const ONIX_69 = "gym-heroes-069-brocks-onix";
const ROCKETS_HITMONCHAN = "gym-heroes-011-rockets-hitmonchan";
/** E7: E3 with Rhydon and Onix for the 2 Golem, Rhyhorn #70 for a Graveler. */
const E7 = swap(swap(swap(E3, GOLEM, RHYDON, 1), GOLEM, ONIX_69, 1), GRAVELER, RHYHORN_70, 1);
/** E8: E3 with Professor Oak and Gust of Wind for 2 Brock's Training Method. */
const E8 = swap(swap(E3, "gym-heroes-106-brocks-training-method", "base-set-088-professor-oak", 1), "gym-heroes-106-brocks-training-method", "base-set-093-gust-of-wind", 1);
/** E9: E3 without the Golem line (Geodude #66, Graveler, Golem): Rocket's Hitmonchan ×3, more Rhyhorn / Rhydon / Onix, a Gust. */
const E9: CardEntry[] = [
  ...without(E3, ["gym-heroes-066-brocks-geodude", GRAVELER, GOLEM]),
  { cardId: ROCKETS_HITMONCHAN, qty: 3 },
];
E9.find((e) => e.cardId === RHYHORN_70)!.qty += 1;
E9.find((e) => e.cardId === RHYDON)!.qty += 1;
E9.find((e) => e.cardId === ONIX_69)!.qty += 1;
E9.find((e) => e.cardId === "base-set-093-gust-of-wind")!.qty += 1;
/** E10: E7 + E8. */
const E10 = swap(swap(E7, "gym-heroes-106-brocks-training-method", "base-set-088-professor-oak", 1), "gym-heroes-106-brocks-training-method", "base-set-093-gust-of-wind", 1);

const METHOD = "gym-heroes-106-brocks-training-method";
/** E11: E9 with Professor Oak and PlusPower for 2 Brock's Training Method (few evolutions left). */
const E11 = swap(swap(E9, METHOD, "base-set-088-professor-oak", 1), METHOD, "base-set-084-pluspower", 1);
/** E12: E9 with a 4th Onix and a 4th Rocket's Hitmonchan for the 2 Geodude #38. */
const E12 = swap(swap(E9, "gym-heroes-038-brocks-geodude", ONIX_69, 1), "gym-heroes-038-brocks-geodude", ROCKETS_HITMONCHAN, 1);
/** E13: E11 + E12. */
const E13 = swap(swap(E11, "gym-heroes-038-brocks-geodude", ONIX_69, 1), "gym-heroes-038-brocks-geodude", ROCKETS_HITMONCHAN, 1);
/** E14: E13 with 2 Double Colorless Energy for 2 Fighting. */
const E14 = swap(E13, FIGHTING, "base-set-096-double-colorless-energy", 2);

const DCE = "base-set-096-double-colorless-energy";
/** E15: E12 with 2 Double Colorless Energy for 2 Fighting. */
const E15 = swap(E12, FIGHTING, DCE, 2);
/** E16: E14 with 2 more Double Colorless Energy (4). */
const E16 = swap(E14, FIGHTING, DCE, 2);
/** E17: E14 with a 3rd Training Method back for the Lickitung. */
const E17 = swap(E14, "gym-heroes-041-brocks-lickitung", METHOD, 1);

// ---------------------------------------------------------------------------
// v2.1: no Stadium in either deck (Pewter City Gym is always in play), challengers without Grass /
// Psychic / Fighting Pokémon (Water and Lightning decks now play).
// ---------------------------------------------------------------------------
const PEWTER = "gym-heroes-115-pewter-city-gym";
/** N1: B12 (v2 normal) with 2 Fighting Energy for the 2 Pewter City Gym. */
const N1 = swap(B12, PEWTER, FIGHTING, 2);
/** N2: B12 with a Gust of Wind and a Super Energy Removal for the 2 Pewter City Gym. */
const N2 = swap(swap(B12, PEWTER, "base-set-093-gust-of-wind", 1), PEWTER, SER, 1);
/** N3: B12 with a Bill and a Professor Oak for the 2 Pewter City Gym. */
const N3 = swap(swap(B12, PEWTER, "base-set-091-bill", 1), PEWTER, "base-set-088-professor-oak", 1);

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
  E1,
  E2,
  E3,
  E4,
  E5,
  E6,
  E7,
  E8,
  E9,
  E10,
  E11,
  E12,
  E13,
  E14,
  E15,
  E16,
  E17,
  N1,
  N2,
  N3,
  shipped: BROCK.decks.normal,
  /** The shipped EXPERT deck (= E14). */
  expert: BROCK.decks.expert!,
};

function deckEntries(deck: Deck): CardEntry[] {
  return deck.cards.map((entry) => {
    const card = findCardDefinition(entry.set, entry.cardNumber);
    if (!card) throw new Error(`${deck.id}: card ${entry.set ?? "base-set"} #${entry.cardNumber} not found`);
    return { cardId: card.id, qty: entry.quantity };
  });
}

/** A theme deck's Stadium cards swapped for its most common basic Energy (v2.1: no Stadiums). */
function withoutStadiums(entries: CardEntry[]): CardEntry[] {
  const isStadium = (id: string) => {
    const card = findCardById(id);
    return !!card && isTrainerCard(card) && card.trainerType === "stadium";
  };
  const stadiums = entries.filter((e) => isStadium(e.cardId)).reduce((sum, e) => sum + e.qty, 0);
  if (stadiums === 0) return entries;
  const rest = entries.filter((e) => !isStadium(e.cardId)).map((e) => ({ ...e }));
  const energy = rest.filter((e) => isBasicEnergy(findCardById(e.cardId)!)).sort((a, b) => b.qty - a.qty)[0];
  energy.qty += stadiums;
  return rest;
}

/**
 * Theme decks (classic + Gym Leaders, not the leader's own) that pass the leader's type / owner
 * rules once their Stadiums are out (v2.1), or (--v1-field) the v1 / v2 rule (no Grass / Water
 * Pokémon or basic Energy) as tuned then.
 */
function opponents(): { id: string; entries: CardEntry[] }[] {
  const all = [...themeDecks, ...gymLeaderDecks].filter((deck) => deck.id !== "gym-heroes-brock").map((deck) => ({ id: deck.id, entries: deckEntries(deck) }));
  if (V1_FIELD) {
    const banned = ["grass", "water"];
    return all.filter((deck) =>
      deck.entries.every((e) => {
        const card = findCardById(e.cardId)!;
        if (card.kind === "pokemon") return !(card.types as string[]).some((t) => banned.includes(t));
        return !(card.kind === "energy" && isBasicEnergy(card) && banned.includes(card.energyType));
      }),
    );
  }
  const { bannedPokemonTypes, bannedOwners } = BROCK.rules.normal;
  return all
    .map((deck) => ({ id: deck.id, entries: withoutStadiums(deck.entries) }))
    .filter((deck) => gymRuleErrors(deck.entries, { bannedPokemonTypes, bannedOwners, noStadiums: true }).length === 0);
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
  console.log(`Opponents (${field.length}): ${field.map((o) => o.id).join(", ")}; fixed Stadium: ${FIXED_STADIUM ?? "none"}`);
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
