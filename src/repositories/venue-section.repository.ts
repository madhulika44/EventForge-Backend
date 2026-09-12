import type { VenueSection } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateSectionData {
  venueId: string;
  name: string;
  description?: string | undefined;
  capacity: number;
  sortOrder?: number | undefined;
}

export function createSection(data: CreateSectionData): Promise<VenueSection> {
  const { venueId, name, capacity, description, sortOrder } = data;
  return prisma.venueSection.create({
    data: {
      venueId,
      name,
      capacity,
      ...(description !== undefined ? { description } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    },
  });
}

export function findSectionById(id: string): Promise<VenueSection | null> {
  return prisma.venueSection.findUnique({ where: { id } });
}

export function findSectionsByVenue(venueId: string): Promise<VenueSection[]> {
  return prisma.venueSection.findMany({ where: { venueId }, orderBy: { sortOrder: "asc" } });
}

export interface UpdateSectionData {
  name?: string | undefined;
  description?: string | null | undefined;
  capacity?: number | undefined;
  sortOrder?: number | undefined;
}

export function updateSection(id: string, data: UpdateSectionData): Promise<VenueSection> {
  const { name, description, capacity, sortOrder } = data;
  return prisma.venueSection.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    },
  });
}

export function deleteSection(id: string): Promise<VenueSection> {
  return prisma.venueSection.delete({ where: { id } });
}
