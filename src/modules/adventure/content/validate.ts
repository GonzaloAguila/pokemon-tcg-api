/**
 * Adventure content validator: the zod shape (schema.ts) plus every cross-check the shape can't
 * express (design §5.4). Problems are Spanish sentences, all reported at once.
 */
import { isLimitedInDeck, isPokemonCard, ALL_CARDS } from "@gonzaloaguila/game-core";
import { GYM_LEADERS } from "../../gym/content/index.js";
import { ADVENTURE_CARD_BACKS, ADVENTURE_PLAYMATS } from "../../prizes/catalog.js";
import type { BattleModifier, CardEntry } from "../engine-types.js";
import { adventureCardProblem, cardOf, isBasicPokemonCard } from "./cards.js";
import { battleModifierLists, battleModifiers, rivalDeckOf } from "./difficulty.js";
import { adventureSchema, DIFFICULTIES, type AchievementCosmeticType, type AdventureBattle, type AdventureContent, type Difficulty } from "./schema.js";

export type Adventure = AdventureContent;
export type ValidationResult = { ok: true; adventure: Adventure } | { ok: false; problems: string[] };

export const BATTLE_COUNT = 10;
const POKEMON_NAMES = new Set(ALL_CARDS.filter(isPokemonCard).map((c) => c.name));
/** Card backs an adventure may grant (prizes/catalog.ts). */
const ADVENTURE_CARD_BACK_IDS = new Set(ADVENTURE_CARD_BACKS.map((c) => c.itemId));
/** Cosmetics an adventure achievement may grant, by type (prizes/catalog.ts). */
const ACHIEVEMENT_COSMETIC_IDS: Record<AchievementCosmeticType, ReadonlySet<string>> = {
  playmat: new Set(ADVENTURE_PLAYMATS.map((p) => p.itemId)),
  cardBack: ADVENTURE_CARD_BACK_IDS,
};
const DIFFICULTY_LABELS: Record<Difficulty, string> = { normal: "normal", hard: "difícil" };

const deckSize = (deck: readonly CardEntry[]) => deck.reduce((n, e) => n + e.qty, 0);

/** Every rival deck of a battle with a label ("" for the only one) and the difficulties using it. */
export function rivalDecks(battle: AdventureBattle): { label: string; deck: CardEntry[]; difficulties: Difficulty[] }[] {
  const { deck, deckByDifficulty } = battle.opponent;
  if (deck) return [{ label: "", deck, difficulties: [...DIFFICULTIES] }];
  return (["normal", "hard"] as const).flatMap((difficulty) => {
    const own = deckByDifficulty![difficulty];
    const name = difficulty === "normal" ? "normal" : "difícil";
    return Array.isArray(own)
      ? [{ label: ` (${name})`, deck: own, difficulties: [difficulty] as Difficulty[] }]
      : Object.entries(own.byStarter).map(([starter, d]) => ({ label: ` (${name}, ${starter})`, deck: d, difficulties: [difficulty] as Difficulty[] }));
  });
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

/** One list of battle rules on its own: repeats, names, cards, opponentSetup chains. */
function checkModifierList(problems: string[], where: string, modifiers: readonly BattleModifier[]) {
  const seen = new Set<string>();
  for (const modifier of modifiers) {
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
      case "opponentSetup":
        for (const chain of [modifier.active, ...modifier.bench]) checkEvolutionChain(problems, `${where}, opponentSetup`, chain);
        break;
      case "prizeCount":
      case "openingHand":
      case "opponentPassives":
      case "darkness":
      case "alwaysConfused":
        break;
    }
  }
}

