import { Router } from "express";
import {
  createSectionHandler,
  deleteSectionHandler,
  listSectionsHandler,
  updateSectionHandler,
} from "../controllers/venue-section.controller";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createSectionSchema, updateSectionSchema } from "../schemas/venue-section.schema";
import seatRoutes from "./seat.routes";

// mergeParams so :venueId from the parent venue router is visible here.
const router = Router({ mergeParams: true });

router.post("/", requireAuth, validateBody(createSectionSchema), createSectionHandler);
router.get("/", optionalAuth, listSectionsHandler);
router.patch("/:sectionId", requireAuth, validateBody(updateSectionSchema), updateSectionHandler);
router.delete("/:sectionId", requireAuth, deleteSectionHandler);

router.use("/:sectionId/seats", seatRoutes);

export default router;
