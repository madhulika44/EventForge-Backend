import { randomUUID, createHmac } from "crypto";
import type {
  CreatePaymentIntentParams,
  CreateRefundParams,
  PaymentIntentResult,
  PaymentProvider,
  ProviderWebhookEvent,
  RefundResult,
} from "./payment-provider";

/**
 * In-process test double used whenever real Stripe credentials aren't
 * configured (see payment-provider.factory.ts) — this is what lets the
 * server and the full automated test suite run with zero Stripe account,
 * per this phase's explicit requirement, while still exercising the real
 * webhook route/controller/service code end-to-end. Only the Stripe SDK
 * boundary itself is faked; nothing about booking/payment business logic is
 * mocked away.
 *
 * A "webhook" here is just a JSON-serialized ProviderWebhookEvent, signed
 * with a fixed test secret via HMAC-SHA256 — simple, but it genuinely
 * exercises signature verification (tampered payload / wrong signature
 * really do get rejected), rather than trivially bypassing it.
 */
const FAKE_WEBHOOK_SECRET = "fake_test_webhook_secret";

export function signFakeWebhookPayload(rawBody: Buffer): string {
  return createHmac("sha256", FAKE_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

// Test-controllable failure injection for createRefund, mirroring how real
// payment sandboxes use magic values to trigger specific outcomes. Set by a
// test right before the call it wants to fail; consumed (reset) on use so
// it never leaks into unrelated tests.
let forceNextRefundFailure = false;

export function forceNextFakeRefundFailure(): void {
  forceNextRefundFailure = true;
}

export function createFakePaymentProvider(): PaymentProvider {
  return {
    name: "fake",

    async createPaymentIntent(_params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
      return { providerPaymentId: `fake_pi_${randomUUID()}`, clientSecret: `fake_secret_${randomUUID()}` };
    },

    async retrievePaymentIntent(providerPaymentId: string): Promise<PaymentIntentResult> {
      return { providerPaymentId, clientSecret: `fake_secret_${randomUUID()}` };
    },

    async createRefund(_params: CreateRefundParams): Promise<RefundResult> {
      if (forceNextRefundFailure) {
        forceNextRefundFailure = false;
        throw new Error("Simulated payment provider failure (forceNextFakeRefundFailure)");
      }
      return { providerRefundId: `fake_re_${randomUUID()}`, status: "succeeded" };
    },

    async retrieveRefund(providerRefundId: string): Promise<RefundResult> {
      return { providerRefundId, status: "succeeded" };
    },

    verifyWebhookSignature(rawBody: Buffer, signature: string): ProviderWebhookEvent {
      const expected = signFakeWebhookPayload(rawBody);
      if (signature !== expected) {
        throw new Error("Invalid webhook signature");
      }
      return JSON.parse(rawBody.toString("utf-8")) as ProviderWebhookEvent;
    },
  };
}
