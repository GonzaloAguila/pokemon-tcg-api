/**
 * What unlocks an adventure (`requires` in its file). Today only a Gym Leader: the user owns the
 * leader's medal (normal version's first win) or won a series against it in either version (an
 * expert-only win leaves no medal, but its gym match rows show the challenger reaching 2 wins).
 */
import { getGymLeader } from "../gym/content/index.js";
import type { Db } from "../users/users.service.js";
import type { Adventure } from "./content/validate.js";

export type AdventureRequirement = NonNullable<Adventure["requires"]>;

/** Games a challenger must win to take a best-of-3 series. */
const SERIES_WINS = 2;

export async function requirementMet(db: Db, userId: string, req: AdventureRequirement): Promise<boolean> {
  const leader = getGymLeader(req.leaderId);
  if (!leader) return false;
  if (await db.userMedal.findFirst({ where: { userId, medalId: leader.medalId }, select: { id: true } })) return true;
  const won = await db.match.findFirst({
    where: {
      mode: "gym",
      player1Id: userId,
      AND: [
        { gym: { path: ["leaderId"], equals: leader.id } },
        { gym: { path: ["score", "challenger"], gte: SERIES_WINS } },
      ],
    },
    select: { id: true },
  });
  return won !== null;
}

export function requirementText(req: AdventureRequirement): string {
  const name = getGymLeader(req.leaderId)?.name ?? req.leaderId;
  return `Vence a ${name} en su gimnasio para desbloquearla`;
}
