import { z } from "zod";

const name = z.string().trim().min(2, "Name must be at least 2 characters").max(200, "Name must be at most 200 characters");
const description = z.string().trim().max(2000, "Description must be at most 2000 characters");
const addressLine = z.string().trim().min(1, "Address is required").max(200, "Address must be at most 200 characters");
const place = z.string().trim().min(1, "This field is required").max(100, "This field must be at most 100 characters");
const postalCode = z.string().trim().min(1, "Postal code is required").max(20, "Postal code must be at most 20 characters");
const capacity = z
  .number()
  .int("capacity must be an integer")
  .positive("capacity must be a positive number")
  .max(1_000_000, "capacity must be at most 1,000,000");

export const createVenueSchema = z.object({
  name,
  description: description.optional(),
  addressLine1: addressLine,
  addressLine2: addressLine.optional(),
  city: place,
  state: place,
  country: place,
  postalCode,
  capacity,
});

export const updateVenueSchema = z.object({
  name: name.optional(),
  description: description.nullable().optional(),
  addressLine1: addressLine.optional(),
  addressLine2: addressLine.nullable().optional(),
  city: place.optional(),
  state: place.optional(),
  country: place.optional(),
  postalCode: postalCode.optional(),
  capacity: capacity.optional(),
});

export const listVenuesQuerySchema = z.object({
  page: z.coerce.number().int("page must be an integer").min(1, "page must be at least 1").default(1),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(20),
});

export type CreateVenueInput = z.infer<typeof createVenueSchema>;
export type UpdateVenueInput = z.infer<typeof updateVenueSchema>;
export type ListVenuesQuery = z.infer<typeof listVenuesQuerySchema>;
