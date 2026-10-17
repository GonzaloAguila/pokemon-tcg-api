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
    | "avatar"
    | "playmat"
    | "random_card"
    | "card_skin"
    | "unowned_holo"
    | "emote";
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
  year?: number;
  month?: number;
  daysRemaining: number;
  enrollment: {
    activatedAt: string;
    isPremium: boolean;
    /** Steps reached this month (one per login day) */
    steps: number;
    maxSteps: number;
    /** Today's login already gave its step */
    steppedToday: boolean;
    /** Deprecated alias of steps (calendar pass) */
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
  steps: number;
  maxSteps: number;
  year?: number;
  month?: number;
  daysRemaining?: number;
}
