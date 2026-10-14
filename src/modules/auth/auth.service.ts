import crypto from "crypto";
import { prisma } from "../../lib/prisma.js";
import {
  hashPassword,
  comparePassword,
  validatePasswordStrength,
} from "../../lib/password.js";
import {
  generateAccessToken,
  verifyRefreshToken,
  type TokenPayload,
} from "../../lib/jwt.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../lib/email.js";
import { invalidateAccountState } from "../../lib/account-state.js";
import { disconnectUserSockets } from "../../socket/io-registry.js";
import { Errors } from "../../middleware/error-handler.js";
import type { RegisterRequest } from "./auth.types.js";
import { grantWelcomePackage, welcomeGiftLine } from "../economy/economy.service.js";
import { setStarterDeck } from "../users/users.service.js";
import { endAllRefreshSessions, endRefreshSession, startRefreshSession, useRefreshSession } from "./refresh-sessions.js";


const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || "";
const MAX_FAILED_ATTEMPTS = parseInt(
  process.env.MAX_FAILED_LOGIN_ATTEMPTS || "5",
  10,
);
const LOCK_DURATION_MS =
  parseInt(process.env.ACCOUNT_LOCK_DURATION_MINUTES || "15", 10) * 60 * 1000;

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

// Fields to return as the public profile on login/register
const profileSelect = {
  id: true,
  email: true,
  username: true,
  role: true,
  provider: true,
  avatarUrl: true,
  avatarPresetId: true,
  coins: true,
  coupons: true,
  rareCandy: true,
  exchangeTokens: true,
  loginDays: true,
  level: true,
  experience: true,
  stats: {
    select: {
      normalWins: true,
      normalLosses: true,
      rankedWins: true,
      rankedLosses: true,
      draftWins: true,
      draftLosses: true,
      currentStreak: true,
      bestStreak: true,
    },
  },
  lastDailyCoinsAt: true,
  lastWheelSpinAt: true,
  lastSlotSpinAt: true,
  permissions: true,
  medals: {
    select: {
      medalId: true,
      unlockedAt: true,
    },
  },
  achievements: {
    select: {
      achievementId: true,
      progress: true,
      unlockedAt: true,
    },
  },
  activeCoinId: true,
  activeCardBackId: true,
  maxDeckSlots: true,
  starterColor: true,
  emailVerified: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

export async function registerUser(data: RegisterRequest) {
  // Validate password strength
  const strength = validatePasswordStrength(data.password);
  if (!strength.valid) {
    throw Errors.ValidationError(strength.errors.join(". "));
  }

  // Check uniqueness
  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email: data.email }, { username: data.username }],
    },
  });

  if (existing) {
    if (existing.email === data.email) {
      throw Errors.Conflict("Ya existe una cuenta con este correo electrónico");
    }
    throw Errors.Conflict("El nombre de usuario ya está en uso");
  }

  const passwordHash = await hashPassword(data.password);
  const role =
    SUPERADMIN_EMAIL && data.email.toLowerCase() === SUPERADMIN_EMAIL.toLowerCase()
      ? "superadmin"
      : "user";

  // The account and its welcome package (economy v2) are created together
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: data.email.toLowerCase(),
        username: data.username,
        passwordHash,
        role,
        provider: "local",
        termsAcceptedAt: new Date(),
        stats: { create: {} },
      },
    });
    await grantWelcomePackage(tx, user.id);
    return user;
  });

  // Starter color sent at signup: same flow as POST /users/me/starter (cards + active deck),
  // so the account never ends up with a color but no starter cards
  if (data.starterColor) {
    // A failure here leaves the account without a starter; POST /users/me/starter can still pick it
    await setStarterDeck(created.id, data.starterColor).catch((err) => console.error("[register] starter deck failed:", err));
  }

  // Send verification email (a delivery failure is logged; the user can ask for it again)
  await generateVerificationToken(created.id).catch((err) =>
    console.error(`[auth] verification email for ${created.id} not sent:`, err),
  );

  // Send welcome system message (non-blocking)
  try {
    await prisma.systemMessage.create({
      data: {
        type: "personal",
        title: "Bienvenido a Nostalgic TCG!",
        category: "info",
        senderId: created.id,
        recipientId: created.id,
        content: [
          "**Bienvenido, Entrenador!**",
          "",
          "Nos alegra que te unas a **Nostalgic TCG**, la plataforma donde revives la era dorada del Juego de Cartas Coleccionables de Pokémon.",
          "",
          "La plataforma se encuentra actualmente en fase **Alpha**, lo que significa que todavía estamos trabajando en muchas funcionalidades y puede que encuentres errores. ¡Tu feedback es muy valioso para nosotros!",
          "",
          "Para que puedas empezar tu aventura, te hemos otorgado:",
          "",
          welcomeGiftLine(),
          "",
          "Buena suerte en tus batallas!",
        ].join("\n"),
      },
    });
  } catch {
    // Welcome message failure should not block registration
  }

  const payload = toTokenPayload(created);
  const accessToken = generateAccessToken(payload);
  const refreshToken = await startRefreshSession(payload);

  const user = await prisma.user.update({
    where: { id: created.id },
    data: { lastLoginAt: new Date() },
    select: profileSelect,
  });

  return { user, accessToken, refreshToken };
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    throw Errors.Unauthorized("Credenciales incorrectas");
  }

  // Check account lock
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil(
      (user.lockedUntil.getTime() - Date.now()) / 60000,
    );
    throw Errors.Forbidden(
      `Cuenta bloqueada. Intenta de nuevo en ${minutesLeft} minutos`,
    );
  }

  // OAuth-only accounts don't have passwords
  if (!user.passwordHash) {
    throw Errors.Unauthorized(
      `Esta cuenta usa ${user.provider}. Inicia sesión con ${user.provider}.`,
    );
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    // Increment failed attempts
    const newAttempts = user.failedLoginAttempts + 1;
    const lockData =
      newAttempts >= MAX_FAILED_ATTEMPTS
        ? { lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) }
        : {};

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: newAttempts, ...lockData },
    });

    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      throw Errors.Forbidden(
        "Demasiados intentos fallidos. Cuenta bloqueada temporalmente.",
      );
    }

    throw Errors.Unauthorized("Credenciales incorrectas");
  }

  // Check email verification
  if (!user.emailVerified) {
    throw Errors.Forbidden(
      "Debes verificar tu correo electrónico antes de iniciar sesión",
    );
  }

  // Check account status
  if (user.status === "banned") {
    throw Errors.Forbidden("Tu cuenta ha sido deshabilitada. Contacta soporte.");
  }
  if (user.status === "suspended" && user.suspendedUntil && user.suspendedUntil > new Date()) {
    throw Errors.Forbidden(
      `Tu cuenta está suspendida hasta ${user.suspendedUntil.toISOString()}`,
    );
  }

  // Success — reset failed attempts
  const payload = toTokenPayload(user);
  const accessToken = generateAccessToken(payload);
  const refreshToken = await startRefreshSession(payload);

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
    select: profileSelect,
  });

  return { user: updatedUser, accessToken, refreshToken };
}

