import type { Seat } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateSeatData {
  venueSectionId: string;
  rowLabel: string;
  seatNumber: number;
  label: string;
}

export function createSeat(data: CreateSeatData): Promise<Seat> {
  return prisma.seat.create({ data });
}

export function findSeatById(id: string): Promise<Seat | null> {
  return prisma.seat.findUnique({ where: { id } });
}

export function findSeatsBySection(venueSectionId: string): Promise<Seat[]> {
  return prisma.seat.findMany({
    where: { venueSectionId },
    orderBy: [{ rowLabel: "asc" }, { seatNumber: "asc" }],
  });
}

export interface UpdateSeatData {
  rowLabel?: string | undefined;
  seatNumber?: number | undefined;
  label?: string | undefined;
}

export function updateSeat(id: string, data: UpdateSeatData): Promise<Seat> {
  const { rowLabel, seatNumber, label } = data;
  return prisma.seat.update({
    where: { id },
    data: {
      ...(rowLabel !== undefined ? { rowLabel } : {}),
      ...(seatNumber !== undefined ? { seatNumber } : {}),
      ...(label !== undefined ? { label } : {}),
    },
  });
}

export function deleteSeat(id: string): Promise<Seat> {
  return prisma.seat.delete({ where: { id } });
}
