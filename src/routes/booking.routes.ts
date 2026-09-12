import { Router } from "express";
import {
  cancelBookingHandler,
  createBookingHandler,
  getBookingHandler,
  listBookingsHandler,
} from "../controllers/booking.controller";
import { createPaymentHandler } from "../controllers/payment.controller";
import { retryRefundHandler } from "../controllers/refund.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { createBookingSchema, listBookingsQuerySchema } from "../schemas/booking.schema";
import { createRateLimiter } from "../middleware/rate-limit.middleware";
import { env } from "../config/env";

const router = Router();

// Payment creation calls out to the payment provider and can be retried by
// a client — worth limiting to blunt abuse (e.g. spamming payment-intent
// creation) without affecting normal checkout flows. Configurable via
// PAYMENT_RATE_LIMIT_WINDOW_MS/PAYMENT_RATE_LIMIT_MAX (default: 10 per
// minute per IP).
const paymentLimiter = createRateLimiter({
  windowMs: env.PAYMENT_RATE_LIMIT_WINDOW_MS,
  limit: env.PAYMENT_RATE_LIMIT_MAX,
  message: "Too many payment attempts, please try again later",
});

router.post("/", requireAuth, validateBody(createBookingSchema), createBookingHandler);
router.get("/", requireAuth, validateQuery(listBookingsQuerySchema), listBookingsHandler);
router.get("/:id", requireAuth, getBookingHandler);
router.post("/:id/cancel", requireAuth, cancelBookingHandler);
router.post("/:id/payment", requireAuth, paymentLimiter, createPaymentHandler);
// ADMIN-only check happens in refund.service.ts (retryRefundForBooking),
// consistent with how every other authorization check in this codebase
// lives in the service layer rather than as route-level role middleware.
router.post("/:id/refund", requireAuth, retryRefundHandler);

export default router;
