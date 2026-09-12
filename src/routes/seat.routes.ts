import { Router } from "express";
import { createSeatHandler, deleteSeatHandler, listSeatsHandler, updateSeatHandler } from "../controllers/seat.controller";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createSeatSchema, updateSeatSchema } from "../schemas/seat.schema";

// mergeParams so :venueId and :sectionId from the parent routers are visible here.
const router = Router({ mergeParams: true });

router.post("/", requireAuth, validateBody(createSeatSchema), createSeatHandler);
router.get("/", optionalAuth, listSeatsHandler);
router.patch("/:seatId", requireAuth, validateBody(updateSeatSchema), updateSeatHandler);
router.delete("/:seatId", requireAuth, deleteSeatHandler);

export default router;
