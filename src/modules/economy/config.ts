/**
 * Economy v2 — every tunable number in one place.
 *
 * Source: the economy analysis of 2026-10-14 (section 4). Items NOT built on purpose: dust /
 * crafting for duplicates and the "new rare" pity guarantee. Changing a number here changes the
 * server behaviour directly; the frontend reads them from GET /api/economy/config.
 *
 * Plain mutable object (not frozen) so tests can flip flags (e.g. tableBets.enabled).
 */

export type MissionEvent = "daily_pack_opened" | "game_played" | "game_won";

export interface DailyMissionDef {
  id: string;
  title: string;
  target: number;
  rewardCoins: number;
  event: MissionEvent;
}

export interface BattlePassStepReward {
  step: number;
  rewardType: "coins" | "pack" | "unowned_holo" | "profile_coin" | "card_back" | "playmat" | "avatar" | "card_skin" | "emote";
  amount?: number;
  rewardId?: string;
  label: string;
}

export const ECONOMY = {
  /** Every daily/weekly/monthly reset happens at 00:00 in this time zone (03:00 UTC). */
  timeZone: "America/Argentina/Buenos_Aires",

  welcome: {
    coins: 1000,
    coupons: 100,
    /** One unopened booster of every set in the registry (STANDARD_BOOSTER_IDS). */
    onePackPerSet: true,
  },

  dailyPack: {
    /** Free booster per economy day; the player picks the set. */
    perDay: 1,
  },

  /** Extra free pack on each of the first N login days of accounts created with the v2 welcome. */
  firstSteps: {
    days: 7,
    packsPerDay: 1,
  },

  /** Login calendar: every N login days (not necessarily consecutive, never resets). */
  loginCalendar: {
    everyDays: 7,
    packs: 1,
    coupons: 10,
  },

  missions: {
    daily: [
      { id: "open_daily_pack", title: "Abre tu sobre diario", target: 1, rewardCoins: 25, event: "daily_pack_opened" },
      { id: "play_games", title: "Juega 2 partidas (IA u online)", target: 2, rewardCoins: 50, event: "game_played" },
      { id: "win_game", title: "Gana 1 partida", target: 1, rewardCoins: 50, event: "game_won" },
    ] as DailyMissionDef[],
    weekly: {
      id: "weekly_missions",
      title: "Completa 15 misiones esta semana",
      target: 15,
      rewardPacks: 1,
      rewardExchangeTokens: 1,
    },
  },

  /** Coins credited when a counted game is settled. Draft counts as online. */
  matchCoins: {
    online: { win: 25, loss: 10 },
    ai: { win: 10, loss: 5 },
    dailyCap: 8000,
  },

  /**
   * Rules a game must pass to count for stats, ranking, achievements, XP, match coins and
   * missions ("counted game").
   */
  antiFarming: {
    minTurn: 3,
    /** Multiplayer: minimum time between the game start and its end. */
    minDurationMs: 2 * 60_000,
    /** Multiplayer: a player's wins against the same opponent that count per economy day. */
    maxCountedWinsPerOpponentPerDay: 3,
    /** Single player vs AI (client-reported): minimum duration and counted games per day. */
    aiMinDurationMs: 3 * 60_000,
    aiDailyCountedGames: 10,
  },

  battlePass: {
    maxSteps: 30,
    premiumPriceRareCandy: 2,
    /** Free track: 50 coins per step except packs at 10/20 and an unowned holo at 30. */
    standardCoinsPerStep: 50,
    standardPackSteps: [10, 20],
    // The free track's last step (30) gives a holo the user doesn't own (fallback: any holo).
    /**
     * Premium track (2 Rare Candies): cosmetics (two battle emotes among them) + 4 packs + 1000
     * coins. Steps not listed give nothing. In months shorter than 30 days the step-30 rewards move to the month's last step.
     */
    premium: [
      { step: 1, rewardType: "coins", amount: 100, label: "100 Monedas" },
      { step: 2, rewardType: "coins", amount: 100, label: "100 Monedas" },
      { step: 3, rewardType: "profile_coin", rewardId: "charizard", label: "Moneda: Charizard" },
      { step: 4, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 5, rewardType: "profile_coin", rewardId: "lucario", label: "Moneda: Lucario" },
      { step: 6, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 7, rewardType: "pack", label: "Sobre a elección" },
      { step: 8, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 9, rewardType: "emote", rewardId: "pachirisu-dance", label: "Emote: Pachirisu bailando" },
      { step: 10, rewardType: "card_back", rewardId: "pikachu", label: "Dorso: Pikachu" },
      { step: 11, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 12, rewardType: "coins", amount: 100, label: "100 Monedas" },
      { step: 13, rewardType: "card_back", rewardId: "haymaker", label: "Dorso: Haymaker" },
      { step: 14, rewardType: "pack", label: "Sobre a elección" },
      { step: 15, rewardType: "playmat", rewardId: "stadium", label: "Tapete: Estadio" },
      { step: 16, rewardType: "coins", amount: 100, label: "100 Monedas" },
      { step: 17, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 18, rewardType: "playmat", rewardId: "street", label: "Tapete: Calle" },
      { step: 19, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 20, rewardType: "avatar", rewardId: "snorlax", label: "Avatar: Snorlax" },
      { step: 21, rewardType: "pack", label: "Sobre a elección" },
      { step: 22, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 23, rewardType: "avatar", rewardId: "pikachu", label: "Avatar: Pikachu" },
      { step: 24, rewardType: "coins", amount: 100, label: "100 Monedas" },
      { step: 25, rewardType: "emote", rewardId: "pikachu-shocked", label: "Emote: Pikachu sorprendido" },
      { step: 26, rewardType: "pack", label: "Sobre a elección" },
      { step: 27, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 28, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 29, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 30, rewardType: "card_skin", rewardId: "charizard-sepia", label: "Variante: Charizard Sepia" },
    ] as BattlePassStepReward[],
    /**
     * Passes are rebuilt from this config, so the emote steps only apply from this month on;
     * earlier passes keep the premium track they started with: `premiumBeforeEmotes` replaces
     * these steps of `premium` (steps 2, 9, 16 and 25 were 50 coins each).
     */
    premiumEmotesFrom: { year: 2026, month: 11 },
    premiumBeforeEmotes: [
      { step: 2, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 9, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 16, rewardType: "coins", amount: 50, label: "50 Monedas" },
      { step: 25, rewardType: "coins", amount: 50, label: "50 Monedas" },
    ] as BattlePassStepReward[],
  },

  /** Per-set collection milestones (replace the collection / balance achievements). */
  setMilestones: {
    tiers: [
      { percent: 50, coins: 100 },
      { percent: 75, coins: 250, cardBack: true },
      { percent: 100, coins: 500, title: true, holoVariant: true },
    ],
    /** Cosmetic ids granted per set. The frontend must know these ids (see docs/economy-v2.md). */
    cardBackId: (setId: string) => `set-${setId}`,
    titleMedalId: (setId: string) => `title-maestro-${setId}`,
    /** Holo variant (card skin id) granted at 100% of each set. */
    holoVariantBySet: {
      "base-set": "charizard-holo-sparkle",
      jungle: "scyther-holo-sparkle",
      fossil: "dragonite-holo-sparkle",
      "team-rocket": "dark-dragonite-holo-sparkle",
      "gym-heroes": "blaine-s-moltres-holo-sparkle",
      "gym-challenge": "blaine-s-charizard-holo-sparkle",
    } as Record<string, string>,
    /** Whole catalog completed: title only. */
    collectorMedalId: "title-maestro-coleccionista",
  },

  /** "Ficha de canje": redeem for a chosen card. Basic Energy can't be redeemed. */
  exchangeTokens: {
    costByRarity: { common: 1, uncommon: 1, rare: 1, "rare-holo": 2 } as Record<string, number>,
  },

  market: {
    cardPrices: { rare: 150, uncommon: 50, common: 20, mystery: 100 },
  },

  packs: {
    /** Every standard booster costs the same. */
    price: 200,
    /**
     * How often a card comes out compared with the other cards it is drawn with (same pack,
     * same rarity): 1 by default, 0.5 = half as often, 0.25 = a quarter. By card id, e.g.
     * "base-set-004-charizard": 0.5. The odds (GET /api/economy/odds) follow.
     */
    cardWeights: {} as Record<string, number>,
  },

  rareCandy: {
    toCoins: 2000,
    toCoupons: 50,
    /** Candy → coins conversions per economy week (candy → coupons is not limited). */
    maxCoinConversionsPerWeek: 2,
  },

  /**
   * Card trades between players (modules/trades). Cards only: never coins, Rare Candy or
   * cosmetics. Only duplicates (a player always keeps 1 copy), basic Energy excluded.
   */
  trades: {
    /** Who can trade: verified email, account age and counted online games (like table bets). */
    requireVerifiedEmail: true,
    minAccountAgeDays: 7,
    minOnlineGames: 20,
    /** Coins each player pays when a trade completes (a coin sink; it also discourages spam). */
    feeCoins: 50,
    /** Most copies on each side of a trade. */
    maxCardsPerSide: 10,
    /**
     * Points of a card by rarity, for cards an admin hasn't given points to (backoffice "Puntos
     * de cartas", table card_values).
     */
    valueByRarity: { common: 3, uncommon: 5, rare: 10, "rare-holo": 30 } as Record<string, number>,
    /** The side worth fewer points must be worth at least this share of the other ("cuasi equilibrado"). */
    minValueRatio: 0.8,
    /** Copies received in a trade can't be traded again for this long. */
    lockDays: 3,
    /** Completed trades per economy day: in total, and with the same player. */
    maxTradesPerDay: 3,
    maxTradesPerDayWithSamePlayer: 1,
    /** An admin can revert a completed trade for this long. */
    revertDays: 7,
  },

  draft: {
    /** Coins charged to a player who leaves the tournament early (what they have, up to this); they go to the prize pool. */
    withdrawPenalty: 1000,
    /**
     * Prize pool (entry fees + withdraw penalties) split by final position, in percent, by the
     * number of players in the tournament. Players who left get nothing: the shares of the
     * positions left without a player are spread over the ones that have one.
     */
    prizeSplit: [
      { minPlayers: 5, percents: [50, 30, 20] },
      { minPlayers: 3, percents: [70, 30] },
      { minPlayers: 2, percents: [100] },
    ],
  },

  /** Tutorial and puzzle rewards (modules/progress). Client-reported completions: keep them small and once-only. */
  progress: {
    /** Once, after every tutorial lesson; the pack is a "choose your set" stored pack. */
    tutorialReward: { coins: 300, packs: 1 },
    /** Coins for the first solve of a puzzle, by tier. */
    puzzleCoins: { easy: 50, medium: 100, hard: 200 },
  },

  /**
   * Lucky Duel vs the AI (modules/matches): the game's result is client-reported, so the stake is
   * escrowed at POST /matches/ai and settled once at /finish — victory 2 × stake back, draw the
   * stake back, defeat (or an unfinished game abandoned by starting another) nothing. Every
   * `streakBonusEvery`-th consecutive victory pays `streakBonus` more.
   */
  luckyDuelAi: {
    stake: 20,
    streakBonusEvery: 5,
    streakBonus: 200,
    /** A victory reported sooner than this after the start is settled as a draw (anti-script). */
    minVictoryMs: 30_000,
    /**
     * Lucky Duel starts per economy day that are staked; later ones take no stake and pay
     * nothing (no payout, no streak bonus), though the streak still moves. Caps a scripted
     * client's earnings (the result is client-reported).
     */
    dailyStakedGames: 20,
  },

  /**
   * Lobby tables (socket/handlers.ts). deckRank: a standard table shows its deck's rank, from the
   * average points per card without basic Energy (card_values overrides, else
   * trades.valueByRarity: common 3, uncommon 5, rare 10, rare-holo 30). The first threshold the
   * average reaches, else F (see deck-rank.ts). With the default points: only commons 3 (F),
   * commons + uncommons ~4 (E), the starter theme decks 4.6-6.3 (Blackout, Overgrowth D;
   * Zap, Brushfire C), Haymaker / Raindance 7.3-8.3 (C-B), the rare-heavy ones 9.5-11.4
   * (B-A); S takes about a third of the non-Energy cards being holos.
   */
  lobby: {
    deckRank: { S: 15, A: 11, B: 8, C: 6, D: 4.5, E: 3.5 },
  },

  /** Table bets are off. The settlement code stays; flip `enabled` to bring them back. */
  tableBets: {
    enabled: false,
    minOnlineGames: 20,
    requireVerifiedEmail: true,
    maxBetsPerDayPerOpponent: 3,
    /** Below this turn a bet is refunded instead of paid out. */
    minTurnForPayout: 3,
  },
};
