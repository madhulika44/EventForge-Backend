import type { Event, TicketType } from "@prisma/client";
import { Role, TicketStatus } from "@prisma/client";
import * as ticketTypeRepository from "../repositories/ticket-type.repository";
import { findEventById } from "../repositories/event.repository";
import { findSectionById } from "../repositories/venue-section.repository";
import { getVisibleEvent } from "./event.service";
import { AppError } from "../utils/app-error";
import { assertOwnerOrAdmin } from "../utils/authorization";
import type { AuthenticatedUser } from "../types/auth.types";
import type { CreateTicketTypeInput, UpdateTicketTypeInput } from "../schemas/ticket-type.schema";

// A private local helper rather than reusing event.service's own (unexported)
// equivalent — keeps Phase 2's event.service.ts completely untouched.
async function findEventOrThrow(eventId: string): Promise<Event> {
  const event = await findEventById(eventId);
  if (!event) {
    throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
  }
  return event;
}

async function findTicketTypeInEventOrThrow(eventId: string, ticketTypeId: string): Promise<TicketType> {
  const ticketType = await ticketTypeRepository.findTicketTypeById(ticketTypeId);
  if (!ticketType || ticketType.eventId !== eventId) {
    throw new AppError(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
  }
  return ticketType;
}

/**
 * Validates that a venueSectionId, if provided, is legitimately assignable:
 * the event must have a venue, the section must belong to that venue, and
 * the ticket quantity must not exceed the section's declared capacity.
 * A plain FK can't express any of this multi-hop business rule.
 */
async function assertValidSectionAssignment(event: Event, venueSectionId: string, quantity: number): Promise<void> {
  if (!event.venueId) {
    throw new AppError(400, "INVALID_VENUE_SECTION", "Cannot assign a venue section: this event has no venue");
  }

  const section = await findSectionById(venueSectionId);
  if (!section || section.venueId !== event.venueId) {
    throw new AppError(400, "INVALID_VENUE_SECTION", "The specified section does not belong to this event's venue");
  }

  if (quantity > section.capacity) {
    throw new AppError(
      400,
      "QUANTITY_EXCEEDS_SECTION_CAPACITY",
      `quantity (${quantity}) cannot exceed the section's capacity (${section.capacity})`,
    );
  }
}

export async function createTicketType(
  eventId: string,
  requester: AuthenticatedUser,
  input: CreateTicketTypeInput,
): Promise<TicketType> {
  const event = await findEventOrThrow(eventId);
  assertOwnerOrAdmin(event.organizerId, requester, "You do not have permission to manage this event's ticket types");

  if (input.venueSectionId) {
    await assertValidSectionAssignment(event, input.venueSectionId, input.quantity);
  }

  return ticketTypeRepository.createTicketType({ eventId, ...input });
}

export async function listTicketTypes(eventId: string, requester?: AuthenticatedUser): Promise<TicketType[]> {
  const event = await getVisibleEvent(eventId, requester);
  const all = await ticketTypeRepository.findTicketTypesByEvent(eventId);

  if (isOwnerOrAdmin(event, requester)) {
    return all;
  }

  // DRAFT means "the organizer is still configuring this tier" — not yet
  // meant to be shown to the public, even for an otherwise-published event.
  return all.filter((ticketType) => ticketType.status !== TicketStatus.DRAFT);
}

export async function getVisibleTicketType(
  eventId: string,
  ticketTypeId: string,
  requester?: AuthenticatedUser,
): Promise<TicketType> {
  const event = await getVisibleEvent(eventId, requester);
  const ticketType = await findTicketTypeInEventOrThrow(eventId, ticketTypeId);

  if (isOwnerOrAdmin(event, requester)) {
    return ticketType;
  }

  if (ticketType.status === TicketStatus.DRAFT) {
    throw new AppError(404, "TICKET_TYPE_NOT_FOUND", "Ticket type not found");
  }

  return ticketType;
}

export async function updateTicketType(
  eventId: string,
  ticketTypeId: string,
  requester: AuthenticatedUser,
  input: UpdateTicketTypeInput,
): Promise<TicketType> {
  const event = await findEventOrThrow(eventId);
  const ticketType = await findTicketTypeInEventOrThrow(eventId, ticketTypeId);
  assertOwnerOrAdmin(event.organizerId, requester, "You do not have permission to manage this event's ticket types");

  const effectiveVenueSectionId =
    input.venueSectionId !== undefined ? input.venueSectionId : ticketType.venueSectionId;
  const effectiveQuantity = input.quantity ?? ticketType.quantity;

  if (effectiveVenueSectionId) {
    await assertValidSectionAssignment(event, effectiveVenueSectionId, effectiveQuantity);
  }

  return ticketTypeRepository.updateTicketType(ticketTypeId, input);
}

export async function closeTicketType(
  eventId: string,
  ticketTypeId: string,
  requester: AuthenticatedUser,
): Promise<TicketType> {
  const event = await findEventOrThrow(eventId);
  await findTicketTypeInEventOrThrow(eventId, ticketTypeId);
  assertOwnerOrAdmin(event.organizerId, requester, "You do not have permission to manage this event's ticket types");
  return ticketTypeRepository.closeTicketType(ticketTypeId);
}

function isOwnerOrAdmin(event: Event, requester?: AuthenticatedUser): boolean {
  return requester?.id === event.organizerId || requester?.role === Role.ADMIN;
}
