/**
 * Provider-agnostic payment abstraction. PaymentService talks only to this
 * interface — no Stripe-specific types or calls appear outside
 * stripe-payment-provider.ts, so adding Razorpay (or any other provider)
 * later means writing one new file that implements this interface, not
 * touching booking/payment business logic.
 */
export interface CreatePaymentIntentParams {
  /** Decimal string, e.g. "5000.00" — the provider implementation is
   * responsible for converting to whatever unit it requires. */
  amount: string;
  currency: string;
  metadata: { bookingId: string; userId: string };
}

export interface PaymentIntentResult {
  providerPaymentId: string;
  /** Opaque value the frontend needs to complete payment client-side
   * (Stripe's PaymentIntent client_secret). Never a secret credential. */
  clientSecret: string;
}

export interface ProviderWebhookEvent {
  /** The provider's own id for this specific event delivery — used for
   * audit trails, not as the primary idempotency mechanism (see the
   * Payment.providerEventId schema comment for why). */
  id: string;
  type: string;
  providerPaymentId: string;
  amount: string;
  currency: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult>;
  retrievePaymentIntent(providerPaymentId: string): Promise<PaymentIntentResult>;
  /** Verifies the signature and parses the event. Must throw if the
   * signature is invalid — never trust an unverified payload. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): ProviderWebhookEvent;
}
