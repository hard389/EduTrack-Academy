import {
  verifyTeacherRequest,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { getAttendanceDispatchReadiness } from "./attendanceDispatchReadiness.js";

function toMillis(value: unknown): number | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    try {
      return value.toMillis();
    } catch {
      return null;
    }
  }

  return null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function listAttendanceNotificationJobs(
  request: TeacherApiRequest,
) {
  const actor = await verifyTeacherRequest(request);

  const [jobsSnapshot, settingsSnapshot] = await Promise.all([
    actor.tenantRef
      .collection("whatsappNotificationJobs")
      .limit(100)
      .get(),
    actor.db
      .collection("platformSettings")
      .doc("whatsapp")
      .get(),
  ]);

  const settings = settingsSnapshot.data() ?? {};
  const dispatchReadiness = await getAttendanceDispatchReadiness(
    actor.db,
    actor.uid,
    settings,
  );
  const dispatchAvailable = dispatchReadiness.available;

  const jobs = jobsSnapshot.docs
    .filter((document) => {
      const data = document.data();
      return data.kind === "attendance_absent" &&
        data.tenantId === actor.email;
    })
    .map((document) => {
      const data = document.data();
      const status = clean(data.status);
      const providerHttpStatus = data.providerHttpStatus;

      const hasSuccessfulProviderResponse =
        typeof providerHttpStatus === "number" &&
        providerHttpStatus >= 200 &&
        providerHttpStatus < 300;

      const canReconcile =
        (status === "accepted_by_postabi" || status === "unknown_outcome") &&
        Boolean(clean(data.providerMessageId)) &&
        hasSuccessfulProviderResponse;

      return {
        jobId: document.id,
        status,
        className: clean(data.className) || "Class",
        attendanceDate: clean(data.attendanceDate),
        attemptCount:
          typeof data.attemptCount === "number" &&
          Number.isSafeInteger(data.attemptCount) &&
          data.attemptCount >= 0
            ? data.attemptCount
            : 0,
        providerStatus: clean(data.providerStatus) || null,
        createdAt: toMillis(data.createdAt),
        updatedAt: toMillis(data.updatedAt),
        canDispatch: status === "prepared_for_vercel" && dispatchAvailable,
        canReconcile,
      };
    })
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) -
      (a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, 50);

  return {
    success: true,
    dispatchAvailable,
    dispatchBlockers: dispatchReadiness.blockers,
    jobs,
  };
}
