import rateLimit from "express-rate-limit";

/**
 * Strict rate limiter for login attempts.
 * 5 attempts per 15 minutes per IP. LOGIN_RATE_LIMIT_MAX raises it for local testing with
 * several accounts; read per request because dotenv loads after the imports.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiados intentos de inicio de sesión. Intenta en 15 minutos.",
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
      message: "Demasiados intentos de registro. Intenta más tarde.",
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
      message: "Demasiadas solicitudes de recuperación. Intenta más tarde.",
      code: "RATE_LIMITED",
    },
  },
});

/**
 * Baseline limiter for the whole REST API (per client IP).
 * Requires `app.set("trust proxy", 1)` behind Nginx so req.ip is the real client.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Demasiadas solicitudes. Espera un momento.",
      code: "RATE_LIMITED",
    },
  },
});

/**
 * Stricter limiter for state-changing economy endpoints (purchases, claims, spins).
 * GETs are not counted.
 */
export const economyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET",
  message: {
    error: {
      message: "Demasiadas operaciones seguidas. Espera un momento.",
      code: "RATE_LIMITED",
    },
  },
});
