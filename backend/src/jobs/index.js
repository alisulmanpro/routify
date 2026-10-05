import { sweepSubscriptions } from '../services/subscription.service.js';
import { logger } from '../utils/logger.js';

const HOUR = 3_600_000;

export function startJobs() {
  const run = async () => {
    try {
      const n = await sweepSubscriptions();
      if (n) logger.info({ expired: n }, 'Expired lapsed subscriptions');
    } catch (error) {
      logger.error({ err: error }, 'Subscription sweep failed');
    }
  };
  run();
  const timer = setInterval(run, HOUR);
  timer.unref();
  return () => clearInterval(timer);
}
