/**
 * Battle Pass Service — monthly pass by activity (economy v2)
 *
 * Each economy month (Argentina time) has its own BattlePass row, auto-created on first access;
 * every user is enrolled. A user advances one step per login day of the month (the daily
 * check-in, modules/economy), up to 30 steps (or the month's length). Rewards are claimed per
 * reached step; there is no calendar progress, so missing days can't be claimed afterwards.
 * Premium (2 Rare Candies) adds the premium track for the month.
 *
 * `day` in the routes and in UserBattlePassReward is the step number. Claims made under the old
 * calendar pass stay claimed (the migration set `steps` to the highest day claimed).
 */

import { randomInt } from "crypto";
import { CardRarity, type Card } from "@gonzaloaguila/game-core";
import { RELEASED_CARDS } from "../../lib/released-sets.js";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import * as usersService from "../users/users.service.js";
import { recordCardChange } from "../users/card-ledger.js";
import { ECONOMY, type BattlePassStepReward } from "../economy/config.js";
import { economyCalendar, economyDay } from "../economy/economy-time.js";
import { grantPacks } from "../economy/pack-inventory.js";
import { grantEmote } from "../emotes/emotes.service.js";
import type {
  BattlePassRewardDef,
  BattlePassWithProgress,
  BattlePassListItem,
} from "./battle-pass.types.js";

type Db = usersService.Db;

// =============================================================================
// Calendar helpers (economy month)
// =============================================================================

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Steps reachable in a month: one per day, at most ECONOMY.battlePass.maxSteps. */
export function maxStepsForMonth(daysInMonth: number): number {
  return Math.min(ECONOMY.battlePass.maxSteps, daysInMonth);
}

function isCurrentMonth(pass: { year: number | null; month: number | null }, now = new Date()): boolean {
  if (pass.year == null || pass.month == null) return false;
  const { year, month } = economyCalendar(now);
  return pass.year === year && pass.month === month;
}

/**
 * Both tracks for a month with `maxSteps` steps. Free track: coins per step, packs at 10/20,
 * an unowned holo at the last step. Premium: ECONOMY.battlePass.premium; in shorter months the
 * step-30 rewards move to the last step.
 */
/** The premium track of a pass's month: before ECONOMY.battlePass.premiumEmotesFrom, the old one (no emotes). */
export function premiumTrackFor(period?: { year: number | null; month: number | null }): BattlePassStepReward[] {
  const cfg = ECONOMY.battlePass;
  const from = cfg.premiumEmotesFrom;
  const isBefore =
    !!period && (period.year == null || period.month == null || period.year * 12 + period.month < from.year * 12 + from.month);
  if (!isBefore) return cfg.premium;
  const old = new Map(cfg.premiumBeforeEmotes.map((r) => [r.step, r]));
  return cfg.premium.map((r) => old.get(r.step) ?? r);
}

/**
 * Both tracks for a pass of `maxSteps` steps. `period`: the pass's month (its premium track,
 * see premiumTrackFor); omitted = the current config.
 */
export function buildRewards(maxSteps: number, period?: { year: number | null; month: number | null }): BattlePassRewardDef[] {
  const cfg = ECONOMY.battlePass;
  const full = cfg.maxSteps;
  const standard: BattlePassStepReward[] = [];
  for (let step = 1; step <= full; step++) {
    if (step === full) standard.push({ step, rewardType: "unowned_holo", label: "Carta holo que no tengas" });
    else if (cfg.standardPackSteps.includes(step)) standard.push({ step, rewardType: "pack", label: "Sobre a elección" });
    else standard.push({ step, rewardType: "coins", amount: cfg.standardCoinsPerStep, label: `${cfg.standardCoinsPerStep} Monedas` });
  }

  const toDefs = (track: "standard" | "premium", rewards: BattlePassStepReward[]): BattlePassRewardDef[] => {
    const kept = rewards.filter((r) => r.step < maxSteps);
    const last = rewards.filter((r) => r.step === full).map((r) => ({ ...r, step: maxSteps }));
    return [...kept, ...last].map((r) => ({
      day: r.step,
      track,
      rewardType: r.rewardType,
      ...(r.amount !== undefined ? { amount: r.amount } : {}),
      ...(r.rewardId !== undefined ? { rewardId: r.rewardId } : {}),
      label: r.label,
    }));
  };
  return [...toDefs("standard", standard), ...toDefs("premium", premiumTrackFor(period))].sort(
    (a, b) => a.day - b.day || (a.track === "standard" ? -1 : 1),
  );
}

