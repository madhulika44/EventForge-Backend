import { z } from "zod";

const name = z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters");
const description = z.string().trim().max(1000, "Description must be at most 1000 characters");
const capacity = z
  .number()
  .int("capacity must be an integer")
  .positive("capacity must be a positive number")
  .max(100_000, "capacity must be at most 100,000");
const sortOrder = z.number().int("sortOrder must be an integer").min(0, "sortOrder must be at least 0");

export const createSectionSchema = z.object({
  name,
  description: description.optional(),
  capacity,
  sortOrder: sortOrder.optional(),
});

export const updateSectionSchema = z.object({
  name: name.optional(),
  description: description.nullable().optional(),
  capacity: capacity.optional(),
  sortOrder: sortOrder.optional(),
});

export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
