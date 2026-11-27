# EduTrack Academy — Updated Complete Master AI Patch Prompt (Version 2)

**This is the single updated prompt.** It includes the previously agreed Academy registration, Academy ID, Academy Admin portal, strict Teacher Portal visual lock, subscription-access removal, Academy permissions, central fees, Academy Expenses, secure migration and delivery requirements, plus the latest detailed Class → Subject → Teacher → Student → Fees flow and Quiz/Notes/Reports ownership rules.

**Instruction priority:** Read the full prompt and the original source ZIP. Part L and Part M are the latest authoritative workflow updates and override older conflicting details. The Teacher Portal's visual design remains unchanged. Student attendance is recorded only in the existing Teacher Portal attendance page; Academy Admin sees read-only analytics.

---

# EduTrack → Academy Management System
## Complete Master AI Patch Prompt — Registration, Academy Admin, Teacher Portal Lock, Permissions, Central Fees & Expenses

**Source archive:** `EDUTRACK_ACADEMY_CONFIGURED_SOURCE_ARCHITECTURE_REVIEW_20261124_104020(1).zip`  
**Repository root inside ZIP:** `EDUTRACK_ACADEMY_CONFIGURED_SOURCE/`  
**Purpose:** Convert the existing single-teacher EduTrack application into a multi-user, academy-scoped management system without redesigning or replacing the existing Teacher Portal.

---

# COPY-PASTE THE INSTRUCTIONS BELOW INTO YOUR CODING AI

You are acting as a senior full-stack architect, Firebase security engineer, React/TypeScript engineer, financial-data engineer and migration engineer. You have been provided with the complete EduTrack source ZIP. Your job is to implement a complete, secure and production-minded **Academy Management System** by extending the existing application.

Do not create a disconnected demo, static dashboard, mock UI or a second unrelated application. Every new Academy Admin screen must use real authenticated backend operations and the same canonical academy data used by the existing Teacher Portal.

## 0. Non-negotiable product rules

These rules take priority over implementation convenience:

1. **Do not redesign the existing Teacher Portal.** Preserve its current visual design, layout, component hierarchy, page structure, colors, typography, forms, interactions, responsive behaviour and navigation appearance. Do not replace it with a new template.
2. Existing Teacher Portal pages and workflows must remain recognizable and behave as they do now. Backend/data-service integration is allowed and required, but do not perform a visual redesign or rewrite the Teacher Portal UI.
3. Teacher Portal module access must be controlled by permissions granted by the Academy Admin. **Subscription plans, subscription entitlements, subscription status, paid plans and add-ons must no longer decide what a teacher can access.**
4. Keep the existing Platform/SaaS Super Admin portal separate. Its current `/admin/*` authentication and privileged operations must not become Academy Admin functionality.
5. Build a separate Academy Admin Portal with its own premium design and navigation. Do not mount the Academy Admin UI inside the Teacher Portal.
6. Academy Admin and Teacher Portal must use one authenticated academy identity and one canonical academy data source. Do not create unrelated duplicate records for the same student, invoice or payment.
7. An Admin-created student assigned to Teacher A must appear automatically in Teacher A's existing Teacher Portal, in the right class/subject, without a second manual entry. A teacher-created student must appear in the Academy Admin portal and central academy records.
8. Each student must have one canonical student profile, even when enrolled in multiple subjects or taught by different teachers.
9. All student fees must be centralized at academy level. Teacher and Admin fee actions must update the same invoice/payment ledger and balance.
10. Add a premium **Academy Expenses** page to the Academy Admin Portal. It must use real persisted financial records and be reflected in dashboard analytics.
11. No secret, password, Firebase Admin credential, private API key or service-account JSON may be added to the ZIP or exposed in frontend code.
12. Do not claim completion based on a frontend screenshot. Complete backend, Firebase, Firestore security, data migration, tests and build verification.

### Clarifying the “0% Teacher Portal change” requirement

“0% change” means **zero visual redesign and no replacement of existing Teacher Portal pages or workflows**. The minimum code changes needed to replace subscription checks with Academy Admin permissions, load academy-scoped records, synchronize data and protect routes are required. Keep current markup and UI styling intact. If a teacher has not been granted access to a module, hide that existing navigation item in the same existing navigation design and block its direct route; do not redesign the sidebar or Quick Access.

---

# PART A — VERIFIED SOURCE ARCHITECTURE: INSPECT BEFORE PATCHING

The uploaded project is a React 18 + TypeScript + Vite application using Firebase Authentication, Cloud Firestore, Firebase Admin SDK, Firebase Cloud Functions, Vercel API handlers, Cloudflare Workers/R2 and WhatsApp integrations.

The archive inspection identified these important current paths and behaviours. Re-open and verify every item in the actual source before editing; do not rely only on this summary.

## A1. Current authentication and roles

- `src/pages/RegisterPage.tsx` is currently the self-service Teacher Registration form. It collects teacher name, Gmail, WhatsApp, password, profile picture and subscription selection.
- Current self-registration creates a Firebase Auth user and a `users/{normalizedEmail}` profile with `role: "teacher"`, `registrationSource: "self_registered"` and `approvalStatus: "approved"`.
- Current registration checks Gmail-shaped email format but does not enforce Firebase email verification as an access condition.
- `src/pages/LoginPage.tsx` currently signs in by email/password and validates a teacher profile; it has no Academy ID field.
- `src/pages/LoadingPage.tsx` and `src/pages/LoadingPage.auth.tsx` contain teacher-profile assumptions.
- `server/teacherAuth.ts` verifies Firebase ID tokens and checks the active teacher profile at `users/{email}`.
- `server/firebaseAdmin.ts` and `src/components/AdminRouteGuard.tsx` implement a distinct Platform/SaaS Super Admin using the Firebase custom claim `admin === true`.
- `src/pages/admin/*` and `/admin/*` currently belong to the platform-admin area. Preserve its security boundary and do not grant these privileges to Academy Admins.

## A2. Existing Teacher Portal files that must be preserved visually

- `src/App.tsx` — route registry; currently imports the Teacher Subscription page and wraps teacher feature routes in `FeatureRoute`.
- `src/components/Layout.tsx` — existing Teacher Portal shell and sidebar.
- `src/pages/Dashboard.tsx` — existing Teacher Dashboard and Quick Access.
- `src/pages/ClassesPage.tsx`
- `src/pages/DepartmentsPage.tsx` — current class/student management flows.
- `src/pages/attendance.tsx` — student attendance workflow.
- `src/pages/fees.tsx` — extensive current teacher fee-management experience and payment history.
- `src/pages/reports.tsx`, `src/pages/analytics.tsx`, `src/pages/notes.tsx`, `src/pages/alerts.tsx`, `src/pages/quiz.tsx`, `src/pages/settings.tsx` and their imported components.

Do not remove, replace or visually redesign these pages. Reuse them for authorized teachers and introduce repository/service adapters behind the existing UI where possible.

## A3. Current subscription coupling that must be removed from Teacher Portal access

Verified source references include:

- `src/contexts/AppContext.tsx` loads `/api/teacher/subscription`, stores an entitlement snapshot and derives feature access from it.
- `src/components/FeatureRoute.tsx` currently checks subscription entitlement and presents subscription-related access states.
- `src/App.tsx` currently contains the `/subscription` Teacher Portal route and wraps several existing routes in `FeatureRoute`.
- Existing source contains teacher subscription APIs such as `api-handlers/teacher/subscription.ts` and `api-handlers/teacher/subscription/*`.
- Current subscription/entitlement tests and student import/consent checks exist. Search the full repository before removing or changing their assumptions.

The Teacher Portal must stop using subscription entitlement as an access-control source. Replace it with Academy Admin membership permissions. Do not blindly delete the entire subscription-related source tree: first identify platform-super-admin-only functionality and shared dependencies. See Part F.

## A4. Current teacher-scoped data model

The current application is strongly scoped to each teacher email. Source inspection identified patterns including:

- Teacher profile: `users/{normalizedTeacherEmail}`.
- Classes: `users/{teacherEmail}/classes/{classId}`.
- Student records are currently embedded in class documents, often in a `students` array.
- Student attendance: `users/{teacherEmail}/attendance/{attendanceId}`.
- Monthly fee documents: `users/{teacherEmail}/fees/{classId}_{YYYY-MM}`.
- Fee receipts/payments: nested below `users/{teacherEmail}/fees/{feeDocId}/payments/{paymentId}`.

Current screens and services contain direct teacher-email-based Firestore reads and writes. Search the complete project, including server modules, functions, handlers, Firestore rules, indexes and workers. A shared academy cannot be implemented safely by changing only the registration form.

## A5. Toolchain and baseline

- Root `package.json` declares Node `>=22.22.2 <23`.
- Use the version specified by the project `.nvmrc` / `package.json` engine and the package manager/lockfile actually used by this project.
- The source review previously ran these focused baseline tests successfully: `node --test tests/teacher-registration-access.test.mjs tests/teacher-registration-customer-links.test.mjs tests/firestore-no-op-workload-guards.test.mjs` — 26 tests, 0 failures.
- The earlier source review did not complete the full build/typecheck because the available Node runtime was below the project's declared minimum and `node_modules` was not included. Do not represent those as already passing.

---

# PART B — TARGET APPLICATION AND ROLE ARCHITECTURE

## B1. Roles must be distinct

Implement at least these independent roles:

### 1. Platform/SaaS Super Admin

- Existing role controlled by Firebase custom claim `admin === true`.
- Keeps access to existing `/admin/*` platform pages and platform-level operations.
- Must not automatically become an Academy Admin or receive access to an academy's private records without an explicit, audited support workflow.
- Preserve the current platform admin route guard, API checks and security.

### 2. Academy Admin / Academy Owner

- The account that creates a new academy through the public Academy Registration form is always the first Academy Admin/Owner.
- Academy Admin manages only the academy identified by the authenticated membership.
- Has academy-wide administration and finance permissions by default.
- Can create teachers, assign classes/subjects, add/manage students, configure academy access, attendance and fees, view reports and manage expenses.
- Cannot access other academies merely by changing Academy ID or request payload.

### 3. Academy Teacher

- Created/invited by an Academy Admin; public registration must not create teacher-role accounts.
- Belongs to an academy through a membership record.
- Receives only the pages/actions explicitly granted by the Academy Admin and only for the classes, subjects and students inside the assigned scope.
- Uses the existing Teacher Portal UI, not a new teacher interface.

