import { isMonthlyReportWhatsAppEnabled } from "../../server/monthlyReportFeature.js";
import { calculateMonthlyReportContentHash } from "../../server/monthlyReportHash.js";
import { getFirebaseAdminFirestore } from "../../server/firebaseAdmin.js";
import {
  verifyMonthlyReportMediaLink,
} from "../../server/monthlyReportMedia.js";
import { renderWhatsAppNotificationPng } from "../../server/whatsappNotificationImage.js";
import { createHash } from "node:crypto";

type RecordLike = Record<string, unknown>;

type Request = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};

type Response = {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  send(data: Buffer | string): unknown;
  json(data: unknown): unknown;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

function readQuery(
  query: Request["query"],
  name: string,
): string {
  const value = query?.[name];
  return typeof value === "string" ? value : "";
}

function normalizePhone(value: unknown): string | null {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) {
    digits = `92${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `92${digits}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function readRoster(
  classData: RecordLike,
): Map<string, RecordLike> {
  const reserved = new Set([
    "id", "name", "code", "monthlyFee", "className", "title",
    "fee", "classFee", "createdAt", "createdDate", "date",
    "updatedAt", "students",
  ]);

  const raw = classData.students;
  let entries: Array<[string, unknown]> = [];
  let isArray = false;

  if (Array.isArray(raw)) {
    isArray = true;
    entries = raw.map((student, index) => [String(index), student]);
  } else if (isRecord(raw)) {
    entries = Object.entries(raw);
  } else if (raw === undefined || raw === null) {
    entries = Object.entries(classData).filter(([key, value]) =>
      !reserved.has(key) &&
      isRecord(value) &&
      (typeof value.name === "string" ||
        value.id !== undefined ||
        value.studentId !== undefined),
    );
  }

  const roster = new Map<string, RecordLike>();

  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;

    const isIndex = /^(0|[1-9]\d*)$/.test(key) &&
      Number(key) < 4294967295;
    const stableKey = !isArray && !isIndex ? key : undefined;
    const rawId = value.id ?? value.studentId ?? stableKey;

    if (typeof rawId !== "string" && typeof rawId !== "number") continue;

    const id = String(rawId).trim();
    if (id && !id.includes("/") && !roster.has(id)) {
      roster.set(id, value);
    }
  }

  return roster;
}

function getCurrentConsentedGuardianPhone(student: RecordLike): string | null {
  if (student.parentWhatsAppOptIn !== true) return null;
  if (
    typeof student.parentWhatsAppOptInAt !== "string" ||
    !student.parentWhatsAppOptInAt.trim()
  ) return null;

  const consentPhone = normalizePhone(student.parentWhatsAppOptInPhone);
  if (!consentPhone) return null;

  const matchesCurrentRoster = ["phone", "fatherPhone", "parentPhone", "guardianPhone"]
    .some((field) => normalizePhone(student[field]) === consentPhone);

  return matchesCurrentRoster ? consentPhone : null;
}

function recipientPhoneFingerprint(phone: string): string {
  return createHash("sha256")
    .update(`edutrack-monthly-report-recipient:v1:${phone}`)
    .digest("hex");
}

function calculateReportHash(
  report: RecordLike,
  className: string,
  student: RecordLike,
): string {
  return calculateMonthlyReportContentHash(report, className, student);
}

function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString("en", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = clean(value);
    if (
      text &&
      !/^(undefined|null|\[object Object\])$/i.test(text)
    ) {
      return text;
    }
  }
  return "";
}

