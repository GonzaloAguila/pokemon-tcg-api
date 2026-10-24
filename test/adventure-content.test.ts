import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAdventure, getAdventures, validateAdventure } from "../src/modules/adventure/content/load.js";
import { isPokemonCard } from "@gonzaloaguila/game-core";
import { cardOf, isBasicPokemonCard } from "../src/modules/adventure/content/cards.js";
import { battleModifiers, battleObjective, difficultyRules, rivalDeckOf, withOpeningBench } from "../src/modules/adventure/content/difficulty.js";
import { describeModifier } from "../src/modules/adventure/content/modifiers.js";
import { ADVENTURE_CARD_BACKS, ADVENTURE_PLAYMATS } from "../src/modules/prizes/catalog.js";
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
    expect(adventure?.name).toBe("El Comienzo");
    expect(adventure?.entryCost).toBeUndefined();
    expect(adventure?.requires).toBeUndefined();
    for (const a of adventure!.achievements) expect(a.description).not.toContain("Pueblo Paleta");
  });

  it("has the spec's rules, starters, battles and pools", () => {
    const adventure = getAdventure("pueblo-paleta-bosque-verde")!;
    expect(adventure.rules).toEqual({ hearts: 3, prizeCount: 3, openingHand: 7, minDeckSize: 20, maxDeckSize: 40, maxCopies: null });
    expect(adventure.starters.map((s) => s.id)).toEqual(["charmander", "squirtle", "bulbasaur"]);
    for (const starter of adventure.starters) expect(sum(starter.deck)).toBe(24);
    expect(adventure.battles.map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sizes = adventure.battles.map((b) => (b.opponent.deck ? sum(b.opponent.deck) : sum(b.opponent.deckByDifficulty!.normal)));
    expect(sizes).toEqual([20, 20, 20, 20, 20, 20, 40, 20, 20, 24]);
    const hard10 = adventure.battles[9].opponent.deckByDifficulty!.hard;
    if (Array.isArray(hard10)) throw new Error("battle 10's hard decks are by starter");
    expect(Object.values(hard10.byStarter).map(sum)).toEqual([28, 28, 29]);
    expect(adventure.battles.map((b) => b.treasurePool)).toEqual([
      "tier1", "tier1", "tier1", "tier1", "major", "tier2", "tier2", "tier2", "tier2", null,
    ]);
    expect(adventure.achievements.map((a) => [a.id, a.tier])).toEqual([
      ["adventure-1-clear-normal", "bronze"],
      ["adventure-1-clear-hard", "platinum"],
      ["adventure-1-flawless", "silver"],
      ["adventure-1-all-starters", "silver"],
      ["adventure-1-all-starters-hard", "platinum"],
      ["adventure-1-purist", "gold"],
      ["adventure-1-monotype", "silver"],
    ]);
  });

  it("battle 7 is the Metapod battle with its four rules (normal: a Caterpie to reach; hard: only Metapods, no free Caterpie)", () => {
    const battle = getAdventure("pueblo-paleta-bosque-verde")!.battles[6];
    expect(battle.opponent.name).toBe("Teo");
    expect(battle.modifiers.map((m) => m.type)).toEqual(["prizeCount", "noPrizeFor", "opponentSetup", "bonusCards"]);
    expect(battle.modifiers.map((m) => describeModifier(m as BattleModifier))).toEqual([
      "Premios: tú 1, el rival 2",
      "Los Metapod del rival no dan premios",
      "El rival empieza con Metapod activo y Caterpie en la banca",
      "Empiezas con Pokémon Flute, Gust of Wind y PlusPower en la mano",
    ]);
    expect(battleModifiers(battle, "hard", "charmander").map(describeModifier)).toEqual([
      "Premios: tú 1, el rival 2",
      "Los Metapod del rival no dan premios",
      "El rival empieza con Metapod activo y 2 Metapod en la banca",
      "Empiezas con Pokémon Flute, Gust of Wind y PlusPower en la mano",
    ]);
    // Hard: the deck's 3 Caterpie are under the Metapods (a Prize means knocking out a Metapod first)
    const hardDeck = rivalDeckOf(battle, "hard", "charmander")!;
    expect(hardDeck.find((e) => e.cardId === "base-set-045-caterpie")!.qty).toBe(3);
    for (const difficulty of ["normal", "hard"] as const) {
      expect(battleObjective(battle, difficulty)).toBe("Los Metapod del rival no dan premios: consigue tu premio de otra forma.");
    }
  });

  it("hard mode: 2 hearts, its own decks and rules in every battle, its own treasure pools and weights", () => {
    const adventure = getAdventure("pueblo-paleta-bosque-verde")!;
    expect(difficultyRules(adventure, "normal")).toMatchObject({ hearts: 3, treasurePools: adventure.treasurePools, treasureOffer: adventure.treasureOffer });
    const hard = difficultyRules(adventure, "hard");
    expect(hard.hearts).toBe(2);
    expect(hard.treasureOffer).toEqual({ rarityWeights: { common: 4, rare: 4, epic: 2 }, maxPassives: 1 });
    for (const d of ["normal", "hard"] as const) expect(adventure.difficulties[d].description.length).toBeGreaterThan(10);

    // Every battle has a hard deck of its own (battle 10: one per starter), with more evolutions
    const evolutions = (deck: { cardId: string; qty: number }[]) =>
      deck.filter((e) => isPokemonCard(cardOf(e.cardId)) && !isBasicPokemonCard(cardOf(e.cardId))).reduce((n, e) => n + e.qty, 0);
    for (const battle of adventure.battles) {
      const normal = rivalDeckOf(battle, "normal", "charmander")!;
      for (const starter of adventure.starters) {
        const hardDeck = rivalDeckOf(battle, "hard", starter.id)!;
        // A deck of its own, or (battle 7) the same deck behind harder rules
        const differs =
          JSON.stringify(hardDeck) !== JSON.stringify(normal) || JSON.stringify(battleModifiers(battle, "hard", starter.id)) !== JSON.stringify(battle.modifiers);
        expect(differs).toBe(true);
        expect(evolutions(hardDeck)).toBeGreaterThanOrEqual(evolutions(normal));
      }
    }
    // Boss rules: the rival plays with one Prize fewer in battles 5, 8, 9 and 10 (hard only), and the board says so
    for (const index of [5, 8, 9, 10]) {
      const battle = adventure.battles[index - 1];
      for (const starter of adventure.starters) expect(battleModifiers(battle, "hard", starter.id)).toContainEqual({ type: "prizeCount", opponent: 2 });
      expect(battleModifiers(battle, "normal", "charmander").some((m) => m.type === "prizeCount")).toBe(false);
      expect(battleObjective(battle, "hard")).toBe("El rival gana con 2 premios: cuida a tus Pokémon.");
      expect(battleObjective(battle, "normal")).toBeNull();
    }
    // Hard rivals never start alone: an Active and at least one Benched Pokémon in every battle
    for (const battle of adventure.battles) {
      for (const starter of adventure.starters) {
        const setup = battleModifiers(battle, "hard", starter.id).find((m) => m.type === "opponentSetup");
        expect(setup !== undefined && setup.bench.length > 0, `batalla ${battle.index}, ${starter.id}`).toBe(true);
      }
    }
    // The final rival leads with its own starter line and a second Pokémon on the Bench, in both difficulties
    const final = adventure.battles[9];
    const leadOf = (starterId: string) =>
      (battleModifiers(final, "hard", starterId).find((m) => m.type === "opponentSetup") as { active: string[] }).active[0];
    expect(adventure.starters.map((s) => leadOf(s.id))).toEqual(["base-set-063-squirtle", "base-set-044-bulbasaur", "base-set-046-charmander"]);
    expect(battleModifiers(final, "normal", "charmander").map(describeModifier)).toEqual(["El rival empieza con Pidgey activo y Rattata en la banca"]);

    // No "easy" treasures in hard: no Potion packs, no Arranque rápido before battle 6
    const pools = hard.treasurePools;
    for (const id of [...pools.tier1, ...pools.major, ...pools.tier2]) expect(["t1-pociones", "t2-superpocion"]).not.toContain(id);
    expect([...pools.tier1, ...pools.major]).not.toContain("t1-energia");
    const epics = (ids: string[]) => ids.filter((id) => adventure.treasures.find((t) => t.id === id)!.rarity === "epic").length;
    expect(epics(pools.tier2)).toBeGreaterThan(epics(adventure.treasurePools.tier2));
  });

  it("Esta vez en serio is platinum and grants the Ciudad Plateada playmat", () => {
    const achievement = getAdventure("pueblo-paleta-bosque-verde")!.achievements.find((a) => a.id === "adventure-1-clear-hard")!;
    expect(achievement).toMatchObject({ tier: "platinum", cosmetic: { type: "playmat", id: "playmat-ciudad-plateada" } });
    expect(ADVENTURE_PLAYMATS.map((p) => p.itemId)).toContain("playmat-ciudad-plateada");
  });
});

