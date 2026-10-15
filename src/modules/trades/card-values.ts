/**
 * Points of each card in trades. An admin sets them card by card (backoffice "Puntos de
 * cartas"); cards without a value are worth ECONOMY.trades.valueByRarity. The values live in
 * `card_values` and in memory (one API process): loaded at startup, reloaded on every change.
 */

import { CARD_SETS, findCardById, getSetById, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { ECONOMY } from "../economy/config.js";

/** Most points a card can be given. */
export const MAX_CARD_POINTS = 1000;

let customPoints = new Map<string, number>();

/** Read every admin-set value into memory (startup, after a change). */
export async function loadCardValues(): Promise<void> {
  const rows = await prisma.cardValue.findMany({ select: { cardDefId: true, points: true } });
  customPoints = new Map(rows.map((r) => [r.cardDefId, r.points]));
}

/** Points by rarity, for a card without an admin-set value (null: not tradable). */
export function defaultCardPoints(cardDefId: string): number | null {
  const card = findCardById(cardDefId);
  if (!card || isBasicEnergy(card)) return null;
  return ECONOMY.trades.valueByRarity[card.rarity] ?? null;
}

/** Trade value of one copy, or null when the card can't be traded (unknown, basic Energy). */
export function cardTradeValue(cardDefId: string): number | null {
  const fallback = defaultCardPoints(cardDefId);
  if (fallback === null) return null;
  return customPoints.get(cardDefId) ?? fallback;
}

/** Every tradable card of a set with its points (backoffice). */
export function listSetCardValues(setId: string) {
  const set = getSetById(setId);
  if (!set) throw Errors.BadRequest("Expansión desconocida");
  return set.cards
    .filter((card) => !isBasicEnergy(card))
    .map((card) => ({
      cardDefId: card.id,
      name: card.name,
      kind: card.kind,
      rarity: card.rarity,
      points: cardTradeValue(card.id) ?? 0,
      defaultPoints: defaultCardPoints(card.id) ?? 0,
      custom: customPoints.has(card.id),
    }));
}

export function listCardValueSets() {
  return CARD_SETS.map((set) => ({ id: set.id, name: set.name }));
}

/** Set (points) or reset to the rarity default (null) the value of some cards. */
export async function setCardValues(adminId: string, values: { cardDefId: string; points: number | null }[]): Promise<void> {
  for (const { cardDefId, points } of values) {
    if (defaultCardPoints(cardDefId) === null) throw Errors.BadRequest(`Esa carta no se intercambia: ${cardDefId}`);
    if (points !== null && (!Number.isInteger(points) || points < 1 || points > MAX_CARD_POINTS)) {
      throw Errors.BadRequest(`Los puntos van de 1 a ${MAX_CARD_POINTS}`);
    }
  }
  await prisma.$transaction(
    values.map(({ cardDefId, points }) =>
      points === null
        ? prisma.cardValue.deleteMany({ where: { cardDefId } })
        : prisma.cardValue.upsert({
            where: { cardDefId },
            update: { points, updatedById: adminId },
            create: { cardDefId, points, updatedById: adminId },
          }),
    ),
  );
  await loadCardValues();
}
