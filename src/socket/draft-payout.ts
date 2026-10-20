/**
 * Pays a finished draft's prizes (room.prizes): the entry-fee pool coins plus the admin's
 * configured rewards (coins, unopened packs, cosmetics). One transaction per player, claimed
 * once in the DB (EconomyClaim "draft_prize"), so calling it again pays nobody twice.
 */
import { CARD_SETS } from "@gonzaloaguila/game-core";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import * as usersService from "../modules/users/users.service.js";
import type { Db } from "../modules/users/users.service.js";
import { lockUsers } from "../modules/users/xp.service.js";
import { claimOnce } from "../modules/economy/claims.js";
import { grantPacks } from "../modules/economy/pack-inventory.js";
import { boosterIdForSet } from "../modules/boosters/boosters.service.js";
import { COSMETIC_TYPE_LABELS } from "../modules/admin/grantable-cosmetics.js";
import {
  ADMIN_ONLY_PLAYMATS,
  ALL_VARIANTS,
  AVAILABLE_AVATARS,
  AVAILABLE_CARD_BACKS,
  AVAILABLE_COINS,
  AVAILABLE_PLAYMATS,
  TROPHIES,
} from "../modules/prizes/catalog.js";
import { BATTLE_EMOTES } from "../modules/emotes/catalog.js";
import { grantEmote } from "../modules/emotes/emotes.service.js";
import { isEmptyGrant, type DraftRewardGrant, type DraftRewardItem } from "./draft-rewards.js";
import type { DraftPrize, DraftRoom } from "./draft-rooms.js";

/** One claim per player and draft (room codes repeat across restarts; the creation time doesn't). */
export function draftPrizeClaimKey(room: Pick<DraftRoom, "id" | "createdAt">): string {
  return `${room.id}:${room.createdAt.getTime()}`;
}

/**
 * The admin log of a draft created with prizes: who set them, for which room, every tier. There
 * is no admin audit table; like the backoffice grants it is a SystemMessage row, sent by the admin
 * to themselves (automatic: kept out of the backoffice's sent list). Returns its id.
 */
