import type { Request, Response } from "express";
import * as bookingService from "../services/booking.service";
import type { ListBookingsQuery } from "../schemas/booking.schema";

function idempotencyKeyFrom(req: Request): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}

export async function createBookingHandler(req: Request, res: Response): Promise<void> {
  const { booking, replayed } = await bookingService.createBooking(req.user!.id, req.body, idempotencyKeyFrom(req));
  res.status(replayed ? 200 : 201).json({ success: true, data: { booking } });
}

export async function listBookingsHandler(req: Request, res: Response): Promise<void> {
  const { page, limit } = res.locals.query as ListBookingsQuery;
  const { data, pagination } = await bookingService.listOwnBookings(req.user!.id, page, limit);
  res.status(200).json({ success: true, data, pagination });
}

export async function getBookingHandler(req: Request, res: Response): Promise<void> {
  const booking = await bookingService.getOwnBooking(req.params.id as string, req.user!);
  res.status(200).json({ success: true, data: { booking } });
}

export async function cancelBookingHandler(req: Request, res: Response): Promise<void> {
  const booking = await bookingService.cancelBooking(req.params.id as string, req.user!);
  res.status(200).json({ success: true, data: { booking } });
}
