import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { createRedisConnection } from "../config/redis";

export const BOOKING_EXPIRY_QUEUE_NAME = "booking-expiry";
export const BOOKING_EXPIRY_JOB_NAME = "sweep";
const SCHEDULER_ID = "booking-expiry-sweep";

let queue: Queue | undefined;
let connection: IORedis | undefined;

export function getBookingExpiryQueue(): Queue {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue(BOOKING_EXPIRY_QUEUE_NAME, { connection });
  }
  return queue;
}

/**
 * Schedules the recurring "sweep for due bookings" job. Uses BullMQ's job
 * scheduler (not a per-booking delayed job — see the Phase 6 report for
 * why): one lightweight repeating job that, each time it runs, asks the
 * database which PENDING bookings are actually due and expires them.
 *
 * Idempotent: upserting the same scheduler id on every worker startup
 * replaces any existing schedule rather than creating a duplicate, so
 * restarting the worker (or running multiple worker instances) never
 * results in overlapping/duplicate recurring schedules.
 */
export async function scheduleBookingExpirySweep(everyMs: number): Promise<void> {
  const q = getBookingExpiryQueue();
  await q.upsertJobScheduler(
    SCHEDULER_ID,
    { every: everyMs },
    {
      name: BOOKING_EXPIRY_JOB_NAME,
      opts: {
        removeOnComplete: 100,
        removeOnFail: 100,
        // A transient DB/Redis hiccup shouldn't silently skip a sweep —
        // retry with backoff before giving up on that run (the next
        // scheduled sweep will still pick up anything missed regardless).
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    },
  );
}

export async function closeBookingExpiryQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
}
