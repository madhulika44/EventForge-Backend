import type { Payment, Prisma } from "@prisma/client";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "../config/database";

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findPaymentById(id: string, client: DbClient = prisma): Promise<Payment | null> {
  return client.payment.findUnique({ where: { id } });
}

export function findPendingPaymentForBooking(bookingId: string, client: DbClient = prisma): Promise<Payment | null> {
  return client.payment.findFirst({
    where: { bookingId, status: PaymentStatus.PENDING },
    orderBy: { createdAt: "desc" },
  });
}

export function findPaymentByProviderPaymentId(
  provider: string,
  providerPaymentId: string,
  client: DbClient = prisma,
): Promise<Payment | null> {
  return client.payment.findUnique({ where: { provider_providerPaymentId: { provider, providerPaymentId } } });
}

export interface CreatePaymentData {
  bookingId: string;
  provider: string;
  providerPaymentId: string;
  amount: string;
  currency: string;
}

export function createPayment(data: CreatePaymentData, client: DbClient = prisma): Promise<Payment> {
  return client.payment.create({ data: { ...data, status: PaymentStatus.PENDING } });
}

export interface TransitionPaymentResult {
  transitioned: boolean;
  payment: Payment;
}

/**
 * Same guarded-conditional-UPDATE pattern as
 * booking.repository.transitionBookingIfInState, applied to Payment: only
 * transitions if currently in one of `fromStatuses`, and the affected-row
 * count (not a prior read) is what determines success — safe against two
 * concurrent deliveries of the same webhook event racing each other.
 */
export async function transitionPaymentIfInState(
  id: string,
  fromStatuses: PaymentStatus[],
  toStatus: PaymentStatus,
  providerEventId: string | undefined,
  tx: Prisma.TransactionClient,
): Promise<TransitionPaymentResult> {
  const result = await tx.payment.updateMany({
    where: { id, status: { in: fromStatuses } },
    data: { status: toStatus, ...(providerEventId !== undefined ? { providerEventId } : {}) },
  });

  const payment = await tx.payment.findUnique({ where: { id } });
  if (!payment) {
    throw new Error(`transitionPaymentIfInState: payment ${id} not found`);
  }
  return { transitioned: result.count > 0, payment };
}
