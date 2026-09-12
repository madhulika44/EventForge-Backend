import type { Event } from "@prisma/client";
import { EventStatus } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateEventData {
  organizerId: string;
  title: string;
  description?: string | undefined;
  startDateTime: Date;
  endDateTime: Date;
}

export function createEvent(data: CreateEventData): Promise<Event> {
  const { organizerId, title, startDateTime, endDateTime, description } = data;
  return prisma.event.create({
    data: {
      organizerId,
      title,
      startDateTime,
      endDateTime,
      // Prisma's generated input type wants the key omitted entirely when
      // there's no value, not set to `undefined` (exactOptionalPropertyTypes).
      ...(description !== undefined ? { description } : {}),
    },
  });
}

export function findEventById(id: string): Promise<Event | null> {
  return prisma.event.findUnique({ where: { id } });
}

export interface FindPublishedEventsParams {
  skip: number;
  take: number;
}

export async function findPublishedEvents({
  skip,
  take,
}: FindPublishedEventsParams): Promise<{ events: Event[]; total: number }> {
  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where: { status: EventStatus.PUBLISHED },
      orderBy: { startDateTime: "asc" },
      skip,
      take,
    }),
    prisma.event.count({ where: { status: EventStatus.PUBLISHED } }),
  ]);

  return { events, total };
}

export interface UpdateEventData {
  title?: string | undefined;
  description?: string | null | undefined;
  startDateTime?: Date | undefined;
  endDateTime?: Date | undefined;
  status?: EventStatus | undefined;
}

export function updateEvent(id: string, data: UpdateEventData): Promise<Event> {
  const { title, description, startDateTime, endDateTime, status } = data;
  return prisma.event.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(startDateTime !== undefined ? { startDateTime } : {}),
      ...(endDateTime !== undefined ? { endDateTime } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
}

export function cancelEvent(id: string): Promise<Event> {
  return prisma.event.update({ where: { id }, data: { status: EventStatus.CANCELLED } });
}
