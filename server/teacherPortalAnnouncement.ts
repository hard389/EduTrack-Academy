import { randomUUID } from "node:crypto";
import { getFirebaseAdminFirestore, verifyAdminRequest } from "./firebaseAdmin.js";
import { verifyTeacherRequest } from "./teacherAuth.js";
import type { Firestore } from "firebase-admin/firestore";
import { getPakistanDateKey, getTeacherAnnouncementDismissalId } from "./teacherPortalAnnouncementDomain.mjs";

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type RecordLike = Record<string, unknown>;

export class TeacherPortalAnnouncementError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TeacherPortalAnnouncementError";
  }
}

const clean = (value: unknown, max = 1200): string =>
  typeof value === "string"
    ? value.trim().replace(
        // eslint-disable-next-line no-control-regex -- Deliberately strip unsafe control characters from user-supplied text.
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
        "",
      ).slice(0, max)
    : "";

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicAnnouncement(data: RecordLike | undefined) {
  if (!data) return null;
  return {
    id: clean(data.announcementId, 80),
    title: clean(data.title, 100),
    message: clean(data.message, 1800),
    status: data.status === "published" ? "published" : "unpublished",
    publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : null,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
  };
}

function announcementRef(db: Firestore) {
  return db.collection("platformSettings").doc("teacherPortalAnnouncement");
}

export async function getAdminTeacherPortalAnnouncement(request: RequestLike) {
  await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  const db = getFirebaseAdminFirestore();
  const snapshot = await announcementRef(db).get();
  return { success: true, announcement: publicAnnouncement(snapshot.data()) };
}

export async function saveAdminTeacherPortalAnnouncement(request: RequestLike) {
  const admin = await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  if (!isRecord(request.body)) {
    throw new TeacherPortalAnnouncementError(400, "A valid JSON request body is required.");
  }

  const action = clean(request.body.action, 20);
  const ref = announcementRef(getFirebaseAdminFirestore());
  const now = new Date().toISOString();

  if (action === "unpublish") {
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return { success: true, announcement: null, message: "There is no published teacher notice." };
    }
    await ref.set({
      status: "unpublished",
      unpublishedAt: now,
      updatedAt: now,
      updatedByUid: admin.uid,
      updatedByEmail: admin.email,
    }, { merge: true });
    const updated = await ref.get();
    return { success: true, announcement: publicAnnouncement(updated.data()), message: "Teacher notice unpublished." };
  }

  if (action !== "publish") {
    throw new TeacherPortalAnnouncementError(400, "Choose Publish or Unpublish.");
  }

  const title = clean(request.body.title, 100);
  const message = clean(request.body.message, 1800);
  if (!title) throw new TeacherPortalAnnouncementError(400, "Enter a notice title.");
  if (!message) throw new TeacherPortalAnnouncementError(400, "Enter the notice message.");

  const current = await ref.get();
  const previous = current.data() ?? {};
  const announcementId = randomUUID();
  await ref.set({
    announcementId,
    title,
    message,
    status: "published",
    publishedAt: now,
    createdAt: typeof previous.createdAt === "string" ? previous.createdAt : now,
    createdByUid: typeof previous.createdByUid === "string" ? previous.createdByUid : admin.uid,
    createdByEmail: typeof previous.createdByEmail === "string" ? previous.createdByEmail : admin.email,
    updatedAt: now,
    updatedByUid: admin.uid,
    updatedByEmail: admin.email,
  }, { merge: true });

  const saved = await ref.get();
  return {
    success: true,
    announcement: publicAnnouncement(saved.data()),
    message: "Teacher portal notice published successfully.",
  };
}

export async function getTeacherPortalAnnouncement(request: RequestLike) {
  const teacher = await verifyTeacherRequest(request as Parameters<typeof verifyTeacherRequest>[0]);
  const db = getFirebaseAdminFirestore();
  const today = getPakistanDateKey();
  const snapshot = await announcementRef(db).get();
  const data = snapshot.data();
  if (!snapshot.exists || !data || data.status !== "published") {
    return { success: true, announcement: null, dismissedToday: false, dayKey: today };
  }

  const dismissId = getTeacherAnnouncementDismissalId(teacher.uid, today);
  const dismissed = await db.collection("platformTeacherAnnouncementDismissals").doc(dismissId).get();
  const announcement = publicAnnouncement(data);
  if (!announcement?.id || !announcement.title || !announcement.message) {
    return { success: true, announcement: null, dismissedToday: false, dayKey: today };
  }

  return {
    success: true,
    announcement: dismissed.exists ? null : announcement,
    dismissedToday: dismissed.exists,
    dayKey: today,
  };
}

export async function dismissTeacherPortalAnnouncement(request: RequestLike) {
  const teacher = await verifyTeacherRequest(request as Parameters<typeof verifyTeacherRequest>[0]);
  if (!isRecord(request.body)) {
    throw new TeacherPortalAnnouncementError(400, "A valid JSON request body is required.");
  }
  const announcementId = clean(request.body.announcementId, 80);
  if (!announcementId) throw new TeacherPortalAnnouncementError(400, "The notice ID is required.");

  const db = getFirebaseAdminFirestore();
  const currentRef = announcementRef(db);
  const today = getPakistanDateKey();
  const dismissId = getTeacherAnnouncementDismissalId(teacher.uid, today);
  const dismissRef = db.collection("platformTeacherAnnouncementDismissals").doc(dismissId);

  await db.runTransaction(async (transaction) => {
    const [current, existingDismissal] = await Promise.all([
      transaction.get(currentRef),
      transaction.get(dismissRef),
    ]);
    const data = current.data();
    if (!current.exists || !data || data.status !== "published" || data.announcementId !== announcementId) {
      throw new TeacherPortalAnnouncementError(409, "This notice is no longer active. Refresh the dashboard.");
    }
    if (!existingDismissal.exists) {
      transaction.create(dismissRef, {
        teacherUid: teacher.uid,
        dateKey: today,
        announcementId,
        dismissedAt: new Date().toISOString(),
      });
    }
  });

  return { success: true, dismissed: true, dayKey: today };
}

export function sendTeacherPortalAnnouncementApiError(
  res: { status(code: number): { json(data: unknown): unknown } },
  error: unknown,
) {
  const status = error instanceof TeacherPortalAnnouncementError
    ? error.status
    : Number((error as { status?: unknown } | null)?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const message = safeStatus >= 500
    ? "The teacher notice service could not complete the request."
    : error instanceof Error ? error.message : "The request was rejected.";
  if (safeStatus >= 500) {
    console.error("[teacher-portal-announcement-api] Request failed.", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: clean((error as { code?: unknown } | null)?.code, 80),
      message: clean((error as { message?: unknown } | null)?.message, 300),
    });
  }
  return res.status(safeStatus).json({ success: false, error: message });
}
