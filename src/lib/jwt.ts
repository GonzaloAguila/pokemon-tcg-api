import jwt, { type SignOptions } from "jsonwebtoken";
import type { UserRole } from "@prisma/client";

export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  tokenVersion: number;
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}
const ACCESS_TOKEN_EXPIRES_IN =
  process.env.JWT_ACCESS_TOKEN_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN =
  process.env.JWT_REFRESH_TOKEN_EXPIRES_IN || "7d";

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  } as SignOptions);
}

export function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET + "_refresh", {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  } as SignOptions);
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET + "_refresh") as TokenPayload;
  } catch {
    return null;
  }
}
