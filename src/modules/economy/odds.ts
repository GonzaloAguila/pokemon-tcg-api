/**
 * Real odds of the pack / wheel / slots generators, computed from the same definitions the
 * generators use (boosters.service slots and pools, WHEEL_SEGMENTS, slot pattern and symbol
 * weights), so the frontend can show them (GET /api/economy/odds).
 */

import { getAllPackOdds } from "../boosters/boosters.service.js";
import { WHEEL_SEGMENTS, WHEEL_SPIN_COST, type WheelPayload } from "../wheel/wheel.config.js";
import { PATTERN_WEIGHTS, SLOTS_SPIN_COST, SYMBOL_WEIGHTS, type SlotPattern, type SlotSymbol } from "../slots/slots.service.js";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

const RARITY_LABEL: Record<string, string> = {
  common: "común",
  uncommon: "poco común",
  rare: "rara (o holo)",
  "rare-holo": "holo",
};

function wheelPrizeLabel(payload: WheelPayload): string {
  switch (payload.type) {
    case "card":
      return `Carta Pokémon ${RARITY_LABEL[payload.rarityPool] ?? payload.rarityPool}`;
    case "coins":
      return `${payload.amount} monedas`;
    case "card_back":
      return "Dorso de carta al azar";
    case "collectible_coin":
      return "Moneda coleccionable al azar";
    case "avatar":
      return "Avatar al azar";
    case "free_pack":
      return "Sobre gratis (set al azar)";
    case "spin_again":
      return `+${payload.bonusCoins} monedas y un giro gratis`;
    case "jackpot":
      return "Jackpot: 1.000 monedas + carta holo + variante al azar + 1 Caramelo Raro + 100 cupones";
    case "nothing":
      return "Nada";
  }
}

const PATTERN_PRIZES: Record<SlotPattern, string> = {
  full_grid: "Mega jackpot: carta holo + 300 monedas + dorso + moneda coleccionable + variante + sobre + 1 Caramelo Raro + 100 cupones",
  pokeball: "Sobre gratis (set al azar)",
  cross: "Carta Pokémon rara (2/3) u holo (1/3)",
  x_pattern: "200, 250 o 300 monedas",
  corners: "Moneda coleccionable al azar",
  diagonal: "Carta Pokémon poco común (2/3) o rara (1/3)",
  horizontal: "Según el símbolo de la línea",
  vertical: "Según el símbolo de la línea",
  none: "Nada",
};

const LINE_PRIZES: Record<"horizontal" | "vertical", Partial<Record<SlotSymbol, string>>> = {
  horizontal: {
    card: "Carta Pokémon común (2/3) o poco común (1/3)",
    coins: "75, 100 o 150 monedas",
    card_back: "Dorso de carta al azar",
    overlay: "Variante al azar",
    playmat: "Tapete al azar",
  },
  vertical: {
    card: "Dorso o moneda coleccionable (50/50)",
    coins: "50, 75 o 100 monedas",
    card_back: "Dorso de carta al azar",
    overlay: "Dorso o moneda coleccionable (50/50)",
    playmat: "Tapete al azar",
  },
};

export function getOdds() {
  const wheelTotal = WHEEL_SEGMENTS.reduce((n, s) => n + s.weight, 0);
  const patternTotal = PATTERN_WEIGHTS.reduce((n, p) => n + p.weight, 0);
  const lineSymbols = SYMBOL_WEIGHTS.filter((s) => s.value !== "nothing");
  const lineTotal = lineSymbols.reduce((n, s) => n + s.weight, 0);

  return {
    packs: getAllPackOdds(),
    wheel: {
      cost: WHEEL_SPIN_COST,
      segments: WHEEL_SEGMENTS.map((s) => ({
        id: s.id,
        probability: round(s.weight / wheelTotal),
        prize: wheelPrizeLabel(s.payload),
      })),
    },
    slots: {
      cost: SLOTS_SPIN_COST,
      patterns: PATTERN_WEIGHTS.map((p) => ({
        pattern: p.value,
        probability: round(p.weight / patternTotal),
        prize: PATTERN_PRIZES[p.value],
        ...(p.value === "horizontal" || p.value === "vertical"
          ? {
              bySymbol: lineSymbols.map((s) => ({
                symbol: s.value,
                probability: round(s.weight / lineTotal),
                prize: LINE_PRIZES[p.value as "horizontal" | "vertical"][s.value] ?? "Nada",
              })),
            }
          : {}),
      })),
    },
  };
}
