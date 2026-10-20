/**
 * Cosmetic and card pools shared by the market and the prize games (wheel, slots).
 * Item ids must match the frontend catalogs in src/domain/profile/types.ts.
 */

import {
  ALL_CARDS,
  isPokemonCard,
  CardRarity,
  getCardImageUrl,
} from "@gonzaloaguila/game-core";
import type { Card } from "@gonzaloaguila/game-core";

export const allCards: Card[] = [...ALL_CARDS];
export const allPokemonCards = allCards.filter((c) => isPokemonCard(c));
export const rareHoloCards = allCards.filter((c) => isPokemonCard(c) && c.rarity === CardRarity.RareHolo);

export interface CosmeticItem {
  itemId: string;
  name: string;
  imageUrl: string;
}

export const AVAILABLE_COINS: CosmeticItem[] = [
  { itemId: "charizard", name: "Charizard", imageUrl: "/coins/TCGP_Coin_Charizard.png" },
  { itemId: "lucario", name: "Lucario", imageUrl: "/coins/TCGP_Coin_Lucario.png" },
  { itemId: "venusaur", name: "Venusaur", imageUrl: "/coins/TCGP_Coin_Venusaur.png" },
  { itemId: "vulpix-alola", name: "Vulpix Alola", imageUrl: "/coins/vulpix-alola-coin.png" },
  { itemId: "mankey", name: "Mankey", imageUrl: "/coins/mankey-coin.png" },
  { itemId: "charmeleon", name: "Charmeleon", imageUrl: "/coins/charmeleon-coin.png" },
  { itemId: "red", name: "Red", imageUrl: "/coins/red-coin.png" },
];

/**
 * Gym-leader and event coins (frontend COIN_COLLECTION, source "gym-leader" / "event"): not sold nor
 * won, only granted from the backoffice.
 */
export const ADMIN_ONLY_COINS: readonly string[] = [
  "gengar",
  "golem",
  "starmie",
  "raichu",
  "vileplume",
  "alakazam",
  "muk",
  "arcanine",
  "nidoking",
];

export const AVAILABLE_CARD_BACKS: CosmeticItem[] = [
  { itemId: "haymaker", name: "Haymaker", imageUrl: "/card-backs/haymakerBKC.jpeg" },
  { itemId: "draw", name: "Draw", imageUrl: "/card-backs/card-back-draw.jpg" },
  { itemId: "pikachu", name: "Pikachu", imageUrl: "/card-backs/card-back-pikachu.jpg" },
  { itemId: "pokeball", name: "Poké Ball", imageUrl: "/card-backs/card-back-pokeball.jpg" },
];

/** Event playmats (frontend PLAYMAT_COLLECTION, source "event"): not sold nor won, only granted. */
export const ADMIN_ONLY_PLAYMATS: CosmeticItem[] = [
  { itemId: "halloween-forest", name: "Bosque Embrujado", imageUrl: "/bg/bg-halloween-forest.jpg" },
];

/**
 * Trophies (frontend src/domain/profile/trophies.ts): event and tournament awards shown in the
 * profile. Only granted (backoffice, draft prizes); stored as UserMedal rows with these ids.
 */
export const TROPHIES: CosmeticItem[] = [
  { itemId: "trophy-halloween-2026-gold", name: "Calabaza de Oro", imageUrl: "/trophies/halloween-2026-gold.svg" },
  { itemId: "trophy-halloween-2026-silver", name: "Calabaza de Plata", imageUrl: "/trophies/halloween-2026-silver.svg" },
  { itemId: "trophy-halloween-2026-bronze", name: "Calabaza de Bronce", imageUrl: "/trophies/halloween-2026-bronze.svg" },
];

export const AVAILABLE_AVATARS: CosmeticItem[] = [
  { itemId: "bellsprout", name: "Bellsprout", imageUrl: "/avatars/darius-dan/bellsprout.png" },
  { itemId: "pikachu", name: "Pikachu", imageUrl: "/avatars/darius-dan/pikachu.png" },
  { itemId: "poliwhirl", name: "Poliwhirl", imageUrl: "/avatars/darius-dan/poliwhirl.png" },
  { itemId: "sandshrew", name: "Sandshrew", imageUrl: "/avatars/darius-dan/sandshew.png" },
  { itemId: "snorlax", name: "Snorlax", imageUrl: "/avatars/darius-dan/snorlax.png" },
  { itemId: "voltorb", name: "Voltorb", imageUrl: "/avatars/darius-dan/voltorb.png" },
];

/** Playmat rarity (mirrors the frontend's PLAYMAT_COLLECTION): it sets the market price. */
export type PlaymatRarity = "common" | "uncommon" | "rare" | "legendary";

export const AVAILABLE_PLAYMATS: (CosmeticItem & { rarity: PlaymatRarity })[] = [
  { itemId: "eevee-evos", name: "Eevee Evoluciones", imageUrl: "/bg/bg-eevee-evos.jpg", rarity: "uncommon" },
  { itemId: "street", name: "Calle Pokémon", imageUrl: "/bg/bg-street.png", rarity: "uncommon" },
  { itemId: "stadium", name: "Estadio", imageUrl: "/bg/bg2.jpg", rarity: "rare" },
  { itemId: "kanto-sky", name: "Cielo de Kanto", imageUrl: "/bg/bg-kanto-sky.png", rarity: "common" },
  { itemId: "charizard-sunset", name: "Atardecer de Charizard", imageUrl: "/bg/bg-charizard-sunset.jpg", rarity: "uncommon" },
  { itemId: "night-city", name: "Ciudad de Noche", imageUrl: "/bg/bg-night-city.png", rarity: "uncommon" },
];

// Card skin variants: every Rare Holo Pokémon × every overlay
export const OVERLAY_DEFS = [
  { id: "holo-sparkle", label: "Holo" },
  { id: "sepia", label: "Sepia" },
  { id: "rainbow", label: "Arcoíris" },
  { id: "negative", label: "Glitch" },
  { id: "frost", label: "Hielo" },
  { id: "galaxy", label: "Galaxia" },
  { id: "gold", label: "Dorado" },
  { id: "crystal", label: "Cristal" },
  { id: "neon", label: "Neón" },
  { id: "prism", label: "Prisma" },
  { id: "fire", label: "Ígneo" },
];

/** Only these overlays are sold in the market; the rest are prize-only. */
export const MARKET_OVERLAY_IDS = ["holo-sparkle", "sepia", "rainbow"];

export interface VariantItem extends CosmeticItem {
  cardDefId: string;
  overlayId: string;
}

function buildVariants(overlayIds: string[]): VariantItem[] {
  return rareHoloCards.flatMap((card) => {
    const pokeName = isPokemonCard(card) ? card.name : card.id;
    return OVERLAY_DEFS.filter((overlay) => overlayIds.includes(overlay.id)).map((overlay) => ({
      // Slug format shared with the frontend: "alakazam-holo-sparkle"
      itemId: `${pokeName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${overlay.id}`,
      name: `${pokeName} ${overlay.label}`,
      cardDefId: card.id,
      overlayId: overlay.id,
      imageUrl: getCardImageUrl(card),
    }));
  });
}

export const MARKET_VARIANTS = buildVariants(MARKET_OVERLAY_IDS);
export const ALL_VARIANTS = buildVariants(OVERLAY_DEFS.map((o) => o.id));
