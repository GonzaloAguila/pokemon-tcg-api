/**
 * Modo Aventura runs (design §5.1). The rules are in run-logic.ts (pure); this file loads and
 * stores runs, one `$transaction` per mutation after the user's row lock (`lockUsers`), so a run
 * never changes twice at once. The battle's result only comes from the server's adventure room
 * (`applyRunBattleResult`, no route): no endpoint accepts a result, a coin or a seed.
 */
import { randomBytes } from "node:crypto";
import { Prisma, type AdventureRun } from "@prisma/client";
import { isPokemonCard } from "@gonzaloaguila/game-core";
import { prisma } from "../../lib/prisma.js";
import { AppError, Errors } from "../../middleware/error-handler.js";
import { lockUsers } from "../users/xp.service.js";
import type { Db } from "../users/users.service.js";
import { recordCardChange } from "../users/card-ledger.js";
import { claimOnce, hasClaim } from "../economy/claims.js";
import { checkAndUpdateProgress } from "../achievements/achievements.service.js";
import { cardOf } from "./content/cards.js";
import { getAdventure, getAdventures, type Adventure } from "./content/load.js";
import { describeModifier } from "./content/modifiers.js";
import type { AdventureBattle, AdventureReward, Difficulty } from "./content/schema.js";
import type { AdventurePassive, BattleModifier, CardEntry } from "./engine-types.js";
import * as logic from "./run-logic.js";
import { RunPhaseError, RunRuleError, type DeckEdit, type RunEvent, type RunState, type TreasureChoice } from "./run-logic.types.js";

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

/** How a battle ended (adventure room end detection). */
export type BattleEndReason = "prizes" | "no-pokemon" | "deck-out" | "surrender";

/** `AdventureRun.battle`: the live battle. Only `roomId` ever leaves the server. */
export interface BattleSnapshot {
  roomId: string;
  startedAt: string;
  state?: unknown;
  rngState?: number;
  aiPlan?: unknown;
  humanActions?: unknown[];
}

/**
 * The socket layer's adventure rooms (Task 12) register here, so starting a battle over HTTP
 * makes sure its room exists. Without a host (HTTP-only tests) the room id is just recorded.
 */
export interface AdventureBattleHost {
  ensureRoom(runId: string): Promise<void>;
  /** False while the server can't run battles (no engine): the battle isn't started. */
  isAvailable(): boolean;
}
let battleHost: AdventureBattleHost | null = null;
export function setAdventureBattleHost(host: AdventureBattleHost | null) {
  battleHost = host;
}

// ---------------------------------------------------------------------------
// Rows ↔ run state
// ---------------------------------------------------------------------------

function adventureOf(adventureId: string): Adventure {
  const adventure = getAdventure(adventureId);
  if (!adventure) throw Errors.NotFound("Aventura");
  return adventure;
}

/** A run row as run-logic state. */
export function runStateOf(row: AdventureRun): RunState {
  return {
    adventureId: row.adventureId,
    adventureVersion: row.adventureVersion,
    difficulty: row.difficulty as Difficulty,
    starterId: row.starterId,
    status: row.status as RunState["status"],
    phase: row.phase as RunState["phase"],
    currentBattle: row.currentBattle,
    attempt: row.attempt,
    hearts: row.hearts,
    maxHearts: row.maxHearts,
    heartsLost: row.heartsLost,
    deck: row.deck as unknown as CardEntry[],
    passives: row.passives as AdventurePassive[],
    treasuresTaken: row.treasuresTaken,
    treasuresSkipped: row.treasuresSkipped,
    pendingOffer: row.pendingOffer,
    offTypeUsed: row.offTypeUsed,
    seed: row.seed,
  };
}

/** The columns run-logic may change. */
function stateData(state: RunState) {
  return {
    status: state.status,
    phase: state.phase,
    currentBattle: state.currentBattle,
    attempt: state.attempt,
    hearts: state.hearts,
    maxHearts: state.maxHearts,
    heartsLost: state.heartsLost,
    deck: state.deck as unknown as Prisma.InputJsonValue,
    passives: state.passives,
    treasuresTaken: state.treasuresTaken,
    treasuresSkipped: state.treasuresSkipped,
    pendingOffer: state.pendingOffer,
    offTypeUsed: state.offTypeUsed,
    ...(state.phase === "finished" ? { finishedAt: new Date() } : {}),
  };
}

