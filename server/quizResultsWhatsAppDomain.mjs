import { createHash } from "node:crypto";

export function normalizeQuizWhatsAppPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function getQuizResultsConsentedPhone(student) {
  if (!student || student.quizResultsWhatsAppOptIn !== true) return null;
  if (typeof student.quizResultsWhatsAppOptInAt !== "string" || !student.quizResultsWhatsAppOptInAt.trim()) return null;
  const saved = normalizeQuizWhatsAppPhone(student.quizResultsWhatsAppOptInPhone);
  const current = normalizeQuizWhatsAppPhone(student.phone);
  if (!saved || !current || saved !== current) return null;
  return saved;
}

export function parseQuizResultMark(value, totalMarks) {
  if (value === "" || value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return { kind: "empty" };
  }
  if (typeof value !== "number" && typeof value !== "string") return { kind: "invalid" };
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isFinite(totalMarks) || totalMarks <= 0 || number > totalMarks) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value: number };
}

export function calculateQuizResultsContentHash(input) {
  const rows = (Array.isArray(input.rows) ? input.rows : [])
    .map((row) => ({
      studentId: String(row.studentId ?? "").trim(),
      studentName: String(row.studentName ?? "").trim(),
      rollNo: String(row.rollNo ?? "").trim(),
      marksObtained: Number(row.marksObtained),
    }))
    .filter((row) => row.studentId && Number.isFinite(row.marksObtained))
    .sort((a, b) => a.studentId.localeCompare(b.studentId));
  const canonical = {
    version: 1,
    classId: String(input.classId ?? ""),
    quizId: String(input.quizId ?? ""),
    topic: String(input.topic ?? "").trim(),
    totalMarks: Number(input.totalMarks),
    date: String(input.date ?? ""),
    rows,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createQuizResultsDispatchId(input) {
  // One permanent dispatch identity per tenant/class/quiz. Content hashes are
  // validated separately and must never create a second send opportunity.
  const canonical = [
    "edutrack-quiz-results:v2",
    String(input.tenantId ?? ""),
    String(input.classId ?? ""),
    String(input.quizId ?? ""),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export function createQuizResultsRecipientKey(studentId) {
  return createHash("sha256").update(`edutrack-quiz-result-recipient:v1:${String(studentId)}`).digest("hex");
}

export function createQuizResultMessage(input) {
  const marks = Number(input.marksObtained);
  const total = Number(input.totalMarks);
  const percentage = Math.round((marks / total) * 1000) / 10;
  const percentageText = Number.isInteger(percentage) ? String(percentage) : percentage.toFixed(1);
  const lines = [
    "Assalam-o-Alaikum!",
    "",
    `Quiz result for ${String(input.studentName || "Student")}:`,
    `Class: ${String(input.className || "Class")}`,
    `Quiz: ${String(input.topic || "Quiz")}`,
    `Date: ${String(input.date || "Not specified")}`,
    `Marks: ${marks}/${total}`,
    `Percentage: ${percentageText}%`,
    "",
    `Regards, ${String(input.teacherName || "Teacher")}`,
    "EduTrack",
  ];
  return lines.join("\n");
}