export default async function handler(
  req: Request,
  res: Response,
): Promise<unknown> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!isMonthlyReportWhatsAppEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      error: "Method not allowed.",
    });
  }

  try {
    const db = getFirebaseAdminFirestore();

    const access = await verifyMonthlyReportMediaLink({
      db,
      mediaId: readQuery(req.query, "id"),
      expiresAt: readQuery(req.query, "exp"),
      signature: readQuery(req.query, "sig"),
    });

    if (!access) {
      return res.status(404).json({
        success: false,
        error: "This report link is invalid or has expired.",
      });
    }

    const tenantRef = db.collection("users").doc(access.tenantId);
    const jobRef = tenantRef
      .collection("whatsappNotificationJobs")
      .doc(access.jobId);

    const jobSnapshot = await jobRef.get();

    if (!jobSnapshot.exists) {
      return res.status(404).json({
        success: false,
        error: "The report is not available.",
      });
    }

    const job = jobSnapshot.data();

    // Postabi may fetch the signed PNG image URL after the send request returns.
    // Keep the short-lived link usable in unknown_outcome, but no other state.
    if (
      !job ||
      job.kind !== "monthly_report_pdf" ||
      (job.status !== "dispatching" && job.status !== "unknown_outcome") ||
      (job.status === "dispatching" && job.dispatchEnabled !== true) ||
      (job.status === "unknown_outcome" && job.dispatchEnabled !== false) ||
      job.tenantId !== access.tenantId
    ) {
      return res.status(404).json({
        success: false,
        error: "The report is not available.",
      });
    }

    const classId = clean(job.classId);
    const studentId = clean(job.studentId);
    const monthKey = clean(job.monthKey);

    if (
      !classId ||
      classId.includes("/") ||
      !studentId ||
      studentId.includes("/") ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)
    ) {
      return res.status(404).json({
        success: false,
        error: "The report is not available.",
      });
    }

    const classRef = tenantRef.collection("classes").doc(classId);
    const reportRef = classRef
      .collection("reports")
      .doc(`${studentId}_${monthKey}`);

    const [tenantSnapshot, classSnapshot, reportSnapshot, settingsSnapshot] =
      await Promise.all([
        tenantRef.get(),
        classRef.get(),
        reportRef.get(),
        tenantRef.collection("settings").doc("profile_data").get(),
      ]);

    if (
      !tenantSnapshot.exists ||
      !classSnapshot.exists ||
      !reportSnapshot.exists
    ) {
      return res.status(404).json({
        success: false,
        error: "The report is no longer available.",
      });
    }

    const tenant = tenantSnapshot.data();
    const classData = classSnapshot.data();
    const report = reportSnapshot.data();
    const settings = settingsSnapshot.data();

    if (
      !tenant ||
      !classData ||
      !report ||
      !isRecord(classData) ||
      !isRecord(report)
    ) {
      return res.status(404).json({
        success: false,
        error: "The report data is invalid.",
      });
    }

    if (
      (report.whatsAppStatus !== "sending" &&
        report.whatsAppStatus !== "unknown_outcome") ||
      report.whatsAppJobId !== access.jobId ||
      clean(report.studentId) !== studentId ||
      clean(report.monthKey) !== monthKey ||
      clean(report.classId) !== classId ||
      clean(report.lastWhatsAppAcceptedMonth) === monthKey
    ) {
      return res.status(404).json({
        success: false,
        error: "The report is no longer eligible for delivery.",
      });
    }

    const student = readRoster(classData).get(studentId);
    const currentGuardianPhone = student
      ? getCurrentConsentedGuardianPhone(student)
      : null;

    if (!student || !currentGuardianPhone) {
      return res.status(403).json({
        success: false,
        error: "Current guardian consent could not be verified.",
      });
    }

    const savedRecipientFingerprint =
      typeof job.recipientPhoneHash === "string"
        ? job.recipientPhoneHash
        : "";

    if (
      !/^[a-f0-9]{64}$/i.test(savedRecipientFingerprint) ||
      recipientPhoneFingerprint(currentGuardianPhone) !== savedRecipientFingerprint
    ) {
      return res.status(409).json({
        success: false,
        error: "The guardian number changed after dispatch was claimed. Image access is blocked.",
      });
    }

    const className = firstText(
      classData.name,
      classData.className,
      classData.title,
      job.className,
    );
    const verifiedClassName = /^class$/i.test(className) ? "" : className;

    const currentHash = calculateReportHash(
      report,
      className,
      student,
    );

    if (
      typeof job.contentHash !== "string" ||
      currentHash !== job.contentHash
    ) {
      return res.status(409).json({
        success: false,
        error: "The saved report changed after preparation. Prepare it again before delivery.",
      });
    }

    const tenantProfile = isRecord(tenant.profile) ? tenant.profile : {};
    const savedSettings = isRecord(settings) ? settings : {};
    const nestedSettings = isRecord(savedSettings.profile)
      ? savedSettings.profile
      : savedSettings;

    const teacherName = firstText(
      nestedSettings.name,
      nestedSettings.teacherName,
      savedSettings.teacherName,
      tenant.teacherName,
      tenant.name,
      tenantProfile.name,
    );

    const academyName = firstText(
      nestedSettings.schoolName,
      nestedSettings.academyName,
      savedSettings.schoolName,
      savedSettings.academyName,
      tenant.schoolName,
      tenant.academyName,
      tenantProfile.schoolName,
    );
    const classCode = firstText(classData.classCode, classData.code);
    const studentName = firstText(student.name, report.studentName);

    if (!academyName || !studentName || !verifiedClassName || !classCode) {
      console.error("[MonthlyReportMedia] Mandatory report identity metadata is missing.", {
        tenantId: access.tenantId,
        classId,
        studentId,
        hasAcademyName: Boolean(academyName),
        hasStudentName: Boolean(studentName),
        hasClassName: Boolean(verifiedClassName),
        hasClassCode: Boolean(classCode),
      });
      return res.status(422).json({
        success: false,
        error: "The report cannot be sent because academy name, student name, class or class code is not configured.",
      });
    }

    const remarks = Array.isArray(report.remarkItems)
      ? report.remarkItems.filter(isRecord)
      : [];
    const remarkFor = (category: string): string => {
      const match = remarks.find((item) => clean(item.category).toLowerCase() === category.toLowerCase());
      return match ? clean(match.remarkText) : "";
    };
    const numberValue = (value: unknown): number | null => {
      const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    };

    const png = await renderWhatsAppNotificationPng({
      kind: "monthly_report",
      academyName,
      teacherAvatarUrl: firstText(
        nestedSettings.avatarUrl, nestedSettings.profileImage, nestedSettings.photoURL,
        savedSettings.avatarUrl, savedSettings.profileImage, tenant.avatarUrl, tenant.profileImage,
        tenant.photoURL, tenantProfile.avatarUrl, tenantProfile.profileImage,
      ),
      studentAvatarUrl: firstText(
        student.profileImage, student.photoURL, student.photoUrl, student.avatarUrl, student.avatar, student.imageUrl,
      ),
      studentName,
      className: verifiedClassName,
      classCode,
      fatherName: firstText(student.fatherName, report.fatherName),
      rollNumber: firstText(student.rollNo, report.rollNo),
      reportingPeriod: monthLabel(monthKey),
      preparedBy: teacherName,
      attendancePercentage: firstText(report.attendanceRate) || "Not recorded",
      attendedDays: numberValue(report.presentDays),
      totalRecordedDays: numberValue(report.totalAttendanceDays),
      quizAverage: firstText(report.quizScore) || "Not recorded",
      marksObtained: numberValue(report.quizObtained),
      totalMarks: numberValue(report.quizTotal),
      feeStatus: firstText(report.feeStatus) || "Unrecorded",
      evaluations: [
        { category: "Homework", grade: clean(report.homeworkGrade), remark: remarkFor("Homework") },
        { category: "Behavior", grade: clean(report.behaviorGrade), remark: remarkFor("Behavior") },
        { category: "Participation", grade: clean(report.participationGrade), remark: remarkFor("Participation") },
        { category: "Performance", grade: clean(report.performanceGrade), remark: remarkFor("Performance") },
        { category: "Overall Remarks", grade: "", remark: remarkFor("Remarks") },
      ],
      academyContactPhone: firstText(nestedSettings.phone, savedSettings.phone),
      academyContactEmail: firstText(nestedSettings.email, savedSettings.email),
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(png.length));
    res.setHeader(
      "Content-Disposition",
      'inline; filename="edutrack-monthly-student-report.png"',
    );

    return res.status(200).send(png);
  } catch (error) {
    console.error("[MonthlyReportMedia] Secure monthly report image request failed.", error);

    return res.status(500).json({
      success: false,
      error: "The monthly report image could not be provided.",
    });
  }
}
