import type { TicketType } from "@prisma/client";
import { TicketStatus } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateTicketTypeData {
  eventId: string;
  name: string;
  description?: string | undefined;
  price: string;
  currency: string;
  quantity: number;
  venueSectionId?: string | undefined;
  saleStartAt?: Date | null | undefined;
  saleEndAt?: Date | null | undefined;
  status?: TicketStatus | undefined;
}

export function createTicketType(data: CreateTicketTypeData): Promise<TicketType> {
  const { eventId, name, price, currency, quantity, description, venueSectionId, saleStartAt, saleEndAt, status } =
    data;
  return prisma.ticketType.create({
    data: {
      eventId,
      name,
      price,
      currency,
      quantity,
      ...(description !== undefined ? { description } : {}),
      ...(venueSectionId !== undefined ? { venueSectionId } : {}),
      ...(saleStartAt !== undefined ? { saleStartAt } : {}),
      ...(saleEndAt !== undefined ? { saleEndAt } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
}

export function findTicketTypeById(id: string): Promise<TicketType | null> {
  return prisma.ticketType.findUnique({ where: { id } });
}

export function findTicketTypesByEvent(eventId: string): Promise<TicketType[]> {
  return prisma.ticketType.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } });
}

export interface UpdateTicketTypeData {
  name?: string | undefined;
  description?: string | null | undefined;
  price?: string | undefined;
  currency?: string | undefined;
  quantity?: number | undefined;
  venueSectionId?: string | null | undefined;
  saleStartAt?: Date | null | undefined;
  saleEndAt?: Date | null | undefined;
  status?: TicketStatus | undefined;
}

export function updateTicketType(id: string, data: UpdateTicketTypeData): Promise<TicketType> {
  const { name, description, price, currency, quantity, venueSectionId, saleStartAt, saleEndAt, status } = data;
  return prisma.ticketType.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(venueSectionId !== undefined ? { venueSectionId } : {}),
      ...(saleStartAt !== undefined ? { saleStartAt } : {}),
      ...(saleEndAt !== undefined ? { saleEndAt } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
}

export function closeTicketType(id: string): Promise<TicketType> {
  return prisma.ticketType.update({ where: { id }, data: { status: TicketStatus.CLOSED } });
}
