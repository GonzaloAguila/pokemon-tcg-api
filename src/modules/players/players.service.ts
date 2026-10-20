/**
 * Public player profiles: what any signed-in player may see of another one (medals,
 * achievements, collection progress, variants, cosmetics in use, record). Never select
 * private fields here (email, balances, transactions, moderation, permissions, sessions):
 * the selects below are the whitelist.
 */

import { CARD_SETS } from "@gonzaloaguila/game-core";
import { RELEASED_SETS } from "../../lib/released-sets.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { listEarnedAchievements } from "../achievements/achievements.service.js";
import { titleIdFromStats } from "../users/titles.js";
import { getUserCardSkins, getUserCollection } from "../users/users.service.js";

/** Usernames are `[a-zA-Z0-9_]`, 3–20 chars (signup and OAuth); anything else can't exist. */
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,32}$/;

const playerNotFound = () => new AppError("No encontramos a ese jugador", 404, "NOT_FOUND");

const SET_ID_BY_CARD_ID = new Map(CARD_SETS.flatMap((set) => set.cards.map((card) => [card.id, set.id] as const)));

const publicUserSelect = {
  id: true,
  username: true,
  role: true,
  level: true,
  createdAt: true,
  activeAvatarId: true,
  activeCoinId: true,
  activeCardBackId: true,
  activePlaymatId: true,
  stats: {
    select: {
      normalWins: true,
      normalLosses: true,
      rankedWins: true,
      rankedLosses: true,
      draftWins: true,
      draftLosses: true,
      currentStreak: true,
      bestStreak: true,
    },
  },
  medals: {
    select: { medalId: true, unlockedAt: true },
    orderBy: { unlockedAt: "asc" },
  },
} as const;

/**
 * The visible (not banned) account with that username, case-insensitively. An exact match wins
 * (usernames are unique case-sensitively, so "Ash" and "ash" may both exist).
 */
async function findVisiblePlayer(username: string) {
  if (!USERNAME_PATTERN.test(username)) throw playerNotFound();
  const visible = { status: { not: "banned" } };
  // The insensitive lookup may be an ILIKE, where "_" is a wildcard: keep only real matches.
  const user =
    (await prisma.user.findFirst({ where: { username, ...visible }, select: publicUserSelect })) ??
    (
      await prisma.user.findMany({
        where: { username: { equals: username, mode: "insensitive" }, ...visible },
        select: publicUserSelect,
        orderBy: { createdAt: "asc" },
        take: 10,
      })
    ).find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
  if (!user) throw playerNotFound();
  return user;
}

/** Distinct catalog cards owned per set of the engine registry (unknown ids are skipped). */
export function summarizeCollection(cards: readonly { cardDefId: string; quantity: number }[]) {
  const owned = new Map<string, number>();
  for (const { cardDefId, quantity } of cards) {
    if (quantity <= 0) continue;
    const setId = SET_ID_BY_CARD_ID.get(cardDefId);
    if (setId) owned.set(setId, (owned.get(setId) ?? 0) + 1);
  }
  const sets = RELEASED_SETS.map((set) => ({ setId: set.id, owned: owned.get(set.id) ?? 0, total: set.cards.length }));
  return {
    owned: sets.reduce((sum, set) => sum + set.owned, 0),
    total: sets.reduce((sum, set) => sum + set.total, 0),
    sets,
  };
}

/** GET /api/players/:username */
export async function getPublicProfile(username: string) {
  const user = await findVisiblePlayer(username);
  const [achievements, collection, skins] = await Promise.all([
    listEarnedAchievements(user.id),
    getUserCollection(user.id),
    getUserCardSkins(user.id),
  ]);

  const stats = {
    normalWins: user.stats?.normalWins ?? 0,
    normalLosses: user.stats?.normalLosses ?? 0,
    rankedWins: user.stats?.rankedWins ?? 0,
    rankedLosses: user.stats?.rankedLosses ?? 0,
    draftWins: user.stats?.draftWins ?? 0,
    draftLosses: user.stats?.draftLosses ?? 0,
    currentStreak: user.stats?.currentStreak ?? 0,
    bestStreak: user.stats?.bestStreak ?? 0,
  };

  return {
    username: user.username,
    avatarId: user.activeAvatarId ?? "collector",
    titleId: titleIdFromStats(user.stats, user.role),
    level: user.level,
    memberSince: user.createdAt,
    stats,
    medals: user.medals,
    achievements: {
      points: achievements.reduce((sum, achievement) => sum + achievement.points, 0),
      earned: achievements,
    },
    collection: summarizeCollection(collection),
    variants: skins.map((skin) => skin.skinId),
    cosmetics: {
      coinId: user.activeCoinId ?? "eevee",
      cardBackId: user.activeCardBackId ?? "default",
      playmatId: user.activePlaymatId ?? "field",
    },
  };
}

/** GET /api/players/:username/collection: every card owned, `{ cardDefId, quantity }`. */
export async function getPublicCollection(username: string) {
  const user = await findVisiblePlayer(username);
  const cards = await getUserCollection(user.id);
  return { username: user.username, cards: cards.filter((card) => card.quantity > 0) };
}
