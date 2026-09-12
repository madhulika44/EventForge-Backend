import IORedis from "ioredis";
import { env } from "./env";

/** Only the worker process (src/worker.ts) ever calls this — the API
 * server and the test suite never touch Redis. `maxRetriesPerRequest: null`
 * is required by BullMQ for its blocking connections. */
export function createRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
