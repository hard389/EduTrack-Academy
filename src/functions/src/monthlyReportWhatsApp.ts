import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { WHATSAPP_ACCESS_TOKEN, normalizeWhatsAppPhone, sendApprovedDocumentTemplate } from "./whatsappService";
import { hasActiveTeacherFeatureEntitlement } from "./subscriptionEntitlements";

if (!getApps().length) initializeApp();

const db = getFirestore();
const REGION = "us-central1";
const RESERVED_CLASS_KEYS = new Set([
  "id", "name", "code", "monthlyFee", "className", "title", "fee",
  "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
]);

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result && !result.includes("/") ? result : null;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getClassRoster(classData: RecordLike): Map<string, RecordLike> {
  const rawStudents = classData.students;
  let entries: Array<[string, unknown]> = [];
  let studentsAreArray = false;

  if (Array.isArray(rawStudents)) {
    studentsAreArray = true;
    entries = rawStudents.map((student, index) => [String(index), student]);
  } else if (isRecord(rawStudents)) {
    entries = Object.entries(rawStudents);
  } else if (rawStudents === undefined || rawStudents === null) {
    entries = Object.entries(classData).filter(([key, value]) =>
      !RESERVED_CLASS_KEYS.has(key) && isRecord(value) &&
      (typeof value.name === "string" || value.id !== undefined || value.studentId !== undefined),
    );
  }

  const roster = new Map<string, RecordLike>();
  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;
    const keyIsArrayIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
    const stableMapKey = !studentsAreArray && !keyIsArrayIndex ? key : undefined;
    const id = normalizeStudentId(value.id ?? value.studentId ?? stableMapKey);
    if (!id || roster.has(id)) continue;
    roster.set(id, value);
  }
  return roster;
}

function chooseGuardianPhone(student: RecordLike): string | null {
  const consentPhone = normalizeWhatsAppPhone(student.parentWhatsAppOptInPhone);
  if (!consentPhone) return null;
  const currentPhones = [student.phone, student.fatherPhone, student.parentPhone, student.guardianPhone]
    .map((value) => normalizeWhatsAppPhone(value))
    .filter((value): value is string => Boolean(value));
  return currentPhones.includes(consentPhone) ? consentPhone : null;
}

function hasExplicitOptIn(student: RecordLike): boolean {
  return student.parentWhatsAppOptIn === true &&
    typeof student.parentWhatsAppOptInAt === "string" &&
    Boolean(student.parentWhatsAppOptInAt.trim()) &&
    chooseGuardianPhone(student) !== null;
}

function profileDisplayValues(
  tenantData: RecordLike | undefined,
  settingsData: RecordLike | undefined,
): { teacherName: string; academyName: string } {
  const tenant = tenantData ?? {};
  const settings = settingsData ?? {};
  const nestedTenant = isRecord(tenant.profile) ? tenant.profile : {};
  const nestedSettings = isRecord(settings.profile) ? settings.profile : settings;
  const firstText = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (text && !/^(undefined|null|\[object Object\])$/i.test(text)) return text;
    }
    return "";
  };
  return {
    teacherName: firstText(nestedSettings.name, nestedSettings.teacherName, settings.teacherName, tenant.teacherName, tenant.name, nestedTenant.name) || "Teacher",
    academyName: firstText(nestedSettings.schoolName, nestedSettings.academyName, settings.schoolName, settings.academyName, tenant.schoolName, tenant.academyName, nestedTenant.schoolName, nestedTenant.academyName) || "EduTrack",
  };
}

function assertTeacherOwnsTenant(tenantData: RecordLike, uid: string, email: string): void {
  const ownerIds = [tenantData.uid, tenantData.authUid, tenantData.ownerUid, tenantData.userId]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (ownerIds.length > 0 && !ownerIds.includes(uid)) {
    throw new HttpsError("permission-denied", "This teacher workspace belongs to another account.");
  }
  const storedEmail = normalizeEmail(tenantData.email);
  if (storedEmail && storedEmail !== email) {
    throw new HttpsError("permission-denied", "This teacher workspace belongs to another account.");
  }
  if (tenantData.disabled === true || tenantData.active === false || tenantData.deleted === true) {
    throw new HttpsError("permission-denied", "This teacher account is disabled.");
  }
}

function readableMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
}

function monthKeyIsValid(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return year >= 2000 && year <= 2200 && month >= 1 && month <= 12;
}

function isSendingLocked(data: RecordLike): boolean {
  return data.whatsAppStatus === "sending" ||
    data.whatsAppStatus === "unknown_outcome";
}

function buildRemarks(reportData: RecordLike): string {
  const remarks = readString(reportData.remarks);
  if (remarks) return remarks.slice(0, 3000);
  if (Array.isArray(reportData.remarkItems)) {
    return reportData.remarkItems
      .filter(isRecord)
      .map((item) => `${readString(item.category)}: ${readString(item.remarkText)}`.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 3000) || "No saved remarks";
  }
  return "No saved remarks";
}

function reportContentHash(reportData: RecordLike, className: string, student: RecordLike): string {
  const stable = {
    studentId: String(reportData.studentId ?? ""),
    studentName: readString(student.name) || readString(reportData.studentName),
    fatherName: readString(student.fatherName) || readString(reportData.fatherName),
    rollNo: readString(student.rollNo) || readString(reportData.rollNo),
    className,
    monthKey: readString(reportData.monthKey),
    category: readString(reportData.category),
    homeworkGrade: readString(reportData.homeworkGrade),
    behaviorGrade: readString(reportData.behaviorGrade),
    participationGrade: readString(reportData.participationGrade),
    performanceGrade: readString(reportData.performanceGrade),
    attendanceRate: readString(reportData.attendanceRate),
    quizScore: readString(reportData.quizScore),
    feeStatus: readString(reportData.feeStatus),
    remarks: buildRemarks(reportData),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function buildMonthlyReportPdf(
  reportData: RecordLike,
  student: RecordLike,
  className: string,
  teacherName: string,
  academyName: string,
  monthLabel: string,
): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 48, left: 48, right: 48 }, compress: true });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  pdf.fillColor("#172033").fontSize(20).font("Helvetica-Bold").text("Monthly Student Report", { align: "center" });
  pdf.moveDown(0.3).fillColor("#526078").fontSize(10).font("Helvetica").text(academyName, { align: "center" });
  pdf.moveDown(0.2).text(`Teacher: ${teacherName}`);
  pdf.moveDown(0.8).strokeColor("#d7deea").moveTo(48, pdf.y).lineTo(547, pdf.y).stroke();
  pdf.moveDown(0.8);

  const fields: Array<[string, string]> = [
    ["Month", monthLabel],
    ["Class", className],
    ["Student", readString(student.name) || readString(reportData.studentName) || "Student"],
    ["Father/Guardian", readString(student.fatherName) || readString(reportData.fatherName) || "Not provided"],
    ["Roll Number", readString(student.rollNo) || readString(reportData.rollNo) || "—"],
    ["Category", readString(reportData.category) || "—"],
    ["Homework Grade", readString(reportData.homeworkGrade) || "—"],
    ["Behavior Grade", readString(reportData.behaviorGrade) || "—"],
    ["Participation Grade", readString(reportData.participationGrade) || "—"],
    ["Performance Grade", readString(reportData.performanceGrade) || "—"],
    ["Attendance", readString(reportData.attendanceRate) || "—"],
    ["Quiz Score", readString(reportData.quizScore) || "—"],
    ["Fee Status", readString(reportData.feeStatus) || "Unrecorded"],
  ];
  for (const [label, value] of fields) {
    pdf.font("Helvetica-Bold").fontSize(10).fillColor("#172033").text(`${label}: `, { continued: true });
    pdf.font("Helvetica").fillColor("#303b50").text(value, { lineGap: 2 });
    pdf.moveDown(0.25);
  }
  pdf.moveDown(0.4).font("Helvetica-Bold").fontSize(11).fillColor("#172033").text("Remarks");
  pdf.moveDown(0.2).font("Helvetica").fontSize(10).fillColor("#303b50").text(buildRemarks(reportData), { lineGap: 3 });
  pdf.moveDown(1).fontSize(8).fillColor("#667085").text("Generated by EduTrack for the student's parent/guardian.", { align: "center" });
  pdf.end();
  return completed;
}

