const PAKISTAN_TIME_ZONE = "Asia/Karachi";

function dateParts(date, includeDay = false) {
  const options = includeDay
    ? { timeZone: PAKISTAN_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }
    : { timeZone: PAKISTAN_TIME_ZONE, year: "numeric", month: "2-digit" };
  return new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
}

export function currentPakistanMonthKey(now = new Date()) {
  const parts = dateParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("The Pakistan calendar month could not be resolved.");
  return `${year}-${month}`;
}

export function validatePakistanMonthKey(raw, now = new Date()) {
  const current = currentPakistanMonthKey(now);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return current;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw Object.assign(new Error("Choose a valid month in YYYY-MM format."), { status: 400 });
  }
  if (value > current) {
    throw Object.assign(new Error("Future months are not available."), { status: 400 });
  }
  return value;
}

export function pakistanMonthBoundsUtc(monthKey) {
  if (typeof monthKey !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new TypeError("Month must use YYYY-MM format.");
  }
  const [year, month] = monthKey.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Pakistan Standard Time is UTC+05:00 and has no DST transition.
  const start = new Date(Date.UTC(year, month - 1, 1) - 5 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, month, 1) - 5 * 60 * 60 * 1000);
  return { start, end, days };
}

export function previousPakistanMonthKey(monthKey) {
  if (typeof monthKey !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new TypeError("Month must use YYYY-MM format.");
  }
  const [year, month] = monthKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function classifyWhatsAppOutcome(statusValue, data = {}) {
  const status = typeof statusValue === "string" ? statusValue.trim().toLowerCase() : "";
  if (!status) return null;
  if (status === "delivered") return "deliveryConfirmed";
  if (["accepted_by_postabi", "accepted_by_provider", "provider_accepted"].includes(status)) return "providerAccepted";
  if (["provider_rejected", "rejected", "failed"].includes(status)) {
    // A retrySafe Attendance failure happened before a provider request.
    if (status === "failed" && data?.retrySafe === true) return null;
    return "failed";
  }
  if (["unknown_outcome", "unknown", "uncertain"].includes(status)) return "unknown";
  if (["pending", "dispatching", "sending", "prepared", "prepared_for_vercel", "queued"].includes(status)) return "pending";
  return null;
}
