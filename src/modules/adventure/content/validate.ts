/**
 * Adventure content validator: the zod shape (schema.ts) plus every cross-check the shape can't
 * express (design §5.4). Problems are Spanish sentences, all reported at once.
 */
import { isLimitedInDeck, isPokemonCard, ALL_CARDS } from "@gonzaloaguila/game-core";
import type { CardEntry } from "../engine-types.js";
import { adventureCardProblem, cardOf, isBasicPokemonCard } from "./cards.js";
import { adventureSchema, type AdventureBattle, type AdventureContent } from "./schema.js";

export type Adventure = AdventureContent;
export type ValidationResult = { ok: true; adventure: Adventure } | { ok: false; problems: string[] };

export const BATTLE_COUNT = 10;
const POKEMON_NAMES = new Set(ALL_CARDS.filter(isPokemonCard).map((c) => c.name));

const deckSize = (deck: readonly CardEntry[]) => deck.reduce((n, e) => n + e.qty, 0);

/** Every rival deck of a battle with a label ("" for the only one). */
export function rivalDecks(battle: AdventureBattle): { label: string; deck: CardEntry[] }[] {
  const { deck, deckByDifficulty } = battle.opponent;
  if (deck) return [{ label: "", deck }];
  return [
    { label: " (normal)", deck: deckByDifficulty!.normal },
    ...Object.entries(deckByDifficulty!.hard.byStarter).map(([starter, d]) => ({ label: ` (difícil, ${starter})`, deck: d })),
  ];
}

function checkCards(problems: string[], where: string, ids: readonly string[]) {
  for (const id of ids) {
    const problem = adventureCardProblem(id);
    if (problem) problems.push(`${where}: ${problem}`);
  }
}

function checkDeck(
  problems: string[],
  where: string,
  deck: readonly CardEntry[],
  rules: Adventure["rules"],
  options: { maxCopies: number | null; needsBasic: boolean },
) {
  const before = problems.length;
  checkCards(problems, `${where}, mazo`, deck.map((e) => e.cardId));
  const size = deckSize(deck);
  if (size < rules.minDeckSize || size > rules.maxDeckSize) {
    problems.push(`${where}: el mazo tiene ${size} cartas (debe tener entre ${rules.minDeckSize} y ${rules.maxDeckSize})`);
  }
  if (problems.length > before) return;
  if (options.needsBasic && !deck.some((e) => isBasicPokemonCard(cardOf(e.cardId)))) {
    problems.push(`${where}: el mazo no tiene Pokémon básicos`);
  }
  if (options.maxCopies !== null) {
    const byName = new Map<string, number>();
    for (const entry of deck) {
      const card = cardOf(entry.cardId);
      if (isLimitedInDeck(card)) byName.set(card.name, (byName.get(card.name) ?? 0) + entry.qty);
    }
    for (const [name, copies] of byName) {
      if (copies > options.maxCopies) problems.push(`${where}: más de ${options.maxCopies} copias de ${name}`);
    }
  }
}

function checkEvolutionChain(problems: string[], where: string, chain: readonly string[]) {
  const before = problems.length;
  checkCards(problems, where, chain);
  if (problems.length > before) return;
  const cards = chain.map(cardOf);
  if (!isBasicPokemonCard(cards[0])) problems.push(`${where}: ${cards[0].name} no es un Pokémon básico`);
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];
    if (!isPokemonCard(card) || card.evolvesFrom !== cards[i - 1].name) {
      problems.push(`${where}: ${card.name} no evoluciona de ${cards[i - 1].name}`);
    }
  }
}

