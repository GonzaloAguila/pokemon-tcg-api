export interface DailyCardOffer {
  cardDefId: string;
  name: string;
  number: number;
  set: string;
  rarity: string;
  kind: string;
  price: number;
  /** For mystery card, identity is hidden until purchase */
  isMystery?: boolean;
}

export interface DailyCosmeticOffer {
  type: "coin" | "cardBack" | "avatar" | "variant";
  itemId: string;
  name: string;
  imageUrl?: string;
  price: number;
}

export interface EnergyOffer {
  cardDefId: string;
  energyType: string;
  name: string;
  price: number;
}

export interface DailyOffersResponse {
  cardOffers: DailyCardOffer[];
  cosmeticOffers: DailyCosmeticOffer[];
  energyOffers: EnergyOffer[];
  /** itemKeys purchased by this user today (e.g. "card:base-25", "cosmetic:coin:charizard") */
  purchasedToday: string[];
  /** itemKeys the user already owns (e.g. "own:coin:charizard", "own:cardBack:default") */
  ownedItems: string[];
}
