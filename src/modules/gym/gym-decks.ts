/**
 * The decks the leaders play (docs/gym-leaders.md): an admin may replace a version's content
 * default with their own list (GymLeaderDeck row, one per leader and mode); battles that start
 * afterwards play it. The challenger's rules never apply to the leader's deck: only real card ids,
 * positive quantities and exactly 60 cards.
 */
import { findCardById } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { leaderDeck, type CardEntry, type GymLeaderDef, type GymMode } from "./content/index.js";

export const LEADER_DECK_SIZE = 60;

export interface LeaderDeckView {
  cards: CardEntry[];
  /** No saved deck: the content default. */
  isDefault: boolean;
  /** ISO, null for the default. */
  updatedAt: string | null;
}

/** Same card twice in a list: summed (one entry per card id). */
function merge(cards: readonly CardEntry[]): CardEntry[] {
  const byId = new Map<string, number>();
  for (const { cardId, qty } of cards) byId.set(cardId, (byId.get(cardId) ?? 0) + qty);
  return [...byId].map(([cardId, qty]) => ({ cardId, qty }));
}

/** Why the list can't be a leader's deck (Spanish), or null. */
export function leaderDeckError(cards: readonly CardEntry[]): string | null {
  const unknown = cards.find((entry) => !findCardById(entry.cardId));
  if (unknown) return `Carta desconocida: ${unknown.cardId}`;
  if (cards.some((entry) => !Number.isInteger(entry.qty) || entry.qty < 1)) return "Cada carta debe tener al menos 1 copia";
  const total = cards.reduce((sum, entry) => sum + entry.qty, 0);
  if (total !== LEADER_DECK_SIZE) return `El mazo debe tener exactamente ${LEADER_DECK_SIZE} cartas (tiene ${total})`;
  return null;
}

/** The saved row's list, when it is still a valid deck (a card removed from game-core: the default). */
function savedCards(row: { cards: unknown } | null): CardEntry[] | null {
  if (!row || !Array.isArray(row.cards)) return null;
  const cards = (row.cards as unknown[]).filter(
    (e): e is CardEntry => !!e && typeof (e as CardEntry).cardId === "string" && typeof (e as CardEntry).qty === "number",
  );
  return cards.length === row.cards.length && !leaderDeckError(cards) ? cards.map((e) => ({ cardId: e.cardId, qty: e.qty })) : null;
}

/** The deck a battle starting now plays: the saved one, else the content default (undefined: no such version). */
export async function battleDeck(leader: GymLeaderDef, mode: GymMode): Promise<CardEntry[] | undefined> {
  const fallback = leaderDeck(leader, mode);
  if (!fallback) return undefined;
  const row = await prisma.gymLeaderDeck.findUnique({ where: { leaderId_mode: { leaderId: leader.id, mode } }, select: { cards: true } });
  const saved = savedCards(row);
  if (row && !saved) console.error(`[gym] the saved ${leader.id} ${mode} deck is no longer valid: playing the default`);
  return (saved ?? fallback).map((e) => ({ ...e }));
}

/** GET /admin/gyms/:leaderId/decks/:mode. */
export async function getLeaderDeck(leader: GymLeaderDef, mode: GymMode): Promise<LeaderDeckView> {
  const fallback = leaderDeck(leader, mode);
  if (!fallback) throw Errors.NotFound("Versión del gimnasio");
  const row = await prisma.gymLeaderDeck.findUnique({ where: { leaderId_mode: { leaderId: leader.id, mode } } });
  const saved = savedCards(row);
  if (row && saved) return { cards: saved, isDefault: false, updatedAt: row.updatedAt.toISOString() };
  return { cards: fallback.map((e) => ({ ...e })), isDefault: true, updatedAt: null };
}

/** PUT /admin/gyms/:leaderId/decks/:mode: validated (400 in Spanish), saved for the next battles. */
export async function saveLeaderDeck(leader: GymLeaderDef, mode: GymMode, input: CardEntry[], adminId: string): Promise<LeaderDeckView> {
  if (!leaderDeck(leader, mode)) throw Errors.NotFound("Versión del gimnasio");
  const cards = merge(input);
  const error = leaderDeckError(cards);
  if (error) throw Errors.BadRequest(error);
  const row = await prisma.gymLeaderDeck.upsert({
    where: { leaderId_mode: { leaderId: leader.id, mode } },
    create: { leaderId: leader.id, mode, cards, updatedById: adminId },
    update: { cards, updatedById: adminId },
  });
  return { cards, isDefault: false, updatedAt: row.updatedAt.toISOString() };
}

/** DELETE /admin/gyms/:leaderId/decks/:mode: back to the content default. */
export async function resetLeaderDeck(leader: GymLeaderDef, mode: GymMode): Promise<LeaderDeckView> {
  if (!leaderDeck(leader, mode)) throw Errors.NotFound("Versión del gimnasio");
  await prisma.gymLeaderDeck.deleteMany({ where: { leaderId: leader.id, mode } });
  return getLeaderDeck(leader, mode);
}

/** Which versions have a saved deck (admin rows): "leaderId:mode" → updatedAt. */
export async function savedDeckDates(): Promise<Map<string, Date>> {
  const rows = await prisma.gymLeaderDeck.findMany({ select: { leaderId: true, mode: true, updatedAt: true } });
  return new Map(rows.map((r) => [`${r.leaderId}:${r.mode}`, r.updatedAt]));
}
