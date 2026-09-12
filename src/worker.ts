import { createBookingExpiryWorker } from "./workers/booking-expiry.worker";
import { scheduleBookingExpirySweep, closeBookingExpiryQueue } from "./queues/booking-expiry.queue";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { logger } from "./config/logger";

// A deliberately separate process from the API server (started via
// `npm run worker`, not by server.ts): the worker's lifecycle — crashes,
// restarts, deploys — shouldn't be entangled with the HTTP API's, and
// production systems typically scale/deploy these independently anyway.
const SWEEP_INTERVAL_MS = 60_000; // re-check for due bookings once a minute

async function main(): Promise<void> {
  await connectDatabase();
  await scheduleBookingExpirySweep(SWEEP_INTERVAL_MS);
  const worker = createBookingExpiryWorker();

  logger.info(`Booking expiry worker started (sweeping every ${SWEEP_INTERVAL_MS / 1000}s)`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down booking expiry worker`);
    await worker.close();
    await closeBookingExpiryQueue();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Failed to start booking expiry worker");
  process.exit(1);
});
