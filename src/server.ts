import { createApp } from "./app";
import { env } from "./config/env";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { logger } from "./config/logger";

// If graceful shutdown (draining in-flight requests, closing the DB pool)
// hasn't finished by this point, force-exit rather than hang the process
// forever — a stuck connection or a slow client should never block a
// deploy/restart indefinitely.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`EventForge backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  // SIGTERM/SIGINT can each fire more than once (e.g. an impatient operator
  // hitting Ctrl+C twice, or process managers that send both) — without this
  // guard, a second signal would re-run server.close()/disconnectDatabase()
  // concurrently with the first shutdown already in progress.
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);

    const forceExit = setTimeout(() => {
      logger.error(`Graceful shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((err) => {
      if (err) {
        logger.error({ err }, "Error while closing HTTP server");
      }
      disconnectDatabase()
        .catch((disconnectErr) => {
          logger.error({ err: disconnectErr }, "Error while disconnecting database during shutdown");
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
