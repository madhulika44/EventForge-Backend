import type { VenueSection } from "@prisma/client";
import * as sectionRepository from "../repositories/venue-section.repository";
import { findVenueOrThrow, getVisibleVenue } from "./venue.service";
import { AppError } from "../utils/app-error";
import { assertOwnerOrAdmin } from "../utils/authorization";
import type { AuthenticatedUser } from "../types/auth.types";
import type { CreateSectionInput, UpdateSectionInput } from "../schemas/venue-section.schema";

/**
 * Loads the section and verifies it actually belongs to venueId — a section
 * id that exists but belongs to a different venue is treated as not found
 * within this venue's collection, so a nested URL can never be used to
 * reach across into another venue's data.
 */
export async function findSectionInVenueOrThrow(venueId: string, sectionId: string): Promise<VenueSection> {
  const section = await sectionRepository.findSectionById(sectionId);
  if (!section || section.venueId !== venueId) {
    throw new AppError(404, "SECTION_NOT_FOUND", "Section not found");
  }
  return section;
}

export async function createSection(
  venueId: string,
  requester: AuthenticatedUser,
  input: CreateSectionInput,
): Promise<VenueSection> {
  const venue = await findVenueOrThrow(venueId);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");
  return sectionRepository.createSection({ venueId, ...input });
}

export async function listSections(venueId: string, requester?: AuthenticatedUser): Promise<VenueSection[]> {
  await getVisibleVenue(venueId, requester);
  return sectionRepository.findSectionsByVenue(venueId);
}

export async function updateSection(
  venueId: string,
  sectionId: string,
  requester: AuthenticatedUser,
  input: UpdateSectionInput,
): Promise<VenueSection> {
  const venue = await findVenueOrThrow(venueId);
  const section = await findSectionInVenueOrThrow(venueId, sectionId);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");
  return sectionRepository.updateSection(section.id, input);
}

export async function deleteSection(
  venueId: string,
  sectionId: string,
  requester: AuthenticatedUser,
): Promise<VenueSection> {
  const venue = await findVenueOrThrow(venueId);
  const section = await findSectionInVenueOrThrow(venueId, sectionId);
  assertOwnerOrAdmin(venue.ownerId, requester, "You do not have permission to manage this venue");
  return sectionRepository.deleteSection(section.id);
}
