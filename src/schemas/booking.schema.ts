import { z } from "zod";

const bookingItemSchema = z
  .object({
    ticketTypeId: z.string().uuid("ticketTypeId must be a valid UUID"),
    quantity: z
      .number()
      .int("quantity must be an integer")
      .positive("quantity must be a positive number")
      .max(20, "quantity must be at most 20 per item"),
    seatId: z.string().uuid("seatId must be a valid UUID").optional(),
  })
  .refine((item) => !item.seatId || item.quantity === 1, {
    message: "quantity must be exactly 1 when a seatId is specified",
    path: ["quantity"],
  });

export const createBookingSchema = z.object({
  eventId: z.string().uuid("eventId must be a valid UUID"),
  items: z.array(bookingItemSchema).min(1, "At least one item is required").max(20, "At most 20 items per booking"),
});

export const listBookingsQuerySchema = z.object({
  page: z.coerce.number().int("page must be an integer").min(1, "page must be at least 1").default(1),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(20),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CreateBookingItemInput = z.infer<typeof bookingItemSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
