# EduTrack – Final Source Review and Local Verification

**Review date:** 27 November 2026  
**Source basis:** `Academy_EduTrack_COMPLETE_REVIEW_20261127_114334.zip` supplied in this conversation.  
**Important:** The separate older `firestore.rules` text shared earlier is not the authoritative Rules file for this source archive. This package keeps the Academy-membership Rules shipped with this source and does not copy the old subscription-entitlement Rules over it.

## Intended access model

Teacher Portal access is granted by the Academy Admin through the active, email-verified Academy membership and its boolean `permissions` map. Teacher pages and teacher APIs must not require a teacher subscription, teacher add-on, payment proof, or a subscription entitlement projection.

The Platform/SaaS Super Admin subscription and billing tools under `/admin/*` remain separate. Historical subscription documents can remain as metadata, but they do not authorize or deny Teacher Portal features. See `SUBSCRIPTION_REMOVAL_AUDIT.md`.

## Changes included in this delivery

1. **Firestore authorization evaluation:** `hasAcademyPermission`, `hasAnyAcademyPermission`, and `hasAllAcademyPermissions3` validate the teacher profile, UID-keyed Academy mapping, active Academy, active membership, verified email claims, and requested boolean permission without calling the whole workspace validator repeatedly.
2. **Rules language limits:** all Firestore Rules functions are kept within the documented maximum of ten `let` bindings. A regression test now checks this limit.
3. **Fail-closed permission mapping:** legacy feature names map to explicit Academy Admin permission keys. Unknown feature names do not grant access.
4. **Teacher assignment integrity:** class creation aggregates all class/subject assignments for a teacher before updating the membership document, so one subject update does not overwrite the other subject IDs.
5. **Teacher subscription removal:** Teacher Portal routes, API access and feature checks use Academy permissions. The platform-level subscription admin remains isolated.
6. **Teacher-facing messaging:** permission failures for monthly reports, quizzes and announcements now refer to Academy Admin grants rather than teacher subscription status.
7. **Student import template:** the workbook wording describes Academy permissions rather than subscription-based feature availability.
8. **Regression tests:** test contracts were updated to match the current Rules implementation and to cover the subscription-free Teacher Portal access contract, notification wording and Rules function binding limit.

## Checks performed for this package

- **115 targeted Node.js regression tests passed; 0 failed.** These are the 21 files invoked by `npm run test:academy-access`.
- `node --check` passed for the edited `.mjs`/`.js` test and generated JavaScript files during the review.
- A static scan confirmed there is no teacher `activeSubscriptionProjection` / `subscriptionEntitlements/current` dependency in the authoritative Firestore Rules file.
- A static check confirmed every Firestore Rules function is within the ten-`let` binding limit.

Run the focused suite with:

```bash
source ~/.nvm/nvm.sh
nvm use 22.22.2
npm run test:academy-access
```

## Checks NOT certified in this environment

The following are **not** represented as passed:

- Full dependency installation, because the review container runs Node `22.16.0` rather than the repository-pinned `22.22.2`; the attempted `npm ci` exceeded the available execution window.
- `npm run typecheck` (including the Firebase Functions build).
- Vite production build (`npm run build`).
- Full Firestore Emulator execution of `tests/firestore.rules.test.mjs` after the final Rules helper refactor. Earlier local runs from the user's machine encountered Firestore Emulator write lock timeouts on `settings/trigger_alerts`; the latest helper refactor must be re-run on the user's Node `22.22.2` environment with the Vercel dev server stopped so the emulator can use port `8080`.
- Live Firebase Rules/Storage Rules/Cloud Functions deployment, Vercel deployment, or real-data browser acceptance.
- The Firebase Authentication user's actual `emailVerified` property. The supplied Authentication screenshot showed the user list, not the selected user's detail record. The Firestore `emailVerified` field is not proof of the Firebase Auth token's `email_verified` claim.

Therefore this is a **tested source delivery**, not a claim of 100% production certification or zero remaining bugs.

## Local validation sequence

Use Node.js `22.22.2` as specified by `.nvmrc`:

```bash
source ~/.nvm/nvm.sh
nvm use 22.22.2
node -v
npm -v

npm ci
npm --prefix src/functions ci
npm run test:academy-access
npm run typecheck
npm run build
```

Then stop the local Vercel/Vite app with `Ctrl+C` before starting the Firestore Emulator, because `firebase.json` configures the Firestore Emulator on port `8080`:

```bash
npx firebase-tools emulators:exec \
  --project demo-edutrack \
  --only firestore \
  "node --test tests/firestore.rules.test.mjs"
```

The full Rules suite should finish with `# fail 0`. If `settings/trigger_alerts` again produces a lock timeout, capture the test's final summary and `tail -n 150 firestore-debug.log`; do not deploy Rules while the test is unresolved.

## Production deployment gate

Only after dependency install, Functions build, typecheck, Vite build, and Firestore Emulator tests all pass, verify the selected Firebase project and deploy the matching Rules/Storage files and Functions:

```bash
npx firebase-tools use edutrack-academy
npx firebase-tools deploy --only firestore:rules,storage
npx firebase-tools deploy --only functions
```

Deploy the frontend through the already-linked Vercel project only after its build and smoke tests pass. Do not deploy the old subscription-entitlement Rules text supplied separately in the chat.

## Live Teacher Portal acceptance checks

1. Open Firebase Authentication and select the teacher account. Confirm the actual **Email verified** field is true; then sign out and sign in again to refresh the ID token.
2. Confirm `academyMemberships/{uid}`, `academies/{academyId}`, and `academies/{academyId}/members/{uid}` are active and match the same UID, email and Academy ID.
3. Confirm the member `permissions` map contains the exact grants required for the modules being tested.
4. Confirm the teacher's `users/{email}/classes/{classId}` projection is present and includes both assigned subject IDs.
5. Sign into the Teacher Portal and verify Dashboard, Classes, Students, Attendance, Fees, Reports and Settings according to the granted permissions.
6. Review browser Console and Firebase Functions logs. Do not treat a populated Firestore document as proof that the browser's Auth token and deployed Rules are correct.
