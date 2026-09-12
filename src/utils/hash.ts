import { createHash } from "crypto";

/**
 * Deterministic SHA-256 hash used to look up refresh tokens by value.
 * Not for passwords (see password.ts) — refresh tokens are already
 * high-entropy random JWTs, so a fast, comparable hash is sufficient
 * and lets us index/query by tokenHash instead of scanning + verifying.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
