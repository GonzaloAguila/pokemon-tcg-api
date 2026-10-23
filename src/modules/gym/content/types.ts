/**
 * Gym Leaders (docs/gym-leaders.md): every leader is data — who they are, what they look like on
 * the board, the rules a challenger's deck must follow and the decks the server's AI plays.
 */
import type { CardEntry } from "@gonzaloaguila/game-core";

export type { CardEntry };

/** A leader's version: the normal deck first, the expert one later (v1: normal only). */
export const GYM_MODES = ["normal", "expert"] as const;
export type GymMode = (typeof GYM_MODES)[number];

/** Energy types a leader can ban (game-core EnergyType values; Colorless is never banned). */
export type BannableType = "grass" | "fire" | "water" | "lightning" | "psychic" | "fighting";

/** Exact card counts of a challenger's deck (Trainers played as Basics count as Trainers). */
export interface GymComposition {
  pokemon: number;
  trainer: number;
  energy: number;
}

export interface GymRules {
  /** No Pokémon with any of these types, no basic Energy of these types. */
  bannedTypes: BannableType[];
  composition?: GymComposition;
}

export interface GymLeaderDef {
  id: string;
  name: string;
  title: string;
  /** UserMedal id granted on the first victory (matches the frontend's KANTO_MEDALS). */
  medalId: string;
  /** The AI seat's avatar (frontend asset; no API catalog entry). */
  avatarId: string;
  /** The AI seat's fixed cosmetics (room.cosmetics.player2). */
  cosmetics: { playmatId: string; coinId: string; cardBackId: string };
  rules: GymRules;
  decks: { normal: CardEntry[]; expert?: CardEntry[] };
}
