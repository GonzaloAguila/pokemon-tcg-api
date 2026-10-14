/**
 * Economy v2: daily check-in (login days, first steps, login calendar, battle-pass step), daily
 * free pack, status, "Fichas de canje", welcome grant and per-set collection milestones.
 * Every grant is a one-time claim (EconomyClaim / conditional updates) in the same transaction
 * as the balance change, and every currency change goes through users.service.
 */

import { ALL_CARDS, CARD_SETS, findCardById, getSetById, isBasicEnergy } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import { creditBalance, debitBalance, type Db } from "../users/users.service.js";
import { lockUsers } from "../users/xp.service.js";
import { isStandardBoosterId, openPackForUser } from "../boosters/boosters.service.js";
import type { PackOpeningResult } from "../boosters/boosters.types.js";
import { advanceStepForLogin } from "../battle-pass/battle-pass.service.js";
import { ECONOMY } from "./config.js";
import { claimOnce, hasClaim } from "./claims.js";
import {
  economyDay,
  economyWeek,
  nextEconomyDayStart,
  nextEconomyWeekStart,
} from "./economy-time.js";
import { countUnopenedPacks, grantOnePackPerSet, grantPacks } from "./pack-inventory.js";
import { getMissionsStatus, recordMissionEvent, type MissionCompletion } from "./missions.service.js";
import { matchCoinsEarnedToday } from "./match-rewards.js";

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

async function assertUser(tx: Db, userId: string) {
  await lockUsers(tx, [userId]);
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw Errors.NotFound("Usuario");
}

// ---------------------------------------------------------------------------
// Welcome grant (new accounts only)
// ---------------------------------------------------------------------------

/** Line of the welcome system message that lists the gift (Spanish, markdown). */
export function welcomeGiftLine(): string {
  const { coins, coupons } = ECONOMY.welcome;
  const fmt = (n: number) => n.toLocaleString("es-AR");
  return `**${fmt(coins)} monedas**, **${fmt(coupons)} cupones** y **un sobre de cada set** sin abrir (búscalos en tus sobres) para que empieces tu colección y armes tus mazos.`;
}

/**
 * Welcome package of a NEW account: coins, coupons and one unopened pack of every set. Runs in
 * the account-creation transaction; claimed once ("welcome:v2"), so calling it twice is a no-op.
 * Accounts created before economy v2 never get it (their balances are untouched), and only
 * accounts with this claim get "first steps" packs.
 */
export async function grantWelcomePackage(tx: Db, userId: string): Promise<boolean> {
  if (!(await claimOnce(tx, userId, "welcome", "v2"))) return false;
  const { coins, coupons } = ECONOMY.welcome;
  if (coins > 0) await creditBalance(userId, "coins", coins, "welcome_grant", `Bienvenida: ${coins} monedas`, tx);
  if (coupons > 0) await creditBalance(userId, "coupons", coupons, "welcome_grant", `Bienvenida: ${coupons} cupones`, tx);
  if (ECONOMY.welcome.onePackPerSet) await grantOnePackPerSet(tx, userId, "welcome");
  return true;
}

// ---------------------------------------------------------------------------
// Daily check-in
// ---------------------------------------------------------------------------

export interface CheckInResult {
  alreadyCheckedIn: boolean;
  economyDay: string;
  loginDays: number;
  granted: {
    firstStepsPacks: number;
    calendar: { packs: number; coupons: number } | null;
    battlePassStep: number | null;
  };
}

/**
 * Record today's login day (once per economy day): +1 login day, "first steps" pack(s) on the
 * first days of new accounts, the login-calendar reward every N login days and one battle-pass
 * step. Idempotent: later calls the same day grant nothing.
 */
