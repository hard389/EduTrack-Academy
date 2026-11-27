import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { refreshDueSubscriptionProjections } from './subscriptionProjectionRefresh.js';

export const refreshSubscriptionProjections = onSchedule({
  schedule: 'every 1 minutes',
  region: 'us-central1',
  timeoutSeconds: 540,
  memory: '512MiB',
}, async () => {
  try {
    await refreshDueSubscriptionProjections();
  } catch (error) {
    logger.error('Scheduled subscription projection refresh failed', error);
    throw error;
  }
});
