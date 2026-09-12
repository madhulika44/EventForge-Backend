import { Router } from "express";
import { getEventBookingHandler, listEventBookingsHandler } from "../controllers/event-booking.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { validateQuery } from "../middleware/validate.middleware";
import { listEventBookingsQuerySchema } from "../schemas/event-booking.schema";

// mergeParams so :eventId from the parent event router is visible here.
const router = Router({ mergeParams: true });

router.get("/", requireAuth, validateQuery(listEventBookingsQuerySchema), listEventBookingsHandler);
router.get("/:bookingId", requireAuth, getEventBookingHandler);

export default router;
