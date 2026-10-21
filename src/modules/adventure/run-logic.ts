/**
 * Adventure run rules (design §2, §5.3), pure: no DB, no clock, no Math.random. Every function
 * takes a run and returns a new one; actions outside their phase throw RunPhaseError (409), rule
 * violations RunRuleError (422).
 */
import { isBasicEnergy, isEnergyCard, isPokemonCard, validateDeckEntries } from "@gonzaloaguila/game-core";
import { adventureCardProblem, cardOf, isBasicPokemonCard } from "./content/cards.js";
import type { AdventureStarter, AdventureTreasure, Difficulty } from "./content/schema.js";
import type { Adventure } from "./content/validate.js";
import type { AdventureGameConfig, CardEntry } from "./engine-types.js";
import { seededRandom } from "./rng.js";
import {
  RunPhaseError,
  RunRuleError,
  type AchievementFacts,
  type DeckEdit,
  type RunEvent,
  type RunState,
  type TreasureChoice,
} from "./run-logic.types.js";

/** Treasures offered after a victory (fewer when the pool has fewer candidates). */
export const OFFER_SIZE = 3;


function lastBattle(adventure: Adventure): number {
  return Math.max(...adventure.battles.map((b) => b.index));
}

function battleAt(adventure: Adventure, index: number) {
  const battle = adventure.battles.find((b) => b.index === index);
  if (!battle) throw new RunRuleError(`La batalla ${index} no existe`);
  return battle;
}

function starterOf(adventure: Adventure, starterId: string): AdventureStarter {
  const starter = adventure.starters.find((s) => s.id === starterId);
  if (!starter) throw new RunRuleError("Inicial desconocido");
  return starter;
}

function assertPhase(run: RunState, phases: RunState["phase"][], message: string) {
  if (run.status !== "active" || !phases.includes(run.phase)) throw new RunPhaseError(message);
}

/** Add entries to a deck, merging lines of the same card (new cards at the end). */
function addCards(deck: readonly CardEntry[], entries: readonly CardEntry[]): CardEntry[] {
  const out = deck.map((e) => ({ ...e }));
  for (const entry of entries) {
    const line = out.find((e) => e.cardId === entry.cardId);
    if (line) line.qty += entry.qty;
    else out.push({ ...entry });
  }
  return out;
}

/**
 * Why a run deck breaks the adventure's rules, or null: game-core's `validateDeckEntries` (size
 * within min/max, copies by name when `rules.maxCopies` is a number, basic Energy unlimited),
 * plus at least one Basic Pokémon (a deck without one could never start).
 */
export function deckProblem(deck: readonly CardEntry[], adventure: Adventure): string | null {
  const { minDeckSize, maxDeckSize, maxCopies } = adventure.rules;
  const problem = validateDeckEntries(deck, { minSize: minDeckSize, maxSize: maxDeckSize, maxCopies });
  if (problem) return problem;
  if (!deck.some((e) => isBasicPokemonCard(cardOf(e.cardId)))) return "El mazo necesita al menos un Pokémon básico";
  return null;
}

export function newRun(
  adventure: Adventure,
  options: { difficulty: Difficulty; starterId: string; seed: string },
): RunState {
  const starter = starterOf(adventure, options.starterId);
  return {
    adventureId: adventure.id,
    adventureVersion: adventure.version,
    difficulty: options.difficulty,
    starterId: starter.id,
    status: "active",
    phase: "pre_battle",
    currentBattle: 1,
    attempt: 1,
    hearts: adventure.rules.hearts,
    maxHearts: adventure.rules.hearts,
    heartsLost: 0,
    deck: addCards([], starter.deck),
    passives: [],
    treasuresTaken: [],
    treasuresSkipped: 0,
    pendingOffer: [],
    offTypeUsed: false,
    seed: options.seed,
  };
}

/** Removals are final; basic Energy of any type is set to the given counts. Only in pre_battle. */
export function editDeck(run: RunState, adventure: Adventure, edit: DeckEdit): RunState {
  assertPhase(run, ["pre_battle"], "Solo puedes editar el mazo antes de una batalla");
  let deck = run.deck.map((e) => ({ ...e }));

  for (const removal of edit.remove) {
    const line = deck.find((e) => e.cardId === removal.cardId);
    if (!line || line.qty < removal.qty) {
      throw new RunRuleError(`No tienes ${removal.qty} ${line ? cardOf(removal.cardId).name : removal.cardId} en el mazo`);
    }
    line.qty -= removal.qty;
  }

  for (const energy of edit.energies) {
    const problem = adventureCardProblem(energy.cardId);
    if (problem) throw new RunRuleError(`Carta inválida: ${problem}`);
    const card = cardOf(energy.cardId);
    if (!isBasicEnergy(card)) throw new RunRuleError(`Solo puedes sumar energías básicas (${card.name} no lo es)`);
    deck = deck.filter((e) => e.cardId !== energy.cardId);
    if (energy.qty > 0) deck.push({ cardId: energy.cardId, qty: energy.qty });
  }

  deck = deck.filter((e) => e.qty > 0);
  const problem = deckProblem(deck, adventure);
  if (problem) throw new RunRuleError(problem);
  return { ...run, deck };
}