Never conflate `academy_admin` with the existing Firebase custom claim `admin`.

## B2. Separate Academy Admin Portal routes

Create a separate Academy Admin route group, for example:

- `/academy-admin/login` if a distinct URL is needed, or use the unified `/login` form with role-aware redirects.
- `/academy-admin/dashboard`
- `/academy-admin/teachers`
- `/academy-admin/students`
- `/academy-admin/classes`
- `/academy-admin/subjects`
- `/academy-admin/assignments`
- `/academy-admin/attendance`
- `/academy-admin/fees`
- `/academy-admin/expenses`
- `/academy-admin/reports`
- `/academy-admin/permissions`
- `/academy-admin/settings`

Choose a route layout consistent with the existing router, but keep it separate from `/admin/*` and from the Teacher Portal `Layout`.

The Academy Admin portal gets its own premium, responsive admin design. Reuse the project's existing component library, chart library, theme support and icon conventions where appropriate. Do not add an unnecessary UI framework.

## B3. One unified login experience

Update the normal application login to include:

- Academy ID (manually entered by the user at login)
- Email address
- Password
- Password visibility toggle
- Existing password recovery behaviour, safely adapted to academy membership

After Firebase Authentication succeeds, validate on the trusted backend that:

1. The supplied Academy ID resolves to an active academy.
2. The authenticated Firebase UID has a membership in that academy.
3. The membership is active and its email corresponds to the authenticated account.
4. The verified email requirement is satisfied.
5. The role is either `academy_admin` or `teacher`.

Then route `academy_admin` to `/academy-admin/dashboard` and `teacher` to the existing `/dashboard`. If membership validation fails, sign out or deny access safely and show a useful non-sensitive error. Do not reveal whether arbitrary emails are registered in another academy.

Do not permit an authenticated teacher from Academy 100 to enter Academy 101 by changing the login field, URL, Firestore path or request body.

---

# PART C — ACADEMY REGISTRATION AND IMMUTABLE ACADEMY ID

## C1. Public registration becomes Academy Registration

Modify the current `src/pages/RegisterPage.tsx` flow:

- Page title: **Academy Registration**.
- Replace Teacher Name with **Academy Name**.
- Add a read-only **Academy ID** field.
- Keep appropriate email, WhatsApp/contact, password, confirm-password and profile image/logo fields where compatible.
- Remove the subscription-plan selector and any subscription/payment selection from the Academy Registration form.
- The registrant is always the Academy Owner/Admin. Do not show a role dropdown.
- Keep the existing design language where practical for registration; do not redesign the existing Teacher Portal.

## C2. Academy ID allocation

- Visible Academy IDs are numeric and begin at **100**: first successful academy gets 100, next gets 101, then 102, etc.
- The ID is generated only by trusted server-side code using an atomic Firestore transaction/counter.
- Never calculate the authoritative ID in React, from `Date.now()`, random numbers, a client-supplied number or a non-transactional read-then-write.
- Display the auto-assigned ID in the registration field. Implement a secure server-side reservation endpoint/operation if the form must show the actual numeric ID before final submission. The reservation must use an unguessable server-generated token, expire safely, be rate-limited, and be single-use. Gaps caused by expired reservations are acceptable; duplicates are not.
- On final registration, verify that the reservation belongs to the current registration attempt and has not expired or already been consumed.
- The Academy ID is permanent and immutable. Enforce immutability in backend validation and Firestore rules; never rely only on a disabled input.
- It is acceptable to keep an internal Firestore document ID separate from the visible Academy ID, provided a trusted, unique mapping is maintained. Never trust a client-supplied mapping.

## C3. Academy Owner email verification

- Use Firebase Auth `sendEmailVerification`.
- Gmail format validation is not a substitute for actual email verification.
- Create the new academy/membership in a `pending_email_verification` or equivalent state.
- The owner cannot access the Academy Admin Portal or teacher data until Firebase Auth confirms `emailVerified === true` and the backend verifies the token/account.
- Provide verify-email, resend-verification, refresh/re-authenticate and sign-out states.
- Do not mark an account verified based on a URL query parameter or frontend-only state.
- Once verified, activate the academy owner membership and route to the Academy Admin Portal.

## C4. First registrant is always Academy Admin

- First public registration creates the academy and its owner membership with role `academy_admin`.
- No teacher account is created during public Academy Registration.
- Do not give first registrant the platform Super Admin custom claim.
- Academy owner can never edit the immutable Academy ID.

---

# PART D — ACADEMY ADMIN PORTAL: REQUIRED PREMIUM MODULES

Create the Academy Admin portal as a new management interface. Its primary purpose is to control the academy and supervise the same academic/financial data that teachers use.

## D1. Premium Academy Dashboard

Create a high-quality responsive dashboard with real Firestore-backed metrics, date filters, loading/error/empty states and charts.

Include KPI cards such as:

- Total active teachers
- Teachers present today / absent today (only when staff attendance records support this)
- Total active students
- Student attendance percentage for selected date/period
- Active classes and subjects
- Total invoiced fees for the selected period
- Actual fees collected for the selected period
- Outstanding student dues
- Total academy expenses for the selected period
- Net cash movement / net operating cash position for the selected period, calculated from actual collected payments minus posted expenses (not from invoices issued)

Include charts/tables such as:

- Student attendance trend by day/week/month
- Staff/teacher present vs absent trend
- Attendance by class
- Fees collected over time
- Fees due/outstanding trend
- Collection vs academy expenses comparison
- Expenses by category
- Student/class/subject enrolment overview
- Teacher workload summary

Rules:

- Use real data only. Do not ship fabricated dashboard numbers or hard-coded chart series.
- Clearly distinguish invoice value, amount collected, amount outstanding and actual expenses.
- Do not infer teacher absence from missing student attendance. Staff attendance must be a separate, explicit dataset/workflow.
- Add date-range and relevant class/teacher filters.
- Avoid loading the entire academy database into the browser for every metric. Use paginated queries, server aggregation or maintained aggregate documents where appropriate.
- Explain “no data yet” rather than showing misleading zero-like values when the data is not available.

## D2. Teacher Management

Create an Academy Admin **Teachers** page with:

- Add Teacher form: profile picture, full name, email, initial password/temporary password, WhatsApp/contact and optional profile metadata.
- Create Firebase Auth teacher account through trusted Firebase Admin SDK/backend code. Never use client-side Admin SDK credentials.
- Never save plaintext passwords in Firestore, logs or exports.
- Send verification/reset/invitation instructions using Firebase Auth-supported flows. Require verified email before normal teacher access, with a clear pending state.
- Assign teacher to one or more classes and subjects with start/end/effective dates.
- Edit teacher profile and assignments.
- Activate/deactivate membership; deactivation must revoke access promptly without deleting academic/financial history.
- Password reset flow via Firebase Admin SDK/Firebase Auth supported mechanism.
- Teacher detail/profile page showing:
  - Profile and account state
  - Assigned classes and subjects
  - Number of unique students currently assigned
  - Active teaching sessions/assignments
  - Student fee amount attributed to the teacher's assigned subject/class enrollments, where attribution is well-defined
  - Actual amount collected by that teacher as collector
  - Outstanding amount for assigned enrollments
  - Attendance summary for that teacher, if staff attendance is enabled

Important financial distinction: “fees attributed to the teacher's assigned classes/subjects” and “payments physically collected by that teacher” are different metrics. Do not combine them or call student fee revenue a teacher salary. Avoid double counting when one student studies several subjects or has more than one teacher.

## D3. Classes and Subjects

Provide Academy Admin pages to:

- Create/edit/archive classes and class sections.
- Create/edit/archive subjects.
- Set class/subject relationships.
- Assign teachers to specific class + subject combinations.
- Set assignment effective dates and active/inactive state.
- View rosters by class and subject.
- Avoid duplicate class/subject/assignment records.

Teacher access to a class/subject must be constrained by current assignment or a valid temporary substitute authorization.

## D4. Students — one canonical student profile

Create an Academy Admin **Students** page with a profile form aligned with the fields already used by the existing Teacher Portal. At minimum inspect and preserve current data fields such as student name, picture, stable student ID/roll number, contact/guardian details and class metadata where they exist.

Admin should be able to:

- Add/edit/view/archive a student.
- Assign one student to a class and one or more subjects.
- Assign the student/enrolment to the responsible teacher(s).
- View all subjects, teachers, invoices, payments and attendance history linked to the same student.
- Search and filter students by name, ID, class, subject and assigned teacher.

A student taking Mathematics and Physics, or two/three subjects, is still **one student profile** with multiple subject enrolments. Do not create separate student identities for each subject.

## D5. Teacher Portal student creation remains available

- Teachers may continue to add students through the existing Teacher Portal form/page, without visual redesign.
- The feature works only if the Academy Admin grants the required permission, e.g. `students.create`.
- The teacher can add the student only into classes/subjects within their permission and assignment scope.
- The teacher-created student is saved in the same academy canonical student collection and appears in the Admin portal automatically.
- If the Admin creates a student and assigns them to Teacher A + Class X + Subject Y, the student must appear automatically in Teacher A's existing portal in the corresponding roster.
- Use Firestore listeners, query invalidation or reliable refetching so updates appear without duplicate manual work.
- Other teachers must not see this student unless they have an applicable assignment or an explicitly granted broader permission.
- Use stable IDs and academy-scope duplicate checks. Record who created the student and when.

## D6. Attendance Management

### Student attendance

- Keep the existing Teacher Portal student attendance page and its visual design/workflow.
- Teachers can take attendance only for their assigned classes/subjects or valid temporary substitute sessions.
- Academy Admin can view attendance across the academy, filter by class, subject, student, teacher and date, and make authorized corrections with a reason and audit entry.
- Admin dashboard attendance graphs must use validated student attendance records.

### Teacher/staff attendance

- Implement a separate staff attendance record/workflow if the Academy wants teacher present/absent analytics.
- Support clear statuses such as present, absent, late, leave or approved absence, with date, teacher UID, recordedBy UID, timestamps and optional reason.
- Do not invent absence from missing records. Establish an explicit expected working day/session policy before calculating absence.
- Academy Admin can view daily attendance and trends.

### Temporary substitute teacher / one-day class access

Support this real-world case: Teacher A normally teaches a class, but Teacher B takes one specific lecture on a particular day.

