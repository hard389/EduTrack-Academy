const REQUIRED_IDENTITY = ["academyName", "studentName", "className", "classCode"];
const SUPPORTED_KINDS = new Set([
  "attendance_absent",
  "quiz_result",
  "fee_upcoming",
  "fee_overdue",
  "fee_reminder",
  "monthly_report",
  "announcement",
]);

const COLORS = {
  navy: "#061b43",
  navy2: "#0b3d86",
  blue: "#087cf0",
  blue2: "#26c6f4",
  ink: "#102748",
  muted: "#4d6684",
  line: "#b8dafb",
  orange: "#ff7417",
  red: "#e11d48",
  green: "#059669",
};

export function cleanNotificationText(value, max = 600) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}

export function formatNotificationDate(value) {
  const raw = cleanNotificationText(value, 80);
  if (!raw) return "";
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!ymd) return raw;
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  }).format(date);
}

export function escapeSvgText(value) {
  return cleanNotificationText(value, 4000)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function validateNotificationImagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, error: "Notification image payload is invalid." };
  }
  const kind = cleanNotificationText(payload.kind, 40);
  if (!SUPPORTED_KINDS.has(kind)) return { valid: false, error: "Unsupported notification image type." };
  const identityFields = kind === "announcement"
    ? ["academyName", "className", "classCode"]
    : REQUIRED_IDENTITY;
  for (const field of identityFields) {
    if (!cleanNotificationText(payload[field], 180)) {
      return { valid: false, error: `Required notification field is missing: ${field}.` };
    }
  }
  if (kind === "attendance_absent" && (!cleanNotificationText(payload.attendanceDate, 32) || !cleanNotificationText(payload.attendanceStatus, 24))) {
    return { valid: false, error: "Attendance date and status are required." };
  }
  if (kind === "quiz_result") {
    const obtained = Number(payload.marksObtained);
    const total = Number(payload.totalMarks);
    if (!cleanNotificationText(payload.quizName, 180) || !cleanNotificationText(payload.quizDate, 32) || !Number.isFinite(obtained) || !Number.isFinite(total) || total <= 0 || obtained < 0 || obtained > total) {
      return { valid: false, error: "Saved quiz title, date, and marks are required." };
    }
  }
  if (kind === "fee_upcoming" || kind === "fee_overdue" || kind === "fee_reminder") {
    if (!cleanNotificationText(payload.feeMonth, 32) || !Number.isFinite(Number(payload.amountDue)) || Number(payload.amountDue) <= 0) {
      return { valid: false, error: "Fee month and positive outstanding balance are required." };
    }
    if (kind !== "fee_reminder" && !cleanNotificationText(payload.dueDate, 32)) {
      return { valid: false, error: "A saved fee due date is required for an upcoming or overdue notification." };
    }
    if (payload.totalFee !== undefined && (!Number.isFinite(Number(payload.totalFee)) || Number(payload.totalFee) < 0)) {
      return { valid: false, error: "The saved total fee obligation is invalid." };
    }
    if (kind === "fee_overdue" && (!Number.isInteger(Number(payload.daysOverdue)) || Number(payload.daysOverdue) < 1)) {
      return { valid: false, error: "A valid overdue-day count is required." };
    }
  }
  if (kind === "monthly_report" && !cleanNotificationText(payload.reportingPeriod, 32)) {
    return { valid: false, error: "The monthly report period is required." };
  }
  if (kind === "announcement") {
    if (!cleanNotificationText(payload.announcementTitle, 180) || !cleanNotificationText(payload.announcementMessage, 2200)) {
      return { valid: false, error: "Announcement title and message are required." };
    }
    if (!cleanNotificationText(payload.className, 180) || !cleanNotificationText(payload.classCode, 80)) {
      return { valid: false, error: "Announcement class context is required." };
    }
  }
  return { valid: true, kind };
}

