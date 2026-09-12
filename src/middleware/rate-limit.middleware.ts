import rateLimit from "express-rate-limit";
import { env } from "../config/env";

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  message: string;
}

/**
 * In-memory (per-process) rate limiting — not Redis-backed. This project's
 * API server has deliberately never depended on Redis (only the separate
 * worker process does, for BullMQ); adding a Redis dependency here purely
 * for rate limiting would be a real new architectural coupling for a
 * single-instance deployment target, not a "hardening" fix. The tradeoff
 * this accepts: limits are per-process, so they reset on restart and don't
 * share state across horizontally-scaled instances. If this API is ever
 * run as more than one instance, upgrading to a shared Redis store (e.g.
 * `rate-limit-redis`) behind this same factory is a contained change.
 *
 * Disabled entirely under NODE_ENV=test so the automated suite (many
 * requests from the same address) isn't throttled; fully active otherwise.
 */
export function createRateLimiter({ windowMs, limit, message }: RateLimiterOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    message: {
      success: false,
      error: { code: "TOO_MANY_REQUESTS", message },
    },
  });
}