- Academy Admin can grant Teacher B a temporary substitute authorization for an exact class + subject + date/session.
- Store the permanent teacher assignment separately from the substitute session.
- Include class ID, subject ID, substitute teacher UID, exact date/session, approvedBy UID, reason, status and createdAt.
- Teacher B may take student attendance only for the authorized class/session and only within the authorized date/time window.
- This temporary grant must not silently change Teacher A's permanent assignment or give Teacher B permanent class access.
- Preserve a clear audit trail of who authorized and who recorded attendance.

## D7. Central Fees, Invoices and Collections

This is a mandatory core module. **One central academy fee system for all students; no independent per-teacher fee balances.**

### Admin Fee Management

Create a premium Academy Admin Fees/Finance page with:

- All students searchable in one place.
- One student fee account showing all enrolled subjects.
- Fee structure by subject/class and billing period, with effective dates.
- Invoice generation for selected billing period.
- Consolidated invoice per student per billing period, with subject-wise line items.
- Invoice status, amount invoiced, discount/adjustment if supported, amount paid, balance due and payment history.
- Payment receipts and collection history.
- Outstanding dues, overdue filters and reports.
- Payment methods and reference numbers where supported by existing application.
- Printable/downloadable invoice and receipt where current project libraries support it.

A student enrolled in 3 subjects should have one invoice with 3 subject line items, not 3 duplicated student accounts or multiple competing fee balances. A later fee-structure change must not rewrite historical invoice line-item amounts.

### Teacher Fees page must remain the existing page

- Reuse the existing `src/pages/fees.tsx` UI and its current interaction design.
- No new teacher fee interface and no visual redesign.
- When Academy Admin grants `fees.view_assigned` and/or `fees.collect`, the teacher can view/collect against authorized students only.
- Teachers must not see academy-wide fee data unless a separate `fees.view_all` permission is explicitly granted.
- Payment recorded through the existing teacher Fees page writes to the central academy invoice/payment ledger.
- Admin sees the same payment, receipt, amount, date, payment method, invoice/student and authenticated collecting teacher.
- Admin collections must also be reflected in the existing teacher Fees page for teachers authorized to see those students.
- The displayed balance must always come from the same canonical ledger/calculation.

### Financial integrity

- Use trusted backend operations and Firestore transactions for payment allocation and invoice balance updates.
- Each payment references academy ID/document ID, invoice ID, student ID and authenticated collector UID.
- Prevent duplicate payment submissions (idempotency key), concurrent double collection, cross-academy payment writes and invalid invoice/student references.
- Validate overpayment according to one documented rule; do not silently over-collect or silently cap the submitted amount.
- Receipts are immutable financial records. Corrections/refunds/voids require an explicit permission, reason and compensating ledger entry; do not silently delete or overwrite payments.
- Distinguish fees invoiced, fees collected and outstanding dues.
- Use subject line-item attribution for teacher/class reporting so multi-subject student fees are not double counted.
- Student tuition revenue is academy revenue. Do not call it teacher income/salary.

## D8. Academy Expenses — new premium Admin-only module

Create a dedicated **Academy Expenses** page in the Academy Admin Portal. This is a new requested module and must be fully integrated with the dashboard and reports.

### Expense dashboard/overview

Display real persisted financial totals, for example:

- Expenses today
- Expenses this month
- Total posted expenses in selected date range
- Category-wise expense breakdown
- Month-over-month expenses trend
- Net cash movement: actual fee payments collected minus posted expenses during the same period

Never calculate net cash from invoices that have not been paid.

### Expense management

The page should include:

- Add Expense form
- View expense details
- Edit draft/unposted expense where permitted
- Void/cancel an already posted expense only through a reasoned, auditable operation; do not hard-delete financial history
- Search, sort, filter and paginate the expense register
- Date-range filter
- Category filter
- Payment method filter
- Vendor/payee and reference filter
- Receipt/proof attachment when supported by existing secure storage
- Export/print report if existing libraries allow it

Suggested default categories (make configurable by Academy Admin):

- Teacher/staff salaries and compensation
- Building rent
- Electricity, gas, water and utilities
- Internet/phone
- Stationery and classroom supplies
- Books and learning materials
- Maintenance and repairs
- Furniture/equipment
- Transport
- Cleaning/security
- Marketing/advertising
- Software/subscriptions used by the academy
- Miscellaneous/other

Do not confuse the retired Teacher Portal subscription products with legitimate academy business expenses. The expense category can include a general software/service expense only if the Academy Admin records an actual academy cost.

### Expense fields and audit

At minimum store:

- expenseId
- academyId / academy document reference
- title/description
- categoryId/category name snapshot
- amount and currency
- expenseDate
- vendor/payee (optional)
- paymentMethod
- reference/receipt number (optional)
- attachment metadata/secure storage reference (optional)
- status such as draft, posted or void
- createdBy UID and createdAt
- updatedBy UID and updatedAt
- postedBy UID and postedAt
- voidedBy UID, voidedAt and voidReason when applicable

Use a trusted backend write. Only Academy Admin may access this module by default. Do not add a Teacher Portal Expenses link unless a future explicit permission is implemented; no teacher expense permission is requested now.

### Expense security

- Validate amount > 0, valid date, currency, category and academy membership.
- Validate attachment ownership and content type/size using existing secure upload practices.
- Do not expose receipt files to other academies.
- Log create/edit/post/void events in the audit log.
- Expense totals and charts must exclude drafts and voided expenses from posted spending.

## D9. Permission Management — Academy Admin is the sole authority

Build a dedicated Academy Admin Permissions page. Admin can open a teacher profile and turn specific pages/actions on/off. Permissions must be enforced both in the UI and by backend/Firestore security.

Use a typed, centrally declared permission manifest. Example permissions (adapt names to current modules):

- `dashboard.view`
- `classes.view_assigned`
- `classes.manage_all`
- `students.view_assigned`
- `students.create`
- `students.edit_assigned`
- `students.manage_all`
- `subjects.view_assigned`
- `attendance.take_assigned`
- `attendance.view_assigned`
- `attendance.view_all`
- `attendance.correct`
- `attendance.substitute_session`
- `fees.view_assigned`
- `fees.collect`
- `fees.view_all`
- `fees.issue_invoice`
- `fees.configure`
- `fees.adjust`
- `fees.refund`
- `reports.view_assigned`
- `reports.view_all`
- `analytics.view_assigned`
- `analytics.view_all`
- `notes.view`
- `notes.manage`
- `alerts.view`
- `alerts.manage`
- `quiz.view_assigned`
- `quiz.manage_assigned`
- `settings.profile`

The exact permission list must map to the real pages/actions found in the repository. Do not grant an ability simply because a page is visible.

Rules:

- Academy Admin has full access within their academy by default.
- Teacher access starts from a secure least-privilege default. Do not assume all permissions are enabled.
- Page visibility, sidebar and Quick Access must derive from the same permission manifest so they cannot disagree.
- Preserve the existing Teacher Portal sidebar/Quick Access design. Only filter existing items by permissions; do not redesign their markup or visual language.
- Existing teacher routes must check permission before rendering.
- Backend APIs, Cloud Functions and Firestore rules must independently enforce the same authorization. A hidden sidebar item is not security.
- Re-check permission for every target resource: class, subject, student, invoice and date/session. Never trust a teacher-supplied resource ID alone.
- When Admin revokes a permission or deactivates a teacher, new requests must be rejected promptly. Do not rely only on stale local context/cache.
- Maintain audit history for permission changes (who changed what, from which previous value to which new value, and when).

---

# PART E — REMOVE SUBSCRIPTION ACCESS FROM THE TEACHER PORTAL

This requirement is explicit and mandatory.

## E1. Replace subscription-based feature access

- Remove `AppContext` subscription entitlement loading as the source of Teacher Portal feature access.
- Remove teacher-facing checks that call `/api/teacher/subscription` to determine whether a route is enabled.
- Refactor `FeatureRoute` or replace its authorization internals so it uses academy membership + Academy Admin permission grants + resource scope.
- Do not show “Checking your subscription”, subscription expired, choose a plan, upgrade, buy add-on or subscription-blocked messaging in the Teacher Portal.
- Remove the Teacher Portal `/subscription` route and its navigation/Quick Access references. Redirect old `/subscription` URLs to an appropriate safe destination, such as `/dashboard`, without a dead page.
- Remove subscription plan selection from Academy Registration.
- Remove teacher-facing subscription proof upload, proof submission, add-on purchase/request and plan-selection controls where they are part of Teacher Portal workflows.
- Remove subscription-based student-count caps, import restrictions, plan quotas or page restrictions from teacher features. Replace genuine access checks with Academy Admin permissions and academy assignment scope. Keep technical safety/rate limits that are not subscription entitlements.
- Remove subscription entitlement fields as an authorization dependency. Legacy fields may be retained as historical metadata if needed, but never use them to grant/deny Academy Teacher permissions.

## E2. Do not break the existing platform admin by accident

- First classify every subscription-related source file/API/Cloud Function/worker as teacher-facing, platform-admin-only, or shared.
- Existing `/admin/subscriptions`, platform customer management or SaaS billing pages may remain only as isolated Platform/SaaS Super Admin functionality if still used by the product owner.
- These platform subscription functions must not be required for Academy creation, Academy login, teacher route access, student creation, fees or expenses.
- Never let a platform subscription entitlement override an Academy Admin grant or revoke it.
- If a teacher subscription endpoint becomes unused, remove it or retire it safely after checking every caller, tests, scheduled worker and integration. Do not leave broken UI calls.
- Update or replace tests that asserted teachers are blocked because of subscription state. New tests must assert that access comes from Academy Admin permission grants.
- Search all references including `subscription`, `entitlement`, `plan`, `add-on`, `quota`, `featureVisibilityMode`, `accessMode` and `featurePermissions` across `src/`, `server/`, `api-handlers/`, `src/functions/`, `cloudflare/`, tests, Firestore rules, indexes and docs.

---

# PART F — CANONICAL ACADEMY DATA MODEL AND TEACHER COMPATIBILITY

The current application stores data in teacher-email workspaces. A proper multi-teacher academy needs academy-scoped canonical records. Implement a clean and documented data model. Exact collection naming may follow project conventions, but the ownership principles below are mandatory.

## F1. Suggested canonical Firestore structure

Use a trusted internal academy document ID plus the immutable visible numeric Academy ID. A possible layout is:

