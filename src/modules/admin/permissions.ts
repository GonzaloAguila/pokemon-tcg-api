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
} as const;

export type AdminPermission = typeof ADMIN_PERMISSIONS[keyof typeof ADMIN_PERMISSIONS];
export const ALL_PERMISSIONS: AdminPermission[] = Object.values(ADMIN_PERMISSIONS);
