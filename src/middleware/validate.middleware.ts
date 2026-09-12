import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { AppError } from "../utils/app-error";

/**
 * Generic request-body validator. Kept as its own middleware (rather than
 * folded into auth.middleware.ts) since it's schema-agnostic and will be
 * reused by future non-auth routes (events, venues, ...).
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const message = result.error.issues[0]?.message ?? "Invalid request body";
      next(new AppError(400, "VALIDATION_ERROR", message));
      return;
    }

    req.body = result.data;
    next();
  };
}
