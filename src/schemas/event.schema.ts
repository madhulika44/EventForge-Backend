import { z } from "zod";
import { EventStatus } from "@prisma/client";

const title = z
  .string()
  .trim()
  .min(3, "Title must be at least 3 characters")
  .max(200, "Title must be at most 200 characters");

const description = z.string().trim().max(5000, "Description must be at most 5000 characters");

const isoDateTime = (fieldName: string) =>
  z
    .string()
    .datetime({ offset: true, message: `${fieldName} must be a valid ISO 8601 date-time` })
    .transform((value) => new Date(value));

const venueId = z.string().uuid("venueId must be a valid UUID");

export const createEventSchema = z
  .object({
    title,
    description: description.optional(),
    venueId: venueId.optional(),
    startDateTime: isoDateTime("startDateTime"),
    endDateTime: isoDateTime("endDateTime"),
  })
  .refine((data) => data.endDateTime > data.startDateTime, {
    message: "endDateTime must be after startDateTime",
    path: ["endDateTime"],
  });

export const updateEventSchema = z
  .object({
    title: title.optional(),
    description: description.nullable().optional(),
    venueId: venueId.nullable().optional(),
    startDateTime: isoDateTime("startDateTime").optional(),
    endDateTime: isoDateTime("endDateTime").optional(),
    status: z.nativeEnum(EventStatus).optional(),
  })
  .refine((data) => !(data.startDateTime && data.endDateTime) || data.endDateTime > data.startDateTime, {
    message: "endDateTime must be after startDateTime",
    path: ["endDateTime"],
  });

export const listEventsQuerySchema = z.object({
  page: z.coerce.number().int("page must be an integer").min(1, "page must be at least 1").default(1),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(20),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
