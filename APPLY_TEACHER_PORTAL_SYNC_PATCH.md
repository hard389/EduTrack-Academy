# Apply and Deploy — Academy ↔ Teacher Portal Sync Patch

This ZIP is a patched copy of the supplied EduTrack project. Apply it to a backup/staging copy first. Do not overwrite the currently deployed application before the release checks pass.

## 1. Back up and extract

1. Keep an untouched copy of the currently working source ZIP/repository.
2. Extract `Academy_EduTrack_TeacherPortal_Sync_PATCHED.zip` into a new folder.
3. Do not copy any old `node_modules`, `dist`, `.vercel`, service-account JSON, `.env.local` or private key from an old environment into the patched folder.
4. Open a terminal in the extracted project root — the folder containing `package.json`, `firebase.json` and `vercel.json`.

The repository configuration names `edutrack-academy` as its default Firebase project. Confirm this is the exact project you intend to update before deploying.

## 2. Use the required Node runtime

This project pins Node.js `22.22.2` in `.nvmrc` and declares a compatible Node 22 range. Use:

```bash
nvm install 22.22.2
nvm use 22.22.2
node -v
npm -v
```

Confirm `node -v` prints `v22.22.2` before installing or building.

## 3. Clean install and build

Run from the project root:

```bash
npm ci
npm --prefix src/functions ci
npm run typecheck
npm run build
npm run lint
```

Then run the relevant existing tests:

```bash
npm run test:entitlements
npm run test:student-import
node --test tests/academy-core-module-access.test.mjs
```

Do not deploy if any install, typecheck, lint or test command fails. Resolve the actual compiler/test error first; do not bypass it with `--force` or by deleting lockfiles.

## 4. Verify Firestore rules in the Emulator

Install or use the Firebase CLI, authenticate, and start the Firestore rules test:

```bash
npx firebase-tools --version
npx firebase-tools emulators:exec --project edutrack-academy --only firestore "node --test tests/firestore.rules.test.mjs"
```

The machine must have a supported Java runtime for the Firestore Emulator. Confirm the tests include both allowed and denied cases for each teacher permission, cross-teacher roster isolation, Academy-origin quiz protection and Academy-origin alert read-only behavior.

## 5. Confirm Firebase project and credentials

```bash
npx firebase-tools login
npx firebase-tools projects:list
npx firebase-tools use edutrack-academy
npx firebase-tools use
```

Check the Firebase Console project ID is exactly `edutrack-academy`. The Cloud Functions use the Firebase Admin SDK. Vercel API routes also need the Academy service-account environment configured in Vercel (or the existing approved secret mechanism described in `ACADEMY_DEPLOYMENT_SETUP.md`). Never put service-account JSON/private keys in `VITE_*` variables or commit them to Git.

The existing setup guide also describes the required `VITE_FIREBASE_*`, `FIREBASE_PROJECT_ID`, service-account and Vercel environment settings. Keep those values aligned with the same Academy Firebase project.

## 6. Deploy Firestore rules, indexes and Cloud Functions

Only after steps 2–5 pass and the target project has been verified:

```bash
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions --project edutrack-academy
```

The `firebase.json` predeploy hook builds `src/functions` before deploying. Confirm the 11 `sync*` Cloud Functions appear in Firebase Console > Functions after deployment, and check Cloud Logging for trigger errors.

## 7. Deploy the web application

The repository contains `vercel.json`. Link the extracted project to the intended Vercel project and verify the project/domain before production deployment:

```bash
npx vercel login
npx vercel link
npx vercel env ls
npx vercel --prod
```

Do not blindly deploy to a previously linked Vercel project. Confirm its Firebase service-account secrets and public `VITE_FIREBASE_*` configuration point to the same Academy project.

## 8. Staging acceptance scenario

Use test-only records in a staging Academy. Do not experiment with real students.

1. Create Class 11.
2. Assign Chemistry to Teacher A and Physics to Teacher B.
3. Enrol Ali in Chemistry and Physics; enrol Ahmed in Chemistry only.
4. Confirm Teacher A sees Ali and Ahmed in the existing Classes/Students screen.
5. Confirm Teacher B sees Ali only.
6. Add one student through Admin and confirm both affected teacher rosters update without changing the Teacher Portal layout.
7. Record attendance as Teacher A and confirm one canonical `studentAttendance` record is created with Chemistry subject ID.
8. Create a quiz as Teacher A and verify the canonical Academy quiz plus the assigned Teacher workspace projection. Repeat for an Admin-created quiz.
9. Save a teacher report and a teacher alert; verify canonical `studentReports` and `teacherNotifications` records.
10. Publish an Admin class/subject alert and confirm only the targeted teacher workspace receives it.
11. Revoke one permission in Admin. Confirm the route is hidden/blocked and the corresponding Firestore/API operation is denied, not merely hidden in navigation.
12. Review `academies/{academyId}/integrationIssues` for invalid/ambiguous sync records.

If a teacher is assigned multiple subjects in the same class, attendance/quiz synchronization is deliberately paused until the legacy Teacher Portal screen has a subject context. The current patch does not add a subject selector because the stated requirement is to preserve the existing UI.

## 9. Historical data and rollback

This patch does not bulk migrate historical teacher attendance, quizzes or reports. New writes/updates flow through the new triggers after Functions deployment. Before backfilling existing documents, prepare and review a dry-run migration with a mapping of teacher UID, class ID, subject ID, student ID and Academy ID. Keep an export/backup and do not guess missing mappings.

For rollback, redeploy the previous known-good web build and previous Firestore rules/Functions versions from your release process. Keep the new canonical records and integration issues for investigation; do not delete them as a rollback shortcut.

## 10. Go-live release gate

The code patch is ready for a staging deployment attempt, not certified for production based only on the focused checks performed during preparation. Release only after the correct Node build, full tests, Firestore Emulator rules tests, Vercel deployment checks and the staging scenario above all pass. Also review every remaining `Partial`/`Not implemented` item in `ACADEMY_REQUIREMENTS_MAPPING.md`; this synchronization patch does not finish unrelated finance, staff, note ownership, substitute-session or other application requirements.