```text
academyIdReservations/{reservationId}
systemCounters/academyIds
academyIdLookup/{visibleAcademyId}

academies/{academyDocId}
  members/{firebaseUid}
  students/{studentId}
  classes/{classId}
  subjects/{subjectId}
  studentSubjectEnrollments/{enrollmentId}
  teacherAssignments/{assignmentId}
  substituteSessions/{sessionId}
  studentAttendance/{attendanceRecordId}
  staffAttendance/{staffAttendanceId}
  feeStructures/{feeStructureId}
  feeInvoices/{invoiceId}
    payments/{paymentId}  (or an equivalent canonical payments collection)
  expenses/{expenseId}
  expenseCategories/{categoryId}
  auditLogs/{eventId}
  aggregates/{aggregateId}
  settings/{settingsDocId}
```

Suggested key fields:

### Academy
- `academyId` (immutable visible number/string)
- `academyName`
- `ownerUid`
- `ownerEmail`
- `status`
- `createdAt`, `updatedAt`

### Member
- `uid`
- `email`
- `displayName`
- `role` (`academy_admin` or `teacher`)
- `status` (`pending_verification`, `active`, `suspended`, etc.)
- typed `permissions`
- `createdAt`, `updatedAt`, `createdBy`

### Student
- stable `studentId`
- `academyId`
- name/profile/guardian/contact attributes currently used by the app
- `status`
- audit metadata

### Student Subject Enrollment
- student ID
- class ID
- subject ID
- assigned teacher UID (where applicable)
- effective start/end dates
- fee structure snapshot/reference
- enrollment status

### Teacher Assignment
- teacher UID
- class ID
- subject ID
- effective dates
- status
- createdBy

### Invoice
- student ID
- billing period
- subject line items (class/subject/teacher attribution and amount snapshots)
- total amount
- discount/adjustment if supported
- paid amount derived safely from ledger or transactionally maintained
- outstanding amount
- status and timestamps

### Payment
- academy ID
- invoice ID
- student ID
- amount/currency
- paidAt
- payment method/reference
- receipt number
- collectedBy UID
- idempotency key
- immutable audit metadata

### Expense
Use the fields specified in Part D8.

Never treat a proposed schema as final without checking current data, indexes, query patterns and project conventions.

## F2. Single source of truth and Teacher Portal adapter

- The canonical student, class, subject, assignment, attendance, invoice, payment and expense data belongs to the academy.
- Refactor data access behind services/repositories so the existing Teacher Portal pages can continue to receive the data shape they expect.
- Preserve current Teacher Portal markup and interaction design. Prefer an adapter/mapper that converts canonical academy records to existing component types over rebuilding page components.
- Search for every direct `users/{email}` read/write. Migrate teacher-facing workflows so writes go through secure academy-scoped services.
- Legacy `users/{teacherEmail}` paths may be retained temporarily as compatibility projections or migration backups, but they must not become a second competing source of truth.
- If a derived projection is necessary for performance or compatibility, document it as derived/read-only, define a deterministic refresh strategy and prevent teachers from writing conflicting copies.
- Real-time updates or reliable cache invalidation are required so Admin and Teacher Portal remain synchronized.
- Preserve existing student IDs/roll numbers where possible. Do not silently create duplicate students because the same child appears in old workspaces for more than one subject.

## F3. Tenant isolation

- Every canonical record must be tied to the academy.
- Every server query must derive the academy membership from the verified UID, not from an untrusted body parameter.
- Firestore rules must deny cross-academy reads/writes by default.
- Validate class/student/invoice relationships server-side; do not trust client-supplied academy ID or teacher email as proof of authority.

---

# PART G — FIREBASE AUTH, BACKEND, API AND FIRESTORE SECURITY

Implement the new architecture end-to-end. This is not a frontend-only task.

## G1. Trusted membership verification

Create reusable backend helpers such as:

- `requireAuthenticatedUser`
- `requireAcademyMembership`
- `requireAcademyAdmin`
- `requireAcademyPermission(permissionKey)`
- `requireTeacherAssignment({ classId, subjectId, studentId, date/session })`

Names may vary, but apply the same logic consistently across Vercel handlers and Cloud Functions.

## G2. Teacher creation endpoint

- Academy Admin calls a trusted API/Callable Function.
- Verify owner/admin membership for the academy in the backend.
- Create Firebase Auth account using Firebase Admin SDK.
- Create the academy member profile and any legacy compatibility identity atomically or with a recoverable idempotent workflow.
- Prevent duplicate accounts, duplicate membership and cross-academy account takeover.
- If initial password is accepted, handle it only transiently; never persist it or log it. Provide email verification/password reset/invitation steps.
- Use safe error handling that does not leak whether an unrelated email has an account.

## G3. Firestore rules

Rewrite/extend `firestore.rules` carefully:

- Academy membership must be verified for every academy document access.
- Academy Admin permissions must be required for admin-only operations.
- Teacher reads/writes must be scoped to assigned classes, subjects, students and explicitly granted actions.
- Fee collection must validate invoice/student scope and permission.
- Expenses are Academy Admin-only by default.
- Academy ID fields must be immutable after creation.
- Client must not self-assign `academy_admin`, change its own permissions, elevate role, activate an unverified owner or forge a staff substitute session.
- Audit/payment/receipt records must not be directly deleted or altered by ordinary clients.
- Avoid overly broad wildcard rules that accidentally restore teacher-email-wide access.

If Firestore rules cannot safely validate a complex operation, route it through trusted backend logic and keep direct writes denied.

## G4. API and Cloud Function rules

- Update teacher API auth to resolve Academy membership and permission.
- Do not assume `users/{email}` is sufficient tenant authorization.
- Platform admin handlers continue to require the platform super-admin claim.
- Academy Admin handlers require Academy Admin membership, not `admin === true`.
- Every operation validates target resource academy ownership and assignment scope.
- Use idempotency and Firestore transactions for invoice/payment/expense operations.
- Add structured logs without secrets or sensitive personal data.

## G5. Security and abuse controls

- Rate-limit public academy ID reservation and registration.
- Validate inputs with schemas on both server and client.
- Use Firebase App Check if already configured or add it where compatible.
- Do not expose Firebase Admin SDK keys to Vite/frontend bundle.
- Secure file attachments using the existing storage architecture and signed/authorized reads.
- Never accept an arbitrary UID, teacher email, Academy ID, role or permission as proof of authority.

---

# PART H — MIGRATION OF EXISTING TEACHER DATA

This project already contains teacher-specific workspaces. Migrate safely; do not blindly merge or discard data.

1. Before changing paths, inspect every collection/document shape and all current consumers.
2. Produce a **dry-run migration report** showing source workspace, teacher identity, classes, embedded students, attendance, monthly fee documents, payment receipts and any detected duplicates/conflicts.
3. Existing standalone teacher accounts must not automatically become Academy Admins.
4. Do not merge two teachers' data just because their class names, student names or email patterns look similar.
5. Provide an explicit mapping/claim process so the first Academy Owner can link existing teacher workspaces to the academy and invite the teachers who should become academy members.
6. Preserve source IDs, invoice/receipt history, attendance history, fee values and timestamps wherever possible.
7. Create backups/export manifests before writes.
8. Make migration idempotent: rerunning it must not duplicate students, invoices, payments or attendance.
9. Record source-to-target IDs in a migration map.
10. Keep a rollback plan and do not delete legacy data in the same operation that creates canonical records.
11. Reconcile counts and financial totals before activating the new canonical data source.
12. Do not automatically recalculate historical invoice totals using today's fee structure. Preserve original historical amounts.
13. After cutover, ensure old paths cannot accept competing writes. Retain read-only compatibility views only where necessary.

---

# PART I — PAGE AND REQUIREMENT MAPPING

Before coding, create a page-by-page requirements matrix in the repository (for example `docs/ACADEMY_REQUIREMENTS_MAPPING.md`) with columns:

- Requirement
- Academy Admin page/route
- Existing Teacher Portal page/route (if reused)
- Frontend file(s)
- Backend/API/Cloud Function(s)
- Firestore collection(s)
- Permission key(s)
- Tests
- Migration impact
- Status

At minimum map every module below:

| Requirement | Academy Admin | Existing Teacher Portal | Notes |
|---|---|---|---|
| Academy registration | New registration flow | None | First registrant is owner/admin |
| Login | Academy ID + email + password | Same login, role-aware redirect | Membership checked server-side |
| Dashboard | New premium academy-wide dashboard | Existing Teacher Dashboard unchanged | Real aggregates only |
| Teachers | Add/edit/deactivate/assign | Existing profile/settings only where applicable | Auth account created server-side |
| Students | Academy-wide add/manage | Existing student form retained | One canonical profile |
| Classes | Academy-wide classes | Existing Classes/Departments views | Reused through adapter |
| Subjects | Academy-wide subjects | Assigned-subject context | Subject enrolments are relational |
| Assignments | Teacher-class-subject linking | Teacher sees permitted classes | Effective dates |
| Student attendance | All academy records and reports | Existing attendance page | Assignment scoped |
| Staff attendance | Staff presence/absence records | No redesign required | Separate from student attendance |
| Substitute session | Grant temporary one-session access | Existing attendance page used | Exact date/session only |
| Fees/invoices | One central student invoice/payment ledger | Existing Fees page reused | Same balance and receipt |
| Expenses | New premium expense ledger | No teacher link by default | Admin-only |
| Permissions | Admin controls grants | Existing sidebar/Quick Access filtered | No subscription gate |
| Reports/analytics | Academy-wide reports | Existing teacher reports where granted | Scope enforced |
| Settings | Academy profile, categories, fee configuration | Existing teacher profile settings retained | Separate role scope |
| Audit log | Academy admin activity | No teacher access by default | Immutable events |

Also inspect and map any existing modules not listed above. Do not silently drop quizzes, notes, alerts, WhatsApp notifications, reports, import/export, storage, grading presets or other currently working teacher features. Decide whether they remain teacher-available behind an Academy Admin permission. Preserve their functionality unless the user explicitly requested removal or a direct architecture dependency must be adapted.

---

# PART J — TESTS AND ACCEPTANCE CRITERIA

Do not mark the patch complete until the following are tested. Add unit, integration, Firestore rules, API and end-to-end tests appropriate to the repository.

## J1. Registration and identity

1. First academy gets visible Academy ID 100.
2. Second academy gets 101; concurrent registrations never create duplicate IDs.
3. Expired/consumed reservation tokens cannot create another academy.
4. Academy ID cannot be changed from browser, API or direct Firestore write.
5. Public registration always creates `academy_admin`, never teacher or platform super-admin.
6. Unverified owner cannot access the Academy Admin Portal.
7. Verified owner can log in using Academy ID + email + password.
8. Wrong Academy ID/email pairing is denied without leaking another academy's membership.
9. Existing `/admin/*` platform super-admin protection remains unchanged.

