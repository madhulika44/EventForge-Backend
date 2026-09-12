import type { Request, Response } from "express";
import * as ticketTypeService from "../services/ticket-type.service";

export async function createTicketTypeHandler(req: Request, res: Response): Promise<void> {
  const ticketType = await ticketTypeService.createTicketType(req.params.eventId as string, req.user!, req.body);
  res.status(201).json({ success: true, data: { ticketType } });
}

export async function listTicketTypesHandler(req: Request, res: Response): Promise<void> {
  const ticketTypes = await ticketTypeService.listTicketTypes(req.params.eventId as string, req.user);
  res.status(200).json({ success: true, data: ticketTypes });
}

export async function getTicketTypeHandler(req: Request, res: Response): Promise<void> {
  const ticketType = await ticketTypeService.getVisibleTicketType(
    req.params.eventId as string,
    req.params.ticketTypeId as string,
    req.user,
  );
  res.status(200).json({ success: true, data: { ticketType } });
}

export async function updateTicketTypeHandler(req: Request, res: Response): Promise<void> {
  const ticketType = await ticketTypeService.updateTicketType(
    req.params.eventId as string,
    req.params.ticketTypeId as string,
    req.user!,
    req.body,
  );
  res.status(200).json({ success: true, data: { ticketType } });
}

export async function closeTicketTypeHandler(req: Request, res: Response): Promise<void> {
  const ticketType = await ticketTypeService.closeTicketType(
    req.params.eventId as string,
    req.params.ticketTypeId as string,
    req.user!,
  );
  res.status(200).json({ success: true, data: { ticketType } });
}
