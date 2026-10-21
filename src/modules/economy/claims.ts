import type { Db } from "../users/users.service.js";

/**
 * One-time claims (EconomyClaim): `INSERT ... ON CONFLICT DO NOTHING` on (userId, kind, key).
 * Returns true only for the call that inserted the row. A concurrent claim of the same key blocks
 * until the first transaction ends and then inserts nothing, so whatever the caller grants after
 * a `true` happens exactly once (if the caller's transaction rolls back, the claim does too).
 */
export async function claimOnce(tx: Db, userId: string, kind: ClaimKind, key: string): Promise<boolean> {
  const { count } = await tx.economyClaim.createMany({
    data: [{ userId, kind, key }],
    skipDuplicates: true,
  });
  return count === 1;
}

export async function hasClaim(db: Db, userId: string, kind: ClaimKind, key: string): Promise<boolean> {
  const row = await db.economyClaim.findUnique({
    where: { userId_kind_key: { userId, kind, key } },
    select: { id: true },
  });
  return row !== null;
}

export type ClaimKind =
  /** key: economy day */
  | "check_in"
  /** key: economy day */
  | "daily_pack"
  /** key: "v2" */
  | "welcome"
  /** key: "<setId>:<percent>" or "all:100" */
  | "set_milestone"
  /** key: "<economy week>:<n>" (n = 1..maxCoinConversionsPerWeek) */
  | "candy_coins"
  /** key: "v1" (tutorial reward, modules/progress) */
  | "tutorial"
  /** key: "<draft room id>:<room createdAt ms>" (a finished draft's prizes, socket/draft-payout.ts) */
  | "draft_prize"
  /** key: "<adventureId>:<difficulty>" (an adventure's unique reward, modules/adventure) */
  | "adventure";
