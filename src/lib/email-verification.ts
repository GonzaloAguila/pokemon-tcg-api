import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The one rule for "may this account take part in the economy": OAuth accounts count as verified
 * (the provider verified the email); local accounts need `emailVerified`. Used by the
 * `requireVerifiedEmail` middleware (403 EMAIL_NOT_VERIFIED on economy routes) and by the grants
 * that don't go through a guarded route (check-in, match settlement), which simply grant nothing
 * to an unverified account. See docs/economy-v2.md, "Unverified accounts".
 */
export function isEconomyVerified(user: { provider: string; emailVerified: boolean }): boolean {
  return user.provider !== "local" || user.emailVerified;
}

/** isEconomyVerified for a user id; null when the user doesn't exist. */
export async function hasVerifiedEmail(userId: string, db: Db = prisma): Promise<boolean | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { emailVerified: true, provider: true } });
  return user ? isEconomyVerified(user) : null;
}
