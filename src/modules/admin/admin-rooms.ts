/**
 * Backoffice "Mesas activas" (GET /admin/rooms). Seats are named from the users table: adventure
 * and gym rooms are created without the challenger's username, and their player 2 is the
 * server's AI (no user), shown by the rival's name.
 */
import { prisma } from "../../lib/prisma.js";
import type { GameRoom } from "../../socket/rooms.js";

export type AdminRoomKind = "ranked" | "friendly" | "lucky-duel" | "draft" | "adventure" | "gym";

export interface AdminRoomSeat {
  id: string | null;
  username: string | null;
  /** The server's AI (adventure rival, Gym Leader) */
  ai?: true;
}

export interface AdminRoomRow {
  id: string;
  status: GameRoom["status"];
  kind: AdminRoomKind;
  player1: AdminRoomSeat | null;
  player2: AdminRoomSeat | null;
  betAmount: number;
  friendly: boolean;
  createdAt: Date;
}

function roomKind(room: GameRoom): AdminRoomKind {
  if (room.adventure) return "adventure";
  if (room.gym) return "gym";
  if (room.isDraft) return "draft";
  if (room.config.mode === "lucky-duel") return "lucky-duel";
  return room.config.friendly ? "friendly" : "ranked";
}

export async function listAdminRooms(rooms: Iterable<GameRoom>): Promise<AdminRoomRow[]> {
  const list = [...rooms];
  const ids = [...new Set(list.flatMap((room) => [room.player1Id, room.player2Id]).filter((id): id is string => !!id))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } }) : [];
  const usernames = new Map(users.map((u) => [u.id, u.username]));
  const seat = (id: string | null, shown: string | null): AdminRoomSeat | null => (id ? { id, username: usernames.get(id) ?? shown } : null);

  return list.map((room) => {
    const aiSeat = !!room.adventure || !!room.gym;
    return {
      id: room.id,
      status: room.status,
      kind: roomKind(room),
      player1: seat(room.player1Id, room.creator.username),
      player2: aiSeat ? { id: null, username: room.joiner.username, ai: true } : seat(room.player2Id, room.joiner.username),
      betAmount: room.config.betAmount,
      friendly: room.config.friendly,
      createdAt: room.createdAt,
    };
  });
}
