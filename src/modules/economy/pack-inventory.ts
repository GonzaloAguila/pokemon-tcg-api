/**
 * Unopened booster packs owned by a user (UserPack). Free packs (welcome, first steps, login
 * calendar, weekly mission, battle pass) land here and are opened when the player wants. A row
 * with `packId: null` lets the player choose any standard booster when opening it.
 */

import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../middleware/error-handler.js";
import type { Db } from "../users/users.service.js";
import {
  STANDARD_BOOSTER_IDS,
  getPackById,
  isStandardBoosterId,
  openPackForUser,
} from "../boosters/boosters.service.js";
import type { PackOpeningResult } from "../boosters/boosters.types.js";

export type PackSource =
  | "welcome"
  | "first_steps"
  | "login_calendar"
  | "weekly_mission"
  | "battle_pass"
  | "tutorial";

export const PACK_SOURCE_LABELS: Record<PackSource, string> = {
  welcome: "Bienvenida",
  first_steps: "Primeros pasos",
  login_calendar: "Calendario de visitas",
  weekly_mission: "Misión semanal",
  battle_pass: "Pase de batalla",
  tutorial: "Tutorial completado",
};

/** Add `count` unopened packs. `packId` null = player's choice of set. */
export async function grantPacks(
  tx: Db,
  userId: string,
  count: number,
  source: PackSource,
  packId: string | null = null,
): Promise<void> {
  if (count <= 0) return;
  if (packId !== null && !isStandardBoosterId(packId)) throw new Error(`grantPacks: unknown booster ${packId}`);
  await tx.userPack.createMany({
    data: Array.from({ length: count }, () => ({ userId, packId, source })),
  });
}

/** One unopened pack of every standard booster. */
export async function grantOnePackPerSet(tx: Db, userId: string, source: PackSource): Promise<void> {
  for (const packId of STANDARD_BOOSTER_IDS) await grantPacks(tx, userId, 1, source, packId);
}

export async function countUnopenedPacks(userId: string, db: Db = prisma): Promise<number> {
  return db.userPack.count({ where: { userId, openedAt: null } });
}

export async function listUnopenedPacks(userId: string) {
  const rows = await prisma.userPack.findMany({
    where: { userId, openedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, packId: true, source: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    packId: r.packId,
    packName: r.packId ? getPackById(r.packId)?.name ?? r.packId : null,
    chooseSet: r.packId === null,
    source: r.source,
    sourceLabel: PACK_SOURCE_LABELS[r.source as PackSource] ?? r.source,
    createdAt: r.createdAt,
  }));
}

/** Where a stored pack came from (user_packs.source), as the card history shows it. */
const STORED_PACK_SOURCE_LABEL: Record<string, string> = {
  welcome: "bienvenida",
  first_steps: "primeros pasos",
  login_calendar: "calendario",
  weekly_mission: "misión semanal",
  battle_pass: "pase de batalla",
  tutorial: "tutorial",
};

/**
 * Open one owned pack. `chosenPackId` is required for a "choose your set" pack and ignored
 * (must match if sent) for a fixed one. The pack is consumed with a conditional update, so two
 * concurrent opens of the same pack give cards only once.
 */
export async function openOwnedPack(
  userId: string,
  userPackId: string,
  chosenPackId?: string,
): Promise<{ pack: PackOpeningResult; unopenedPacks: number }> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.userPack.findFirst({
      where: { id: userPackId, userId },
      select: { packId: true, openedAt: true, source: true },
    });
    if (!row) throw Errors.NotFound("Sobre");
    if (row.openedAt) throw Errors.Conflict("Este sobre ya fue abierto");

    let packId: string;
    if (row.packId) {
      if (chosenPackId && chosenPackId !== row.packId) throw Errors.BadRequest("Este sobre es de otro set");
      packId = row.packId;
    } else {
      if (!chosenPackId) throw Errors.BadRequest("Elige el set del sobre");
      if (!isStandardBoosterId(chosenPackId)) throw Errors.BadRequest("Sobre inválido");
      packId = chosenPackId;
    }

    const { count } = await tx.userPack.updateMany({
      where: { id: userPackId, userId, openedAt: null },
      data: { openedAt: new Date(), openedPackId: packId },
    });
    if (count === 0) throw Errors.Conflict("Este sobre ya fue abierto");

    const label = `Sobre guardado (${STORED_PACK_SOURCE_LABEL[row.source] ?? row.source})`;
    const pack = await openPackForUser(tx, userId, packId, { reason: "stored_pack", label });
    return { pack, unopenedPacks: await countUnopenedPacks(userId, tx) };
  });
}
