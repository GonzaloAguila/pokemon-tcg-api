import { describe, expect, it } from "vitest";
import { getAdventure } from "../src/modules/adventure/content/load.js";
import { difficultyRules, rivalDeckOf } from "../src/modules/adventure/content/difficulty.js";
import {
  abandonRun,
  achievementFacts,
  applyBattleResult,
  battleConfig,
  battleRules,
  chooseTreasure,
  editDeck,
  generateOffer,
  newRun,
  offerCandidates,
  resolveTreasureCards,
  startBattle,
  stealCards,
} from "../src/modules/adventure/run-logic.js";
import { RunPhaseError, RunRuleError, type RunState } from "../src/modules/adventure/run-logic.types.js";
import type { TreasureRarity } from "../src/modules/adventure/content/schema.js";
import type { Adventure } from "../src/modules/adventure/content/validate.js";

const adventure = getAdventure("pueblo-paleta-bosque-verde")!;
const SEED = "0123456789abcdef0123456789abcdef";
const CHARMANDER = "base-set-046-charmander";
const FIRE = "base-set-098-fire-energy";
const LIGHTNING = "base-set-100-lightning-energy";
const DCE = "base-set-096-double-colorless-energy";

const size = (run: RunState) => run.deck.reduce((n, e) => n + e.qty, 0);
const copies = (run: RunState, cardId: string) => run.deck.filter((e) => e.cardId === cardId).reduce((n, e) => n + e.qty, 0);

function fresh(starterId = "charmander", difficulty: "normal" | "hard" = "normal", seed = SEED) {
  return newRun(adventure, { difficulty, starterId, seed });
}

/** Win the current battle and take `treasureId` (or skip). */
function winAndChoose(run: RunState, choice: { treasureId: string } | { skip: true } = { skip: true }) {
  let next = applyBattleResult(startBattle(run, adventure), adventure, { victory: true }).run;
  if (next.phase === "choosing_treasure") next = chooseTreasure(next, adventure, choice);
  return next;
}

/** A run at the given battle, in pre_battle, skipping every treasure. */
function runAtBattle(battle: number, base = fresh()) {
  let run = base;
  while (run.currentBattle < battle) run = winAndChoose(run);
  return run;
}

describe("newRun", () => {
  it("starts in pre_battle of battle 1 with the starter deck and 3 hearts", () => {
    const run = fresh();
    expect(run).toMatchObject({
      adventureId: "pueblo-paleta-bosque-verde",
      adventureVersion: 4,
      status: "active",
      phase: "pre_battle",
      currentBattle: 1,
      attempt: 1,
      hearts: 3,
      maxHearts: 3,
      heartsLost: 0,
      passives: [],
      pendingOffer: [],
      offTypeUsed: false,
    });
    expect(size(run)).toBe(24);
    expect(copies(run, CHARMANDER)).toBe(4);
  });

  it("rejects an unknown starter", () => {
    expect(() => fresh("pikachu")).toThrow(RunRuleError);
  });

  it("a hard run starts with the hard hearts (2); the extra heart treasure still adds one", () => {
    const run = fresh("squirtle", "hard");
    expect(run).toMatchObject({ difficulty: "hard", hearts: 2, maxHearts: 2, currentBattle: 1 });
    const won = applyBattleResult(startBattle(runAtBattle(5, run), adventure), adventure, { victory: true }).run;
    const next = chooseTreasure({ ...won, pendingOffer: ["m-corazon"] }, adventure, { treasureId: "m-corazon" });
    expect(next).toMatchObject({ hearts: 3, maxHearts: 3 });
    // One defeat leaves 1 heart, the second ends the run
    const lost = applyBattleResult(startBattle(run, adventure), adventure, { victory: false }).run;
    expect(lost).toMatchObject({ status: "active", hearts: 1 });
    expect(applyBattleResult(startBattle(lost, adventure), adventure, { victory: false }).run).toMatchObject({ status: "lost", hearts: 0 });
  });
});