/** A treasure's cards with the `starter.*` tokens resolved to the starter's line. */
export function resolveTreasureCards(treasure: AdventureTreasure, starter: AdventureStarter): CardEntry[] {
  if (treasure.kind !== "cards") return [];
  return treasure.cards.map((c) => {
    if ("cardId" in c) return { cardId: c.cardId, qty: c.qty };
    const stage = c.ref.slice("starter.".length) as keyof AdventureStarter["line"];
    return { cardId: starter.line[stage], qty: c.qty };
  });
}

function treasureById(adventure: Adventure, id: string): AdventureTreasure {
  const treasure = adventure.treasures.find((t) => t.id === id);
  if (!treasure) throw new RunRuleError(`Tesoro desconocido: ${id}`);
  return treasure;
}

/** Whether taking a card treasure keeps the deck within the rules (max size, copies). */
function cardsFit(run: RunState, adventure: Adventure, treasure: AdventureTreasure): boolean {
  if (treasure.kind !== "cards") return true;
  const deck = addCards(run.deck, resolveTreasureCards(treasure, starterOf(adventure, run.starterId)));
  return deckProblem(deck, adventure) === null;
}

/**
 * Treasures that can be offered after `battleIndex`: the battle's pool minus passives the run
 * already has and card treasures that would break the deck rules (over the max size; no copy
 * limit in adventure mode).
 */
export function offerCandidates(run: RunState, adventure: Adventure, battleIndex: number): string[] {
  const pool = battleAt(adventure, battleIndex).treasurePool;
  if (!pool) return [];
  return adventure.treasurePools[pool].filter((id) => {
    const treasure = treasureById(adventure, id);
    if (treasure.kind === "passive") return !run.passives.includes(treasure.passive);
    return cardsFit(run, adventure, treasure);
  });
}

/**
 * The candidates in a random order weighted by rarity (`treasureOffer.rarityWeights`): weighted
 * sampling without replacement (Efraimidis–Spirakis: key = -ln(u) / weight, smallest first),
 * driven by `rng` in pool order so the same seed always gives the same order.
 */
