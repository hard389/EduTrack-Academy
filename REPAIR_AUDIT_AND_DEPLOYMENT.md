# EduTrack Academy repair patch — 26 November 2026

## Scope of this patch

This patch targets confirmed issues in the supplied archive and browser screenshots. It does not redesign the application UI.

### 1. Academy Admin Students page crash

- Browser console showed `ReferenceError: Users is not defined` while rendering `/academy-admin/students`.
- `src/pages/academy-admin/AcademyStudentsPage.tsx` rendered the Lucide `Users` icon without importing it.
- Added `Users` to the existing `lucide-react` import. No JSX layout, styling, or form workflow was changed for this fix.

### 2. UID-keyed Academy membership compatibility

- Membership documents are addressed by Firebase Auth UID at `academyMemberships/{uid}`.
- Existing membership records can legitimately omit a duplicate `uid` property because the document ID is already the UID.
- Several trusted backend readers incorrectly required `mapping.uid` to exist. They now reject a duplicate UID only when it is present and does not match the document UID.
- New Academy Admin and teacher membership writes continue to include the `uid` property for consistency going forward.
- The TypeScript Functions source and the deployable `src/functions/lib` JavaScript were both updated. The current `firebase.json` also rebuilds Functions during deployment.

### 3. Teacher workspace projection reconciliation

- Added `syncAcademyTeacherMembershipToTeacherPortal`, a Firestore document-written trigger on `academies/{academyId}/members/{memberUid}`.
- When a teacher membership becomes active and email-verified, or permissions are updated while active, the trigger rebuilds that teacher's bounded, active assigned-class projections from canonical Academy records.
- Rebuild is capped at 500 assignment documents. If the cap is reached, it records an integration issue rather than publishing a partial roster.
- The function is exported from `src/functions/src/index.ts` and the deployable Functions entry point.
- Existing legacy projections are not bulk-migrated by this patch. Missing projections for active assignments can be rebuilt by the membership trigger or by the existing assignment/class/student triggers.

### 4. Firestore and Storage authorization

- The authoritative model in this archive is Academy membership plus boolean permission grants under `academies/{academyId}/members/{uid}.permissions`.
- `firestore.rules` remains tenant-scoped and server-owned Academy canonical data is not made writable by browser users.
- Teacher class projections under `users/{teacherEmail}/classes/{classId}` are readable only by the matching active teacher with at least one relevant module permission. The class projection update remains limited to the existing student-array editing path and its explicit permission check.
- `storage.rules` now checks the UID-keyed mapping's active state, verified-email state, and normalized email match as well as the Academy member document.
- The old subscription-entitlement Firestore rules supplied separately do not match the current Academy permission model in this archive. Do not deploy those old rules over this archive's `firestore.rules`; `firebase.json` points to the rules file shipped in this project.
- `tests/firestore.rules.test.mjs` was aligned to the current Academy boolean permission model and includes a legacy UID-keyed mapping fixture without a duplicate `uid` field.

## Checks performed in the patch environment

- 30 focused Node.js domain/regression tests passed across Academy identity, Academy management, class roll allocation, module permissions, and the new repair tests.
- The deployable Functions JavaScript was regenerated from the patched TypeScript source for `academyPortalSync`, `subscriptionEntitlements`, and `index`.
- The generated Functions JavaScript and test source files were syntax-checked separately during packaging.

## Checks not performed / release gate

The supplied runtime did not contain root or Functions `node_modules`, did not contain the Firebase CLI, and was running Node.js 22.16.0 while `.nvmrc` pins Node.js 22.22.2. Therefore these items are **not certified by this patch run**:

- Full TypeScript type-check and Vite production build.
- Firebase Emulator execution of `tests/firestore.rules.test.mjs`.
- Deployment of Firestore Rules, Storage Rules, or Cloud Functions to the live `edutrack-academy` project.
- Vercel browser E2E tests, visual regression, and real tenant-record synchronization.

The project's existing `ACADEMY_REQUIREMENTS_MAPPING.md` also explicitly marks multiple requirements as partial or not implemented, including staff attendance, substitute sessions, complete refund/void handling, expense attachments/categories, ownership transfer locks, and legacy-data migration. Accordingly, this patch must not be described as proving 100% requirement completion or zero remaining bugs.

## Recommended validation and deployment sequence

Run these commands from the repository root on a machine with access to the project's Firebase and Vercel accounts:

```bash
nvm install 22.22.2
nvm use 22.22.2
npm ci
npm --prefix src/functions ci
npm run typecheck
npm run build
npx firebase-tools emulators:exec --only firestore "node --test tests/firestore.rules.test.mjs"
```

Only after the checks above pass, deploy the matching rules and functions:

```bash
npx firebase-tools use edutrack-academy
npx firebase-tools deploy --only firestore:rules,storage
npx firebase-tools deploy --only functions
```

Then deploy the patched frontend through the connected Vercel workflow and run the live acceptance checks below.

## Live acceptance checklist

1. Sign in as the Academy Admin and open `/academy-admin/students`. Confirm no `Users is not defined` console exception occurs.
2. Confirm classes and subjects load from the intended Academy ID, and create one test student with one assigned subject.
3. Confirm the canonical student and enrollment records appear under that Academy, and the student's row appears in the assigned teacher's class projection.
4. Sign in as that teacher. Confirm only assigned class/student data is visible and module permissions are respected.
5. Change a teacher permission or reactivate a previously pending teacher. Confirm the membership trigger rebuilds the assigned class projection.
6. Test teacher-originated roster, attendance, quiz, report, and notification synchronization only for the workflows actually enabled in the requirements matrix; verify each canonical target record and any integration issue record.
7. Review Firebase Functions logs and Firestore `integrationIssues` for bounded-query or synchronization errors.

Do not run a historical-data migration or overwrite production records as part of this patch without a backup and an approved dry-run.
