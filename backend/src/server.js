import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { createApp } from './app.js';
import { ensureDefaultPlans } from './services/subscription.service.js';
import { startJobs } from './jobs/index.js';
import { logger } from './utils/logger.js';

async function boot() {
  await connectDatabase(env.MONGODB_URI);
  await ensureDefaultPlans();
  const stopJobs = startJobs();
  const server = createApp().listen(env.PORT, () => logger.info(`Delivery Planner API listening on :${env.PORT} (${env.NODE_ENV})`));

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    server.close(async () => { await disconnectDatabase(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled rejection'));

boot().catch((error) => {
  logger.error({ err: error }, 'Failed to start');
  process.exit(1);
});
