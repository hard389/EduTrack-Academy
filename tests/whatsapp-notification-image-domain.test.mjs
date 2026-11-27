import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotificationSvg,
  escapeSvgText,
  formatNotificationDate,
  validateNotificationImagePayload,
} from "../server/whatsappNotificationImageDomain.mjs";

const identity = {
  academyName: "EduTrack Academy",
  studentName: "Ali Tahir",
  className: "Class 10 A",
  classCode: "CHEM-10A",
};

const logo = "data:image/png;base64,aGVsbG8=";

test("all notification images require the four tenant/student identity fields", () => {
  for (const field of ["academyName", "studentName", "className", "classCode"]) {
    const payload = { kind: "quiz_result", ...identity, quizName: "Chapter 1", quizDate: "2026-11-16", marksObtained: 0, totalMarks: 20 };
    delete payload[field];
    const result = validateNotificationImagePayload(payload);
    assert.equal(result.valid, false, `${field} must be mandatory`);
    assert.match(result.error, new RegExp(field));
  }
});

test("SVG text is XML escaped", () => {
  assert.equal(escapeSvgText(`<Ali & "Academy">`), "&lt;Ali &amp; &quot;Academy&quot;&gt;");
});

test("attendance image contains real identity, date, status and metrics", () => {
  const payload = {
    kind: "attendance_absent", ...identity,
    attendanceDate: "2026-11-16", attendanceStatus: "ABSENT",
    previousAbsentDays: 2, attendancePercentage: "82%",
  };
  const svg = buildNotificationSvg(payload, logo);
  for (const value of [identity.academyName, identity.studentName, identity.className, identity.classCode, "16 Nov 2026", "ABSENT", "82%", "2"]) {
    assert.ok(svg.includes(value));
  }
});

test("quiz image supports zero marks without inventing score", () => {
  const payload = {
    kind: "quiz_result", ...identity,
    quizName: "Chapter 10 A", quizDate: "16/11/2026",
    marksObtained: 0, totalMarks: 20, percentage: "0%",
  };
  const svg = buildNotificationSvg(payload, logo);
  assert.ok(svg.includes("0 / 20"));
  assert.ok(svg.includes("0%"));
});

test("fee image refuses to fabricate a missing saved due date", () => {
  const payload = {
    kind: "fee_upcoming", ...identity,
    feeMonth: "November 2026", amountDue: 5000,
  };
  const result = validateNotificationImagePayload(payload);
  assert.equal(result.valid, false);
  assert.match(result.error, /due date/i);
});

test("overdue image requires a positive saved overdue-day count", () => {
  const payload = {
    kind: "fee_overdue", ...identity,
    feeMonth: "November 2026", amountDue: 5000,
    dueDate: "2026-11-05", daysOverdue: 0,
  };
  const result = validateNotificationImagePayload(payload);
  assert.equal(result.valid, false);
  assert.match(result.error, /overdue-day/i);
});

test("monthly report image includes period, metrics and only supplied feedback", () => {
  const payload = {
    kind: "monthly_report", ...identity,
    reportingPeriod: "November 2026",
    studentName: "Ali Tahir",
    attendancePercentage: "80%", attendedDays: 4, totalRecordedDays: 5,
    quizAverage: "70%", marksObtained: 14, totalMarks: 20,
    feeStatus: "Partial",
    evaluations: [{ category: "Homework", grade: "B", remark: "Complete the assigned work." }],
  };
  const svg = buildNotificationSvg(payload, logo);
  for (const value of ["November 2026", "80%", "4 attended / 5 recorded", "70%", "14 / 20", "Partial", "Complete the assigned work."]) {
    assert.ok(svg.includes(value));
  }
  assert.ok(!svg.includes("Academy name not configured"));
  assert.ok(!svg.includes("Full Access"));
});

test("a missing logo fails closed", () => {
  assert.throws(() => buildNotificationSvg({ kind: "quiz_result", ...identity, quizName: "Q", quizDate: "2026-11-16", marksObtained: 1, totalMarks: 10 }, ""), /logo/i);
});


test("ISO notification dates are formatted deterministically without timezone shifts", () => {
  assert.equal(formatNotificationDate("2026-11-16"), "16 Nov 2026");
  assert.equal(formatNotificationDate("2026-02-31"), "");
});

test("optional attendance and report contact fields are omitted when not configured", () => {
  const attendance = buildNotificationSvg({
    kind: "attendance_absent", ...identity,
    attendanceDate: "16 Nov 2026", attendanceStatus: "ABSENT",
    attendancePercentage: "80%", previousAbsentDays: 0,
  }, logo);
  assert.ok(!attendance.includes("Not recorded</text>"));

  const report = buildNotificationSvg({
    kind: "monthly_report", ...identity,
    reportingPeriod: "November 2026",
    evaluations: [],
  }, logo);
  assert.ok(!report.includes("Issued by: Not recorded"));
  assert.ok(!report.includes("Guardian: Not provided"));
  assert.ok(!report.includes("academy@example.invalid"));
});

test("premium graphics preserve long configured academy, student and class identity text", () => {
  const longAcademy = Array.from({ length: 18 }, (_, i) => `Academy${i + 1}`).join(" ");
  const longStudent = Array.from({ length: 20 }, (_, i) => `Stud${i + 1}`).join(" ");
  const longClass = Array.from({ length: 20 }, (_, i) => `Level${i + 1}`).join(" ");
  const longCode = "CLASS-CODE-2026-ADVANCED-SECTION-A-01";
  const svg = buildNotificationSvg({
    kind: "quiz_result",
    academyName: longAcademy,
    studentName: longStudent,
    className: longClass,
    classCode: longCode,
    quizName: "Extended chapter assessment",
    quizDate: "2026-11-16",
    marksObtained: 18,
    totalMarks: 20,
  }, logo);
  for (const token of [...longAcademy.split(" "), ...longStudent.split(" "), ...longClass.split(" "), longCode]) {
    assert.ok(svg.includes(token), `missing visible identity token: ${token}`);
  }
});