## J2. Teacher creation and permissions

10. Academy Admin can create a teacher account using the trusted endpoint.
11. Client cannot create an Academy Admin or alter its own role/permissions.
12. Teacher with no permission cannot access the protected page by direct URL/API.
13. Teacher with `students.create` can add a student only within assigned scope.
14. Revoking permission blocks future API/Firestore operations promptly.
15. Deactivated teacher cannot access the academy.
16. Academy 100 teacher cannot read/write Academy 101 data.
17. Teacher Portal sidebar and Quick Access show only currently granted modules while keeping their existing visual structure.

## J3. Teacher Portal visual and functional lock

18. Capture before/after screenshots for every existing Teacher Portal page at the same viewport, theme, zoom and equivalent data state.
19. Verify there is no visual redesign: same layout, components, styles, forms, buttons, navigation style and interaction flow.
20. Verify all current Teacher Portal features still work when permissions are granted.
21. No subscription page, plan selector, upgrade banner, add-on purchase, proof-upload workflow or subscription-expired message remains in Teacher Portal.
22. Teacher route access is based on Academy Admin permissions, not plan/entitlement status.

## J4. Student synchronization

23. Admin adds a student assigned to Teacher A + Class X + Subject Y; it appears in Teacher A's existing page automatically.
24. Teacher A adds a student through the existing UI; it appears in Admin's Students page.
25. Teacher B cannot read/edit that student unless explicitly assigned/authorized.
26. Student taking multiple subjects remains one canonical profile with multiple enrolments.
27. Duplicate form submission/retry does not create duplicate students.

## J5. Attendance and substitute teacher

28. Teacher can take attendance only for assigned classes/subjects.
29. Admin can view attendance across the academy.
30. Staff absence graph uses explicit staff-attendance data and expected working schedule; missing attendance is not automatically treated as absence without that policy.
31. Admin authorizes Teacher B for a specific substitute session; Teacher B can take attendance only for that class/date/session.
32. Substitute authorization does not permanently reassign the class or grant later access.
33. Attendance corrections and substitute approvals create audit events.

## J6. Central fees

34. Student with 2–3 subjects receives one invoice containing separate subject line items.
35. Teacher payment through the existing Teacher Fees page updates the central invoice/payment ledger.
36. Admin sees the same payment and receipt immediately/after reliable refresh.
37. Admin-recorded payment updates the same balance in an authorized teacher's existing Fees page.
38. Concurrent/double payment requests cannot double collect.
39. Payment records cannot be silently deleted or edited; refunds/voids require authorized compensating entries.
40. Teacher fee metrics do not double-count a multi-subject student's invoice total.
41. Teacher can collect only if `fees.collect` is granted and the student/invoice is in scope.

## J7. Academy Expenses and analytics

42. Academy Admin can create, view, filter and report expenses.
43. Teacher cannot access Expenses without an explicitly implemented permission; default must be denied.
44. Draft/void expenses are excluded from posted expense totals.
45. Voiding a posted expense requires a reason and creates an audit event; posted financial history is retained.
46. Expense attachments are academy-private.
47. Dashboard net cash calculation uses actual collected payments minus posted expenses in the same period.
48. Dashboard graphs use persisted records/validated aggregates, not fixture data.
49. Teacher/staff attendance and student attendance are shown as distinct metrics.

## J8. Migration and regression

50. Dry-run migration reports all detected source records and conflicts.
51. Migration can be rerun without duplicates.
52. Legacy student, attendance, invoice and receipt totals reconcile before cutover.
53. Existing classes, quizzes, notes, reports, WhatsApp features, alerts and other unaffected modules pass regression tests.
54. Existing platform/SaaS Super Admin portal still works and cannot be entered by an Academy Admin without platform credentials.
55. Firestore rules emulator tests cover cross-academy and role-based access.
56. All lint, typecheck, build and relevant test commands pass in the declared Node version environment.

---

# PART K — IMPLEMENTATION WORKFLOW AND PATCH DELIVERY

Follow this order. Do not start by making UI-only changes.

## K1. Inspect and map

1. Extract the ZIP into a clean working directory.
2. Read `ARCHITECTURE_REVIEW_GUIDE.md`, package/config files, `firestore.rules`, indexes, Firebase config, `src/App.tsx`, auth flows, `AppContext`, `FeatureRoute`, `Layout`, `Dashboard`, current classes/students/attendance/fees code, all server auth helpers, API routers, Cloud Functions and tests.
3. Search the entire repository for every tenant path and subscription/entitlement check.
4. Write the requirement mapping and migration design before editing.
5. Record the baseline test/build state in a patch log.

## K2. Implement foundations first

1. Academy identity and secure ID allocation.
2. Academy owner and member model.
3. Unified login and role-aware redirects.
4. Trusted authorization helpers.
5. Firestore rules and indexes.
6. Canonical academy data repositories.
7. Migration tools and compatibility adapters.

## K3. Implement modules

1. Academy Admin shell/dashboard.
2. Teacher management and assignments.
3. Classes, subjects and student management.
4. Academy permissions.
5. Student/staff attendance and substitute authorization.
6. Central fees/invoices/payments.
7. Academy Expenses.
8. Reports/analytics and existing module integration.
9. Remove teacher-facing subscription access paths and replace their guards with membership permissions.

## K4. Preserve Teacher Portal

Before/after screenshot and code review all existing Teacher Portal routes. Change its data repository and authorization only as required. Do not restyle or rebuild pages.

## K5. Validate

- Install exact dependencies with the correct Node version and project package manager.
- Run lint, frontend typecheck, server typecheck, Cloud Functions build, Vite production build, unit tests, API integration tests and Firestore emulator rules tests.
- Run migration dry-run and reconciliation against a copy of source data.
- Run security tests for direct URL, API, Firestore, cross-academy access and privilege escalation.
- Capture visual regression screenshots for Teacher Portal.
- Do not suppress TypeScript errors, disable tests, loosen Firestore rules or insert fake data to get a green build.

## K6. Required final deliverables

Deliver all of the following:

1. A complete patched project folder.
2. A ZIP of the patched project, excluding `node_modules`, `.env`, private keys, service-account JSON and other secrets.
3. A detailed `PATCH_REPORT.md` listing every file changed/added/removed and why.
4. `ACADEMY_REQUIREMENTS_MAPPING.md` with each request mapped to UI, backend, Firebase, permissions and tests.
5. `MIGRATION_GUIDE.md` with backup, dry-run, apply, verification and rollback steps.
6. Updated Firestore rules and index definitions.
7. New/updated automated tests.
8. `TEACHER_PORTAL_VISUAL_REGRESSION.md` with before/after evidence and confirmation of no visual redesign.
9. `SUBSCRIPTION_REMOVAL_AUDIT.md` showing all teacher-facing subscription routes, UI references, API handlers, entitlement checks and quota guards removed/replaced, plus any platform-only subscription functionality intentionally retained.
10. A concise README with exact local run/build/test/deploy steps and required environment variable names (never secret values).
11. ZIP integrity verification (`unzip -t`) and a printed SHA-256 checksum.

## K7. Honest completion report

In the final response, state separately:

- Features fully implemented
- Features only partially implemented
- Migration work completed vs still requiring production data approval
- Exact tests/builds that passed
- Exact tests/builds that could not be run and why
- Any manual Firebase/Cloudflare/Vercel configuration or deployment steps still needed
- Location/name of the output ZIP

Never say “100% complete” if any requirement, test, migration or deployment step is unfinished. Do not claim data is migrated or deployed unless it was actually verified.

---

# FINAL PRODUCT SUMMARY

The completed product must behave as follows:

1. A person registers an **Academy**, receives an immutable Academy ID starting at 100 and becomes its first Academy Admin after email verification.
2. User logs in using **Academy ID + email + password**. Academy Admin enters the new Academy Admin Portal; a teacher enters the existing Teacher Portal.
3. Academy Admin gets a new premium academy-wide dashboard and modules for teachers, students, classes, subjects, assignments, attendance, fees, expenses, reports and permissions.
4. Academy Admin creates teachers and assigns classes/subjects. Teachers use the existing Teacher Portal without a visual redesign.
5. Admin controls which existing Teacher Portal pages/actions each teacher can access. The sidebar and Quick Access are filtered using the same permission source while preserving their design.
6. Teacher subscriptions, plans, add-ons and subscription entitlements no longer control Teacher Portal access. Academy Admin permissions do.
7. Admin-created and teacher-created students are synchronized as one canonical academy student record. Admin assignment makes the student appear in the assigned teacher's existing page.
8. Student attendance remains in the existing Teacher Portal workflow for authorized classes. Admin can view academy-wide records and can authorize an exact one-day substitute teacher session.
9. All subjects for one student feed into one central consolidated invoice. Payments through Admin or an authorized teacher update the same ledger and balance.
10. Academy Expenses is a separate premium Admin module. Its posted expenses feed academy financial reports and dashboard cash-flow analytics.
11. Academy data is tenant-isolated and role-secured across React routes, API handlers, Firebase Auth, Firestore rules, Cloud Functions and storage.
12. The existing Platform/SaaS Super Admin portal remains separate and secure.

**Start by inspecting the actual ZIP and mapping the current code. Then implement the complete end-to-end patch. Never substitute a mockup or a frontend-only change for the requested Academy Management System.**

---

# PART L — AUTHORITATIVE UPDATE: CLASS → SUBJECT → TEACHER → STUDENT → CENTRAL FEE FLOW

**This Part L is the latest user-approved workflow and overrides any older conflicting wording in this prompt or in earlier attendance addenda.** In particular:

- Keep the existing Teacher Portal visual interface unchanged (0% visual redesign).
- Student attendance is recorded only from the existing Teacher Portal attendance page. Do not create a separate Admin student-attendance entry page. The Academy Admin may see read-only attendance summaries, analytics and reports.
- The Academy Admin Portal has its own premium Class, Student and Fees management screens, but those screens must operate on the same canonical academy records used by the existing Teacher Portal.
- Reuse existing Teacher Portal business logic, validation, calculations, receipts and workflows wherever possible. Do not fork business rules into disconnected Admin-only copies.

## L1. Required user journey and implementation sequence

Implement and test this exact order. Do not begin with a student form that has no preconfigured class/subject/teacher options.

### Step 1 — Academy Admin creates a Class

