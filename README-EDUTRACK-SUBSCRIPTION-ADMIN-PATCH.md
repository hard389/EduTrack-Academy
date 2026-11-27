# EduTrack — Subscription Admin Control Center Patch

This patch extends the existing Admin Subscriptions architecture. It does **not** add a second billing system.

## Included functionality

### 1. Customer subscription controls

The Admin Subscriptions page now has a **Customer subscriptions** tab. For a selected managed teacher, an administrator can:

- Assign a plan manually.
- Change a plan manually.
- Extend the current approved period.
- Suspend access immediately.
- Reactivate an eligible current or future approved period.
- Cancel the subscription without deleting the teacher account.

Every manual action requires an administrator confirmation and a reason (10–500 characters). Actions are written to the server-owned `admins/{adminEmail}/subscriptionAuditLogs` collection with the actor, reason, previous/next state, and whether payment approval was bypassed.

**Important:** Manual assign/change are explicit administrator overrides. They grant the selected plan without payment approval. The UI displays a warning and the audit log marks the action as `paymentBypassed: true`. Use only for authorized complimentary/manual grants. Normal paid subscriptions should continue through invoice generation and receipt approval.

Extend only changes a currently active approved period. Reactivation rechecks an eligible period inside a Firestore transaction. Immediate plan changes supersede the previous active period; scheduled future periods are kept scheduled until their start date.

### 2. Complete promotional offer editing

The offer form supports create and edit for:

- Name and description.
- Percentage or fixed-PKR discount.
- Valid-from and valid-until dates.
- Applicable plan IDs.
- Enable/disable state.

If no plans are selected, the offer applies to all active plans. The invoice UI filters offers against the selected plan, and the backend independently validates the offer's plan restriction and date window.

### 3. Paid monthly add-on catalog and billing

The Add-ons tab now includes a paid catalog with create, edit, enable/disable, and archive operations. Each catalog item has a monthly PKR price and exactly one ERP feature key.

Paid add-ons are selected as line items on the existing monthly subscription invoice. Their name, feature, and price are snapshotted on the invoice. They are **not activated when the invoice is created**; they are activated only inside the existing administrator payment-approval transaction after the receipt has passed its current verification flow. The grant is scoped to that approved billing period and expires with it.

To preserve the existing one-invoice-per-teacher-per-month architecture, paid add-ons are consolidated into the teacher's subscription invoice rather than creating a second standalone invoice. The administrator must include the add-on again when preparing a later monthly invoice; this patch does not add automatic recurring charges, a payment gateway, or auto-renewal.

The backend prevents charging for a feature already marked `enabled` in the selected plan and prevents two paid add-ons for the same feature on one invoice. Invoice snapshots preserve historical price details if the catalog changes later.

### 4. Entitlement and customer-status handling

- The projection scheduler treats cancelled/canceled subscription accounts as blocked.
- A first approved future-period invoice moves an inactive account shell to `scheduled`, allowing the existing scheduler to activate it at the period start.
- Scheduled accounts with an approved period can be activated by the projection scheduler when due.
- Admin customer directory status reflects suspended/cancelled account state.

## Storage additions

No Firestore rules change is included. New documents are server-owned and are written through the authenticated admin API:

- `admins/{adminEmail}/subscriptionAddOnCatalog/{catalogItemId}`
- `admins/{adminEmail}/subscriptionAuditLogs/{auditLogId}`
- `admins/{adminEmail}/subscriptionInvoices/{invoiceId}` gains an `addOnSnapshots` array for invoices containing paid add-ons.
- `admins/{adminEmail}/subscriptionAccounts/{teacherUid}/addOns/{grantId}` stores approved paid add-on grants.

No migration is required to create these collections; Firestore creates them on first write. Existing invoices and approved-period permission snapshots are not rewritten.

## Files in this patch

- `server/adminSubscriptions.ts`
- `server/adminSubscriptionReviews.ts`
- `server/adminCustomers.ts`
- `server/subscriptionAdminDomain.mjs`
- `server/subscriptionAdminDomain.d.mts`
- `src/pages/admin/Subscriptions.tsx`
- `src/functions/src/subscriptionProjectionRefresh.ts`
- `src/functions/lib/subscriptionProjectionRefresh.js` and source map
- `tests/admin-subscription-management-domain.test.mjs`

## Apply

1. Back up the current project folder.
2. Extract this ZIP **over the existing project root**, preserving the directory paths in the ZIP. It overwrites only the files listed above; it does not delete other project files.
3. Reinstall dependencies only if your local `node_modules` is missing.
4. Run the verification command below before deployment.

## Local verification command

```bash
cd "$HOME/Pictures/New_updated-_School_ERP_Latest_DevOps" && \
npm run lint && \
npm run typecheck && \
npm run build && \
node --test \
  tests/admin-subscription-management-domain.test.mjs \
  tests/subscription-domain.test.mjs \
  tests/subscription-feature-permissions.test.mjs \
  tests/subscription-entitlement-domain.test.mjs \
  tests/teacher-subscription-access-integration.test.mjs \
  tests/subscription-review-domain.test.mjs \
  tests/subscription-receipt-token.test.mjs \
  tests/subscription-receipt-worker.test.mjs \
  tests/admin-billing-removal.test.mjs \
  tests/fee-alerts-whatsapp-domain.test.mjs \
  tests/quiz-results-whatsapp-domain.test.mjs \
  tests/announcements-whatsapp-domain.test.mjs \
  tests/attendance-dispatch-authorization.test.mjs \
  tests/attendance-retry-policy.test.mjs \
  tests/teacher-registration-access.test.mjs \
  tests/teacher-registration-customer-links.test.mjs \
  tests/alerts-typecheck-repair.test.mjs \
  tests/api-route-dispatcher.test.mjs
```

The Firebase Functions build is included in `npm run typecheck` via the project's existing script. After reviewing the local build and tests, deploy through the project's normal Vercel/Firebase workflow. The function scheduler change must be included in the next Firebase Functions deployment for cancellation/scheduled activation behavior to take effect in production.

## Scope and safety

- No WhatsApp notification dispatch files, Postabi integration, credentials, or provider settings are included in this patch.
- No real WhatsApp messages are sent by these changes.
- The patch does not run deployment commands or modify the live database.
- Existing `allowUnassignedFullAccess` policy is preserved; review its current Admin setting separately if your intended business rule is paid-only registration.
- The project's current manual bank/wallet receipt workflow remains unchanged; no payment gateway is added.

## Verification performed while preparing this patch

- 138 pure/domain/static automated tests passed in the supplied source tree, including the new Admin subscription-management tests and the existing Fee Alerts, Quiz Results, Announcements, attendance authorization/retry policy, receipt security, entitlement, registration, and routing tests.
- TypeScript/TSX syntax transpilation checks passed for all modified TypeScript files.
- A full dependency-backed TypeScript typecheck, ESLint run, and Vite production build could not be rerun in this patch-building environment because the archive intentionally did not include `node_modules` and dependency installation could not complete. Run the local verification command above in the original project environment before deployment.
- Firebase Emulator integration tests and real provider dispatch were not run here. No dummy WhatsApp provider calls were made.
