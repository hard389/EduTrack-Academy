import { createHash } from "node:crypto";

export function normalizeAnnouncementWhatsAppPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.startsWith("3") && digits.length === 10) digits = `92${digits}`;
  // The guardian contact form is Pakistan-mobile based; block landlines and malformed numbers.
  return /^923\d{9}$/.test(digits) ? digits : null;
}

export function getAnnouncementConsentedPhone(student) {
  if (!student || student.announcementWhatsAppOptIn !== true) return null;
  if (typeof student.announcementWhatsAppOptInAt !== "string" || !student.announcementWhatsAppOptInAt.trim()) return null;
  const saved = normalizeAnnouncementWhatsAppPhone(student.announcementWhatsAppOptInPhone);
  const current = normalizeAnnouncementWhatsAppPhone(student.phone);
  if (!saved || !current || saved !== current) return null;
  return current;
}

export function createAnnouncementPhoneHash(phone) {
  const normalized = normalizeAnnouncementWhatsAppPhone(phone);
  if (!normalized) throw new Error("A valid current guardian WhatsApp number is required.");
  return createHash("sha256").update(`edutrack-announcement-recipient-phone:v1:${normalized}`).digest("hex");
}

export function createAnnouncementRecipientKey(phoneHash) {
  const value = String(phoneHash ?? "").trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("A valid guardian phone fingerprint is required.");
  return createHash("sha256").update(`edutrack-announcement-recipient:v1:${value}`).digest("hex");
}

export function calculateAnnouncementContentHash(input) {
  const canonical = {
    version: 1,
    tenantId: String(input.tenantId ?? "").trim().toLowerCase(),
    alertId: String(input.alertId ?? "").trim(),
    title: String(input.title ?? "").trim(),
    message: String(input.message ?? "").trim(),
    category: String(input.category ?? ""),
    targetClass: String(input.targetClass ?? ""),
    classIds: [...new Set(Array.isArray(input.classIds) ? input.classIds.map(String) : [])].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createAnnouncementDispatchId(input) {
  // One immutable dispatch identity per saved alert. Content and audience hashes are
  // validated separately against the frozen dispatch record before any recipient is sent.
  return createHash("sha256").update([
    "edutrack-announcements:v2",
    String(input.tenantId ?? "").trim().toLowerCase(),
    String(input.alertId ?? "").trim(),
  ].join("|")).digest("hex");
}

export function buildAnnouncementMessage(input) {
  const title = String(input.title ?? "").trim();
  const message = String(input.message ?? "").trim();
  const targetClass = String(input.targetClass ?? "All Classes").trim() || "All Classes";
  const schoolName = String(input.schoolName ?? "").trim().slice(0, 100) || "Your school";
  if (!title || title.length > 140 || !message || message.length > 3000) {
    throw new Error("The announcement title or message is outside the allowed length.");
  }
  return [
    "Assalam-o-Alaikum!",
    "",
    `Announcement from ${schoolName}:`,
    `For: ${targetClass}`,
    "",
    title,
    message,
    "",
    "Regards,",
    schoolName,
    "EduTrack",
  ].join("\n");
}
