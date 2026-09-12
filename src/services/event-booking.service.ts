import type { Event } from "@prisma/client";
import { BookingStatus } from "@prisma/client";
import * as bookingRepository from "../repositories/booking.repository";
import type { BookingWithAttendeeDetails } from "../repositories/booking.repository";
import { findEventById } from "../repositories/event.repository";
import { AppError } from "../utils/app-error";
import { assertOwnerOrAdmin } from "../utils/authorization";
import type { AuthenticatedUser } from "../types/auth.types";

async function findEventOrThrow(eventId: string): Promise<Event> {
  const event = await findEventById(eventId);
  if (!event) {
    throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
  }
  return event;
}

export interface AttendeeBookingItemView {
  type: "RESERVED" | "GENERAL_ADMISSION";
  ticketTypeName: string;
  quantity?: number;
  seatLabel?: string;
}

export interface AttendeeBookingView {
  bookingId: string;
  bookingReference: string;
  status: BookingStatus;
  createdAt: Date;
  total: string;
  currency: string;
  attendee: { name: string; email: string };
  items: AttendeeBookingItemView[];
}

/**
 * The privacy-safe projection organizers see — deliberately never the raw
 * Booking/BookingItem/User models. No passwordHash, role, other bookings by
 * this same attendee, or payment/refund internals; nothing here comes from
 * a table an organizer shouldn't be able to see in the first place (the
 * repository query itself only selects user.name/email, not the full User).
 * Same idea as auth.service.ts's toPublicUser for the same reason.
 */
function toAttendeeBookingView(booking: BookingWithAttendeeDetails): AttendeeBookingView {
  return {
    bookingId: booking.id,
    bookingReference: booking.bookingReference,
    status: booking.status,
    createdAt: booking.createdAt,
    total: booking.total.toString(),
    currency: booking.currency,
    attendee: { name: booking.user.name, email: booking.user.email },
    items: booking.items.map((item) =>
      item.seat
        ? { type: "RESERVED" as const, ticketTypeName: item.ticketType.name, seatLabel: item.seat.label }
        : { type: "GENERAL_ADMISSION" as const, ticketTypeName: item.ticketType.name, quantity: item.quantity },
    ),
  };
}

export interface PaginatedAttendeeBookings {
  data: AttendeeBookingView[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export async function listEventBookings(
  eventId: string,
  requester: AuthenticatedUser,
  page: number,
  limit: number,
  status?: BookingStatus,
): Promise<PaginatedAttendeeBookings> {
  const event = await findEventOrThrow(eventId);
  assertOwnerOrAdmin(event.organizerId, requester, "You do not have permission to view this event's bookings");

  const skip = (page - 1) * limit;
  const { bookings, total } = await bookingRepository.findBookingsByEvent({ eventId, skip, take: limit, status });

  return {
    data: bookings.map(toAttendeeBookingView),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getEventBooking(
  eventId: string,
  bookingId: string,
  requester: AuthenticatedUser,
): Promise<AttendeeBookingView> {
  const event = await findEventOrThrow(eventId);

  const booking = await bookingRepository.findBookingWithAttendeeDetailsById(bookingId);
  if (!booking || booking.eventId !== eventId) {
    // A booking id that exists but belongs to a different event is treated
    // as not found in this event's collection — same cross-resource-mismatch
    // handling already used for ticket types/sections/seats.
    throw new AppError(404, "BOOKING_NOT_FOUND", "Booking not found");
  }

  assertOwnerOrAdmin(event.organizerId, requester, "You do not have permission to view this event's bookings");

  return toAttendeeBookingView(booking);
}
