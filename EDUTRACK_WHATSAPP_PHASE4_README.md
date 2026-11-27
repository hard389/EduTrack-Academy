# EduTrack WhatsApp Automation — updated source files

This update adds consent recording, server-side attendance notification sending, automatic individual PDF reports, and a manual retry action for monthly reports.

## What the code does

1. The student form records `parentWhatsAppOptIn` and `parentWhatsAppOptInAt`. The checkbox starts unchecked for a new student and is only to be selected after the guardian has explicitly agreed. Unticking it records withdrawal.
2. When the existing attendance page creates a saved attendance document under `users/{tenantId}/attendance/{classId}_{YYYY-MM-DD}`, `queueAbsentAttendanceNotifications` creates idempotent jobs for absent students. It uses the same embedded roster and student IDs as the current attendance page.
3. `sendQueuedAbsentAttendanceNotification` re-reads the roster and consent immediately before attempting the approved template. A job is marked `accepted_by_meta` only when Meta returns a message ID. That status is **not** proof of delivery/read.
4. When the monthly report saving flow writes a complete `mode: "automatic"` report document, `autoSendMonthlyStudentReportWhatsApp` creates an individual PDF from the saved report and submits it with the approved document-header WhatsApp template, provided the current student roster has a guardian phone and explicit consent.
5. The Reports Dashboard has a manual send/retry action. It also checks server-side consent and monthly duplicate status. The backend generates the individual PDF from the saved Firestore report; the browser cannot supply different PDF bytes or choose a different recipient number.
6. The old general `alerts.tsx` announcement sender intentionally remains a simulation. It is not converted into a free-form WhatsApp sender, because business-initiated messages must use appropriate approved templates and this file does not establish a suitable approved template for arbitrary alert text.

## Important configuration boundary

Vercel environment variables are **not** automatically available to Firebase Cloud Functions. The WhatsApp sender is server-side Firebase Functions code, so its configuration must be set for Firebase Functions separately.

### 1. Configure non-secret parameters

Copy the example file in the Functions source directory:

```bash
cp src/functions/.env.edutrack-academy.example src/functions/.env
```

Fill in the production `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_BUSINESS_ACCOUNT_ID` from the correct Meta WhatsApp account. Do not use the test phone-number ID. Set the API version and language codes to the current values shown for the account/templates in Meta. `.env` is ignored by Git.

For each template, inspect its exact approved BODY text. Set `WHATSAPP_ATTENDANCE_TEMPLATE_PARAMETER_ORDER` and `WHATSAPP_MONTHLY_REPORT_TEMPLATE_PARAMETER_ORDER` to the field names in the exact order corresponding to `{{1}}`, `{{2}}`, etc. For example, if the first two body placeholders of a template mean student name and class name, set `studentName,className`. If a template has no BODY placeholders, leave its parameter-order value empty. If the configured number/order differs from the approved template, the code fails closed instead of sending incorrectly ordered personal data.

Allowed fields are: `studentName`, `fatherName`, `rollNo`, `className`, `date`, `month`, `category`, `remarks`, `quizScore`, `attendanceRate`, `feeStatus`, `homeworkGrade`, `behaviorGrade`, `participationGrade`, `performanceGrade`, `academyName`, and `teacherName`.

The monthly report template must be approved and include a **DOCUMENT** header. Both templates must have status `APPROVED` and the configured language code exactly as returned by Meta. Templates that are still in review will not be sent.

### 2. Save the access token as a Firebase secret

From the project root, run the following command and enter the token only into the CLI prompt. Never paste it into chat or commit it to source control:

```bash
firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN
```

The token must have the necessary WhatsApp Business messaging permissions and access to the configured WABA/phone number. Access to list templates also requires suitable WhatsApp Business Management permission.

### 3. Build and deploy after configuration

Use the repository-pinned Node.js 22.22.2 runtime (`nvm use 22.22.2`). Run:

```bash
npm ci
npm run build
npm --prefix src/functions ci
npm --prefix src/functions run build
```

Only after both builds pass and the Meta configuration/template statuses are verified should you deploy:

```bash
firebase deploy --only functions
```

The deployment registers new functions; Vercel only serves the frontend and does not deploy Firebase Functions.

## Status and safety semantics

- `queued`: an idempotent absent-attendance job is ready to process.
- `blocked_missing_opt_in` / `blocked_missing_phone`: no send attempt was made.
- `sending`: a sender claimed the job/report to avoid concurrent duplicate attempts.
- `accepted_by_meta`: the Cloud API returned a WhatsApp message ID. This does not confirm sent/delivered/read; a delivery-status webhook is not included in this patch.
- `failed`: the API/config/template request failed. Check `lastError` on the attendance job or `whatsAppLastError` on the report document. The monthly report button can retry after resolving the cause. Attendance jobs need a deliberate trusted backend review/reset before requeueing so that an uncertain Meta response does not create duplicate alerts.

Automatic monthly sending runs for report documents written by the app's existing report-save flow (`mode: "automatic"`) once the saved report has a month/student/category, the current roster still includes the student, and consent is recorded. If the report is saved before consent is recorded, no message is sent; after obtaining consent, the teacher can use the manual send action or save the report again.

## Explicit limitations

- No source edit can approve a Meta message template, grant Meta permissions, create Firebase Secrets, or confirm account-specific IDs from code alone.
- A stored checkbox is an audit marker for a teacher to record the guardian's actual permission; it must not be used as a substitute for obtaining consent. Consent is also tied to the exact saved WhatsApp number (`parentWhatsAppOptInPhone`), with a timestamp; changing the number clears the checkbox and requires a fresh consent decision.
- Delivery/read tracking would require configuring a verified Meta webhook. These functions deliberately use `accepted_by_meta` rather than claiming delivery.
- The uploaded source set did not include the deployed Firestore/Storage security rules, so those rules still need a separate review before production rollout.
