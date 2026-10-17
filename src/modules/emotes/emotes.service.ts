/**
 * Battle emotes a player owns and the (up to) five they take into games.
 *
 * Owned = the starters (no row) + UserEmote rows. The loadout lives in User.emoteLoadout; its
 * column default is the starters, so old accounts have them equipped without a backfill. A stored
 * loadout is always read through `cleanLoadout` (known, owned, no repeats, at most five), so an
 * emote removed from the catalog never reaches a game.
 */
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import type { Db } from "../users/users.service.js";
import {
  BATTLE_EMOTES,
  EMOTE_BY_ID,
  EMOTE_LOADOUT_SIZE,
  STARTER_EMOTE_IDS,
  isStarterEmote,
} from "./catalog.js";

type Reader = Db | typeof prisma;

/** Every emote id the user owns (starters included). */
export async function getOwnedEmoteIds(userId: string, db: Reader = prisma): Promise<Set<string>> {
  const rows = await db.userEmote.findMany({ where: { userId }, select: { emoteId: true } });
  return new Set([...STARTER_EMOTE_IDS, ...rows.map((r) => r.emoteId).filter((id) => EMOTE_BY_ID.has(id))]);
}

/** A stored loadout as a game may use it: known and owned emotes, first occurrence, at most five. */
export function cleanLoadout(stored: readonly string[], owned: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of stored) {
    if (out.length >= EMOTE_LOADOUT_SIZE) break;
    if (!EMOTE_BY_ID.has(id) || !owned.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** The user's equipped emotes (cleaned). A missing user has none. */
export async function getEmoteLoadout(userId: string, db: Reader = prisma): Promise<string[]> {
  const [user, owned] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { emoteLoadout: true } }),
    getOwnedEmoteIds(userId, db),
  ]);
  if (!user) return [];
  return cleanLoadout(user.emoteLoadout, owned);
}

export interface OwnedEmote {
  emoteId: string;
  /** null for the starters (owned since the account exists). */
  obtainedAt: Date | null;
  starter: boolean;
}

/** GET /users/me/emotes: owned emotes (catalog order) and the loadout. */
export async function getUserEmotes(userId: string): Promise<{ emotes: OwnedEmote[]; loadout: string[] }> {
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { emoteLoadout: true } }),
    prisma.userEmote.findMany({ where: { userId }, select: { emoteId: true, obtainedAt: true } }),
  ]);
  if (!user) throw Errors.NotFound("Usuario");
  const obtained = new Map(rows.map((r) => [r.emoteId, r.obtainedAt]));
  const emotes: OwnedEmote[] = BATTLE_EMOTES.filter((e) => e.starter || obtained.has(e.id)).map((e) => ({
    emoteId: e.id,
    obtainedAt: e.starter ? null : (obtained.get(e.id) ?? null),
    starter: !!e.starter,
  }));
  const owned = new Set(emotes.map((e) => e.emoteId));
  return { emotes, loadout: cleanLoadout(user.emoteLoadout, owned) };
}

/**
 * PATCH /users/me/emotes/loadout: replace the equipped emotes. Up to five, no repeats, each one
 * known and owned (the starters always are). Returns the saved loadout.
 */
export async function setEmoteLoadout(userId: string, emoteIds: string[]): Promise<string[]> {
  if (emoteIds.length > EMOTE_LOADOUT_SIZE) {
    throw Errors.BadRequest(`Puedes llevar hasta ${EMOTE_LOADOUT_SIZE} emotes`);
  }
  if (new Set(emoteIds).size !== emoteIds.length) {
    throw Errors.BadRequest("No puedes repetir un emote");
  }
  const unknown = emoteIds.find((id) => !EMOTE_BY_ID.has(id));
  if (unknown) throw Errors.BadRequest(`Emote inexistente: ${unknown}`);

  const toCheck = emoteIds.filter((id) => !isStarterEmote(id));
  if (toCheck.length > 0) {
    const rows = await prisma.userEmote.findMany({
      where: { userId, emoteId: { in: toCheck } },
      select: { emoteId: true },
    });
    const owned = new Set(rows.map((r) => r.emoteId));
    const missing = toCheck.find((id) => !owned.has(id));
    if (missing) throw Errors.BadRequest(`No posees el emote ${EMOTE_BY_ID.get(missing)!.name}`);
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { emoteLoadout: emoteIds },
    select: { emoteLoadout: true },
  });
  return user.emoteLoadout;
}

/**
 * Give `emoteId` to the user inside the caller's transaction (market, prizes, battle pass,
 * draft prizes). A starter or an emote already owned changes nothing. Returns whether a row was
 * added.
 */
export async function grantEmote(tx: Db, userId: string, emoteId: string): Promise<boolean> {
  if (!EMOTE_BY_ID.has(emoteId)) throw Errors.BadRequest(`Emote inexistente: ${emoteId}`);
  if (isStarterEmote(emoteId)) return false;
  const { count } = await tx.userEmote.createMany({ data: [{ userId, emoteId }], skipDuplicates: true });
  return count === 1;
}
