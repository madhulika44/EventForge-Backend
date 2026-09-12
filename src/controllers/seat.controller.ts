import type { Request, Response } from "express";
import * as seatService from "../services/seat.service";

export async function createSeatHandler(req: Request, res: Response): Promise<void> {
  const seat = await seatService.createSeat(
    req.params.venueId as string,
    req.params.sectionId as string,
    req.user!,
    req.body,
  );
  res.status(201).json({ success: true, data: { seat } });
}

export async function listSeatsHandler(req: Request, res: Response): Promise<void> {
  const seats = await seatService.listSeats(req.params.venueId as string, req.params.sectionId as string, req.user);
  res.status(200).json({ success: true, data: seats });
}

export async function updateSeatHandler(req: Request, res: Response): Promise<void> {
  const seat = await seatService.updateSeat(
    req.params.venueId as string,
    req.params.sectionId as string,
    req.params.seatId as string,
    req.user!,
    req.body,
  );
  res.status(200).json({ success: true, data: { seat } });
}

export async function deleteSeatHandler(req: Request, res: Response): Promise<void> {
  await seatService.deleteSeat(
    req.params.venueId as string,
    req.params.sectionId as string,
    req.params.seatId as string,
    req.user!,
  );
  res.status(200).json({ success: true, data: null });
}
