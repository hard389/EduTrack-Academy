# EduTrack Academy - new-project deployment setup

This source is configured for the separate Firebase project `edutrack-academy`. It does not copy records from the old Firebase project. Keep the old project and its data unchanged.

## 1. Firebase Web app configuration

1. Open Firebase Console > Project settings > General > Your apps.
2. Select the Academy Web app and copy the SDK config.
3. Run `cp .env.example .env.local`.
4. Replace `VITE_FIREBASE_API_KEY` with the exact Web API key from the console. Do not type it from a screenshot. Do not add spaces or quotes around the value.
5. Verify the remaining `VITE_FIREBASE_*` values match the Academy Web app shown in the console. The project ID must be `edutrack-academy`.
6. Stop the running server completely and restart it after editing `.env.local`. In Chrome DevTools > Application, unregister any previous Service Worker and clear site data, then hard-refresh once.

`src/lib/firebase.ts` is now the one shared frontend Firebase initializer. The shared-document page imports the same `db`; it no longer initializes a second Firebase project. Set `VITE_SHARED_DOCUMENT_OWNER_UID` only after the Academy document owner UID is known, or include `ownerUid` in a shared URL.

## 2. Firebase Authentication

- Confirm Authentication > Sign-in method > Email/Password is enabled.
- Confirm `aliupwork243715@gmail.com` exists in Authentication.
- The admin custom claim was assigned separately. Sign out and sign in again to refresh the ID token.
- A Firebase `400` must be diagnosed from DevTools > Network > `accounts:signInWithPassword` > Response. If the response is `API_KEY_INVALID`, re-copy the API key; if it is `EMAIL_NOT_FOUND`, `INVALID_PASSWORD` or `INVALID_LOGIN_CREDENTIALS`, check the account/password; if it is `OPERATION_NOT_ALLOWED`, enable Email/Password.

## 3. Local development: run the full app and API routes

Use the repository-pinned Node.js 22.22.2 runtime first:

```bash
nvm install 22.22.2
nvm use 22.22.2
npm install
cp .env.example .env.local
# Set GOOGLE_APPLICATION_CREDENTIALS in .env.local to the absolute path
# of your Academy Firebase service-account JSON file (when using local ADC).
npm run dev
```

The first `npm run dev` automatically opens the Vercel CLI project-link flow, then downloads the linked project's **Development** settings and starts Vercel Dev on `http://localhost:8080`. Select the existing Academy Vercel project; do not create a different project. Later runs only refresh the Development settings and start the app.

`npm run dev` is the full local workflow because it runs both the Vite frontend and the existing `/api/*` Vercel handlers. `npm run dev:vite` is frontend-only and does not run those API handlers.

For local Firebase data to match the live Academy project, configure these values in the linked Vercel project's **Development** environment (not only Production):

- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, and `VITE_FIREBASE_MESSAGING_SENDER_ID` from the Academy Web app. `VITE_FIREBASE_PROJECT_ID` must be `edutrack-academy`.
- `FIREBASE_PROJECT_ID=edutrack-academy` and either `FIREBASE_SERVICE_ACCOUNT_JSON`, or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS` for server-side Firebase Admin access. A local absolute path can be placed in `.env.local`; the startup script loads non-empty local overrides without committing them.
- Existing R2/WhatsApp variables only when those integrations are needed locally. Keep WhatsApp dispatch flags disabled during ordinary local testing to avoid sending real messages.

The startup script runs `vercel pull --yes --environment=development` before starting the app. The pulled settings are stored under `.vercel/` and that directory is ignored by Git. If the Vercel Development environment has no Firebase values, add them in Vercel Project Settings first. `VITE_USE_FIREBASE_EMULATORS` must be unset or `false` when you intend to read/write the live `edutrack-academy` Firebase project.

If Vercel is not linked yet, sign in and link the existing project manually with `npx vercel@latest login` and `npx vercel@latest link`, then run `npm run dev` again.

## 4. Vercel environment variables

Create a new Vercel project connected to the Academy GitHub repository. Set the variables from `.env.example` in Vercel Project Settings > Environment Variables. Required server-side values include:

- `FIREBASE_PROJECT_ID=edutrack-academy`
- `FIREBASE_SERVICE_ACCOUNT_JSON` for a service account created in the Academy Firebase project, or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
- `EDUTRACK_REGISTRATION_ADMIN_EMAIL=aliupwork243715@gmail.com`
- `EDUTRACK_R2_WORKER_URL` and `R2_API_BASE_URL` to the new Academy R2 Worker URL
- `SUBSCRIPTION_RECEIPT_SECRET` matching the R2 Worker secret
- `PUBLIC_APP_URL` set to the exact new Vercel production origin
- `CRON_SECRET` and `WHATSAPP_QUEUE_WORKER_SECRET` set to newly generated values

Also set all `VITE_FIREBASE_*` and `VITE_R2_API_URL` variables in Vercel for Production, Preview and Development as required. Never put service-account JSON or private keys in `VITE_*` variables or in Git.

## 5. Cloudflare R2

1. Create a new private bucket named `edutrack-academy-library`.
2. From the repository root, deploy the R2 worker using `npx wrangler deploy --config cloudflare/r2-api/wrangler.jsonc`.
3. Set the Worker secret `FIREBASE_API_KEY` to the exact Academy Web API key.
4. Set Worker secret `SUBSCRIPTION_RECEIPT_SECRET` to the same value used by Vercel.
5. Replace `YOUR-ACADEMY-VERCEL-DOMAIN` in `APP_ORIGINS` with the actual Vercel domain and redeploy.
6. Put the actual Worker URL into Vercel `EDUTRACK_R2_WORKER_URL`, `R2_API_BASE_URL`, `R2_PUBLIC_BASE_URL`, and frontend `VITE_R2_API_URL`.

## 6. Cloudflare WhatsApp scheduler

Before deploying `cloudflare/whatsapp-queue-scheduler/wrangler.jsonc`, replace `YOUR-ACADEMY-VERCEL-DOMAIN` with the deployed Vercel production domain. Set the Worker secret `CRON_SECRET` to the same value as Vercel. Deploy with:

```bash
npx wrangler deploy --config cloudflare/whatsapp-queue-scheduler/wrangler.jsonc
```

Keep WhatsApp dispatch disabled until provider credentials, allowed origins and user consent have been checked.

## 7. Automatic Firestore admin workspace

Do not create the `admins/{email}` record manually. After a successful admin sign-in, open Admin Portal > Subscriptions. That page calls `GET /api/admin/subscription-settings`; `server/adminSubscriptionSettings.ts` verifies the Firebase ID token and creates/merges `admins/{email}` using the Admin SDK. The serverless API must be running (Vercel deployment or `vercel dev`) for this to happen.

## 8. Deployment checks

- Verify `src/lib/firebase.ts` resolves to `edutrack-academy` in the browser.
- In DevTools Network, confirm Firebase sign-in succeeds before diagnosing claims.
- Confirm admin ID token contains `admin: true` after signing in again.
- Confirm `GET /api/admin/subscription-settings` returns 200.
- Confirm Firestore creates `admins/aliupwork243715@gmail.com` automatically after that API call.
- Confirm R2 health/config endpoint reports the Academy bucket and project configuration.
- Confirm all data remains empty/new in the Academy project unless intentionally created through the app.
