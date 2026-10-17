/**
 * Draft prizes an admin configures (DraftConfig.rewards): coins, unopened packs and cosmetics
 * for every player who finished the tournament ("all") and for given final places. They go on
 * top of the entry-fee prize pool (computeDraftPrizes). Pure: validation and who gets what; the
 * payout is socket/draft-payout.ts.
 */
import { z } from "zod";
import { CARD_SETS, type CardSetId } from "@gonzaloaguila/game-core";
import { boosterIdForSet } from "../modules/boosters/boosters.service.js";
import { COSMETIC_TYPES, isGrantableCosmetic, type CosmeticType } from "../modules/admin/grantable-cosmetics.js";

export type DraftRewardTarget = "all" | { place: number } | { from: number; to: number };
export type DraftRewardPack = { setId: CardSetId; quantity: number };
export type DraftRewardItem = { type: CosmeticType; id: string };
export type DraftRewardTier = {
  target: DraftRewardTarget;
  coins?: number;
  packs?: DraftRewardPack[];
  items?: DraftRewardItem[];
};
/** What one player wins from the configured tiers ("all" + their place's). */
export type DraftRewardGrant = { coins: number; packs: DraftRewardPack[]; items: DraftRewardItem[] };

export const MAX_REWARD_TIERS = 12;
export const MAX_REWARD_COINS = 100_000;
export const MAX_REWARD_PACKS_PER_SET = 20;
export const MAX_REWARD_ITEMS_PER_TIER = 10;
/** Most players a draft can have (DraftConfig.maxPlayers). */
const MAX_PLACE = 8;

/** Sets whose booster can be a prize (every set with a standard booster). */
export const REWARD_PACK_SET_IDS = CARD_SETS.map((set) => set.id).filter((id) => boosterIdForSet(id) !== null) as [
  CardSetId,
  ...CardSetId[],
];

const place = z.number().int().min(1).max(MAX_PLACE);

const target = z.union([z.literal("all"), z.object({ place }), z.object({ from: place, to: place })]);

const tier = z
  .object({
    target,
    coins: z.number().int().min(0).max(MAX_REWARD_COINS).optional(),
    packs: z
      .array(
        z.object({
          setId: z.enum(REWARD_PACK_SET_IDS),
          quantity: z.number().int().min(1).max(MAX_REWARD_PACKS_PER_SET),
        }),
      )
      .max(REWARD_PACK_SET_IDS.length)
      .optional(),
    items: z
      .array(z.object({ type: z.enum(COSMETIC_TYPES), id: z.string().trim().min(1).max(100) }))
      .max(MAX_REWARD_ITEMS_PER_TIER)
      .optional(),
  })
  .superRefine((t, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, params: { forPlayer: true } });
    if (!(t.coins ?? 0) && !t.packs?.length && !t.items?.length) issue("Hay un premio vacío: agrégale monedas, sobres o cosméticos");
    const setIds = (t.packs ?? []).map((p) => p.setId);
    if (new Set(setIds).size !== setIds.length) issue("Un premio repite la expansión de un sobre");
    const itemKeys = (t.items ?? []).map((i) => `${i.type}:${i.id}`);
    if (new Set(itemKeys).size !== itemKeys.length) issue("Un premio repite un cosmético");
    for (const item of t.items ?? []) {
      if (!isGrantableCosmetic(item.type, item.id)) issue(`Cosmético que no se puede regalar: ${item.id}`);
    }
  });

/** DraftConfig.rewards: shapes, catalog and the tiers among themselves (places vs maxPlayers: draftRewardsError). */
export const draftRewardsSchema = z
  .array(tier)
  .max(MAX_REWARD_TIERS)
  .superRefine((tiers, ctx) => {
    const error = draftRewardsError(tiers, MAX_PLACE);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, params: { forPlayer: true } });
  });

/** The places a target covers (empty for "all"). */
function placesOf(target: DraftRewardTarget): number[] {
  if (target === "all") return [];
  if ("place" in target) return [target.place];
  const places: number[] = [];
  for (let p = target.from; p <= target.to; p++) places.push(p);
  return places;
}

/**
 * Why these tiers can't be used in a draft of `maxPlayers` players, or null: one "all" at most,
 * ranges in order, places within the draft, no place in two tiers.
 */
export function draftRewardsError(tiers: readonly DraftRewardTier[], maxPlayers: number): string | null {
  if (tiers.filter((t) => t.target === "all").length > 1) return "Solo puede haber un premio para todos los participantes";
  const taken = new Set<number>();
  for (const t of tiers) {
    if (t.target !== "all" && "from" in t.target && t.target.from > t.target.to) return "Un rango de puestos está al revés";
    for (const p of placesOf(t.target)) {
      if (p > maxPlayers) return `El ${p}.º puesto no existe en un draft de ${maxPlayers} jugadores`;
      if (taken.has(p)) return `El ${p}.º puesto tiene más de un premio`;
      taken.add(p);
    }
  }
  return null;
}

/** Whether `tier` is for the player who finished at `position` (1-based). */
function tierCovers(tier: DraftRewardTier, position: number): boolean {
  if (tier.target === "all") return true;
  if ("place" in tier.target) return tier.target.place === position;
  return tier.target.from <= position && position <= tier.target.to;
}

/**
 * What the player at `position` wins: "all" plus their place's tier, merged (packs of a set
 * added up; a cosmetic in both only once). Players who left the tournament get nothing.
 */
export function rewardsForPosition(tiers: readonly DraftRewardTier[], position: number, withdrawn: boolean): DraftRewardGrant {
  const grant: DraftRewardGrant = { coins: 0, packs: [], items: [] };
  if (withdrawn) return grant;
  for (const tier of tiers) {
    if (!tierCovers(tier, position)) continue;
    grant.coins += tier.coins ?? 0;
    for (const pack of tier.packs ?? []) {
      const existing = grant.packs.find((p) => p.setId === pack.setId);
      if (existing) existing.quantity += pack.quantity;
      else grant.packs.push({ ...pack });
    }
    for (const item of tier.items ?? []) {
      if (!grant.items.some((i) => i.type === item.type && i.id === item.id)) grant.items.push({ ...item });
    }
  }
  return grant;
}

export function isEmptyGrant(grant: DraftRewardGrant | null | undefined): boolean {
  return !grant || (grant.coins <= 0 && grant.packs.length === 0 && grant.items.length === 0);
}