export async function refreshAccessToken(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) {
    throw Errors.Unauthorized("Refresh token inválido o expirado");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
  });

  if (!user) {
    throw Errors.Unauthorized("Usuario no encontrado");
  }

  // Check token version — if changed, all tokens are invalidated
  if (user.tokenVersion !== payload.tokenVersion) {
    throw Errors.Unauthorized("Sesión invalidada. Inicia sesión de nuevo.");
  }

  // Check account status
  if (user.status === "banned") {
    throw Errors.Unauthorized("Cuenta deshabilitada");
  }
  if (user.status === "suspended" && user.suspendedUntil && user.suspendedUntil > new Date()) {
    throw Errors.Unauthorized("Cuenta suspendida");
  }

  // A live session of this device (logout or a revocation deletes it)
  if (!(await useRefreshSession(user.id, refreshToken))) {
    throw Errors.Unauthorized("Refresh token no válido");
  }

  const newPayload = toTokenPayload(user);
  const accessToken = generateAccessToken(newPayload);

  return { accessToken };
}

/** Ends this device's session only (other devices stay logged in). */
export async function logoutUser(refreshToken: string | undefined) {
  if (refreshToken) await endRefreshSession(refreshToken);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) {
    throw Errors.BadRequest(
      "No se puede cambiar la contraseña de una cuenta OAuth",
    );
  }

  const valid = await comparePassword(currentPassword, user.passwordHash);
  if (!valid) {
    throw Errors.Unauthorized("Contraseña actual incorrecta");
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw Errors.ValidationError(strength.errors.join(". "));
  }

  // A new password revokes every session (tokenVersion + stored refresh token); the session
  // that changed it gets fresh tokens so it stays logged in
  const passwordHash = await hashPassword(newPassword);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  const payload = toTokenPayload(updated);
  const accessToken = generateAccessToken(payload);
  await endAllRefreshSessions(userId);
  const refreshToken = await startRefreshSession(payload);
  invalidateAccountState(userId);
  return { accessToken, refreshToken };
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  // Always return success (don't leak user existence)
  if (!user) return;

  // OAuth-only users can't reset passwords
  if (!user.passwordHash && user.provider !== "local") return;

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken, resetTokenExpiry },
  });

  await sendPasswordResetEmail(user.email, user.username, resetToken).catch((err) =>
    console.error(`[auth] password reset email for ${user.id} not sent:`, err),
  );
}

