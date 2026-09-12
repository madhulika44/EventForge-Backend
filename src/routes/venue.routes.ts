import { Router } from "express";
import {
  archiveVenueHandler,
  createVenueHandler,
  getVenueHandler,
  listVenuesHandler,
  updateVenueHandler,
} from "../controllers/venue.controller";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { createVenueSchema, listVenuesQuerySchema, updateVenueSchema } from "../schemas/venue.schema";
import sectionRoutes from "./venue-section.routes";

const router = Router();

router.post("/", requireAuth, validateBody(createVenueSchema), createVenueHandler);
router.get("/", validateQuery(listVenuesQuerySchema), listVenuesHandler);
router.get("/:id", optionalAuth, getVenueHandler);
router.patch("/:id", requireAuth, validateBody(updateVenueSchema), updateVenueHandler);
router.delete("/:id", requireAuth, archiveVenueHandler);

router.use("/:venueId/sections", sectionRoutes);

export default router;
