# Academy Admin ↔ Teacher Portal Synchronization Patch

Patch date: 2026-11-25

## Purpose

Connect the existing Academy Admin canonical records to the existing Teacher Portal Firebase workspace without redesigning Teacher Portal pages. The Academy collections remain the source of truth for class, subject, teacher assignment, student, subject-enrolment, attendance, quiz, report and Academy notification records. The existing `users/{teacherEmail}` workspace remains a compatibility projection for the current Teacher Portal UI.

This patch covers synchronization for the requested workflow. It is **not** a certification that every requirement in `ACADEMY_REQUIREMENTS_MAPPING.md` is complete or production-ready; see the release gates and limitations below.

## Data ownership and paths

### Canonical Academy data

- `academies/{academyId}/classes/{classId}`
- `academies/{academyId}/subjects/{subjectId}`
- `academies/{academyId}/teacherAssignments/{assignmentId}`
- `academies/{academyId}/students/{studentId}`
- `academies/{academyId}/studentSubjectEnrollments/{enrollmentId}`
- `academies/{academyId}/studentAttendance/{attendanceId}`
- `academies/{academyId}/quizzes/{quizId}`
- `academies/{academyId}/studentReports/{reportId}`
- `academies/{academyId}/notifications/{notificationId}`
- `academies/{academyId}/teacherNotifications/{notificationId}`
- `academies/{academyId}/integrationIssues/{issueId}`

### Existing Teacher Portal compatibility paths

- `users/{teacherEmail}/classes/{classId}` (existing class/student projection)
- `users/{teacherEmail}/classes/{classId}/quizzes/{quizId}`
- `users/{teacherEmail}/classes/{classId}/reports/{reportId}`
- `users/{teacherEmail}/attendance/{attendanceId}`
- `users/{teacherEmail}/notifications/{notificationId}`

The synchronization functions preserve these paths so the existing Teacher Portal screens can continue to use their current Firestore shape.

## Implemented synchronization

### Academy → Teacher

1. Changes to canonical students and subject enrolments rebuild the relevant teacher's class projection from active subject enrolments.
2. Changes to class, subject or teacher assignment rebuild affected teacher class projections.
3. A student is projected only to teachers who have an active assignment for a subject in that class and an active enrolment for that student/subject.
4. Each projected student carries canonical identifiers (`canonicalStudentId`, `academyId`, `academySubjectIds`) to keep the relationship stable.
5. Academy-created quizzes are projected into the assigned teacher's existing nested `quizzes` collection. Admin-origin quiz records are protected from teacher-side overwrite.
6. Published Academy alerts are copied to the relevant verified teacher workspaces. The target audience can be Academy, class or subject. Archived alerts are marked archived in teacher workspaces.

### Teacher → Academy

1. An edit to the existing teacher class roster is validated against the active teacher's assigned enrolments before allowed student profile fields are copied to the canonical student record.
2. Teacher attendance is validated against the active subject roster and written to canonical `studentAttendance`.
3. Teacher quizzes are validated against the active subject roster and written to canonical `quizzes`.
4. Teacher student reports are mirrored to canonical `studentReports` only for an actively assigned/enrolled student.
5. Teacher-created notifications are mirrored to canonical `teacherNotifications`; Academy-origin notifications and WhatsApp operational records are not echoed back.
6. Invalid or ambiguous records are recorded in `integrationIssues` rather than guessed into another subject or student.

## Permission enforcement

The former unconditional core-module permission bypass has been removed from the Academy feature resolver, Teacher app context, Teacher route access resolver and Firestore feature checks. Teacher module access now depends on the exact mapped permission being explicitly granted by an Academy Admin.

The Firestore rules additionally gate:

- class workspace reads by relevant assigned module permissions;
- student roster edits by `students.edit_assigned` or `students.manage_all`;
- attendance reads/writes by the corresponding attendance permission;
- quiz writes by `quiz.manage_assigned` and prevent teacher edits to `sourceType: academy_admin` quiz projections;
- report access by `reports.view_assigned`;
- notification reads by `alerts.view`, with Academy-origin notifications restricted to read-state changes.

UI navigation hiding is not treated as security. Server-side trigger checks and Firestore rules perform the access checks too.

## Existing UI preservation

No new Teacher Portal design or page layout was introduced. The Quiz page now listens to its existing class and quiz collections in real time. The Alerts page now listens to its existing notifications collection in real time. Existing routes and collection shapes are retained.

## Important constraints / known gaps

1. **Subject selection in old Teacher UI:** the current Attendance and Quiz screens select a class but do not expose a subject selector. If one teacher is assigned multiple active subjects in the same class, the synchronization trigger will pause attendance/quiz sync and create an `integrationIssues` entry (`teacher_subject_selection_required`). It will not guess a subject. The requested case—Chemistry assigned to Teacher A and Physics assigned to Teacher B—works because each teacher has one subject in that class.
2. **Legacy historical records:** this patch adds write-trigger synchronization; it does not bulk backfill every old attendance, quiz or report document already stored in legacy teacher collections. Do not run an unreviewed mass rewrite against production. A reviewed dry-run migration is required for historical data.
3. **Admin report detail UI:** canonical student report records and analytics counts are wired, but this patch does not invent a new Admin report-detail screen where the source project has only a read-only/report-summary surface.
4. **Attendance detail UI:** canonical attendance records are synchronized, and existing admin read/query capabilities remain; this patch does not add a new Admin attendance editing UI.
5. **Alert dispatch:** publishing an Academy alert creates Teacher Portal notifications. It does not send WhatsApp/SMS messages. Those are separate provider workflows and require their own consent, credentials and delivery verification.
6. **Scale limits:** roster projection uses explicit query/document safety limits and records an integration issue instead of writing a partial roster. Admin alert publication is capped at 50 verified teacher recipients per publish operation.
7. **Production validation:** Firebase Emulator tests, full TypeScript build, browser visual regression and staging end-to-end testing have not been run in this patch environment. See `APPLY_TEACHER_PORTAL_SYNC_PATCH.md` before deployment.

## New Cloud Functions exports

`src/functions/src/academyPortalSync.ts` defines the synchronization triggers and `src/functions/src/index.ts` exports them:

- `syncAcademyStudentToTeacherPortals`
- `syncAcademyEnrollmentToTeacherPortals`
- `syncAcademyTeacherAssignmentToTeacherPortal`
- `syncAcademyClassToTeacherPortals`
- `syncAcademySubjectToTeacherPortals`
- `syncTeacherRosterEditsToAcademy`
- `syncTeacherAttendanceToAcademy`
- `syncTeacherQuizToAcademy`
- `syncAcademyQuizToAssignedTeacher`
- `syncTeacherReportsToAcademy`
- `syncTeacherNotificationsToAcademy`

`firebase.json` already runs the Functions TypeScript build as a predeploy step, so no separate Functions source setting is required.

## Verification performed while preparing the patch

- `node --test tests/academy-core-module-access.test.mjs`: 2 tests passed.
- TypeScript/TSX syntax transpilation for the changed `.ts` and `.tsx` files: passed.
- Full `npm run typecheck`, production build, Firebase Emulator/rules tests and browser end-to-end tests: **not completed**. The uploaded project requires Node `22.22.2`; the patch environment had Node `22.16.0`. The Functions dependency install timed out and left incomplete `node_modules`, so the full compiler and emulator checks could not be run.

Do not treat the two focused tests as a production release sign-off.
