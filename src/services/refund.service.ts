import type { Payment, Refund } from "@prisma/client";
import { BookingStatus, Prisma, RefundStatus, Role } from "@prisma/client";
import { randomUUID } from "crypto";
import * as refundRepository from "../repositories/refund.repository";
import * as paymentRepository from "../repositories/payment.repository";
import { findBookingById } from "../repositories/booking.repository";
import { getPaymentProvider } from "../providers/payment-provider.factory";
import type { ProviderWebhookEvent } from "../providers/payment-provider";
import { enqueueRefundJob } from "../queues/refund.queue";
import { prisma } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../utils/app-error";
import type { AuthenticatedUser } from "../types/auth.types";

/**
 * Creates a refund for a payment, or returns the already-active one —
 * shared by both the automatic (booking cancellation) and manual (admin
 * retry) trigger paths, so "never create a second active refund" is
 * enforced in exactly one place rather than twice.
 *
 * Race-safe end to end: the check-then-create has a window where two
 * concurrent callers could both see "no active refund" and both attempt to
 * create one, but the partial unique index (refunds_active_payment_unique)
 * makes the loser's insert fail with P2002 — caught here and turned into
 * "return the winner's row" rather than an error, so the operation is
 * idempotent in effect even under genuine concurrency, not just when called
 * sequentially.
 */
async function ensureRefundForPayment(payment: Payment): Promise<Refund> {
  const active = await refundRepository.findActiveRefundForPayment(payment.id);
  if (active) {
    if (active.status === RefundStatus.PENDING) {
      // Defensive re-enqueue: if the ORIGINAL enqueue call for this exact
      // refund failed (e.g. Redis was briefly unreachable right after the
      // row was created), the row exists but no job was ever queued for
      // it, and it would sit stuck forever. Re-adding with the same job id
      // is a safe no-op if a job already exists (BullMQ dedupes by job
      // id) — processRefund itself is fully idempotent regardless of how
      // many times its job is triggered — and otherwise un-sticks it. Not
      // thrown on failure: this is a best-effort nudge, not the primary
      // operation the caller asked for.
      await enqueueRefundJob(active.id).catch((err) => {
        logger.error({ refundId: active.id, err }, "Failed to re-enqueue existing pending refund");
      });
    }
    return active;
  }

  try {
    const refund = await refundRepository.createRefund({
      paymentId: payment.id,
      provider: payment.provider,
      idempotencyKey: `refund_${randomUUID()}`,
      amount: payment.amount.toString(),
      currency: payment.currency,
    });
    await enqueueRefundJob(refund.id);
    return refund;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await refundRepository.findActiveRefundForPayment(payment.id);
      if (existing) {
        return existing;
      }
    }
    throw err;
  }
}

/**
 * Called from booking.service.cancelBooking right after a booking that was
 * CONFIRMED transitions to CANCELLED. Cancelling a booking that was still
 * PENDING (never successfully paid) finds no SUCCEEDED payment and is a
 * clean no-op — no Refund row is ever created for it.
 */
export async function triggerRefundForCancelledBooking(bookingId: string): Promise<void> {
  const payment = await paymentRepository.findSucceededPaymentForBooking(bookingId);
  if (!payment) {
    return;
  }
  await ensureRefundForPayment(payment);
}

/**
 * POST /api/bookings/:id/refund — ADMIN-only manual lever, primarily for
 * retrying after a refund attempt permanently FAILED. Idempotent: if a
 * refund is already active (PENDING/SUCCEEDED) it's returned as-is rather
 * than creating another. The amount is never taken from the request — it
 * always comes from the payment's own immutable snapshot.
 */
export async function retryRefundForBooking(bookingId: string, requester: AuthenticatedUser): Promise<Refund> {
  if (requester.role !== Role.ADMIN) {
    throw new AppError(403, "FORBIDDEN", "Only an admin can retry a refund");
  }

  const booking = await findBookingById(bookingId);
  if (!booking) {
    throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  }
  if (booking.status !== BookingStatus.CANCELLED) {
    throw new AppError(400, "BOOKING_NOT_REFUNDABLE", "Only a cancelled booking can be refunded");
  }

  const payment = await paymentRepository.findSucceededPaymentForBooking(bookingId);
  if (!payment) {
    throw new AppError(400, "NO_SUCCEEDED_PAYMENT", "This booking has no successful payment to refund");
  }

  return ensureRefundForPayment(payment);
}

/**
 * Worker-invoked (also directly callable/testable with no BullMQ
 * involved, same philosophy as booking.service.expireDueBookings). Safe to
 * run repeatedly, concurrently with itself, or after a crash:
 *   - a refund no longer PENDING is already resolved — no-op.
 *   - a refund that already has a providerRefundId had its provider-side
 *     call already succeed on a previous run; this only re-checks its
 *     status rather than calling createRefund a second time.
 *   - a genuine provider failure (the provider call throws) is recorded as
 *     terminal FAILED immediately, not left for BullMQ to keep retrying —
 *     that requires the explicit admin retry endpoint. Only a failure to
 *     even RECORD that outcome (our own DB/transaction throwing) propagates
 *     out of this function, which is what should trigger BullMQ's own
 *     job-level retry.
 */
