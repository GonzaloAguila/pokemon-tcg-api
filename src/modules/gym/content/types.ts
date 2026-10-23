/**
 * Gym Leaders (docs/gym-leaders.md): every leader is data — who they are, what they look like on
 * the board, the rules a challenger's deck must follow, what beating them gives and the decks the
 * server's AI plays, per version (mode).
 */
import type { CardEntry, PokemonOwner } from "@gonzaloaguila/game-core";

export type { CardEntry };

/** A leader's version: the normal deck and the stronger expert one. */
export const GYM_MODES = ["normal", "expert"] as const;
export type GymMode = (typeof GYM_MODES)[number];

/** Energy types a leader can ban (game-core EnergyType values; Colorless is never banned). */
export type BannableType = "grass" | "fire" | "water" | "lightning" | "psychic" | "fighting";

/**
 * A version's rules: for the challenger's deck (on top of the normal deck rules) and the Stadium
 * every game of the battle starts with. The leader's own deck follows none of them.
 */
export interface GymRules {
  /** No Pokémon with any of these types (Energy cards are not restricted by type). */
  bannedPokemonTypes: BannableType[];
  /** No Pokémon of these owners (game-core ownerOf: "Brock" bans every "Brock's …" Pokémon). */
  bannedOwners: PokemonOwner[];
  /** No Stadium cards (the gym's own Stadium is always in play). */
  noStadiums: boolean;
  /** At most this many Trainer cards in total (Trainers played as Basics count). */
  maxTrainers?: number;
  /** At most this many copies of each card by name, basic Energy exempt (absent = the normal 4). */
  maxCopies?: number;
  /** Stadium in play from the start of every game, never replaced (game-core card id). */
  fixedStadiumId?: string;
}

/** What the first victory in a version gives (each part optional but `coins`). */
export interface GymRewards {
  /** UserMedal id (matches the frontend's KANTO_MEDALS). */
  medalId: string | null;
  coins: number;
  /** Coin cosmetic id (UserCoin). */
  coinId: string | null;
  /** Card back cosmetic id (UserCardBack). */
  cardBackId: string | null;
}

export interface GymLeaderDef {
  id: string;
  name: string;
  title: string;
  /** The leader's medal (shown on its tables; the normal version's first victory grants it). */
  medalId: string;
  /** The AI seat's avatar (frontend asset; no API catalog entry). */
  avatarId: string;
  /** Coins a challenge costs (both versions), charged when the series is created. */
  entryCost: number;
  /** Challenges (series) a user may start per economy day, both versions together. */
  attemptsPerDay: number;
  /** The AI seat's fixed cosmetics (room.cosmetics.player2). */
  cosmetics: { playmatId: string; coinId: string; cardBackId: string };
  /**
   * The leader's own emotes (frontend LEADER_EMOTES; no player owns them), sent on the leader's
   * side: when the battle starts, when it knocks out a challenger's Pokémon, when it wins.
   */
  emotes?: { battleStart?: string; knockOut?: string; victory?: string };
  /** A version exists when it has rules, rewards and a deck (normal always). */
  rules: { normal: GymRules; expert?: GymRules };
  rewards: { normal: GymRewards; expert?: GymRewards };
  /** The content default; an admin may replace it (GymLeaderDeck rows, gym-decks.ts). */
  decks: { normal: CardEntry[]; expert?: CardEntry[] };
}
