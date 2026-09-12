import type { Request, Response } from "express";
import * as eventBookingService from "../services/event-booking.service";
import type { ListEventBookingsQuery } from "../schemas/event-booking.schema";

export async function listEventBookingsHandler(req: Request, res: Response): Promise<void> {
  const { page, limit, status } = res.locals.query as ListEventBookingsQuery;
  const { data, pagination } = await eventBookingService.listEventBookings(
    req.params.eventId as string,
    req.user!,
    page,
    limit,
    status,
  );
  res.status(200).json({ success: true, data, pagination });
}

export async function getEventBookingHandler(req: Request, res: Response): Promise<void> {
  const booking = await eventBookingService.getEventBooking(
    req.params.eventId as string,
    req.params.bookingId as string,
    req.user!,
  );
  res.status(200).json({ success: true, data: { booking } });
}