export async function processRefund(refundId: string): Promise<void> {
  const refund = await refundRepository.findRefundById(refundId);
  if (!refund) {
    logger.warn({ refundId }, "processRefund: refund not found");
    return;
  }
  if (refund.status !== RefundStatus.PENDING) {
    return;
  }

  const payment = await paymentRepository.findPaymentById(refund.paymentId);
  if (!payment) {
    logger.error({ refundId, paymentId: refund.paymentId }, "processRefund: payment not found for refund");
    return;
  }

  const provider = getPaymentProvider();

  if (refund.providerRefundId) {
    // A provider-side refund object already exists from a prior run of
    // this job — only ever RE-CHECK its status here, never call
    // createRefund again for this attempt (that would risk a genuine
    // second refund at the provider). Crucially, a failure to check
    // (network blip) must NOT be converted into FAILED: it stays PENDING
    // and this throw propagates so BullMQ retries the check later, and the
    // refund webhook can also resolve it independently in the meantime.
    const result = await provider.retrieveRefund(refund.providerRefundId);
    if (result.status === "pending") {
      return;
    }
    const toStatus = result.status === "succeeded" ? RefundStatus.SUCCEEDED : RefundStatus.FAILED;
    await prisma.$transaction((tx) => refundRepository.transitionRefundIfInState(refund.id, [RefundStatus.PENDING], toStatus, {}, tx));
    return;
  }

  // No providerRefundId yet: this is the first real attempt to create the
  // refund at the provider.
  let result;
  try {
    result = await provider.createRefund({
      providerPaymentId: payment.providerPaymentId,
      amount: refund.amount.toString(),
      currency: refund.currency,
      idempotencyKey: refund.idempotencyKey,
    });
  } catch (err) {
    // The call itself never returned an id, so nothing was (confirmably)
    // created at the provider — safe to mark this attempt terminally
    // FAILED; a retry creates a fresh attempt with a fresh idempotency key.
    const message = err instanceof Error ? err.message : String(err);
    await prisma.$transaction((tx) =>
      refundRepository.transitionRefundIfInState(refund.id, [RefundStatus.PENDING], RefundStatus.FAILED, { failureReason: message }, tx),
    );
    logger.error({ refundId, err: message }, "Refund provider call failed — marked FAILED (retry via admin endpoint)");
    return;
  }

  // We now have a definitive providerRefundId. From here on, a failure to
  // persist the outcome must never be turned into FAILED (same reasoning
  // as above) — let it propagate so BullMQ retries recording it; a retry
  // takes the "already has providerRefundId" branch above, not this one.
  if (result.status === "pending") {
    await prisma.$transaction((tx) =>
      refundRepository.transitionRefundIfInState(
        refund.id,
        [RefundStatus.PENDING],
        RefundStatus.PENDING,
        { providerRefundId: result.providerRefundId },
        tx,
      ),
    );
    return;
  }

  const toStatus = result.status === "succeeded" ? RefundStatus.SUCCEEDED : RefundStatus.FAILED;
  await prisma.$transaction((tx) =>
    refundRepository.transitionRefundIfInState(refund.id, [RefundStatus.PENDING], toStatus, { providerRefundId: result.providerRefundId }, tx),
  );
}

/**
 * Called from payment.service.handleStripeWebhook once it detects a
 * refund-related event. Same guarded-transition + providerEventId-audit
 * pattern as the payment webhook path.
 */
export async function handleRefundWebhookEvent(event: ProviderWebhookEvent): Promise<void> {
  const provider = getPaymentProvider();
  const refund = await refundRepository.findRefundByProviderRefundId(provider.name, event.providerRefundId);
  if (!refund) {
    // Rare race: the webhook arrived before our own synchronous worker
    // write recorded providerRefundId. Safe to log and acknowledge — that
    // worker path is still the primary, near-immediate source of truth.
    logger.warn({ eventId: event.id, providerRefundId: event.providerRefundId }, "Webhook for unknown refund");
    return;
  }

  const toStatus =
    event.refundStatus === "succeeded"
      ? RefundStatus.SUCCEEDED
      : event.refundStatus === "failed"
        ? RefundStatus.FAILED
        : null;

  if (!toStatus) {
    return; // still pending at the provider — nothing to change yet
  }

  await prisma.$transaction((tx) =>
    refundRepository.transitionRefundIfInState(refund.id, [RefundStatus.PENDING], toStatus, { providerEventId: event.id }, tx),
  );
}
