import type { TeacherApiRequest } from './teacherAuth.js';
import {
  GUARDIAN_CONSENT_CAPABILITIES,
  buildStudentRecord,
} from './studentRosterDomain.mjs';
import { createTeacherCanonicalStudentFromExistingForm } from './academyManagement.js';

type RecordLike = Record<string, unknown>;
type TeacherStudentApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): TeacherStudentApiResponse;
  json(data: unknown): unknown;
};
type StudentRequest = TeacherApiRequest & { method?: string; body?: unknown };

export class TeacherStudentRosterError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'TeacherStudentRosterError';
  }
}

const isRecord = (value: unknown): value is RecordLike => typeof value === 'object' && value !== null && !Array.isArray(value);
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const validPathSegment = (value: string) => Boolean(value) && !value.includes('/') && !value.includes('\\') && !value.includes('..');

export async function addTeacherStudentToClass(request: StudentRequest) {
  if (!isRecord(request.body)) throw new TeacherStudentRosterError(400, 'INVALID_BODY', 'A valid student payload is required.');
  const body = request.body;
  const classId = clean(body.classId);
  if (!validPathSegment(classId)) throw new TeacherStudentRosterError(400, 'INVALID_CLASS', 'A valid class must be selected.');
  if (!isRecord(body.values)) throw new TeacherStudentRosterError(400, 'INVALID_STUDENT', 'Student details are missing.');

  // Guardian WhatsApp consent is not a teacher module-access grant. Preserve only
  // the explicit choices made in the existing form; buildStudentRecord still
  // requires each individual consent input to be exactly true and binds it to the
  // current normalized guardian phone number.
  const consentPermissions = GUARDIAN_CONSENT_CAPABILITIES as Record<string, boolean>;

  const classMonthlyFee = clean(body.classMonthlyFee) || '5000';
  const { student, ignoredConsentFeatures } = buildStudentRecord(
    body.values,
    consentPermissions,
    'pending-canonical-id',
    { classMonthlyFee },
  );

  try {
    const result = await createTeacherCanonicalStudentFromExistingForm(request, {
      classId,
      values: student as RecordLike,
      classMonthlyFee,
    });
    return {
      success: true,
      studentId: result.canonicalStudentId,
      canonicalStudentId: result.canonicalStudentId,
      ignoredConsentFeatures,
    };
  } catch (error) {
    const candidate = isRecord(error) ? error : {};
    const status = Number(candidate.status);
    throw new TeacherStudentRosterError(
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
      clean(candidate.code) || 'STUDENT_SAVE_FAILED',
      error instanceof Error ? error.message : 'The student could not be saved.',
    );
  }
}

export function sendTeacherStudentRosterError(response: TeacherStudentApiResponse, error: unknown) {
  const candidate = isRecord(error) ? error : {};
  const status = Number(candidate.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const message = safeStatus >= 500
    ? 'The student could not be saved. Please try again.'
    : error instanceof Error ? error.message : 'The request is invalid.';
  console.error('[EduTrack][teacher-student-roster] request failed:', { status: safeStatus, code: clean(candidate.code) });
  response.setHeader('Cache-Control', 'no-store');
  return response.status(safeStatus).json({ success: false, error: message, code: clean(candidate.code) || 'STUDENT_SAVE_FAILED' });
}