/**
 * Sends a student-specific PDF through the approved WhatsApp document template.
 * The recipient and consent are read from the server-side class roster, never accepted from the browser.
 * A successful response means Meta accepted the message; a delivery/read webhook is not implemented here.
 */
export const sendMonthlyStudentReportWhatsApp = onCall(
  {
    region: REGION,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [WHATSAPP_ACCESS_TOKEN],
  },
  async (request) => {
    // Safety boundary: never send monthly reports from a local emulator.
    const projectId =
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      "";
    const runningInEmulator =
      process.env.FUNCTIONS_EMULATOR === "true" ||
      projectId.startsWith("demo-");

    if (runningInEmulator) {
      throw new HttpsError(
        "failed-precondition",
        "Monthly WhatsApp sending is disabled in Firebase Emulator; no external request was made.",
      );
    }

    const authUid = request.auth?.uid;
    const authEmail = normalizeEmail(request.auth?.token.email);
    if (!authUid || !authEmail) {
      throw new HttpsError("unauthenticated", "Sign in with your teacher account before sending a report.");
    }

    const data = isRecord(request.data) ? request.data : {};
    const classId = readString(data.classId);
    const studentId = normalizeStudentId(data.studentId);
    const monthKey = data.monthKey;
    if (!classId || classId.includes("/") || !studentId || !monthKeyIsValid(monthKey)) {
      throw new HttpsError("invalid-argument", "Class, student, or report month is invalid.");
    }

    const tenantRef = db.collection("users").doc(authEmail);
    const classRef = tenantRef.collection("classes").doc(classId);
    const reportRef = classRef.collection("reports").doc(`${studentId}_${monthKey}`);
    const settingsRef = tenantRef.collection("settings").doc("profile_data");
    const [tenantSnapshot, classSnapshot, reportSnapshot, settingsSnapshot] = await Promise.all([
      tenantRef.get(),
      classRef.get(),
      reportRef.get(),
      settingsRef.get(),
    ]);
    if (!tenantSnapshot.exists) {
      throw new HttpsError("permission-denied", "The signed-in teacher workspace could not be verified.");
    }
    const tenantData = tenantSnapshot.data();
    if (!tenantData || !isRecord(tenantData)) {
      throw new HttpsError("permission-denied", "The signed-in teacher workspace could not be verified.");
    }
    assertTeacherOwnsTenant(tenantData, authUid, authEmail);
    if (!await hasActiveTeacherFeatureEntitlement(authEmail, authUid, "monthly_reports")) {
      throw new HttpsError("permission-denied", "Your Academy Admin has not granted Monthly Reports permission.");
    }
    if (!classSnapshot.exists) throw new HttpsError("not-found", "The selected class no longer exists.");
    if (!reportSnapshot.exists) {
      throw new HttpsError("failed-precondition", "Save the selected student's monthly report before sending it.");
    }
    const classData = classSnapshot.data();
    const reportData = reportSnapshot.data();
    if (!classData || !isRecord(classData) || !reportData || !isRecord(reportData)) {
      throw new HttpsError("failed-precondition", "The class roster or monthly report data is invalid.");
    }
    if (readString(reportData.monthKey) !== monthKey || readString(reportData.studentId) !== studentId) {
      throw new HttpsError("failed-precondition", "The saved report does not match the selected student and month.");
    }
    if (!readString(reportData.category)) {
      throw new HttpsError("failed-precondition", "Save the student's monthly rating before sending the report.");
    }

    const student = getClassRoster(classData).get(studentId);
    if (!student) throw new HttpsError("not-found", "The student was not found in the selected class roster.");
    if (!hasExplicitOptIn(student)) {
      throw new HttpsError("failed-precondition", "Guardian WhatsApp consent for the current contact number is not recorded. No message was sent.");
    }
    const guardianPhone = chooseGuardianPhone(student);
    if (typeof guardianPhone !== "string" || !guardianPhone.trim()) {
      throw new HttpsError("failed-precondition", "No guardian WhatsApp number is saved for this student.");
    }

    const acceptedMonth = readString(reportData.lastWhatsAppAcceptedMonth);
    if (acceptedMonth === monthKey) {
      throw new HttpsError("already-exists", "This student's report has already been accepted by WhatsApp for this month.");
    }
    if (isSendingLocked(reportData)) {
      throw new HttpsError(
        "already-exists",
        "The previous WhatsApp request may still be in progress. Check its outcome before retrying.",
      );
    }
    if (reportData.whatsAppStatus === "failed" && reportData.whatsAppRetrySafe !== true) {
      throw new HttpsError(
        "failed-precondition",
        "This failure is not verified as safe to retry. Check the WhatsApp outcome first.",
      );
    }

    const claimed = await db.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(reportRef);
      if (!latestSnapshot.exists) return false;
      const latest = latestSnapshot.data() ?? {};
      if (latest.lastWhatsAppAcceptedMonth === monthKey || isSendingLocked(latest)) return false;
      if (latest.whatsAppStatus === "failed" && latest.whatsAppRetrySafe !== true) return false;
      transaction.update(reportRef, {
        whatsAppStatus: "sending",
        whatsAppRetrySafe: false,
        whatsAppAttemptHash: reportContentHash(reportData, readString(classData.name) || readString(classData.className) || readString(classData.title) || "Class", getClassRoster(classData).get(studentId) ?? {}),
        whatsAppSendStartedAt: FieldValue.serverTimestamp(),
        whatsAppLastError: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!claimed) {
      throw new HttpsError("already-exists", "A WhatsApp report was already accepted or is still in progress for this month.");
    }

    let metaAcceptedMessageId = "";
    let sendApiInvoked = false;
    try {
      const { teacherName, academyName } = profileDisplayValues(
        tenantData,
        settingsSnapshot.data() as RecordLike | undefined,
      );
      const className = readString(classData.name) || readString(classData.className) || readString(classData.title) || "Class";
      const studentName = readString(student.name) || readString(reportData.studentName) || "Student";
      const fatherName = readString(student.fatherName) || readString(reportData.fatherName) || "Parent/Guardian";
      // Generate the attachment from the trusted saved report, not browser-supplied PDF bytes.
      const pdf = await buildMonthlyReportPdf(
        reportData,
        student,
        className,
        teacherName,
        academyName,
        readableMonth(monthKey),
      );
      if (pdf.length > 1_000_000) {
        throw new HttpsError("invalid-argument", "The generated monthly report PDF exceeds the 1 MB sending limit.");
      }
      const filename = `EduTrack-${readString(student.rollNo) || studentId}-${monthKey}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
      sendApiInvoked = true;
      const result = await sendApprovedDocumentTemplate(
        guardianPhone,
        pdf.toString("base64"),
        filename,
        {
          studentName,
          fatherName,
          rollNo: readString(student.rollNo) || readString(reportData.rollNo),
          className,
          month: readableMonth(monthKey),
          category: readString(reportData.category),
          remarks: buildRemarks(reportData),
          quizScore: readString(reportData.quizScore) || "—",
          attendanceRate: readString(reportData.attendanceRate) || "—",
          feeStatus: readString(reportData.feeStatus) || "Unrecorded",
          homeworkGrade: readString(reportData.homeworkGrade) || "—",
          behaviorGrade: readString(reportData.behaviorGrade) || "—",
          participationGrade: readString(reportData.participationGrade) || "—",
          performanceGrade: readString(reportData.performanceGrade) || "—",
          academyName,
          teacherName,
        },
      );

      metaAcceptedMessageId = result.messageId;
      await reportRef.update({
        whatsAppStatus: "accepted_by_meta",
        whatsAppMessageId: result.messageId,
        whatsAppAcceptedAt: FieldValue.serverTimestamp(),
        lastWhatsAppAcceptedMonth: monthKey,
        whatsAppLastError: null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      await tenantRef.collection("notifications").doc(`whatsapp_report_accepted_${classId}_${studentId}_${monthKey}`)
        .set({
          title: "Monthly Report Accepted by WhatsApp",
          message: `The PDF report for ${studentName} (${monthKey}) was accepted by the WhatsApp Cloud API. Delivery to the guardian is not confirmed by this status.`,
          type: "whatsapp_report_accepted",
          createdAt: FieldValue.serverTimestamp(),
          read: false,
          classId,
          studentId,
          monthKey,
          messageId: result.messageId,
        }, { merge: true })
        .catch((notificationError) => {
          logger.error("WhatsApp accepted status was saved, but the optional notification could not be created.", {
            tenantId: authEmail,
            classId,
            studentId,
            monthKey,
            error: notificationError instanceof Error ? notificationError.message : "Unknown notification error",
          });
        });

      logger.info("Monthly report WhatsApp message accepted by Meta; delivery is not confirmed.", {
        tenantId: authEmail,
        classId,
        studentId,
        monthKey,
        messageId: result.messageId,
      });
      return { success: true, status: "accepted_by_meta", messageId: result.messageId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown WhatsApp monthly report failure.";
      if (metaAcceptedMessageId) {
        logger.error("Meta accepted the monthly report, but post-send status persistence failed; leaving the attempt locked to reduce duplicate-send risk.", {
          tenantId: authEmail,
          classId,
          studentId,
          monthKey,
          messageId: metaAcceptedMessageId,
          reason,
        });
        return { success: true, status: "accepted_by_meta", messageId: metaAcceptedMessageId };
      }
      await reportRef.update({
        whatsAppStatus: sendApiInvoked ? "unknown_outcome" : "failed",
        whatsAppRetrySafe: !sendApiInvoked,
        whatsAppLastError: reason.slice(0, 500),
        updatedAt: FieldValue.serverTimestamp(),
      }).catch((updateError) => {
        logger.error("Could not record monthly report WhatsApp failure status.", {
          tenantId: authEmail,
          classId,
          studentId,
          monthKey,
          error: updateError instanceof Error ? updateError.message : "Unknown Firestore error",
        });
      });
      logger.error("Monthly report WhatsApp send failed.", {
        tenantId: authEmail,
        classId,
        studentId,
        monthKey,
        reason,
      });
      throw new HttpsError("failed-precondition", reason.slice(0, 400));
    }
  },
);


/**
 * Automatically sends an individual PDF after a saved monthly report becomes complete.
 * Only reports saved by the existing monthly-report flow (mode="automatic") are eligible.
 * The trigger re-reads the class roster and checks current guardian consent server-side.
 */
export const autoSendMonthlyStudentReportWhatsApp = onDocumentWritten(
  {
    document: "users/{tenantId}/classes/{classId}/reports/{reportId}",
    region: REGION,
    retry: false,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [WHATSAPP_ACCESS_TOKEN],
  },
  async (event) => {
    const afterSnapshot = event.data?.after;
    if (!afterSnapshot?.exists) return;
    const reportData = afterSnapshot.data();
    if (!reportData || !isRecord(reportData) || readString(reportData.mode) !== "automatic") return;

    // Safety boundary: automatic monthly sends are disabled in local emulators.
    const projectId =
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      "";
    const runningInEmulator =
      process.env.FUNCTIONS_EMULATOR === "true" ||
      projectId.startsWith("demo-");

    if (runningInEmulator) {
      // Write the blocked status only once to prevent a trigger write loop.
      if (reportData.whatsAppStatus !== "blocked_emulator") {
        await afterSnapshot.ref.update({
          whatsAppStatus: "blocked_emulator",
          whatsAppRetrySafe: false,
          whatsAppLastError:
            "Local Firebase Emulator: external WhatsApp sending is disabled.",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return;
    }

    const tenantId = String(event.params.tenantId ?? "").trim();
    const classId = String(event.params.classId ?? "").trim();
    const reportId = String(event.params.reportId ?? "").trim();
    const studentId = normalizeStudentId(reportData.studentId);
    const monthKey = reportData.monthKey;
    if (!tenantId || !classId || !studentId || !monthKeyIsValid(monthKey) || !readString(reportData.category)) return;
    if (reportId !== `${studentId}_${monthKey}`) return;
    const storedClassId = readString(reportData.classId);
    if (storedClassId && storedClassId !== classId) return;

    const reportRef = afterSnapshot.ref;
    // The browser can write a report and then this function writes status fields on that same doc.
    // Ignore those bookkeeping updates once an attempt is in progress or was accepted by Meta.
    // Never automatically re-send a stale "sending" report: Meta may have accepted it
    // just before a process failure. The callable path is the explicit manual retry route.
    if (isSendingLocked(reportData) ||
        (reportData.whatsAppStatus === "accepted_by_meta" && reportData.lastWhatsAppAcceptedMonth === monthKey)) return;

    try {
      const tenantRef = db.collection("users").doc(tenantId);
      const classRef = tenantRef.collection("classes").doc(classId);
      const settingsRef = tenantRef.collection("settings").doc("profile_data");
      const [classSnapshot, tenantSnapshot, settingsSnapshot] = await Promise.all([
        classRef.get(), tenantRef.get(), settingsRef.get(),
      ]);
      const tenantData = tenantSnapshot.data();
      const tenantUid = tenantData && isRecord(tenantData) ? readString(tenantData.uid) : "";
      if (!await hasActiveTeacherFeatureEntitlement(tenantId, tenantUid, "monthly_reports")) {
        if (reportData.whatsAppStatus !== "blocked_permission") {
          await reportRef.update({
            whatsAppStatus: "blocked_permission",
            whatsAppRetrySafe: false,
            whatsAppLastError: "Your Academy Admin has not granted Monthly Reports permission; no message was sent.",
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return;
      }
      if (!classSnapshot.exists) return;
      const classData = classSnapshot.data();
      if (!classData || !isRecord(classData)) return;
      const className = readString(classData.name) || readString(classData.className) || readString(classData.title) || "Class";
      const student = getClassRoster(classData).get(studentId);
      if (!student) {
        if (reportData.whatsAppStatus !== "blocked_student_missing") {
          await reportRef.update({
            whatsAppStatus: "blocked_student_missing",
            whatsAppLastError: "Student was not found in the current class roster.",
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return;
      }
      if (!hasExplicitOptIn(student)) {
        // Avoid a write loop if this report was already marked blocked for missing consent.
        if (reportData.whatsAppStatus !== "blocked_missing_opt_in") {
          await reportRef.update({
            whatsAppStatus: "blocked_missing_opt_in",
            whatsAppLastError: "Guardian WhatsApp consent for the current contact number is not recorded; no message was sent.",
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return;
      }
      const guardianPhone = chooseGuardianPhone(student);
      if (typeof guardianPhone !== "string" || !guardianPhone.trim()) {
        if (reportData.whatsAppStatus !== "blocked_missing_phone") {
          await reportRef.update({
            whatsAppStatus: "blocked_missing_phone",
            whatsAppLastError: "No guardian WhatsApp number is saved for this student.",
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return;
      }

      const contentHash = reportContentHash(reportData, className, student);
      if (reportData.whatsAppStatus === "failed" && reportData.whatsAppAttemptHash === contentHash) return;
      const claimed = await db.runTransaction(async (transaction) => {
        const latestSnapshot = await transaction.get(reportRef);
        if (!latestSnapshot.exists) return false;
        const latest = latestSnapshot.data() ?? {};
        if (isSendingLocked(latest) || latest.lastWhatsAppAcceptedMonth === monthKey) return false;
        if (latest.whatsAppStatus === "failed" && latest.whatsAppRetrySafe !== true) return false;
        if (latest.whatsAppStatus === "failed" && latest.whatsAppAttemptHash === contentHash) return false;
        transaction.update(reportRef, {
          whatsAppStatus: "sending",
          whatsAppRetrySafe: false,
          whatsAppAttemptHash: contentHash,
          whatsAppSendStartedAt: FieldValue.serverTimestamp(),
          whatsAppLastError: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!claimed) return;

      let metaAcceptedMessageId = "";
      let sendApiInvoked = false;
      try {
        const { teacherName, academyName } = profileDisplayValues(
          tenantSnapshot.data() as RecordLike | undefined,
          settingsSnapshot.data() as RecordLike | undefined,
        );
        const monthLabel = readableMonth(monthKey);
        const pdf = await buildMonthlyReportPdf(reportData, student, className, teacherName, academyName, monthLabel);
        if (pdf.length > 1_000_000) throw new Error("Generated student report PDF exceeds the 1 MB sending limit.");
        const filename = `EduTrack-${readString(student.rollNo) || studentId}-${monthKey}.pdf`;
        sendApiInvoked = true;
        const result = await sendApprovedDocumentTemplate(
          guardianPhone,
          pdf.toString("base64"),
          filename,
          {
            studentName: readString(student.name) || readString(reportData.studentName) || "Student",
            fatherName: readString(student.fatherName) || readString(reportData.fatherName) || "Parent/Guardian",
            rollNo: readString(student.rollNo) || readString(reportData.rollNo),
            className,
            month: monthLabel,
            category: readString(reportData.category),
            remarks: buildRemarks(reportData),
            quizScore: readString(reportData.quizScore) || "—",
            attendanceRate: readString(reportData.attendanceRate) || "—",
            feeStatus: readString(reportData.feeStatus) || "Unrecorded",
            homeworkGrade: readString(reportData.homeworkGrade) || "—",
            behaviorGrade: readString(reportData.behaviorGrade) || "—",
            participationGrade: readString(reportData.participationGrade) || "—",
            performanceGrade: readString(reportData.performanceGrade) || "—",
            academyName,
            teacherName,
          },
        );
        metaAcceptedMessageId = result.messageId;
        await reportRef.update({
          whatsAppStatus: "accepted_by_meta",
          whatsAppMessageId: result.messageId,
          whatsAppAcceptedAt: FieldValue.serverTimestamp(),
          lastWhatsAppAcceptedMonth: monthKey,
          whatsAppLastError: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        logger.info("Automatic monthly report PDF accepted by WhatsApp Cloud API; delivery is not confirmed.", {
          tenantId, classId, reportId, studentId, monthKey, messageId: result.messageId,
        });
      } catch (sendError) {
        const reason = sendError instanceof Error ? sendError.message : "Unknown automatic monthly report send failure.";
        if (metaAcceptedMessageId) {
          logger.error("Meta accepted the automatic monthly report, but status persistence failed; do not automatically retry to avoid a duplicate.", {
            tenantId, classId, reportId, studentId, monthKey, messageId: metaAcceptedMessageId, reason,
          });
          return;
        }
        await reportRef.update({
          whatsAppStatus: sendApiInvoked ? "unknown_outcome" : "failed",
          whatsAppRetrySafe: !sendApiInvoked,
          whatsAppAttemptHash: contentHash,
          whatsAppLastError: reason.slice(0, 500),
          updatedAt: FieldValue.serverTimestamp(),
        });
        logger.error("Automatic monthly report WhatsApp send failed.", {
          tenantId, classId, reportId, studentId, monthKey, reason,
        });
      }
    } catch (error) {
      logger.error("Automatic monthly report trigger could not process the saved report.", {
        tenantId,
        classId,
        reportId,
        studentId,
        monthKey,
        reason: error instanceof Error ? error.message : "Unknown trigger failure",
      });
    }
  },
);
