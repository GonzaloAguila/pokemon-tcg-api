import rateLimit from "express-rate-limit";

/**
 * Strict rate limiter for login attempts.
 * 5 attempts per 15 minutes per IP.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiados intentos de inicio de sesion. Intenta en 15 minutos.",
      code: "RATE_LIMITED",
    },
  },
});

/**
 * Rate limiter for registration.
 * 10 attempts per hour per IP.
 */
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiados intentos de registro. Intenta mas tarde.",
      code: "RATE_LIMITED",
    },
  },
});

/**
 * Rate limiter for password reset requests.
 * 3 attempts per hour per IP.
 */
export const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiadas solicitudes de recuperacion. Intenta mas tarde.",
      code: "RATE_LIMITED",
    },
  },
});
