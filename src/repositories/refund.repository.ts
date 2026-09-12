import type { Prisma, Refund } from "@prisma/client";
import { RefundStatus } from "@prisma/client";
import { prisma } from "../config/database";

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findRefundById(id: string, client: DbClient = prisma): Promise<Refund | null> {
  return client.refund.findUnique({ where: { id } });
}

/** Any PENDING or SUCCEEDED refund for a payment — the same set the partial
 * unique index (refunds_active_payment_unique) treats as "active". */
export function findActiveRefundForPayment(paymentId: string, client: DbClient = prisma): Promise<Refund | null> {
  return client.refund.findFirst({
    where: { paymentId, status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] } },
    orderBy: { createdAt: "desc" },
  });
}

/** Most recent refund attempt for a payment regardless of status — used to
 * decide whether a manual retry should create a new attempt (the latest is
 * FAILED, or there isn't one yet) or just report the existing one. */
export function findLatestRefundForPayment(paymentId: string, client: DbClient = prisma): Promise<Refund | null> {
  return client.refund.findFirst({ where: { paymentId }, orderBy: { createdAt: "desc" } });
}

export function findRefundByProviderRefundId(
  provider: string,
  providerRefundId: string,
  client: DbClient = prisma,
): Promise<Refund | null> {
  return client.refund.findUnique({ where: { provider_providerRefundId: { provider, providerRefundId } } });
}

export interface CreateRefundData {
  paymentId: string;
  provider: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
}

/** Persists the PENDING row BEFORE the provider is ever called — see the
 * schema comment on Refund.providerRefundId for why this ordering matters
 * for crash safety in an async, worker-driven flow. */
export function createRefund(data: CreateRefundData, client: DbClient = prisma): Promise<Refund> {
  return client.refund.create({ data: { ...data, status: RefundStatus.PENDING } });
}

export interface TransitionRefundResult {
  transitioned: boolean;
  refund: Refund;
}

export interface TransitionRefundExtra {
  providerRefundId?: string;
  failureReason?: string;
  providerEventId?: string;
}

/**
 * Same guarded-conditional-UPDATE pattern as
 * booking.repository.transitionBookingIfInState and
 * payment.repository.transitionPaymentIfInState: only transitions if
 * currently in one of `fromStatuses`, and the affected-row count decides
 * success — safe against concurrent/duplicate attempts to move the same
 * refund (a retried worker job, a duplicate webhook delivery, or both
 * racing each other).
 */
export async function transitionRefundIfInState(
  id: string,
  fromStatuses: RefundStatus[],
  toStatus: RefundStatus,
  extra: TransitionRefundExtra,
  tx: Prisma.TransactionClient,
): Promise<TransitionRefundResult> {
  const result = await tx.refund.updateMany({
    where: { id, status: { in: fromStatuses } },
    data: {
      status: toStatus,
      ...(extra.providerRefundId !== undefined ? { providerRefundId: extra.providerRefundId } : {}),
      ...(extra.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      ...(extra.providerEventId !== undefined ? { providerEventId: extra.providerEventId } : {}),
    },
  });

  const refund = await tx.refund.findUnique({ where: { id } });
  if (!refund) {
    throw new Error(`transitionRefundIfInState: refund ${id} not found`);
  }
  return { transitioned: result.count > 0, refund };
}
