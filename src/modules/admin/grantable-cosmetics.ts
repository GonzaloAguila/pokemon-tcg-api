/**
 * Cosmetics an admin can hand out (backoffice grants, draft prizes): the catalogs the market,
 * prizes, battle pass and set milestones grant from (+ the gym-leader coins the backoffice
 * offers). Items every player has (Eevee coin, classic back, field playmat, free avatars, starter
 * emotes) are not grantable.
 */
import { RELEASED_SETS } from "../../lib/released-sets.js";
import {
  ADMIN_ONLY_COINS,
  ALL_VARIANTS,
  AVAILABLE_AVATARS,
  AVAILABLE_CARD_BACKS,
  AVAILABLE_COINS,
  AVAILABLE_PLAYMATS,
  ADMIN_ONLY_PLAYMATS,
  TROPHIES,
} from "../prizes/catalog.js";
import { ECONOMY } from "../economy/config.js";
import { FREE_AVATAR_IDS } from "../users/users.service.js";
import { COLLECTIBLE_EMOTES } from "../emotes/catalog.js";

export const COSMETIC_TYPES = ["coin", "cardBack", "avatar", "skin", "playmat", "emote", "trophy"] as const;
export type CosmeticType = (typeof COSMETIC_TYPES)[number];

export const COSMETIC_TYPE_LABELS: Record<CosmeticType, string> = {
  coin: "Moneda",
  cardBack: "Dorso de carta",
  avatar: "Avatar",
  skin: "Skin de carta",
  playmat: "Tapete",
  emote: "Emote",
  trophy: "Trofeo",
};

export const GRANTABLE_COSMETICS: Record<CosmeticType, ReadonlySet<string>> = {
  coin: new Set([...AVAILABLE_COINS.map((c) => c.itemId), ...ADMIN_ONLY_COINS]),
  cardBack: new Set([
    ...AVAILABLE_CARD_BACKS.map((c) => c.itemId),
    ...RELEASED_SETS.map((set) => ECONOMY.setMilestones.cardBackId(set.id)),
  ]),
  avatar: new Set(AVAILABLE_AVATARS.map((a) => a.itemId).filter((id) => !FREE_AVATAR_IDS.has(id))),
  // "<pokemon-slug>-<overlayId>": every Rare Holo Pokémon × every overlay (catalog.ts)
  skin: new Set(ALL_VARIANTS.map((v) => v.itemId)),
  playmat: new Set([...AVAILABLE_PLAYMATS, ...ADMIN_ONLY_PLAYMATS].map((p) => p.itemId)),
  emote: new Set(COLLECTIBLE_EMOTES.map((e) => e.id)),
  trophy: new Set(TROPHIES.map((t) => t.itemId)),
};

export function isGrantableCosmetic(type: CosmeticType, itemId: string): boolean {
  return GRANTABLE_COSMETICS[type].has(itemId);
}
