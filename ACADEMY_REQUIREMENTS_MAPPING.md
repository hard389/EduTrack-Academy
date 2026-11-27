# EduTrack Academy — V2 Requirements Mapping Matrix

**Mapping coverage:** Parts A–M of the supplied V2 master prompt are mapped below. This means the requirements have been accounted for in the matrix; it does **not** mean every requirement is fully implemented. Status is explicit per area.

Status key:
- **Implemented (patch scope):** code path exists in this patch; still subject to environment/staging verification.
- **Partial:** a first working layer exists, but one or more required workflows/security/migration/regression details remain.
- **Not implemented:** not delivered in this patch.
- **Preserved / isolated:** existing functionality intentionally left in place or kept behind its existing boundary.

| Requirement | Academy Admin route/page | Existing Teacher Portal route/page | Frontend files | Backend/API / Firebase | Permission | Tests / migration | Status |
|---|---|---|---|---|---|---|---|
| Platform/SaaS Super Admin remains separate | Existing `/admin/*` | None | `src/pages/admin/*`, `AdminRouteGuard` unchanged | Existing platform admin handlers/custom claim retained | `admin === true` | Regression not fully run | Preserved / isolated |
| Academy registration and owner membership | `/register` (Academy registration) | None | `src/pages/RegisterPage.tsx` | Problem 1 Academy identity API/domain | Server-derived owner | Problem 1 tests | Implemented by prior patch; integration not re-run here |
| Academy ID allocation from 100, immutable | Registration success state | None | `RegisterPage.tsx` | Problem 1 transaction/counter and lookup | Trusted server only | Problem 1 domain tests | Implemented by prior patch; production concurrency not tested |
| Academy ID + email + password login / role redirect | Unified login; `/academy-admin/*` or `/dashboard` | `/login` | `LoginPage`, `LoadingPage`, auth guards | Problem 1 Academy identity/session APIs | Verified membership | Needs full browser/staging verification | Partial / prior patch |
| Academy Admin premium shell | `/academy-admin/*` | Existing Teacher `Layout` | `src/pages/academy-admin/AcademyAdminLayout.tsx`, `AcademyAdminUI.tsx`, `src/App.tsx` | Academy management API | `academy_admin` membership | Domain/API tests limited | Partial |
| Academy dashboard with persisted data | `/academy-admin/dashboard` | Existing Teacher dashboard untouched except access-filtered Quick Access | `AcademyAdminOverview.tsx`, `Dashboard.tsx` | `getAcademyDashboard` | Academy Admin | No browser/date-filter test | Partial |
| Teacher management | `/academy-admin/teachers` | Existing teacher profile/settings | `AcademyTeachersPage.tsx` | list members, update permissions, prior teacher create API | Academy Admin | API integration incomplete | Partial |
| Central permission manifest | `/academy-admin/permissions` | Existing sidebar / Quick Access | `useAcademyAccess.ts`, `Layout.tsx`, `Dashboard.tsx`, `AcademyPermissionRoute.tsx` | `server/academyManagementDomain.mjs`, `server/academyManagement.ts`, subscription entitlement adapter, Firestore rules | Per-key grants; least privilege | 62 focused tests pass | Implemented (first layer) |
| Hide unauthorized existing Teacher nav items without redesign | N/A | Existing sidebar and Quick Access | `Layout.tsx`, `Dashboard.tsx` | Membership permissions from session endpoint | Same manifest | Screenshot comparison not run | Partial; intended visual structure retained |
| Teacher direct route protection | N/A | Existing feature routes | `FeatureRoute.tsx`, `AcademyPermissionRoute.tsx`, `App.tsx` | API checks/rules also updated | Per-page permission | Focused tests | Partial; not all APIs independently mapped |
| Remove teacher subscription access control | `/admin/*` platform subscriptions intentionally retained | `/subscription` redirects to `/dashboard` | `App.tsx`, `AppContext.tsx`, `FeatureRoute.tsx`; old teacher page deleted | Teacher subscription endpoints removed; membership grant adapter used | Academy grants, not SaaS plan | Subscription contract tests | Implemented for the audited teacher UI/API surface; full repo grep/audit documented |
| Existing student create form uses canonical backend | `/academy-admin/students` | Existing Departments student form | `AcademyStudentsPage.tsx`, `DepartmentsPage.tsx` | `createAcademyStudent`, teacher adapter | `students.create` / assignment scope | Domain and route tests | Partial; teacher edit/delete remain legacy |
| Admin Class catalogue | `/academy-admin/classes` | Existing Classes/Departments | `AcademyClassesPage.tsx` | `createAcademyClass`, class and subject collections | Academy Admin | Class-subject model unit tests limited | Partial |
| Per-subject assignment to different teachers | Class wizard per subject | Teacher gets assigned subject projection | `AcademyClassesPage.tsx`, legacy roster adapter | `teacherAssignments`, class/subject docs | Same Academy active verified teacher | Not full multi-teacher E2E | Partial |
| Subject codes, fee terms and effective dating | Class wizard | Teacher class context | `AcademyClassesPage.tsx` | Subject docs and fee snapshot fields | Admin | Concurrency/index tests not complete | Partial |
| Single canonical student + multiple subject enrolments | `/academy-admin/students` | Existing roster projection | `AcademyStudentsPage.tsx`, `DepartmentsPage.tsx` | `academies/{id}/students`, `studentSubjectEnrollments` | `students.*`, assignment checks | Domain tests; no emulator concurrency | Partial |
| Admin-created student auto appears in existing teacher page | Student wizard | Existing Class/Departments roster | `AcademyStudentsPage.tsx`, `DepartmentsPage.tsx` | Legacy compatibility class projection from canonical student/enrolment | Assigned teacher only | Full live-listener E2E not run | Partial; persisted projection remains |
| Teacher-created student syncs to Admin | N/A | Existing Departments form | `DepartmentsPage.tsx`, `academyApi.ts` | Canonical teacher student endpoint | `students.create` + assigned scope | Route tests | Partial; legacy form fields need broader verification |
| Student duplicate protection / stable IDs | Student wizard | Existing student form | Admin and teacher forms | Transaction/idempotency logic; roll/student ID checks | Server-side | Domain tests | Partial; sibling false-match scenarios not comprehensively tested |
| Student attendance stays on existing Teacher page | Read-only `/academy-admin/reports` | Existing Attendance page | Existing `attendance.tsx`; `AcademyReportsPage.tsx` | Current legacy attendance writes; Academy read-only report collections | `attendance.take_assigned`, report scope | No end-to-end migration | Partial; canonical attendance adapter not complete |
| Admin attendance view is read-only | `/academy-admin/reports` | Existing attendance UI | `AcademyReportsPage.tsx` | read-only report query | Academy Admin | Not tested against emulator | Partial |
| Staff attendance | No complete page/workflow | No teacher redesign | None | Collection not fully wired | Not implemented | No tests | Not implemented |
| Temporary substitute session | No page/workflow | Existing Attendance intended for future use | None | No complete substitute authorization endpoint | `attendance.substitute_session` reserved | No tests | Not implemented |
| Central consolidated invoice per student/month | `/academy-admin/fees` | Existing Fees page | `AcademyFeesPage.tsx`, `fees.tsx` | `feeInvoices` with subject line item snapshots | `fees.issue_invoice`, view permissions | Domain tests; central API partial | Partial |
| Fee collection by teacher and admin same ledger | `/academy-admin/fees` | Existing `fees.tsx` | `AcademyFeesPage.tsx`, `fees.tsx` | transaction-based payment endpoint; collector identity/idempotency | `fees.collect`, assigned scope | Domain tests; UI E2E incomplete | Partial; legacy fee fallback remains |
| Receipt immutability/refund/void compensating entries | Fee detail | Existing fee history | Current fee pages | Payment writes present; full corrections/refunds not implemented | Dedicated financial grants | No full transaction race test against Firestore | Partial / not complete |
| Extra charges, discounts and fee adjustments | Fees page | Existing fee UI | `AcademyFeesPage.tsx`, `fees.tsx` | Invoice snapshot supports extras; extra-charge permission guard | `fees.adjust` etc. | Limited unit coverage | Partial |
| Academy Expenses | `/academy-admin/expenses` | No teacher page/link | `AcademyExpensesPage.tsx` | `expenses` collection create/edit-draft/void with audit fields | Academy Admin | Domain tests limited; no storage tests | Partial |
| Expense receipts/attachments and categories | Expenses page | None | Page supports core form only | Secure attachments/configurable categories not complete | Admin | No tests | Not implemented |
| Academy-wide reports and analytics | `/academy-admin/reports` | Existing teacher reports retained | `AcademyReportsPage.tsx` | Read-only report endpoint | Admin / teacher report grants | No real-data E2E | Partial |
| Quiz definition ownership locks | Future Admin/Teacher resource management | Existing Quiz page | Existing quiz page unchanged | No full canonical owner lock/transfer model | `quiz.*` permission exists but not ownership | No tests | Not implemented |
| Notes/Library ownership locks | Future Admin/Teacher resource management | Existing Notes page | Existing Notes page unchanged | No canonical owner lock/transfer model | `notes.*` permissions | No tests | Not implemented |
| Report template ownership locks | Future Admin/Teacher resource management | Existing Reports page | Existing Reports page unchanged | No canonical owner lock/transfer model | `reports.*` permission | No tests | Not implemented |
| Owner-approved transfer / immutable audit | N/A | No visual changes | None | Not implemented for class/quiz/note/report resources | Owner approval required | No tests | Not implemented |
| Legacy data dry-run migration | Admin-only/offline tooling to be built | Existing workspaces preserved | No migration CLI supplied | Existing teacher-workspace records are not bulk moved | Explicit owner mapping | No production data supplied | Not implemented; manual migration approval required |
| Firestore tenant isolation | N/A | Existing routes | Firestore rules changed | Active verified membership, permission helpers, canonical docs server-owned | Rules + API | No emulator run | Partial; emulator verification required |
| Cloud Functions and external integrations | Existing services | Existing WhatsApp flows remain | Some functions changed to remove subscription wording/gates | More legacy services need per-endpoint audit | Permissions where adapted | Build unavailable | Partial |
| Teacher Portal visual regression | N/A | Existing pages preserved in code where possible | Teacher UI changes mostly access/data-only | N/A | Permission visibility | No screenshot capture environment | Not verified |
| Acceptance scenario: Class 11 Chemistry/Physics, Teacher A/B, Ali, PKR 4,500, split payments | Classes, Students, Fees pages | Existing teacher roster/fees/attendance | New Admin pages + adapters | Per-subject assignments, one student with multiple enrolments, one invoice/payment endpoint | Admin + assigned teachers | Not executed as full staging scenario | Partial; not certified end-to-end |

## Requirement sections accounted for

- Parts A–B: existing architecture, role separation and route layout.
- Part C: registration, Academy ID and verification (delivered in Problem 1 baseline; not reimplemented here).
- Part D: Admin dashboard, teachers, classes, students, attendance reporting, central fees, expenses and permissions.
- Part E: teacher subscription gate removal while retaining platform subscription operations.
- Part F: canonical Academy collection direction and legacy compatibility.
- Part G: backend auth, API and Firestore security.
- Part H: data migration safety; migration intentionally not executed.
- Part I: page/requirement mapping.
- Part J: tests and acceptance gaps.
- Part K: implementation/delivery workflow.
- Part L: Class → Subject → Teacher → Student → Fees sequence.
- Part M: fee scenario, role/ownership locks, reports/notes/quiz, attendance and migration acceptance.

## Release gate

Do not call the system production-complete until all `Partial` and `Not implemented` items are completed, verified with the correct Node version, Firebase Emulator, browser visual-regression and a staging data set. This matrix is the 100% requirement-mapping index, not a 100% implementation claim.