function checkBattle(problems: string[], adventure: Adventure, battle: AdventureBattle) {
  const where = `Batalla ${battle.index}`;
  const { rules } = adventure;
  const setup = battle.modifiers.find((m) => m.type === "opponentSetup");

  for (const { label, deck } of rivalDecks(battle)) {
    const before = problems.length;
    checkCards(problems, `${where}, mazo del rival${label}`, deck.map((e) => e.cardId));
    if (problems.length > before) continue;
    const size = deckSize(deck);
    if (size < rules.minDeckSize || size > rules.maxDeckSize) {
      problems.push(`${where}: el mazo del rival${label} tiene ${size} cartas (debe tener entre ${rules.minDeckSize} y ${rules.maxDeckSize})`);
    }
    if (!setup && !deck.some((e) => isBasicPokemonCard(cardOf(e.cardId)))) {
      problems.push(`${where}: el mazo del rival${label} no tiene Pokémon básicos`);
    }
  }

  const byStarter = battle.opponent.deckByDifficulty?.hard.byStarter;
  if (byStarter) {
    for (const starter of adventure.starters) {
      if (!byStarter[starter.id]) problems.push(`${where}: falta el mazo difícil para el inicial ${starter.id}`);
    }
    for (const key of Object.keys(byStarter)) {
      if (!adventure.starters.some((s) => s.id === key)) problems.push(`${where}: mazo difícil para un inicial desconocido ${key}`);
    }
  }

  if (battle.opponent.lead) {
    const problem = adventureCardProblem(battle.opponent.lead);
    if (problem) problems.push(`${where}, lead: ${problem}`);
    else if (!isPokemonCard(cardOf(battle.opponent.lead))) problems.push(`${where}, lead: no es un Pokémon`);
  }

  const seen = new Set<string>();
  for (const modifier of battle.modifiers) {
    // One modifier of each type per battle (bonusCards / noPrizeFor: one per side)
    const key = modifier.type === "bonusCards" || modifier.type === "noPrizeFor" ? `${modifier.type}:${modifier.side}` : modifier.type;
    if (seen.has(key)) problems.push(`${where}: modificador ${modifier.type} repetido`);
    seen.add(key);

    switch (modifier.type) {
      case "noPrizeFor":
        for (const name of modifier.names) {
          if (!POKEMON_NAMES.has(name)) problems.push(`${where}, noPrizeFor: ningún Pokémon se llama ${name}`);
        }
        break;
      case "bonusCards":
        checkCards(problems, `${where}, bonusCards`, modifier.cards.map((c) => c.cardId));
        break;
      case "opponentSetup": {
        const chains = [modifier.active, ...modifier.bench];
        const before = problems.length;
        for (const chain of chains) checkEvolutionChain(problems, `${where}, opponentSetup`, chain);
        if (problems.length > before) break;
        const needed = new Map<string, number>();
        for (const id of chains.flat()) needed.set(id, (needed.get(id) ?? 0) + 1);
        for (const { label, deck } of rivalDecks(battle)) {
          for (const [id, count] of needed) {
            const inDeck = deck.filter((e) => e.cardId === id).reduce((n, e) => n + e.qty, 0);
            if (inDeck < count) {
              problems.push(`${where}, opponentSetup: el mazo del rival${label} tiene ${inDeck} ${cardOf(id).name} y la mesa pide ${count}`);
            }
          }
        }
        break;
      }
      case "prizeCount":
      case "openingHand":
      case "opponentPassives":
        break;
    }
  }
}

/** Validate a parsed JSON adventure. */
export function validateAdventure(raw: unknown): ValidationResult {
  const parsed = adventureSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const adventure = parsed.data;
  const problems: string[] = [];
  const { rules } = adventure;

  if (rules.minDeckSize > rules.maxDeckSize) problems.push("Reglas: minDeckSize mayor que maxDeckSize");

  // Battles 1..10, each once
  const indices = adventure.battles.map((b) => b.index).sort((a, b) => a - b);
  if (indices.length !== BATTLE_COUNT || indices.some((index, i) => index !== i + 1)) {
    problems.push(`La aventura necesita ${BATTLE_COUNT} batallas con índices 1 a ${BATTLE_COUNT} (tiene ${indices.join(", ")})`);
  }
  const duplicated = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of duplicated(adventure.battles.map((b) => b.id))) problems.push(`Batalla repetida: ${id}`);
  for (const id of duplicated(adventure.starters.map((s) => s.id))) problems.push(`Inicial repetido: ${id}`);
  for (const id of duplicated(adventure.treasures.map((t) => t.id))) problems.push(`Tesoro repetido: ${id}`);
  for (const id of duplicated(adventure.achievements.map((a) => a.id))) problems.push(`Logro repetido: ${id}`);

  for (const starter of adventure.starters) {
    const where = `Inicial ${starter.id}`;
    checkEvolutionChain(problems, `${where}, línea`, [starter.line.basic, starter.line.stage1, starter.line.stage2]);
    checkDeck(problems, where, starter.deck, rules, { maxCopies: rules.maxCopies, needsBasic: true });
  }

  for (const battle of adventure.battles) checkBattle(problems, adventure, battle);

  for (const treasure of adventure.treasures) {
    if (treasure.kind !== "cards") continue;
    const ids = treasure.cards.flatMap((c) => ("cardId" in c ? [c.cardId] : []));
    checkCards(problems, `Tesoro ${treasure.id}`, ids);
  }
  const treasureIds = new Set(adventure.treasures.map((t) => t.id));
  for (const [pool, ids] of Object.entries(adventure.treasurePools)) {
    for (const id of ids) if (!treasureIds.has(id)) problems.push(`Pool ${pool}: tesoro desconocido ${id}`);
    for (const id of duplicated(ids)) problems.push(`Pool ${pool}: tesoro repetido ${id}`);
  }

  for (const [difficulty, reward] of Object.entries(adventure.rewards)) {
    if (reward.type === "card") checkCards(problems, `Recompensa ${difficulty}`, [reward.cardId]);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, adventure };
}