function weightedOrder(ids: readonly string[], adventure: Adventure, rng: () => number): string[] {
  const weights = adventure.treasureOffer.rarityWeights;
  return ids
    .map((id) => ({ id, key: -Math.log(1 - rng()) / weights[treasureById(adventure, id).rarity] }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.id);
}

/**
 * Up to 3 distinct candidates, always the same for the same run seed and battle (the offer is
 * stored in `pendingOffer`, so reloading never rerolls it). Drawn by rarity weight, with:
 * at most `treasureOffer.maxPassives` passives; at least one card treasure whenever a candidate
 * has one; treasures the run hasn't taken yet first (a card treasure already taken only fills a
 * slot nothing else can).
 */
export function generateOffer(run: RunState, adventure: Adventure, battleIndex: number): string[] {
  const candidates = offerCandidates(run, adventure, battleIndex);
  const rng = seededRandom(`${run.seed}:${battleIndex}`);
  const taken = new Set(run.treasuresTaken);
  const ordered = weightedOrder(candidates, adventure, rng);
  const queue = [...ordered.filter((id) => !taken.has(id)), ...ordered.filter((id) => taken.has(id))];
  const isPassive = (id: string) => treasureById(adventure, id).kind === "passive";
  const { maxPassives } = adventure.treasureOffer;

  const offer: string[] = [];
  let passives = 0;
  for (const [i, id] of queue.entries()) {
    if (offer.length === OFFER_SIZE) break;
    if (isPassive(id)) {
      if (passives >= maxPassives) continue;
      // Keep the last slot for a card treasure if the offer has none yet and one is left
      const lastSlot = offer.length === OFFER_SIZE - 1;
      if (lastSlot && offer.every(isPassive) && queue.slice(i + 1).some((other) => !isPassive(other))) continue;
      passives++;
    }
    offer.push(id);
  }
  return offer;
}

/** Victory → take one of the offered treasures, or skip; then the next battle. */
export function chooseTreasure(run: RunState, adventure: Adventure, choice: TreasureChoice): RunState {
  assertPhase(run, ["choosing_treasure"], "No hay un tesoro para elegir ahora");
  const next: RunState = {
    ...run,
    phase: "pre_battle",
    currentBattle: run.currentBattle + 1,
    attempt: 1,
    pendingOffer: [],
  };
  if ("skip" in choice) return { ...next, treasuresSkipped: run.treasuresSkipped + 1 };

  if (!run.pendingOffer.includes(choice.treasureId)) throw new RunRuleError("Ese tesoro no está en la oferta");
  const treasure = treasureById(adventure, choice.treasureId);
  next.treasuresTaken = [...run.treasuresTaken, treasure.id];
  if (treasure.kind === "cards") {
    if (!cardsFit(run, adventure, treasure)) throw new RunRuleError("Ese tesoro no entra en tu mazo");
    next.deck = addCards(run.deck, resolveTreasureCards(treasure, starterOf(adventure, run.starterId)));
  } else {
    next.passives = [...run.passives, treasure.passive];
    if (treasure.passive === "extra_heart") {
      next.hearts = run.hearts + 1;
      next.maxHearts = run.maxHearts + 1;
    }
  }
  return next;
}

/**
 * Whether a deck has a card off the starter's type: a Pokémon with a type other than the
 * starter's or Colorless, or an Energy that isn't the starter's type (Double Colorless counts as
 * Colorless). Trainers never count.
 */
export function isOffType(deck: readonly CardEntry[], starter: AdventureStarter): boolean {
  const allowed = new Set<string>([starter.energyType, "colorless"]);
  return deck.some(({ cardId }) => {
    const card = cardOf(cardId);
    if (isPokemonCard(card)) return card.types.some((type) => !allowed.has(type));
    if (isEnergyCard(card)) return !allowed.has(card.energyType);
    return false;
  });
}

/** pre_battle → in_battle (the room is created by the caller); records an off-type deck. */
export function startBattle(run: RunState, adventure: Adventure): RunState {
  assertPhase(run, ["pre_battle"], "Solo puedes empezar una batalla desde el mapa");
  const problem = deckProblem(run.deck, adventure);
  if (problem) throw new RunRuleError(problem);
  return markOffType({ ...run, phase: "in_battle" }, adventure);
}

/** Monotype achievement: once a battle starts with an off-type deck, the run is marked for good. */
export function markOffType(run: RunState, adventure: Adventure): RunState {
  if (run.offTypeUsed || !isOffType(run.deck, starterOf(adventure, run.starterId))) return run;
  return { ...run, offTypeUsed: true };
}

/** The end of the current battle, decided by the server's room (never by the client). */
export function applyBattleResult(
  run: RunState,
  adventure: Adventure,
  result: { victory: boolean },
): { run: RunState; events: RunEvent[] } {
  assertPhase(run, ["in_battle"], "No hay una batalla en curso");

  if (result.victory) {
    if (run.currentBattle >= lastBattle(adventure)) {
      return { run: { ...run, status: "won", phase: "finished", pendingOffer: [] }, events: [{ type: "runWon" }] };
    }
    const offer = generateOffer(run, adventure, run.currentBattle);
    if (offer.length === 0) {
      // Nothing to offer (no pool, or every candidate excluded): straight to the next battle
      return {
        run: { ...run, phase: "pre_battle", currentBattle: run.currentBattle + 1, attempt: 1, pendingOffer: [] },
        events: [],
      };
    }
    return { run: { ...run, phase: "choosing_treasure", pendingOffer: offer }, events: [{ type: "offer", offer }] };
  }

  const hearts = run.hearts - 1;
  const lost: RunState = { ...run, hearts, heartsLost: run.heartsLost + 1 };
  if (hearts > 0) {
    return { run: { ...lost, phase: "pre_battle", attempt: run.attempt + 1 }, events: [{ type: "heartLost", hearts }] };
  }
  return { run: { ...lost, status: "lost", phase: "finished" }, events: [{ type: "heartLost", hearts }, { type: "runLost" }] };
}

/** Abandon from the map or the treasure screen (inside a battle: surrender first). */
export function abandonRun(run: RunState): RunState {
  assertPhase(run, ["pre_battle", "choosing_treasure"], "Ríndete en la batalla antes de abandonar la aventura");
  return { ...run, status: "abandoned", phase: "finished", pendingOffer: [] };
}

/** The rival deck of a battle for this run (battle 10: by difficulty, hard by starter). */
export function rivalDeckFor(adventure: Adventure, battleIndex: number, difficulty: Difficulty, starterId: string): CardEntry[] {
  const { opponent } = battleAt(adventure, battleIndex);
  if (opponent.deck) return opponent.deck;
  const byDifficulty = opponent.deckByDifficulty!;
  if (difficulty === "normal") return byDifficulty.normal;
  const deck = byDifficulty.hard.byStarter[starterId];
  if (!deck) throw new RunRuleError(`No hay mazo difícil para ${starterId}`);
  return deck;
}

/** What `createAdventureGame` needs for the run's current battle. */
export function battleConfig(run: RunState, adventure: Adventure): AdventureGameConfig {
  const battle = battleAt(adventure, run.currentBattle);
  return {
    playerDeck: run.deck.map((e) => ({ ...e })),
    opponentDeck: rivalDeckFor(adventure, battle.index, run.difficulty, run.starterId).map((e) => ({ ...e })),
    prizeCount: adventure.rules.prizeCount,
    openingHand: adventure.rules.openingHand,
    playerPassives: [...run.passives],
    modifiers: battle.modifiers.map((m) => structuredClone(m)),
  };
}

/** Facts the "adventure" achievements read from a finished run. */
export function achievementFacts(run: RunState): AchievementFacts {
  return {
    won: run.status === "won",
    difficulty: run.difficulty,
    starterId: run.starterId,
    flawless: run.heartsLost === 0,
    purist: run.treasuresTaken.length === 0,
    monotype: !run.offTypeUsed,
  };
}
