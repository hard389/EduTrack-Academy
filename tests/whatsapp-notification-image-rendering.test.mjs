import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { buildNotificationSvg } from "../server/whatsappNotificationImageDomain.mjs";

const logoBytes = await readFile(new URL("../public/logo.png", import.meta.url));
const logo = `data:image/png;base64,${logoBytes.toString("base64")}`;
const require = createRequire(import.meta.url);
const fontFiles = [
  require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"),
  require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"),
];
const resvgFontOptions = {
  font: {
    fontFiles,
    loadSystemFonts: false,
    defaultFontFamily: "DejaVu Sans",
    sansSerifFamily: "DejaVu Sans",
  },
};
const identity = {
  academyName: "EduTrack Academy",
  studentName: "Ali Tahir",
  fatherName: "Tahir Mahmood Akhtar",
  rollNumber: "17",
  className: "Class 10 A",
  classCode: "CHEM-10A",
};

const payloads = [
  ["attendance_absent", {
    kind: "attendance_absent", ...identity,
    attendanceDate: "16 Nov 2026", attendanceTime: "08:00 AM",
    attendanceStatus: "ABSENT", previousAbsentDays: 2,
    attendancePercentage: "80%",
  }],
  ["quiz_result", {
    kind: "quiz_result", ...identity,
    quizName: "Chapter 10 Chemistry", quizDate: "16 Nov 2026",
    marksObtained: 0, totalMarks: 20, percentage: "0%",
  }],
  ["fee_upcoming", {
    kind: "fee_upcoming", ...identity,
    feeMonth: "November 2026", totalFee: 5000,
    totalFeeLabel: "PKR 5,000", amountDue: 2500,
    currencyAmount: "PKR 2,500", dueDate: "20 Nov 2026",
    paymentStatus: "PARTIAL",
  }],
  ["fee_overdue", {
    kind: "fee_overdue", ...identity,
    feeMonth: "November 2026", totalFee: 5000,
    totalFeeLabel: "PKR 5,000", amountDue: 2500,
    currencyAmount: "PKR 2,500", dueDate: "05 Nov 2026",
    daysOverdue: 11, paymentStatus: "OVERDUE",
  }],
  ["monthly_report", {
    kind: "monthly_report", ...identity,
    reportingPeriod: "November 2026", fatherName: "Tahir Mahmood Akhtar",
    rollNumber: "1", preparedBy: "Teacher",
    attendancePercentage: "80%", attendedDays: 4,
    totalRecordedDays: 5, quizAverage: "70%",
    marksObtained: 14, totalMarks: 20, feeStatus: "Partial",
    evaluations: [{ category: "Homework", grade: "B", remark: "Complete the assigned work." }],
  }],
];

for (const [kind, payload] of payloads) {
  test(`${kind} produces a decodable PNG with actual identity metadata`, async () => {
    const svg = buildNotificationSvg(payload, logo);
    assert.match(svg, /font-family="DejaVu Sans"/);
    assert.doesNotMatch(svg, /font-family="(?:Arial|Helvetica)/);
    const visibleIdentity = [
      payload.academyName,
      payload.studentName,
      payload.fatherName,
      payload.rollNumber ?? payload.rollNo,
      payload.className,
      payload.classCode,
    ].filter(Boolean);
    for (const value of visibleIdentity) {
      assert.ok(svg.includes(value), `missing visible student/academy field: ${value}`);
    }
    const renderedPng = new Resvg(svg, resvgFontOptions).render().asPng();
    const png = await sharp(renderedPng).png().toBuffer();
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.format, "png");
    assert.ok(metadata.width >= 1000);
    assert.ok(metadata.height > 500);
    assert.ok(png.length > 1000);
    assert.ok(png.length < 5_000_000);
  });
}
