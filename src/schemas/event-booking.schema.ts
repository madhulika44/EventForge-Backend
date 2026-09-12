import { z } from "zod";
import { BookingStatus } from "@prisma/client";

export const listEventBookingsQuerySchema = z.object({
  page: z.coerce.number().int("page must be an integer").min(1, "page must be at least 1").default(1),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(20),
  status: z.nativeEnum(BookingStatus).optional(),
});

export type ListEventBookingsQuery = z.infer<typeof listEventBookingsQuerySchema>;
