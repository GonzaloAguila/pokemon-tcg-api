import crypto from "crypto";
import { prisma } from "../../lib/prisma.js";
import {
  hashPassword,
  comparePassword,
  validatePasswordStrength,
} from "../../lib/password.js";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  type TokenPayload,
} from "../../lib/jwt.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../lib/email.js";
import { Errors } from "../../middleware/error-handler.js";
import type { RegisterRequest } from "./auth.types.js";

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
  level: true,
  experience: true,
  normalWins: true,
  normalLosses: true,
  rankedWins: true,
  rankedLosses: true,
  draftWins: true,
  draftLosses: true,
  currentStreak: true,
  bestStreak: true,
  lastDailyCoinsAt: true,
  lastWheelSpinAt: true,
  lastSlotSpinAt: true,
  permissions: true,
  medalsData: true,
  achievementsData: true,
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
      throw Errors.Conflict("Ya existe una cuenta con este correo electronico");
    }
    throw Errors.Conflict("El nombre de usuario ya esta en uso");
  }

  const passwordHash = await hashPassword(data.password);
  const role =
    SUPERADMIN_EMAIL && data.email.toLowerCase() === SUPERADMIN_EMAIL.toLowerCase()
      ? "superadmin"
      : "user";

  const created = await prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      username: data.username,
      passwordHash,
      role,
      provider: "local",
      starterColor: data.starterColor ?? null,
      coins: 1000,
      coupons: 1,
    },
  });

  // Send verification email
  await generateVerificationToken(created.id);

  const payload = toTokenPayload(created);
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  const user = await prisma.user.update({
    where: { id: created.id },
    data: { refreshToken, lastLoginAt: new Date() },
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
      `Esta cuenta usa ${user.provider}. Inicia sesion con ${user.provider}.`,
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
      "Debes verificar tu correo electronico antes de iniciar sesion",
    );
  }

  // Success — reset failed attempts
  const payload = toTokenPayload(user);
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      refreshToken,
      lastLoginAt: new Date(),
    },
    select: profileSelect,
  });

  return { user: updatedUser, accessToken, refreshToken };
}

export async function refreshAccessToken(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) {
    throw Errors.Unauthorized("Refresh token invalido o expirado");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
  });

  if (!user) {
    throw Errors.Unauthorized("Usuario no encontrado");
  }

  // Check token version — if changed, all tokens are invalidated
  if (user.tokenVersion !== payload.tokenVersion) {
    throw Errors.Unauthorized("Sesion invalidada. Inicia sesion de nuevo.");
  }

  // Check stored refresh token matches
  if (user.refreshToken !== refreshToken) {
    throw Errors.Unauthorized("Refresh token no valido");
  }

  const newPayload = toTokenPayload(user);
  const accessToken = generateAccessToken(newPayload);

  return { accessToken };
}

export async function logoutUser(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: null },
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) {
    throw Errors.BadRequest(
      "No se puede cambiar la contrasena de una cuenta OAuth",
    );
  }

  const valid = await comparePassword(currentPassword, user.passwordHash);
  if (!valid) {
    throw Errors.Unauthorized("Contrasena actual incorrecta");
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw Errors.ValidationError(strength.errors.join(". "));
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
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

  await sendPasswordResetEmail(user.email, user.username, resetToken);
}

export async function resetPassword(token: string, newPassword: string) {
  const user = await prisma.user.findUnique({
    where: { resetToken: token },
  });

  if (!user) {
    throw Errors.BadRequest("Token de restablecimiento invalido");
  }

  if (!user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
    throw Errors.BadRequest("Token de restablecimiento expirado");
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw Errors.ValidationError(strength.errors.join(". "));
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      resetToken: null,
      resetTokenExpiry: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
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

export async function verifyEmail(token: string) {
  const user = await prisma.user.findUnique({
    where: { verificationToken: token },
  });

  if (!user) {
    throw Errors.BadRequest("Token de verificacion invalido");
  }

  if (
    !user.verificationTokenExpiry ||
    user.verificationTokenExpiry < new Date()
  ) {
    throw Errors.BadRequest("Token de verificacion expirado");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      verificationToken: null,
      verificationTokenExpiry: null,
    },
  });
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

  await generateVerificationToken(user.id);
}