Create a premium Academy Admin **Classes & Subjects** page. It must use the same underlying class/subject domain and repository that the Teacher Portal uses through its adapter, not a separate class database.

The Admin creation flow should be a guided, polished form/wizard:

1. **Class identity**
   - Class/section display name, e.g. `10 A`.
   - Optional grade/level and section fields if the current project supports them.
   - Academic year/term if the Academy uses it.
   - A unique Class Code generated by trusted code (for example, a human-readable code derived from class/section plus a unique suffix). Do not assume a code format already exists; inspect current conventions, define one, and enforce uniqueness server-side.
   - Class status: draft/active/archived. Do not hard-delete a class that has students, attendance, invoices, quiz or report history.
2. **Add one or more Subjects to this Class**
   - Repeatable subject cards/rows, e.g. Chemistry, Physics, Mathematics.
   - Generate a unique Subject Code for each academy/class subject offering. Prevent duplicate normalized subject names or codes within the same class/academic term unless the source model explicitly supports parallel groups.
   - Set the recurring fee for each subject offering, billing frequency and currency. Use the application's existing PKR convention unless the existing settings say otherwise.
   - Store fee amount/effective-from/effective-to as an effective-dated fee structure. A later fee change must never rewrite an already-issued invoice.
3. **Assign a Teacher to each Subject offering**
   - Each subject card must contain an **Assign Teacher** dropdown populated only from active, verified teachers who are members of this same academy.
   - Assignment is per `Academy + Class + Subject`, not merely a class-wide free-text teacher name. One teacher can teach multiple subjects; different teachers may teach different subjects in the same class.
   - Show the teacher's name, email and active status in the selector. Never accept a teacher UID/email supplied by the browser without revalidating academy membership on the backend.
   - Provide an explicit “Unassigned” draft state if the Admin wants to complete setup later; do not silently make an arbitrary teacher the owner.
   - Save assignment effective dates, status, assigning admin UID and timestamps.
4. **Review and confirm**
   - Show class code, subject list, each subject fee, and assigned teacher before saving.
   - Validate duplicate class/subject entries and missing teacher assignments according to the configured policy.
   - Save Class, Subject offerings and assignments atomically where possible, or use a trusted idempotent multi-step server operation with clear rollback/retry behaviour.

After saving, the Class and subject assignments must immediately become available in the relevant existing Teacher Portal pages. For each assigned teacher, only their assigned subjects and related enrolled students should be exposed. Preserve existing layout and page design.

### Step 2 — Class Code and Subject Codes become selectable in Student Add

The Admin Student creation screen must be designed around the pre-created Class/Subject catalogue. Do not make the Admin type free-text class or subject values when structured records already exist.

Student form sequence:

1. Enter the student's existing profile fields from the current `DepartmentsPage.tsx` form and student model. Inspect and preserve fields such as full name, father/guardian name, picture/avatar, phone/contact, roll number, gender, fee/status fields and WhatsApp consent metadata where those exist. Do not discard consent or guardian communication preferences.
2. Select the Class from active Academy Classes. Display its Class Code and academic year/section for disambiguation.
3. Load only Subjects configured under the selected Class. Let Admin select **one or multiple subjects** (e.g. from Class 11 choose Chemistry + Physics). Do not display unrelated subjects.
4. For each selected subject, automatically resolve the currently active assigned teacher from the Class-Subject assignment. Show the teacher's name. Do not ask the Admin to manually type or guess a teacher. Where the subject is intentionally unassigned, block enrollment or require an explicit authorized assignment decision; do not invent a teacher.
5. Show a clear tuition preview: selected subject names, each current monthly fee, total recurring tuition and any configured one-time charges. This preview is informational until an invoice is generated; do not silently collect money during admission.
6. Validate stable Student ID/Roll Number uniqueness according to Academy policy. Prevent duplicates by normalized identity/roll/contact rules without falsely merging siblings or students with similar names. Use a trusted uniqueness check/transaction and allow an authorized correction process for collisions.
7. Save the student once as a single canonical Academy Student profile, then save one enrolment record per selected Class-Subject pair. Store the responsible teacher assignment reference on the enrolment, not as duplicate student profiles.
8. Record `createdByUid`, `createdByRole`, `academyId`, created/updated timestamps and source (`academy_admin` or `teacher_portal`).

**Multi-subject rule:** A student studying Chemistry and Physics is one student profile with two subject enrolments. The student must appear only once in Academy-wide student totals and once in unique-student counts, while showing in each relevant subject roster. Never duplicate the profile merely to make the student appear in multiple Teacher Portals.

### Step 3 — Admin-created student synchronizes to Teacher Portal

As soon as the Admin saves the student and enrolments:

- Teacher A's existing Teacher Portal Class/Student/Attendance/Quiz/Notes/Reports pages must receive the student in the correct class and subject roster without manual re-entry.
- Teacher B must not see the student in a subject they do not teach unless Academy Admin explicitly grants a broader read permission.
- If the same teacher is assigned Chemistry and Physics, the student appears in the appropriate subject contexts without duplicate profile creation.
- Live listeners or reliable query invalidation/refetching must make changes appear promptly in an open Teacher Portal session. Handle offline/reconnect and stale-query states honestly.
- Keep the existing teacher page layout, field order, buttons and interactions visually unchanged. Adapt the repository/view model behind the page to map canonical Student + Enrolment records into the existing view model.
- The canonical record must remain Academy-scoped. Do not keep a second teacher-owned copy as the source of truth.

### Step 4 — Teacher-created student also synchronizes to Admin

Teacher student creation through the existing Teacher Portal Student form remains available only when the Academy Admin grants the relevant permission, e.g. `students.create_assigned`.

- The current teacher UI remains intact.
- Teacher must choose only classes/subjects in their own valid assignment scope. If the existing form cannot represent a class/subject selection, adapt the data adapter and only add the minimum necessary control without changing visual design or the established flow. Prefer deriving assignment from the active teacher context where unambiguous.
- A teacher cannot assign a student to another teacher's subject, change Academy ID, select another academy or grant permissions.
- Save to the same canonical Academy Student and Enrolment collections.
- The student must appear automatically in Academy Admin Students, Class rosters and Central Fees views.
- Store immutable creator/audit metadata so Admin can see which user added the student.
- Repeated submit/retry must be idempotent and must not create duplicate student or enrolment documents.

## L2. Admin Classes page and Teacher Classes page: same data, preserved Teacher UI

- Academy Admin gets a new premium Class & Subject management experience with list/grid/table views, search, filters, status badges, subject counts, assigned teacher chips, enrolled unique student counts and fee summaries.
- Admin can open a Class detail page showing subject cards, assignment, fee setup, roster count and linked academic content.
- Use existing class page/domain logic and validation where it is reliable. Extract reusable domain services/repositories if needed; do not copy/paste Firestore business logic into an unrelated Admin implementation.
- The existing Teacher Portal Classes/Departments pages remain visually unchanged and show only classes/subjects the teacher is authorized to access.
- Admin-created Class appears for its assigned teacher automatically. If one Class contains Chemistry assigned to Teacher A and Physics assigned to Teacher B, Teacher A must not get Teacher B's subject roster simply because they share the class name.
- Teacher may create a Class/Subject only if the Admin grants the precise permission (e.g. `classes.create_assigned` or `classes.create`). The new record must be saved in the same canonical catalogue. Teacher cannot assign another teacher unless a distinct permission is explicitly granted.
- Prevent duplicate class names/codes and duplicate class-subject combinations using normalized unique keys and server-side transactions.
- Archiving/deactivating a Class, Subject or Assignment must preserve historical student enrolments, attendance, invoices, quiz scores, notes and reports. Disable new enrolments/attendance according to policy without deleting history.

## L3. Student roster projection into the legacy Teacher UI

The source currently has legacy teacher-scoped class documents and embedded student arrays. The new Academy model must not keep writing a second copy of the same student as the authoritative record.

Implement a **Teacher Portal compatibility adapter**:

- Read canonical Academy Class, Subject, Assignment, Student and Enrolment documents.
- Project them into the exact types/shape expected by the existing Teacher Portal screens.
- Include only enrolments visible to the authenticated teacher under current membership and assignment/permission checks.
- Preserve legacy stable IDs, roll numbers and existing fields when reading migrated records.
- Keep write operations routed through canonical services; never let the projected legacy view write a second teacher-owned copy.
- If a legacy feature expects an array embedded under `class.students`, construct that array as an in-memory projection. It must not become a second persisted source of truth.
- Search all other modules that consume class student arrays (Attendance, Fees, Quiz, Notes, Analytics, Reports, WhatsApp notifications, import/export) and adapt their repository layer consistently.
- If a temporary projection/cache is required for performance or backwards compatibility, mark it as derived, rebuildable and non-authoritative, with a reliable invalidation strategy.

## L4. Central Fees page — class filter → student list → full fee tracking

Create a premium Academy Admin **Fees & Collections** page using the same central invoice/payment ledger as the Teacher Portal Fees page.

### Admin Fees page sequence

1. Open Fees & Collections.
2. Select a Class from a searchable Class dropdown/filter. Include academic year/section and active status to disambiguate similar class names.
3. Load only students enrolled in that Class, with filters for Subject, assigned Teacher, fee status, invoice period and overdue state.
4. Search by Student Name, Student ID/Roll Number, guardian/contact or invoice number.
5. Display a clean student list/table with profile, selected subjects, responsible teachers, monthly tuition total, extra charges, current invoice total, paid amount, outstanding balance and status. Ensure amounts are sourced from invoices/ledger and not recalculated inconsistently in the browser.
6. Clicking a student opens a detailed fee profile/drawer/page containing:
   - Student profile and class/subject enrolments.
   - Subject-wise current and historical fee structure.
   - Consolidated invoices by billing period.
   - Subject-wise invoice line items.
   - Extra charges, discounts, scholarships/adjustments (only where authorized and supported).
   - All payments/receipts with date, amount, method, reference, collector and notes.
   - Due dates, previous balance, current charges, amount paid and remaining balance.
   - Printable/downloadable invoice and receipt using the existing supported PDF/print libraries.
7. Provide filters and summary cards for total assessed/invoiced, collected, outstanding, overdue and extra charges. Distinguish these measures clearly.

### Central invoice calculation rules

