import type { Venue } from "@prisma/client";
import { Role } from "@prisma/client";
import * as venueRepository from "../repositories/venue.repository";
import { AppError } from "../utils/app-error";
import { assertOwnerOrAdmin } from "../utils/authorization";
import type { AuthenticatedUser } from "../types/auth.types";
import type { CreateVenueInput, UpdateVenueInput } from "../schemas/venue.schema";

export interface PaginatedVenues {
  data: Venue[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export async function findVenueOrThrow(id: string): Promise<Venue> {
  const venue = await venueRepository.findVenueById(id);
  if (!venue) {
    throw new AppError(404, "VENUE_NOT_FOUND", "Venue not found");
  }
  return venue;
}

export async function createVenue(ownerId: string, input: CreateVenueInput): Promise<Venue> {
  return venueRepository.createVenue({ ownerId, ...input });
}

export async function getVisibleVenue(id: string, requester?: AuthenticatedUser): Promise<Venue> {
  const venue = await findVenueOrThrow(id);

  if (!venue.archivedAt) {
    return venue;
  }

  const isOwner = requester?.id === venue.ownerId;
  const isAdmin = requester?.role === Role.ADMIN;

  if (isOwner || isAdmin) {
    return venue;
  }

  // Don't reveal that an archived venue exists to an unauthorized caller.
  throw new AppError(404, "VENUE_NOT_FOUND", "Venue not found");
}

export async function listActiveVenues(page: number, limit: number): Promise<PaginatedVenues> {
  const skip = (page - 1) * limit;
  const { venues, total } = await venueRepository.findActiveVenues({ skip, take: limit });

  return {
    data: venues,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function updateVenue(id: string, requester: AuthenticatedUser, input: UpdateVenueInput): Promise<Venue> {
  const venue = await findVenueOrThrow(id);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");
  return venueRepository.updateVenue(id, input);
}

export async function archiveVenue(id: string, requester: AuthenticatedUser): Promise<Venue> {
  const venue = await findVenueOrThrow(id);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");

  // Idempotent: archiving an already-archived venue just returns it as-is
  // rather than bumping archivedAt to a new timestamp.
  if (venue.archivedAt) {
    return venue;
  }

  return venueRepository.archiveVenue(id);
}
