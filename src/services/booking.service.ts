import type { Booking } from "@prisma/client";
import { BookingStatus, EventStatus, Prisma, Role, TicketStatus } from "@prisma/client";
import * as bookingRepository from "../repositories/booking.repository";
import type { BookingWithItems } from "../repositories/booking.repository";
import { findEventById } from "../repositories/event.repository";
import { findTicketTypeById } from "../repositories/ticket-type.repository";
import { findSeatById } from "../repositories/seat.repository";
import { prisma } from "../config/database";
import { AppError } from "../utils/app-error";
import type { AuthenticatedUser } from "../types/auth.types";
import type { CreateBookingInput } from "../schemas/booking.schema";

// How long a PENDING booking holds its inventory before a lazy read/write
// treats it as EXPIRED. No background job enforces this — see the Phase 5
// report for why that's an intentional, explicitly-scoped simplification.
const BOOKING_HOLD_MINUTES = 15;

interface ResolvedItem {
  ticketTypeId: string;
  seatId?: string | undefined;
  quantity: number;
  ticketTypeQuantity: number;
  isReserved: boolean;
  unitPrice: Prisma.Decimal;
  totalPrice: Prisma.Decimal;
}

export interface PaginatedBookings {
  data: BookingWithItems[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface CreateBookingResult {
  booking: BookingWithItems;
  replayed: boolean;
}

function assertCanAccess(booking: Booking, requester: AuthenticatedUser): void {
  const isOwner = booking.userId === requester.id;
  const isAdmin = requester.role === Role.ADMIN;
  if (!isOwner && !isAdmin) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to access this booking");
  }
}

/** PENDING + past its hold window is treated as EXPIRED the moment anything
 * looks at it — there is no background worker for this in this phase. */
async function lazilyExpireIfDue(booking: BookingWithItems): Promise<BookingWithItems> {
  if (booking.status === BookingStatus.PENDING && booking.expiresAt && booking.expiresAt < new Date()) {
    return bookingRepository.markBookingExpired(booking.id);
  }
  return booking;
}

interface ResolvedItems {
  items: ResolvedItem[];
  currency: string;
}

async function resolveAndValidateItems(eventId: string, input: CreateBookingInput): Promise<ResolvedItems> {
  const seatIds = input.items.map((i) => i.seatId).filter((id): id is string => Boolean(id));
  if (new Set(seatIds).size !== seatIds.length) {
    throw new AppError(400, "DUPLICATE_SEAT_IN_REQUEST", "The same seat was requested more than once");
  }

  const gaTicketTypeIds = input.items.filter((i) => !i.seatId).map((i) => i.ticketTypeId);
  if (new Set(gaTicketTypeIds).size !== gaTicketTypeIds.length) {
    throw new AppError(
      400,
      "DUPLICATE_TICKET_TYPE_IN_REQUEST",
      "Combine quantities into a single item per general-admission ticket type instead of repeating it",
    );
  }

  const now = new Date();
  const resolved: ResolvedItem[] = [];
  let currency: string | undefined;

  for (const item of input.items) {
    const ticketType = await findTicketTypeById(item.ticketTypeId);
    if (!ticketType || ticketType.eventId !== eventId) {
      throw new AppError(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
    }
    if (ticketType.status !== TicketStatus.ACTIVE) {
      throw new AppError(400, "TICKET_TYPE_NOT_BOOKABLE", "This ticket type is not currently available for purchase");
    }
    if (ticketType.saleStartAt && now < ticketType.saleStartAt) {
      throw new AppError(400, "SALE_NOT_STARTED", "Ticket sales have not started yet");
    }
    if (ticketType.saleEndAt && now > ticketType.saleEndAt) {
      throw new AppError(400, "SALE_ENDED", "Ticket sales have ended");
    }

    if (ticketType.venueSectionId) {
      if (!item.seatId) {
        throw new AppError(400, "SEAT_REQUIRED", "This ticket type requires selecting a specific seat");
      }
      const seat = await findSeatById(item.seatId);
      if (!seat || seat.venueSectionId !== ticketType.venueSectionId) {
        throw new AppError(404, "SEAT_NOT_FOUND", "Seat not found");
      }
    } else if (item.seatId) {
      throw new AppError(400, "SEAT_NOT_ALLOWED", "This ticket type is general admission and does not use seat selection");
    }

    if (currency === undefined) {
      currency = ticketType.currency;
    } else if (currency !== ticketType.currency) {
      throw new AppError(400, "MIXED_CURRENCY_NOT_SUPPORTED", "All items in a booking must use the same currency");
    }

    const unitPrice = ticketType.price;
    const totalPrice = unitPrice.mul(item.quantity);

    resolved.push({
      ticketTypeId: ticketType.id,
      seatId: item.seatId,
      quantity: item.quantity,
      ticketTypeQuantity: ticketType.quantity,
      isReserved: Boolean(ticketType.venueSectionId),
      unitPrice,
      totalPrice,
    });
  }

  return { items: resolved, currency: currency! };
}

export async function createBooking(
  userId: string,
  input: CreateBookingInput,
  idempotencyKey?: string,
): Promise<CreateBookingResult> {
  if (idempotencyKey) {
    const existing = await bookingRepository.findBookingByIdempotencyKey(userId, idempotencyKey);
    if (existing) {
      return { booking: existing, replayed: true };
    }
  }

  const event = await findEventById(input.eventId);
  if (!event) {
    throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
  }
  // Deliberately no owner/admin preview exception here: booking eligibility
  // is PUBLISHED-only for everyone, organizer included.
  if (event.status !== EventStatus.PUBLISHED) {
    throw new AppError(400, "EVENT_NOT_BOOKABLE", "This event is not open for booking");
  }

  const { items: resolvedItems, currency } = await resolveAndValidateItems(input.eventId, input);
  const subtotal = resolvedItems.reduce((sum, item) => sum.add(item.totalPrice), new Prisma.Decimal(0));
  const total = subtotal; // no fees/taxes yet — see the Phase 5 report.
  const expiresAt = new Date(Date.now() + BOOKING_HOLD_MINUTES * 60 * 1000);

  // Consistent lock-acquisition order across concurrent transactions
  // (ticket type first, then seat) avoids deadlocking on shared resources.
  const sortedItems = [...resolvedItems].sort(
    (a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId) || (a.seatId ?? "").localeCompare(b.seatId ?? ""),
  );

  const booking = await prisma.$transaction(async (tx) => {
    for (const item of sortedItems) {
      if (item.seatId) {
        await bookingRepository.expireStaleHolds({ seatId: item.seatId }, tx);
        await bookingRepository.lockSeatRow(item.seatId, tx);
        const activeItem = await bookingRepository.findActiveBookingItemForSeat(item.seatId, tx);
        if (activeItem) {
          throw new AppError(409, "SEAT_UNAVAILABLE", "This seat is no longer available");
        }
      } else {
        await bookingRepository.expireStaleHolds({ ticketTypeId: item.ticketTypeId }, tx);
        const { quantity: currentTicketTypeQuantity } = await bookingRepository.lockTicketTypeRow(
          item.ticketTypeId,
          tx,
        );
        const held = await bookingRepository.sumActiveQuantityForTicketType(item.ticketTypeId, tx);
        if (held + item.quantity > currentTicketTypeQuantity) {
          throw new AppError(409, "INSUFFICIENT_INVENTORY", "Not enough tickets remaining for this ticket type");
        }
      }
    }

    return bookingRepository.createBookingWithItems(
      {
        userId,
        eventId: input.eventId,
        currency,
        subtotal: subtotal.toString(),
        total: total.toString(),
        expiresAt,
        idempotencyKey,
        items: sortedItems.map((item) => ({
          ticketTypeId: item.ticketTypeId,
          seatId: item.seatId,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          totalPrice: item.totalPrice.toString(),
        })),
      },
      tx,
    );
  });

  return { booking, replayed: false };
}

export async function getOwnBooking(id: string, requester: AuthenticatedUser): Promise<BookingWithItems> {
  const booking = await bookingRepository.findBookingById(id);
  if (!booking) {
    throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  }
  assertCanAccess(booking, requester);
  return lazilyExpireIfDue(booking);
}

export async function listOwnBookings(userId: string, page: number, limit: number): Promise<PaginatedBookings> {
  const skip = (page - 1) * limit;
  const { bookings, total } = await bookingRepository.findUserBookings({ userId, skip, take: limit });
  const data = await Promise.all(bookings.map((booking) => lazilyExpireIfDue(booking)));

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function cancelBooking(id: string, requester: AuthenticatedUser): Promise<BookingWithItems> {
  const booking = await getOwnBooking(id, requester); // reuses ownership check + lazy expiry

  if (booking.status === BookingStatus.CANCELLED) {
    return booking; // idempotent
  }
  if (booking.status !== BookingStatus.PENDING && booking.status !== BookingStatus.CONFIRMED) {
    throw new AppError(400, "BOOKING_NOT_CANCELLABLE", "This booking can no longer be cancelled");
  }

  return bookingRepository.markBookingCancelled(id);
}
