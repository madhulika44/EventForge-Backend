import type { Event } from "@prisma/client";
import { EventStatus, Role } from "@prisma/client";
import * as eventRepository from "../repositories/event.repository";
import { findVenueById } from "../repositories/venue.repository";
import { AppError } from "../utils/app-error";
import type { AuthenticatedUser } from "../types/auth.types";
import type { CreateEventInput, UpdateEventInput } from "../schemas/event.schema";

async function assertVenueExists(venueId: string): Promise<void> {
  const venue = await findVenueById(venueId);
  if (!venue) {
    throw new AppError(400, "INVALID_VENUE_ID", "The specified venue does not exist");
  }
}

export interface PaginatedEvents {
  data: Event[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function assertCanManage(event: Event, requester: AuthenticatedUser): void {
  const isOwner = event.organizerId === requester.id;
  const isAdmin = requester.role === Role.ADMIN;

  if (!isOwner && !isAdmin) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to manage this event");
  }
}

async function findEventOr404(id: string): Promise<Event> {
  const event = await eventRepository.findEventById(id);
  if (!event) {
    throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
  }
  return event;
}

export async function createEvent(organizerId: string, input: CreateEventInput): Promise<Event> {
  if (input.venueId) {
    await assertVenueExists(input.venueId);
  }
  return eventRepository.createEvent({ organizerId, ...input });
}

export async function getVisibleEvent(id: string, requester?: AuthenticatedUser): Promise<Event> {
  const event = await findEventOr404(id);

  if (event.status === EventStatus.PUBLISHED) {
    return event;
  }

  const isOwner = requester?.id === event.organizerId;
  const isAdmin = requester?.role === Role.ADMIN;

  if (isOwner || isAdmin) {
    return event;
  }

  // Don't reveal that a non-published event exists to an unauthorized caller.
  throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
}

export async function listPublishedEvents(page: number, limit: number): Promise<PaginatedEvents> {
  const skip = (page - 1) * limit;
  const { events, total } = await eventRepository.findPublishedEvents({ skip, take: limit });

  return {
    data: events,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function updateEvent(
  id: string,
  requester: AuthenticatedUser,
  input: UpdateEventInput,
): Promise<Event> {
  const event = await findEventOr404(id);
  assertCanManage(event, requester);

  if (input.venueId) {
    await assertVenueExists(input.venueId);
  }

  const effectiveStart = input.startDateTime ?? event.startDateTime;
  const effectiveEnd = input.endDateTime ?? event.endDateTime;
  if (effectiveEnd <= effectiveStart) {
    throw new AppError(400, "INVALID_EVENT_DATES", "endDateTime must be after startDateTime");
  }

  return eventRepository.updateEvent(id, input);
}

export async function cancelEvent(id: string, requester: AuthenticatedUser): Promise<Event> {
  const event = await findEventOr404(id);
  assertCanManage(event, requester);
  return eventRepository.cancelEvent(id);
}
