import { Router } from "express";
import {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerHandler,
} from "../controllers/auth.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { loginSchema, registerSchema } from "../schemas/auth.schema";
import { createRateLimiter } from "../middleware/rate-limit.middleware";
import { env } from "../config/env";

const router = Router();

// Credential-guessing endpoints get a tighter limit than the rest of the
// API. Window/max configurable via AUTH_RATE_LIMIT_WINDOW_MS/AUTH_RATE_LIMIT_MAX
// (default: 10 attempts per 15 minutes per IP) — tight enough to slow down
// brute-force/credential-stuffing attempts, loose enough that a legitimate
// user mistyping their password a few times is never blocked.
const authLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  message: "Too many attempts, please try again later",
});

router.post("/register", authLimiter, validateBody(registerSchema), registerHandler);
router.post("/login", authLimiter, validateBody(loginSchema), loginHandler);
router.post("/refresh", authLimiter, refreshHandler);
router.post("/logout", logoutHandler);
router.get("/me", requireAuth, meHandler);

export default router;
