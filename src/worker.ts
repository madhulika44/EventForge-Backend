import { createBookingExpiryWorker } from "./workers/booking-expiry.worker";
import { scheduleBookingExpirySweep, closeBookingExpiryQueue } from "./queues/booking-expiry.queue";
import { createRefundWorker } from "./workers/refund.worker";
import { closeRefundQueue } from "./queues/refund.queue";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { logger } from "./config/logger";

// A deliberately separate process from the API server (started via
// `npm run worker`, not by server.ts): the worker's lifecycle — crashes,
// restarts, deploys — shouldn't be entangled with the HTTP API's, and
// production systems typically scale/deploy these independently anyway.
// Both background jobs (booking expiry, refund processing) run in this one
// process for now — they're both lightweight, and this project doesn't yet
// have a reason to scale them independently of each other.
const SWEEP_INTERVAL_MS = 60_000; // re-check for due bookings once a minute

// If in-flight jobs, queue connections, or the DB pool don't close within
// this window, force-exit rather than let a stuck BullMQ/Redis connection
// hang a deploy/restart forever.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  await connectDatabase();

  await scheduleBookingExpirySweep(SWEEP_INTERVAL_MS);
  const expiryWorker = createBookingExpiryWorker();
  const refundWorker = createRefundWorker();

  logger.info(`Booking expiry worker started (sweeping every ${SWEEP_INTERVAL_MS / 1000}s)`);
  logger.info("Refund processing worker started");

  // Same double-signal concern as server.ts: guard against a second
  // SIGINT/SIGTERM re-entering shutdown while the first is still closing
  // workers/queues/the DB connection.
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down workers`);

    const forceExit = setTimeout(() => {
      logger.error(`Graceful shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async () => {
      try {
        await Promise.all([expiryWorker.close(), refundWorker.close()]);
        await Promise.all([closeBookingExpiryQueue(), closeRefundQueue()]);
        await disconnectDatabase();
      } catch (err) {
        logger.error({ err }, "Error while shutting down workers");
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Failed to start workers");
  process.exit(1);
});
