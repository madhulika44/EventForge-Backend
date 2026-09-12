import { z } from "zod";

const rowLabel = z.string().trim().min(1, "rowLabel is required").max(10, "rowLabel must be at most 10 characters");
const seatNumber = z.number().int("seatNumber must be an integer").positive("seatNumber must be a positive number");
const label = z.string().trim().min(1, "label must not be empty").max(20, "label must be at most 20 characters");

export const createSeatSchema = z.object({
  rowLabel,
  seatNumber,
  label: label.optional(),
});

export const updateSeatSchema = z.object({
  rowLabel: rowLabel.optional(),
  seatNumber: seatNumber.optional(),
  label: label.optional(),
});

export type CreateSeatInput = z.infer<typeof createSeatSchema>;
export type UpdateSeatInput = z.infer<typeof updateSeatSchema>;
