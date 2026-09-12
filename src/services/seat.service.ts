import type { Seat } from "@prisma/client";
import * as seatRepository from "../repositories/seat.repository";
import { findVenueOrThrow, getVisibleVenue } from "./venue.service";
import { findSectionInVenueOrThrow } from "./venue-section.service";
import { AppError } from "../utils/app-error";
import { assertOwnerOrAdmin } from "../utils/authorization";
import type { AuthenticatedUser } from "../types/auth.types";
import type { CreateSeatInput, UpdateSeatInput } from "../schemas/seat.schema";

/**
 * Loads the seat and verifies it actually belongs to sectionId — same
 * cross-scope protection as findSectionInVenueOrThrow, one level deeper.
 */
async function findSeatInSectionOrThrow(sectionId: string, seatId: string): Promise<Seat> {
  const seat = await seatRepository.findSeatById(seatId);
  if (!seat || seat.venueSectionId !== sectionId) {
    throw new AppError(404, "SEAT_NOT_FOUND", "Seat not found");
  }
  return seat;
}

export async function createSeat(
  venueId: string,
  sectionId: string,
  requester: AuthenticatedUser,
  input: CreateSeatInput,
): Promise<Seat> {
  const venue = await findVenueOrThrow(venueId);
  const section = await findSectionInVenueOrThrow(venueId, sectionId);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");

  return seatRepository.createSeat({
    venueSectionId: section.id,
    rowLabel: input.rowLabel,
    seatNumber: input.seatNumber,
    label: input.label ?? `${input.rowLabel}${input.seatNumber}`,
  });
}

export async function listSeats(
  venueId: string,
  sectionId: string,
  requester?: AuthenticatedUser,
): Promise<Seat[]> {
  await getVisibleVenue(venueId, requester);
  const section = await findSectionInVenueOrThrow(venueId, sectionId);
  return seatRepository.findSeatsBySection(section.id);
}

export async function updateSeat(
  venueId: string,
  sectionId: string,
  seatId: string,
  requester: AuthenticatedUser,
  input: UpdateSeatInput,
): Promise<Seat> {
  const venue = await findVenueOrThrow(venueId);
  const section = await findSectionInVenueOrThrow(venueId, sectionId);
  const seat = await findSeatInSectionOrThrow(section.id, seatId);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");
  return seatRepository.updateSeat(seat.id, input);
}

export async function deleteSeat(
  venueId: string,
  sectionId: string,
  seatId: string,
  requester: AuthenticatedUser,
): Promise<Seat> {
  const venue = await findVenueOrThrow(venueId);
  const section = await findSectionInVenueOrThrow(venueId, sectionId);
  const seat = await findSeatInSectionOrThrow(section.id, seatId);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");
  return seatRepository.deleteSeat(seat.id);
}
