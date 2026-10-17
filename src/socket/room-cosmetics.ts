/**
 * Both players' cosmetics in a game room (playmat, coin, card back, card variants), read from
 * the DB once when the game starts and kept with the room, so rejoins and spectators see the
 * same ones. A cosmetic id is only used if the player still owns it (the free defaults always);
 * nothing a client sends is ever used.
 */
import { findCardById } from "@gonzaloaguila/game-core";
import { prisma } from "../lib/prisma.js";
import type { DeckCardEntry } from "../modules/decks/decks.service.js";
import type { GameRoom } from "./rooms.js";
import type { Viewer } from "./state-masking.js";

/** The free items every player has (users.service `updateCosmetics`). */
export const DEFAULT_COSMETICS = { playmatId: "field", coinId: "eevee", cardBackId: "default" } as const;

/** What the other side sees of a player: `gameStart.playerCosmetics` / `opponentCosmetics`. */
export interface PlayerCosmetics {
  playmatId: string;
  coinId: string;
  cardBackId: string;
}

export interface SeatCosmetics extends PlayerCosmetics {
  /** Card name → overlay id (deck entries' `variantId`), only skins the player owns. */
  variantMap: Record<string, string>;
}

export interface RoomCosmetics {
  player1: SeatCosmetics;
  player2: SeatCosmetics;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Skin id of a card name + overlay, as the market / prizes grant it: "alakazam-holo-sparkle". */
export function skinSlug(cardName: string, overlayId: string): string {
  return `${cardName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${overlayId}`;
}

/** The deck's variants (card name → overlay id), only those whose skin is in `ownedSkins`. */
export function buildOwnedVariantMap(entries: DeckCardEntry[], ownedSkins: ReadonlySet<string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.variantId) continue;
    const card = findCardById(entry.cardDefId);
    if (!card) continue;
    if (!ownedSkins.has(skinSlug(card.name, entry.variantId))) continue;
    map[card.name] = entry.variantId;
  }
  return map;
}

/** One player's active cosmetics (owned only) and the owned variants of their deck. */
export async function loadSeatCosmetics(userId: string | null, deckId: string | null): Promise<SeatCosmetics> {
  if (!userId) return { ...DEFAULT_COSMETICS, variantMap: {} };
  const deckEntries = async (): Promise<DeckCardEntry[]> => {
    // Theme decks (game-core ids) and drafted decks have no variants
    if (!deckId || !UUID_RE.test(deckId)) return [];
    const deck = await prisma.deck.findFirst({ where: { id: deckId, userId }, select: { cards: true } });
    return (deck?.cards ?? []) as unknown as DeckCardEntry[];
  };
  const [user, entries] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { activePlaymatId: true, activeCoinId: true, activeCardBackId: true },
    }),
    deckEntries(),
  ]);
  const playmatId = user?.activePlaymatId ?? DEFAULT_COSMETICS.playmatId;
  const coinId = user?.activeCoinId ?? DEFAULT_COSMETICS.coinId;
  const cardBackId = user?.activeCardBackId ?? DEFAULT_COSMETICS.cardBackId;
  const variantEntries = entries.filter((entry) => entry.variantId);

  const [playmat, coin, cardBack, skins] = await Promise.all([
    playmatId === DEFAULT_COSMETICS.playmatId
      ? true
      : prisma.userPlaymat.findUnique({ where: { userId_playmatId: { userId, playmatId } }, select: { id: true } }),
    coinId === DEFAULT_COSMETICS.coinId
      ? true
      : prisma.userCoin.findUnique({ where: { userId_coinId: { userId, coinId } }, select: { id: true } }),
    cardBackId === DEFAULT_COSMETICS.cardBackId
      ? true
      : prisma.userCardBack.findUnique({ where: { userId_cardBackId: { userId, cardBackId } }, select: { id: true } }),
    variantEntries.length === 0
      ? []
      : prisma.userCardSkin.findMany({ where: { userId }, select: { skinId: true } }),
  ]);

  return {
    playmatId: playmat ? playmatId : DEFAULT_COSMETICS.playmatId,
    coinId: coin ? coinId : DEFAULT_COSMETICS.coinId,
    cardBackId: cardBack ? cardBackId : DEFAULT_COSMETICS.cardBackId,
    variantMap: buildOwnedVariantMap(variantEntries, new Set(skins.map((s) => s.skinId))),
  };
}

/** A seat's cosmetics, or the defaults if the DB can't be read (a game never fails over a skin). */
async function loadSeatCosmeticsOrDefaults(userId: string | null, deckId: string | null): Promise<SeatCosmetics> {
  try {
    return await loadSeatCosmetics(userId, deckId);
  } catch (err) {
    console.error(`[room-cosmetics] Could not read the cosmetics of ${userId}:`, err);
    return { ...DEFAULT_COSMETICS, variantMap: {} };
  }
}

/** Read both seats' cosmetics from the DB and keep them with the room (call when the game starts). */
export async function snapshotRoomCosmetics(room: GameRoom): Promise<RoomCosmetics> {
  const [player1, player2] = await Promise.all([
    loadSeatCosmeticsOrDefaults(room.player1Id, room.player1DeckId),
    loadSeatCosmeticsOrDefaults(room.player2Id, room.player2DeckId),
  ]);
  room.cosmetics = { player1, player2 };
  return room.cosmetics;
}

/** The room's cosmetics: the snapshot taken at the start (read now if the room has none yet). */
export async function getRoomCosmetics(room: GameRoom): Promise<RoomCosmetics> {
  return room.cosmetics ?? snapshotRoomCosmetics(room);
}

function publicCosmetics({ playmatId, coinId, cardBackId }: SeatCosmetics): PlayerCosmetics {
  return { playmatId, coinId, cardBackId };
}

/**
 * The `gameStart` fields for a viewer: "player" = the viewer's own side (the bottom of the
 * board), "opponent" = the other one; a spectator sees player 1 at the bottom.
 */
export function cosmeticsPayload(cosmetics: RoomCosmetics, viewer: Viewer) {
  const [own, other] = viewer === "player2" ? [cosmetics.player2, cosmetics.player1] : [cosmetics.player1, cosmetics.player2];
  return {
    playerCosmetics: publicCosmetics(own),
    opponentCosmetics: publicCosmetics(other),
    playerVariantMap: own.variantMap,
    opponentVariantMap: other.variantMap,
  };
}
