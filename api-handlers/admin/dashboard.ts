import type { DocumentData, DocumentReference, Firestore } from "firebase-admin/firestore";
import {
  AdminApiAuthError,
  FirebaseAdminConfigurationError,
  getFirebaseAdminFirestore,
  verifyAdminRequest,
} from "../../server/firebaseAdmin.js";

type Request = {
  method?: string;
  headers: { authorization?: string | string[] };
};

type Response = {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  json(data: unknown): Response;
};

type Profile = {
  id: string;
  uid: string;
  email: string;
  data: Record<string, unknown>;
  active: boolean | null;
  createdAt: string | null;
  classCount: number | null;
  enrollmentCount: number | null;
  uniqueStudentCount: number | null;
};

const clean = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizeEmail = (value: unknown): string =>
  clean(value).toLowerCase();

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (value && typeof value === "object") {
    const timestamp = value as { toDate?: () => Date };
    if (typeof timestamp.toDate === "function") {
      try {
        const date = timestamp.toDate();
        return date instanceof Date && !Number.isNaN(date.getTime())
          ? date
          : null;
      } catch {
        return null;
      }
    }
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function toIso(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function accountStatus(data: Record<string, unknown>): boolean | null {
  const approval = clean(data.approvalStatus).toLowerCase();

  if (approval === "pending" || approval === "rejected") {
    return false;
  }

  if (data.disabled === true || data.deleted === true) return false;

  if (typeof data.active === "boolean") return data.active;
  if (typeof data.isActive === "boolean") return data.isActive;

  const status = clean(data.status || data.accountStatus).toLowerCase();

  if (["active", "enabled"].includes(status)) return true;
  if (["disabled", "inactive", "suspended", "deleted", "blocked"].includes(status)) {
    return false;
  }

  if (typeof data.disabled === "boolean") return !data.disabled;

  return null;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await callback(items[index]);
      }
    }),
  );

  return results;
}

function cachedAcademicCounts(data: Record<string, unknown>) {
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    }
    return null;
  };
  // Dashboard requests must not enumerate every class/student subcollection.
  // Use persisted aggregates when available; otherwise report unknown counts.
  return {
    classCount: read("classCount", "totalClasses", "classesCount"),
    enrollmentCount: read("enrollmentCount", "totalEnrollments", "studentCount", "totalStudents"),
    uniqueStudentCount: read("uniqueStudentCount", "uniqueStudents"),
  };
}