function wrapAll(value, maxChars = 52) {
  const source = cleanNotificationText(value, 4000);
  if (!source) return [];
  const words = source.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (word.length > maxChars) {
      if (line) { lines.push(line); line = ""; }
      for (let offset = 0; offset < word.length; offset += maxChars) lines.push(word.slice(offset, offset + maxChars));
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function wrap(value, maxChars = 52, maxLines = 3) {
  const lines = wrapAll(value, maxChars);
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = visible[maxLines - 1].replace(/[. ]*$/, "…");
  return visible;
}

function text(x, y, value, size = 30, color = COLORS.ink, weight = 500, maxChars = 52, maxLines = 2, lineHeight = size * 1.3, anchor = "start", letterSpacing = 0) {
  const lines = wrap(value, maxChars, maxLines);
  if (!lines.length) return "";
  return lines.map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" fill="${color}" font-family="DejaVu Sans" font-size="${size}" font-weight="${weight}" letter-spacing="${letterSpacing}">${escapeSvgText(line)}</text>`
  ).join("");
}

function optionalText(x, y, value, size = 20, color = COLORS.muted, weight = 500, maxChars = 50, maxLines = 1) {
  return cleanNotificationText(value) ? text(x, y, value, size, color, weight, maxChars, maxLines) : "";
}

function rect(x, y, width, height, fill = "#ffffff", stroke = COLORS.line, radius = 24, strokeWidth = 2) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function line(x1, y1, x2, y2, color = COLORS.line, width = 2, opacity = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round"/>`;
}

function icon(name, x, y, size = 54, color = COLORS.blue) {
  const shapes = {
    bell: `<path d="M24 5c-7 0-12 5-12 13v7c0 4-2 7-5 10h34c-3-3-5-6-5-10v-7C36 10 31 5 24 5Z"/><path d="M19 40c1 4 3 6 5 6s4-2 5-6"/><path d="M7 13 3 9m38 4 4-4"/>`,
    calendar: `<rect x="5" y="8" width="38" height="34" rx="5"/><path d="M14 4v9m20-9v9M5 18h38M14 25h5m7 0h5m-17 8h5m7 0h5"/>`,
    clock: `<circle cx="24" cy="24" r="19"/><path d="M24 12v13l9 6"/>`,
    layers: `<path d="m24 5 19 10-19 10L5 15 24 5Z"/><path d="m5 24 19 10 19-10M5 33l19 10 19-10"/>`,
    code: `<rect x="5" y="5" width="15" height="15" rx="3"/><rect x="28" y="5" width="15" height="15" rx="3"/><rect x="5" y="28" width="15" height="15" rx="3"/><path d="M28 28h7v7h-7zm8 8h7v7h-7z"/>`,
    chart: `<path d="M7 42V27h8v15M20 42V17h8v25M33 42V7h8v35"/>`,
    trophy: `<path d="M15 7h18v10c0 9-4 14-9 14s-9-5-9-14V7Z"/><path d="M15 12H7v4c0 7 4 10 11 10m15-14h8v4c0 7-4 10-11 10M24 31v8m-10 4h20m-17-4h14"/>`,
    book: `<path d="M5 9c8-3 14-1 19 4 5-5 11-7 19-4v29c-8-3-14-1-19 4-5-5-11-7-19-4V9Z"/><path d="M24 13v29"/>`,
    coins: `<ellipse cx="18" cy="13" rx="12" ry="6"/><path d="M6 13v8c0 3 5 6 12 6 3 0 6-.5 8-2M6 21v8c0 3 5 6 12 6 2 0 4-.2 6-1"/><ellipse cx="31" cy="29" rx="11" ry="5"/><path d="M20 29v8c0 3 5 5 11 5s11-2 11-5v-8"/>`,
    check: `<path d="m7 25 11 11L41 12"/>`,
    info: `<circle cx="24" cy="24" r="19"/><path d="M24 21v13m0-22h.1"/>`,
    cap: `<path d="m3 18 21-11 21 11-21 11L3 18Z"/><path d="M12 23v11c8 6 16 6 24 0V23m8-5v15m0 0-4 5m4-5 4 5"/>`,
    mail: `<rect x="4" y="9" width="40" height="30" rx="4"/><path d="m6 12 18 15 18-15"/>`,
    phone: `<path d="M14 5H8c-2 0-3 2-3 4 2 16 14 28 30 30 2 0 4-1 4-3v-6l-10-5-5 6c-5-2-9-6-11-11l6-5-5-10Z"/>`,
    wallet: `<rect x="5" y="10" width="38" height="31" rx="6"/><path d="M5 16h34c3 0 5 2 5 5v6H31c-4 0-6-2-6-5s2-5 6-5h13M33 26h.1"/>`,
  };
  const body = shapes[name] || shapes.info;
  return `<g transform="translate(${x} ${y}) scale(${size / 48})" fill="none" stroke="${color}" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

function pill(x, y, label, fill, color, width = 230) {
  return `${rect(x, y, width, 44, fill, fill, 22, 0)}${text(x + width / 2, y + 29, label, 16, color, 800, Math.max(12, Math.floor(width / 12)), 1, 18, "middle", 1.1)}`;
}

function defs() {
  return `<defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#041333"/><stop offset=".38" stop-color="#064ca6"/><stop offset=".76" stop-color="#087fe0"/><stop offset="1" stop-color="#11b8e8"/></linearGradient>
    <linearGradient id="brandAccent" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#00c2ff"/><stop offset=".48" stop-color="#34d3ff"/><stop offset="1" stop-color="#78f0ff"/></linearGradient>
    <linearGradient id="blueSoft" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f8fcff"/><stop offset=".52" stop-color="#e8f5ff"/><stop offset="1" stop-color="#d8edff"/></linearGradient>
    <linearGradient id="orangeSoft" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff9f1"/><stop offset=".5" stop-color="#ffeedb"/><stop offset="1" stop-color="#ffddb6"/></linearGradient>
    <linearGradient id="redSoft" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff5f6"/><stop offset=".55" stop-color="#ffe2e8"/><stop offset="1" stop-color="#ffcbd7"/></linearGradient>
    <linearGradient id="greenSoft" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1fff8"/><stop offset=".55" stop-color="#d8ffeb"/><stop offset="1" stop-color="#b9f6d5"/></linearGradient>
    <linearGradient id="goldSoft" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffaf0"/><stop offset=".55" stop-color="#fff0c7"/><stop offset="1" stop-color="#ffe09a"/></linearGradient>
    <linearGradient id="reportOrange" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#e95112"/><stop offset=".48" stop-color="#ff8424"/><stop offset="1" stop-color="#ffd04d"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="#7cecff" stop-opacity=".78"/><stop offset=".48" stop-color="#41bfff" stop-opacity=".28"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="11" stdDeviation="14" flood-color="#064a96" flood-opacity=".22"/></filter>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#073a78" flood-opacity=".16"/></filter>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.5" fill="#ffffff" opacity=".22"/></pattern>
  </defs>`;
}
function avatarImage(dataUri, x, y, size, clipId) {
  if (typeof dataUri !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUri)) return "";
  return `<defs><clipPath id="${clipId}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath></defs><image href="${dataUri}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`;
}

function brandHeader(academyName, logoDataUri, teacherAvatarDataUri, title, tone = "blue", height = 238) {
  const report = tone === "orange";
  const nameLen = cleanNotificationText(academyName, 180).length;
  const lines = nameLen > 100 ? 3 : nameLen > 34 ? 2 : 1;
  const font = nameLen > 145 ? 14 : nameLen > 100 ? 17 : nameLen > 60 ? 20 : nameLen > 34 ? 25 : 34;
  const nameY = lines === 1 ? 87 : 65;
  const chars = nameLen > 145 ? 60 : nameLen > 100 ? 48 : 29;
  const subtitleY = lines === 3 ? 143 : lines === 2 ? 135 : 137;
  const titleWidth = Math.min(430, Math.max(300, title.length * 15));
  const titleX = 235;
  const teacherImage = avatarImage(teacherAvatarDataUri, 63, 42, 126, "teacherAvatarClip");
  return `<rect width="1200" height="${height}" fill="url(#brand)"/>
    <rect x="0" y="0" width="1200" height="${height}" fill="url(#dots)"/>
    <circle cx="1090" cy="-10" r="250" fill="url(#glow)"/>
    <circle cx="126" cy="105" r="82" fill="#22d3ee" fill-opacity=".30" filter="url(#softShadow)"/>
    <circle cx="126" cy="105" r="75" fill="none" stroke="url(#brandAccent)" stroke-width="7"/>
    <circle cx="126" cy="105" r="68" fill="#ffffff" stroke="#ffffff" stroke-opacity=".98" stroke-width="4" filter="url(#softShadow)"/>
    ${teacherImage || `${icon("cap", 91, 70, 70, "#07599a")}${text(126, 172, "TEACHER", 10, "#07599a", 900, 12, 1, 12, "middle", 1.2)}`}
    <rect x="1008" y="27" width="164" height="164" rx="31" fill="#42c9f4" fill-opacity=".26" stroke="#8deaff" stroke-opacity=".95" stroke-width="3" filter="url(#softShadow)"/>
    <rect x="1016" y="35" width="148" height="148" rx="25" fill="#ffffff" stroke="#ffffff" stroke-width="3" filter="url(#softShadow)"/>
    <image href="${logoDataUri}" x="1021" y="40" width="138" height="138" preserveAspectRatio="xMidYMid meet"/>
    <path d="M0 204Q280 258 565 214T1200 204V238H0Z" fill="#03478d" opacity=".82"/>
    <path d="M0 ${height-5}Q320 ${height-23} 620 ${height-5}T1200 ${height-7}" fill="none" stroke="url(#brandAccent)" stroke-width="11" opacity="1"/>
    ${text(235, nameY, academyName, font, "#ffffff", 800, chars, lines, font * 1.12)}
    ${text(238, subtitleY, "LEARN  •  GROW  •  EXCEL", 16, "#d9efff", 700, 31, 1, 22, "start", 2.2)}
    <rect x="235" y="168" width="${titleWidth}" height="43" rx="21" fill="${report ? "#fff0d9" : "#ffffff"}" fill-opacity="${report ? ".98" : ".15"}" stroke="${report ? "#ffe0b7" : "#ffffff"}" stroke-opacity="${report ? ".9" : ".34"}"/>
    ${text(titleX + titleWidth/2, 197, title, 18, report ? "#9b4b18" : "#ffffff", 800, 40, 1, 22, "middle", 1.1)}
    <circle cx="960" cy="34" r="5" fill="#ffffff" opacity=".82"/><circle cx="990" cy="62" r="3.5" fill="#ffffff" opacity=".65"/>`;
}
function studentPanel(p, y, h = 220, studentAvatarDataUri = "") {
  const nameLen = cleanNotificationText(p.studentName, 180).length;
  const nameLines = nameLen > 100 ? 3 : nameLen > 52 ? 2 : 1;
  const nameFont = nameLen > 100 ? 17 : nameLen > 52 ? 24 : 35;
  const nameChars = nameLen > 100 ? 52 : nameLen > 52 ? 46 : 44;
  const nameY = nameLines === 3 ? y + 63 : nameLines === 2 ? y + 73 : y + 86;
  const className = cleanNotificationText(p.className, 180);
  const fatherName = cleanNotificationText(p.fatherName, 120);
  const rollNumber = cleanNotificationText(p.rollNumber ?? p.rollNo, 32);
  const classCode = cleanNotificationText(p.classCode, 80);
  const classLines = className.length > 115 ? 3 : className.length > 60 ? 2 : 1;
  const classFont = classLines === 3 ? 10 : className.length > 65 ? 13 : 15;
  const classY = classLines === 3 ? y + h - 65 : classLines === 2 ? y + h - 45 : y + h - 19;
  const classChars = classLines === 3 ? 60 : classLines === 2 ? 60 : 68;
  const classCodeFont = classCode.length > 30 ? 9 : classCode.length > 22 ? 12 : 16;
  const rollNumberFont = rollNumber.length > 18 ? 13 : rollNumber.length > 12 ? 17 : rollNumber.length > 8 ? 23 : 31;
  const studentImage = avatarImage(studentAvatarDataUri, 103, y + h / 2 - 48, 96, "studentAvatarClip");
  return `${rect(48, y, 1104, h, "#ffffff", "#82caff", 27, 3)}
    <rect x="49" y="${y+1}" width="1102" height="${h-2}" rx="26" fill="#ffffff" filter="url(#softShadow)"/>
    <rect x="49" y="${y+1}" width="9" height="${h-2}" rx="4.5" fill="url(#brandAccent)" opacity=".95"/>
    <rect x="820" y="${y+16}" width="314" height="${h-32}" rx="21" fill="url(#blueSoft)" stroke="#c4e6ff" stroke-width="1.5"/>
    <circle cx="151" cy="${y+h/2}" r="62" fill="#d8f3ff" stroke="#36b9f4" stroke-width="4"/>
    <circle cx="151" cy="${y+h/2}" r="53" fill="#ffffff" stroke="#b5e6ff" stroke-width="2"/>
    ${studentImage || icon("cap", 118, y+h/2-34, 66, "#0871bd")}
    ${line(236, y+22, 236, y+h-22, "#d9e8f6", 2)}
    ${text(274, y+39, "STUDENT PROFILE", 14, "#64809c", 800, 32, 1, 17, "start", 1.4)}
    ${text(274, nameY, p.studentName, nameFont, COLORS.navy, 800, nameChars, nameLines, nameFont*1.08)}
    ${optionalText(274, nameLines === 3 ? y+125 : y+130, fatherName ? `PARENT / GUARDIAN  ·  ${fatherName}` : "", 12, "#627c96", 700, 58, 1)}
    ${text(274, classY, `CLASS  ·  ${className}`, classFont, "#315b82", 700, classChars, classLines, classFont*1.35)}
    ${text(852, y+48, "ROLL NUMBER", 12, "#64809c", 800, 24, 1, 15, "start", 1.1)}
    ${text(852, y+94, rollNumber || "—", rollNumberFont, "#075b9e", 800, 32, 1, 34)}
    ${line(850, y+111, 1103, y+111, "#cbdff0", 1.5)}
    ${text(852, y+139, "CLASS CODE", 11, "#64809c", 800, 22, 1, 14, "start", 1.0)}
    ${text(852, y+h-34, classCode || "—", classCodeFont, "#315b82", 800, 80, 1, 18)}`;
}
function infoTile(x, y, w, label, value, iconName, color = COLORS.blue, valueSize = 25) {
  const valueText = cleanNotificationText(value, 180);
  const adjustedSize = valueText.length > 42 ? Math.min(valueSize, 17) : valueText.length > 24 ? Math.min(valueSize, 20) : valueSize;
  return `${rect(x, y, w, 132, "#ffffff", "#acd9fb", 22, 2.5)}
    <rect x="${x+1}" y="${y+1}" width="7" height="130" rx="3" fill="${color}" opacity=".98"/>
    <circle cx="${x+57}" cy="${y+66}" r="33" fill="#e2f4ff" stroke="#c2e7ff" stroke-width="1.5"/>
    ${icon(iconName, x+33, y+42, 48, color)}
    ${text(x+99, y+43, label.toUpperCase(), 12, "#7890a8", 800, 36, 1, 15, "start", .85)}
    ${text(x+99, y+88, valueText, adjustedSize, COLORS.ink, 800, Math.max(16, Math.floor((w-120)/11)), 2, adjustedSize*1.12)}`;
}
function metricCard(x, y, w, h, label, value, iconName, variant = "blue", subline = "") {
  const variants = {
    blue: { border: "#8ed4ff", color: "#006ed1", tint: "#e7f5ff" },
    red: { border: "#ff9db2", color: "#d71942", tint: "#ffe9ef" },
    green: { border: "#8ce2b6", color: "#047b51", tint: "#e4fff1" },
    orange: { border: "#ffc07d", color: "#c6530b", tint: "#fff0dd" },
  };
  const v = variants[variant] || variants.blue;
  const valueLen = cleanNotificationText(value, 100).length;
  const valueSize = valueLen > 26 ? 24 : valueLen > 17 ? 30 : valueLen > 10 ? 37 : 45;
  const labelSize = w < 380 ? 11 : 13;
  const subSize = w < 380 ? 12 : 14;
  return `${rect(x, y, w, h, "#ffffff", v.border, 24, 2)}
    <rect x="${x+1}" y="${y+1}" width="${w-2}" height="${h-2}" rx="23" fill="${v.tint}" opacity=".28"/>
    <rect x="${x+1}" y="${y+1}" width="7" height="${h-2}" rx="3" fill="${v.color}" opacity=".85"/>
    <circle cx="${x+66}" cy="${y+h/2}" r="39" fill="#ffffff" stroke="${v.border}" stroke-width="1.5"/>
    ${icon(iconName, x+38, y+h/2-28, 56, v.color)}
    ${text(x+124, y+48, label.toUpperCase(), labelSize, "#71869b", 800, w < 380 ? 28 : 44, 1, 16, "start", .7)}
    ${text(x+124, y+101, value, valueSize, v.color, 800, w < 380 ? 17 : 24, 1, valueSize*1.08)}
    ${optionalText(x+124, y+h-18, subline, subSize, "#62778b", 600, w < 380 ? 30 : 54, 1)}`;
}
function footer(p, y, tone = "blue") {
  const report = tone === "orange";
  const accent = report ? "#b85a20" : "#0b5e9e";
  const bg = report ? "#fffaf5" : "#f1f8ff";
  const contactPhone = cleanNotificationText(p.academyContactPhone);
  const contactEmail = cleanNotificationText(p.academyContactEmail);
  return `${rect(48, y, 1104, 126, "#ffffff", report ? "#f0ddcd" : "#d2e7f8", 24, 2)}
    <rect x="49" y="${y+1}" width="1102" height="124" rx="23" fill="${bg}"/>
    <rect x="49" y="${y+1}" width="7" height="124" rx="3" fill="${accent}"/>
    ${text(80, y+37, "ACADEMY SUPPORT", 13, accent, 800, 30, 1, 16, "start", 1.35)}
    ${optionalText(80, y+72, p.preparedBy, 18, COLORS.ink, 700, 42, 1)}
    ${text(80, y+105, `${p.className}  •  ${p.classCode}`, 13, "#71869a", 600, 58, 1)}
    ${contactPhone ? `${icon("phone", 620, y+43, 30, accent)}${text(660, y+72, contactPhone, 16, COLORS.ink, 700, 26, 1)}` : ""}
    ${contactEmail ? `${icon("mail", 875, y+43, 30, accent)}${text(914, y+72, contactEmail, 15, COLORS.ink, 600, 27, 1)}` : ""}`;
}
function pageBackground(width, height, report = false) {
  return `<rect width="${width}" height="${height}" fill="#f5f9fd"/>
    <circle cx="1120" cy="330" r="180" fill="#e1f1ff" opacity=".33"/>
    <circle cx="65" cy="980" r="190" fill="#e7f3ff" opacity=".26"/>
    <path d="M0 ${height-170}Q240 ${height-220} 480 ${height-170}T960 ${height-168}T1200 ${height-190}V${height}H0Z" fill="${report ? "#fff0df" : "#eaf5ff"}" opacity=".25"/>`;
}
function attendanceSvg(p, logo, avatars = {}) {
  const date = formatNotificationDate(p.attendanceDate) || cleanNotificationText(p.attendanceDate, 32);
  const status = cleanNotificationText(p.attendanceStatus, 24).toUpperCase();
  const message = cleanNotificationText(p.parentMessage) || "Regular attendance is essential for your child's academic progress. Please support their presence in upcoming classes.";
  const contactY = 1300;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1480" viewBox="0 0 1200 1480">${defs()}${pageBackground(1200,1480)}
    ${brandHeader(p.academyName, logo, avatars.teacher, "ATTENDANCE ALERT")}
    ${pill(52, 266, status, "#ffe5e8", "#b51f34", 220)}
    ${icon("bell", 1000, 265, 70, "#c51e35")}
    ${text(62, 365, "Dear Parent / Guardian,", 34, COLORS.navy, 800, 52, 1)}
    ${text(62, 414, `Your child has been marked ${status} in today's attendance record.`, 25, "#45576d", 500, 82, 2, 34)}
    ${studentPanel(p, 462, 220, avatars.student)}
    ${text(58, 708, "ATTENDANCE DETAILS", 17, "#52789d", 800, 35, 1, 18, "start", 1.5)}
    ${infoTile(48, 736, 264, "Date", date, "calendar", COLORS.blue, 24)}
    ${infoTile(328, 736, 264, "Class", p.className, "layers", COLORS.blue, 23)}
    ${infoTile(608, 736, 264, "Class Code", p.classCode, "code", COLORS.blue, 23)}
    ${infoTile(888, 736, 264, "Time", cleanNotificationText(p.attendanceTime) || "—", "clock", COLORS.blue, 23)}
    ${metricCard(48, 876, 532, 190, "Previous absent days · this month", String(p.previousAbsentDays ?? 0), "calendar", "red", "Recorded for the current month")}
    ${metricCard(620, 876, 532, 190, "Attendance percentage", cleanNotificationText(p.attendancePercentage) || "—", "chart", "green", "Based on saved attendance records")}
    ${rect(48, 1094, 1104, 160, "url(#blueSoft)", "#c8e5fb", 26)}
    ${icon("info", 82, 1140, 58, COLORS.blue)}
    ${line(160, 1122, 160, 1224, "#9cc7ea", 3)}
    ${text(195, 1154, "A NOTE FOR PARENTS", 15, "#17629d", 800, 35, 1, 18, "start", 1.2)}
    ${text(195, 1201, message, 23, COLORS.ink, 600, 75, 2, 31)}
    ${footer(p, contactY, "blue")}
    <path d="M0 1450Q250 1406 480 1450T960 1444T1200 1438V1480H0Z" fill="#07599a"/><path d="M0 1450Q280 1430 550 1460T1200 1444" fill="none" stroke="#4ab4ed" stroke-width="12" opacity=".75"/>
  </svg>`;
}

function quizSvg(p, logo, avatars = {}) {
  const pct = p.percentage ?? `${Math.round((Number(p.marksObtained) / Number(p.totalMarks)) * 1000) / 10}%`;
  const pctNumber = Math.max(0, Math.min(100, Number.parseFloat(String(pct)) || 0));
  const date = formatNotificationDate(p.quizDate) || cleanNotificationText(p.quizDate, 32);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1450" viewBox="0 0 1200 1450">${defs()}${pageBackground(1200,1450)}
    ${brandHeader(p.academyName, logo, avatars.teacher, "QUIZ RESULT")}
    ${pill(52, 266, "ASSESSMENT UPDATE", "#fff1d4", "#95600d", 270)}
    ${icon("trophy", 1004, 270, 80, "#e5a323")}
    ${text(62, 354, "Assalam-o-Alaikum!", 34, COLORS.navy, 800, 54, 1)}
    ${text(62, 402, "Please find the saved quiz result and assessment details below.", 23, "#4b5d73", 500, 78, 2, 31)}
    ${studentPanel(p, 432, 220, avatars.student)}
    ${text(58, 694, "ASSESSMENT DETAILS", 14, "#52789d", 800, 34, 1, 17, "start", 1.35)}
    ${infoTile(48, 718, 532, "Quiz / Chapter", p.quizName, "book", COLORS.blue, 27)}
    ${infoTile(620, 718, 532, "Quiz Date", date, "calendar", COLORS.blue, 27)}
    ${metricCard(48, 878, 532, 184, "Marks obtained", `${p.marksObtained} / ${p.totalMarks}`, "check", "green", "Saved assessment result")}
    ${metricCard(620, 878, 532, 184, "Percentage", pct, "chart", "orange", "Calculated from saved quiz marks")}
    <circle cx="1084" cy="970" r="37" fill="none" stroke="#f7dfb6" stroke-width="8"/>
    <circle cx="1084" cy="970" r="37" fill="none" stroke="#d28a1a" stroke-width="8" stroke-linecap="round" stroke-dasharray="233" stroke-dashoffset="${233 - (233 * pctNumber / 100)}" transform="rotate(-90 1084 970)"/>
    ${rect(48, 1084, 1104, 90, "#ffffff", "#d6e8f7", 22)}
    ${text(78, 1120, "PERFORMANCE PROGRESS", 13, "#6b8299", 800, 40, 1, 16, "start", 1.2)}
    ${rect(78, 1138, 1040, 15, "#e7eff7", "#e7eff7", 8, 0)}
    <rect x="78" y="1138" width="${1040 * pctNumber / 100}" height="15" rx="8" fill="#18a66d"/>
    ${rect(48, 1190, 1104, 76, "url(#blueSoft)", "#c8e5fb", 22)}
    ${icon("book", 76, 1205, 46, COLORS.blue)}
    ${text(142, 1235, p.resultMessage || "Keep practicing and stay consistent. Every step forward counts!", 19, "#254b70", 600, 92, 2, 24)}
    ${footer(p, 1280, "blue")}
  </svg>`;
}

function feeSvg(p, logo, avatars = {}) {
  const overdue = p.kind === "fee_overdue";
  const genericReminder = p.kind === "fee_reminder";
  const accent = overdue ? COLORS.red : "#bf6b13";
  const soft = overdue ? "url(#redSoft)" : "url(#orangeSoft)";
  const status = cleanNotificationText(p.paymentStatus) || (overdue ? "OVERDUE" : genericReminder ? "OUTSTANDING" : "DUE SOON");
  const dueDate = formatNotificationDate(p.dueDate) || cleanNotificationText(p.dueDate, 32) || "Not recorded";
  const heading = overdue ? "FEE OVERDUE ALERT" : "FEE REMINDER";
  const pillLabel = overdue ? "PAYMENT OVERDUE" : genericReminder ? "OUTSTANDING BALANCE" : "DUE SOON";
  const greeting = overdue
    ? "Our records show that a fee balance remains after its due date."
    : genericReminder
      ? "This is a reminder that an outstanding fee balance is recorded for this student."
      : "This is a friendly reminder about the upcoming fee payment.";
  const dueDateLabel = genericReminder ? "Due date" : overdue ? "Original due date" : "Due date";
  const height = 1400;
  const extraInstruction = cleanNotificationText(p.paymentInstructions)
    ? `${rect(48, 1080, 1104, 112, "url(#blueSoft)", "#c9e4f8", 22)}${icon("info", 77, 1106, 48, COLORS.blue)}${text(145, 1135, "PAYMENT INFORMATION", 14, "#17629d", 800, 35, 1, 16, "start", 1.2)}${text(145, 1170, p.paymentInstructions, 18, COLORS.ink, 600, 94, 2, 23)}`
    : `${rect(48, 1080, 1104, 90, "url(#blueSoft)", "#c9e4f8", 22)}${icon("info", 77, 1102, 45, COLORS.blue)}${text(145, 1136, "Please contact the academy office if you need help with payment.", 20, COLORS.ink, 600, 85, 2, 25)}`;
  const footerY = 1205;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="${height}" viewBox="0 0 1200 ${height}">${defs()}${pageBackground(1200,height)}
    ${brandHeader(p.academyName, logo, avatars.teacher, heading)}
    ${pill(52, 266, pillLabel, overdue ? "#ffe2e5" : "#fff0cf", accent, overdue ? 260 : genericReminder ? 300 : 190)}
    ${icon("wallet", 1000, 264, 78, accent)}
    ${text(62, 365, "Dear Parent / Guardian,", 34, COLORS.navy, 800, 52, 1)}
    ${text(62, 414, greeting, 24, "#4b5c72", 500, 82, 2, 32)}
    ${studentPanel(p, 450, 220, avatars.student)}
    ${infoTile(48, 684, 532, "Fee month", p.feeMonth, "calendar", COLORS.blue, 29)}
    ${infoTile(620, 684, 532, dueDateLabel, dueDate, "clock", accent, 29)}
    ${rect(48, 840, 1104, 220, "#ffffff", overdue ? "#f2c6cc" : "#f2d9bd", 28)}
    <rect x="49" y="841" width="1102" height="218" rx="27" fill="${soft}" opacity=".67"/>
    ${icon("coins", 85, 886, 75, accent)}
    ${text(184, 900, "OUTSTANDING AMOUNT", 16, "#7b8795", 800, 38, 1, 18, "start", 1.2)}
    ${text(184, 970, p.currencyAmount || String(p.amountDue), 49, accent, 800, 30, 1, 54)}
    ${optionalText(184, 1017, p.totalFeeLabel ? `Total fee: ${p.totalFeeLabel}` : "", 17, "#627387", 600, 46, 1)}
    ${line(750, 870, 750, 1030, overdue ? "#eab4bc" : "#eed0ad", 2)}
    ${text(795, 900, "PAYMENT STATUS", 16, "#7b8795", 800, 38, 1, 18, "start", 1.2)}
    ${text(795, 964, status, 34, accent, 800, 21, 1, 38)}
    ${overdue ? `${pill(795, 990, `${p.daysOverdue} DAYS OVERDUE`, "#ffe2e5", COLORS.red, 245)}` : ""}
    ${extraInstruction}
    ${footer(p, footerY, "blue")}
    ${overdue ? `<path d="M0 ${height-22}Q290 ${height-72} 590 ${height-22}T1200 ${height-25}V${height}H0Z" fill="#b71f35"/>` : `<path d="M0 ${height-22}Q290 ${height-72} 590 ${height-22}T1200 ${height-25}V${height}H0Z" fill="#0b62a4"/>`}
  </svg>`;
}

function monthlySvg(p, logo, avatars = {}) {
  const rows = Array.isArray(p.evaluations) ? p.evaluations.slice(0, 5) : [];
  const tableTop = 982;
  let cursorY = tableTop;
  const items = rows.map((row, index) => {
    const category = cleanNotificationText(row.category || `Criterion ${index + 1}`, 100);
    const remark = cleanNotificationText(row.remark, 800);
    const remarkLines = remark ? wrapAll(remark, 66) : [];
    if (remarkLines.length > 12) throw new Error("A teacher remark is too long for a single WhatsApp report image. Shorten the saved remark or use a paginated report workflow.");
    const height = Math.max(86, 34 + Math.max(1, remarkLines.length) * 24);
    const y = cursorY;
    const background = index % 2 ? "#ffffff" : "#fffaf5";
    const grade = cleanNotificationText(row.grade, 12);
    const block = `${rect(48, y, 1104, height, background, "#e8edf4", 16)}
      <rect x="49" y="${y+1}" width="6" height="${height-2}" rx="3" fill="#df8a3b" opacity=".82"/>
      <circle cx="91" cy="${y + height/2}" r="22" fill="#fff0df"/>${text(91, y + height/2 + 6, String(index + 1).padStart(2,"0"), 14, "#a9511b", 800, 4, 1, 16, "middle")}
      ${text(137, y + 35, category, 18, "#20334c", 800, 27, 2, 22)}
      ${remark ? text(410, y + 30, remark, 15, "#536174", 500, 65, remarkLines.length, 21) : text(410, y + 30, "No saved remark for this criterion.", 14, "#8592a2", 500, 58, 1)}
      ${grade ? `${rect(1030, y + height/2 - 21, 78, 42, "#fff0df", "#f7dfc6", 21, 1)}${text(1069, y + height/2 + 7, grade, 18, "#a9511b", 800, 6, 1, 21, "middle")}` : ""}`;
    cursorY += height + 10;
    return block;
  }).join("");
  if (!rows.length) cursorY += 92;
  const footerY = cursorY + 28;
  const imageHeight = footerY + 190;
  const attendanceMetric = cleanNotificationText(p.attendancePercentage);
  const quizMetric = cleanNotificationText(p.quizAverage);
  const feeMetric = cleanNotificationText(p.feeStatus);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="${imageHeight}" viewBox="0 0 1200 ${imageHeight}">${defs()}<rect width="1200" height="${imageHeight}" fill="#fffdfb"/>
    <rect x="20" y="20" width="1160" height="${imageHeight-40}" rx="27" fill="#ffffff" stroke="#eadfd4" stroke-width="2" filter="url(#softShadow)"/>
    <rect x="20" y="20" width="1160" height="13" rx="6" fill="url(#reportOrange)"/>
    ${brandHeader(p.academyName, logo, avatars.teacher, "STUDENT PERFORMANCE REPORT", "orange", 226)}
    ${text(64, 282, "MONTHLY PERFORMANCE", 13, "#a75a2c", 800, 32, 1, 15, "start", 1.35)}
    ${text(64, 324, p.reportingPeriod, 28, "#24364d", 800, 36, 1)}
    ${optionalText(690, 282, p.preparedBy ? `PREPARED BY  ·  ${p.preparedBy}` : "", 15, "#7d695a", 700, 54, 1)}
    ${studentPanel(p, 350, 210, avatars.student)}
    ${text(58, 582, "01  /  MONTHLY OVERVIEW", 14, "#b85a20", 800, 38, 1, 18, "start", 1.4)}
    ${text(58, 620, "Learning & Wellbeing", 26, "#1e2e43", 800, 38, 1)}
    ${metricCard(48, 646, 350, 150, "Attendance", attendanceMetric || "—", "chart", "green", `${p.attendedDays ?? "—"} attended / ${p.totalRecordedDays ?? "—"} recorded`)}
    ${metricCard(425, 646, 350, 150, "Quiz average", quizMetric || "—", "book", "orange", `${p.marksObtained ?? "—"} / ${p.totalMarks ?? "—"} total marks`)}
    ${metricCard(802, 646, 350, 150, "Fee status", feeMetric || "—", "wallet", "blue", p.reportingPeriod)}
    ${text(58, 844, "02  /  TEACHER EVALUATION & FEEDBACK", 14, "#b85a20", 800, 48, 1, 18, "start", 1.4)}
    ${text(58, 881, "Academic & Personal Development", 24, "#1e2e43", 800, 40, 1)}
    ${rect(48, 908, 1104, 56, "#122e50", "#122e50", 14)}
    ${text(137, 944, "EVALUATION CRITERIA", 13, "#ffffff", 800, 28, 1, 15, "start", .8)}
    ${text(410, 944, "TEACHER REMARKS", 13, "#ffffff", 800, 28, 1, 15, "start", .8)}
    ${text(1069, 944, "GRADE", 13, "#ffffff", 800, 8, 1, 15, "middle", .8)}
    ${items || text(74, 1050, "No saved teacher evaluation rows are available for this reporting period.", 17, "#657386", 500, 84, 2)}
    ${line(58, footerY, 1142, footerY, "#e6d6c8", 2)}
    ${text(62, footerY + 38, "ISSUED BY", 13, "#bd5a1b", 800, 24, 1, 15, "start", 1.2)}
    ${optionalText(62, footerY + 72, p.preparedBy, 19, "#26384e", 700, 45, 1)}
    ${optionalText(62, footerY + 106, p.academyContactPhone, 16, "#596b80", 600, 38, 1)}
    ${optionalText(62, footerY + 136, p.academyContactEmail, 16, "#596b80", 600, 42, 1)}
    ${text(740, footerY + 72, `REPORT PERIOD  ·  ${p.reportingPeriod}`, 15, "#596b80", 700, 42, 1)}
    ${text(740, footerY + 106, `${p.className}  ·  ${p.classCode}`, 15, "#596b80", 700, 44, 1)}
    <rect x="58" y="${imageHeight-48}" width="1084" height="2" rx="1" fill="#f0dfd0"/>
    <text x="58" y="${imageHeight-22}" font-family="DejaVu Sans" font-size="11" fill="#987b68">EDUTRACK  •  ACADEMIC RECORD  •  ${escapeSvgText(p.reportingPeriod)}</text>
  </svg>`;
}


function announcementSvg(p, logo, avatars = {}) {
  const title = cleanNotificationText(p.announcementTitle, 180);
  const message = cleanNotificationText(p.announcementMessage, 2200);
  const className = cleanNotificationText(p.className, 180);
  const classCode = cleanNotificationText(p.classCode, 80);
  const titleLines = wrapAll(title, 42);
  const messageLines = wrapAll(message, 62);
  if (titleLines.length > 4 || messageLines.length > 18) {
    throw new Error("The announcement is too long for a single WhatsApp image. Shorten the title or message.");
  }
  const titleHeight = Math.max(92, titleLines.length * 48 + 36);
  const messageTop = 410 + titleHeight;
  const messageHeight = Math.max(210, messageLines.length * 33 + 70);
  const imageHeight = Math.max(940, messageTop + messageHeight + 190);
  const titleBlock = text(80, 350, title, 34, "#1f2f45", 800, 42, 4, 47);
  const messageBlock = text(88, messageTop + 66, message, 22, "#495b70", 500, 62, 18, 33);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="${imageHeight}" viewBox="0 0 1200 ${imageHeight}">${defs()}
    <rect width="1200" height="${imageHeight}" fill="#fffdfb"/>
    <rect x="20" y="20" width="1160" height="${imageHeight - 40}" rx="28" fill="#ffffff" stroke="#eadfd4" stroke-width="2" filter="url(#softShadow)"/>
    <rect x="20" y="20" width="1160" height="13" rx="6" fill="url(#reportOrange)"/>
    ${brandHeader(p.academyName, logo, avatars.teacher, "SCHOOL ANNOUNCEMENT", "orange", 238)}
    ${text(80, 296, "IMPORTANT NOTICE", 14, "#b85a20", 800, 28, 1, 18, "start", 1.5)}
    ${titleBlock}
    ${rect(64, messageTop, 1072, messageHeight, "#fffaf5", "#f4dfcd", 24, 2)}
    ${messageBlock}
    ${rect(64, messageTop + messageHeight + 22, 1072, 92, "#f4f8fc", "#e2eaf2", 18, 1)}
    ${icon("layers", 92, messageTop + messageHeight + 41, 50, "#f97316")}
    ${text(158, messageTop + messageHeight + 55, "FOR CLASS", 12, "#9a6845", 800, 20, 1, 16, "start", 1.2)}
    ${text(158, messageTop + messageHeight + 86, className, 22, "#23374f", 800, 58, 1, 28)}
    ${optionalText(900, messageTop + messageHeight + 77, `CODE  ·  ${classCode}`, 15, "#64748b", 700, 25, 1)}
    ${text(64, imageHeight - 74, "EDUTRACK  •  SCHOOL COMMUNICATION", 13, "#9b765f", 800, 48, 1, 16, "start", 1.2)}
    ${text(1134, imageHeight - 74, "OFFICIAL NOTICE", 13, "#b85a20", 800, 24, 1, 16, "end", 1.1)}
  </svg>`;
}

export function buildNotificationSvg(payload, logoDataUri, avatars = {}) {
  const validation = validateNotificationImagePayload(payload);
  if (!validation.valid) throw new Error(validation.error);
  if (typeof logoDataUri !== "string" || !logoDataUri.startsWith("data:image/")) {
    throw new Error("EduTrack academy logo is unavailable.");
  }
  switch (validation.kind) {
    case "attendance_absent": return attendanceSvg(payload, logoDataUri, avatars);
    case "quiz_result": return quizSvg(payload, logoDataUri, avatars);
    case "fee_upcoming":
    case "fee_overdue":
    case "fee_reminder": return feeSvg(payload, logoDataUri, avatars);
    case "monthly_report": return monthlySvg(payload, logoDataUri, avatars);
    case "announcement": return announcementSvg(payload, logoDataUri, avatars);
    default: throw new Error("Unsupported notification image type.");
  }
}
