import { Router } from "express";
import rateLimit from "express-rate-limit";
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
import { env } from "../config/env";

const router = Router();

// Credential-guessing endpoints get a tighter limit than the rest of the API.
// Disabled under NODE_ENV=test so the automated suite (many requests from
// the same address) isn't throttled; it stays fully active in dev/production.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test",
  message: {
    success: false,
    error: { code: "TOO_MANY_REQUESTS", message: "Too many attempts, please try again later" },
  },
});

router.post("/register", authLimiter, validateBody(registerSchema), registerHandler);
router.post("/login", authLimiter, validateBody(loginSchema), loginHandler);
router.post("/refresh", authLimiter, refreshHandler);
router.post("/logout", logoutHandler);
router.get("/me", requireAuth, meHandler);

export default router;
