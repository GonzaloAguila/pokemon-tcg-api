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
};

/**
 * Express error handler middleware
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("Error:", err);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code,
      },
    });
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