export async function resetPassword(token: string, newPassword: string) {
  const user = await prisma.user.findUnique({
    where: { resetToken: token },
  });

  if (!user) {
    throw Errors.BadRequest("Token de restablecimiento inválido");
  }

  if (!user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
    throw Errors.BadRequest("Token de restablecimiento expirado");
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw Errors.ValidationError(strength.errors.join(". "));
  }

  const passwordHash = await hashPassword(newPassword);
  // One-time token (conditional on it still being there) and every session revoked: a stolen
  // refresh cookie or access token stops working once the password is reset
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, resetToken: token },
    data: {
      passwordHash,
      resetToken: null,
      resetTokenExpiry: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });
  if (count === 0) throw Errors.BadRequest("Token de restablecimiento inválido");
  await endAllRefreshSessions(user.id);
  invalidateAccountState(user.id);
  disconnectUserSockets(user.id, "Tu contraseña cambió. Inicia sesión de nuevo.");
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function generateVerificationToken(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, username: true },
  });
  if (!user) throw Errors.NotFound("Usuario");

  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await prisma.user.update({
    where: { id: userId },
    data: { verificationToken, verificationTokenExpiry },
  });

  await sendVerificationEmail(user.email, user.username, verificationToken);
}

/** How long a used verification link still answers "already verified". */
const VERIFIED_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Verify the email of the token's account. Idempotent: the used token is kept (with a new
 * expiry of VERIFIED_TOKEN_GRACE_MS) so opening the link again (mail scanners, a second click)
 * answers { alreadyVerified: true } instead of "invalid token".
 */
export async function verifyEmail(token: string): Promise<{ alreadyVerified: boolean }> {
  const user = await prisma.user.findUnique({
    where: { verificationToken: token },
  });

  if (!user) {
    throw Errors.BadRequest("Token de verificación inválido");
  }

  const now = new Date();
  if (user.emailVerified) {
    if (user.verificationTokenExpiry && user.verificationTokenExpiry >= now) return { alreadyVerified: true };
    throw Errors.BadRequest("Token de verificación inválido");
  }

  if (!user.verificationTokenExpiry || user.verificationTokenExpiry < now) {
    throw Errors.BadRequest("Token de verificación expirado");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      verificationTokenExpiry: new Date(now.getTime() + VERIFIED_TOKEN_GRACE_MS),
    },
  });
  return { alreadyVerified: false };
}

export async function resendVerificationEmail(email: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  // Don't leak user existence
  if (!user) return;

  // Already verified
  if (user.emailVerified) return;

  // OAuth users don't need verification
  if (user.provider !== "local") return;

  await generateVerificationToken(user.id).catch((err) =>
    console.error(`[auth] verification email for ${user.id} not sent:`, err),
  );
}
