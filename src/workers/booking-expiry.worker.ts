import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../config/redis";
import { BOOKING_EXPIRY_QUEUE_NAME } from "../queues/booking-expiry.queue";
import { expireDueBookings } from "../services/booking.service";
import { logger } from "../config/logger";

/**
 * Each job run re-asks the database "which PENDING bookings are due right
 * now" rather than carrying a specific booking id — there's no per-booking
 * job at all (a permanent timer per booking, which this phase was
 * explicitly told to avoid, doesn't scale and doesn't survive a worker
 * restart). This design does: a crashed worker just means the next
 * scheduled sweep (or, worst case, a lazy check on the API side) picks up
 * whatever's overdue. Every transition inside expireDueBookings is guarded
 * (transitionBookingIfInState), so running this job twice, concurrently,
 * or after a retry is always safe — it only ever acts on bookings still
 * actually PENDING at the moment of its own transaction.
 */
export function createBookingExpiryWorker(): Worker {
  const worker = new Worker(
    BOOKING_EXPIRY_QUEUE_NAME,
    async (job: Job) => {
      const { expiredCount, checkedCount } = await expireDueBookings();
      if (expiredCount > 0) {
        logger.info({ jobId: job.id, expiredCount, checkedCount }, "Booking expiry sweep expired bookings");
      }
      return { expiredCount, checkedCount };
    },
    {
      connection: createRedisConnection(),
      concurrency: 1, // one sweep at a time is enough; avoids redundant overlapping scans
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Booking expiry job failed — BullMQ will retry per its backoff policy");
  });

  return worker;
}
