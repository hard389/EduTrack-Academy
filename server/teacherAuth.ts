import { timingSafeEqual } from "node:crypto";
import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
} from "./firebaseAdmin.js";

export type TeacherApiRequest = {
  headers: {
    authorization?: string | string[];
    "x-edutrack-worker-secret"?: string | string[];
    "x-edutrack-tenant"?: string | string[];
    [key: string]: string | string[] | undefined;
  };
};

export class TeacherApiAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TeacherApiAuthError";
  }
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

function readHeader(headers: TeacherApiRequest["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function secretMatches(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

async function verifyInternalWorkerRequest(request: TeacherApiRequest) {
  const receivedSecret = readHeader(request.headers, "x-edutrack-worker-secret");
  if (!receivedSecret) return null;

  const expectedSecret = process.env.WHATSAPP_QUEUE_WORKER_SECRET?.trim() ?? "";
  if (!secretMatches(receivedSecret, expectedSecret)) {
    throw new TeacherApiAuthError(401, "Unauthorized internal worker request.");
  }

  const email = normalizeEmail(readHeader(request.headers, "x-edutrack-tenant"));
  if (!email) throw new TeacherApiAuthError(400, "The internal worker tenant is invalid.");

  const db = getFirebaseAdminFirestore();
  const auth = getFirebaseAdminAuth();
  const tenantRef = db.collection("users").doc(email);
  const tenantSnapshot = await tenantRef.get();
  const tenantData = tenantSnapshot.data();
  const uid = typeof tenantData?.uid === "string" ? tenantData.uid.trim() : "";

  if (!tenantSnapshot.exists || !tenantData || !uid) {
    throw new TeacherApiAuthError(403, "The internal worker tenant could not be verified.");
  }

  let authUser;
  try {
    authUser = await auth.getUser(uid);
  } catch {
    throw new TeacherApiAuthError(403, "The internal worker teacher account could not be verified.");
  }

  if (
    authUser.disabled ||
    normalizeEmail(authUser.email) !== email ||
    normalizeEmail(tenantData.email) !== email ||
    tenantData.uid !== uid ||
    tenantData.role !== "teacher" ||
    tenantData.active !== true ||
    tenantData.disabled === true ||
    tenantData.deleted === true
  ) {
    throw new TeacherApiAuthError(403, "The internal worker tenant is not an active teacher workspace.");
  }

  return { db, uid, email, tenantRef, tenantData };
}


async function verifyActiveAcademyTeacher(db: ReturnType<typeof getFirebaseAdminFirestore>, uid: string, email: string, tenantData: Record<string, unknown>) {
  const academyId = typeof tenantData.academyId === "string" ? tenantData.academyId.trim() : "";
  if (!/^\d{3,15}$/.test(academyId) || Number(academyId) < 100) {
    throw new TeacherApiAuthError(403, "Teacher account is not linked to an active Academy.");
  }
  const mappingRef = db.collection("academyMemberships").doc(uid);
  const academyRef = db.collection("academies").doc(academyId);
  const memberRef = academyRef.collection("members").doc(uid);
  const [mappingSnapshot, academySnapshot, memberSnapshot] = await Promise.all([
    mappingRef.get(), academyRef.get(), memberRef.get(),
  ]);
  const mapping = mappingSnapshot.data();
  const academy = academySnapshot.data();
  const member = memberSnapshot.data();
  if (
    !mappingSnapshot.exists || !academySnapshot.exists || !memberSnapshot.exists ||
    mapping?.academyId !== academyId || mapping?.role !== "teacher" || mapping?.active !== true ||
    normalizeEmail(mapping?.email) !== email ||
    academy?.academyId !== academyId || academy?.status !== "active" ||
    member?.uid !== uid || member?.academyId !== academyId || member?.role !== "teacher" ||
    member?.active !== true || member?.emailVerified !== true ||
    normalizeEmail(member?.email) !== email
  ) {
    throw new TeacherApiAuthError(403, "Teacher account is not an active member of this Academy.");
  }
}

export async function verifyTeacherRequest(request: TeacherApiRequest) {
  const internalActor = await verifyInternalWorkerRequest(request);
  if (internalActor) return internalActor;

  const header = readHeader(request.headers, "authorization");

  if (!header) {
    throw new TeacherApiAuthError(401, "Authorization required.");
  }

  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new TeacherApiAuthError(401, "Invalid authorization header.");
  }

  const auth = getFirebaseAdminAuth();

  let token;
  try {
    token = await auth.verifyIdToken(match[1], true);
  } catch {
    throw new TeacherApiAuthError(401, "Invalid, expired, or revoked session.");
  }

  const uid = token.uid;
  const email = normalizeEmail(token.email);

  if (!uid || !email) {
    throw new TeacherApiAuthError(403, "Teacher identity is incomplete.");
  }

  const authUser = await auth.getUser(uid);

  if (
    authUser.disabled ||
    normalizeEmail(authUser.email) !== email ||
    authUser.emailVerified !== true ||
    token.email_verified !== true
  ) {
    throw new TeacherApiAuthError(403, "Teacher account verification failed. Verify your email and sign in again.");
  }

  const db = getFirebaseAdminFirestore();
  const tenantRef = db.collection("users").doc(email);
  const tenantSnapshot = await tenantRef.get();

  if (!tenantSnapshot.exists) {
    throw new TeacherApiAuthError(403, "Teacher workspace could not be verified.");
  }

  const tenantData = tenantSnapshot.data();

  if (
    !tenantData ||
    tenantData.uid !== uid ||
    normalizeEmail(tenantData.email) !== email ||
    tenantData.role !== "teacher" ||
    tenantData.active !== true ||
    tenantData.disabled === true ||
    tenantData.deleted === true
  ) {
    throw new TeacherApiAuthError(
      403,
      "You do not own an active teacher workspace.",
    );
  }

  await verifyActiveAcademyTeacher(db, uid, email, tenantData as Record<string, unknown>);

  return {
    db,
    uid,
    email,
    tenantRef,
    tenantData,
  };
}
