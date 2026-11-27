# EduTrack Spark Plan Scheduler Bridge

This change moves **only two scheduled workloads** out of Firebase Cloud Functions and into the existing Vercel + Cloudflare scheduler architecture:

- Subscription entitlement projection refresh: every minute.
- Expired WhatsApp failure-payload cleanup: every five minutes.

The existing minute queue-worker schedule and hourly Fee Alerts schedule remain in place. The new Vercel routes reuse the existing `CRON_SECRET` and the same Firebase Admin Firestore app used by the other Vercel API handlers. No Firebase Blaze upgrade or new Firebase Cloud Functions deployment is needed.

## Important Spark limitation

Firebase's official pricing documentation says Spark projects cannot deploy new or updated Cloud Functions. This bridge therefore runs the same server-side Firestore work inside the existing Vercel Node.js API runtime, invoked by the existing Cloudflare Worker Cron Triggers. Firestore itself still uses the project's Spark quotas; moving compute does not increase Firestore quotas.

## Safety preflight — do this before enabling the new Cloudflare schedule

A previous version of these scheduled functions may already have been deployed while the project was on Blaze. The failed deployment attempt in this session does not establish whether older deployed functions exist or continue to execute.

Run this read-only command:

```bash
firebase functions:list --project edutrack-academy
```

If `refreshSubscriptionProjections` or `cleanupExpiredWhatsAppFailedJobsSchedule` are listed, inspect their last execution in Firebase/Google Cloud logs before enabling the new Cloudflare triggers. Do **not** enable the new schedule while an old copy is still running, otherwise the same jobs may execute twice. Firebase documentation confirms that Spark blocks new deployments; it does not clearly state in the pricing page whether every pre-existing deployment is immediately stopped after downgrade, so verify your project rather than assume.

## Required environment configuration

The existing Vercel and Cloudflare `CRON_SECRET` values must match exactly. The current queue worker and Fee Alerts endpoints already use this shared secret, so do not print it, commit it, or put it into source code.

Vercel must retain its existing Firebase Admin service-account environment variables (`FIREBASE_PROJECT_ID` plus either `FIREBASE_SERVICE_ACCOUNT_JSON` or the existing client-email/private-key variables). The new endpoints use `getFirebaseAdminFirestore()` and do not use Firebase Functions.

The WhatsApp API function max duration is set to 300 seconds. This assumes Vercel Fluid Compute is enabled; Vercel's current Hobby maximum is 300 seconds with Fluid Compute. Verify **Project Settings → Functions → Fluid Compute** before deploying. If it is disabled and Vercel rejects the setting, enable Fluid Compute or ask before reducing task batch behaviour.

## Apply

1. Save `EDUTRACK_SPARK_PLAN_SCHEDULER_BRIDGE.patch` into `~/Downloads/`.
2. Run `bash ~/Downloads/APPLY_EDUTRACK_SPARK_BRIDGE.sh`.
3. Run the local verification commands below.
4. Review and commit/push to GitHub. Vercel should deploy the new authenticated API routes.
5. Verify both new endpoints return `401` without the cron secret (do not send/print the secret in a test command), and that existing endpoints continue to work.
6. Complete the safety preflight above.
7. Update/deploy the existing Cloudflare Worker. Add the third Cron Trigger `*/5 * * * *`; retain `* * * * *` and `0 * * * *`.

## Cloudflare Free plan capacity

The current Worker uses two cron patterns; this bridge uses three. Cloudflare documents up to five Cron Triggers per Free account and 100,000 Worker requests/day. Check the total trigger count across the whole Cloudflare account (not just this Worker) before adding the third trigger.

The schedule creates approximately 1,440 subscription-projection API calls/day and 288 cleanup API calls/day, in addition to the existing 1,440 queue-worker calls/day and 24 hourly Fee Alerts calls/day. These are estimates from the cron frequencies, not measured usage. Vercel usage and its plan limits remain separate from Firebase's Spark limits.

## Local verification

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 22.22.2

npm run typecheck
npm run lint
npm run build

node --test \
  tests/cloudflare-scheduler-cron-split.test.mjs \
  tests/spark-scheduled-jobs-bridge.test.mjs \
  tests/firestore-no-op-workload-guards.test.mjs \
  tests/firestore-read-quota-guards.test.mjs
```

Do not run `firebase deploy --only functions`. That is the operation blocked on Spark. Firestore indexes from the earlier optimization patch should already be deployed; confirm they show **Enabled** in the Firebase console.

## Files changed by this bridge

- `server/subscriptionProjectionRefresh.ts` — Vercel-compatible execution of the existing due-projection logic, accepting the configured Admin Firestore instance.
- `server/whatsappFailedJobCleanup.ts` — Vercel-compatible execution of the existing expired-job cleanup logic.
- `api-handlers/whatsapp/*-cron.ts` and `server/whatsappApiRouter.ts` — authenticated API routes.
- `cloudflare/whatsapp-queue-scheduler/*` — minute and five-minute route dispatch.
- `src/functions/src/index.ts` — stops exporting the two Firebase scheduled wrappers, avoiding future duplicate scheduler deployment from the Functions barrel. Other Functions exports remain.
- `vercel.json` — increases the existing WhatsApp API function duration to 300 seconds for Fluid Compute.
- Tests for the new routing and schedule mapping.
