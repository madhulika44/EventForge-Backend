import { Router } from "express";
import {
  cancelEventHandler,
  createEventHandler,
  getEventHandler,
  listEventsHandler,
  updateEventHandler,
} from "../controllers/event.controller";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import { createEventSchema, listEventsQuerySchema, updateEventSchema } from "../schemas/event.schema";

const router = Router();

router.post("/", requireAuth, validateBody(createEventSchema), createEventHandler);
router.get("/", validateQuery(listEventsQuerySchema), listEventsHandler);
router.get("/:id", optionalAuth, getEventHandler);
router.patch("/:id", requireAuth, validateBody(updateEventSchema), updateEventHandler);
router.delete("/:id", requireAuth, cancelEventHandler);

export default router;