test("every notification variant renders the current student's own profile metadata", () => {
  const profile = {
    academyName: "Bright Future Academy",
    studentName: "Ayesha Tariq",
    fatherName: "Usman Tariq",
    rollNumber: "ST-037",
    className: "Grade 8 Blue",
    classCode: "G8-BLUE",
  };
  const payloads = [
    { kind: "attendance_absent", ...profile, attendanceDate: "2026-11-16", attendanceStatus: "ABSENT" },
    { kind: "quiz_result", ...profile, quizName: "Science Unit 4", quizDate: "2026-11-16", marksObtained: 16, totalMarks: 20 },
    { kind: "fee_upcoming", ...profile, feeMonth: "November 2026", amountDue: 2500, dueDate: "2026-11-20" },
    { kind: "fee_overdue", ...profile, feeMonth: "November 2026", amountDue: 2500, dueDate: "2026-11-05", daysOverdue: 11 },
    { kind: "monthly_report", ...profile, reportingPeriod: "November 2026" },
  ];

  for (const payload of payloads) {
    const svg = buildNotificationSvg(payload, logo);
    for (const field of [profile.academyName, profile.studentName, profile.fatherName, profile.rollNumber, profile.className, profile.classCode]) {
      assert.ok(svg.includes(field), `${payload.kind} must render this student's ${field}`);
    }
    assert.ok(!svg.includes("Ali Tahir"), `${payload.kind} must not reuse another student's identity`);
  }
});


test("all premium notification variants use teacher and student profile photos when supplied", () => {
  const teacherPhoto = "data:image/png;base64,dGVhY2hlcg==";
  const studentPhoto = "data:image/png;base64,c3R1ZGVudA==";
  const profile = {
    ...identity,
    teacherAvatarUrl: "https://edutrack-academy-r2-api.example.workers.dev/profile-images/teacher.png",
    studentAvatarUrl: "https://edutrack-academy-r2-api.example.workers.dev/profile-images/student.png",
  };
  const payloads = [
    { kind: "attendance_absent", ...profile, attendanceDate: "2026-11-16", attendanceStatus: "ABSENT" },
    { kind: "quiz_result", ...profile, quizName: "Science Unit 4", quizDate: "2026-11-16", marksObtained: 16, totalMarks: 20 },
    { kind: "fee_upcoming", ...profile, feeMonth: "November 2026", amountDue: 2500, dueDate: "2026-11-20" },
    { kind: "fee_overdue", ...profile, feeMonth: "November 2026", amountDue: 2500, dueDate: "2026-11-05", daysOverdue: 11 },
    { kind: "monthly_report", ...profile, reportingPeriod: "November 2026" },
  ];

  for (const payload of payloads) {
    const svg = buildNotificationSvg(payload, logo, { teacher: teacherPhoto, student: studentPhoto });
    assert.ok(svg.includes(teacherPhoto), `${payload.kind} must render the teacher profile photo`);
    assert.ok(svg.includes(studentPhoto), `${payload.kind} must render the student profile photo`);
    assert.ok(svg.includes(logo), `${payload.kind} must retain the EduTrack logo`);
  }
});

test("missing profile photos use the safe teacher/student illustration fallbacks", () => {
  const svg = buildNotificationSvg({
    kind: "attendance_absent", ...identity,
    attendanceDate: "2026-11-16", attendanceStatus: "ABSENT",
  }, logo);
  assert.ok(svg.includes('"TEACHER"') || svg.includes("TEACHER"));
  assert.ok(svg.includes('stroke="#0871bd"') || svg.includes("cap"));
  assert.ok(svg.includes(logo));
});


test("announcement image uses the shared EduTrack renderer without requiring an individual student identity", () => {
  const payload = {
    kind: "announcement",
    academyName: "EduTrack Academy",
    className: "Class 10 A",
    classCode: "CHEM-10A",
    announcementTitle: "Annual examination timetable",
    announcementMessage: "The annual examination timetable is available from the class teacher. Please review the dates and arrive before the reporting time.",
  };
  assert.equal(validateNotificationImagePayload(payload).valid, true);
  const svg = buildNotificationSvg(payload, logo);
  for (const value of ["EduTrack Academy", "SCHOOL ANNOUNCEMENT", payload.announcementTitle, "The annual examination timetable", "Class 10 A", "CHEM-10A"]) {
    assert.ok(svg.includes(value), `announcement image should include ${value}`);
  }
  assert.ok(svg.includes(logo));
});

test("announcement image rejects missing copy and safely escapes unsafe characters", () => {
  const payload = { kind: "announcement", academyName: "EduTrack Academy", className: "Class 10 A", classCode: "10A", announcementTitle: "Notice <Today>", announcementMessage: "Please read & follow the instructions." };
  const svg = buildNotificationSvg(payload, logo);
  assert.ok(svg.includes("Notice &lt;Today&gt;"));
  assert.ok(svg.includes("Please read &amp; follow"));
  assert.equal(validateNotificationImagePayload({ ...payload, announcementMessage: "" }).valid, false);
});
