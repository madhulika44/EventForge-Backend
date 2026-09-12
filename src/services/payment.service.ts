import type { Payment } from "@prisma/client";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import * as paymentRepository from "../repositories/payment.repository";
import * as bookingRepository from "../repositories/booking.repository";
import { getOwnBooking } from "./booking.service";
import { getPaymentProvider } from "../providers/payment-provider.factory";
import { prisma } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../utils/app-error";
import type { AuthenticatedUser } from "../types/auth.types";

const RELEVANT_EVENT_TYPES = new Set(["payment_intent.succeeded", "payment_intent.payment_failed"]);

export interface CreatePaymentResult {
  payment: Payment;
  clientSecret: string;
}

/**
 * Creates (or reuses) a payment for a booking. Ownership, PENDING status,
 * and expiry are all enforced via getOwnBooking, which lazily expires the
 * booking first if its hold window has already passed — so a payment can
 * never be created for a booking that's actually already dead, even if its
 * status column hadn't been lazily updated yet by anything else.
 */
export async function createPaymentForBooking(bookingId: string, requester: AuthenticatedUser): Promise<CreatePaymentResult> {
  const booking = await getOwnBooking(bookingId, requester);

  if (booking.status !== BookingStatus.PENDING) {
    throw new AppError(400, "BOOKING_NOT_PAYABLE", "This booking is not awaiting payment");
  }

  const provider = getPaymentProvider();

  // Reuse an existing unresolved payment attempt rather than opening a
  // second one for the same booking on every retry/re-click.
  const existing = await paymentRepository.findPendingPaymentForBooking(bookingId);
  if (existing) {
    const { clientSecret } = await provider.retrievePaymentIntent(existing.providerPaymentId);
    return { payment: existing, clientSecret };
  }

  // The amount always comes from the server-side booking total — never
  // from the client — and that total is itself an immutable Phase 5 price
  // snapshot, not recalculated from current ticket type prices.
  const { providerPaymentId, clientSecret } = await provider.createPaymentIntent({
    amount: booking.total.toString(),
    currency: booking.currency,
    metadata: { bookingId: booking.id, userId: booking.userId },
  });

  const payment = await paymentRepository.createPayment({
    bookingId: booking.id,
    provider: provider.name,
    providerPaymentId,
    amount: booking.total.toString(),
    currency: booking.currency,
  });

  return { payment, clientSecret };
}

/**
 * Processes a verified Stripe webhook event. The caller (the controller)
 * is responsible for having already run this through
 * provider.verifyWebhookSignature — this function assumes the event is
 * authentic and only decides whether/how to act on it.
 */
export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const provider = getPaymentProvider();
  // Throws on an invalid/tampered signature — the controller lets that
  // reject the request with 400 rather than reaching this function's body.
  const event = provider.verifyWebhookSignature(rawBody, signature);

  if (!RELEVANT_EVENT_TYPES.has(event.type)) {
    logger.info({ eventId: event.id, eventType: event.type }, "Ignoring irrelevant Stripe webhook event");
    return;
  }

  const payment = await paymentRepository.findPaymentByProviderPaymentId(provider.name, event.providerPaymentId);
  if (!payment) {
    // Never trust a booking/payment relationship implied by the webhook
    // alone — if we don't recognize this provider payment id, there is
    // nothing safe to do but log it and acknowledge receipt.
    logger.warn({ eventId: event.id, providerPaymentId: event.providerPaymentId }, "Webhook for unknown payment");
    return;
  }

  if (event.type === "payment_intent.payment_failed") {
    await prisma.$transaction((tx) =>
      paymentRepository.transitionPaymentIfInState(payment.id, [PaymentStatus.PENDING], PaymentStatus.FAILED, event.id, tx),
    );
    return;
  }

  // payment_intent.succeeded — verify the amount/currency the provider is
  // reporting against what WE recorded when the payment was created
  // (itself sourced from the booking total), never against anything the
  // webhook payload could be used to imply on its own.
  if (!payment.amount.equals(event.amount) || payment.currency !== event.currency) {
    logger.error(
      {
        eventId: event.id,
        paymentId: payment.id,
        expected: { amount: payment.amount.toString(), currency: payment.currency },
        received: { amount: event.amount, currency: event.currency },
      },
      "Webhook amount/currency mismatch — refusing to confirm booking",
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Guarded on Payment.status = PENDING: this is what makes duplicate or
    // concurrently-delivered copies of the same webhook event safe — the
    // second one finds the payment already SUCCEEDED and no-ops here.
    const { transitioned: paymentTransitioned } = await paymentRepository.transitionPaymentIfInState(
      payment.id,
      [PaymentStatus.PENDING],
      PaymentStatus.SUCCEEDED,
      event.id,
      tx,
    );

    if (!paymentTransitioned) {
      return;
    }

    const { transitioned: bookingTransitioned, booking } = await bookingRepository.transitionBookingIfInState(
      payment.bookingId,
      [BookingStatus.PENDING],
      BookingStatus.CONFIRMED,
      tx,
    );

    if (!bookingTransitioned) {
      // The booking left PENDING (cancelled or expired) before this
      // payment's confirmation arrived — the classic payment-vs-expiry
      // race. The Payment row is still marked SUCCEEDED above: the money
      // genuinely moved, and that must remain true for audit purposes.
      // Reconciling this into a refund is explicitly out of scope for this
      // phase; this is logged loudly so it's visible for manual handling.
      logger.warn(
        { paymentId: payment.id, bookingId: payment.bookingId, bookingStatus: booking.status },
        "Payment succeeded but booking was no longer PENDING — needs manual reconciliation (refunds are a future phase)",
      );
    }
  });
}
