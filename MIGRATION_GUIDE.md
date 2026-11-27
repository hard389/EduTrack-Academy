# EduTrack Academy — Migration, Backup, Apply and Rollback Guide

## Critical status

This patch does **not** bulk-migrate existing production Firestore data. Existing `users/{teacherEmail}` workspaces, embedded class student arrays, attendance documents, monthly fee documents and nested payment receipts are not automatically consolidated. This is deliberate: matching by student names or class names can merge unrelated records and damage financial/attendance history.

A dry-run migration CLI and reconciliation report generator are not included in this patch. The data migration is therefore a manual, owner-approved release gate, not a completed feature.

## 1. Before applying code

1. Keep a full copy of the currently running project and its current Firestore export.
2. Export Firestore data from the Firebase project using the project's approved backup process. Store the export privately; do not include it in a ZIP or upload it to chat.
3. Record Firebase project ID, deployed Functions version, Firestore rules/indexes and current Vercel/Cloudflare deployment versions.
4. Confirm Problem 1 Academy Identity patch is already applied. The Problem 2 patch checks file hashes and refuses a mismatched source.
5. Use a staging Firebase project first. Do not point the local build at production credentials during first validation.

## 2. Runtime and dependency setup

The repository `.nvmrc` and package engine require Node `22.22.2` (range `>=22.22.2 <23`). The authoring environment used Node `22.16.0`, which is below the declared minimum.

```bash
nvm install 22.22.2
nvm use 22.22.2
node --version
npm ci
```

Expected Node output: `v22.22.2`.

## 3. Apply the incremental patch

Extract the patch ZIP:

```bash
cd ~/Downloads
mkdir -p EDUTRACK_PROBLEM2_PATCH
unzip -o EDUTRACK_ACADEMY_PROBLEM2_PATCH.zip -d EDUTRACK_PROBLEM2_PATCH
```

Enter the existing Problem 1 project folder (folder name may differ; use the real location):

```bash
cd ~/Downloads/EDUTRACK_ACADEMY_CONFIGURED_SOURCE
```

Apply:

```bash
bash ~/Downloads/EDUTRACK_PROBLEM2_PATCH/EDUTRACK_ACADEMY_PROBLEM2_PATCH/APPLY_PATCH.sh "$PWD"
```

The script verifies base SHA-256 values, creates a timestamped backup under `.patch-backups/`, applies add/modify/delete actions and verifies the resulting file hashes. It does not run a Firebase deployment or data migration.

## 4. Validate locally

```bash
npm run typecheck
npm run lint
npm run build
node --test tests/*.test.mjs
npm run test:rules
```

Some tests require Firebase Emulator and optional dependencies. Do not disable or skip failing security tests to obtain a green result. Record actual output.

## 5. Firebase staging configuration

Review before deploying:

- `firestore.rules`
- `firestore.indexes.json`
- `firebase.json`
- Vercel API routes and server-side Firebase Admin initialization
- Firebase Auth email verification settings and allowed domains
- Required server environment variable names from current deployment docs

Never put Firebase Admin service-account JSON, private keys or secrets in the frontend bundle or patch ZIP.

## 6. Data migration plan — NOT INCLUDED / MUST BE APPROVED SEPARATELY

Before any production cutover, a dedicated migration utility must be built and validated with these steps:

1. Dry-run inventory of each teacher workspace and source document ID.
2. Show class, subject, embedded student, attendance, monthly fee, payment/receipt and quiz/report resource counts.
3. Detect duplicate candidates but do not auto-merge siblings or similar names. Require an explicit stable identity/owner mapping.
4. Generate stable source-to-target ID maps.
5. Preserve original fee amounts, dates, receipt IDs and historical invoice snapshots.
6. Produce before/after count and financial reconciliation reports.
7. Require explicit `--apply` after review and a verified backup.
8. Make writes idempotent and record each migrated source ID.
9. Keep legacy source records intact until reconciliation is approved.
10. Roll back by restoring from the recorded export/migration map; never delete historical source records during initial migration.

No production migration should be run from this Problem 2 code ZIP alone.

## 7. Rollback code patch

The apply script prints the exact timestamped backup path. Use it with:

```bash
bash ~/Downloads/EDUTRACK_PROBLEM2_PATCH/EDUTRACK_ACADEMY_PROBLEM2_PATCH/ROLLBACK_PATCH.sh "$PWD"
```

Or specify the backup directory as the second argument:

```bash
bash ROLLBACK_PATCH.sh "$PWD" "$PWD/.patch-backups/academy-management-problem2-YYYYMMDD_HHMMSS"
```

Rollback restores files that existed before the patch and removes files newly added by this patch. It does not reverse any Firebase/Firestore deployment or database writes.

## 8. Production release gate

Do not deploy until:

- Typecheck, lint and production build pass on Node 22.22.2.
- Firebase Emulator rules tests and API authorization tests pass.
- Teacher Portal before/after screenshots are compared at the same viewport/theme/data state.
- The full acceptance scenario in `ACADEMY_REQUIREMENTS_MAPPING.md` is executed in staging.
- Student, attendance, invoice and payment migration has been separately reconciled and approved.
- Quiz/Notes/Reports owner locks, substitute attendance, staff attendance and attachment workflows are finished or explicitly descoped.
