import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { getFirebaseAdminAuth, getFirebaseAdminFirestore, verifyAdminRequest } from "./firebaseAdmin.js";
import { verifyTeacherRequest } from "./teacherAuth.js";
import { resolveAcademySession } from "./academyIdentity.js";
import {
  buildScannerEndpoint,
  mapScannerResponse,
  normalizeWhatsAppNumber,
  validateScannerBaseUrl,
  WHATSAPP_NUMBER_PROVIDER_BATCH_SIZE,
} from "./whatsappNumberVerificationDomain.mjs";

type RecordLike = Record<string, unknown>;
type RequestLike = { method?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown };

export class WhatsAppNumberVerificationError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "WhatsAppNumberVerificationError";
  }
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function encryptionKey(): Buffer {
  const encoded = process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new WhatsAppNumberVerificationError(503, "Server-side WhatsApp credential encryption is not configured.");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new WhatsAppNumberVerificationError(503, "Server-side WhatsApp credential encryption key is invalid.");
  }
  return key;
}

function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptSecret(data: RecordLike, prefix: "appKey" | "authKey"): string {
  const ciphertext = clean(data[`${prefix}Ciphertext`]);
  const iv = clean(data[`${prefix}Iv`]);
  const tag = clean(data[`${prefix}Tag`]);
  if (!ciphertext || !iv || !tag) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new WhatsAppNumberVerificationError(503, "Stored number-verification credentials could not be decrypted. Check the server encryption key.");
  }
}

function scannerSettingsRef(db: Firestore) {
  // Deliberately isolated from platformSettings/whatsapp, which controls existing message automation.
  return db.collection("platformSettings").doc("whatsappNumberScanner");
}

function publicSettings(data: RecordLike) {
  return {
    success: true,
    settings: {
      scannerBaseUrl: clean(data.scannerBaseUrl),
      enabled: data.enabled === true,
      appKeyConfigured: Boolean(clean(data.appKeyCiphertext)),
      authKeyConfigured: Boolean(clean(data.authKeyCiphertext)),
      credentialsConfigured: Boolean(clean(data.appKeyCiphertext) && clean(data.authKeyCiphertext)),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
    },
  };
}

async function adminContext(request: RequestLike) {
  const actor = await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  const authUser = await getFirebaseAdminAuth().getUser(actor.uid);
  if (authUser.disabled || clean(authUser.email).toLowerCase() !== actor.email.toLowerCase()) {
    throw new WhatsAppNumberVerificationError(403, "Administrator account verification failed.");
  }
  return { db: getFirebaseAdminFirestore(), uid: actor.uid, email: actor.email.toLowerCase() };
}

export async function getAdminWhatsAppNumberScannerSettings(request: RequestLike) {
  const { db } = await adminContext(request);
  const snapshot = await scannerSettingsRef(db).get();
  return publicSettings(snapshot.data() ?? {});
}