- One canonical student profile; one consolidated invoice per student per billing period and configured billing account. If there are multiple subjects, each subject must be a separate line item on the same invoice.
- Example: Student X studies Chemistry (PKR 2,000) and Physics (PKR 2,500). One invoice should show Chemistry PKR 2,000 + Physics PKR 2,500 = PKR 4,500 before approved adjustments/extra charges. Do not create two unrelated fee accounts.
- Add extra charges as explicit invoice line items with title, amount, category, recurrence/one-time flag, reason, createdBy and authorization. Do not mutate tuition fees to hide extra charges.
- Apply discounts/waivers only with a permission, reason, effective period and audit event. Keep original fee/line item history.
- Store invoice line-item snapshots (subject name/code, class, teacher assignment attribution if applicable, quantity, unit amount, discount and final amount) at invoice issuance. Future fee changes affect future invoices only.
- Use a deterministic idempotent invoice identity such as academy + student + billing period + invoice cycle. Enforce uniqueness on the backend to prevent duplicates during retries or concurrent invoice generation.
- If student enrolments change during a billing cycle, use a documented effective-date/proration policy. Do not silently charge a full month for a mid-period join/withdrawal if policy says otherwise.
- Keep payment allocation and balances in one central ledger. Use transactions/server-side functions for payments and invoice updates. A receipt must refer to the canonical invoice/student/academy and authenticated collector.
- Prevent overpayment unless an explicit advance-credit rule is implemented. Never silently truncate, double-post or discard a payment.
- Corrections/refunds/voids are compensating financial entries with reason and audit history; do not delete posted receipts.

### Teacher Fees page remains exactly as it looks

- Existing `src/pages/fees.tsx` remains the teacher interface and keeps its visual design, tabs, table, receipt and workflows.
- Replace its Firestore data access with a central fee repository adapter; do not create a separate teacher fee database.
- The teacher sees only authorized student invoices/collections according to Admin-granted permissions such as `fees.view_assigned`, `fees.collect`, `fees.view_history`, and `fees.add_extra_charge`.
- A teacher records collection only through the existing Teacher Fees UI; the backend records the authenticated teacher as `collectedByUid`/collector, with timestamp and receipt reference.
- Admin sees the exact same collection in Central Fees immediately through listener/refetch.
- Admin-recorded payments must also appear in the appropriate authorized Teacher Fees view, with the real collector identity. Do not imply a teacher collected cash that the Admin collected.
- Preserve existing fee-page business rules such as arrears allocation and historical reporting only after translating them to the canonical central ledger and writing reconciliation tests. Do not drop existing features like payment history, exports/print, partial payments, status and extra-charge handling.

### Teacher and class fee analytics

On an Admin Teacher detail page, show distinct figures:

- Unique currently assigned students (deduplicated across multiple subject enrolments).
- Students and subject enrolments by class.
- Tuition assessed for the teacher's assigned subject line items, with no whole-student invoice duplication.
- Amount actually collected by this teacher (`collectedByUid`) separately from amount collected by Admin/another teacher.
- Outstanding balances attributed to assigned line items, where attribution is well-defined.

Never call attributed tuition “teacher salary” or confuse attributed fee with collected cash.

## L5. Class, Quiz, Notes and Reports configuration — both roles, exclusive owner lock

Academy Admin and Teachers may configure Classes/Subjects, Quiz content, Notes/Library resources and Report templates/settings only when their specific permission allows it. These objects must be Academy-scoped and linked to the relevant Class, Subject, academic year/term and creator.

### Core “one creator owns edits” rule

When either Academy Admin or a Teacher creates a particular Class configuration, Subject configuration, Quiz definition, Note/Library resource or Report template/configuration:

- Save `createdByUid`, `createdByRole`, `createdAt`, `ownerUid`, `ownerRole`, `updatedByUid`, `updatedAt`, `version` and an ownership/edit-lock state.
- The creator is the editor/owner of that exact resource.
- The other role/user may view it according to view permission but must not edit, overwrite, replace, rename, reconfigure or delete that same resource.
- Do not let Academy Admin silently overwrite a teacher-owned resource or a teacher overwrite an Admin-owned resource merely because of role hierarchy. This is an explicit user requirement.
- The creator may edit/archive their own resource while still authorized. A controlled ownership transfer is allowed only when the current owner explicitly initiates/approves it; record a permanent audit event. Do not offer an unapproved admin override.
- Use backend/Firestore authorization, not just disabled buttons. Direct API/Firestore attempts by a non-owner must be denied.
- Display a small “Created by [name/role] · Read only for you” indicator to non-owners. Keep Teacher Portal visual styling/layout intact; Admin may use its own premium UI.

### Duplicate prevention and collaboration semantics

- Generate a normalized uniqueness key for each resource: academyId + resourceType + classId + subjectId (if applicable) + academicTermId + normalized title/name + relevant version/scope.
- Use server transactions to prevent two users from creating the same logical resource simultaneously.
- If the same Quiz/Note/Report template already exists for that Class/Subject/term, show the existing item and its owner rather than creating a duplicate.
- The non-owner can view/use/assign/print/run the resource only where permission allows, but cannot change the protected definition/configuration.
- Separate resource definition ownership from operational actions. Example: a Teacher may administer an Admin-created quiz and enter scores only if `quiz.administer_assigned`/`quiz.results.create` is granted, but cannot change the quiz questions or total marks. Similarly, a report may be generated by another user from a locked Report template if `reports.generate_assigned` is permitted, without changing the template.
- Keep Quiz attempts/results, student scores, generated report snapshots and Notes usage logs as separate operational records linked to the source resource. They must not overwrite the owner's definition.
- Do not create duplicate Class/Subject records. If a teacher tries to create a class/subject combination that already exists, show the canonical class and assignment state, and offer a request-to-admin/ownership-transfer flow rather than a duplicate.

### Quiz module

- Admin can create quiz definitions for a Class/Subject and academic term when authorized.
- Teacher can create quiz definitions for assigned Class/Subjects only when `quiz.create` is granted.
- Existing Quiz Portal and its visual design remain unchanged for teachers. Adapt data repository to canonical academy Class/Subject/Student Enrolments.
- Quiz definition includes title/topic, subject, class, total marks, questions/rubric if current feature supports it, schedule/due date and owner.
- Teacher sees only quizzes for authorized assigned subjects, and students/marks must map to canonical Student IDs.
- Duplicate title/scope is blocked. A non-owner may administer/mark results if explicitly permitted, but cannot edit/delete the source quiz definition.
- Preserve existing quiz history, scores, PDF/report exports and WhatsApp result flows. Verify all WhatsApp notifications use academy-scoped enrolments and opt-in consent.

### Notes & Library module

- Admin or assigned Teacher can add notes/resources for Class/Subject only with `notes.create` or relevant permission.
- Each resource has title, type, description, subject/class scope, file/link metadata, storage path, creator/owner, created date and visibility.
- Use academy-private storage access and validate access on signed URL/API retrieval. Never expose private R2/storage objects through guessed public URLs.
- Existing Notes page and Teacher Portal styling remain unchanged. Adapter filters resources by the teacher's assignments and permissions.
- Non-owner can open/download/use resources only if permitted, but cannot edit/replace/delete owner metadata or files.
- Prevent duplicate logical note titles/resources within the same subject/term unless intentionally versioned.

### Reports module

- Admin can configure Academy-wide or class/subject Report templates/settings if their role allows it.
- Teacher can configure a Report template for assigned class/subject only if `reports.configure_assigned` is granted.
- Existing Teacher Reports page remains visually unchanged. Preserve monthly reports, PDF generation, WhatsApp dispatch, status/retry flows and report hashes/history where currently implemented.
- Template/config owner lock applies. Another user may generate a report from the template if `reports.generate_assigned` is granted, but may not alter the protected template.
- Generated report content must use canonical student, attendance, quiz and fee records allowed for the requesting user. Never broaden access just because a Report template is Academy-wide.
- Keep generated snapshots immutable or versioned so later template changes do not rewrite prior issued reports.

## L6. Academy permissions and navigation for this workflow

Use Academy Admin-granted permissions, not subscription entitlements. Permission keys should be explicit, scoped and independently revocable. At minimum consider:

- `classes.view_assigned`, `classes.create`, `classes.create_assigned`, `classes.edit_owned`, `classes.archive_owned`, `subjects.create`, `subjects.edit_owned`
- `assignments.view_assigned`, `assignments.manage` (Admin only by default)
- `students.view_assigned`, `students.create_assigned`, `students.edit_assigned`, `students.archive_assigned`
- `fees.view_assigned`, `fees.collect`, `fees.view_history`, `fees.add_extra_charge`, `fees.apply_discount` (default Admin only)
- `quiz.view_assigned`, `quiz.create`, `quiz.administer_assigned`, `quiz.results.create`, `quiz.edit_owned`, `quiz.delete_owned`
- `notes.view_assigned`, `notes.create`, `notes.edit_owned`, `notes.delete_owned`
- `reports.view_assigned`, `reports.configure_assigned`, `reports.generate_assigned`, `reports.dispatch_assigned`

Do not implement broad permissions like `all: true` if the current role/permission model supports safer granular permissions. Admin portal navigation can show all Admin modules according to Academy Admin role; Teacher Sidebar and Quick Access must retain their existing design and list only allowed features. A direct URL/API call must be denied if permission is missing.

## L7. Academy Admin experience polish and useful additions

Polish the Admin workflow without changing the Teacher Portal:

- Use a guided stepper for Class creation and Student admission, with progress, validation, review and save confirmation.
- Provide searchable dropdowns, clear helper text, subject chips, active teacher status and inline fee previews.
- Make table rows/cards clickable and show detailed drawers/pages with history.
- Add search, filters, sorting, pagination and sensible bulk actions. Bulk operations must show a preview and confirmation and must use bounded batched writes.
- Add class/subject/student counts, unassigned-subject alerts, students with no subject enrollment, enrollment mismatch warnings and duplicate warnings.
- Provide admission confirmation and a student profile with class/subject/teacher enrolments, invoice history and attendance/academic report links.
- Add CSV/Excel import/export only by extending the existing tested import/export paths; include dry-run preview, row validation, duplicates report, failed-row download and idempotent import.
- Add audit timeline for admission, enrolment changes, teacher assignment changes, fee changes, invoice issuance, payments, refunds, Quiz/Notes/Report ownership and permission changes.
- Provide loading skeletons, empty states, error states, retry, success toast, offline state and responsive design. Do not ship mock chart values or sample students.
- Keep destructive actions soft-delete/archive by default. Never delete financial/attendance/quiz/report history through a simple student/class delete.
- Use accessible labels, keyboard-operable dropdowns/dialogs and clear validation messages.

