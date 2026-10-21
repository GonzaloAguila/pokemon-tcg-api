/**
 * Spanish lines for the battle modifiers ("Reglas de la mesa"), shown before a battle, in the run
 * bar and on the battle screen. One line per modifier, speaking to the player (tú).
 */
import type { AdventurePassive, BattleModifier, CardEntry } from "../engine-types.js";
import { cardName, joinSpanish } from "./cards.js";

export const PASSIVE_NAMES: Record<AdventurePassive, string> = {
  lucky_coin: "Moneda de la suerte",
  start_attached_energy: "Arranque rápido",
  opening_hand_plus_1: "Mano preparada",
  prize_minus_one: "Atajo",
  extra_heart: "Corazón extra",
};

const premios = (n: number) => `${n} ${n === 1 ? "premio" : "premios"}`;

/** "Pokémon Flute, Gust of Wind y PlusPower" / "2 PlusPower". */
function cardList(cards: readonly CardEntry[]): string {
  return joinSpanish(cards.map((c) => (c.qty > 1 ? `${c.qty} ${cardName(c.cardId)}` : cardName(c.cardId))));
}

/** Names of the top cards of evolution chains, grouped: ["Caterpie", "2 Metapod"]. */
function chainTops(chains: readonly string[][]): string[] {
  const counts = new Map<string, number>();
  for (const chain of chains) {
    const name = cardName(chain[chain.length - 1]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${n} ${name}` : name));
}

export function describeModifier(modifier: BattleModifier): string {
  switch (modifier.type) {
    case "prizeCount": {
      const { player, opponent } = modifier;
      if (player !== undefined && opponent !== undefined) {
        return player === opponent ? `Mesa a ${premios(player)} por jugador` : `Premios: tú ${player}, el rival ${opponent}`;
      }
      return player !== undefined ? `Juegas con ${premios(player)}` : `El rival juega con ${premios(opponent!)}`;
    }
    case "openingHand": {
      const { player, opponent } = modifier;
      if (player !== undefined && opponent !== undefined) {
        return player === opponent
          ? `Mano inicial de ${player} cartas para los dos`
          : `Mano inicial: tú ${player} cartas, el rival ${opponent}`;
      }
      return player !== undefined
        ? `Empiezas con ${player} cartas en la mano`
        : `El rival empieza con ${opponent} cartas en la mano`;
    }
    case "noPrizeFor": {
      const names = joinSpanish(modifier.names);
      return modifier.side === "opponent" ? `Los ${names} del rival no dan premios` : `Tus ${names} no dan premios`;
    }
    case "bonusCards": {
      const cards = cardList(modifier.cards);
      return modifier.side === "player" ? `Empiezas con ${cards} en la mano` : `El rival empieza con ${cards} en la mano`;
    }
    case "opponentSetup": {
      const active = chainTops([modifier.active]).join("");
      const bench = chainTops(modifier.bench);
      return bench.length > 0
        ? `El rival empieza con ${active} activo y ${joinSpanish(bench)} en la banca`
        : `El rival empieza con ${active} activo`;
    }
    case "opponentPassives":
      return `El rival tiene ${joinSpanish(modifier.passives.map((p) => PASSIVE_NAMES[p]))}`;
  }
}