/** Run the pure rules and map their errors to HTTP statuses. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RunPhaseError) throw Errors.Conflict(err.message);
    if (err instanceof RunRuleError) throw Errors.ValidationError(err.message);
    throw err;
  }
}

function battleOf(adventure: Adventure, index: number): AdventureBattle | undefined {
  return adventure.battles.find((b) => b.index === index);
}

/** The map's Pokémon for a battle: its `lead`, else the first Pokémon of the deck it uses. */
function leadOf(battle: AdventureBattle, deck: readonly CardEntry[]): string | null {
  return battle.opponent.lead ?? deck.find((e) => isPokemonCard(cardOf(e.cardId)))?.cardId ?? null;
}

const rulesOf = (battle: AdventureBattle) => battle.modifiers.map((m) => describeModifier(m as BattleModifier));

function treasureView(adventure: Adventure, state: RunState, id: string) {
  const treasure = adventure.treasures.find((t) => t.id === id);
  if (!treasure) return null;
  const starter = adventure.starters.find((s) => s.id === state.starterId)!;
  const base = { id: treasure.id, name: treasure.name, description: treasure.description, kind: treasure.kind };
  return treasure.kind === "cards"
    ? { ...base, cards: logic.resolveTreasureCards(treasure, starter) }
    : { ...base, passive: treasure.passive };
}

