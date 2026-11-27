import { createHash } from "node:crypto";

/** Return the calendar day used by the EduTrack teacher-notice dismissal policy. */
export function getPakistanDateKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("A valid date is required.");
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Stable, non-identifying Firestore document ID for one teacher dismissal per PK day. */
export function getTeacherAnnouncementDismissalId(uid, dateKey) {
  const teacherUid = typeof uid === "string" ? uid.trim() : "";
  const day = typeof dateKey === "string" ? dateKey.trim() : "";
  if (!teacherUid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError("A teacher UID and valid YYYY-MM-DD day key are required.");
  }
  return createHash("sha256").update(`${teacherUid}:${day}`).digest("hex");
}