describe("every adventure rival starts with an Active and a Benched Pokémon (owner, 2026-10-24)", () => {
  it("in every battle of every adventure, difficulty and starter", () => {
    for (const adventure of getAdventures().values()) {
      for (const battle of adventure.battles) {
        for (const difficulty of ["normal", "hard"] as const) {
          for (const starter of adventure.starters) {
            const setup = battleModifiers(battle, difficulty, starter.id).find((m) => m.type === "opponentSetup");
            const where = `${adventure.id} batalla ${battle.index} (${difficulty}, ${starter.id})`;
            expect(setup?.active.length, where).toBeGreaterThanOrEqual(1);
            expect(setup?.bench.length, where).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });

  const deck = (...entries: [string, number][]) => entries.map(([cardId, qty]) => ({ cardId, qty }));
  const RATTATA = "base-set-061-rattata", PIDGEY = "base-set-057-pidgey", RATICATE = "base-set-040-raticate", POTION = "base-set-094-potion";

  it("no setup: the lead is the Active when it is a Basic, the deck's next Basic goes to the Bench", () => {
    expect(withOpeningBench([], PIDGEY, deck([RATTATA, 3], [PIDGEY, 2], [POTION, 1]))).toEqual([
      { type: "opponentSetup", active: [PIDGEY], bench: [[RATTATA]] },
    ]);
  });

  it("an evolved lead: the deck's first Basic is the Active; a single Basic species fills the Bench with a second copy", () => {
    expect(withOpeningBench([], RATICATE, deck([RATTATA, 2], [RATICATE, 1]))).toEqual([
      { type: "opponentSetup", active: [RATTATA], bench: [[RATTATA]] },
    ]);
  });

  it("a setup without a Bench gets one Benched Basic the setup doesn't use; a setup with a Bench stays as it is", () => {
    const noBench = { type: "opponentSetup" as const, active: [RATTATA, RATICATE], bench: [] };
    expect(withOpeningBench([noBench], RATICATE, deck([RATTATA, 1], [RATICATE, 1], [PIDGEY, 2]))).toEqual([{ ...noBench, bench: [[PIDGEY]] }]);
    const withBench = { type: "opponentSetup" as const, active: [RATTATA], bench: [[PIDGEY]] };
    expect(withOpeningBench([withBench], RATTATA, deck([RATTATA, 1], [PIDGEY, 1]))).toEqual([withBench]);
  });

  it("a deck with a single Basic card keeps the battle as it is (nothing to put on the Bench)", () => {
    expect(withOpeningBench([], RATTATA, deck([RATTATA, 1], [RATICATE, 2]))).toEqual([
      { type: "opponentSetup", active: [RATTATA], bench: [] },
    ]);
  });
});

describe("Adventure 2 content", () => {
  const ADV2 = "ciudad-plateada-ciudad-celeste";
  const FILE2 = path.resolve(__dirname, `../content/adventures/${ADV2}.json`);
  const adventure2 = () => getAdventure(ADV2)!;

  it("loads both adventures, El Comienzo first, adventure 2 costs 20 and requires Brock", () => {
    const result = validateAdventure(JSON.parse(readFileSync(FILE2, "utf8")));
    expect(result.ok ? [] : result.problems).toEqual([]);
    expect([...getAdventures().keys()]).toEqual(["pueblo-paleta-bosque-verde", ADV2]);
    expect(getAdventure("pueblo-paleta-bosque-verde")!.name).toBe("El Comienzo");
    const adventure = adventure2();
    expect(adventure).toMatchObject({
      name: "Camino a Ciudad Celeste",
      order: 2,
      image: "/adventures/ciudad-plateada-ciudad-celeste.jpg",
      entryCost: 20,
      requires: { type: "gymLeader", leaderId: "brock" },
    });
    expect(adventure.rules).toEqual({ hearts: 3, prizeCount: 3, openingHand: 7, minDeckSize: 20, maxDeckSize: 40, maxCopies: null });
  });

  it("starters: adventure 1's three improved plus a locked Pikachu, 24–28 cards each, no Stage 2", () => {
    const adventure = adventure2();
    expect(adventure.starters.map((s) => [s.id, !!s.requiresUnlock])).toEqual([
      ["charmander", false], ["squirtle", false], ["bulbasaur", false], ["pikachu", true],
    ]);
    for (const starter of adventure.starters) {
      expect(sum(starter.deck), starter.id).toBeGreaterThanOrEqual(24);
      expect(sum(starter.deck), starter.id).toBeLessThanOrEqual(28);
      // The Stage 1 is in the deck, the Stage 2 only comes from treasures (owner, 2026-10-24)
      expect(starter.deck.some((e) => e.cardId === starter.line.stage1), starter.id).toBe(true);
      expect(starter.deck.some((e) => e.cardId === starter.line.stage2), starter.id).toBe(false);
      expect(starter.deck.some((e) => e.cardId === "base-set-088-professor-oak"), starter.id).toBe(true);
    }
  });

  it("battles: sprites, Team Rocket steals at 6 and 9, the fixed offers at 3 and 7, the Zubat ambush at 4", () => {
    const { battles, treasures } = adventure2();
    expect(battles.map((b) => b.opponent.sprite)).toEqual(
      ["youngster", "lass", "magikarp-salesman", "hiker", "scientist", "jessie-james", "supernerd", "fisherman", "jessie-james", "rival-blue"].map(
        (n) => `/sprites/adventure/trainers/${n}.png`,
      ),
    );
    expect(battles.map((b) => b.opponent.trainerClass)).toEqual([
      "Joven", "Chica", "Vendedor", "Montañero", "Científico", "Team Rocket", "Súper Nerd", "Pescador", "Team Rocket", "Rival",
    ]);
    expect(battles[4].opponent.name).toBe("Seymour");
    expect(battles[5].opponent.name).toBe("Jessie y James");
    expect(battles[6].opponent.name).toBe("Miguel");
    expect(battles[7].opponent.name).toBe("Pedro");
    expect(battles[8].opponent.name).toBe("Jessie y James");
    const steal = { type: "stealCards", count: 2, countByDifficulty: { hard: 3 } };
    expect(battles.map((b) => b.onLoss ?? null)).toEqual([null, null, null, null, null, steal, null, null, steal, null]);
    expect(battles.map((b) => b.onWin ?? null)).toEqual([null, null, null, null, null, null, null, null, { type: "recoverStolen" }, null]);

    const cardsOf = (id: string) => {
      const t = treasures.find((x) => x.id === id)!;
      return t.kind === "cards" ? t.cards.map((c) => ("cardId" in c ? c.cardId : c.ref)) : [];
    };
    expect(cardsOf(battles[2].fixedOffer![0])).toEqual(expect.arrayContaining(["base-set-035-magikarp", "base-set-006-gyarados"]));
    expect(battles[6].fixedOffer!.map(cardsOf)).toEqual([
      expect.arrayContaining(["fossil-062-mysterious-fossil", "fossil-052-omanyte", "fossil-040-omastar"]),
      expect.arrayContaining(["fossil-062-mysterious-fossil", "fossil-050-kabuto", "fossil-009-kabutops"]),
    ]);
    for (const difficulty of ["normal", "hard"] as const) {
      const setup = battleModifiers(battles[3], difficulty, "charmander").find((m) => m.type === "opponentSetup");
      expect(setup?.bench.flat().filter((id) => cardOf(id).name === "Zubat").length, difficulty).toBeGreaterThanOrEqual(1);
    }
    for (const battle of battles) expect(battle.objective ?? battle.objectiveByDifficulty, `batalla ${battle.index}`).toBeTruthy();
  });

  it("special battles: darkness in Monte Moon's cave (Montañero), always Confused at the Slowpoke lake, in both difficulties", () => {
    const { battles } = adventure2();
    const types = (index: number, difficulty: "normal" | "hard") => battleModifiers(battles[index - 1], difficulty, "charmander").map((m) => m.type);
    for (const difficulty of ["normal", "hard"] as const) {
      const special = battles.map((b) => types(b.index, difficulty).filter((t) => t === "darkness" || t === "alwaysConfused"));
      expect(special, difficulty).toEqual([[], [], [], ["darkness"], [], [], [], ["alwaysConfused"], [], []]);
    }
    expect(describeModifier({ type: "darkness" })).toBe("Oscuridad: antes de cada ataque se lanza una moneda; si sale cruz, el ataque falla");
    expect(describeModifier({ type: "alwaysConfused" })).toBe("Los dos Pokémon activos están confundidos todo el tiempo");
  });

  it("treasures: a family that isn't Colorless comes with 3 Energy of its type (owner, 2026-10-24)", () => {
    const { treasures } = adventure2();
    for (const treasure of treasures) {
      if (treasure.kind !== "cards") continue;
      const entries = treasure.cards.filter((c): c is { cardId: string; qty: number } => "cardId" in c);
      const energyOf = (type: string) =>
        entries.filter((c) => cardOf(c.cardId).kind === "energy" && (cardOf(c.cardId) as { energyType: string }).energyType === type).reduce((n, c) => n + c.qty, 0);
      for (const entry of entries) {
        const card = cardOf(entry.cardId);
        if (!isPokemonCard(card)) continue;
        const type = card.types[0];
        if (type === "colorless") continue;
        expect(energyOf(type), `${treasure.id}: ${card.name} (${type})`).toBe(3);
      }
    }
  });

  it("hard: evolved rival decks in every battle, one per starter at the final", () => {
    const adventure = adventure2();
    const evolutions = (deck: { cardId: string; qty: number }[]) =>
      deck.filter((e) => isPokemonCard(cardOf(e.cardId)) && !isBasicPokemonCard(cardOf(e.cardId))).reduce((n, e) => n + e.qty, 0);
    for (const battle of adventure.battles) {
      const normal = rivalDeckOf(battle, "normal", "charmander")!;
      for (const starter of adventure.starters) {
        const hard = rivalDeckOf(battle, "hard", starter.id)!;
        expect(evolutions(hard), `batalla ${battle.index}, ${starter.id}`).toBeGreaterThan(evolutions(normal));
      }
    }
    const hard10 = adventure.battles[9].opponent.deckByDifficulty!.hard;
    expect(Array.isArray(hard10) ? [] : Object.keys(hard10.byStarter)).toEqual(["charmander", "squirtle", "bulbasaur", "pikachu"]);
    expect(adventure.difficulties.hard.hearts).toBe(2);
  });

  it("rewards: the Monte Moon card back on normal, 1000 coins on hard; adventure-2 achievements with noSteal", () => {
    const adventure = adventure2();
    expect(adventure.rewards).toEqual({
      normal: { type: "cosmetic", cosmeticType: "cardBack", id: "cardback-monte-moon", name: "Dorso Monte Moon" },
      hard: { type: "coins", amount: 1000, name: "1000 monedas" },
    });
    expect(ADVENTURE_CARD_BACKS).toContainEqual({ itemId: "cardback-monte-moon", name: "Monte Moon", imageUrl: "/card-backs/card-back-monte-moon.jpg" });
    expect(adventure.achievements.map((a) => [a.id, a.tier, a.condition.type])).toEqual([
      ["adventure-2-clear-normal", "bronze", "clear"],
      ["adventure-2-clear-hard", "platinum", "clear"],
      ["adventure-2-flawless", "silver", "flawless"],
      ["adventure-2-all-starters", "silver", "allStarters"],
      ["adventure-2-all-starters-hard", "platinum", "allStarters"],
      ["adventure-2-purist", "gold", "purist"],
      ["adventure-2-monotype", "silver", "monotype"],
      ["adventure-2-no-steal", "silver", "noSteal"],
    ]);
    expect(adventure.achievements.find((a) => a.condition.type === "noSteal")!.name).toBe("Ni una carta para el Team Rocket");
  });
});

describe("validator", () => {
  it("rejects 9 battles", () => {
    expect(problemsOf((a) => a.battles.pop())).toContain("La aventura necesita 10 batallas con índices 1 a 10 (tiene 1, 2, 3, 4, 5, 6, 7, 8, 9)");
  });

  it("rejects a 19-card rival deck", () => {
    expect(problemsOf((a) => (a.battles[0].opponent.deckByDifficulty.normal[3].qty = 11))).toContain(
      "Batalla 1: el mazo del rival (normal) tiene 19 cartas (debe tener entre 20 y 40)",
    );
    expect(problemsOf((a) => (a.battles[0].opponent.deckByDifficulty.hard[7].qty = 6))).toContain(
      "Batalla 1: el mazo del rival (difícil) tiene 19 cartas (debe tener entre 20 y 40)",
    );
  });

  it("rejects an unknown card id", () => {
    expect(problemsOf((a) => (a.battles[1].opponent.deckByDifficulty.normal[0].cardId = "base-set-999-missingno"))).toContain(
      "Batalla 2, mazo del rival (normal): carta desconocida base-set-999-missingno",
    );
    expect(problemsOf((a) => (a.battles[1].opponent.deckByDifficulty.hard[0].cardId = "base-set-999-missingno"))).toContain(
      "Batalla 2, mazo del rival (difícil): carta desconocida base-set-999-missingno",
    );
  });

  it("a battle with deckByDifficulty needs both decks; deck and deckByDifficulty can't go together", () => {
    expect(problemsOf((a) => delete a.battles[0].opponent.deckByDifficulty.hard).some((p) => p.startsWith("battles.0.opponent.deckByDifficulty.hard"))).toBe(true);
    expect(
      problemsOf((a) => (a.battles[0].opponent.deck = a.battles[0].opponent.deckByDifficulty.normal)).some((p) => p.includes("deck o deckByDifficulty")),
    ).toBe(true);
  });

  it("requires a description for each difficulty and validates the hard overrides", () => {
    expect(problemsOf((a) => delete a.difficulties)).toEqual([expect.stringMatching(/^difficulties: /)]);
    expect(problemsOf((a) => delete a.difficulties.hard.description)).toEqual([expect.stringMatching(/^difficulties\.hard\.description: /)]);
    expect(problemsOf((a) => (a.difficulties.hard.hearts = 0))).toEqual([expect.stringMatching(/^difficulties\.hard\.hearts: /)]);
    expect(problemsOf((a) => (a.difficulties.hard.treasureOffer.rarityWeights.epic = 0))).toEqual([
      expect.stringMatching(/^difficulties\.hard\.treasureOffer\.rarityWeights\.epic: /),
    ]);
    expect(problemsOf((a) => a.difficulties.hard.treasurePools.tier2.push("h2-nada"))).toContain("Pool difícil tier2: tesoro desconocido h2-nada");
  });

  it("checks a difficulty's own battle rules against its decks", () => {
    expect(problemsOf((a) => a.battles[1].modifiersByDifficulty.hard.push({ type: "opponentSetup", active: ["base-set-061-rattata"], bench: [] }))).toEqual(
      expect.arrayContaining(["Batalla 2 (difícil): modificador opponentSetup repetido"]),
    );
    expect(
      problemsOf((a) => (a.battles[1].modifiersByDifficulty.hard = [{ type: "opponentSetup", active: ["base-set-061-rattata"], bench: [] }])),
    ).toEqual(["Batalla 2, opponentSetup: el mazo del rival (difícil) tiene 0 Rattata y la mesa pide 1"]);
    expect(problemsOf((a) => (a.battles[3].modifiersByDifficulty.hard = [{ type: "noPrizeFor", side: "opponent", names: ["Missingno"] }]))).toContain(
      "Batalla 4 (difícil), noPrizeFor: ningún Pokémon se llama Missingno",
    );
    expect(problemsOf((a) => (a.battles[0].modifiersByDifficulty = { hard: [{ type: "doublePrizes" }] })).some((p) => p.startsWith("battles.0.modifiersByDifficulty.hard"))).toBe(true);
  });

  it("an achievement cosmetic must be an adventure cosmetic of that type", () => {
    expect(problemsOf((a) => (a.achievements[1].cosmetic = { type: "playmat", id: "stadium", name: "Estadio" }))).toEqual([
      "Logro adventure-1-clear-hard: cosmético de aventura desconocido playmat stadium",
    ]);
    expect(problemsOf((a) => (a.achievements[1].cosmetic = { type: "cardBack", id: "playmat-ciudad-plateada", name: "x" }))).toEqual([
      "Logro adventure-1-clear-hard: cosmético de aventura desconocido cardBack playmat-ciudad-plateada",
    ]);
    expect(problemsOf((a) => (a.achievements[1].cosmetic = { type: "emote", id: "x", name: "x" })).some((p) => p.startsWith("achievements.1.cosmetic.type"))).toBe(true);
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
        a.battles[6].opponent.deckByDifficulty.normal.push({ cardId: "base-set-069-weedle", qty: 1 });
        a.battles[6].opponent.deckByDifficulty.normal[7].qty = 20;
        a.battles[6].modifiers[2].active = ["base-set-069-weedle", "base-set-054-metapod"];
      }),
    ).toContain("Batalla 7, opponentSetup: Metapod no evoluciona de Weedle");
  });

  it("rejects an opponentSetup card missing from the rival deck (each difficulty's table vs its own deck)", () => {
    expect(
      problemsOf((a) => {
        a.battles[6].opponent.deckByDifficulty.hard[1].qty = 1; // hard: 3 Metapod in play, 1 in the deck
        a.battles[6].opponent.deckByDifficulty.hard[7].qty = 24;
      }),
    ).toEqual(["Batalla 7, opponentSetup: el mazo del rival (difícil) tiene 1 Metapod y la mesa pide 3"]);
    // Normal asks for 1 Metapod: 2 in its deck are fine (the hard deck keeps its 4)
    const ok = raw();
    ok.battles[6].opponent.deckByDifficulty.normal[1].qty = 2;
    ok.battles[6].opponent.deckByDifficulty.normal[7].qty = 23;
    const result = validateAdventure(ok);
    expect(result.ok ? [] : result.problems).toEqual([]);
  });

  it("rejects a starter deck over the maximum and a copy limit when rules set one", () => {
    expect(problemsOf((a) => (a.starters[0].deck[6].qty = 28))).toContain("Inicial charmander: el mazo tiene 41 cartas (debe tener entre 20 y 40)");
    expect(problemsOf((a) => (a.rules.maxCopies = 3))).toContain("Inicial charmander: más de 3 copias de Charmander");
  });

  it("lists every problem at once", () => {
    const problems = problemsOf((a) => {
      a.battles[0].opponent.deckByDifficulty.normal[0].cardId = "nope";
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

describe("Adventure 2 content fields", () => {
  const treasureId = () => raw().treasures[0].id as string;

  it("accepts entryCost, requires, image, order, onLoss, onWin, fixedOffer, sprite, a coins reward and a noSteal condition", () => {
    const data = raw();
    data.order = 2;
    data.entryCost = 500;
    data.requires = { type: "gymLeader", leaderId: "brock" };
    data.battles[0].onLoss = { type: "stealCards", count: 2, countByDifficulty: { hard: 3 } };
    data.battles[0].onWin = { type: "recoverStolen" };
    data.battles[0].fixedOffer = [data.treasures[0].id, data.treasures[1].id];
    data.battles[0].opponent.sprite = "/sprites/adventure/trainers/rival-1.png";
    data.rewards.normal = { type: "coins", amount: 300, name: "300 monedas" };
    data.achievements[0].condition = { type: "noSteal" };
    const result = validateAdventure(data);
    expect(result.ok ? [] : result.problems).toEqual([]);
  });

  it("rejects a fixedOffer naming an unknown treasure", () => {
    const problems = problemsOf((a) => (a.battles[0].fixedOffer = ["no-such-treasure"]));
    expect(problems.join("\n")).toContain("no-such-treasure");
  });

  it("rejects requires naming an unknown gym leader", () => {
    const problems = problemsOf((a) => (a.requires = { type: "gymLeader", leaderId: "nobody" }));
    expect(problems.join("\n")).toContain("nobody");
  });

  it.each([0, 6])("rejects stealCards count %i", (count) => {
    problemsOf((a) => (a.battles[0].onLoss = { type: "stealCards", count }));
  });

  it("rejects a missing order or image", () => {
    problemsOf((a) => delete a.order);
    problemsOf((a) => delete a.image);
    problemsOf((a) => (a.image = "/elsewhere/x.gif"));
  });

  it("uses a known treasure id fixture", () => {
    expect(treasureId()).toBeTruthy();
  });
});
