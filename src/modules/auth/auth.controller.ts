import crypto from "crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import * as authService from "./auth.service.js";
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.validation.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  loginRateLimiter,
  registerRateLimiter,
  passwordResetRateLimiter,
} from "../../middleware/rate-limit.js";
import { Errors } from "../../middleware/error-handler.js";
import * as oauthService from "./oauth.service.js";
import { getGoogleAuthUrl, getDiscordAuthUrl } from "../../lib/oauth.js";

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined; // e.g. ".nostalgic-tcg.online"

const REFRESH_COOKIE_OPTIONS: import("express").CookieOptions = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? ("none" as const) : ("lax" as const),
  path: "/api/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
};

function setRefreshCookie(res: Response, token: string) {
  res.cookie("refreshToken", token, REFRESH_COOKIE_OPTIONS);
}

function clearRefreshCookie(res: Response) {
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? ("none" as const) : ("lax" as const),
    path: "/api/auth",
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
}

// POST /register
router.post(
  "/register",
  registerRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const result = await authService.registerUser(parsed.data);
      setRefreshCookie(res, result.refreshToken);

      res.status(201).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /login
router.post(
  "/login",
  loginRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      const result = await authService.loginUser(
        parsed.data.email,
        parsed.data.password,
      );
      setRefreshCookie(res, result.refreshToken);

      res.json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /refresh
router.post(
  "/refresh",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refreshToken = req.cookies?.refreshToken;
      if (!refreshToken) {
        throw Errors.Unauthorized("No se encontró refresh token");
      }

      const result = await authService.refreshAccessToken(refreshToken);
      res.json({ accessToken: result.accessToken });
    } catch (err) {
      next(err);
    }
  },
);

// POST /logout
router.post(
  "/logout",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authService.logoutUser(req.cookies?.refreshToken);
      clearRefreshCookie(res);
      res.json({ message: "Sesión cerrada correctamente" });
    } catch (err) {
      next(err);
    }
  },
);

// POST /forgot-password
router.post(
  "/forgot-password",
  passwordResetRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      await authService.requestPasswordReset(parsed.data.email);
      // Always return success to not leak user existence
      res.json({
        message:
          "Si existe una cuenta con ese correo, recibirás instrucciones para restablecer tu contraseña.",
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /reset-password
router.post(
  "/reset-password",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      await authService.resetPassword(
        parsed.data.token,
        parsed.data.newPassword,
      );
      res.json({ message: "Contraseña restablecida correctamente" });
    } catch (err) {
      next(err);
    }
  },
);

// POST /change-password
router.post(
  "/change-password",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.ValidationError(
          parsed.error.errors.map((e) => e.message).join(". "),
        );
      }

      // Every other session is revoked; this one continues with the new tokens
      const tokens = await authService.changePassword(
        req.user!.userId,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      setRefreshCookie(res, tokens.refreshToken);
      res.json({ message: "Contraseña cambiada correctamente", accessToken: tokens.accessToken });
    } catch (err) {
      next(err);
    }
  },
);

// GET /verify-email
router.get(
  "/verify-email",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.query.token as string;
      if (!token) {
        throw Errors.ValidationError("Token de verificación requerido");
      }

      const { alreadyVerified } = await authService.verifyEmail(token);
      res.json({
        message: alreadyVerified
          ? "Tu correo electrónico ya estaba verificado"
          : "Correo electrónico verificado correctamente",
        alreadyVerified,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /resend-verification
router.post(
  "/resend-verification",
  passwordResetRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      if (!email) {
        throw Errors.ValidationError("Correo electrónico requerido");
      }

      await authService.resendVerificationEmail(email);
      // Always return success to not leak user existence
      res.json({
        message:
          "Si existe una cuenta con ese correo, recibirás un enlace de verificación.",
      });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// OAuth Routes
// ============================================================================

// OAuth CSRF protection: a random `state` is stored in a short-lived httpOnly cookie
// when the auth URL is requested, and must come back unchanged on the callback.
const OAUTH_STATE_COOKIE = "oauthState";
const OAUTH_STATE_COOKIE_OPTIONS: import("express").CookieOptions = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? ("none" as const) : ("lax" as const),
  path: "/api/auth",
  maxAge: 10 * 60 * 1000, // 10 minutes
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
};

function issueOAuthState(res: Response): string {
  const state = crypto.randomBytes(24).toString("base64url");
  res.cookie(OAUTH_STATE_COOKIE, state, OAUTH_STATE_COOKIE_OPTIONS);
  return state;
}

function consumeOAuthState(req: Request, res: Response): boolean {
  const expected = req.cookies?.[OAUTH_STATE_COOKIE];
  const received = req.query.state;
  res.clearCookie(OAUTH_STATE_COOKIE, { ...OAUTH_STATE_COOKIE_OPTIONS, maxAge: undefined });
  if (typeof expected !== "string" || typeof received !== "string" || expected.length !== received.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

type OAuthResult = { accessToken: string; refreshToken: string; isNewUser: boolean };

function oauthCallback(handle: (code: string) => Promise<OAuthResult>) {
  return async (req: Request, res: Response) => {
    const code = req.query.code;
    if (typeof code !== "string" || !consumeOAuthState(req, res)) {
      return res.redirect(`${FRONTEND_URL}/login?error=oauth-failed`);
    }
    try {
      const result = await handle(code);
      setRefreshCookie(res, result.refreshToken);
      const params = new URLSearchParams({
        token: result.accessToken,
        isNewUser: String(result.isNewUser),
      });
      res.redirect(`${FRONTEND_URL}/auth/callback#${params}`);
    } catch (err) {
      console.error("OAuth callback failed:", (err as Error).message);
      res.redirect(`${FRONTEND_URL}/login?error=oauth-failed`);
    }
  };
}

// GET /google
router.get(
  "/google",
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      const url = getGoogleAuthUrl(issueOAuthState(res));
      res.json({ url });
    } catch (err) {
      next(err);
    }
  },
);

// GET /google/callback
router.get("/google/callback", oauthCallback(oauthService.handleGoogleCallback));

// GET /discord
router.get(
  "/discord",
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      const url = getDiscordAuthUrl(issueOAuthState(res));
      res.json({ url });
    } catch (err) {
      next(err);
    }
  },
);

// GET /discord/callback
router.get("/discord/callback", oauthCallback(oauthService.handleDiscordCallback));

export const authRouter = router;
