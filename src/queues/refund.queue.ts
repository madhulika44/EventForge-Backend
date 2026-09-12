import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { createRedisConnection } from "../config/redis";

export const REFUND_QUEUE_NAME = "refund-processing";
export const REFUND_JOB_NAME = "process-refund";

export interface RefundJobData {
  refundId: string;
}

let queue: Queue<RefundJobData> | undefined;
let connection: IORedis | undefined;

export function getRefundQueue(): Queue<RefundJobData> {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue<RefundJobData>(REFUND_QUEUE_NAME, { connection });
  }
  return queue;
}

/**
 * Enqueues a job to process one refund. Unlike booking-expiry's single
 * recurring sweep, this is a per-refund job — but never a per-booking timer
 * living in the API process; it's a durable BullMQ job that survives an API
 * restart and is only ever run by the separate worker process.
 *
 * Using the refund's own id as the BullMQ job id makes enqueuing the "same"
 * refund twice a safe no-op at the queue level (BullMQ de-duplicates by job
 * id within a queue) — one more layer on top of the partial unique DB index
 * and the guarded state transition, not a replacement for either.
 */
export async function enqueueRefundJob(refundId: string): Promise<void> {
  const q = getRefundQueue();
  await q.add(
    REFUND_JOB_NAME,
    { refundId },
    {
      jobId: refundId,
      removeOnComplete: 100,
      removeOnFail: 100,
      // Retries here cover OUR OWN infrastructure hiccups (Redis/DB
      // blips) — a genuine provider-reported failure is recorded as
      // terminal FAILED inside the job itself (see refund.service.ts) and
      // is not something BullMQ should keep retrying automatically; that
      // requires the explicit admin retry endpoint instead.
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

export async function closeRefundQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
}