/** What the client gets: never `seed`, never the battle snapshot beyond its room id. */
export function serializeRun(row: AdventureRun) {
  const adventure = adventureOf(row.adventureId);
  const state = runStateOf(row);
  const battle = battleOf(adventure, state.currentBattle);
  const snapshot = row.battle as BattleSnapshot | null;
  const rivalDeck = battle ? logic.rivalDeckFor(adventure, battle.index, state.difficulty, state.starterId) : [];
  return {
    id: row.id,
    adventureId: row.adventureId,
    adventureVersion: row.adventureVersion,
    difficulty: state.difficulty,
    starterId: state.starterId,
    status: state.status,
    phase: state.phase,
    currentBattle: state.currentBattle,
    battleCount: adventure.battles.length,
    attempt: state.attempt,
    hearts: state.hearts,
    maxHearts: state.maxHearts,
    heartsLost: state.heartsLost,
    deck: state.deck,
    passives: state.passives,
    treasuresTaken: state.treasuresTaken,
    treasuresSkipped: state.treasuresSkipped,
    pendingOffer: state.pendingOffer,
    offer: state.pendingOffer.map((id) => treasureView(adventure, state, id)).filter((t) => t !== null),
    battle: snapshot ? { roomId: snapshot.roomId } : null,
    currentBattleInfo: battle
      ? {
          index: battle.index,
          id: battle.id,
          location: battle.location,
          opponent: { name: battle.opponent.name, trainerClass: battle.opponent.trainerClass, lead: leadOf(battle, rivalDeck) },
          rules: rulesOf(battle),
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}
export type RunView = ReturnType<typeof serializeRun>;

/** The user's run, locked for the transaction (404 if missing or someone else's). */
async function lockedRun(tx: Db, userId: string, runId: string): Promise<AdventureRun> {
  await lockUsers(tx, [userId]);
  const run = await tx.adventureRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw Errors.NotFound("Aventura en curso");
  return run;
}

// ---------------------------------------------------------------------------
// Adventures
// ---------------------------------------------------------------------------

function rewardKey(adventureId: string, difficulty: Difficulty) {
  return `${adventureId}:${difficulty}`;
}

async function progressOf(db: Db, userId: string, adventureId: string) {
  const row = await db.adventureProgress.findUnique({ where: { userId_adventureId: { userId, adventureId } } });
  return {
    clearsNormal: row?.clearsNormal ?? 0,
    clearsHard: row?.clearsHard ?? 0,
    clearedStartersNormal: row?.clearedStartersNormal ?? [],
    clearedStartersHard: row?.clearedStartersHard ?? [],
    runsPlayed: row?.runsPlayed ?? 0,
  };
}

async function rewardsView(userId: string, adventure: Adventure) {
  const view = async (difficulty: Difficulty) => ({
    ...adventure.rewards[difficulty],
    claimed: await hasClaim(prisma, userId, "adventure", rewardKey(adventure.id, difficulty)),
  });
  return { normal: await view("normal"), hard: await view("hard") };
}

const achievementsView = (adventure: Adventure) =>
  adventure.achievements.map(({ id, name, description, tier }) => ({ id, name, description, tier }));

/** GET /adventures */
export async function listAdventures(userId: string) {
  const active = await prisma.adventureRun.findFirst({ where: { userId, status: "active" } });
  return Promise.all(
    [...getAdventures().values()].map(async (adventure) => ({
      id: adventure.id,
      version: adventure.version,
      name: adventure.name,
      description: adventure.description,
      starters: adventure.starters.map((s) => ({ id: s.id, name: s.name, energyType: s.energyType })),
      battleCount: adventure.battles.length,
      rewards: await rewardsView(userId, adventure),
      progress: await progressOf(prisma, userId, adventure.id),
      achievements: achievementsView(adventure),
      activeRun:
        active && active.adventureId === adventure.id
          ? {
              id: active.id,
              difficulty: active.difficulty,
              starterId: active.starterId,
              phase: active.phase,
              currentBattle: active.currentBattle,
              hearts: active.hearts,
              maxHearts: active.maxHearts,
            }
          : null,
    })),
  );
}

/**
 * GET /adventures/:id — rival decks only of the battles the active run already beat; the battle
 * rules of those and of the current one; future battles show only who and where.
 */
export async function getAdventureDetail(userId: string, adventureId: string) {
  const adventure = adventureOf(adventureId);
  const [activeRow, unlocks] = await Promise.all([
    prisma.adventureRun.findFirst({ where: { userId, status: "active", adventureId } }),
    prisma.userStarterUnlock.findMany({ where: { userId }, select: { starterId: true } }),
  ]);
  const active = activeRow ? runStateOf(activeRow) : null;
  const beatenUpTo = !active ? 0 : active.phase === "choosing_treasure" ? active.currentBattle : active.currentBattle - 1;
  const current = active && (active.phase === "pre_battle" || active.phase === "in_battle") ? active.currentBattle : null;
  const unlocked = new Set(unlocks.map((u) => u.starterId));

  return {
    id: adventure.id,
    version: adventure.version,
    name: adventure.name,
    description: adventure.description,
    rules: adventure.rules,
    starters: adventure.starters.map((s) => ({
      id: s.id,
      name: s.name,
      energyType: s.energyType,
      line: s.line,
      deck: s.deck,
      locked: !!s.requiresUnlock && !unlocked.has(s.id),
    })),
    battles: adventure.battles.map((battle) => {
      const deck = active
        ? logic.rivalDeckFor(adventure, battle.index, active.difficulty, active.starterId)
        : (battle.opponent.deck ?? battle.opponent.deckByDifficulty!.normal);
      const beaten = battle.index <= beatenUpTo;
      return {
        index: battle.index,
        id: battle.id,
        location: battle.location,
        opponent: { name: battle.opponent.name, trainerClass: battle.opponent.trainerClass, lead: leadOf(battle, deck) },
        treasurePool: battle.treasurePool,
        beaten,
        current: battle.index === current,
        rules: beaten || battle.index === current ? rulesOf(battle) : null,
        rivalDeck: beaten ? deck : null,
      };
    }),
    treasures: adventure.treasures,
    treasurePools: adventure.treasurePools,
    rewards: await rewardsView(userId, adventure),
    achievements: achievementsView(adventure),
    activeRunId: activeRow?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** POST /adventure/runs */
export async function createRun(userId: string, input: { adventureId: string; difficulty: Difficulty; starterId: string }) {
  const adventure = adventureOf(input.adventureId);
  const starter = adventure.starters.find((s) => s.id === input.starterId);
  if (!starter) throw Errors.NotFound("Inicial");

  try {
    const row = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [userId]);
      if (starter.requiresUnlock) {
        const unlock = await tx.userStarterUnlock.findUnique({ where: { userId_starterId: { userId, starterId: starter.id } } });
        if (!unlock) throw Errors.Forbidden("Todavía no desbloqueaste este inicial");
      }
      if (await tx.adventureRun.findFirst({ where: { userId, status: "active" }, select: { id: true } })) {
        throw Errors.Conflict("Ya tienes una aventura en curso");
      }
      const state = logic.newRun(adventure, { difficulty: input.difficulty, starterId: starter.id, seed: randomBytes(16).toString("hex") });
      await tx.adventureProgress.upsert({
        where: { userId_adventureId: { userId, adventureId: adventure.id } },
        update: { runsPlayed: { increment: 1 } },
        create: { userId, adventureId: adventure.id, runsPlayed: 1 },
      });
      return tx.adventureRun.create({
        data: {
          userId,
          adventureId: state.adventureId,
          adventureVersion: state.adventureVersion,
          difficulty: state.difficulty,
          starterId: state.starterId,
          seed: state.seed,
          ...stateData(state),
        },
      });
    }, TX_OPTIONS);
    return serializeRun(row);
  } catch (err) {
    // The partial unique index adventure_runs_one_active, if the lock was ever bypassed
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw Errors.Conflict("Ya tienes una aventura en curso");
    }
    throw err;
  }
}

