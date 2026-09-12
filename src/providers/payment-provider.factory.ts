import { env } from "../config/env";
import { logger } from "../config/logger";
import type { PaymentProvider } from "./payment-provider";
import { createStripePaymentProvider } from "./stripe-payment-provider";
import { createFakePaymentProvider } from "./fake-payment-provider";

let cachedProvider: PaymentProvider | undefined;

/**
 * Selects the real Stripe provider only when actual credentials are
 * configured; otherwise (including always in NODE_ENV=test) falls back to
 * the fake provider. This means `npm run dev` works out of the box with no
 * Stripe account, and `npm test` never depends on one.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!cachedProvider) {
    const useFake = env.NODE_ENV === "test" || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET;
    cachedProvider = useFake ? createFakePaymentProvider() : createStripePaymentProvider();
    if (useFake && env.NODE_ENV !== "test") {
      logger.warn("STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET not set — using the fake payment provider");
    }
  }
  return cachedProvider;
}
