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

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function setRefreshCookie(res: Response, token: string) {
  res.cookie("refreshToken", token, REFRESH_COOKIE_OPTIONS);
}

function clearRefreshCookie(res: Response) {
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/auth",
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
        throw Errors.Unauthorized("No se encontro refresh token");
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
      await authService.logoutUser(req.user!.userId);
      clearRefreshCookie(res);
      res.json({ message: "Sesion cerrada correctamente" });
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
          "Si existe una cuenta con ese correo, recibiras instrucciones para restablecer tu contrasena.",
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
      res.json({ message: "Contrasena restablecida correctamente" });
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

      await authService.changePassword(
        req.user!.userId,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      res.json({ message: "Contrasena cambiada correctamente" });
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
        throw Errors.ValidationError("Token de verificacion requerido");
      }

      await authService.verifyEmail(token);
      res.json({ message: "Correo electronico verificado correctamente" });
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
        throw Errors.ValidationError("Correo electronico requerido");
      }

      await authService.resendVerificationEmail(email);
      // Always return success to not leak user existence
      res.json({
        message:
          "Si existe una cuenta con ese correo, recibiras un enlace de verificacion.",
      });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// OAuth Routes
// ============================================================================

// GET /google
router.get(
  "/google",
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      const url = getGoogleAuthUrl();
      res.json({ url });
    } catch (err) {
      next(err);
    }
  },
);

// GET /google/callback
router.get(
  "/google/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.query.code as string;
      if (!code) {
        return res.redirect(`${FRONTEND_URL}/login?error=oauth-failed`);
      }

      const result = await oauthService.handleGoogleCallback(code);
      setRefreshCookie(res, result.refreshToken);

      const params = new URLSearchParams({
        token: result.accessToken,
        isNewUser: String(result.isNewUser),
      });
      res.redirect(`${FRONTEND_URL}/auth/callback#${params}`);
    } catch (err) {
      next(err);
    }
  },
);

// GET /discord
router.get(
  "/discord",
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      const url = getDiscordAuthUrl();
      res.json({ url });
    } catch (err) {
      next(err);
    }
  },
);

// GET /discord/callback
router.get(
  "/discord/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.query.code as string;
      if (!code) {
        return res.redirect(`${FRONTEND_URL}/login?error=oauth-failed`);
      }

      const result = await oauthService.handleDiscordCallback(code);
      setRefreshCookie(res, result.refreshToken);

      const params = new URLSearchParams({
        token: result.accessToken,
        isNewUser: String(result.isNewUser),
      });
      res.redirect(`${FRONTEND_URL}/auth/callback#${params}`);
    } catch (err) {
      next(err);
    }
  },
);

export const authRouter = router;
