import { BROCK } from "./brock.js";
import type { GymLeaderDef, GymMode, GymRewards, GymRules } from "./types.js";

export * from "./types.js";

/** Every Gym Leader, in Kanto order (v2: Brock). */
export const GYM_LEADERS: readonly GymLeaderDef[] = [BROCK];

export function getGymLeader(leaderId: string): GymLeaderDef | undefined {
  return GYM_LEADERS.find((leader) => leader.id === leaderId);
}

/** The leader's content deck for `mode` (the default an admin can replace), undefined when that version doesn't exist. */
export function leaderDeck(leader: GymLeaderDef, mode: GymMode) {
  return mode === "expert" ? leader.decks.expert : leader.decks.normal;
}

/** The version's rules for the challenger's deck. */
export function leaderRules(leader: GymLeaderDef, mode: GymMode): GymRules | undefined {
  return mode === "expert" ? leader.rules.expert : leader.rules.normal;
}

/** What the version's first victory gives. */
export function leaderRewards(leader: GymLeaderDef, mode: GymMode): GymRewards | undefined {
  return mode === "expert" ? leader.rewards.expert : leader.rewards.normal;
}

/** The versions a leader can be challenged in: those with a deck, rules and rewards. */
export function leaderModes(leader: GymLeaderDef): GymMode[] {
  const modes: GymMode[] = ["normal"];
  if (leader.decks.expert && leader.rules.expert && leader.rewards.expert) modes.push("expert");
  return modes;
}

/** "Brock" / "Brock EXPERT" (transaction log, server logs). */
export function versionLabel(leader: GymLeaderDef, mode: GymMode): string {
  return mode === "expert" ? `${leader.name} EXPERT` : leader.name;
}
