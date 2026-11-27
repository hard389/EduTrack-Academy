import {
  isMonthlyReportWhatsAppEnabled,
  MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE,
} from "./monthlyReportFeature.js";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";

const MEDIA_TTL_SECONDS = 300;
const MEDIA_ROUTE = "/api/whatsapp/monthly-report-media";

function getSigningKey(): Buffer {
  const encoded = process.env.WHATSAPP_MEDIA_SIGNING_SECRET?.trim();

  if (!encoded) {
    throw new Error("WHATSAPP_MEDIA_SIGNING_SECRET is not configured.");
  }

  const key = Buffer.from(encoded, "base64");

  if (
    key.length !== 32 ||
    key.toString("base64") !== encoded
  ) {
    throw new Error("WHATSAPP_MEDIA_SIGNING_SECRET must be a valid base64-encoded 32-byte key.");
  }

  return key;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";

  const email = value.trim().toLowerCase();

  if (
    !email ||
    email.includes("/") ||
    email.includes("\\") ||
    /\s/.test(email) ||
    !email.includes("@") ||
    email.startsWith("@") ||
    email.endsWith("@")
  ) {
    return "";
  }

  return email;
}

function createSignature(mediaId: string, expiresAt: number): string {
  const key = getSigningKey();
  const payload = `monthly-report-pdf:v1\n${mediaId}\n${expiresAt}`;

  return createHmac("sha256", key)
    .update(payload)
    .digest("hex");
}

function getPublicApplicationUrl(): URL {
  const configured = process.env.PUBLIC_APP_URL?.trim();

  if (!configured) {
    throw new Error("PUBLIC_APP_URL is not configured.");
  }

  let base: URL;

  try {
    base = new URL(configured);
  } catch {
    throw new Error("PUBLIC_APP_URL is invalid.");
  }

  const localHost = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);

  if (
    (base.protocol !== "https:" && !(localHost && base.protocol === "http:")) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("PUBLIC_APP_URL must be a valid HTTPS application origin.");
  }

  return base;
}

export async function createMonthlyReportMediaLink(
  input: {
    db: Firestore;
    tenantId: string;
    jobId: string;
  },
): Promise<{
  url: string;
  mediaId: string;
  expiresAt: string;
  expiresInSeconds: number;
}> {
  if (!isMonthlyReportWhatsAppEnabled()) {
    throw new Error(MONTHLY_REPORT_WHATSAPP_DISABLED_MESSAGE);
  }

  const tenantId = normalizeEmail(input.tenantId);
  const jobId = input.jobId.trim();

  if (!tenantId || !/^[a-f0-9]{64}$/i.test(jobId)) {
    throw new Error("Monthly report media identity is invalid.");
  }

  const mediaId = randomBytes(18).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + MEDIA_TTL_SECONDS;
  const expiresTimestamp = Timestamp.fromMillis(expiresAt * 1000);

  const accessRef = input.db
    .collection("monthlyReportMediaAccess")
    .doc(mediaId);

  await accessRef.create({
    version: 1,
    purpose: "monthly_report_pdf",
    tenantId,
    jobId,
    expiresAt: expiresTimestamp,
    createdAt: FieldValue.serverTimestamp(),
  });

  const signature = createSignature(mediaId, expiresAt);
  const url = getPublicApplicationUrl();

  url.pathname = MEDIA_ROUTE;
  url.search = "";
  url.hash = "";
  url.searchParams.set("id", mediaId);
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signature);

  return {
    url: url.toString(),
    mediaId,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    expiresInSeconds: MEDIA_TTL_SECONDS,
  };
}

export async function verifyMonthlyReportMediaLink(
  input: {
    db: Firestore;
    mediaId: string;
    expiresAt: string;
    signature: string;
  },
): Promise<{
  tenantId: string;
  jobId: string;
} | null> {
  if (!isMonthlyReportWhatsAppEnabled()) return null;

  const { mediaId, signature } = input;

  if (
    !/^[A-Za-z0-9_-]{24}$/.test(mediaId) ||
    !/^\d{10}$/.test(input.expiresAt) ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return null;
  }

  const expiresAt = Number(input.expiresAt);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MEDIA_TTL_SECONDS
  ) {
    return null;
  }

  let expected: Buffer;

  try {
    expected = Buffer.from(createSignature(mediaId, expiresAt), "hex");
  } catch {
    return null;
  }

  const supplied = Buffer.from(signature, "hex");

  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return null;
  }

  const snapshot = await input.db
    .collection("monthlyReportMediaAccess")
    .doc(mediaId)
    .get();

  if (!snapshot.exists) return null;

  const data = snapshot.data();

  if (
    !data ||
    data.version !== 1 ||
    data.purpose !== "monthly_report_pdf" ||
    !(data.expiresAt instanceof Timestamp) ||
    Math.floor(data.expiresAt.toMillis() / 1000) !== expiresAt
  ) {
    return null;
  }

  const tenantId = normalizeEmail(data.tenantId);
  const jobId = typeof data.jobId === "string" ? data.jobId : "";

  if (!tenantId || !/^[a-f0-9]{64}$/i.test(jobId)) {
    return null;
  }

  return { tenantId, jobId };
}
