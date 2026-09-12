import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { stripeWebhookHandler } from "./controllers/payment.controller";
import routes from "./routes";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: true, // reflects the request origin; tighten to an allowlist once a frontend URL exists
      credentials: true,
    }),
  );
  // pino-http moved ahead of body parsing (was after express.json() before
  // Phase 6) so the Stripe webhook route below — which must run before the
  // global JSON parser — still gets request logging like everything else.
  app.use(pinoHttp({ logger }));

  // Stripe webhook signature verification needs the raw, unparsed request
  // body, so this route is registered — with its own raw-body parser —
  // before the global express.json() below consumes the stream for every
  // other route. It sends its own response and never calls next(), so it
  // never reaches express.json() regardless of order.
  app.post("/api/payments/webhook/stripe", express.raw({ type: "application/json" }), stripeWebhookHandler);

  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });

  app.use("/api", routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
