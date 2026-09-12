import { Router } from "express";
import authRoutes from "./auth.routes";
import eventRoutes from "./event.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/events", eventRoutes);

export default router;
