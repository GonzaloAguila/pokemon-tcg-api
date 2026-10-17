/**
 * Watching is cheap to toggle and every start/stop changes counts other clients see: at most
 * SPECTATE_MAX_PER_WINDOW spectateRoom / draft:spectate per socket per SPECTATE_WINDOW_MS.
 */
export const SPECTATE_WINDOW_MS = 10_000;
export const SPECTATE_MAX_PER_WINDOW = 5;
export const SPECTATE_RATE_LIMITED = {
  code: "SPECTATE_RATE_LIMITED",
  message: "Espera unos segundos antes de volver a mirar",
} as const;

const attempts = new Map<string, number[]>();

/** Whether this socket may start watching now (and count the attempt). */
export function allowSpectate(socketId: string, now = Date.now()): boolean {
  const recent = (attempts.get(socketId) ?? []).filter((t) => now - t < SPECTATE_WINDOW_MS);
  if (recent.length >= SPECTATE_MAX_PER_WINDOW) {
    attempts.set(socketId, recent);
    return false;
  }
  recent.push(now);
  attempts.set(socketId, recent);
  return true;
}

/** The socket went away. */
export function forgetSpectateSocket(socketId: string): void {
  attempts.delete(socketId);
}