export async function saveAdminWhatsAppNumberScannerSettings(request: RequestLike) {
  const { db, uid, email } = await adminContext(request);
  if (!isRecord(request.body)) throw new WhatsAppNumberVerificationError(400, "A valid JSON request body is required.");
  const body = request.body;
  const ref = scannerSettingsRef(db);
  const snapshot = await ref.get();
  const current = snapshot.data() ?? {};

  const suppliedBaseUrl = body.scannerBaseUrl === undefined ? clean(current.scannerBaseUrl) : clean(body.scannerBaseUrl);
  const checkedUrl = validateScannerBaseUrl(suppliedBaseUrl);
  if (!checkedUrl.valid) throw new WhatsAppNumberVerificationError(400, checkedUrl.error || "Invalid scanner URL.");

  const appKey = clean(body.appKey);
  const authKey = clean(body.authKey);
  const removeCredentials = body.removeCredentials === true;
  if (Boolean(appKey) !== Boolean(authKey)) {
    throw new WhatsAppNumberVerificationError(400, "Enter both Scanner App Key and Auth Key together.");
  }
  if (removeCredentials && (appKey || authKey)) {
    throw new WhatsAppNumberVerificationError(400, "Choose either replace or remove scanner credentials.");
  }

  const patch: RecordLike = {
    scannerBaseUrl: checkedUrl.value,
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled === true,
    updatedAt: new Date().toISOString(),
    updatedByUid: uid,
    updatedByEmail: email,
  };

  if (appKey && authKey) {
    const encryptedApp = encryptSecret(appKey);
    const encryptedAuth = encryptSecret(authKey);
    Object.assign(patch, {
      appKeyCiphertext: encryptedApp.ciphertext,
      appKeyIv: encryptedApp.iv,
      appKeyTag: encryptedApp.tag,
      authKeyCiphertext: encryptedAuth.ciphertext,
      authKeyIv: encryptedAuth.iv,
      authKeyTag: encryptedAuth.tag,
      credentialsEncryption: "aes-256-gcm-v1",
    });
  } else if (removeCredentials) {
    Object.assign(patch, {
      appKeyCiphertext: null, appKeyIv: null, appKeyTag: null,
      authKeyCiphertext: null, authKeyIv: null, authKeyTag: null,
      credentialsEncryption: null,
    });
    patch.enabled = false;
  }

  const willHaveCredentials = appKey && authKey
    ? true
    : removeCredentials
      ? false
      : Boolean(clean(current.appKeyCiphertext) && clean(current.authKeyCiphertext));
  if (patch.enabled === true && (!checkedUrl.valid || !willHaveCredentials)) {
    throw new WhatsAppNumberVerificationError(409, "Configure the HTTPS scanner URL and both credentials before enabling number verification.");
  }

  await ref.set(patch, { merge: true });
  const saved = await ref.get();
  return publicSettings(saved.data() ?? {});
}

async function getConfiguredScanner(db: Firestore) {
  const snapshot = await scannerSettingsRef(db).get();
  const data = snapshot.data() ?? {};
  if (data.enabled !== true) {
    throw new WhatsAppNumberVerificationError(503, "WhatsApp number verification is not enabled by the administrator.");
  }
  const checkedUrl = validateScannerBaseUrl(data.scannerBaseUrl);
  const appKey = decryptSecret(data, "appKey");
  const authKey = decryptSecret(data, "authKey");
  if (!checkedUrl.valid || !appKey || !authKey) {
    throw new WhatsAppNumberVerificationError(503, "WhatsApp number verification is not fully configured.");
  }
  return { endpoint: buildScannerEndpoint(checkedUrl.value!), appKey, authKey };
}

async function callProvider(db: Firestore, numbers: string[]) {
  const scanner = await getConfiguredScanner(db);
  let response: Response;
  try {
    response = await fetch(scanner.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ app_key: scanner.appKey, auth_key: scanner.authKey, numbers }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    return numbers.map((number) => ({ number, status: "verification_failed" as const }));
  }

  if (!response.ok) {
    return numbers.map((number) => ({ number, status: "verification_failed" as const }));
  }
  let payload: unknown;
  try {
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("Provider response too large.");
    payload = JSON.parse(text);
  } catch {
    return numbers.map((number) => ({ number, status: "verification_failed" as const }));
  }
  return mapScannerResponse(payload, numbers);
}