// =============================================================================
// Monthly pass + enrollment (idempotent, safe inside a transaction)
// =============================================================================

export async function getOrCreateMonthlyPass(db: Db = prisma, now = new Date()) {
  const { year, month, daysInMonth } = economyCalendar(now);
  const existing = await db.battlePass.findUnique({ where: { year_month: { year, month } } });
  if (existing) return existing;

  const monthName = MONTH_NAMES[month - 1];
  // Expire any previous active passes
  await db.battlePass.updateMany({ where: { status: "active" }, data: { status: "expired" } });
  // ON CONFLICT DO NOTHING: a concurrent first visit may create it at the same time
  await db.battlePass.createMany({
    data: [{
      slug: `${year}-${String(month).padStart(2, "0")}`,
      name: `Pase de Batalla — ${monthName} ${year}`,
      description: `Pase de batalla mensual de ${monthName} ${year}. Avanza un paso por cada día que entras.`,
      imageUrl: "",
      durationDays: daysInMonth,
      premiumPrice: ECONOMY.battlePass.premiumPriceRareCandy,
      status: "active",
      rewards: buildRewards(maxStepsForMonth(daysInMonth), { year, month }) as any,
      year,
      month,
    }],
    skipDuplicates: true,
  });
  return db.battlePass.findUniqueOrThrow({ where: { year_month: { year, month } } });
}

async function getOrCreateEnrollment(userId: string, passId: string, db: Db = prisma) {
  await db.userBattlePass.createMany({ data: [{ userId, battlePassId: passId }], skipDuplicates: true });
  return db.userBattlePass.findUniqueOrThrow({
    where: { userId_battlePassId: { userId, battlePassId: passId } },
    include: { claimedRewards: true },
  });
}

/**
 * One battle-pass step for today's login (called by the daily check-in, inside its
 * transaction). Returns the new step count, or null when today's step was already taken or
 * the month's steps are exhausted.
 */
export async function advanceStepForLogin(tx: Db, userId: string, now = new Date()): Promise<number | null> {
  const pass = await getOrCreateMonthlyPass(tx, now);
  const enrollment = await getOrCreateEnrollment(userId, pass.id, tx);
  const today = economyDay(now);
  const maxSteps = maxStepsForMonth(pass.durationDays);
  const { count } = await tx.userBattlePass.updateMany({
    where: {
      id: enrollment.id,
      steps: { lt: maxSteps },
      OR: [{ lastStepDay: null }, { lastStepDay: { not: today } }],
    },
    data: { steps: { increment: 1 }, lastStepDay: today },
  });
  if (count === 0) return null;
  const { steps } = await tx.userBattlePass.findUniqueOrThrow({ where: { id: enrollment.id }, select: { steps: true } });
  return steps;
}

// =============================================================================
// Read
// =============================================================================

function rewardsOf(pass: { durationDays: number; year: number | null; month: number | null }): BattlePassRewardDef[] {
  return buildRewards(maxStepsForMonth(pass.durationDays), pass);
}

function toProgress(
  pass: Awaited<ReturnType<typeof getOrCreateMonthlyPass>>,
  enrollment: Awaited<ReturnType<typeof getOrCreateEnrollment>>,
  now: Date,
): BattlePassWithProgress {
  const { dayOfMonth, daysInMonth } = economyCalendar(now);
  const maxSteps = maxStepsForMonth(pass.durationDays);
  return {
    id: pass.id,
    slug: pass.slug,
    name: pass.name,
    description: pass.description,
    imageUrl: pass.imageUrl,
    durationDays: pass.durationDays,
    premiumPrice: pass.premiumPrice,
    status: pass.status,
    rewards: rewardsOf(pass),
    year: pass.year ?? undefined,
    month: pass.month ?? undefined,
    daysRemaining: Math.max(daysInMonth - dayOfMonth, 0),
    enrollment: {
      activatedAt: enrollment.activatedAt.toISOString(),
      isPremium: enrollment.isPremium,
      steps: enrollment.steps,
      maxSteps,
      steppedToday: enrollment.lastStepDay === economyDay(now),
      currentDay: enrollment.steps,
      claimedRewards: enrollment.claimedRewards.map((r) => ({ day: r.day, track: r.track })),
    },
  };
}

