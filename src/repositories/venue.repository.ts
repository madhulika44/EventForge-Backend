import type { Venue } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateVenueData {
  ownerId: string;
  name: string;
  description?: string | undefined;
  addressLine1: string;
  addressLine2?: string | undefined;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  capacity: number;
}

export function createVenue(data: CreateVenueData): Promise<Venue> {
  const { ownerId, name, addressLine1, city, state, country, postalCode, capacity, description, addressLine2 } = data;
  return prisma.venue.create({
    data: {
      ownerId,
      name,
      addressLine1,
      city,
      state,
      country,
      postalCode,
      capacity,
      ...(description !== undefined ? { description } : {}),
      ...(addressLine2 !== undefined ? { addressLine2 } : {}),
    },
  });
}

export function findVenueById(id: string): Promise<Venue | null> {
  return prisma.venue.findUnique({ where: { id } });
}

export interface FindActiveVenuesParams {
  skip: number;
  take: number;
}

export async function findActiveVenues({
  skip,
  take,
}: FindActiveVenuesParams): Promise<{ venues: Venue[]; total: number }> {
  const where = { archivedAt: null };
  const [venues, total] = await Promise.all([
    prisma.venue.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.venue.count({ where }),
  ]);

  return { venues, total };
}

export interface UpdateVenueData {
  name?: string | undefined;
  description?: string | null | undefined;
  addressLine1?: string | undefined;
  addressLine2?: string | null | undefined;
  city?: string | undefined;
  state?: string | undefined;
  country?: string | undefined;
  postalCode?: string | undefined;
  capacity?: number | undefined;
}

export function updateVenue(id: string, data: UpdateVenueData): Promise<Venue> {
  const { name, description, addressLine1, addressLine2, city, state, country, postalCode, capacity } = data;
  return prisma.venue.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(addressLine1 !== undefined ? { addressLine1 } : {}),
      ...(addressLine2 !== undefined ? { addressLine2 } : {}),
      ...(city !== undefined ? { city } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(country !== undefined ? { country } : {}),
      ...(postalCode !== undefined ? { postalCode } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
    },
  });
}

export function archiveVenue(id: string): Promise<Venue> {
  return prisma.venue.update({ where: { id }, data: { archivedAt: new Date() } });
}