/** GET /adventure/runs/active */
export async function getActiveRun(userId: string) {
  const row = await prisma.adventureRun.findFirst({ where: { userId, status: "active" } });
  if (!row) throw Errors.NotFound("Aventura en curso");
  return serializeRun(row);
}

/** GET /adventure/runs/:id (own runs only). */
export async function getRun(userId: string, runId: string) {
  const row = await prisma.adventureRun.findFirst({ where: { id: runId, userId } });
  if (!row) throw Errors.NotFound("Aventura");
  return serializeRun(row);
}

async function mutateRun(userId: string, runId: string, change: (state: RunState, adventure: Adventure) => RunState) {
  const row = await prisma.$transaction(async (tx) => {
    const run = await lockedRun(tx, userId, runId);
    const next = rule(() => change(runStateOf(run), adventureOf(run.adventureId)));
    return tx.adventureRun.update({ where: { id: run.id }, data: stateData(next) });
  }, TX_OPTIONS);
  return serializeRun(row);
}

/** PATCH /adventure/runs/:id/deck */
export function editRunDeck(userId: string, runId: string, edit: DeckEdit) {
  return mutateRun(userId, runId, (state, adventure) => logic.editDeck(state, adventure, edit));
}

/** POST /adventure/runs/:id/treasure */
export function chooseRunTreasure(userId: string, runId: string, choice: TreasureChoice) {
  return mutateRun(userId, runId, (state, adventure) => logic.chooseTreasure(state, adventure, choice));
}

/** POST /adventure/runs/:id/abandon */
export function abandonRun(userId: string, runId: string) {
  return mutateRun(userId, runId, (state) => logic.abandonRun(state));
}

/**
 * POST /adventure/runs/:id/battle — pre_battle → in_battle with a new room id; while the battle
 * lasts, the same room id (the room itself is rebuilt from the run if the server lost it).
 */
export async function startRunBattle(userId: string, runId: string): Promise<{ roomId: string }> {
  if (battleHost && !battleHost.isAvailable()) {
    throw new AppError("Las batallas de aventura no están disponibles en este momento", 503, "ADVENTURE_UNAVAILABLE");
  }
  const roomId = await prisma.$transaction(async (tx) => {
    const run = await lockedRun(tx, userId, runId);
    const snapshot = run.battle as BattleSnapshot | null;
    if (run.status === "active" && run.phase === "in_battle" && snapshot?.roomId) return snapshot.roomId;
    const next = rule(() => logic.startBattle(runStateOf(run), adventureOf(run.adventureId)));
    const battle: BattleSnapshot = { roomId: `adv-${randomBytes(6).toString("hex")}`, startedAt: new Date().toISOString() };
    await tx.adventureRun.update({
      where: { id: run.id },
      data: { ...stateData(next), battle: battle as unknown as Prisma.InputJsonValue },
    });
    return battle.roomId;
  }, TX_OPTIONS);
  await battleHost?.ensureRoom(runId);
  return { roomId };
}

// ---------------------------------------------------------------------------
// Battle results (server only: the adventure room's end detection)
// ---------------------------------------------------------------------------

async function grantReward(tx: Db, userId: string, adventure: Adventure, difficulty: Difficulty): Promise<AdventureReward | null> {
  if (!(await claimOnce(tx, userId, "adventure", rewardKey(adventure.id, difficulty)))) return null;
  const reward = adventure.rewards[difficulty];
  switch (reward.type) {
    case "cosmetic":
      await tx.userCardBack.upsert({
        where: { userId_cardBackId: { userId, cardBackId: reward.id } },
        update: {},
        create: { userId, cardBackId: reward.id },
      });
      break;
    case "starter_unlock":
      await tx.userStarterUnlock.createMany({ data: [{ userId, starterId: reward.id }], skipDuplicates: true });
      break;
    case "card":
      await tx.userCard.upsert({
        where: { userId_cardDefId: { userId, cardDefId: reward.cardId } },
        update: { quantity: { increment: 1 } },
        create: { userId, cardDefId: reward.cardId, quantity: 1 },
      });
      await recordCardChange(tx, userId, "adventure_reward", `Aventura: ${adventure.name}`, [{ cardDefId: reward.cardId, quantity: 1 }], adventure.id);
      break;
  }
  return reward;
}

