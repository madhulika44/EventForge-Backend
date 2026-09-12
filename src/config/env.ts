import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 characters"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 characters"),
  // Google OAuth is not wired up yet; kept optional until that increment lands.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),

  // Stripe (test mode). Both optional: when either is unset, the app falls
  // back to an in-process fake payment provider (see
  // src/providers/payment-provider.factory.ts) so the server, and the full
  // test suite, run correctly with zero real Stripe credentials.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Redis connection for the BullMQ booking-expiry worker (src/worker.ts).
  // Only that separate worker process actually needs Redis reachable — the
  // API server and the full test suite never connect to it.
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Comma-separated list of allowed browser origins in production. Outside
  // production, any origin is reflected for developer convenience (see
  // app.ts). Not defaulted to anything usable in production on purpose —
  // see the production check in loadEnv below.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Rate limiting (express-rate-limit, in-memory — see README for why this
  // isn't Redis-backed). Skipped entirely under NODE_ENV=test.
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  PAYMENT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  PAYMENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // Max JSON body size for express.json()/express.raw() (the Stripe webhook
  // route). Accepts the same size strings as the `bytes` package, e.g.
  // "100kb", "1mb".
  REQUEST_BODY_LIMIT: z.string().default("100kb"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }

  const data = parsed.data;

  if (data.NODE_ENV === "production") {
    // Warnings, not hard failures: a deliberately backend-only or
    // Stripe-less production deployment is a legitimate (if unusual)
    // choice. The point is that it must never be silent.
    if (!data.CORS_ALLOWED_ORIGINS?.trim()) {
      // eslint-disable-next-line no-console
      console.warn(
        "[env] production configuration warning: CORS_ALLOWED_ORIGINS is not set — no browser origin will be allowed (failing closed, not open).",
      );
    }
    if (Boolean(data.STRIPE_SECRET_KEY) !== Boolean(data.STRIPE_WEBHOOK_SECRET)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[env] production configuration warning: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set, or both left unset.",
      );
    }
    if (!data.STRIPE_SECRET_KEY) {
      // eslint-disable-next-line no-console
      console.warn(
        "[env] production configuration warning: STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are not set — payments will use the fake provider.",
      );
    }
  }

  return data;
}

export const env = loadEnv();
export type Env = typeof env;
