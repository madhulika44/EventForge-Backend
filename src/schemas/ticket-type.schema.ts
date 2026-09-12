import { z } from "zod";
import { TicketStatus } from "@prisma/client";

const name = z.string().trim().min(2, "Name must be at least 2 characters").max(150, "Name must be at most 150 characters");
const description = z.string().trim().max(2000, "Description must be at most 2000 characters");

// Accepts a JSON number or string, but always normalizes through toFixed(2)
// / a strict decimal-string check before it ever reaches Prisma's Decimal —
// a raw JS float (e.g. 2500.1) is never passed through directly, since a
// binary float can already be imprecise before any arithmetic happens.
const price = z
  .union([z.string(), z.number()])
  .transform((val) => (typeof val === "number" ? val.toFixed(2) : val.trim()))
  .refine((val) => /^\d{1,10}(\.\d{1,2})?$/.test(val), {
    message: "price must be a valid monetary amount with up to 2 decimal places",
  })
  .refine((val) => Number(val) > 0, { message: "price must be greater than 0" });

const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 code (e.g. INR, USD)");

const quantity = z
  .number()
  .int("quantity must be an integer")
  .positive("quantity must be a positive number")
  .max(1_000_000, "quantity must be at most 1,000,000");

const venueSectionId = z.string().uuid("venueSectionId must be a valid UUID");

const saleDateTime = (fieldName: string) =>
  z
    .string()
    .datetime({ offset: true, message: `${fieldName} must be a valid ISO 8601 date-time` })
    .transform((value) => new Date(value));

export const createTicketTypeSchema = z
  .object({
    name,
    description: description.optional(),
    price,
    currency: currency.default("INR"),
    quantity,
    venueSectionId: venueSectionId.optional(),
    saleStartAt: saleDateTime("saleStartAt").nullable().optional(),
    saleEndAt: saleDateTime("saleEndAt").nullable().optional(),
    status: z.nativeEnum(TicketStatus).optional(),
  })
  .refine((data) => !(data.saleStartAt && data.saleEndAt) || data.saleEndAt > data.saleStartAt, {
    message: "saleEndAt must be after saleStartAt",
    path: ["saleEndAt"],
  });

export const updateTicketTypeSchema = z
  .object({
    name: name.optional(),
    description: description.nullable().optional(),
    price: price.optional(),
    currency: currency.optional(),
    quantity: quantity.optional(),
    venueSectionId: venueSectionId.nullable().optional(),
    saleStartAt: saleDateTime("saleStartAt").nullable().optional(),
    saleEndAt: saleDateTime("saleEndAt").nullable().optional(),
    status: z.nativeEnum(TicketStatus).optional(),
  })
  .refine((data) => !(data.saleStartAt && data.saleEndAt) || data.saleEndAt > data.saleStartAt, {
    message: "saleEndAt must be after saleStartAt",
    path: ["saleEndAt"],
  });

export type CreateTicketTypeInput = z.infer<typeof createTicketTypeSchema>;
export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeSchema>;
