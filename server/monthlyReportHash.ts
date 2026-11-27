import { createHash } from "node:crypto";

type ReportRecord = Record<string, unknown>;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is ReportRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalRemarks(report: ReportRecord): string {
  const direct = clean(report.remarks);
  if (direct) return direct.slice(0, 3000);

  if (Array.isArray(report.remarkItems)) {
    const items = report.remarkItems
      .filter(isRecord)
      .map((item) => `${clean(item.category)}: ${clean(item.remarkText)}`.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 3000);

    return items || "No saved remarks";
  }

  return "No saved remarks";
}

export function calculateMonthlyReportContentHash(
  report: ReportRecord,
  className: string,
  student: ReportRecord,
): string {
  const stable = {
    studentId: clean(report.studentId),
    studentName: clean(student.name) || clean(report.studentName),
    fatherName: clean(student.fatherName) || clean(report.fatherName),
    rollNo: clean(student.rollNo) || clean(report.rollNo),
    className,
    monthKey: clean(report.monthKey),
    category: clean(report.category),
    homeworkGrade: clean(report.homeworkGrade),
    behaviorGrade: clean(report.behaviorGrade),
    participationGrade: clean(report.participationGrade),
    performanceGrade: clean(report.performanceGrade),
    attendanceRate: clean(report.attendanceRate),
    quizScore: clean(report.quizScore),
    feeStatus: clean(report.feeStatus),
    remarks: canonicalRemarks(report),
  };

  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
}
