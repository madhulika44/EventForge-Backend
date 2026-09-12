import type { Booking, BookingItem, Prisma } from "@prisma/client";
import { BookingStatus } from "@prisma/client";
import { randomBytes } from "crypto";
import { prisma } from "../config/database";

// Any Prisma client capable of running queries — either the global client
// or an interactive transaction handle. Every function here accepts one so
// the service can compose them all inside a single prisma.$transaction(...)
// while still keeping this repository as the only layer touching Prisma.
type DbClient = typeof prisma | Prisma.TransactionClient;

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateBookingReference(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) {
    code += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `EVF-${code}`;
}

export type BookingWithItems = Booking & { items: BookingItem[] };

export function findBookingById(id: string, client: DbClient = prisma): Promise<BookingWithItems | null> {
  return client.booking.findUnique({ where: { id }, include: { items: true } });
}

export function findBookingByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
  client: DbClient = prisma,
): Promise<BookingWithItems | null> {
  return client.booking.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: { items: true },
  });
}

export interface FindUserBookingsParams {
  userId: string;
  skip: number;
  take: number;
}

export async function findUserBookings({
  userId,
  skip,
  take,
}: FindUserBookingsParams): Promise<{ bookings: BookingWithItems[]; total: number }> {
  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.booking.count({ where: { userId } }),
  ]);
  return { bookings, total };
}

/** Locks the ticket type row for the duration of the transaction (so
 * concurrent bookings against it serialize on this lock) and returns its
 * quantity as read under that lock — the freshest possible value, closing
 * any window between an earlier pre-check and this point. */
export async function lockTicketTypeRow(
  ticketTypeId: string,
  tx: Prisma.TransactionClient,
): Promise<{ quantity: number }> {
  const rows = await tx.$queryRaw<
    { quantity: number }[]
  >`SELECT quantity FROM ticket_types WHERE id = ${ticketTypeId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) {
    throw new Error(`lockTicketTypeRow: ticket type ${ticketTypeId} not found`);
  }
  return row;
}

/** Locks the seat row for the duration of the transaction, so concurrent
 * bookings against the same seat serialize on it. */
export async function lockSeatRow(seatId: string, tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seatId}::uuid FOR UPDATE`;
}

/** Sum of quantities currently held (PENDING or CONFIRMED) against a ticket
 * type — the "sold or reserved" figure derived from BookingItem, never
 * stored on TicketType itself. */
export async function sumActiveQuantityForTicketType(
  ticketTypeId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const result = await tx.bookingItem.aggregate({
    where: { ticketTypeId, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

/** The currently-active (PENDING/CONFIRMED) booking item for a seat, if any. */
export function findActiveBookingItemForSeat(
  seatId: string,
  tx: Prisma.TransactionClient,
): Promise<BookingItem | null> {
  return tx.bookingItem.findFirst({
    where: { seatId, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
  });
}

/**
 * Finds PENDING bookings past their expiresAt that are currently holding a
 * given seat or ticket type, and transitions them (and their items) to
 * EXPIRED. This is what makes "lazy expiry" actually work for concurrency:
 * without it, an abandoned hold would keep blocking new bookings forever,
 * since nothing else would ever flip its status.
 */
export async function expireStaleHolds(
  where: { seatId: string } | { ticketTypeId: string },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const staleBookings = await tx.booking.findMany({
    where: {
      status: BookingStatus.PENDING,
      expiresAt: { lt: new Date() },
      items: { some: where },
    },
    select: { id: true },
  });

  if (staleBookings.length === 0) {
    return;
  }

  const ids = staleBookings.map((b) => b.id);
  await tx.booking.updateMany({ where: { id: { in: ids } }, data: { status: BookingStatus.EXPIRED } });
  await tx.bookingItem.updateMany({ where: { bookingId: { in: ids } }, data: { status: BookingStatus.EXPIRED } });
}

export interface CreateBookingItemData {
  ticketTypeId: string;
  seatId?: string | undefined;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
}

export interface CreateBookingData {
  userId: string;
  eventId: string;
  currency: string;
  subtotal: string;
  total: string;
  expiresAt: Date;
  idempotencyKey?: string | undefined;
  items: CreateBookingItemData[];
}

export function createBookingWithItems(data: CreateBookingData, tx: Prisma.TransactionClient): Promise<BookingWithItems> {
  const { userId, eventId, currency, subtotal, total, expiresAt, idempotencyKey, items } = data;
  return tx.booking.create({
    data: {
      userId,
      eventId,
      currency,
      subtotal,
      total,
      expiresAt,
      bookingReference: generateBookingReference(),
      status: BookingStatus.PENDING,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      items: {
        create: items.map((item) => ({
          ticketTypeId: item.ticketTypeId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: BookingStatus.PENDING,
          ...(item.seatId !== undefined ? { seatId: item.seatId } : {}),
        })),
      },
    },
    include: { items: true },
  });
}

export interface TransitionResult {
  /** false means someone else already moved this booking off `fromStatuses`
   * before this call's UPDATE could — a safe, expected outcome under
   * concurrency (e.g. the payment-vs-expiry race), never an error. */
  transitioned: boolean;
  booking: BookingWithItems;
}

/**
 * Transitions a booking and all its items to `toStatus`, but only if the
 * booking is currently in one of `fromStatuses` — atomically, and safe
 * under concurrency with no explicit row lock needed.
 *
 * Why this is race-safe: `UPDATE ... WHERE id = ? AND status IN (...)` is a
 * single statement, and Postgres takes a row-level write lock on the target
 * row as part of executing it. If two transactions race to transition the
 * same booking (e.g. a payment webhook confirming it while the expiry
 * worker is simultaneously trying to expire it), the second one's UPDATE
 * blocks until the first commits, then re-evaluates its own WHERE clause
 * against the now-committed row — finds status is no longer in
 * `fromStatuses`, and affects zero rows. That's exactly the `transitioned:
 * false` case: a safe no-op, not a partial or corrupted update. This needs
 * no raw SELECT ... FOR UPDATE query and no extra schema column; it's
 * Postgres's ordinary UPDATE semantics, applied deliberately.
 */
export async function transitionBookingIfInState(
  id: string,
  fromStatuses: BookingStatus[],
  toStatus: BookingStatus,
  tx: Prisma.TransactionClient,
): Promise<TransitionResult> {
  const result = await tx.booking.updateMany({
    where: { id, status: { in: fromStatuses } },
    data: { status: toStatus },
  });

  if (result.count > 0) {
    await tx.bookingItem.updateMany({ where: { bookingId: id }, data: { status: toStatus } });
  }

  const booking = await findBookingById(id, tx);
  if (!booking) {
    throw new Error(`transitionBookingIfInState: booking ${id} not found`);
  }
  return { transitioned: result.count > 0, booking };
}

/** IDs of PENDING bookings whose hold window has already passed —
 * candidates for the expiry worker (or a lazy check) to transition. */
export async function findDuePendingBookingIds(now: Date = new Date()): Promise<string[]> {
  const due = await prisma.booking.findMany({
    where: { status: BookingStatus.PENDING, expiresAt: { lt: now } },
    select: { id: true },
  });
  return due.map((b) => b.id);
}
