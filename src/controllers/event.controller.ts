import type { Request, Response } from "express";
import * as eventService from "../services/event.service";
import type { ListEventsQuery } from "../schemas/event.schema";

export async function createEventHandler(req: Request, res: Response): Promise<void> {
  const event = await eventService.createEvent(req.user!.id, req.body);
  res.status(201).json({ success: true, data: { event } });
}

export async function listEventsHandler(_req: Request, res: Response): Promise<void> {
  const { page, limit } = res.locals.query as ListEventsQuery;
  const { data, pagination } = await eventService.listPublishedEvents(page, limit);
  res.status(200).json({ success: true, data, pagination });
}

export async function getEventHandler(req: Request, res: Response): Promise<void> {
  const event = await eventService.getVisibleEvent(req.params.id as string, req.user);
  res.status(200).json({ success: true, data: { event } });
}

export async function updateEventHandler(req: Request, res: Response): Promise<void> {
  const event = await eventService.updateEvent(req.params.id as string, req.user!, req.body);
  res.status(200).json({ success: true, data: { event } });
}

export async function cancelEventHandler(req: Request, res: Response): Promise<void> {
  const event = await eventService.cancelEvent(req.params.id as string, req.user!);
  res.status(200).json({ success: true, data: { event } });
}
