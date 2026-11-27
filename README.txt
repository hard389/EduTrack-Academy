EduTrack Academy WhatsApp Scheduler - Cron limit patch

Replace these two files in the local project:
  cloudflare/whatsapp-queue-scheduler/wrangler.jsonc
  cloudflare/whatsapp-queue-scheduler/index.mjs

This keeps the Academy scheduler as a separate Worker but uses one five-minute
Cron Trigger to dispatch all four jobs. It is designed for the Cloudflare Free
account limit when the old scheduler already consumes four triggers.

The single trigger dispatches:
- queue worker every 5 minutes
- subscription projection at minute 15 of every UTC hour
- failed-job cleanup daily at 22:00 UTC (03:00 Pakistan time)
- fee alerts daily at 04:00 UTC (09:00 Pakistan time)

Do not remove or edit the old Worker. Confirm that the old Worker actually has
four Cron Triggers and that no other Worker is using the fifth slot before deploy.
The Cloudflare Cron Trigger quota is account-wide.

Security: rotate CRON_SECRET because the previously generated value was exposed.
Use the same fresh value in the Vercel Production environment variable CRON_SECRET
and the Academy Worker secret CRON_SECRET. Redeploy Vercel after changing its env.

Deploy after replacing both files:
  npx wrangler deploy --config cloudflare/whatsapp-queue-scheduler/wrangler.jsonc

Set the new Worker secret (enter the same fresh value):
  npx wrangler secret put CRON_SECRET --config cloudflare/whatsapp-queue-scheduler/wrangler.jsonc