describe("hard mode", () => {
  const hard = difficultyRules(adventure, "hard");
  const rarityOf = (id: string) => adventure.treasures.find((t) => t.id === id)!.rarity;

  it("offers come from the hard pools (and the normal ones from the normal pools)", () => {
    for (const seed of Array.from({ length: 200 }, (_, i) => `hard-pools-${i}`)) {
      const run = { ...fresh("bulbasaur", "hard"), seed };
      for (const battle of [1, 2, 3, 4]) for (const id of generateOffer(run, adventure, battle)) expect(hard.treasurePools.tier1).toContain(id);
      for (const id of generateOffer(run, adventure, 5)) expect(hard.treasurePools.major).toContain(id);
      for (const battle of [6, 7, 8, 9]) for (const id of generateOffer(run, adventure, battle)) expect(hard.treasurePools.tier2).toContain(id);
      expect(generateOffer(run, adventure, 10)).toEqual([]);
      for (const id of generateOffer({ ...fresh("bulbasaur", "normal"), seed }, adventure, 1)) expect(adventure.treasurePools.tier1).toContain(id);
    }
    expect(offerCandidates(fresh("charmander", "hard"), adventure, 1)).not.toContain("t1-pociones");
  });

  it("uses the hard offer weights: epics show up more often than in normal", () => {
    const epicShare = (difficulty: "normal" | "hard") => {
      let epics = 0;
      let total = 0;
      for (let i = 0; i < 600; i++) {
        for (const id of generateOffer({ ...fresh("charmander", difficulty), seed: `weights-${i}` }, adventure, 6)) {
          total++;
          if (rarityOf(id) === "epic") epics++;
        }
      }
      return epics / total;
    };
    expect(epicShare("hard")).toBeGreaterThan(epicShare("normal") + 0.1);
    // The weights come from the difficulty: an epic-only hard table offers its epics first
    const epicOnly = structuredClone(adventure);
    epicOnly.difficulties.hard.treasureOffer = { rarityWeights: { common: 1, rare: 1, epic: 1000 }, maxPassives: 1 };
    for (let i = 0; i < 100; i++) {
      const offer = generateOffer({ ...fresh("charmander", "hard"), seed: `epic-${i}` }, epicOnly, 6);
      expect(offer.filter((id) => rarityOf(id) === "epic").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("new hard treasures resolve with the starter's line and enter the deck", () => {
    const criador = adventure.treasures.find((t) => t.id === "h5-criador")!;
    expect(resolveTreasureCards(criador, adventure.starters[1])).toEqual([
      { cardId: "base-set-002-blastoise", qty: 1 },
      { cardId: "base-set-076-pokemon-breeder", qty: 2 },
    ]);
    const won = applyBattleResult(startBattle(fresh("squirtle", "hard"), adventure), adventure, { victory: true }).run;
    const run = chooseTreasure({ ...won, pendingOffer: ["h1-kangaskhan"] }, adventure, { treasureId: "h1-kangaskhan" });
    expect(copies(run, "jungle-005-kangaskhan")).toBe(1);
    expect(copies(run, DCE)).toBe(2);
  });

  it("battleConfig uses the hard rival deck and the hard rules of the battle", () => {
    const hard1 = battleConfig(fresh("charmander", "hard"), adventure);
    expect(hard1.opponentDeck).toEqual(rivalDeckOf(adventure.battles[0], "hard", "charmander"));
    expect(hard1.opponentDeck.some((e) => e.cardId === "base-set-040-raticate")).toBe(true);
    expect(battleConfig(fresh("charmander", "normal"), adventure).opponentDeck.some((e) => e.cardId === "base-set-040-raticate")).toBe(false);

    const boss = battleConfig(runAtBattle(5, fresh("charmander", "hard")), adventure);
    expect(boss.modifiers).toContainEqual({ type: "prizeCount", opponent: 2 });
    expect(battleConfig(runAtBattle(5), adventure).modifiers.map((m) => m.type)).toEqual(["opponentSetup"]);
    expect(battleRules(adventure, 5, "hard", "charmander")).toEqual(boss.modifiers);

    const final = battleConfig(runAtBattle(10, fresh("squirtle", "hard")), adventure);
    expect(final.opponentDeck[0].cardId).toBe("base-set-044-bulbasaur");
    expect(final.modifiers.map((m) => m.type)).toEqual(["prizeCount", "bonusCards", "opponentPassives", "opponentSetup"]);
    expect(final.modifiers.find((m) => m.type === "opponentSetup")).toEqual({
      type: "opponentSetup",
      active: ["base-set-044-bulbasaur"],
      bench: [["base-set-058-pikachu"]],
    });
  });
});

describe("offers", () => {
  it("the same seed and battle always give the same offer; another seed may not", () => {
    const run = runAtBattle(3);
    const a = generateOffer(run, adventure, 3);
    expect(generateOffer(run, adventure, 3)).toEqual(a);
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
    const offers = new Set(Array.from({ length: 12 }, (_, i) => generateOffer({ ...run, seed: `seed-${i}` }, adventure, 3).join()));
    expect(offers.size).toBeGreaterThan(1);
  });

  it("uses tier1 after 1–4, the major pool after 5, tier2 after 6–9 and nothing after 10", () => {
    const run = fresh();
    const { tier1, major, tier2 } = adventure.treasurePools;
    for (const battle of [1, 2, 3, 4]) for (const id of generateOffer(run, adventure, battle)) expect(tier1).toContain(id);
    for (const id of generateOffer(run, adventure, 5)) expect(major).toContain(id);
    for (const battle of [6, 7, 8, 9]) for (const id of generateOffer(run, adventure, battle)) expect(tier2).toContain(id);
    expect(generateOffer(run, adventure, 10)).toEqual([]);
  });

  it("t1-evolucion is offerable with the untouched starter deck (no copy limit)", () => {
    expect(offerCandidates(fresh(), adventure, 1)).toContain("t1-evolucion");
  });

  it("excludes passives already owned; card treasures stay on offer with a full deck (trimmed before the next battle)", () => {
    const run = { ...fresh(), passives: ["lucky_coin" as const] };
    expect(offerCandidates(run, adventure, 1)).not.toContain("t1-moneda");
    expect(offerCandidates(run, adventure, 6)).toContain("t1-energia");
    expect(offerCandidates({ ...run, passives: ["start_attached_energy"] }, adventure, 6)).not.toContain("t1-energia");

    const full = { ...fresh(), deck: [...fresh().deck.filter((e) => e.cardId !== FIRE), { cardId: FIRE, qty: 27 }] }; // 40 cards
    expect(size(full)).toBe(40);
    expect(offerCandidates(full, adventure, 1).sort()).toEqual([...adventure.treasurePools.tier1].sort());

    // Taking one goes over 40; the next battle won't start until the player trims the deck
    const won = applyBattleResult(startBattle(full, adventure), adventure, { victory: true }).run;
    const over = chooseTreasure({ ...won, pendingOffer: ["t1-pociones"] }, adventure, { treasureId: "t1-pociones" });
    expect(size(over)).toBe(42);
    expect(() => startBattle(over, adventure)).toThrow(RunRuleError);
    const trimmed = editDeck(over, adventure, { remove: [{ cardId: FIRE, qty: 2 }], energies: [] });
    expect(startBattle(trimmed, adventure).phase).toBe("in_battle");
  });
});

describe("offers by rarity", () => {
  const SEEDS = Array.from({ length: 1500 }, (_, i) => `rarity-seed-${i}`);
  const kindOf = (id: string) => adventure.treasures.find((t) => t.id === id)!.kind;
  const rarityOf = (id: string) => adventure.treasures.find((t) => t.id === id)!.rarity;
  /** The adventure with some content edits (never mutates the loaded one). */
  const variant = (edit: (a: Adventure) => void): Adventure => {
    const copy = structuredClone(adventure);
    edit(copy);
    return copy;
  };
  const setRarity = (a: Adventure, id: string, rarity: TreasureRarity) => {
    a.treasures.find((t) => t.id === id)!.rarity = rarity;
  };

  it("every treasure has a rarity; Arranque rápido is epic and in the battles 6–9 pool only", () => {
    for (const t of adventure.treasures) expect(["common", "rare", "epic"]).toContain(t.rarity);
    expect(rarityOf("t1-energia")).toBe("epic");
    expect(adventure.treasurePools.tier1).not.toContain("t1-energia");
    expect(adventure.treasurePools.major).not.toContain("t1-energia");
    expect(adventure.treasurePools.tier2).toContain("t1-energia");
    expect(adventure.treasureOffer).toEqual({ rarityWeights: { common: 6, rare: 3, epic: 1 }, maxPassives: 1 });
  });

  it("Arranque rápido is never offered before battle 6, and is offered sometimes in 6–9", () => {
    let later = 0;
    for (const seed of SEEDS) {
      const run = { ...fresh(), seed };
      for (const battle of [1, 2, 3, 4, 5]) expect(generateOffer(run, adventure, battle)).not.toContain("t1-energia");
      for (const battle of [6, 7, 8, 9]) if (generateOffer(run, adventure, battle).includes("t1-energia")) later++;
    }
    expect(later).toBeGreaterThan(0);
  });

  it("commons are offered more often than rares, rares more than epics (weights 6/3/1)", () => {
    for (const battle of [1, 6]) {
      const seen = new Map<string, number>();
      for (const seed of SEEDS) for (const id of generateOffer({ ...fresh(), seed }, adventure, battle)) seen.set(id, (seen.get(id) ?? 0) + 1);
      const pool = battle === 1 ? adventure.treasurePools.tier1 : adventure.treasurePools.tier2;
      const mean = (rarity: string) => {
        const ids = pool.filter((id) => rarityOf(id) === rarity);
        return ids.reduce((n, id) => n + (seen.get(id) ?? 0), 0) / ids.length;
      };
      expect(mean("common")).toBeGreaterThan(mean("rare"));
      if (battle === 6) expect(mean("rare")).toBeGreaterThan(mean("epic"));
    }
  });

  it("the weights come from the content: an epic-heavy table offers epics first", () => {
    const epicHeavy = variant((a) => {
      a.treasureOffer.rarityWeights = { common: 1, rare: 1, epic: 1000 };
      setRarity(a, "t2-oak", "epic");
    });
    const withOak = SEEDS.slice(0, 300).filter((seed) => generateOffer({ ...fresh(), seed }, epicHeavy, 6).includes("t2-oak")).length;
    expect(withOak).toBeGreaterThan(290);
  });

  it("at most one passive per offer and at least one card treasure, in every battle", () => {
    for (const seed of SEEDS.slice(0, 500)) {
      const run = { ...fresh(), seed };
      for (const battle of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const offer = generateOffer(run, adventure, battle);
        expect(offer).toHaveLength(3);
        expect(new Set(offer).size).toBe(3);
        expect(offer.filter((id) => kindOf(id) === "passive").length).toBeLessThanOrEqual(1);
        expect(offer.some((id) => kindOf(id) === "cards")).toBe(true);
      }
      // Battle 5: Corazón extra and Atajo never together
      const major = generateOffer(run, adventure, 5);
      expect(major.includes("m-corazon") && major.includes("m-atajo")).toBe(false);
    }
  });

  it("keeps a slot for a card treasure even when passives may fill the offer", () => {
    const passiveHeavy = variant((a) => {
      a.treasurePools.tier2 = ["t2-mano", "t1-energia", "m-corazon", "m-atajo", "t2-oak"];
      a.treasureOffer = { rarityWeights: { common: 1000, rare: 1000, epic: 1 }, maxPassives: 3 };
      for (const id of ["t2-mano", "t1-energia", "m-corazon", "m-atajo"]) setRarity(a, id, "common");
      setRarity(a, "t2-oak", "epic");
    });
    for (const seed of SEEDS.slice(0, 200)) {
      const offer = generateOffer({ ...fresh(), seed }, passiveHeavy, 6);
      expect(offer).toHaveLength(3);
      expect(offer).toContain("t2-oak");
      expect(offer.filter((id) => kindOf(id) === "passive")).toHaveLength(2);
    }
  });

  it("is deterministic per run seed and battle, and varies across seeds", () => {
    const run = runAtBattle(7);
    for (const battle of [1, 5, 6, 9]) expect(generateOffer(run, adventure, battle)).toEqual(generateOffer({ ...run }, adventure, battle));
    expect(generateOffer({ ...fresh(), seed: "fixed-seed" }, adventure, 6)).toEqual(generateOffer({ ...fresh(), seed: "fixed-seed" }, adventure, 6));
    const offers = new Set(SEEDS.slice(0, 50).map((seed) => generateOffer({ ...fresh(), seed }, adventure, 6).join()));
    expect(offers.size).toBeGreaterThan(10);
  });

  it("prefers treasures the run hasn't taken; a taken card treasure only fills a slot nothing else can", () => {
    const run = { ...fresh(), treasuresTaken: ["t2-oak", "t2-superpocion"] };
    for (const seed of SEEDS.slice(0, 300)) {
      const offer = generateOffer({ ...run, seed }, adventure, 6);
      expect(offer).not.toContain("t2-oak");
      expect(offer).not.toContain("t2-superpocion");
    }
    // Both passives owned, every card treasure but two already taken: the two fresh ones + one repeat
    const cards = adventure.treasurePools.tier2.filter((id) => kindOf(id) === "cards");
    const almostAll = {
      ...fresh(),
      passives: ["opening_hand_plus_1" as const, "start_attached_energy" as const],
      treasuresTaken: cards.filter((id) => id !== "t2-plus" && id !== "t2-dce"),
    };
    for (const seed of SEEDS.slice(0, 100)) {
      const offer = generateOffer({ ...almostAll, seed }, adventure, 6);
      expect(offer).toHaveLength(3);
      expect(offer).toEqual(expect.arrayContaining(["t2-plus", "t2-dce"]));
    }
  });

  it("a full deck still gets 3 treasures (owner report: battle 9 offered only 1)", () => {
    const full = { ...fresh("charmander", "hard"), deck: [...fresh().deck.filter((e) => e.cardId !== FIRE), { cardId: FIRE, qty: 27 }] }; // 40 cards
    for (const battle of [1, 5, 6, 9]) {
      for (const seed of ["a", "b", "c", "d"]) expect(generateOffer({ ...full, seed }, adventure, battle)).toHaveLength(3);
    }
  });

  it("falls back to fewer treasures only when the pool runs out; then the passive cap gives way", () => {
    const withTier1 = (ids: string[]) => variant((a) => (a.treasurePools = { ...a.treasurePools, tier1: ids }));
    // Two passives and nothing else: both offered (the one-passive cap gives way)
    expect(generateOffer(fresh(), withTier1(["t1-moneda", "t1-energia"]), 1).sort()).toEqual(["t1-energia", "t1-moneda"]);
    // One passive the run already has: nothing to offer, the victory goes straight to the next battle
    const lonelyAdventure = withTier1(["t1-moneda"]);
    const lonely = { ...fresh(), passives: ["lucky_coin" as const] };
    expect(generateOffer(lonely, lonelyAdventure, 1)).toEqual([]);
    expect(applyBattleResult(startBattle(lonely, lonelyAdventure), lonelyAdventure, { victory: true }).run).toMatchObject({
      phase: "pre_battle",
      currentBattle: 2,
    });
  });

  it("live runs keep working: every treasure id of content version 1 still resolves", () => {
    const V1_IDS = [
      "t1-evolucion", "t1-pociones", "t1-bill", "t1-tactica", "t1-pikachu", "t1-moneda", "t1-energia",
      "m-final", "m-corazon", "m-atajo", "m-profesor",
      "t2-oak", "t2-superpocion", "t2-plus", "t2-removal", "t2-bandada", "t2-defensa", "t2-dce", "t2-mano",
    ];
    const ids = new Set(adventure.treasures.map((t) => t.id));
    for (const id of V1_IDS) expect(ids.has(id)).toBe(true);
    // An offer stored under version 1 with Arranque rápido after battle 2 can still be taken
    const won = applyBattleResult(startBattle(runAtBattle(2), adventure), adventure, { victory: true }).run;
    const run = chooseTreasure({ ...won, adventureVersion: 1, pendingOffer: ["t1-energia", "t1-bill", "t1-moneda"] }, adventure, { treasureId: "t1-energia" });
    expect(run).toMatchObject({ currentBattle: 3, passives: ["start_attached_energy"], treasuresTaken: ["t1-energia"] });
    expect(adventure.version).toBe(4);
    expect(fresh().adventureVersion).toBe(4);
  });

  it("live hard runs of version 2 keep their hearts and stored offer; later offers use the hard pools", () => {
    // A version-2 hard run: 3 hearts and a stored offer from the old (shared) pools
    const won = applyBattleResult(startBattle(runAtBattle(2, fresh("charmander", "hard")), adventure), adventure, { victory: true }).run;
    const v2 = { ...won, adventureVersion: 2, hearts: 3, maxHearts: 3, pendingOffer: ["t1-pociones", "t1-bill", "t1-moneda"] };
    const run = chooseTreasure(v2, adventure, { treasureId: "t1-pociones" });
    expect(run).toMatchObject({ currentBattle: 3, hearts: 3, maxHearts: 3, adventureVersion: 2 });
    expect(copies(run, "base-set-094-potion")).toBe(4);
    const next = applyBattleResult(startBattle(run, adventure), adventure, { victory: true }).run;
    for (const id of next.pendingOffer) expect(difficultyRules(adventure, "hard").treasurePools.tier1).toContain(id);
  });
});

describe("treasures", () => {
  it("starter.* tokens resolve with each starter's line", () => {
    const treasure = adventure.treasures.find((t) => t.id === "m-final")!;
    expect(resolveTreasureCards(treasure, adventure.starters[0])).toEqual([
      { cardId: "base-set-004-charizard", qty: 1 },
      { cardId: "base-set-024-charmeleon", qty: 1 },
    ]);
    expect(resolveTreasureCards(treasure, adventure.starters[1])).toEqual([
      { cardId: "base-set-002-blastoise", qty: 1 },
      { cardId: "base-set-042-wartortle", qty: 1 },
    ]);
    expect(resolveTreasureCards(treasure, adventure.starters[2])).toEqual([
      { cardId: "base-set-015-venusaur", qty: 1 },
      { cardId: "base-set-030-ivysaur", qty: 1 },
    ]);
  });

  it("a starter without a Stage 2 (Pikachu) is never offered a Stage 2 treasure, nor can take one", () => {
    const pikachu = {
      id: "pikachu",
      name: "Pikachu",
      energyType: "lightning" as const,
      line: { basic: "base-set-058-pikachu", stage1: "base-set-014-raichu" },
      deck: [{ cardId: "base-set-058-pikachu", qty: 4 }, { cardId: "base-set-014-raichu", qty: 2 }, { cardId: LIGHTNING, qty: 18 }],
    };
    const withPikachu: Adventure = { ...adventure, starters: [...adventure.starters, pikachu] };
    const run = newRun(withPikachu, { difficulty: "normal", starterId: "pikachu", seed: SEED });
    expect(adventure.treasurePools.major).toContain("m-final");
    expect(offerCandidates(run, withPikachu, 5)).not.toContain("m-final");
    expect(offerCandidates(run, withPikachu, 5).length).toBeGreaterThan(0);
    expect(offerCandidates(run, withPikachu, 1)).toContain("t1-evolucion");
    const finalEvolution = withPikachu.treasures.find((t) => t.id === "m-final")!;
    expect(resolveTreasureCards(finalEvolution, pikachu)).toEqual([{ cardId: "base-set-014-raichu", qty: 1 }]);
    const choosing: RunState = { ...run, currentBattle: 5, phase: "choosing_treasure", pendingOffer: ["m-final"] };
    expect(() => chooseTreasure(choosing, withPikachu, { treasureId: "m-final" })).toThrow(RunRuleError);
  });

  it("a 5th and 6th Charmander are fine (no copy limit)", () => {
    const won = applyBattleResult(startBattle(fresh(), adventure), adventure, { victory: true }).run;
    const run = chooseTreasure({ ...won, pendingOffer: ["t1-evolucion"] }, adventure, { treasureId: "t1-evolucion" });
    const won2 = applyBattleResult(startBattle(run, adventure), adventure, { victory: true }).run;
    const run2 = chooseTreasure({ ...won2, pendingOffer: ["t1-evolucion"] }, adventure, { treasureId: "t1-evolucion" });
    expect(copies(run2, CHARMANDER)).toBe(6);
    expect(run2.treasuresTaken).toEqual(["t1-evolucion", "t1-evolucion"]);
    expect(run2).toMatchObject({ phase: "pre_battle", currentBattle: 3, attempt: 1, pendingOffer: [] });
  });

  it("a passive is appended; extra_heart raises hearts and max hearts", () => {
    const won = applyBattleResult(startBattle(runAtBattle(5), adventure), adventure, { victory: true }).run;
    expect(won.phase).toBe("choosing_treasure");
    const run = chooseTreasure({ ...won, hearts: 2, pendingOffer: ["m-corazon", "m-atajo"] }, adventure, { treasureId: "m-corazon" });
    expect(run).toMatchObject({ hearts: 3, maxHearts: 4, passives: ["extra_heart"], currentBattle: 6 });
  });

  it("only an offered treasure can be taken (422); skipping counts", () => {
    const won = applyBattleResult(startBattle(fresh(), adventure), adventure, { victory: true }).run;
    const notOffered = adventure.treasurePools.tier1.find((id) => !won.pendingOffer.includes(id))!;
    expect(() => chooseTreasure(won, adventure, { treasureId: notOffered })).toThrow(RunRuleError);
    expect(chooseTreasure(won, adventure, { skip: true })).toMatchObject({ treasuresSkipped: 1, treasuresTaken: [], currentBattle: 2 });
  });
});

describe("battle results", () => {
  it("a victory in 1–9 stores the offer and waits for the treasure", () => {
    const { run, events } = applyBattleResult(startBattle(fresh(), adventure), adventure, { victory: true });
    expect(run.phase).toBe("choosing_treasure");
    expect(run.pendingOffer).toEqual(generateOffer(fresh(), adventure, 1));
    expect(events).toEqual([{ type: "offer", offer: run.pendingOffer }]);
  });

  it("a defeat costs a heart and repeats the same battle; at 0 the run is lost", () => {
    let run = startBattle(runAtBattle(4), adventure);
    let result = applyBattleResult(run, adventure, { victory: false });
    expect(result.run).toMatchObject({ phase: "pre_battle", currentBattle: 4, attempt: 2, hearts: 2, heartsLost: 1, status: "active" });
    expect(result.events).toEqual([{ type: "heartLost", hearts: 2 }]);
    run = applyBattleResult(startBattle(result.run, adventure), adventure, { victory: false }).run;
    result = applyBattleResult(startBattle(run, adventure), adventure, { victory: false });
    expect(result.run).toMatchObject({ status: "lost", phase: "finished", hearts: 0, heartsLost: 3, currentBattle: 4 });
    expect(result.events).toEqual([{ type: "heartLost", hearts: 0 }, { type: "runLost" }]);
  });

  it("winning battle 10 wins the run", () => {
    const run = startBattle(runAtBattle(10), adventure);
    const result = applyBattleResult(run, adventure, { victory: true });
    expect(result.run).toMatchObject({ status: "won", phase: "finished", pendingOffer: [] });
    expect(result.events).toEqual([{ type: "runWon" }]);
    expect(achievementFacts(result.run)).toEqual({ won: true, difficulty: "normal", starterId: "charmander", flawless: true, purist: true, monotype: true, noSteal: true });
  });
});

describe("phase guards (RunPhaseError → 409)", () => {
  it("deck edit, battle start, treasure choice, result and abandon only in their phase", () => {
    const pre = fresh();
    const inBattle = startBattle(pre, adventure);
    const choosing = applyBattleResult(inBattle, adventure, { victory: true }).run;
    expect(() => editDeck(inBattle, adventure, { remove: [], energies: [] })).toThrow(RunPhaseError);
    expect(() => editDeck(choosing, adventure, { remove: [], energies: [] })).toThrow(RunPhaseError);
    expect(() => startBattle(inBattle, adventure)).toThrow(RunPhaseError);
    expect(() => startBattle(choosing, adventure)).toThrow(RunPhaseError);
    expect(() => chooseTreasure(pre, adventure, { skip: true })).toThrow(RunPhaseError);
    expect(() => applyBattleResult(pre, adventure, { victory: true })).toThrow(RunPhaseError);
    expect(() => abandonRun(inBattle)).toThrow(RunPhaseError);
    expect(abandonRun(pre)).toMatchObject({ status: "abandoned", phase: "finished" });
    expect(abandonRun(choosing)).toMatchObject({ status: "abandoned", phase: "finished", pendingOffer: [] });
    expect(() => startBattle(abandonRun(pre), adventure)).toThrow(RunPhaseError);
  });
});

describe("deck edit", () => {
  it("never goes under 20 or over 40", () => {
    const run = fresh();
    expect(() => editDeck(run, adventure, { remove: [{ cardId: FIRE, qty: 5 }], energies: [] })).toThrow(RunRuleError);
    expect(size(editDeck(run, adventure, { remove: [{ cardId: FIRE, qty: 4 }], energies: [] }))).toBe(20);
    expect(() => editDeck(run, adventure, { remove: [], energies: [{ cardId: FIRE, qty: 28 }] })).toThrow(RunRuleError);
    expect(size(editDeck(run, adventure, { remove: [], energies: [{ cardId: FIRE, qty: 27 }] }))).toBe(40);
  });

  it("removed cards are gone; basic Energy is set to the given count, of any type", () => {
    const run = editDeck(fresh(), adventure, {
      remove: [{ cardId: "base-set-061-rattata", qty: 2 }],
      energies: [{ cardId: FIRE, qty: 9 }, { cardId: LIGHTNING, qty: 2 }],
    });
    expect(copies(run, "base-set-061-rattata")).toBe(0);
    expect(copies(run, FIRE)).toBe(9);
    expect(copies(run, LIGHTNING)).toBe(2);
    expect(size(run)).toBe(22);
  });

  it("can't add DCE or any non-basic-Energy card, nor remove what isn't there", () => {
    expect(() => editDeck(fresh(), adventure, { remove: [], energies: [{ cardId: DCE, qty: 1 }] })).toThrow(RunRuleError);
    expect(() => editDeck(fresh(), adventure, { remove: [], energies: [{ cardId: CHARMANDER, qty: 5 }] })).toThrow(RunRuleError);
    expect(() => editDeck(fresh(), adventure, { remove: [{ cardId: "base-set-091-bill", qty: 3 }], energies: [] })).toThrow(RunRuleError);
    expect(() => editDeck(fresh(), adventure, { remove: [{ cardId: "base-set-004-charizard", qty: 1 }], energies: [] })).toThrow(RunRuleError);
  });

  it("keeps at least one Basic Pokémon", () => {
    const run = editDeck(fresh(), adventure, { remove: [{ cardId: "base-set-061-rattata", qty: 2 }], energies: [{ cardId: FIRE, qty: 15 }] });
    expect(() => editDeck(run, adventure, { remove: [{ cardId: CHARMANDER, qty: 4 }], energies: [] })).toThrow(/básico/);
  });
});

describe("battleConfig", () => {
  it("hard battle 10 gives the rival deck of each starter; normal the shared one", () => {
    const first = (id: string, difficulty: "normal" | "hard") => battleConfig(runAtBattle(10, fresh(id, difficulty)), adventure).opponentDeck[0].cardId;
    expect(first("charmander", "hard")).toBe("base-set-063-squirtle");
    expect(first("squirtle", "hard")).toBe("base-set-044-bulbasaur");
    expect(first("bulbasaur", "hard")).toBe("base-set-046-charmander");
    expect(first("bulbasaur", "normal")).toBe("base-set-057-pidgey");
  });

  it("carries the run deck, rules, passives and the battle's modifiers", () => {
    const run = { ...runAtBattle(7), passives: ["lucky_coin" as const] };
    const config = battleConfig(run, adventure);
    expect(config).toMatchObject({ prizeCount: 3, openingHand: 7, playerPassives: ["lucky_coin"], playerDeck: run.deck });
    expect(config.opponentDeck.reduce((n, e) => n + e.qty, 0)).toBe(40);
    expect(config.modifiers.map((m) => m.type)).toEqual(["prizeCount", "noPrizeFor", "opponentSetup", "bonusCards"]);
    // A battle without rules still opens with an Active and a Benched Pokémon (withOpeningBench)
    const opening = battleConfig(runAtBattle(1), adventure).modifiers;
    expect(opening.map((m) => m.type)).toEqual(["opponentSetup"]);
    expect(opening[0]).toMatchObject({ active: [expect.any(String)], bench: [[expect.any(String)]] });
  });
});

describe("monotype", () => {
  it("a Lightning Energy added before a battle marks the run off-type", () => {
    const run = editDeck(fresh(), adventure, { remove: [], energies: [{ cardId: LIGHTNING, qty: 1 }] });
    expect(startBattle(run, adventure).offTypeUsed).toBe(true);
    expect(startBattle(fresh(), adventure).offTypeUsed).toBe(false);
  });

  it("Colorless Pokémon (Rattata, Pidgey) and DCE don't break it; Pikachu does", () => {
    const withDce = { ...fresh(), deck: [...fresh().deck, { cardId: DCE, qty: 2 }, { cardId: "base-set-057-pidgey", qty: 2 }] };
    expect(startBattle(withDce, adventure).offTypeUsed).toBe(false);
    const withPikachu = { ...fresh(), deck: [...fresh().deck, { cardId: "base-set-058-pikachu", qty: 1 }] };
    expect(startBattle(withPikachu, adventure).offTypeUsed).toBe(true);
  });

  it("once set it stays set after the card leaves the deck", () => {
    const marked = applyBattleResult(
      startBattle(editDeck(fresh(), adventure, { remove: [], energies: [{ cardId: LIGHTNING, qty: 1 }] }), adventure),
      adventure,
      { victory: false },
    ).run;
    const cleaned = editDeck(marked, adventure, { remove: [], energies: [{ cardId: LIGHTNING, qty: 0 }] });
    expect(startBattle(cleaned, adventure).offTypeUsed).toBe(true);
  });
});

describe("achievementFacts", () => {
  it("flawless, purist and monotype from the run", () => {
    const won = { ...fresh(), status: "won" as const, phase: "finished" as const, heartsLost: 1, treasuresTaken: ["t1-bill"], offTypeUsed: true };
    expect(achievementFacts(won)).toEqual({ won: true, difficulty: "normal", starterId: "charmander", flawless: false, purist: false, monotype: false, noSteal: true });
    expect(achievementFacts(fresh()).won).toBe(false);
  });
});

describe("Team Rocket steals and returns cards", () => {
  const BULBASAUR = "base-set-044-bulbasaur";
  const rocket = structuredClone(adventure);
  rocket.battles[0].onLoss = { type: "stealCards", count: 3 };
  rocket.battles[1].onWin = { type: "recoverStolen" };
  const tier = rocket.treasurePools.tier1;
  rocket.battles[2].fixedOffer = [tier[2], tier[0]];
  const isEnergyId = (id: string) => id.includes("-energy");
  const total = (cards: { qty: number }[]) => cards.reduce((n, e) => n + e.qty, 0);
  const lose = (run: RunState, adv = rocket) => applyBattleResult(startBattle(run, adv), adv, { victory: false });

  it("a lost Team Rocket battle steals count cards, never basic Energy, and records them", () => {
    const run = fresh();
    const { run: next, events } = lose(run);
    const stolenEvent = events.find((e) => e.type === "stolen");
    if (stolenEvent?.type !== "stolen") throw new Error("no stolen event");
    expect(total(stolenEvent.cards)).toBe(3);
    expect(stolenEvent.cards.some((c) => isEnergyId(c.cardId))).toBe(false);
    expect(next.stolen).toEqual(stolenEvent.cards);
    expect(next.cardsStolen).toBe(3);
    expect(size(next)).toBe(size(run) - 3);
  });

  it("stealing keeps at least 4 Basic Pokémon", () => {
    const run: RunState = { ...fresh(), deck: [{ cardId: CHARMANDER, qty: 4 }, { cardId: BULBASAUR, qty: 1 }, { cardId: FIRE, qty: 19 }] };
    const { run: next, cards } = stealCards(run, rocket, 3);
    expect(total(cards)).toBe(1);
    expect(size(next)).toBe(size(run) - 1);
  });

  it("countByDifficulty.hard overrides count on a hard run (a normal run keeps count)", () => {
    const byDifficulty = structuredClone(rocket);
    byDifficulty.battles[0].onLoss = { type: "stealCards", count: 2, countByDifficulty: { hard: 3 } };
    const stolenBy = (run: RunState) => lose(run, byDifficulty).run.cardsStolen;
    expect(stolenBy(fresh())).toBe(2);
    expect(stolenBy({ ...fresh(), difficulty: "hard" })).toBe(3);
  });

  it("a steal may leave the deck under minDeckSize and startBattle then refuses until Energy is added back", () => {
    const { run: lost } = lose(editDeck(fresh(), rocket, { remove: [{ cardId: FIRE, qty: 4 }], energies: [] }));
    expect(size(lost)).toBe(17);
    expect(() => startBattle(lost, rocket)).toThrow(RunRuleError);
    const fixed = editDeck(lost, rocket, { remove: [], energies: [{ cardId: FIRE, qty: copies(lost, FIRE) + 4 }] });
    expect(() => startBattle(fixed, rocket)).not.toThrow();
  });

  it("every lost attempt steals again", () => {
    const first = lose(fresh()).run;
    const filled = editDeck(first, rocket, { remove: [], energies: [{ cardId: FIRE, qty: copies(first, FIRE) + 1 }] });
    const second = lose(filled).run;
    expect(second.cardsStolen).toBe(6);
    expect(total(second.stolen)).toBe(6);
  });

  it("winning a recoverStolen battle returns every stolen card and clears the list", () => {
    const stolen = [{ cardId: CHARMANDER, qty: 2 }, { cardId: "base-set-024-charmeleon", qty: 1 }];
    const run: RunState = { ...fresh(), currentBattle: 2, stolen, cardsStolen: 3 };
    const before = size(run);
    const { run: next, events } = applyBattleResult(startBattle(run, rocket), rocket, { victory: true });
    expect(events).toContainEqual({ type: "recovered", cards: stolen });
    expect(next.stolen).toEqual([]);
    expect(size(next)).toBe(before + 3);
    expect(next.cardsStolen).toBe(3);
  });

  it("winning a recoverStolen battle with nothing stolen adds no event", () => {
    const run: RunState = { ...fresh(), currentBattle: 2 };
    const { events } = applyBattleResult(startBattle(run, rocket), rocket, { victory: true });
    expect(events.some((e) => e.type === "recovered")).toBe(false);
  });

  it("a fixedOffer battle offers exactly its treasures", () => {
    const run: RunState = { ...fresh(), currentBattle: 3 };
    expect(offerCandidates(run, rocket, 3)).toEqual([tier[2], tier[0]]);
    expect(generateOffer(run, rocket, 3)).toEqual([tier[2], tier[0]]);
  });

  it("the same seed steals the same cards", () => {
    const run = fresh();
    expect(stealCards(run, rocket, 3).cards).toEqual(stealCards({ ...run }, rocket, 3).cards);
    expect(stealCards({ ...run, seed: "other-seed" }, rocket, 3).cards).not.toEqual(stealCards(run, rocket, 3).cards);
    expect(achievementFacts(run).noSteal).toBe(true);
    expect(achievementFacts(lose(run).run).noSteal).toBe(false);
  });
});
