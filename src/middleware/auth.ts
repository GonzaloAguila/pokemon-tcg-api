import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { UserRole } from "@prisma/client";
import { verifyAccessToken, type TokenPayload } from "../lib/jwt.js";
import { Errors } from "./error-handler.js";
import { prisma } from "../lib/prisma.js";
import { accountBlockReason, getAccountState, invalidateAccountState } from "../lib/account-state.js";
import { hasVerifiedEmail } from "../lib/email-verification.js";

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * Check a verified token against the account (cached a few seconds, see account-state.ts):
 * the user must exist, the token's tokenVersion must be current (bans, suspensions and other
 * forced logouts bump it) and the account must not be banned/suspended.
 * Returns the payload with the role read from the DB, so role changes apply immediately.
 */
async function freshSession(payload: TokenPayload): Promise<TokenPayload> {
  const state = await getAccountState(payload.userId);
  if (!state) throw Errors.Unauthorized("Usuario no encontrado");
  if (state.tokenVersion !== payload.tokenVersion) {
    throw Errors.Unauthorized("Sesión invalidada. Inicia sesión de nuevo.");
  }
  const blocked = accountBlockReason(state);
  if (blocked) throw Errors.Forbidden(blocked);
  return { ...payload, role: state.role };
}

/**
 * Require a valid, non-revoked access token. Attaches the payload to req.user.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = bearerToken(req);
  if (!token) return next(Errors.Unauthorized("Token de acceso requerido"));

  const payload = verifyAccessToken(token);
  if (!payload) return next(Errors.Unauthorized("Token inválido o expirado"));

  freshSession(payload).then(
    (user) => {
      req.user = user;
      next();
    },
    next,
  );
}

/**
 * Require a verified email for economy actions (purchases, claims, rewards, spins, market,
 * battle pass, achievement claims, economy v2: daily pack, opening inventory packs, Fichas de
 * canje, set milestones). Must be used after requireAuth. OAuth accounts count as verified (the
 * provider verified the email; lib/email-verification.ts). Login, profile reads, deck building,
 * playing and the daily check-in don't use it (check-in and match settlement grant nothing to an
 * unverified account instead). Rejects with 403 { code: "EMAIL_NOT_VERIFIED" }.
 */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(Errors.Unauthorized("Token de acceso requerido"));
  hasVerifiedEmail(req.user.userId).then((verified) => {
    if (verified === null) return next(Errors.Unauthorized("Usuario no encontrado"));
    if (!verified) return next(Errors.EmailNotVerified());
    next();
  }, next);
}

/**
 * Require one of the specified roles. Must be used after requireAuth.
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw Errors.Unauthorized("Token de acceso requerido");
    }
    if (!roles.includes(req.user.role)) {
      throw Errors.Forbidden("No tienes permisos para esta acción");
    }
    next();
  };
}

/**
 * Require specific admin permissions. Must be used after requireAuth.
 * SuperAdmin bypasses all permission checks.
 * Admins must have the required permissions stored on their user record.
 */
export function requirePermission(...permissions: string[]): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw Errors.Unauthorized("Token de acceso requerido");

      // SuperAdmin bypasses all permission checks
      if (req.user.role === "superadmin") return next();

      // Must be at least admin
      if (req.user.role !== "admin") {
        throw Errors.Forbidden("No tienes permisos para esta acción");
      }

      // Check user's permissions from DB (allows real-time revocation)
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { permissions: true },
      });

      const userPerms = (user?.permissions as string[]) || [];
      const hasAll = permissions.every((p) => userPerms.includes(p));
      if (!hasAll) {
        throw Errors.Forbidden("No tienes permisos para esta acción");
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Check user account status (banned / suspended).
 * Must be used after requireAuth. Queries DB on each request.
 */
export function checkUserStatus(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) return next();

      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { status: true, suspendedUntil: true },
      });

      if (!user) throw Errors.Unauthorized("Usuario no encontrado");

      if (user.status === "banned") {
        throw Errors.Forbidden("Tu cuenta ha sido deshabilitada. Contacta soporte.");
      }

      if (user.status === "suspended") {
        if (user.suspendedUntil && user.suspendedUntil > new Date()) {
          const until = user.suspendedUntil.toISOString();
          throw Errors.Forbidden(`Tu cuenta está suspendida hasta ${until}`);
        }
        // Suspension expired — auto-reactivate
        await prisma.user.update({
          where: { id: req.user.userId },
          data: { status: "active", suspendedUntil: null, suspendedReason: null },
        });
        invalidateAccountState(req.user.userId);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Optional auth — attach user if a valid, non-revoked token is present; otherwise continue
 * as anonymous.
 */
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = bearerToken(req);
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) return next();

  freshSession(payload).then(
    (user) => {
      req.user = user;
      next();
    },
    () => next(),
  );
}