async function recordClear(tx: Db, userId: string, adventure: Adventure, state: RunState) {
  const facts = logic.achievementFacts(state);
  const progress = await progressOf(tx, userId, adventure.id);
  const hard = facts.difficulty === "hard";
  const starters = hard ? progress.clearedStartersHard : progress.clearedStartersNormal;
  const clearedStarters = starters.includes(facts.starterId) ? starters : [...starters, facts.starterId];
  const counters = {
    ...(hard ? { clearsHard: { increment: 1 } } : { clearsNormal: { increment: 1 } }),
    ...(hard ? { clearedStartersHard: clearedStarters } : { clearedStartersNormal: clearedStarters }),
    ...(facts.flawless ? { flawlessClears: { increment: 1 } } : {}),
    ...(facts.purist ? { puristClears: { increment: 1 } } : {}),
    ...(facts.monotype ? { monotypeClears: { increment: 1 } } : {}),
  };
  await tx.adventureProgress.upsert({
    where: { userId_adventureId: { userId, adventureId: adventure.id } },
    update: counters,
    create: {
      userId,
      adventureId: adventure.id,
      clearsNormal: hard ? 0 : 1,
      clearsHard: hard ? 1 : 0,
      clearedStartersNormal: hard ? [] : clearedStarters,
      clearedStartersHard: hard ? clearedStarters : [],
      flawlessClears: facts.flawless ? 1 : 0,
      puristClears: facts.purist ? 1 : 0,
      monotypeClears: facts.monotype ? 1 : 0,
    },
  });
}

export interface BattleResultApplied {
  run: RunView;
  events: RunEvent[];
  /** The unique reward granted by this result (first win of the difficulty), else null. */
  reward: AdventureReward | null;
}

/**
 * Apply the end of the run's current battle exactly once: null when the run isn't in a battle
 * (already applied, or never started). Writes the battle row, moves the run on and, on the last
 * battle's victory, the progress and the unique reward; achievements are re-checked after the
 * commit.
 */
export async function applyRunBattleResult(
  runId: string,
  result: { victory: boolean; reason: BattleEndReason; turns: number },
): Promise<BattleResultApplied | null> {
  const owner = await prisma.adventureRun.findUnique({ where: { id: runId }, select: { userId: true } });
  if (!owner) return null;
  const applied = await prisma.$transaction(async (tx) => {
    const run = await lockedRun(tx, owner.userId, runId);
    if (run.status !== "active" || run.phase !== "in_battle") return null;
    const adventure = adventureOf(run.adventureId);
    const before = runStateOf(run);
    const snapshot = run.battle as BattleSnapshot | null;
    const { count } = await tx.adventureBattleResult.createMany({
      data: [{
        runId,
        battleIndex: before.currentBattle,
        attempt: before.attempt,
        victory: result.victory,
        reason: result.reason,
        turns: Math.max(0, Math.floor(result.turns)),
        startedAt: snapshot?.startedAt ? new Date(snapshot.startedAt) : new Date(),
      }],
      skipDuplicates: true,
    });
    if (count === 0) return null;

    const { run: after, events } = logic.applyBattleResult(before, adventure, { victory: result.victory });
    let reward: AdventureReward | null = null;
    if (after.status === "won") {
      await recordClear(tx, owner.userId, adventure, after);
      reward = await grantReward(tx, owner.userId, adventure, after.difficulty);
    }
    const row = await tx.adventureRun.update({
      where: { id: runId },
      data: { ...stateData(after), battle: Prisma.DbNull },
    });
    return { run: serializeRun(row), events, reward, won: after.status === "won" };
  }, TX_OPTIONS);
  if (!applied) return null;
  if (applied.won) {
    await checkAndUpdateProgress(owner.userId).catch((err) => console.error("Adventure achievements check failed:", err));
  }
  const { won: _won, ...rest } = applied;
  return rest;
}