async function consumeRateLimit(db: Firestore, identity: string, limit: number) {
  const key = createHmac("sha256", encryptionKey()).update(identity).digest("hex");
  const ref = scannerSettingsRef(db).collection("rateLimits").doc(key);
  const now = Date.now();
  const windowMs = 60_000;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    const startedAt = Number(data.windowStartedAtMs) || 0;
    const currentCount = startedAt > 0 && now - startedAt < windowMs ? Number(data.count) || 0 : 0;
    if (currentCount >= limit) throw new WhatsAppNumberVerificationError(429, "Too many number-verification requests. Try again in one minute.");
    const nextStartedAt = currentCount === 0 ? now : startedAt;
    transaction.set(ref, {
      windowStartedAtMs: nextStartedAt,
      count: currentCount + 1,
      expiresAt: Timestamp.fromMillis(now + 48 * 60 * 60 * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function requestBody(request: RequestLike): RecordLike {
  if (!isRecord(request.body)) throw new WhatsAppNumberVerificationError(400, "A valid JSON request body is required.");
  return request.body;
}

function parseNumbers(body: RecordLike): string[] {
  if (!Array.isArray(body.numbers) || body.numbers.length < 1 || body.numbers.length > WHATSAPP_NUMBER_PROVIDER_BATCH_SIZE) {
    throw new WhatsAppNumberVerificationError(400, "Provide between 1 and 50 phone numbers per verification request.");
  }
  const unique = [...new Set(body.numbers.map(normalizeWhatsAppNumber).filter((value): value is string => Boolean(value)))];
  if (unique.length !== body.numbers.length) {
    throw new WhatsAppNumberVerificationError(400, "Every submitted phone number must be valid and unique within this batch.");
  }
  return unique;
}

export async function verifyTeacherWhatsAppNumbers(request: RequestLike) {
  const teacher = await verifyTeacherRequest(request as Parameters<typeof verifyTeacherRequest>[0]);
  const body = requestBody(request);
  const numbers = parseNumbers(body);
  await consumeRateLimit(teacher.db, `teacher:${teacher.email}`, 60);
  const results = await callProvider(teacher.db, numbers);
  return { success: true, totalChecked: results.length, results };
}

/**
 * Academy Admin number lookup uses the same configured provider as teacher lookup,
 * but validates Academy membership independently. The lookup never sends a message.
 * A short-lived result is stored server-side so student admission can bind explicit
 * consent to the exact phone number that was verified.
 */
export async function verifyAcademyAdminWhatsAppNumbers(request: RequestLike) {
  const session = await resolveAcademySession(request as Parameters<typeof resolveAcademySession>[0]);
  if (session.role !== "academy_admin") {
    throw new WhatsAppNumberVerificationError(403, "Academy Admin access is required to verify a guardian number.");
  }
  const db = getFirebaseAdminFirestore();
  const member = await db.collection("academies").doc(session.academyId).collection("members").doc(session.uid).get();
  if (!member.exists || member.data()?.role !== "academy_admin" || member.data()?.active !== true || member.data()?.emailVerified !== true || member.data()?.academyId !== session.academyId) {
    throw new WhatsAppNumberVerificationError(403, "Your active Academy Admin membership could not be verified.");
  }
  const numbers = parseNumbers(requestBody(request));
  await consumeRateLimit(db, `academy-admin:${session.academyId}:${session.uid}`, 30);
  const results = await callProvider(db, numbers);
  const academy = db.collection("academies").doc(session.academyId);
  const nowMs = Date.now();
  await Promise.all(results.map((result) => {
    const key = createHash("sha256").update(`${session.academyId}|+${result.number}`).digest("hex").slice(0, 48);
    return academy.collection("guardianPhoneVerifications").doc(key).set({
      academyId: session.academyId,
      phone: `+${result.number}`,
      status: result.status,
      verifiedByUid: session.uid,
      checkedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(nowMs + 15 * 60 * 1000),
    }, { merge: true });
  }));
  return { success: true, totalChecked: results.length, results };
}

function forwardedIp(request: RequestLike): string {
  const raw = request.headers?.["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = typeof value === "string" ? value.split(",")[0].trim() : "";
  // Never persist the IP itself; only its HMAC-derived rate-limit key is stored.
  return first || "unknown-client";
}

export async function verifyRegistrationWhatsAppNumber(request: RequestLike) {
  const body = requestBody(request);
  const number = normalizeWhatsAppNumber(body.number);
  if (!number) throw new WhatsAppNumberVerificationError(400, "Enter a valid WhatsApp number with country code.");
  const db = getFirebaseAdminFirestore();
  await consumeRateLimit(db, `public-register:${forwardedIp(request)}`, 10);
  const results = await callProvider(db, [number]);
  return { success: true, totalChecked: results.length, results };
}

export function sendWhatsAppNumberVerificationError(res: { status(code: number): { json(data: unknown): unknown } }, error: unknown) {
  const status = error instanceof WhatsAppNumberVerificationError
    ? error.status
    : Number((error as { status?: unknown })?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const message = safeStatus >= 500
    ? "WhatsApp number verification could not be completed. Check the scanner configuration and try again."
    : error instanceof Error ? error.message : "WhatsApp number verification failed.";
  return res.status(safeStatus).json({ success: false, error: message });
}
