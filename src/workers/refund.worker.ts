import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../config/redis";
import { REFUND_QUEUE_NAME, type RefundJobData } from "../queues/refund.queue";
import { processRefund } from "../services/refund.service";
import { logger } from "../config/logger";

/**
 * Processes one refund per job. processRefund itself is fully idempotent —
 * safe against duplicate BullMQ delivery, worker restarts, and job retries
 * (see its own doc comment) — so this worker doesn't need any additional
 * de-duplication logic beyond what the job id (set in refund.queue.ts) and
 * the guarded DB transitions already provide.
 */
export function createRefundWorker(): Worker {
  const worker = new Worker(
    REFUND_QUEUE_NAME,
    async (job: Job<RefundJobData>) => {
      await processRefund(job.data.refundId);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5, // refunds are independent of each other; no reason to serialize
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Refund job failed — BullMQ will retry per its backoff policy");
  });

  return worker;
}
