/**
 * Battle Pass Types
 */

export interface BattlePassRewardDef {
  day: number;
  track: "standard" | "premium";
  rewardType:
    | "coins"
    | "pack"
    | "card_back"
    | "profile_coin"
    | "ticket"
    | "card"
    | "avatar";
  rewardId?: string;
  amount?: number;
  label: string;
  icon?: string;
}

export interface BattlePassWithProgress {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl: string;
  durationDays: number;
  premiumPrice: number;
  status: string;
  rewards: BattlePassRewardDef[];
  enrollment: {
    activatedAt: string;
    isPremium: boolean;
    currentDay: number;
    claimedRewards: Array<{ day: number; track: string }>;
  } | null;
}

export interface BattlePassListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl: string;
  durationDays: number;
  premiumPrice: number;
  status: string;
  isEnrolled: boolean;
  isPremium: boolean;
  currentDay: number | null;
}
