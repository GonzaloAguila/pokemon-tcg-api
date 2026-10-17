export const ADMIN_PERMISSIONS = {
  USERS_VIEW: "users:view",
  USERS_EDIT_ECONOMY: "users:economy",
  USERS_EDIT_CARDS: "users:cards",
  USERS_EDIT_STATS: "users:stats",
  USERS_DELETE: "users:delete",
  USERS_MODERATE: "users:moderate",
  ROOMS_VIEW: "rooms:view",
  ROOMS_CLOSE: "rooms:close",
  MESSAGES_SEND: "messages:send",
  MESSAGES_VIEW: "messages:view",
  DASHBOARD_VIEW: "dashboard:view",
  // Write, publish, pin and delete news posts. A "moderator" is an admin with only this one.
  NEWS: "news",
} as const;

export type AdminPermission = typeof ADMIN_PERMISSIONS[keyof typeof ADMIN_PERMISSIONS];
export const ALL_PERMISSIONS: AdminPermission[] = Object.values(ADMIN_PERMISSIONS);

/** Draft rooms are managed (created, closed from the backoffice) by whoever can close game rooms. */
export function canManageDraftRooms(account: { role: string; permissions: unknown } | null): boolean {
  if (!account) return false;
  if (account.role === "superadmin") return true;
  return (
    account.role === "admin" &&
    Array.isArray(account.permissions) &&
    account.permissions.includes(ADMIN_PERMISSIONS.ROOMS_CLOSE)
  );
}

/** Draft prizes (coins, packs, cosmetics) are economy grants: superadmin or admins with users:economy. */
export function canGrantDraftRewards(account: { role: string; permissions: unknown } | null): boolean {
  if (!account) return false;
  if (account.role === "superadmin") return true;
  return (
    account.role === "admin" &&
    Array.isArray(account.permissions) &&
    account.permissions.includes(ADMIN_PERMISSIONS.USERS_EDIT_ECONOMY)
  );
}
