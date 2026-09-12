import type { Request, Response } from "express";
import * as sectionService from "../services/venue-section.service";

export async function createSectionHandler(req: Request, res: Response): Promise<void> {
  const section = await sectionService.createSection(req.params.venueId as string, req.user!, req.body);
  res.status(201).json({ success: true, data: { section } });
}

export async function listSectionsHandler(req: Request, res: Response): Promise<void> {
  const sections = await sectionService.listSections(req.params.venueId as string, req.user);
  res.status(200).json({ success: true, data: sections });
}

export async function updateSectionHandler(req: Request, res: Response): Promise<void> {
  const section = await sectionService.updateSection(
    req.params.venueId as string,
    req.params.sectionId as string,
    req.user!,
    req.body,
  );
  res.status(200).json({ success: true, data: { section } });
}

export async function deleteSectionHandler(req: Request, res: Response): Promise<void> {
  await sectionService.deleteSection(req.params.venueId as string, req.params.sectionId as string, req.user!);
  res.status(200).json({ success: true, data: null });
}