export async function getCurrentPassWithProgress(userId: string, now = new Date()): Promise<BattlePassWithProgress> {
  const pass = await getOrCreateMonthlyPass(prisma, now);
  const enrollment = await getOrCreateEnrollment(userId, pass.id);
  return toProgress(pass, enrollment, now);
}

export async function getAvailablePasses(userId?: string, now = new Date()): Promise<BattlePassListItem[]> {
  const pass = await getOrCreateMonthlyPass(prisma, now);
  const enrollment = userId
    ? await prisma.userBattlePass.findUnique({ where: { userId_battlePassId: { userId, battlePassId: pass.id } } })
    : null;
  const { dayOfMonth, daysInMonth } = economyCalendar(now);
  return [
    {
      id: pass.id,
      slug: pass.slug,
      name: pass.name,
      description: pass.description,
      imageUrl: pass.imageUrl,
      durationDays: pass.durationDays,
      premiumPrice: pass.premiumPrice,
      status: pass.status,
      isEnrolled: true,
      isPremium: enrollment?.isPremium ?? false,
      currentDay: enrollment?.steps ?? 0,
      steps: enrollment?.steps ?? 0,
      maxSteps: maxStepsForMonth(pass.durationDays),
      year: pass.year ?? undefined,
      month: pass.month ?? undefined,
      daysRemaining: Math.max(daysInMonth - dayOfMonth, 0),
    },
  ];
}

export async function getPassWithProgress(passId: string, userId: string, now = new Date()): Promise<BattlePassWithProgress> {
  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");
  if (!isCurrentMonth(pass, now)) throw Errors.BadRequest("Este pase ya expiró");
  const enrollment = await getOrCreateEnrollment(userId, pass.id);
  return toProgress(pass, enrollment, now);
}

// =============================================================================
// Upgrade to premium
// =============================================================================

export async function upgradeToPremium(passId: string, userId: string, now = new Date()) {
  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");

  if (!isCurrentMonth(pass, now)) {
    throw Errors.BadRequest("Solo puedes comprar premium del mes actual");
  }

  const enrollment = await getOrCreateEnrollment(userId, pass.id);
  if (enrollment.isPremium) throw Errors.Conflict("Ya tienes el pase premium");

  return prisma.$transaction(async (tx) => {
    // Flip to premium only if still standard; concurrent upgrades match nothing and pay nothing.
    const { count } = await tx.userBattlePass.updateMany({
      where: { id: enrollment.id, isPremium: false },
      data: { isPremium: true, upgradedAt: new Date() },
    });
    if (count === 0) throw Errors.Conflict("Ya tienes el pase premium");

    await usersService.spendRareCandy(
      userId,
      pass.premiumPrice,
      "battle_pass_upgrade",
      `Mejora a Premium: ${pass.name}`,
      tx,
    );

    return { isPremium: true };
  });
}

// =============================================================================
// Claim reward
// =============================================================================

export async function claimReward(passId: string, userId: string, step: number, track: string, now = new Date()) {
  if (track !== "standard" && track !== "premium") {
    throw Errors.BadRequest("Track inválido");
  }

  const pass = await prisma.battlePass.findUnique({ where: { id: passId } });
  if (!pass) throw Errors.NotFound("Pase de batalla");
  if (!isCurrentMonth(pass, now)) {
    throw Errors.BadRequest("Este pase ya expiró, no puedes reclamar recompensas");
  }

  const rewardDef = rewardsOf(pass).find((r) => r.day === step && r.track === track);
  if (!rewardDef) throw Errors.NotFound("Recompensa");

  return prisma.$transaction(async (tx) => {
    const enrollment = await getOrCreateEnrollment(userId, pass.id, tx);
    if (step < 1 || step > enrollment.steps) {
      throw Errors.BadRequest("Todavía no llegaste a este paso: avanzas un paso por cada día que entras");
    }
    if (track === "premium" && !enrollment.isPremium) {
      throw Errors.BadRequest("Necesitas el pase premium para reclamar esta recompensa");
    }

    // ON CONFLICT DO NOTHING: a concurrent claim of the same step inserts nothing and grants nothing
    const { count } = await tx.userBattlePassReward.createMany({
      data: [{ userBattlePassId: enrollment.id, day: step, track }],
      skipDuplicates: true,
    });
    if (count === 0) throw Errors.Conflict("Ya reclamaste esta recompensa");

    const granted = await grantReward(tx, userId, rewardDef);
    return { day: step, step, track, rewardType: rewardDef.rewardType, label: rewardDef.label, granted };
  });
}

