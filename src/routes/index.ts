import { Router } from "express";
import authRoutes from "./auth.routes";
import eventRoutes from "./event.routes";
import venueRoutes from "./venue.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/events", eventRoutes);
router.use("/venues", venueRoutes);

export default router;
