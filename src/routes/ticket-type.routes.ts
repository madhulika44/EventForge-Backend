import { Router } from "express";
import {
  closeTicketTypeHandler,
  createTicketTypeHandler,
  getTicketTypeHandler,
  listTicketTypesHandler,
  updateTicketTypeHandler,
} from "../controllers/ticket-type.controller";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import { createTicketTypeSchema, updateTicketTypeSchema } from "../schemas/ticket-type.schema";

// mergeParams so :eventId from the parent event router is visible here.
const router = Router({ mergeParams: true });

router.post("/", requireAuth, validateBody(createTicketTypeSchema), createTicketTypeHandler);
router.get("/", optionalAuth, listTicketTypesHandler);
router.get("/:ticketTypeId", optionalAuth, getTicketTypeHandler);
router.patch("/:ticketTypeId", requireAuth, validateBody(updateTicketTypeSchema), updateTicketTypeHandler);
router.delete("/:ticketTypeId", requireAuth, closeTicketTypeHandler);

export default router;