// =============================================================================
// Reward granting (inside transaction)
// =============================================================================

const holoCards: Card[] = RELEASED_CARDS.filter((c) => c.rarity === CardRarity.RareHolo);

/** A random rare-holo the user doesn't own (any quantity); any holo when they own them all. */
export async function pickUnownedHolo(tx: Db, userId: string): Promise<Card> {
  const owned = await tx.userCard.findMany({
    where: { userId, quantity: { gt: 0 }, cardDefId: { in: holoCards.map((c) => c.id) } },
    select: { cardDefId: true },
  });
  const ownedIds = new Set(owned.map((o) => o.cardDefId));
  const unowned = holoCards.filter((c) => !ownedIds.has(c.id));
  const pool = unowned.length > 0 ? unowned : holoCards;
  return pool[randomInt(0, pool.length)];
}

async function grantReward(tx: Db, userId: string, reward: BattlePassRewardDef) {
  const label = `Pase de batalla: ${reward.label}`;
  switch (reward.rewardType) {
    case "coins": {
      const amount = reward.amount ?? 0;
      const { coins: newBalance } = await usersService.addCoins(userId, amount, "battle_pass_reward", label, tx);
      return { type: "coins", amount, newBalance };
    }

    case "pack": {
      await grantPacks(tx, userId, 1, "battle_pass");
      return { type: "pack", amount: 1, toInventory: true };
    }

    case "unowned_holo": {
      const card = await pickUnownedHolo(tx, userId);
      await tx.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId: card.id } },
        update: { quantity: { increment: 1 } },
        create: { userId, cardDefId: card.id, quantity: 1 },
      });
      await recordCardChange(tx, userId, "battle_pass", label, [{ cardDefId: card.id, quantity: 1 }]);
      return { type: "card", cardDefId: card.id, cardName: card.name };
    }

    case "card_back": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCardBack.upsert({
        where: { userId_cardBackId: { userId, cardBackId: reward.rewardId } },
        update: {},
        create: { userId, cardBackId: reward.rewardId },
      });
      return { type: "card_back", cardBackId: reward.rewardId };
    }

    case "profile_coin": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCoin.upsert({
        where: { userId_coinId: { userId, coinId: reward.rewardId } },
        update: {},
        create: { userId, coinId: reward.rewardId },
      });
      return { type: "profile_coin", coinId: reward.rewardId };
    }

    case "avatar": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userAvatar.upsert({
        where: { userId_avatarId: { userId, avatarId: reward.rewardId } },
        update: {},
        create: { userId, avatarId: reward.rewardId },
      });
      return { type: "avatar", avatarId: reward.rewardId };
    }

    case "playmat": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userPlaymat.upsert({
        where: { userId_playmatId: { userId, playmatId: reward.rewardId } },
        update: {},
        create: { userId, playmatId: reward.rewardId },
      });
      return { type: "playmat", playmatId: reward.rewardId };
    }

    case "emote": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await grantEmote(tx, userId, reward.rewardId);
      return { type: "emote", emoteId: reward.rewardId };
    }

    case "card_skin": {
      if (!reward.rewardId) throw Errors.BadRequest("Reward missing rewardId");
      await tx.userCardSkin.upsert({
        where: { userId_skinId: { userId, skinId: reward.rewardId } },
        update: {},
        create: { userId, skinId: reward.rewardId },
      });
      return { type: "card_skin", skinId: reward.rewardId };
    }

    default:
      return { type: "unknown" };
  }
}
