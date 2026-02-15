import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { UserRole } from "@prisma/client";
import { verifyAccessToken, type TokenPayload } from "../lib/jwt.js";
import { Errors } from "./error-handler.js";
import { prisma } from "../lib/prisma.js";

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Require a valid access token. Attaches decoded payload to req.user.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw Errors.Unauthorized("Token de acceso requerido");
  }

  const token = header.slice(7);
  const payload = verifyAccessToken(token);
  if (!payload) {
    throw Errors.Unauthorized("Token invalido o expirado");
  }

  req.user = payload;
  next();
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
      throw Errors.Forbidden("No tienes permisos para esta accion");
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
        throw Errors.Forbidden("No tienes permisos para esta accion");
      }

      // Check user's permissions from DB (allows real-time revocation)
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { permissions: true },
      });

      const userPerms = (user?.permissions as string[]) || [];
      const hasAll = permissions.every((p) => userPerms.includes(p));
      if (!hasAll) {
        throw Errors.Forbidden("No tienes permisos para esta accion");
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Optional auth — attach user if token present, but don't fail otherwise.
 */
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    const payload = verifyAccessToken(token);
    if (payload) {
      req.user = payload;
    }
  }
  next();
}
