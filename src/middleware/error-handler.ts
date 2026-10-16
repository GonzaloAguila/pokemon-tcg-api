import type { Request, Response, NextFunction } from "express";

/**
 * Custom application error with HTTP status code
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Error code of an economy action from an account without a verified email. */
export const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";

/**
 * Common error types
 */
export const Errors = {
  NotFound: (resource: string) =>
    new AppError(`${resource} not found`, 404, "NOT_FOUND"),

  Unauthorized: (message = "Unauthorized") =>
    new AppError(message, 401, "UNAUTHORIZED"),

  Forbidden: (message = "Forbidden") =>
    new AppError(message, 403, "FORBIDDEN"),

  BadRequest: (message: string) =>
    new AppError(message, 400, "BAD_REQUEST"),

  Conflict: (message: string) =>
    new AppError(message, 409, "CONFLICT"),

  ValidationError: (message: string) =>
    new AppError(message, 422, "VALIDATION_ERROR"),

  RateLimited: () =>
    new AppError("Too many requests", 429, "RATE_LIMITED"),

  /** Economy action from an account whose email isn't verified (requireVerifiedEmail). */
  EmailNotVerified: () =>
    new AppError("Verificá tu email para continuar", 403, EMAIL_NOT_VERIFIED),
};

/** An error that carries a 4xx status of its own (body-parser's, from express.json). */
function isClientError(err: Error): err is Error & { status: number } {
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Express error handler middleware
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Expected rejections (4xx) are warnings; console.error is what Sentry reports
  if (err instanceof AppError && err.statusCode < 500) console.warn("Error:", err.message);
  else if (isClientError(err)) console.warn("Error:", err.message);
  else console.error("Error:", err);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code,
      },
      // EMAIL_NOT_VERIFIED is also readable at the top level ({ code, message }) for clients
      // that check the body directly
      ...(err.code === EMAIL_NOT_VERIFIED ? { code: err.code, message: err.message } : {}),
    });
    return;
  }

  // Rejected by express.json (malformed JSON, body too large): the client's fault, not a 500
  if (isClientError(err)) {
    res.status(err.status).json({ error: { message: "Invalid request", code: "BAD_REQUEST" } });
    return;
  }

  // Prisma errors
  if (err.name === "PrismaClientKnownRequestError") {
    const prismaError = err as { code?: string };
    if (prismaError.code === "P2002") {
      res.status(409).json({
        error: {
          message: "A record with this value already exists",
          code: "DUPLICATE_ENTRY",
        },
      });
      return;
    }
    // Foreign key violation: something still references the row (e.g. deleting a user)
    if (prismaError.code === "P2003") {
      res.status(409).json({
        error: {
          message: "No se puede completar: hay otros registros que dependen de este",
          code: "CONFLICT",
        },
      });
      return;
    }
    if (prismaError.code === "P2025") {
      res.status(404).json({
        error: {
          message: "Record not found",
          code: "NOT_FOUND",
        },
      });
      return;
    }
  }

  // Default to 500 internal server error
  res.status(500).json({
    error: {
      message: "Internal server error",
      code: "INTERNAL_ERROR",
    },
  });
}
