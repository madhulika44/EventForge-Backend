import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../utils/app-error";
import { logger } from "../config/logger";
import { env } from "../config/env";

interface ApiErrorBody {
  success: false;
  error: { code: string; message: string };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` },
  } satisfies ApiErrorBody);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    } satisfies ApiErrorBody);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: err.issues[0]?.message ?? "Invalid request" },
    } satisfies ApiErrorBody);
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    res.status(409).json({
      success: false,
      error: { code: "DUPLICATE_RESOURCE", message: "A resource with these details already exists" },
    } satisfies ApiErrorBody);
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
    res.status(409).json({
      success: false,
      error: { code: "REFERENCED_RESOURCE", message: "Cannot perform this action because other records depend on it" },
    } satisfies ApiErrorBody);
    return;
  }

  // A DB-level RESTRICT violation caught by Postgres itself (rather than
  // pre-checked by Prisma's own query engine) doesn't get mapped to a known
  // P-code — it surfaces as PrismaClientUnknownRequestError with the raw
  // Postgres error text and no structured `.code`. Detected here by message
  // content so it still gets the same clean 409 instead of leaking the raw
  // database error (found via a real FK-restrict test in Phase 4).
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError &&
    /foreign key constraint/i.test(err.message)
  ) {
    res.status(409).json({
      success: false,
      error: { code: "REFERENCED_RESOURCE", message: "Cannot perform this action because other records depend on it" },
    } satisfies ApiErrorBody);
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: env.NODE_ENV === "production" ? "Something went wrong" : (err as Error)?.message ?? "Unknown error",
    },
  } satisfies ApiErrorBody);
}
