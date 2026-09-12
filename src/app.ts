import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { randomUUID } from "crypto";
import { logger } from "./config/logger";
import { env } from "./config/env";
import { prisma } from "./config/database";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { stripeWebhookHandler } from "./controllers/payment.controller";
import routes from "./routes";

const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Outside production, any origin is reflected (dev convenience — a local
 * frontend on any port just works). In production, only origins listed in
 * CORS_ALLOWED_ORIGINS (comma-separated) are allowed; an empty/unset list
 * means no browser origin is allowed at all — failing closed, not open.
 * Requests with no Origin header (curl, server-to-server, mobile apps)
 * always pass through: CORS is a browser-enforced mechanism and doesn't
 * apply to them regardless of this configuration.
 */
function corsOriginHandler(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
  if (!origin || env.NODE_ENV !== "production") {
    callback(null, true);
    return;
  }

  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  callback(allowedOrigins.includes(origin) ? null : new Error(`Origin ${origin} is not allowed by CORS`), true);
}

export function createApp(): Express {
  const app = express();

  app.use(
    helmet({
      // Explicit rather than relying on helmet's default: HSTS only makes
      // sense once this is actually served over HTTPS. Browsers ignore the
      // header over plain HTTP anyway, but stating this explicitly (off
      // outside production) documents the intent rather than depending on
      // that browser behavior.
      hsts: env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  // Helmet doesn't set Permissions-Policy by default. This is a pure JSON
  // API with no use for any browser feature (camera, geolocation, payment
  // UI, ...), so disable them all explicitly rather than leaving the
  // header unset.
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  });

  app.use(cors({ origin: corsOriginHandler, credentials: true }));

  // pino-http ahead of body parsing (the Stripe webhook route below must
  // run before the global JSON parser) so every route — the webhook
  // included — gets request logging and a request id. genReqId always
  // generates a fresh, server-controlled id rather than trusting a
  // client-supplied header: a client-supplied id could otherwise collide
  // with, or be used to spoof, another request's correlation id in logs.
  // pino-http attaches the id to req.id and a child logger to req.log
  // (used by error.middleware.ts) with no global mutable state involved —
  // both are scoped to this one request object.
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
    }),
  );

  // Stripe webhook signature verification needs the raw, unparsed request
  // body, so this route is registered — with its own raw-body parser —
  // before the global express.json() below consumes the stream for every
  // other route. It sends its own response and never calls next(), so it
  // never reaches express.json() regardless of order.
  app.post(
    "/api/payments/webhook/stripe",
    express.raw({ type: "application/json", limit: env.REQUEST_BODY_LIMIT }),
    stripeWebhookHandler,
  );

  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));
  app.use(cookieParser());

  // Liveness: the process is up and can respond. No dependency checks, no
  // auth — this must stay cheap and always answer if the event loop is
  // running at all.
  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });

  // Readiness: can this instance actually serve traffic right now? Checks
  // Postgres (the only dependency the API server itself owns — Redis is
  // only used by the separate worker process). Deliberately minimal
  // response: no connection strings, no error detail, just a status.
  app.get("/ready", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ success: true, data: { status: "ready" } });
    } catch (err) {
      logger.error({ err }, "Readiness check failed: database unreachable");
      res.status(503).json({ success: false, error: { code: "NOT_READY", message: "Service not ready" } });
    }
  });

  app.use("/api", routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