export async function checkIn(userId: string, now = new Date()): Promise<CheckInResult> {
  return prisma.$transaction(async (tx) => {
    await assertUser(tx, userId);
    const day = economyDay(now);
    const none = { firstStepsPacks: 0, calendar: null, battlePassStep: null };

    if (!(await claimOnce(tx, userId, "check_in", day))) {
      const { loginDays } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { loginDays: true } });
      return { alreadyCheckedIn: true, economyDay: day, loginDays, granted: none };
    }

    const { loginDays } = await tx.user.update({
      where: { id: userId },
      data: { loginDays: { increment: 1 } },
      select: { loginDays: true },
    });

    let firstStepsPacks = 0;
    const firstSteps = ECONOMY.firstSteps;
    if (loginDays <= firstSteps.days && (await hasClaim(tx, userId, "welcome", "v2"))) {
      firstStepsPacks = firstSteps.packsPerDay;
      await grantPacks(tx, userId, firstStepsPacks, "first_steps");
    }

    let calendar: CheckInResult["granted"]["calendar"] = null;
    const cal = ECONOMY.loginCalendar;
    if (loginDays % cal.everyDays === 0) {
      await grantPacks(tx, userId, cal.packs, "login_calendar");
      if (cal.coupons > 0) {
        await creditBalance(userId, "coupons", cal.coupons, "login_calendar", `Calendario de visitas: ${loginDays} días`, tx);
      }
      calendar = { packs: cal.packs, coupons: cal.coupons };
    }

    const battlePassStep = await advanceStepForLogin(tx, userId, now);
    return { alreadyCheckedIn: false, economyDay: day, loginDays, granted: { firstStepsPacks, calendar, battlePassStep } };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Daily free pack
// ---------------------------------------------------------------------------

export interface DailyPackResult {
  pack: PackOpeningResult;
  missionsCompleted: MissionCompletion[];
  checkIn: CheckInResult;
}

/** Open today's free pack of the chosen set (once per economy day). Also checks the user in. */
export async function claimDailyPack(userId: string, packId: string, now = new Date()): Promise<DailyPackResult> {
  if (!isStandardBoosterId(packId)) throw Errors.BadRequest("Sobre inválido");
  const checkInResult = await checkIn(userId, now);

  return prisma.$transaction(async (tx) => {
    await assertUser(tx, userId);
    if (!(await claimOnce(tx, userId, "daily_pack", economyDay(now)))) {
      throw Errors.Conflict("Ya abriste tu sobre diario de hoy");
    }
    const pack = await openPackForUser(tx, userId, packId);
    const missionsCompleted = await recordMissionEvent(tx, userId, "daily_pack_opened", now);
    return { pack, missionsCompleted, checkIn: checkInResult };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getEconomyStatus(userId: string, now = new Date()) {
  const day = economyDay(now);
  const week = economyWeek(now);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { loginDays: true, exchangeTokens: true },
  });
  if (!user) throw Errors.NotFound("Usuario");

  const [checkedInToday, dailyPackClaimed, hasWelcome, candyClaims, missions, matchCoins, unopenedPacks] = await Promise.all([
    hasClaim(prisma, userId, "check_in", day),
    hasClaim(prisma, userId, "daily_pack", day),
    hasClaim(prisma, userId, "welcome", "v2"),
    prisma.economyClaim.count({ where: { userId, kind: "candy_coins", key: { startsWith: `${week}:` } } }),
    getMissionsStatus(userId, now),
    matchCoinsEarnedToday(prisma, userId, now),
    countUnopenedPacks(userId),
  ]);

  const cal = ECONOMY.loginCalendar;
  const firstSteps = ECONOMY.firstSteps;
  return {
    timeZone: ECONOMY.timeZone,
    economyDay: day,
    resetsAt: nextEconomyDayStart(now).toISOString(),
    economyWeek: week,
    weekResetsAt: nextEconomyWeekStart(now).toISOString(),
    checkIn: {
      checkedInToday,
      loginDays: user.loginDays,
      calendar: {
        everyDays: cal.everyDays,
        nextRewardInDays: cal.everyDays - (user.loginDays % cal.everyDays),
        packs: cal.packs,
        coupons: cal.coupons,
      },
      firstSteps: {
        eligible: hasWelcome,
        daysLeft: hasWelcome ? Math.max(0, firstSteps.days - user.loginDays) : 0,
        packsPerDay: firstSteps.packsPerDay,
      },
    },
    dailyPack: { available: !dailyPackClaimed },
    missions,
    matchCoins: { earnedToday: matchCoins, dailyCap: ECONOMY.matchCoins.dailyCap },
    rareCandy: {
      coinConversionsThisWeek: candyClaims,
      maxCoinConversionsPerWeek: ECONOMY.rareCandy.maxCoinConversionsPerWeek,
    },
    exchangeTokens: user.exchangeTokens,
    unopenedPacks,
    tableBetsEnabled: ECONOMY.tableBets.enabled,
  };
}

// ---------------------------------------------------------------------------
// Fichas de canje
// ---------------------------------------------------------------------------

/** Tokens a card costs, or null when it can't be redeemed (basic Energy, unknown rarity). */
export function exchangeCost(cardDefId: string): number | null {
  const card = findCardById(cardDefId);
  if (!card || isBasicEnergy(card)) return null;
  return ECONOMY.exchangeTokens.costByRarity[card.rarity] ?? null;
}

export async function redeemExchangeToken(userId: string, cardDefId: string) {
  const card = findCardById(cardDefId);
  if (!card) throw Errors.NotFound("Carta");
  const cost = exchangeCost(cardDefId);
  if (cost === null) throw Errors.BadRequest("Esta carta no se puede canjear");

  return prisma.$transaction(async (tx) => {
    const exchangeTokens = await debitBalance(userId, "exchangeTokens", cost, "exchange_redeem", `Ficha de canje: ${card.name}`, tx);
    const owned = await tx.userCard.upsert({
      where: { userId_cardDefId: { userId, cardDefId } },
      update: { quantity: { increment: 1 } },
      create: { userId, cardDefId, quantity: 1 },
      select: { quantity: true },
    });
    return { cardDefId, cardName: card.name, cost, exchangeTokens, quantity: owned.quantity };
  });
}

// ---------------------------------------------------------------------------
// Set milestones
// ---------------------------------------------------------------------------

export const ALL_SETS_KEY = "all";

interface MilestoneReward {
  coins: number;
  cardBackId: string | null;
  titleMedalId: string | null;
  skinId: string | null;
}

function milestoneReward(setId: string, percent: number): MilestoneReward | null {
  const cfg = ECONOMY.setMilestones;
  if (setId === ALL_SETS_KEY) {
    return percent === 100 ? { coins: 0, cardBackId: null, titleMedalId: cfg.collectorMedalId, skinId: null } : null;
  }
  const tier = cfg.tiers.find((t) => t.percent === percent);
  if (!tier) return null;
  return {
    coins: tier.coins,
    cardBackId: "cardBack" in tier && tier.cardBack ? cfg.cardBackId(setId) : null,
    titleMedalId: "title" in tier && tier.title ? cfg.titleMedalId(setId) : null,
    skinId: "holoVariant" in tier && tier.holoVariant ? cfg.holoVariantBySet[setId] ?? null : null,
  };
}

function setCardIds(setId: string): string[] {
  if (setId === ALL_SETS_KEY) return ALL_CARDS.map((c) => c.id);
  return getSetById(setId)?.cards.map((c) => c.id) ?? [];
}

async function ownedDistinct(db: Db, userId: string, ids: string[]): Promise<number> {
  return db.userCard.count({ where: { userId, quantity: { gt: 0 }, cardDefId: { in: ids } } });
}

const threshold = (total: number, percent: number) => Math.ceil((total * percent) / 100);

export async function getSetMilestones(userId: string) {
  const [owned, claims] = await Promise.all([
    prisma.userCard.findMany({ where: { userId, quantity: { gt: 0 } }, select: { cardDefId: true } }),
    prisma.economyClaim.findMany({ where: { userId, kind: "set_milestone" }, select: { key: true } }),
  ]);
  const ownedIds = new Set(owned.map((o) => o.cardDefId));
  const claimed = new Set(claims.map((c) => c.key));

  const describe = (setId: string, name: string, percents: number[]) => {
    const ids = setCardIds(setId);
    const have = ids.filter((id) => ownedIds.has(id)).length;
    return {
      setId,
      setName: name,
      owned: have,
      total: ids.length,
      percent: ids.length > 0 ? Math.floor((have / ids.length) * 100) : 0,
      tiers: percents.map((percent) => {
        const needed = threshold(ids.length, percent);
        return {
          percent,
          cardsNeeded: needed,
          reached: have >= needed,
          claimed: claimed.has(`${setId}:${percent}`),
          reward: milestoneReward(setId, percent),
        };
      }),
    };
  };

  return {
    sets: CARD_SETS.map((set) => describe(set.id, set.name, ECONOMY.setMilestones.tiers.map((t) => t.percent))),
    collector: describe(ALL_SETS_KEY, "Colección completa", [100]),
  };
}

export async function claimSetMilestone(userId: string, setId: string, percent: number) {
  const reward = setId === ALL_SETS_KEY || getSetById(setId) ? milestoneReward(setId, percent) : null;
  if (!reward) throw Errors.NotFound("Hito");
  const ids = setCardIds(setId);
  const setName = setId === ALL_SETS_KEY ? "toda la colección" : getSetById(setId)!.name;

  return prisma.$transaction(async (tx) => {
    await assertUser(tx, userId);
    const have = await ownedDistinct(tx, userId, ids);
    if (have < threshold(ids.length, percent)) {
      throw Errors.BadRequest(`Todavía no tienes el ${percent}% de ${setName}`);
    }
    if (!(await claimOnce(tx, userId, "set_milestone", `${setId}:${percent}`))) {
      throw Errors.Conflict("Ya reclamaste este hito");
    }

    const label = `Hito de colección: ${percent}% de ${setName}`;
    if (reward.coins > 0) await creditBalance(userId, "coins", reward.coins, "set_milestone", label, tx);
    if (reward.cardBackId) {
      await tx.userCardBack.upsert({
        where: { userId_cardBackId: { userId, cardBackId: reward.cardBackId } },
        update: {},
        create: { userId, cardBackId: reward.cardBackId },
      });
    }
    if (reward.titleMedalId) {
      await tx.userMedal.upsert({
        where: { userId_medalId: { userId, medalId: reward.titleMedalId } },
        update: {},
        create: { userId, medalId: reward.titleMedalId },
      });
    }
    if (reward.skinId) {
      await tx.userCardSkin.upsert({
        where: { userId_skinId: { userId, skinId: reward.skinId } },
        update: {},
        create: { userId, skinId: reward.skinId },
      });
    }
    return { setId, percent, ...reward };
  }, TX_OPTIONS);
}
