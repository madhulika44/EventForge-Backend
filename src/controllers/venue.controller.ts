import type { Request, Response } from "express";
import * as venueService from "../services/venue.service";
import type { ListVenuesQuery } from "../schemas/venue.schema";

export async function createVenueHandler(req: Request, res: Response): Promise<void> {
  const venue = await venueService.createVenue(req.user!.id, req.body);
  res.status(201).json({ success: true, data: { venue } });
}

export async function listVenuesHandler(_req: Request, res: Response): Promise<void> {
  const { page, limit } = res.locals.query as ListVenuesQuery;
  const { data, pagination } = await venueService.listActiveVenues(page, limit);
  res.status(200).json({ success: true, data, pagination });
}

export async function getVenueHandler(req: Request, res: Response): Promise<void> {
  const venue = await venueService.getVisibleVenue(req.params.id as string, req.user);
  res.status(200).json({ success: true, data: { venue } });
}

export async function updateVenueHandler(req: Request, res: Response): Promise<void> {
  const venue = await venueService.updateVenue(req.params.id as string, req.user!, req.body);
  res.status(200).json({ success: true, data: { venue } });
}

export async function archiveVenueHandler(req: Request, res: Response): Promise<void> {
  const venue = await venueService.archiveVenue(req.params.id as string, req.user!);
  res.status(200).json({ success: true, data: { venue } });
}