export async function logDraftRewards(room: Pick<DraftRoom, "id" | "createdAt" | "adminId" | "adminName" | "config">): Promise<string> {
  const tiers = room.config.rewards;
  const row = await prisma.systemMessage.create({
    data: {
      type: "personal",
      title: `Draft ${room.id} creado con premios`,
      content: `Creaste la mesa de draft **${room.id}** con ${tiers.length} ${tiers.length === 1 ? "premio" : "premios"}. Se pagan al terminar el torneo.`,
      category: "info",
      senderId: room.adminId,
      recipientId: room.adminId,
      metadata: {
        kind: "draft_rewards",
        draftRoomId: room.id,
        draftCreatedAt: room.createdAt.toISOString(),
        adminId: room.adminId,
        tiers,
      } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  console.log(`[draft] Room ${room.id} created by ${room.adminName} (${room.adminId}) with prizes (log ${row.id}): ${JSON.stringify(tiers)}`);
  return row.id;
}

/** Waits before each new try of the prizes that failed (the room lives FINISHED_ROOM_TTL_MS: 30 min). */
export const PRIZE_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/**
 * The prizes of a finished tournament (room.prizes), once per room and once per player in the DB.
 * Failed ones stay in room.unpaidPrizes and are tried again after each of `retryDelaysMs` while
 * `isAlive()`; every failure is logged with what was owed, to pay by hand if they never go through.
 */
export async function payDraftPrizes(
  room: DraftRoom,
  { isAlive = () => true, retryDelaysMs = PRIZE_RETRY_DELAYS_MS }: { isAlive?: () => boolean; retryDelaysMs?: readonly number[] } = {},
): Promise<void> {
  if (room.prizesPaid || !room.prizes) return;
  room.prizesPaid = true;
  room.unpaidPrizes = await payEach(room, room.prizes);

  for (const delay of retryDelaysMs) {
    if (room.unpaidPrizes.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delay).unref?.());
    if (!isAlive()) break;
    room.unpaidPrizes = await payEach(room, room.unpaidPrizes);
  }
  for (const prize of room.unpaidPrizes) {
    console.error(`[draft] PRIZE NOT PAID (pay by hand): ${prizeLogLine(room, prize)}`);
  }
}

/** Pays each prize; returns the ones that failed. */
async function payEach(room: DraftRoom, prizes: readonly DraftPrize[]): Promise<DraftPrize[]> {
  const failed: DraftPrize[] = [];
  for (const prize of prizes) {
    try {
      await payDraftPrize(room, prize);
    } catch (err) {
      failed.push(prize);
      console.error(`[draft] Prize payout failed: ${prizeLogLine(room, prize)}`, err);
    }
  }
  return failed;
}

function prizeLogLine(room: Pick<DraftRoom, "id">, prize: DraftPrize): string {
  return JSON.stringify({
    userId: prize.playerId,
    roomId: room.id,
    position: prize.position,
    poolCoins: prize.coins,
    rewards: prize.rewards ?? null,
  });
}

/** One player's prize; false when there was nothing to pay or it was already paid. */
export async function payDraftPrize(
  room: Pick<DraftRoom, "id" | "createdAt"> & Partial<Pick<DraftRoom, "adminId" | "rewardsLogId">>,
  prize: DraftPrize,
): Promise<boolean> {
  const rewards: DraftRewardGrant = prize.rewards ?? { coins: 0, packs: [], items: [] };
  if (prize.withdrawn || (prize.coins <= 0 && isEmptyGrant(rewards))) return false;
  const userId = prize.playerId;
  const place = `${prize.position}.º puesto`;

  return prisma.$transaction(async (tx) => {
    await lockUsers(tx, [userId]);
    if (!(await claimOnce(tx, userId, "draft_prize", draftPrizeClaimKey(room)))) return false;

    if (prize.coins > 0) {
      await usersService.addCoins(userId, prize.coins, "draft_prize", `Premio de draft: ${prize.position}° puesto`, tx);
    }
    if (rewards.coins > 0) {
      await usersService.addCoins(userId, rewards.coins, "draft_reward", `Premio de draft ${room.id}: ${place} (premios del torneo)`, tx);
    }
    for (const pack of rewards.packs) {
      const packId = boosterIdForSet(pack.setId);
      if (!packId) throw new Error(`draft prize: no booster for set ${pack.setId}`);
      await grantPacks(tx, userId, pack.quantity, "draft_prize", packId);
    }
    for (const item of rewards.items) await grantCosmeticItem(tx, userId, item);

    await tx.systemMessage.create({
      data: {
        type: "personal",
        title: "Premio de draft",
        content: prizeMessage(place, prize.coins + rewards.coins, rewards),
        category: "reward",
        // Automatic message (like the welcome one): sent by the recipient, not by an admin
        senderId: userId,
        recipientId: userId,
        metadata: {
          draftRoomId: room.id,
          position: prize.position,
          coins: prize.coins + rewards.coins,
          // The admin who set the prizes and their log row (logDraftRewards)
          ...(isEmptyGrant(rewards) ? {} : { grantedBy: room.adminId ?? null, rewardsLogId: room.rewardsLogId ?? null }),
        },
      },
    });
    return true;
  });
}

/** A cosmetic the player may already own ("all" tiers): owning it again changes nothing. */
async function grantCosmeticItem(tx: Db, userId: string, item: DraftRewardItem): Promise<void> {
  switch (item.type) {
    case "coin":
      await tx.userCoin.createMany({ data: [{ userId, coinId: item.id }], skipDuplicates: true });
      break;
    case "cardBack":
      await tx.userCardBack.createMany({ data: [{ userId, cardBackId: item.id }], skipDuplicates: true });
      break;
    case "avatar":
      await tx.userAvatar.createMany({ data: [{ userId, avatarId: item.id }], skipDuplicates: true });
      break;
    case "skin":
      await tx.userCardSkin.createMany({ data: [{ userId, skinId: item.id }], skipDuplicates: true });
      break;
    case "playmat":
      await tx.userPlaymat.createMany({ data: [{ userId, playmatId: item.id }], skipDuplicates: true });
      break;
    case "emote":
      await grantEmote(tx, userId, item.id);
      break;
    case "trophy":
      await tx.userMedal.createMany({ data: [{ userId, medalId: item.id }], skipDuplicates: true });
      break;
  }
}

const ITEM_NAMES: Record<DraftRewardItem["type"], Map<string, string>> = {
  coin: new Map(AVAILABLE_COINS.map((c) => [c.itemId, c.name])),
  cardBack: new Map([
    ...AVAILABLE_CARD_BACKS.map((c) => [c.itemId, c.name] as const),
    ...CARD_SETS.map((set) => [`set-${set.id}`, set.name] as const),
  ]),
  avatar: new Map(AVAILABLE_AVATARS.map((a) => [a.itemId, a.name])),
  skin: new Map(ALL_VARIANTS.map((v) => [v.itemId, v.name])),
  playmat: new Map([...AVAILABLE_PLAYMATS, ...ADMIN_ONLY_PLAYMATS].map((p) => [p.itemId, p.name])),
  emote: new Map(BATTLE_EMOTES.map((e) => [e.id, e.name])),
  trophy: new Map(TROPHIES.map((t) => [t.itemId, t.name])),
};

function itemName(item: DraftRewardItem): string {
  const name = ITEM_NAMES[item.type].get(item.id) ?? item.id.charAt(0).toUpperCase() + item.id.slice(1);
  return `${COSMETIC_TYPE_LABELS[item.type]} ${name}`;
}

function prizeMessage(place: string, coins: number, rewards: DraftRewardGrant): string {
  const lines = [`Terminaste en el **${place}** de un draft. Tu premio ya está en tu cuenta:`, ""];
  if (coins > 0) lines.push(`- ${coins.toLocaleString("es-AR")} monedas`);
  for (const pack of rewards.packs) {
    const setName = CARD_SETS.find((set) => set.id === pack.setId)?.name ?? pack.setId;
    lines.push(`- ${pack.quantity} ${pack.quantity === 1 ? "sobre" : "sobres"} de ${setName} (en Mis sobres)`);
  }
  for (const item of rewards.items) lines.push(`- ${itemName(item)}`);
  return lines.join("\n");
}
