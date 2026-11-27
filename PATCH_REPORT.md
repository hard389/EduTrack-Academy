# EduTrack Academy — Problem 2 / V2 Patch Report

## Scope

This patch is an incremental update over the Problem 1 Academy Identity patch. It introduces the first implementation layer for a permission-driven Academy Management System while preserving the existing Teacher Portal page styling and keeping the platform/SaaS Super Admin portal separate.

## Implemented in this patch

- A separate `/academy-admin/*` route group and layout, with API-backed pages for overview, teachers/permissions, classes/subjects, students, fees, expenses and read-only reports.
- A typed Academy permission manifest and membership-based access resolution for teacher feature access. Teacher defaults are least-privilege (false unless explicitly granted).
- Existing Teacher Portal navigation and Quick Access are filtered by the current permission data without an intended visual redesign; existing teacher page components are reused.
- Teacher-facing Subscription page is removed, its route redirects to `/dashboard`, and teacher subscription purchase/proof/add-on/registration handlers are removed from the active teacher API surface.
- Academy management endpoints for class/subject setup, per-subject teacher assignments, canonical student creation/enrolments, consolidated invoice generation, central payment collection and Academy Expenses.
- A single canonical student profile can have multiple class/subject enrolments. Admin admission derives teachers from configured subject assignments.
- Fee invoices store subject line-item snapshots. Payments use a Firestore transaction, collector identity, idempotency key and overpayment guard.
- Expense records support draft creation, posting/editing draft and reasoned voiding through the backend, with audit metadata.
- Firestore rules and legacy API compatibility checks are changed to require verified active Academy membership and permission grants for teacher feature access.
- Existing `/admin/*` Platform/SaaS Super Admin authorization continues to use the existing platform `admin === true` custom claim.
- Tests were updated for the new permission/subscription-retirement contract and new Academy domain tests were added.

## Important partial implementations / limitations

The uploaded V2 prompt describes a broader production system than this patch can safely complete without the project dependency install, Firebase emulator, production-like data and browser visual-regression environment. The following are **not complete**:

1. Existing legacy teacher class documents still receive compatibility projections. They are not yet a fully read-only, in-memory adapter. Some existing teacher edit/delete paths still write legacy embedded student arrays.
2. Existing Teacher Fees page uses the central ledger for canonical student records, but legacy records can still follow the old fee path. Full historical fee migration and reconciliation are not implemented.
3. Existing attendance recording remains on the old teacher workspace path. New Academy Admin reporting reads Academy attendance collections, but a complete attendance repository cutover is not implemented. Admin attendance is read-only in the new portal.
4. Quiz, Notes/Library and Reports have not all been migrated to canonical Academy repositories and owner-lock/ownership-transfer controls are not implemented.
5. Temporary substitute-session authorization and staff attendance workflow are not implemented.
6. Expense attachment upload/storage lifecycle, configurable expense categories, detailed expense exports and full dashboard date-range/pagination flows are not complete.
7. No production-data dry-run migration, automatic migration, reconciliation or rollback utility is included. Existing user workspaces are not bulk-moved or deleted.
8. No browser screenshot comparison was run; the visual-lock document records this limitation.
9. Firebase Emulator rules tests, full TypeScript typecheck, lint and Vite production build could not be completed because dependencies/emulator tooling are absent and local Node is below the declared engine version.

## Files changed

See `PATCH-MANIFEST.tsv` for the exact file-by-file action and SHA-256 checksums. The complete unified diff is `PATCH.diff`.

## Test evidence

See `PATCH_TEST_RESULTS.md`. Focused tests pass; the full suite retains 17 failures also present in the supplied baseline suite. Build/lint/typecheck/emulator checks are explicitly not marked as passed.

## Deployment status

No Firebase, Vercel or Cloudflare deployment was performed. No production database migration was performed. Do not enable this against production data until the remaining migration, security, emulator and end-to-end acceptance work is completed.
