import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAdventure, getAdventures, validateAdventure } from "../src/modules/adventure/content/load.js";
import { describeModifier } from "../src/modules/adventure/content/modifiers.js";
import type { BattleModifier } from "../src/modules/adventure/engine-types.js";

const FILE = path.resolve(__dirname, "../content/adventures/pueblo-paleta-bosque-verde.json");
const raw = () => JSON.parse(readFileSync(FILE, "utf8"));

function problemsOf(mutate: (adventure: any) => void): string[] {
  const data = raw();
  mutate(data);
  const result = validateAdventure(data);
  if (result.ok) throw new Error("expected the fixture to be rejected");
  return result.problems;
}

const sum = (deck: { qty: number }[]) => deck.reduce((n, e) => n + e.qty, 0);

describe("Adventure 1 content", () => {
  it("validates and loads from content/adventures", () => {
    const result = validateAdventure(raw());
    expect(result.ok ? [] : result.problems).toEqual([]);
    const adventure = getAdventure("pueblo-paleta-bosque-verde");
    expect(adventure?.name).toBe("De Pueblo Paleta al Bosque Verde");
    expect([...getAdventures().keys()]).toEqual(["pueblo-paleta-bosque-verde"]);
  });

  it("has the spec's rules, starters, battles and pools", () => {
    const adventure = getAdventure("pueblo-paleta-bosque-verde")!;
    expect(adventure.rules).toEqual({ hearts: 3, prizeCount: 3, openingHand: 7, minDeckSize: 20, maxDeckSize: 40, maxCopies: null });
    expect(adventure.starters.map((s) => s.id)).toEqual(["charmander", "squirtle", "bulbasaur"]);
    for (const starter of adventure.starters) expect(sum(starter.deck)).toBe(24);
    expect(adventure.battles.map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sizes = adventure.battles.map((b) => (b.opponent.deck ? sum(b.opponent.deck) : sum(b.opponent.deckByDifficulty!.normal)));
    expect(sizes).toEqual([20, 20, 20, 20, 20, 20, 40, 20, 20, 24]);
    for (const deck of Object.values(adventure.battles[9].opponent.deckByDifficulty!.hard.byStarter)) expect(sum(deck)).toBe(24);
    expect(adventure.battles.map((b) => b.treasurePool)).toEqual([
      "tier1", "tier1", "tier1", "tier1", "major", "tier2", "tier2", "tier2", "tier2", null,
    ]);
    expect(adventure.achievements.map((a) => [a.id, a.tier])).toEqual([
      ["adventure-1-clear-normal", "bronze"],
      ["adventure-1-clear-hard", "gold"],
      ["adventure-1-flawless", "silver"],
      ["adventure-1-all-starters", "silver"],
      ["adventure-1-all-starters-hard", "platinum"],
      ["adventure-1-purist", "gold"],
      ["adventure-1-monotype", "silver"],
    ]);
  });

  it("battle 7 is the Metapod battle with its four rules", () => {
    const battle = getAdventure("pueblo-paleta-bosque-verde")!.battles[6];
    expect(battle.opponent.name).toBe("Teo");
    expect(battle.modifiers.map((m) => m.type)).toEqual(["prizeCount", "noPrizeFor", "opponentSetup", "bonusCards"]);
    expect(battle.modifiers.map((m) => describeModifier(m as BattleModifier))).toEqual([
      "Mesa a 1 premio por jugador",
      "Los Metapod del rival no dan premios",
      "El rival empieza con Metapod activo y 2 Metapod en la banca",
      "Empiezas con Pokémon Flute, Gust of Wind y PlusPower en la mano",
    ]);
  });
});

describe("validator", () => {
  it("rejects 9 battles", () => {
    expect(problemsOf((a) => a.battles.pop())).toContain("La aventura necesita 10 batallas con índices 1 a 10 (tiene 1, 2, 3, 4, 5, 6, 7, 8, 9)");
  });

  it("rejects a 19-card rival deck", () => {
    expect(problemsOf((a) => (a.battles[0].opponent.deck[3].qty = 11))).toContain(
      "Batalla 1: el mazo del rival tiene 19 cartas (debe tener entre 20 y 40)",
    );
  });

  it("rejects an unknown card id", () => {
    expect(problemsOf((a) => (a.battles[1].opponent.deck[0].cardId = "base-set-999-missingno"))).toContain(
      "Batalla 2, mazo del rival: carta desconocida base-set-999-missingno",
    );
  });

  it("requires a known rarity on every treasure and the offer weights", () => {
    expect(problemsOf((a) => delete a.treasures[0].rarity)).toEqual([expect.stringMatching(/^treasures\.0\.rarity: /)]);
    expect(problemsOf((a) => (a.treasures[6].rarity = "legendary"))).toEqual([expect.stringMatching(/^treasures\.6\.rarity: /)]);
    expect(problemsOf((a) => delete a.treasureOffer)).toEqual([expect.stringMatching(/^treasureOffer: /)]);
    expect(problemsOf((a) => (a.treasureOffer.rarityWeights.epic = 0))).toEqual([expect.stringMatching(/^treasureOffer\.rarityWeights\.epic: /)]);
    expect(problemsOf((a) => delete a.treasureOffer.maxPassives)).toEqual([expect.stringMatching(/^treasureOffer\.maxPassives: /)]);
  });

  it("rejects a pool with a missing treasure", () => {
    expect(problemsOf((a) => a.treasurePools.tier2.push("t2-nada"))).toContain("Pool tier2: tesoro desconocido t2-nada");
  });

  it("rejects a hard battle-10 deck missing a starter", () => {
    expect(problemsOf((a) => delete a.battles[9].opponent.deckByDifficulty.hard.byStarter.squirtle)).toContain(
      "Batalla 10: falta el mazo difícil para el inicial squirtle",
    );
  });

  it("rejects an unknown modifier type", () => {
    const problems = problemsOf((a) => a.battles[0].modifiers.push({ type: "doublePrizes" }));
    expect(problems.some((p) => p.startsWith("battles.0.modifiers.0:"))).toBe(true);
  });

  it("rejects an opponentSetup Metapod over a Weedle", () => {
    expect(
      problemsOf((a) => {
        a.battles[6].opponent.deck.push({ cardId: "base-set-069-weedle", qty: 1 });
        a.battles[6].opponent.deck[7].qty = 20;
        a.battles[6].modifiers[2].active = ["base-set-069-weedle", "base-set-054-metapod"];
      }),
    ).toContain("Batalla 7, opponentSetup: Metapod no evoluciona de Weedle");
  });

  it("rejects an opponentSetup card missing from the rival deck", () => {
    expect(
      problemsOf((a) => {
        a.battles[6].opponent.deck[1].qty = 2; // 3 Metapod in play, 2 in the deck
        a.battles[6].opponent.deck[7].qty = 23;
      }),
    ).toContain("Batalla 7, opponentSetup: el mazo del rival tiene 2 Metapod y la mesa pide 3");
  });

  it("rejects a starter deck over the maximum and a copy limit when rules set one", () => {
    expect(problemsOf((a) => (a.starters[0].deck[6].qty = 28))).toContain("Inicial charmander: el mazo tiene 41 cartas (debe tener entre 20 y 40)");
    expect(problemsOf((a) => (a.rules.maxCopies = 3))).toContain("Inicial charmander: más de 3 copias de Charmander");
  });

  it("lists every problem at once", () => {
    const problems = problemsOf((a) => {
      a.battles[0].opponent.deck[0].cardId = "nope";
      a.treasurePools.tier1.push("t1-nada");
    });
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("describeModifier", () => {
  const cases: [BattleModifier, string][] = [
    [{ type: "prizeCount", player: 1, opponent: 1 }, "Mesa a 1 premio por jugador"],
    [{ type: "prizeCount", player: 2, opponent: 2 }, "Mesa a 2 premios por jugador"],
    [{ type: "prizeCount", player: 1, opponent: 2 }, "Premios: tú 1, el rival 2"],
    [{ type: "prizeCount", opponent: 4 }, "El rival juega con 4 premios"],
    [{ type: "openingHand", opponent: 9 }, "El rival empieza con 9 cartas en la mano"],
    [{ type: "openingHand", player: 5, opponent: 9 }, "Mano inicial: tú 5 cartas, el rival 9"],
    [{ type: "noPrizeFor", side: "player", names: ["Magikarp", "Caterpie"] }, "Tus Magikarp y Caterpie no dan premios"],
    [
      { type: "bonusCards", side: "opponent", cards: [{ cardId: "base-set-084-pluspower", qty: 2 }], to: "hand" },
      "El rival empieza con 2 PlusPower en la mano",
    ],
    [{ type: "opponentSetup", active: ["base-set-056-onix"], bench: [] }, "El rival empieza con Onix activo"],
    [{ type: "opponentPassives", passives: ["start_attached_energy", "lucky_coin"] }, "El rival tiene Arranque rápido y Moneda de la suerte"],
  ];
  it.each(cases)("%j", (modifier, line) => {
    expect(describeModifier(modifier)).toBe(line);
  });
});