function checkBattle(problems: string[], adventure: Adventure, battle: AdventureBattle) {
  const where = `Batalla ${battle.index}`;
  const { rules } = adventure;
  const decks = rivalDecks(battle);

  for (const { label, deck } of decks) {
    const before = problems.length;
    checkCards(problems, `${where}, mazo del rival${label}`, deck.map((e) => e.cardId));
    if (problems.length > before) continue;
    const size = deckSize(deck);
    if (size < rules.minDeckSize || size > rules.maxDeckSize) {
      problems.push(`${where}: el mazo del rival${label} tiene ${size} cartas (debe tener entre ${rules.minDeckSize} y ${rules.maxDeckSize})`);
    }
  }

  // A deck / rules per starter (on either difficulty) must cover every starter, and only them
  const name = (difficulty: Difficulty) => (difficulty === "normal" ? "normal" : "difícil");
  for (const difficulty of DIFFICULTIES) {
    const own = battle.opponent.deckByDifficulty?.[difficulty];
    if (!own || Array.isArray(own)) continue;
    for (const starter of adventure.starters) {
      if (!own.byStarter[starter.id]) problems.push(`${where}: falta el mazo ${name(difficulty)} para el inicial ${starter.id}`);
    }
    for (const key of Object.keys(own.byStarter)) {
      if (!adventure.starters.some((s) => s.id === key)) problems.push(`${where}: mazo ${name(difficulty)} para un inicial desconocido ${key}`);
    }
  }

  if (battle.opponent.lead) {
    const problem = adventureCardProblem(battle.opponent.lead);
    if (problem) problems.push(`${where}, lead: ${problem}`);
    else if (!isPokemonCard(cardOf(battle.opponent.lead))) problems.push(`${where}, lead: no es un Pokémon`);
  }

  // Each list of rules on its own: the base one and every difficulty's (and starter's) replacement
  for (const list of battleModifierLists(battle)) checkModifierList(problems, `${where}${list.label}`, list.modifiers);
  for (const difficulty of DIFFICULTIES) {
    const own = battle.modifiersByDifficulty?.[difficulty];
    if (!own || Array.isArray(own)) continue;
    const label = difficulty === "normal" ? "normales" : "difíciles";
    for (const starter of adventure.starters) {
      if (!own.byStarter[starter.id]) problems.push(`${where}: faltan las reglas ${label} para el inicial ${starter.id}`);
    }
    for (const key of Object.keys(own.byStarter)) {
      if (!adventure.starters.some((s) => s.id === key)) problems.push(`${where}: reglas ${label} para un inicial desconocido ${key}`);
    }
  }

  // Each difficulty's rules against the deck it plays with, for every starter
  const reported = new Set<string>();
  const report = (problem: string) => {
    if (!reported.has(problem)) problems.push(problem);
    reported.add(problem);
  };
  for (const difficulty of DIFFICULTIES) {
    for (const starter of adventure.starters) {
      const deck = rivalDeckOf(battle, difficulty, starter.id);
      if (!deck || deck.some((e) => adventureCardProblem(e.cardId))) continue;
      const label = decks.find((d) => d.deck === deck)?.label ?? "";
      const modifiers = battleModifiers(battle, difficulty, starter.id);
      const setup = modifiers.find((m) => m.type === "opponentSetup");
      if (!setup && !deck.some((e) => isBasicPokemonCard(cardOf(e.cardId)))) {
        report(`${where}: el mazo del rival${label} no tiene Pokémon básicos`);
      }
      if (!setup) continue;
      const chains = [setup.active, ...setup.bench];
      if (chains.flat().some((id) => adventureCardProblem(id))) continue;
      const needed = new Map<string, number>();
      for (const id of chains.flat()) needed.set(id, (needed.get(id) ?? 0) + 1);
      for (const [id, count] of needed) {
        const inDeck = deck.filter((e) => e.cardId === id).reduce((n, e) => n + e.qty, 0);
        if (inDeck < count) {
          report(`${where}, opponentSetup: el mazo del rival${label} tiene ${inDeck} ${cardOf(id).name} y la mesa pide ${count}`);
        }
      }
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
    const { basic, stage1, stage2 } = starter.line;
    checkEvolutionChain(problems, `${where}, línea`, stage2 ? [basic, stage1, stage2] : [basic, stage1]);
    checkDeck(problems, where, starter.deck, rules, { maxCopies: rules.maxCopies, needsBasic: true });
  }

  for (const battle of adventure.battles) checkBattle(problems, adventure, battle);

  for (const treasure of adventure.treasures) {
    if (treasure.kind !== "cards") continue;
    const ids = treasure.cards.flatMap((c) => ("cardId" in c ? [c.cardId] : []));
    checkCards(problems, `Tesoro ${treasure.id}`, ids);
  }
  const treasureIds = new Set(adventure.treasures.map((t) => t.id));
  for (const battle of adventure.battles) {
    for (const id of battle.fixedOffer ?? []) {
      if (!treasureIds.has(id)) problems.push(`Batalla ${battle.index}, fixedOffer: tesoro desconocido ${id}`);
    }
  }
  if (adventure.requires && !GYM_LEADERS.some((l) => l.id === adventure.requires!.leaderId)) {
    problems.push(`Requisito: líder de gimnasio desconocido ${adventure.requires.leaderId}`);
  }
  const checkPools = (label: string, pools: Adventure["treasurePools"]) => {
    for (const [pool, ids] of Object.entries(pools)) {
      for (const id of ids) if (!treasureIds.has(id)) problems.push(`${label}${pool}: tesoro desconocido ${id}`);
      for (const id of duplicated(ids)) problems.push(`${label}${pool}: tesoro repetido ${id}`);
    }
  };
  checkPools("Pool ", adventure.treasurePools);
  for (const difficulty of DIFFICULTIES) {
    const own = adventure.difficulties[difficulty].treasurePools;
    if (own) checkPools(`Pool ${DIFFICULTY_LABELS[difficulty]} `, own);
  }

  for (const [difficulty, reward] of Object.entries(adventure.rewards)) {
    if (reward.type === "card") checkCards(problems, `Recompensa ${difficulty}`, [reward.cardId]);
    if (reward.type === "cosmetic" && !ADVENTURE_CARD_BACK_IDS.has(reward.id)) {
      problems.push(`Recompensa ${difficulty}: dorso de carta desconocido ${reward.id}`);
    }
  }

  for (const achievement of adventure.achievements) {
    const { cosmetic } = achievement;
    if (cosmetic && !ACHIEVEMENT_COSMETIC_IDS[cosmetic.type].has(cosmetic.id)) {
      problems.push(`Logro ${achievement.id}: cosmético de aventura desconocido ${cosmetic.type} ${cosmetic.id}`);
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, adventure };
}
