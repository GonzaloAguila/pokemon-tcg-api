import { BROCK } from "./brock.js";
import type { GymLeaderDef, GymMode } from "./types.js";

export * from "./types.js";

/** Every Gym Leader, in Kanto order (v1: Brock). */
export const GYM_LEADERS: readonly GymLeaderDef[] = [BROCK];

export function getGymLeader(leaderId: string): GymLeaderDef | undefined {
  return GYM_LEADERS.find((leader) => leader.id === leaderId);
}

/** The leader's deck for `mode`, or undefined when that version doesn't exist yet. */
export function leaderDeck(leader: GymLeaderDef, mode: GymMode) {
  return mode === "expert" ? leader.decks.expert : leader.decks.normal;
}

/** The versions a leader can be challenged in (v1: "normal"). */
export function leaderModes(leader: GymLeaderDef): GymMode[] {
  return leader.decks.expert ? ["normal", "expert"] : ["normal"];
}
