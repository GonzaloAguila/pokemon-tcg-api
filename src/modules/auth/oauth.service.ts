import crypto from "crypto";
import { prisma } from "../../lib/prisma.js";
import type { AuthProvider } from "@prisma/client";
import {
  getGoogleUserFromCode,
  getDiscordUserFromCode,
  type OAuthUser,
} from "../../lib/oauth.js";
import {
  generateAccessToken,
  generateRefreshToken,
  type TokenPayload,
} from "../../lib/jwt.js";

const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "";

function toTokenPayload(user: {
  id: string;
  email: string;
  role: "user" | "admin" | "superadmin";
  tokenVersion: number;
}): TokenPayload {
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  };
}

async function generateUniqueUsername(baseName: string): Promise<string> {
  let username = baseName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 16);
  if (username.length < 3) username = "user_" + username;

  const existing = await prisma.user.findUnique({ where: { username } });
  if (!existing) return username;

  // Append random suffix
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${username.slice(0, 15)}_${suffix}`;
}

async function handleOAuthCallback(
  oauthUser: OAuthUser,
  provider: AuthProvider,
) {
  const email = oauthUser.email.toLowerCase();

  // Check if user exists with this email
  let user = await prisma.user.findUnique({ where: { email } });

  let isNewUser = false;

  if (user) {
    // User exists — update OAuth fields if needed
    if (!user.providerId || user.provider === "local") {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          provider,
          providerId: oauthUser.id,
        },
      });
      user = (await prisma.user.findUnique({ where: { id: user.id } }))!;
    }
  } else {
    // Create new user
    const username = await generateUniqueUsername(oauthUser.name);
    const role =
      SUPERADMIN_EMAIL && email === SUPERADMIN_EMAIL.toLowerCase()
        ? "superadmin"
        : "user";

    user = await prisma.user.create({
      data: {
        email,
        username,
        provider,
        providerId: oauthUser.id,
        role,
      },
    });
    isNewUser = true;
  }

  // Generate tokens
  const payload = toTokenPayload(user);
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken, lastLoginAt: new Date() },
  });

  return { accessToken, refreshToken, isNewUser };
}

export async function handleGoogleCallback(code: string) {
  const oauthUser = await getGoogleUserFromCode(code);
  return handleOAuthCallback(oauthUser, "google");
}

export async function handleDiscordCallback(code: string) {
  const oauthUser = await getDiscordUserFromCode(code);
  return handleOAuthCallback(oauthUser, "discord");
}