async function resolveAdminProfile(
  db: Firestore,
  uid: string,
  email: string,
) {
  const ref = db.collection("admins").doc(email);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new AdminApiAuthError(403, "Administrator root record could not be verified.");
  }

  const data = snapshot.data() ?? {};

  if (
    clean(data.adminUid) !== uid ||
    normalizeEmail(data.email ?? snapshot.id) !== email
  ) {
    throw new AdminApiAuthError(403, "Administrator root identity does not match the signed-in account.");
  }

  return { ref, data };
}
function createRegistrationMonths(profiles: Profile[]) {
  const months = new Map<string, number>();
  const now = new Date();

  for (let offset = 11; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    months.set(key, 0);
  }

  for (const profile of profiles) {
    if (!profile.createdAt) continue;

    const date = new Date(profile.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    if (months.has(key)) {
      months.set(key, (months.get(key) ?? 0) + 1);
    }
  }

  return Array.from(months, ([month, count]) => ({ month, count }));
}

export default async function handler(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const admin = await verifyAdminRequest(req);
    const db = getFirebaseAdminFirestore();

    const adminProfile = await resolveAdminProfile(
      db,
      admin.uid,
      admin.email,
    );

    const teacherProfiles = await db.collection("users")
      .where("role", "==", "teacher")
      .limit(101)
      .get();
    const warnings: string[] = [];
    const candidates = teacherProfiles.docs.slice(0, 100);
    const hasMoreTeachers = teacherProfiles.size > 100;
    if (hasMoreTeachers) {
      warnings.push("Dashboard teacher coverage is capped at 100 profiles to protect Firestore quota.");
    }

    const byUid = new Map<string, typeof candidates[number]>();
    const ambiguousUids = new Set<string>();

    for (const document of candidates) {
      const data = document.data();
      const uid = clean(data.uid);
      const email = normalizeEmail(data.email ?? document.id);

      if (!uid || !email || !email.includes("@")) {
        warnings.push("A teacher profile was excluded because its identity could not be verified.");
        continue;
      }

      if (ambiguousUids.has(uid)) continue;

      const previous = byUid.get(uid);

      if (!previous) {
        byUid.set(uid, document);
        continue;
      }

      const previousEmail = normalizeEmail(
        previous.data().email ?? previous.id,
      );

      if (previousEmail !== email) {
        byUid.delete(uid);
        ambiguousUids.add(uid);
        warnings.push("Conflicting teacher profile identities were excluded.");
        continue;
      }

      const previousIsEmailKeyed = previous.id.toLowerCase() === email;
      const currentIsEmailKeyed = document.id.toLowerCase() === email;

      if (currentIsEmailKeyed && !previousIsEmailKeyed) {
        byUid.set(uid, document);
      }
    }

    const teacherDocuments = Array.from(byUid.values());

    const profiles = await mapLimit(teacherDocuments, 6, async (document) => {
      const data = document.data();
      const counts = cachedAcademicCounts(data);

      return {
        id: document.id,
        uid: clean(data.uid),
        email: normalizeEmail(data.email ?? document.id),
        data,
        active: accountStatus(data),
        createdAt: toIso(data.createdAt),
        ...counts,
      } satisfies Profile;
    });

    const allStatusesKnown = profiles.every((profile) => profile.active !== null);
    const allAcademicCountsKnown = profiles.every(
      (profile) =>
        profile.classCount !== null &&
        profile.enrollmentCount !== null &&
        profile.uniqueStudentCount !== null,
    );

    if (!allStatusesKnown) {
      warnings.push("Some teacher account statuses could not be verified.");
    }

    if (!allAcademicCountsKnown) {
      warnings.push("Some teacher academic summary counters are not available in the saved profile.");
    }

    const summary = {
      totalTeachers: hasMoreTeachers ? null : profiles.length,
      activeTeachers: allStatusesKnown && !hasMoreTeachers
        ? profiles.filter((profile) => profile.active === true).length
        : null,
      disabledTeachers: allStatusesKnown && !hasMoreTeachers
        ? profiles.filter((profile) => profile.active === false).length
        : null,
      totalClasses: allAcademicCountsKnown
        ? profiles.reduce((sum, profile) => sum + profile.classCount!, 0)
        : null,
      totalEnrollments: allAcademicCountsKnown
        ? profiles.reduce((sum, profile) => sum + profile.enrollmentCount!, 0)
        : null,
      uniqueStudents: allAcademicCountsKnown
        ? profiles.reduce((sum, profile) => sum + profile.uniqueStudentCount!, 0)
        : null,
    };

    return res.status(200).json({
      success: true,
      admin: {
        displayName:
          clean(
            adminProfile.data.teacherName ||
            adminProfile.data.name ||
            adminProfile.data.displayName,
          ) || admin.email,
        email: admin.email,
      },
      generatedAt: new Date().toISOString(),
      summary,
      teachers: profiles.map((profile) => ({
        id: profile.id,
        uid: profile.uid,
        name:
          clean(
            profile.data.teacherName ||
            profile.data.name ||
            profile.data.displayName,
          ) || profile.email.split("@")[0],
        email: profile.email,
        role: "teacher",
        createdAt: profile.createdAt,
        active: profile.active,
        whatsappNumber:
          clean(profile.data.whatsappNumber || profile.data.phone) || null,
        profileImage:
          clean(profile.data.profileImage || profile.data.photoURL) || null,
        classCount: profile.classCount,
        enrollmentCount: profile.enrollmentCount,
        uniqueStudentCount: profile.uniqueStudentCount,
      })),
      registrationsByMonth: createRegistrationMonths(profiles),
      coverage: {
        complete: warnings.length === 0,
        warnings,
      },
    });
  } catch (error) {
    if (error instanceof FirebaseAdminConfigurationError) {
      return res.status(503).json({
        success: false,
        error: "Firebase Admin server settings are not configured.",
      });
    }

    if (error instanceof AdminApiAuthError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
      });
    }

    console.error("[admin/dashboard]", error);

    return res.status(500).json({
      success: false,
      error: "Unable to load the admin dashboard.",
    });
  }
}
