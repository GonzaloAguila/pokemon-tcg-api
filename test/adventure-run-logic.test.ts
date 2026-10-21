import { describe, expect, it } from "vitest";
import { getAdventure } from "../src/modules/adventure/content/load.js";
import {
  abandonRun,
  achievementFacts,
  applyBattleResult,
  battleConfig,
  chooseTreasure,
  editDeck,
  generateOffer,
  newRun,
  offerCandidates,
  resolveTreasureCards,
  startBattle,
} from "../src/modules/adventure/run-logic.js";
import { RunPhaseError, RunRuleError, type RunState } from "../src/modules/adventure/run-logic.types.js";

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
      adventureVersion: 1,
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

  it("excludes passives already owned and card treasures that would pass 40 cards", () => {
    const run = { ...fresh(), passives: ["lucky_coin" as const] };
    expect(offerCandidates(run, adventure, 1)).not.toContain("t1-moneda");
    expect(offerCandidates(run, adventure, 1)).toContain("t1-energia");

    const full = { ...fresh(), deck: [...fresh().deck.filter((e) => e.cardId !== FIRE), { cardId: FIRE, qty: 27 }] }; // 40 cards
    expect(size(full)).toBe(40);
    const candidates = offerCandidates(full, adventure, 1);
    expect(candidates.sort()).toEqual(["t1-energia", "t1-moneda"]);

    const at39 = { ...full, deck: full.deck.map((e) => (e.cardId === FIRE ? { ...e, qty: 26 } : e)) };
    expect(offerCandidates(at39, adventure, 1)).not.toContain("t1-pociones"); // +2 → 41
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
    expect(achievementFacts(result.run)).toEqual({ won: true, difficulty: "normal", starterId: "charmander", flawless: true, purist: true, monotype: true });
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
    expect(battleConfig(runAtBattle(1), adventure).modifiers).toEqual([]);
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
    expect(achievementFacts(won)).toEqual({ won: true, difficulty: "normal", starterId: "charmander", flawless: false, purist: false, monotype: false });
    expect(achievementFacts(fresh()).won).toBe(false);
  });
});
