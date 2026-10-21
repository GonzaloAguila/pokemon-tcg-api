/**
 * Exclusive cosmetics of adventure achievements (content `achievements[].cosmetic`): how they are
 * shown (catalog image) and granted, once, inside the achievement claim's transaction.
 */
import { ADVENTURE_CARD_BACKS, ADVENTURE_PLAYMATS } from "../prizes/catalog.js";
import type { Db } from "../users/users.service.js";
import type { AchievementCosmetic } from "./content/schema.js";

const CATALOG = {
  playmat: ADVENTURE_PLAYMATS,
  cardBack: ADVENTURE_CARD_BACKS,
} as const;

export interface AchievementCosmeticView {
  type: AchievementCosmetic["type"];
  id: string;
  name: string;
  imageUrl: string | null;
}

/** What the client gets for an achievement's cosmetic (null when it has none). */
export function achievementCosmeticView(cosmetic: AchievementCosmetic | undefined): AchievementCosmeticView | null {
  if (!cosmetic) return null;
  const item = CATALOG[cosmetic.type].find((c) => c.itemId === cosmetic.id);
  return { type: cosmetic.type, id: cosmetic.id, name: cosmetic.name, imageUrl: item?.imageUrl ?? null };
}

/** Give the cosmetic (already owned: nothing happens). Run in the claim's transaction. */
export async function grantAchievementCosmetic(tx: Db, userId: string, cosmetic: AchievementCosmetic): Promise<void> {
  switch (cosmetic.type) {
    case "playmat":
      await tx.userPlaymat.createMany({ data: [{ userId, playmatId: cosmetic.id }], skipDuplicates: true });
      break;
    case "cardBack":
      await tx.userCardBack.createMany({ data: [{ userId, cardBackId: cosmetic.id }], skipDuplicates: true });
      break;
  }
}
