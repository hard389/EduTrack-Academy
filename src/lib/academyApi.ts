import type { User } from "firebase/auth";

export type AcademyRole = "academy_admin" | "teacher";
export type AcademySession = {
  success: true;
  uid: string;
  email: string;
  academyId: string;
  academyName: string;
  role: AcademyRole;
  status: "active";
};

type ApiPayload = Record<string, unknown>;

export class AcademyClientError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "AcademyClientError";
  }
}

async function authenticatedRequest<T>(
  user: User,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const token = await user.getIdToken(true);
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as ApiPayload
      : {};
    throw new AcademyClientError(
      typeof record.error === "string" ? record.error : "The Academy request could not be completed.",
      response.status,
      typeof record.code === "string" ? record.code : "REQUEST_FAILED",
    );
  }
  return payload as T;
}

export function registerAcademy(
  user: User,
  input: { academyName: string; whatsappNumber: string; profileImage: string },
) {
  return authenticatedRequest<{ success: true; academyId: string; academyName: string; status: string; alreadyCreated: boolean }>(
    user,
    "/api/academy/register",
    "POST",
    input,
  );
}

export function resolveAcademySession(user: User, academyId?: string) {
  return authenticatedRequest<AcademySession>(
    user,
    "/api/academy/session",
    academyId ? "POST" : "GET",
    academyId ? { academyId } : undefined,
  );
}

export type AcademyTeacher = {
  uid: string;
  name: string;
  email: string;
  active: boolean;
  emailVerified: boolean;
  status: string;
  whatsappNumber: string;
  designation?: string;
  profileImageStoragePath?: string;
  profileImage?: string;
  permissions?: Record<string, boolean>;
  assignedClassIds?: string[];
  assignedSubjectIds?: string[];
  assignedClassCount?: number;
  assignedSubjectCount?: number;
  assignedStudentCount?: number;
  createdAt: string | null;
};

export function listAcademyTeachers(user: User) {
  return authenticatedRequest<{ success: true; academyId: string; teachers: AcademyTeacher[] }>(
    user,
    "/api/academy/teachers",
    "GET",
  );
}

export function createAcademyTeacher(
  user: User,
  input: { teacherName: string; email: string; password: string; whatsappNumber?: string; designation?: string; permissions?: Record<string, boolean> },
) {
  return authenticatedRequest<{ success: true; teacher: AcademyTeacher; message: string }>(
    user,
    "/api/academy/teachers",
    "POST",
    input,
  );
}


export type AcademyAccess = {
  success: true; uid: string; email: string; academyId: string; academyName: string; role: AcademyRole;
  permissions: Record<string, boolean>; assignedClassIds: string[]; assignedSubjectIds: string[];
};

export function getAcademyAccess(user: User) {
  return authenticatedRequest<AcademyAccess>(user, "/api/academy/management", "GET");
}

export type AcademyManagementResult<T = Record<string, unknown>> = { success: true } & T;

export function academyManagementRequest<T = Record<string, unknown>>(user: User, input: Record<string, unknown>) {
  return authenticatedRequest<AcademyManagementResult<T>>(user, "/api/academy/management", "POST", input);
}

export function collectAcademyFeePayment(user: User, input: { invoiceId: string; amount: number; paymentMethod: string; idempotencyKey: string; paymentReference?: string }) {
  return academyManagementRequest<{ duplicate: boolean; invoice: Record<string, unknown>; paymentId: string | null }>(user, { action: "collect-payment", ...input });
}