## L8. Data model requirements for this flow

Before implementation, inspect existing types and data; adapt the naming if the repository already contains suitable types. The logical entities must be normalized and academy-scoped, with stable IDs:

- `academies/{academyId}` — academy metadata and immutable public Academy ID.
- `academies/{academyId}/members/{uid}` — role, status and granular permissions.
- `academies/{academyId}/classes/{classId}` — class identity/code, academic period, status, creator/owner metadata.
- `academies/{academyId}/classes/{classId}/subjects/{subjectId}` — subject name/code, fee structure reference, status, creator/owner.
- `academies/{academyId}/assignments/{assignmentId}` — classId, subjectId, teacherUid, effective dates, status, assignedBy.
- `academies/{academyId}/students/{studentId}` — one canonical profile.
- `academies/{academyId}/enrolments/{enrolmentId}` — studentId, classId, subjectId, teacherUid/assignmentId, effective dates, status, agreed fee reference/snapshot.
- `academies/{academyId}/feeStructures/{feeStructureId}` — subject/class fee amount, frequency, effective dates, version.
- `academies/{academyId}/invoices/{invoiceId}` — one consolidated student billing document per period/cycle, status and totals.
- `academies/{academyId}/invoices/{invoiceId}/lines/{lineId}` or equivalent stable line-item structure.
- `academies/{academyId}/payments/{paymentId}` — central payment ledger and collector attribution.
- `academies/{academyId}/resources/{resourceId}` or clearly separated resource collections for Quiz definitions, Notes and Report templates with ownership-lock metadata.
- `academies/{academyId}/auditLogs/{eventId}` — immutable audit trail.

This is a logical target, not permission to blindly relocate or delete old data. Choose a migration-safe final layout, add indexes, and document why. Maintain immutable legacy IDs and mapping tables so old attendance/fees/quiz/report references can be reconciled. Do not use a normalized email as the permanent academy tenant ID.

## L9. Security and consistency requirements

- Resolve academy membership and role from verified Firebase Auth identity plus trusted backend membership records. Do not trust an `academyId`, `teacherUid`, `ownerUid`, permission array or role sent by browser without verification.
- All reads/writes enforce academy isolation and class-subject assignment scope.
- A teacher may only see enrolments assigned to them or explicitly broadened by Admin permission.
- Payment, invoice generation, class/subject assignment, student enrolment, duplicate checks and ownership lock operations require trusted transactions/server-side validation.
- Enforce resource owner locks in Firestore Rules and backend functions; frontend `disabled` state is not enough.
- Use server timestamps, stable IDs, transaction conflict handling, idempotency tokens and audit records.
- Firestore documents should not exceed size limits. Do not keep growing student arrays in Class documents as the canonical structure.
- Add compound indexes for common queries by academy/class/subject/teacher/student/status/period.
- Prevent a change in a student's teacher assignment from changing old invoices, payments, attendance records or quiz results.

## L10. Required additional acceptance tests

Add automated tests that cover all of the following:

### Class setup and assignments
1. Admin creates Class `10 A` and gets a unique Class Code.
2. Admin adds Chemistry and Physics as distinct subject offerings with their own Subject Codes and fees.
3. Assign Chemistry to Teacher A and Physics to Teacher B; both dropdown options come from active members of the same Academy only.
4. Teacher A sees Chemistry only; Teacher B sees Physics only; neither can access the other's roster by changing URL or request payload.
5. Duplicate class code, duplicate subject code and duplicate same-class subject setup are rejected atomically.
6. A teacher without class-create permission cannot create a class. A permitted teacher can create only within the allowed scope and cannot assign an unauthorized teacher.

### Student admission and synchronization
7. Admin adds one student to Class 11 with Chemistry and Physics; exactly one canonical Student profile and two enrolment records are created.
8. Chemistry Teacher sees the student in the existing Teacher Portal Chemistry roster; Physics Teacher sees the same canonical student in Physics roster.
9. Teacher-created student appears in Admin Students without duplicate profile.
10. Duplicate roll number conflict is shown clearly; two legitimate siblings with similar names are not automatically merged.
11. Unassigned subject cannot receive an enrolment until the required teacher assignment policy is satisfied.
12. Student archive/withdrawal preserves attendance, invoices, payments, quiz results and reports.

### Fee integrity
13. Student with two subjects receives one invoice with two subject line items and the correct total.
14. Adding a one-time extra charge creates a separate line item and leaves tuition fee structure unchanged.
15. Changing a subject fee next month does not rewrite previous invoice totals.
16. Admin payment and Teacher payment appear in the same central ledger and use correct collector identities.
17. A duplicate submit/retry cannot create two invoices or two payments.
18. Overpayment, stale invoice, cross-academy payment and concurrent payment requests are rejected safely or handled by the documented advance-credit policy.
19. Multi-subject student counts and attributed tuition are not double-counted in Admin dashboards/teacher analytics.

### Quiz, Notes and Reports ownership
20. Admin creates Quiz Q; Teacher can view/administer only if allowed, but cannot edit/delete/replace Q.
21. Teacher creates Quiz R; Admin can view it but cannot silently edit/delete it.
22. Duplicate Quiz title/class/subject/term is rejected and existing owner/resource is shown.
23. Same ownership-lock rule applies to Class/Subject configuration, Notes and Report templates/configs.
24. The owner can edit their own resource while authorized; the other party's direct API/Firestore attempt is denied.
25. Ownership transfer works only with current owner's explicit approval and creates an audit event.
26. A permitted non-owner can generate a report or administer a locked quiz without changing its definition.

### Attendance and existing UI
27. Student attendance can be recorded only from the existing Teacher Portal attendance page. No Admin student-attendance entry page is exposed.
28. Admin may view read-only attendance metrics/reports sourced from the same records.
29. Substitute authorization works only for the exact class/subject/date/session and is consumed/expired according to policy.
30. Teacher Portal visual regression is clean: same visual layout, forms, sidebar and Quick Access at matched viewports. Only the underlying data/authorization behavior changes.

---

# PART M — FINAL IMPLEMENTATION ORDER FOR THE UPDATED WORKFLOW

Use this exact dependency sequence so no page is built on incomplete data:

1. **Repository audit and baseline:** map all existing class/student/attendance/fees/quiz/notes/report read/write paths, identify embedded student arrays and teacher-email tenant paths, and record baseline tests.
2. **Academy identity and membership:** ensure all later records have a verified academy scope and authenticated UID.
3. **Canonical Class/Subject catalogue:** implement class codes, subject codes, fee structures and class-subject teacher assignments.
4. **Teacher assignment adapter:** make existing Teacher Portal Class lists show only permitted assigned class/subject records without visual changes.
5. **Canonical Student and Enrolment:** implement the one-student-many-subject model with stable IDs, profile migration and duplicate protection.
6. **Admin Student admission wizard:** connect its class dropdown to the canonical catalogue; subject list filters by class; teachers derive from subject assignments; tuition preview uses fee structures.
7. **Teacher Student creation adapter:** preserve existing form and save to the same canonical Student/Enrolment model; enforce Admin permissions.
8. **Live synchronization:** verify Admin-created students appear in the existing Teacher Portal and teacher-created students appear in Admin, with no duplicated records.
9. **Central invoice/payment ledger:** build one consolidated invoice per student and billing period with subject line items and extra charges. Then adapt the existing Teacher Fees page without visual changes.
10. **Quiz/Notes/Reports repository migration:** preserve current pages and flows; add Academy scope, teacher assignment filters, ownership/edit locks, operational permissions and duplicate prevention.
11. **Student attendance adapter:** preserve the existing Teacher Portal attendance UI and its workflow, but use canonical roster/assignment data. Admin gets read-only analytics only.
12. **Academy Admin polish:** class/student/fees detail screens, filters, guided flows, charts based on real data, audit timeline and exports.
13. **Migration/reconciliation:** run dry-run first; compare old and new class rosters, unique student counts, attendance counts, fee invoices, receipts and quiz/report references. No cutover until reconciliation is explained and approved.
14. **Security/regression:** run all tests, Firestore emulator rules, direct API attacks, cross-academy tests, owner-lock tests, concurrency tests and visual regression.
15. **Delivery:** final patched source ZIP, SHA-256, patch report, requirement mapping, migration/rollback instructions and honest test evidence.

# FINAL ACCEPTANCE SCENARIO — MUST WORK END TO END

Use the following concrete scenario in an automated integration test or a documented staging walkthrough:

1. Academy Admin logs in to Academy 100.
2. Admin creates `Class 11`, system generates its unique Class Code.
3. Admin adds Chemistry (PKR 2,000/month) and assigns it to Teacher A.
4. Admin adds Physics (PKR 2,500/month) and assigns it to Teacher B.
5. Admin adds Student Ali, enters profile/photo/contact/roll number, selects Class 11, then selects Chemistry + Physics.
6. The system resolves Teacher A for Chemistry and Teacher B for Physics and saves one canonical student with two enrolments.
7. Teacher A logs in and sees Ali in the existing Teacher Portal Chemistry roster and existing Attendance page. Teacher A does not see Physics-only management controls or other unauthorized students.
8. Teacher B logs in and sees the same Ali student identity in the existing Physics roster. There is not a second Ali profile.
9. One central invoice is created for Ali: Chemistry PKR 2,000 + Physics PKR 2,500 = PKR 4,500, plus separately itemized authorized extra charges if any.
10. Teacher A collects PKR 2,000 through the existing Teacher Fees page. The central invoice shows PKR 2,000 paid and PKR 2,500 outstanding; Admin sees the same receipt with Teacher A as collector.
11. Admin collects the remaining PKR 2,500 from the central Admin Fees page. The invoice becomes fully paid; the teacher's authorized fee view reflects the same balance and payment history with Admin as collector.
12. Teacher A takes student attendance for the authorized Chemistry teaching session using the unchanged existing Teacher Portal Attendance page. Admin dashboard/report can show the resulting read-only attendance metric; Admin has no separate student-attendance marking screen.
13. Admin creates a Quiz definition for Class 11 Chemistry. Teacher A can administer/record results if permission is granted, but cannot edit the Admin-owned quiz definition. Teacher B cannot access it unless explicitly assigned.
14. Teacher A creates a Chemistry Note or Report template. Admin can view it if allowed but cannot edit/delete the teacher-owned definition unless Teacher A explicitly transfers ownership.
15. No record is duplicated; all updates are academy-scoped, permission-checked, auditable and reflected in both portals.

