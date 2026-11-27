import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { buildNotificationSvg, validateNotificationImagePayload } from "./whatsappNotificationImageDomain.mjs";

const require = createRequire(import.meta.url);

const MEDIA_TTL_SECONDS = 300;
const MEDIA_ROUTE = "/api/whatsapp/notification-image";

const PROFILE_IMAGE_MAX_BYTES = 2_000_000;
const DEFAULT_PROFILE_IMAGE_HOSTS: string[] = [];

function allowedProfileImageHosts(): Set<string> {
  const configured = process.env.WHATSAPP_PROFILE_IMAGE_ALLOWED_HOSTS?.trim();
  const values = configured
    ? configured.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PROFILE_IMAGE_HOSTS;
  return new Set(values);
}

async function loadProfileAvatarDataUri(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) return "";
  let url: URL;
  try { url = new URL(value.trim()); } catch { return ""; }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port !== "" ||
    !allowedProfileImageHosts().has(url.hostname.toLowerCase()) ||
    !url.pathname.startsWith("/profile-images/")
  ) return "";

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return "";
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) return "";
    const length = Number(response.headers.get("content-length") || 0);
    if (length > PROFILE_IMAGE_MAX_BYTES) return "";
    if (!response.body) return "";

    // Enforce the size cap while streaming; never buffer an unbounded remote response.
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > PROFILE_IMAGE_MAX_BYTES) {
          await reader.cancel();
          return "";
        }
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks, totalBytes);
    if (!buffer.length) return "";
    const optimized = await sharp(buffer, { limitInputPixels: 12_000_000 })
      .rotate()
      .resize(256, 256, { fit: "cover", position: "attention" })
      .png({ compressionLevel: 8 })
      .toBuffer();
    return `data:image/png;base64,${optimized.toString("base64")}`;
  } catch {
    // Missing, expired, or inaccessible profile photos use the in-card avatar fallback.
    return "";
  }
}

type RecordLike = Record<string, unknown>;

function signingKey(): Buffer {
  const encoded = process.env.WHATSAPP_MEDIA_SIGNING_SECRET?.trim();
  if (!encoded) throw new Error("WHATSAPP_MEDIA_SIGNING_SECRET is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("WHATSAPP_MEDIA_SIGNING_SECRET must be a valid base64-encoded 32-byte key.");
  }
  return key;
}

function signature(id: string, exp: number): string {
  return createHmac("sha256", signingKey())
    .update(`edutrack-whatsapp-image:v1\n${id}\n${exp}`)
    .digest("hex");
}

function normalizeTenant(value: unknown): string {
  if (typeof value !== "string") return "";
  const result = value.trim().toLowerCase();
  return result.includes("/") || result.includes("\\") || !result.includes("@") ? "" : result;
}

function publicOrigin(): URL {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  if (!raw) throw new Error("PUBLIC_APP_URL is not configured.");
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_APP_URL must be a valid HTTPS origin.");
  }
  return url;
}

export async function createWhatsAppNotificationImageLink(input: {
  db: Firestore;
  tenantId: string;
  payload: RecordLike;
}): Promise<{ url: string; mediaId: string; expiresAt: string; expiresInSeconds: number }> {
  const tenantId = normalizeTenant(input.tenantId);
  const validation = validateNotificationImagePayload(input.payload);
  if (!tenantId || !validation.valid) throw new Error(validation.valid ? "Notification image tenant is invalid." : validation.error);
  const mediaId = randomBytes(18).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_SECONDS;
  const access = input.db.collection("whatsappNotificationImageAccess").doc(mediaId);
  await access.create({
    version: 1,
    purpose: "whatsapp_notification_image",
    tenantId,
    payload: input.payload,
    expiresAt: Timestamp.fromMillis(exp * 1000),
    createdAt: FieldValue.serverTimestamp(),
  });
  const url = publicOrigin();
  url.pathname = MEDIA_ROUTE;
  url.search = "";
  url.hash = "";
  url.searchParams.set("id", mediaId);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", signature(mediaId, exp));
  return { url: url.toString(), mediaId, expiresAt: new Date(exp * 1000).toISOString(), expiresInSeconds: MEDIA_TTL_SECONDS };
}

export async function verifyWhatsAppNotificationImageLink(input: {
  db: Firestore;
  mediaId: string;
  expiresAt: string;
  signature: string;
}): Promise<RecordLike | null> {
  if (!/^[A-Za-z0-9_-]{24}$/.test(input.mediaId) || !/^\d{10}$/.test(input.expiresAt) || !/^[a-f0-9]{64}$/i.test(input.signature)) return null;
  const exp = Number(input.expiresAt);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + MEDIA_TTL_SECONDS) return null;
  let expected: Buffer;
  try { expected = Buffer.from(signature(input.mediaId, exp), "hex"); } catch { return null; }
  const supplied = Buffer.from(input.signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const snapshot = await input.db.collection("whatsappNotificationImageAccess").doc(input.mediaId).get();
  const record = snapshot.data();
  if (!snapshot.exists || !record || record.version !== 1 || record.purpose !== "whatsapp_notification_image") return null;
  if (normalizeTenant(record.tenantId) === "" || !(record.expiresAt instanceof Timestamp) || Math.floor(record.expiresAt.toMillis() / 1000) !== exp) return null;
  const payload = record.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as RecordLike : null;
}

export async function renderWhatsAppNotificationPng(payload: RecordLike): Promise<Buffer> {
  const validation = validateNotificationImagePayload(payload);
  if (!validation.valid) throw new Error(validation.error);
  const logoPath = resolve(process.cwd(), "public", "logo.png");
  const logoSource = await readFile(logoPath);
  const logo = await sharp(logoSource, { limitInputPixels: 4_000_000 })
    .resize(512, 512, { fit: "contain", background: "#ffffff" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const logoUri = `data:image/png;base64,${logo.toString("base64")}`;
  const [teacherAvatar, studentAvatar] = await Promise.all([
    loadProfileAvatarDataUri(payload.teacherAvatarUrl),
    loadProfileAvatarDataUri(payload.studentAvatarUrl),
  ]);
  const svg = buildNotificationSvg(
    payload as Parameters<typeof buildNotificationSvg>[0],
    logoUri,
    { teacher: teacherAvatar, student: studentAvatar },
  );

  // Sharp delegates SVG text to fontconfig, which is not guaranteed to have
  // Arial/Helvetica installed in Vercel's serverless runtime. Resolve and load
  // the app-bundled DejaVu TTF files directly so text never depends on host fonts.
  const fontFiles = [
    require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"),
    require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"),
  ];
  const renderedPng = new Resvg(svg, {
    font: {
      fontFiles,
      loadSystemFonts: false,
      defaultFontFamily: "DejaVu Sans",
      sansSerifFamily: "DejaVu Sans",
    },
  }).render().asPng();
  // Keep the existing Sharp PNG encoding step; Sharp now receives a raster PNG,
  // not SVG text, so its host font availability is irrelevant.
  const png = await sharp(renderedPng).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (!png.length || png.length > 5_000_000) throw new Error("Generated notification image is empty or exceeds 5 MB.");
  return png;
}
