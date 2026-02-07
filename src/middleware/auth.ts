import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { UserRole } from "@prisma/client";
import { verifyAccessToken, type TokenPayload } from "../lib/jwt.js";
import { Errors } from "./error-handler.js";

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
