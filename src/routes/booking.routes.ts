import { Router } from "express";
import {
  cancelBookingHandler,
  createBookingHandler,
  getBookingHandler,
  listBookingsHandler,
} from "../controllers/booking.controller";
import { createPaymentHandler } from "../controllers/payment.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { createBookingSchema, listBookingsQuerySchema } from "../schemas/booking.schema";

const router = Router();

router.post("/", requireAuth, validateBody(createBookingSchema), createBookingHandler);
router.get("/", requireAuth, validateQuery(listBookingsQuerySchema), listBookingsHandler);
router.get("/:id", requireAuth, getBookingHandler);
router.post("/:id/cancel", requireAuth, cancelBookingHandler);
router.post("/:id/payment", requireAuth, createPaymentHandler);

export default router;
