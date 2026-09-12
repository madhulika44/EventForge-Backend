import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import type { CreatePaymentIntentParams, PaymentIntentResult, PaymentProvider, ProviderWebhookEvent } from "./payment-provider";

const RELEVANT_EVENT_TYPES = new Set(["payment_intent.succeeded", "payment_intent.payment_failed"]);

/** Stripe expects integer minor units (paise for INR, cents for USD, ...).
 * Multiplying a Decimal by 100 before converting to a number keeps this
 * exact — no raw JS float ever touches the amount. */
function toMinorUnits(amount: string): number {
  return new Prisma.Decimal(amount).mul(100).toNumber();
}

function fromMinorUnits(amount: number): string {
  return new Prisma.Decimal(amount).div(100).toFixed(2);
}

export function createStripePaymentProvider(): PaymentProvider {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("createStripePaymentProvider: STRIPE_SECRET_KEY is not set");
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  return {
    name: "stripe",

    async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
      const intent = await stripe.paymentIntents.create({
        amount: toMinorUnits(params.amount),
        currency: params.currency.toLowerCase(),
        metadata: params.metadata,
      });
      if (!intent.client_secret) {
        throw new Error("Stripe did not return a client_secret for the created PaymentIntent");
      }
      return { providerPaymentId: intent.id, clientSecret: intent.client_secret };
    },

    async retrievePaymentIntent(providerPaymentId: string): Promise<PaymentIntentResult> {
      const intent = await stripe.paymentIntents.retrieve(providerPaymentId);
      if (!intent.client_secret) {
        throw new Error("Stripe did not return a client_secret for the retrieved PaymentIntent");
      }
      return { providerPaymentId: intent.id, clientSecret: intent.client_secret };
    },

    verifyWebhookSignature(rawBody: Buffer, signature: string): ProviderWebhookEvent {
      if (!env.STRIPE_WEBHOOK_SECRET) {
        throw new Error("verifyWebhookSignature: STRIPE_WEBHOOK_SECRET is not set");
      }
      // Throws Stripe.errors.StripeSignatureVerificationError on an invalid
      // or tampered signature — the caller must let that reject the request.
      const event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

      if (!RELEVANT_EVENT_TYPES.has(event.type)) {
        return { id: event.id, type: event.type, providerPaymentId: "", amount: "0.00", currency: "" };
      }

      const intent = event.data.object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: event.type,
        providerPaymentId: intent.id,
        amount: fromMinorUnits(intent.amount),
        currency: intent.currency.toUpperCase(),
      };
    },
  };
}
