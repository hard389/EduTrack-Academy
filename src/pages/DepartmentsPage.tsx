import { useState, useMemo, useEffect, useRef } from 'react';
import { useApp, type TeacherFeatureKey } from '@/contexts/AppContext';
import { Link, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import {
  STUDENT_CONSENT_COLUMNS,
  STUDENT_IMPORT_FIELD_LABELS,
  STUDENT_IMPORT_REQUIRED_KEYS,
  autoDetectStudentColumnMap,
  createEmptyStudentColumnMap,
  getIgnoredStudentConsentColumnLabels,
  getStudentConsentFormValues,
  parseStudentConsent,
} from '@/lib/studentImportSchema.mjs';
import { downloadStudentImportWorkbook } from '@/lib/studentImportWorkbook.mjs';
import type { StudentColumnMap as StudentImportColumnMap, StudentConsentColumnKey } from '@/lib/studentImportSchema.mjs';
import { Button } from '@/components/ui/button';
import {
  Search,
  Bell,
  Sun,
  Moon,
  Plus,
  Users,
  Wallet,
  Home,
  GraduationCap,
  Settings,
  Upload,
  UserPlus,
  BookOpen,
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Edit2,
  Trash2,
  MoreVertical,
  Loader2,
  Tag,
  SlidersHorizontal,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  ArrowLeft,
  Camera,
  Download,
  Crown,
  ChevronDown,
  Check,
  FileWarning,
  FolderInput
} from 'lucide-react';

// Firebase Imports
import { auth, db } from '@/lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  FieldPath,
  deleteField
} from 'firebase/firestore';
import type { Transaction, DocumentReference, DocumentData } from 'firebase/firestore';

// Interfaces
interface Student {
  // Preserved exactly as stored (number or string). Other modules must compare with String(id).
  id?: number | string;
  name: string;
  fatherName: string;
  phone: string;
  rollNo: string;
  avatar: string;
  gender: 'Male' | 'Female';
  feeStatus: 'Paid' | 'Unpaid' | 'Partial';
  studentFee?: string;
  parentWhatsAppOptIn?: boolean;
  parentWhatsAppOptInAt?: string | null;
  // The exact contact number for which consent was recorded; prevents consent carrying over to a changed number.
  parentWhatsAppOptInPhone?: string | null;
  attendanceWhatsAppOptIn?: boolean;
  attendanceWhatsAppOptInAt?: string | null;
  attendanceWhatsAppOptInPhone?: string | null;
  quizResultsWhatsAppOptIn?: boolean;
  quizResultsWhatsAppOptInAt?: string | null;
  quizResultsWhatsAppOptInPhone?: string | null;
  feeAlertsWhatsAppOptIn?: boolean;
  feeAlertsWhatsAppOptInAt?: string | null;
  feeAlertsWhatsAppOptInPhone?: string | null;
  announcementWhatsAppOptIn?: boolean;
  announcementWhatsAppOptInAt?: string | null;
  announcementWhatsAppOptInPhone?: string | null;
  libraryLinkWhatsAppOptIn?: boolean;
  libraryLinkWhatsAppOptInAt?: string | null;
  libraryLinkWhatsAppOptInPhone?: string | null;
  // In-memory only (never written to Firestore): where this student lives inside the class document
  _sourceKey?: string;
}

interface ClassItem {
  id: string;
  name: string;
  code: string;
  monthlyFee: string;
  createdAt?: string;
  students: Student[];
}

interface CenterToast {
  isOpen: boolean;
  // 'error' reuses the existing rose styling and only appears when an operation fails
  type: 'success' | 'delete' | 'error';
  title: string;
  message: string;
}

// ----------------------------------------------------------------------
// EXCEL / CSV BULK STUDENT IMPORT — TYPES
// ----------------------------------------------------------------------
interface ParsedExcelRow {
  rowIndex: number; // 1-based row number as it appeared in the spreadsheet (header excluded)
  data: Record<string, unknown>;
}

type StudentColumnMap = StudentImportColumnMap;

type ImportRowStatus = 'valid' | 'invalid' | 'duplicate';

interface ProcessedStudentRow {
  id: string;
  rowIndex: number;
  name: string;
  fatherName: string;
  phoneRaw: string;
  phoneFormatted: string;
  rollNo: string;
  gender: 'Male' | 'Female' | '';
  feeRaw: string;
  feeNormalized: string;
  consentRawValues: Record<StudentConsentColumnKey, string>;
  consents: Record<StudentConsentColumnKey, boolean>;
  photoUrl: string;
  avatar: string;
  status: ImportRowStatus;
  whatsappVerificationStatus?: 'registered' | 'not_registered' | 'invalid' | 'verification_failed';
  errorReason?: string;
  saveStatus?: 'pending' | 'success' | 'failed';
  saveError?: string;
}

interface StudentImportSummary {
  imported: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  failed: number;
  ignoredConsentColumns: string[];
}

// ----------------------------------------------------------------------
// IDENTIFIER CONTRACT (shared with Attendance, Fees, Quiz, Analytics, Reports, Dashboard)
//   tenant id   : resolveTeacherTenant(...).tenantId  -> normalized teacher email (legacy-compatible)
//   class id    : the Firestore document id under users/{tenantId}/classes/{classId}
//   student id  : the value stored in the student record (`id`, or legacy `studentId`), compared as String()
// Those modules should import these helpers instead of re-deriving paths or ids.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// ERRORS + SMALL UTILITIES
// ----------------------------------------------------------------------
export class StudentOpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StudentOpError';
    this.code = code;
  }
}

export const getFriendlyErrorMessage = (error: unknown): string => {
  if (error instanceof StudentOpError) return error.message;
  const details = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const code = String(details.code ?? '').replace(/^firestore\//, '');
  switch (code) {
    case 'permission-denied':
      return 'You do not have permission to do this. Please sign in again or contact your administrator.';
    case 'unauthenticated':
      return 'Your session has expired. Please sign in again.';
    case 'unavailable':
    case 'deadline-exceeded':
      return 'Network problem. Please check your connection and try again.';
    case 'not-found':
      return 'This record no longer exists. It may have been removed on another device.';
    case 'aborted':
    case 'failed-precondition':
      return 'Another update happened at the same time. Please try again.';
    case 'resource-exhausted':
      return 'Service limit reached. Please try again in a moment.';
    case 'invalid-argument':
      return 'The data is invalid or too large to save (try a smaller photo).';
    default:
      return details.message ? String(details.message) : error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  }
};

const isBrowserOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

const assertOnline = () => {
  if (isBrowserOffline()) {
    throw new StudentOpError('OFFLINE', 'You appear to be offline. Please reconnect and try again.');
  }
};

// Removes `undefined` values (Firestore rejects them) without touching anything else
const stripUndefined = (input: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  Object.keys(input).forEach((k) => {
    if (input[k] !== undefined) out[k] = input[k];
  });
  return out;
};

// Phone formatter shared by typing and by opening the edit form (legacy numbers are formatted for display only)
export const formatPakPhone = (raw: string): string => {
  let digits = String(raw ?? '').replace(/\D/g, '');

  if (digits.startsWith('0')) digits = digits.substring(1);
  if (digits.startsWith('92')) digits = digits.substring(2);

  digits = digits.slice(0, 10);

  if (!digits) return '+92 ';
  if (digits.length <= 3) return `+92 ${digits}`;
  return `+92 ${digits.slice(0, 3)} ${digits.slice(3)}`;
};

const safeNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Fee fields are stored as strings; accept only finite, non-negative numbers
const normalizeFeeInput = (value: unknown, fallback: string): string => {
  const raw = String(value ?? '').trim();
  const chosen = raw === '' ? fallback : raw;
  const n = Number(chosen);
  if (!Number.isFinite(n) || n < 0) {
    throw new StudentOpError('INVALID_FEE', 'Please enter a valid fee amount (0 or more).');
  }
  return chosen;
};

const isValidPathSegment = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && !value.includes('/');

const DEFAULT_AVATAR_FEMALE =
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop&q=80';
const DEFAULT_AVATAR_MALE =
  'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80';

export const getDefaultAvatar = (gender: 'Male' | 'Female'): string =>
  gender === 'Female' ? DEFAULT_AVATAR_FEMALE : DEFAULT_AVATAR_MALE;

// ----------------------------------------------------------------------
// TENANT RESOLUTION (single strategy)
//   1. Wait for Firebase Auth to resolve the current user.
//   2. Tenant id = normalized email (this is how existing data is stored). No migration.
//      Only when the account has no email is users/{uid} used, and only if that profile already exists.
//   3. The tenant profile document is read and verified (owner uid / email / disabled flags).
//   4. A missing profile document for an email tenant is treated as legacy (subcollections may exist
//      without a parent document); it is never created or modified here.
// There is NO fallback tenant such as "test_user".
// ----------------------------------------------------------------------
export interface AuthIdentity {
  uid: string;
  email?: string | null;
}

export type ProfileReader = (
  docId: string
) => Promise<{ exists: boolean; data: Record<string, unknown> | undefined }>;

export type TenantResolution =
  | { status: 'ready'; tenantId: string; uid: string; profileFound: boolean }
  | { status: 'unauthenticated'; reason: string }
  | { status: 'denied'; reason: string }
  | { status: 'error'; reason: string };

export const normalizeEmailId = (email?: string | null): string =>
  String(email ?? '').toLowerCase().trim();

export const resolveTeacherTenant = async (
  identity: AuthIdentity | null,
  readProfile: ProfileReader
): Promise<TenantResolution> => {
  if (!identity || !identity.uid) {
    return { status: 'unauthenticated', reason: 'Please sign in to manage classes.' };
  }

  const emailId = normalizeEmailId(identity.email);
  const usingEmail = emailId !== '';
  const candidateId = usingEmail ? emailId : identity.uid;

  if (!isValidPathSegment(candidateId)) {
    return { status: 'denied', reason: 'Your account does not have a valid teacher workspace.' };
  }

  let profile: { exists: boolean; data: Record<string, unknown> | undefined };
  try {
    profile = await readProfile(candidateId);
  } catch (error: unknown) {
    return {
      status: 'error',
      reason: `Could not verify your teacher profile. ${getFriendlyErrorMessage(error)}`
    };
  }

  if (!profile.exists) {
    if (usingEmail) {
      // Legacy tenant: classes may exist without a profile document. Nothing is created or migrated.
      return { status: 'ready', tenantId: candidateId, uid: identity.uid, profileFound: false };
    }
    return { status: 'denied', reason: 'No teacher profile was found for this account.' };
  }

  const data = profile.data || {};

  const ownerIds = [data.uid, data.authUid, data.ownerUid, data.userId].filter(
    (v) => typeof v === 'string' && v.trim() !== ''
  );
  if (ownerIds.length > 0 && !ownerIds.includes(identity.uid)) {
    return { status: 'denied', reason: 'This workspace belongs to a different account.' };
  }

  if (typeof data.email === 'string' && data.email.trim() !== '' && usingEmail) {
    if (normalizeEmailId(data.email) !== emailId) {
      return { status: 'denied', reason: 'This workspace belongs to a different account.' };
    }
  }

  if (data.disabled === true || data.active === false || data.deleted === true) {
    return { status: 'denied', reason: 'This teacher account is disabled.' };
  }

  return { status: 'ready', tenantId: candidateId, uid: identity.uid, profileFound: true };
};

const readTenantProfile: ProfileReader = async (docId) => {
  const snap = await getDoc(doc(db, 'users', docId));
  return { exists: snap.exists(), data: snap.exists() ? (snap.data() as Record<string, unknown>) : undefined };
};

// Every Firestore path used by this page is built here, from a verified tenant id only
const assertTenantId = (tenantId: string) => {
  if (!isValidPathSegment(tenantId)) {
    throw new StudentOpError('NO_TENANT', 'No verified teacher workspace. Please sign in again.');
  }
};

const assertClassId = (classId: string) => {
  if (!isValidPathSegment(classId)) {
    throw new StudentOpError('BAD_CLASS', 'Invalid class selected.');
  }
};

export const tenantClassesRef = (tenantId: string) => {
  assertTenantId(tenantId);
  return collection(db, 'users', tenantId, 'classes');
};

export const tenantClassDocRef = (tenantId: string, classId: string) => {
  assertTenantId(tenantId);
  assertClassId(classId);
  return doc(db, 'users', tenantId, 'classes', classId);
};

// Cross-tenant guard: a class id is only usable if it was loaded from the verified tenant's own listener
export const isClassAccessible = (loadedClassIds: string[], classId: string): boolean =>
  isValidPathSegment(classId) && loadedClassIds.includes(classId);

// ----------------------------------------------------------------------
// STUDENT STORAGE HELPERS
// Canonical source of truth: users/{userDocId}/classes/{classId}  ->  field `students` (array).
// Legacy / damaged layouts are READ and WRITTEN in their own format; nothing is converted silently.
// ----------------------------------------------------------------------
// <<CLASS_STUDENT_HELPERS_START>>
// Top-level class fields that are never student records
const RESERVED_CLASS_KEYS = ['id', 'name', 'code', 'monthlyFee', 'className', 'title', 'fee', 'classFee', 'createdAt', 'createdDate', 'date', 'updatedAt', 'students'];

// True only for plain objects ({}), never for arrays, null, Timestamps or other class instances
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Used only for the legacy top-level layout, where a student must carry a name or an identifier
const isStudentRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainObject(value)) return false;
  return typeof value.name === 'string' || value.id !== undefined || value.studentId !== undefined;
};

const compareStudentKeys = (a: string, b: string): number => {
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  return a.localeCompare(b);
};

type RawStudentLayout =
  | { kind: 'array' }
  | { kind: 'studentsMap' }
  | { kind: 'topLevelMap' }
  | { kind: 'empty' }
  | { kind: 'unsupported' };

// Detects HOW students are stored in a class document
export const detectRawStudentLayout = (classData: unknown): RawStudentLayout => {
  if (classData === null || classData === undefined) return { kind: 'empty' };
  if (!isPlainObject(classData)) return { kind: 'unsupported' };
  const students = classData.students;
  if (Array.isArray(students)) return { kind: 'array' };
  if (isPlainObject(students)) return { kind: 'studentsMap' };
  if (students !== undefined && students !== null) return { kind: 'unsupported' };
  const hasTopLevelStudents = Object.keys(classData).some(
    k => !RESERVED_CLASS_KEYS.includes(k) && isStudentRecord(classData[k])
  );
  return hasTopLevelStudents ? { kind: 'topLevelMap' } : { kind: 'empty' };
};

interface RawStudentEntry {
  key: string;
  value: Record<string, unknown>;
}

// Raw student entries exactly as stored (key = array index or map key). Never modifies anything.
export const getRawStudentEntries = (classData: unknown): RawStudentEntry[] => {
  const layout = detectRawStudentLayout(classData);
  if (!isPlainObject(classData)) return [];

  if (layout.kind === 'array' && Array.isArray(classData.students)) {
    return classData.students
      .map((value: unknown, index: number) => ({ key: String(index), value }))
      .filter((entry): entry is RawStudentEntry => isPlainObject(entry.value));
  }

  if (layout.kind === 'studentsMap' && isPlainObject(classData.students)) {
    const studentMap = classData.students;
    return Object.keys(studentMap)
      .filter((key) => isStudentRecord(studentMap[key]))
      .sort(compareStudentKeys)
      .map((key) => ({ key, value: studentMap[key] as Record<string, unknown> }));
  }

  if (layout.kind === 'topLevelMap') {
    return Object.keys(classData)
      .filter((key) => !RESERVED_CLASS_KEYS.includes(key) && isStudentRecord(classData[key]))
      .sort(compareStudentKeys)
      .map((key) => ({ key, value: classData[key] as Record<string, unknown> }));
  }

  return [];
};

const normalizeFeeStatus = (value: unknown): 'Paid' | 'Unpaid' | 'Partial' => {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'paid') return 'Paid';
  if (v === 'partial') return 'Partial';
  return 'Unpaid';
};

// Display-only normalization; a missing/odd gender is shown as Male exactly like the UI always did
const normalizeGender = (value: unknown): 'Male' | 'Female' =>
  String(value ?? '').trim().toLowerCase() === 'female' ? 'Female' : 'Male';

// READ-ONLY conversion for display. Original ids and every other field are preserved as stored.
// No ids are generated here; fee status is only a display value and never hides a student.
export const readStudentsFromClass = (classData: unknown): Student[] => {
  return getRawStudentEntries(classData).map(({ key, value }) => {
    const gender = normalizeGender(value.gender);
    const student = {
      ...value,
      name: String(value.name ?? ''),
      fatherName: String(value.fatherName ?? ''),
      phone: String(value.phone ?? ''),
      rollNo: String(value.rollNo ?? ''),
      gender,
      avatar: typeof value.avatar === 'string' && value.avatar !== '' ? value.avatar : getDefaultAvatar(gender),
      feeStatus: normalizeFeeStatus(value.feeStatus),
      _sourceKey: key
    } as Student;

    const rawId = value.id ?? value.studentId;
    if (typeof rawId === 'string' || typeof rawId === 'number') student.id = rawId;
    else delete student.id;

    if (student.studentFee !== undefined && student.studentFee !== null) {
      student.studentFee = String(student.studentFee);
    }
    return student;
  });
};

export const getStudentIdentifier = (value: unknown): string | null => {
  if (!isPlainObject(value)) return null;
  const id = value.id ?? value.studentId;
  return id === undefined || id === null ? null : String(id);
};

const sameIdentity = (raw: unknown, target: unknown): boolean => {
  if (!isPlainObject(raw) || !isPlainObject(target)) return false;
  return String(raw.name ?? '') === String(target.name ?? '') &&
    String(raw.rollNo ?? '') === String(target.rollNo ?? '');
};

// Finds the stored entry for a student. Matches by id; if the id is duplicated in the document the
// storage position AND the name/roll identity are used to pick exactly one entry, otherwise nothing
// matches (never guesses). For students with no id at all, storage position is used only if the name
// still matches, so unrelated students can never be matched by accident.
export const findRawStudentEntry = (classData: unknown, target: unknown): RawStudentEntry | null => {
  const entries = getRawStudentEntries(classData);
  const targetRecord = isPlainObject(target) ? target : {};
  const targetId = getStudentIdentifier(targetRecord);

  if (targetId !== null) {
    const matches = entries.filter(e => getStudentIdentifier(e.value) === targetId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const exact = matches.filter(e => e.key === targetRecord._sourceKey && sameIdentity(e.value, targetRecord));
      if (exact.length === 1) return exact[0];
      const byIdentity = matches.filter(e => sameIdentity(e.value, target));
      return byIdentity.length === 1 ? byIdentity[0] : null;
    }
    return null;
  }

  const byPosition = entries.find(e => e.key === targetRecord._sourceKey);
  if (
    byPosition &&
    getStudentIdentifier(byPosition.value) === null &&
    String(byPosition.value.name ?? '') === String(targetRecord.name ?? '')
  ) {
    return byPosition;
  }
  return null;
};

const normRoll = (value: unknown): string => String(value ?? '').trim().toLowerCase();

// Another stored student already using this roll number (ignoring the entry being edited)
export const findRollConflict = (classData: unknown, rollNo: string, ignoreKey?: string): RawStudentEntry | null => {
  const wanted = normRoll(rollNo);
  if (!wanted) return null;
  return (
    getRawStudentEntries(classData).find(
      e => e.key !== ignoreKey && normRoll(e.value.rollNo) === wanted
    ) ?? null
  );
};

export type StudentWritePlan =
  | { type: 'none' }
  | { type: 'error'; reason: string }
  | { type: 'array'; students: unknown[] }
  | { type: 'fields'; sets: { path: string[]; value: unknown }[]; deletes: string[][] };

const nextNumericKey = (obj: unknown): string => {
  const source = isPlainObject(obj) || Array.isArray(obj) ? obj : {};
  const nums = Object.keys(source).map(Number).filter(n => Number.isInteger(n) && n >= 0);
  return String(nums.length > 0 ? Math.max(...nums) + 1 : 0);
};

const studentBasePath = (layoutKind: string, key: string): string[] =>
  layoutKind === 'studentsMap' ? ['students', key] : [key];

// PURE: plan for adding one student (new students go first, as before). Id is made unique against stored ids.
export const planAddStudent = (classData: unknown, buildStudent: (id: number) => Record<string, unknown>, baseId: number): StudentWritePlan => {
  const classRecord = isPlainObject(classData) ? classData : {};
  const layout = detectRawStudentLayout(classData);
  if (layout.kind === 'unsupported') {
    return { type: 'error', reason: 'Unsupported students format in class document' };
  }

  const existingIds = new Set(
    getRawStudentEntries(classData)
      .map(e => getStudentIdentifier(e.value))
      .filter(x => x !== null)
  );
  let id = baseId;
  while (existingIds.has(String(id))) id++;
  const student = stripUndefined(buildStudent(id));

  if (layout.kind === 'array') {
    const rawStudents = classRecord.students;
    if (!Array.isArray(rawStudents)) {
      return { type: 'error', reason: 'Invalid students array in class document' };
    }
    return { type: 'array', students: [student, ...rawStudents] };
  }
  if (layout.kind === 'empty') {
    return { type: 'array', students: [student] };
  }
  if (layout.kind === 'studentsMap') {
    const key = nextNumericKey(classRecord.students);
    return { type: 'fields', sets: [{ path: ['students', key], value: student }], deletes: [] };
  }
  const key = nextNumericKey(classRecord);
  return { type: 'fields', sets: [{ path: [key], value: student }], deletes: [] };
};

// PURE: plan for editing one student. Only the fields in buildChanges() are touched; all other
// fields (id, feeStatus, studentFee history, unknown fields...) stay exactly as stored.
export const planEditStudent = (classData: unknown, target: unknown, buildChanges: (raw: Record<string, unknown>) => Record<string, unknown>): StudentWritePlan => {
  const classRecord = isPlainObject(classData) ? classData : {};
  const layout = detectRawStudentLayout(classData);
  if (layout.kind === 'unsupported') {
    return { type: 'error', reason: 'Unsupported students format in class document' };
  }
  const entry = findRawStudentEntry(classData, target);
  if (!entry) {
    return { type: 'error', reason: 'Student not found in class document (or its id is duplicated and ambiguous)' };
  }

  const changes = stripUndefined(buildChanges(entry.value));
  const changedFields = Object.keys(changes).filter(field => changes[field] !== entry.value[field]);
  if (changedFields.length === 0) return { type: 'none' };

  if (layout.kind === 'array') {
    const rawStudents = classRecord.students;
    if (!Array.isArray(rawStudents)) {
      return { type: 'error', reason: 'Invalid students array in class document' };
    }
    const students = rawStudents.map((value: unknown, index: number) => {
      if (String(index) !== entry.key || !isPlainObject(value)) return value;
      const next: Record<string, unknown> = { ...value };
      changedFields.forEach(field => { next[field] = changes[field]; });
      return next;
    });
    return { type: 'array', students };
  }

  const base = studentBasePath(layout.kind, entry.key);
  return {
    type: 'fields',
    sets: changedFields.map(field => ({ path: [...base, field], value: changes[field] })),
    deletes: []
  };
};

// PURE: plan for deleting exactly one student (the matched entry), never by a loose filter
export const planDeleteStudent = (classData: unknown, target: unknown): StudentWritePlan => {
  const classRecord = isPlainObject(classData) ? classData : {};
  const layout = detectRawStudentLayout(classData);
  if (layout.kind === 'unsupported') {
    return { type: 'error', reason: 'Unsupported students format in class document' };
  }
  const entry = findRawStudentEntry(classData, target);
  if (!entry) {
    return { type: 'error', reason: 'Student not found in class document (or its id is duplicated and ambiguous)' };
  }

  if (layout.kind === 'array') {
    const rawStudents = classRecord.students;
    if (!Array.isArray(rawStudents)) {
      return { type: 'error', reason: 'Invalid students array in class document' };
    }
    return {
      type: 'array',
      students: rawStudents.filter((_value: unknown, index: number) => String(index) !== entry.key)
    };
  }

  return { type: 'fields', sets: [], deletes: [studentBasePath(layout.kind, entry.key)] };
};
// <<CLASS_STUDENT_HELPERS_END>>

// Applies a plan inside a Firestore transaction (only the intended student field(s) are written)
export const applyStudentWritePlan = (tx: Transaction, classRef: DocumentReference<DocumentData>, plan: StudentWritePlan) => {
  if (plan.type === 'error') throw new StudentOpError('PLAN_ERROR', plan.reason);
  if (plan.type === 'none') return;

  if (plan.type === 'array') {
    tx.update(classRef, { students: plan.students });
    return;
  }

  const args: unknown[] = [];
  plan.sets.forEach(entry => {
    args.push(new FieldPath(...entry.path), entry.value);
  });
  plan.deletes.forEach(path => {
    args.push(new FieldPath(...path), deleteField());
  });
  if (args.length === 0) return;
  const [firstField, firstValue, ...rest] = args;
  tx.update(classRef, firstField as FieldPath, firstValue as never, ...(rest as never[]));
};

// ----------------------------------------------------------------------
// CLASS ITEM BUILDER (pure; used by the realtime listener)
// ----------------------------------------------------------------------
export const buildClassItem = (docId: string, data: unknown): ClassItem => {
  const safeData = isPlainObject(data) ? data : {};
  let students: Student[] = [];
  try {
    students = readStudentsFromClass(safeData);
  } catch (error) {
    console.error('Malformed students in class', docId, error);
  }
  return {
    ...(safeData as Omit<ClassItem, 'id' | 'students'>),
    id: docId, // the Firestore document id always wins over any stored `id` field
    name: String(safeData.name ?? safeData.className ?? safeData.title ?? ''),
    code: String(safeData.code ?? ''),
    monthlyFee: String(safeData.monthlyFee ?? safeData.fee ?? safeData.classFee ?? ''),
    students
  };
};

// ----------------------------------------------------------------------
// DATA SERVICES (every call takes an explicit verified tenant id; nothing reads component state)
// ----------------------------------------------------------------------
export interface ClassFormValues {
  name: string;
  code: string;
  monthlyFee: string;
}

const validateClassValues = (values: ClassFormValues): ClassFormValues => {
  const name = String(values.name ?? '').trim();
  const code = String(values.code ?? '').trim();
  if (!name || !code) {
    throw new StudentOpError('INVALID_CLASS', 'Class name and class code are required.');
  }
  return {
    name,
    code: code.toUpperCase(),
    monthlyFee: normalizeFeeInput(values.monthlyFee, '5000')
  };
};

export const createClassForTenant = async (tenantId: string, values: ClassFormValues): Promise<void> => {
  const clean = validateClassValues(values);
  await addDoc(tenantClassesRef(tenantId), {
    name: clean.name,
    code: clean.code,
    monthlyFee: clean.monthlyFee,
    createdAt: new Date().toISOString(),
    students: []
  });
};

// Partial update: only name / code / monthlyFee are written; students and every other field stay untouched
export const updateClassForTenant = async (tenantId: string, classId: string, values: ClassFormValues): Promise<void> => {
  const clean = validateClassValues(values);
  await updateDoc(tenantClassDocRef(tenantId, classId), {
    name: clean.name,
    code: clean.code,
    monthlyFee: clean.monthlyFee
  });
};

export const deleteClassForTenant = async (tenantId: string, classId: string): Promise<void> => {
  await deleteDoc(tenantClassDocRef(tenantId, classId));
};

export interface StudentFormValues {
  name: string;
  fatherName: string;
  phone: string;
  rollNo: string;
  gender: 'Male' | 'Female';
  studentFee: string;
  avatar: string;
  attendanceWhatsAppOptIn: boolean;
  monthlyReportWhatsAppOptIn?: boolean;
  quizResultsWhatsAppOptIn?: boolean;
  feeAlertsWhatsAppOptIn?: boolean;
  announcementWhatsAppOptIn?: boolean;
  libraryLinkWhatsAppOptIn?: boolean;
}

const validateStudentValues = (values: StudentFormValues, fallbackFee: string): StudentFormValues => {
  const name = String(values.name ?? '').trim();
  const rollNo = String(values.rollNo ?? '').trim();
  if (!name) throw new StudentOpError('INVALID_STUDENT', 'Student name is required.');
  if (!rollNo) throw new StudentOpError('INVALID_STUDENT', 'Roll number is required.');
  return {
    name,
    fatherName: String(values.fatherName ?? '').trim(),
    phone: String(values.phone ?? ''),
    rollNo,
    gender: values.gender === 'Female' ? 'Female' : 'Male',
    studentFee: normalizeFeeInput(values.studentFee, fallbackFee),
    avatar: String(values.avatar ?? ''),
    attendanceWhatsAppOptIn: values.attendanceWhatsAppOptIn === true,
    monthlyReportWhatsAppOptIn: values.monthlyReportWhatsAppOptIn === true,
    quizResultsWhatsAppOptIn: values.quizResultsWhatsAppOptIn === true,
    feeAlertsWhatsAppOptIn: values.feeAlertsWhatsAppOptIn === true,
    announcementWhatsAppOptIn: values.announcementWhatsAppOptIn === true,
    libraryLinkWhatsAppOptIn: values.libraryLinkWhatsAppOptIn === true
  };
};

const readClassDataInTx = async (tx: Transaction, classRef: DocumentReference<DocumentData>) => {
  const snap = await tx.get(classRef);
  if (!snap.exists()) throw new StudentOpError('CLASS_MISSING', 'This class no longer exists.');
  return snap.data();
};

const throwRollConflict = (rollNo: string): never => {
  throw new StudentOpError('DUPLICATE_ROLL', `Roll number ${rollNo} is already used by another student in this class.`);
};

export const addStudentToClass = async (
  _tenantId: string,
  classId: string,
  rawValues: StudentFormValues,
  options: { classMonthlyFee: string; baseId?: number }
): Promise<{ ignoredConsentFeatures: string[] }> => {
  if (!isValidPathSegment(classId)) throw new StudentOpError('BAD_CLASS', 'Invalid class selected.');
  const values = validateStudentValues(rawValues, options.classMonthlyFee || '5000');
  const user = auth.currentUser;
  if (!user) throw new StudentOpError('NO_AUTH', 'Please sign in again before adding a student.');

  const token = await user.getIdToken();
  const response = await fetch('/api/teacher/students/add', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ classId, values, classMonthlyFee: options.classMonthlyFee || '5000' }),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  const result = isPlainObject(payload) ? payload : {};
  if (!response.ok || result.success !== true) {
    const code = typeof result.code === 'string' ? result.code : 'STUDENT_SAVE_FAILED';
    const message = typeof result.error === 'string' ? result.error : 'The student could not be saved. Please try again.';
    throw new StudentOpError(code, message);
  }
  return {
    ignoredConsentFeatures: Array.isArray(result.ignoredConsentFeatures)
      ? result.ignoredConsentFeatures.filter((value): value is string => typeof value === 'string')
      : [],
  };
};

export const updateStudentInClass = async (
  tenantId: string,
  classId: string,
  target: unknown,
  rawValues: StudentFormValues,
  options: { classMonthlyFee: string; originalAvatar: string }
): Promise<void> => {
  const classRef = tenantClassDocRef(tenantId, classId);
  const values = validateStudentValues(rawValues, options.classMonthlyFee || '5000');

  await runTransaction(db, async (tx) => {
    const classData = await readClassDataInTx(tx, classRef);

    const entry = findRawStudentEntry(classData, target);
    if (entry && normRoll(entry.value.rollNo) !== normRoll(values.rollNo)) {
      if (findRollConflict(classData, values.rollNo, entry.key)) throwRollConflict(values.rollNo);
    }

    const plan = planEditStudent(classData, target, (raw) => {
      const changes: Record<string, unknown> = {};
      const setIfChanged = (field: string, next: string, current: string) => {
        if (next !== current) changes[field] = next;
      };

      setIfChanged('name', values.name, String(raw.name ?? ''));
      setIfChanged('fatherName', values.fatherName, String(raw.fatherName ?? ''));
      setIfChanged('phone', values.phone, String(raw.phone ?? ''));
      const nextAttendanceOptIn = values.attendanceWhatsAppOptIn === true;
      const rawPhone = String(raw.phone ?? '');
      const savedAttendanceConsentPhone = String(raw.attendanceWhatsAppOptInPhone ?? '');
      const hasAttendanceConsentTimestamp =
        Boolean(String(raw.attendanceWhatsAppOptInAt ?? '').trim());
      const currentAttendanceConsentValid =
        raw.attendanceWhatsAppOptIn === true &&
        hasAttendanceConsentTimestamp &&
        formatPakPhone(savedAttendanceConsentPhone) === formatPakPhone(rawPhone);
      const attendanceConsentNeedsUpdate =
        nextAttendanceOptIn !== (raw.attendanceWhatsAppOptIn === true) ||
        (raw.attendanceWhatsAppOptIn === true && !currentAttendanceConsentValid) ||
        formatPakPhone(values.phone) !== formatPakPhone(rawPhone) ||
        (nextAttendanceOptIn &&
          formatPakPhone(savedAttendanceConsentPhone) !== formatPakPhone(values.phone));

      if (attendanceConsentNeedsUpdate) {
        changes.attendanceWhatsAppOptIn = nextAttendanceOptIn;
        changes.attendanceWhatsAppOptInAt =
          nextAttendanceOptIn ? new Date().toISOString() : null;
        changes.attendanceWhatsAppOptInPhone =
          nextAttendanceOptIn ? values.phone : null;
      }

      const nextMonthlyOptIn = values.monthlyReportWhatsAppOptIn === true;
      const savedMonthlyConsentPhone = String(raw.parentWhatsAppOptInPhone ?? '');
      const hasMonthlyConsentTimestamp =
        Boolean(String(raw.parentWhatsAppOptInAt ?? '').trim());
      const currentMonthlyConsentValid =
        raw.parentWhatsAppOptIn === true &&
        hasMonthlyConsentTimestamp &&
        formatPakPhone(savedMonthlyConsentPhone) === formatPakPhone(rawPhone);
      const monthlyConsentNeedsUpdate =
        nextMonthlyOptIn !== (raw.parentWhatsAppOptIn === true) ||
        (nextMonthlyOptIn && !currentMonthlyConsentValid) ||
        formatPakPhone(values.phone) !== formatPakPhone(rawPhone) ||
        (nextMonthlyOptIn &&
          formatPakPhone(savedMonthlyConsentPhone) !== formatPakPhone(values.phone));

      if (monthlyConsentNeedsUpdate) {
        changes.parentWhatsAppOptIn = nextMonthlyOptIn;
        changes.parentWhatsAppOptInAt = nextMonthlyOptIn
          ? (currentMonthlyConsentValid
            ? String(raw.parentWhatsAppOptInAt)
            : new Date().toISOString())
          : null;
        changes.parentWhatsAppOptInPhone = nextMonthlyOptIn ? values.phone : null;
      }

      const nextQuizResultsOptIn = values.quizResultsWhatsAppOptIn === true;
      const savedQuizResultsConsentPhone = String(raw.quizResultsWhatsAppOptInPhone ?? '');
      const hasQuizResultsConsentTimestamp =
        Boolean(String(raw.quizResultsWhatsAppOptInAt ?? '').trim());
      const currentQuizResultsConsentValid =
        raw.quizResultsWhatsAppOptIn === true &&
        hasQuizResultsConsentTimestamp &&
        formatPakPhone(savedQuizResultsConsentPhone) === formatPakPhone(rawPhone);
      const quizResultsConsentNeedsUpdate =
        nextQuizResultsOptIn !== (raw.quizResultsWhatsAppOptIn === true) ||
        (nextQuizResultsOptIn && !currentQuizResultsConsentValid) ||
        formatPakPhone(values.phone) !== formatPakPhone(rawPhone) ||
        (nextQuizResultsOptIn &&
          formatPakPhone(savedQuizResultsConsentPhone) !== formatPakPhone(values.phone));

      if (quizResultsConsentNeedsUpdate) {
        changes.quizResultsWhatsAppOptIn = nextQuizResultsOptIn;
        changes.quizResultsWhatsAppOptInAt = nextQuizResultsOptIn
          ? (currentQuizResultsConsentValid
            ? String(raw.quizResultsWhatsAppOptInAt)
            : new Date().toISOString())
          : null;
        changes.quizResultsWhatsAppOptInPhone = nextQuizResultsOptIn ? values.phone : null;
      }

      const nextAnnouncementOptIn = values.announcementWhatsAppOptIn === true;
      const savedAnnouncementConsentPhone = String(raw.announcementWhatsAppOptInPhone ?? '');
      const hasAnnouncementConsentTimestamp = Boolean(String(raw.announcementWhatsAppOptInAt ?? '').trim());
      const currentAnnouncementConsentValid = raw.announcementWhatsAppOptIn === true &&
        hasAnnouncementConsentTimestamp &&
        formatPakPhone(savedAnnouncementConsentPhone) === formatPakPhone(rawPhone);
      const announcementConsentNeedsUpdate =
        nextAnnouncementOptIn !== (raw.announcementWhatsAppOptIn === true) ||
        (nextAnnouncementOptIn && !currentAnnouncementConsentValid) ||
        formatPakPhone(values.phone) !== formatPakPhone(rawPhone) ||
        (nextAnnouncementOptIn && formatPakPhone(savedAnnouncementConsentPhone) !== formatPakPhone(values.phone));
      if (announcementConsentNeedsUpdate) {
        changes.announcementWhatsAppOptIn = nextAnnouncementOptIn;
        changes.announcementWhatsAppOptInAt = nextAnnouncementOptIn
          ? (currentAnnouncementConsentValid ? String(raw.announcementWhatsAppOptInAt) : new Date().toISOString())
          : null;
        changes.announcementWhatsAppOptInPhone = nextAnnouncementOptIn ? values.phone : null;
      }

      const nextLibraryLinkOptIn = values.libraryLinkWhatsAppOptIn === true;
      const savedLibraryConsentPhone = String(raw.libraryLinkWhatsAppOptInPhone ?? '');
      const hasLibraryConsentTimestamp = Boolean(String(raw.libraryLinkWhatsAppOptInAt ?? '').trim());
      const currentLibraryConsentValid = raw.libraryLinkWhatsAppOptIn === true && hasLibraryConsentTimestamp &&
        formatPakPhone(savedLibraryConsentPhone) === formatPakPhone(rawPhone);
      const libraryConsentNeedsUpdate =
        nextLibraryLinkOptIn !== (raw.libraryLinkWhatsAppOptIn === true) ||
        (nextLibraryLinkOptIn && !currentLibraryConsentValid) ||
        formatPakPhone(values.phone) !== formatPakPhone(rawPhone) ||
        (nextLibraryLinkOptIn && formatPakPhone(savedLibraryConsentPhone) !== formatPakPhone(values.phone));
      if (libraryConsentNeedsUpdate) {
        changes.libraryLinkWhatsAppOptIn = nextLibraryLinkOptIn;
        changes.libraryLinkWhatsAppOptInAt = nextLibraryLinkOptIn
          ? (currentLibraryConsentValid ? String(raw.libraryLinkWhatsAppOptInAt) : new Date().toISOString())
          : null;
        changes.libraryLinkWhatsAppOptInPhone = nextLibraryLinkOptIn ? values.phone : null;
      }

      const nextFeeAlertsOptIn = values.feeAlertsWhatsAppOptIn === true;
      const savedFeeAlertsConsentPhone = String(raw.feeAlertsWhatsAppOptInPhone ?? '');
      const hasFeeAlertsConsentTimestamp =
        Boolean(String(raw.feeAlertsWhatsAppOptInAt ?? '').trim());
      const currentFeeAlertsConsentValid =
        raw.feeAlertsWhatsAppOptIn === true &&
        hasFeeAlertsConsentTimestamp &&
        formatPakPhone(savedFeeAlertsConsentPhone) === formatPakPhone(rawPhone);
      const feeAlertsConsentNeedsUpdate =
        nextFeeAlertsOptIn !== (raw.feeAlertsWhatsAppOptIn === true) ||
        (nextFeeAlertsOptIn && !currentFeeAlertsConsentValid) ||
        formatPakPhone(values.phone) !== formatPakPhone(rawPhone) ||
        (nextFeeAlertsOptIn &&
          formatPakPhone(savedFeeAlertsConsentPhone) !== formatPakPhone(values.phone));

      if (feeAlertsConsentNeedsUpdate) {
        changes.feeAlertsWhatsAppOptIn = nextFeeAlertsOptIn;
        changes.feeAlertsWhatsAppOptInAt = nextFeeAlertsOptIn
          ? (currentFeeAlertsConsentValid
            ? String(raw.feeAlertsWhatsAppOptInAt)
            : new Date().toISOString())
          : null;
        changes.feeAlertsWhatsAppOptInPhone = nextFeeAlertsOptIn ? values.phone : null;
      }

      setIfChanged('rollNo', values.rollNo, String(raw.rollNo ?? ''));
      setIfChanged('gender', values.gender, normalizeGender(raw.gender));

      // Fee: effective stored fee falls back to the class fee for display; only write on a real change
      const storedFee =
        raw.studentFee !== undefined && raw.studentFee !== null && String(raw.studentFee) !== ''
          ? String(raw.studentFee)
          : String(options.classMonthlyFee || '5000');
      if (Number(values.studentFee) !== Number(storedFee)) changes.studentFee = values.studentFee;

      // Photo: only when the user actually picked a different one
      if (values.avatar && values.avatar !== options.originalAvatar) changes.avatar = values.avatar;

      return changes;
    });
    applyStudentWritePlan(tx, classRef, plan);
  });
};

export const removeStudentFromClass = async (
  tenantId: string,
  classId: string,
  target: unknown
): Promise<void> => {
  const classRef = tenantClassDocRef(tenantId, classId);
  await runTransaction(db, async (tx) => {
    const classData = await readClassDataInTx(tx, classRef);
    applyStudentWritePlan(tx, classRef, planDeleteStudent(classData, target));
  });
};

// ----------------------------------------------------------------------
// IMAGE HELPER: photos are stored inline in the class document (1 MiB limit for ALL students together),
// so selected photos are downscaled before they are kept.
// ----------------------------------------------------------------------
const fileToCompressedDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.onload = () => {
      const original = String(reader.result || '');
      const img = new Image();
      img.onerror = () => reject(new Error('The selected file is not a valid image.'));
      img.onload = () => {
        try {
          const MAX_SIDE = 320;
          const scale = Math.min(1, MAX_SIDE / Math.max(img.width || 1,
          img.height || 1));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no canvas context');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          if (original.length <= 150000) resolve(original);
          else reject(new Error('This photo is too large. Please choose a smaller image.'));
        }
      };
      img.src = original;
    };
    reader.readAsDataURL(file);
  });

// Roll numbers: natural ordering ("2" < "10" < "10A"), then name, then storage position (stable)
export const compareStudentsForList = (a: Student, b: Student): number => {
  const byRoll = String(a.rollNo ?? '').localeCompare(String(b.rollNo ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
  if (byRoll !== 0) return byRoll;
  const byName = String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return compareStudentKeys(String(a._sourceKey ?? ''), String(b._sourceKey ?? ''));
};

type TenantState =
  | { status: 'resolving' }
  | { status: 'unauthenticated' }
  | { status: 'denied'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'ready'; tenantId: string; uid: string; token: number };

interface TenantSession {
  uid: string;
  tenantId: string;
  token: number;
}

export default function Classes() {
  const navigate = useNavigate();
  const { canAccessFeature, requestFeatureAddOn, entitlementLoading, entitlement, refreshEntitlement } = useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tenant, setTenant] = useState<TenantState>({ status: 'resolving' });

  const [isDark, setIsDark] = useState(false);
  const [activeTab, setActiveTab] = useState('classes');
  const [searchQuery, setSearchQuery] = useState('');
  const [studentSearchQuery, setStudentSearchQuery] = useState('');

  // Real-time Firestore State
  const [classList, setClassList] = useState<ClassItem[]>([]);
  const [classesLoaded, setClassesLoaded] = useState(false);
  const [classesSynced, setClassesSynced] = useState(false);

  // Active View State
  const [activeClassId, setActiveClassId] = useState<string | null>(null);

  // Modal States
  const [isCreateClassOpen, setIsCreateClassOpen] = useState(false);
  const [editingClass, setEditingClass] = useState<ClassItem | null>(null);
  const [deleteConfirmClass, setDeleteConfirmClass] = useState<ClassItem | null>(null);

  const [isAddStudentOpen, setIsAddStudentOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [deleteConfirmStudent, setDeleteConfirmStudent] = useState<Student | null>(null);

  // Center Animated Glowing Toast State
  const [toast, setToast] = useState<CenterToast>({
    isOpen: false,
    type: 'success',
    title: '',
    message: ''
  });

  // Form States for Create/Edit Class
  const [classNameInput, setClassNameInput] = useState('');
  const [classCodeInput, setClassCodeInput] = useState('');
  const [monthlyFeeInput, setMonthlyFeeInput] = useState('');

  const [editClassNameInput, setEditClassNameInput] = useState('');
  const [editClassCodeInput, setEditClassCodeInput] = useState('');
  const [editMonthlyFeeInput, setEditMonthlyFeeInput] = useState('');

  // Student Form States
  const [fullName, setFullName] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [whatsapp, setWhatsapp] = useState('+92 ');
  const [guardianWhatsAppCheckStatus, setGuardianWhatsAppCheckStatus] = useState<'idle' | 'checking' | 'registered' | 'not_registered' | 'failed'>('idle');
  const [guardianWhatsAppCheckNumber, setGuardianWhatsAppCheckNumber] = useState('');
  const [guardianWhatsAppCheckMessage, setGuardianWhatsAppCheckMessage] = useState('');
  const [attendanceWhatsAppOptIn, setAttendanceWhatsAppOptIn] = useState(false);
  const [monthlyReportWhatsAppOptIn, setMonthlyReportWhatsAppOptIn] = useState(false);
  const [quizResultsWhatsAppOptIn, setQuizResultsWhatsAppOptIn] = useState(false);
  const [feeAlertsWhatsAppOptIn, setFeeAlertsWhatsAppOptIn] = useState(false);
  const [announcementWhatsAppOptIn, setAnnouncementWhatsAppOptIn] = useState(false);
  const [libraryLinkWhatsAppOptIn, setLibraryLinkWhatsAppOptIn] = useState(false);
  const [rollNo, setRollNo] = useState('');
  const [gender, setGender] = useState<'Male' | 'Female'>('Male');
  const [studentFeeInput, setStudentFeeInput] = useState('');
  const [studentAvatar, setStudentAvatar] = useState<string>('');

  // Filter States for Class Detail View
  const [genderFilter, setGenderFilter] = useState<'All' | 'Male' | 'Female'>('All');
  const [feeFilter, setFeeFilter] = useState<'All' | 'Paid' | 'Unpaid'>('All');

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  // ----------------------------------------------------------------------
  // EXCEL / CSV BULK STUDENT IMPORT — STATE
  // Deliberately separate from the individual student photo upload ref/state above.
  // ----------------------------------------------------------------------
  const excelImportInputRef = useRef<HTMLInputElement | null>(null);

  const [excelDragActive, setExcelDragActive] = useState(false);
  const [excelSelectedFileName, setExcelSelectedFileName] = useState<string | null>(null);
  const [excelParsing, setExcelParsing] = useState(false);
  const [excelImportError, setExcelImportError] = useState<string>('');

  const [excelHeaders, setExcelHeaders] = useState<string[]>([]);
  const [excelRawRows, setExcelRawRows] = useState<ParsedExcelRow[]>([]);
  const [studentColumnMap, setStudentColumnMap] = useState<StudentColumnMap>(createEmptyStudentColumnMap());
  const [needsColumnMapping, setNeedsColumnMapping] = useState(false);
  const [openMappingField, setOpenMappingField] = useState<keyof StudentColumnMap | null>(null);

  // The class id this preview was built for — prevents a preview prepared for one class
  // from ever being imported into a different class.
  const [importPreviewClassId, setImportPreviewClassId] = useState<string | null>(null);

  const [processedStudentRows, setProcessedStudentRows] = useState<ProcessedStudentRow[]>([]);
  const [isBulkWhatsAppChecking, setIsBulkWhatsAppChecking] = useState(false);
  const [studentImportFilter, setStudentImportFilter] = useState<'all' | 'valid' | 'invalid' | 'duplicate'>('all');
  const [studentImportPage, setStudentImportPage] = useState(1);
  const STUDENT_IMPORT_PAGE_SIZE = 10;

  const [isImportingStudents, setIsImportingStudents] = useState(false);
  const [studentImportProgress, setStudentImportProgress] = useState(0);
  const [studentImportSummary, setStudentImportSummary] = useState<StudentImportSummary | null>(null);


  // Refs that make async callbacks safe (no stale tenant, no double submit)
  const sessionRef = useRef<TenantSession | null>(null);
  const sessionCounterRef = useRef(0);
  const classListRef = useRef<ClassItem[]>([]);
  const pendingOpsRef = useRef<Set<string>>(new Set());
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentGuardianPhoneRef = useRef(whatsapp);
  currentGuardianPhoneRef.current = whatsapp;
  classListRef.current = classList;

  // Calculate WhatsApp Digits Count
  const rawWhatsappDigits = whatsapp.replace(/\D/g, '').replace(/^92/, '');
  const whatsappDigitCount = rawWhatsappDigits.length;
  const isWhatsappComplete = whatsappDigitCount === 10;
  const remainingWhatsappDigits = 10 - whatsappDigitCount;
  const requestLockedConsentFeature = async (feature: TeacherFeatureKey) => {
    const result = await requestFeatureAddOn(feature, 'Requested from the Add Student guardian-consent controls.');
    showCenterNotification(result.success ? 'success' : 'error', result.success ? 'Permission Updated' : 'Permission Required', result.success ? 'Ask your Academy Admin to grant the required notification permission.' : (result.error || 'The add-on request could not be submitted.'));
  };

  // Phone Number Formatting & Restriction Handler
  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextPhone = formatPakPhone(e.target.value);

    // Every guardian consent applies only to the exact phone number previously recorded.
    // Any number change requires all purpose-specific consent checkboxes to be confirmed again.
    if (nextPhone !== whatsapp) {
      setAttendanceWhatsAppOptIn(false);
      setMonthlyReportWhatsAppOptIn(false);
      setQuizResultsWhatsAppOptIn(false);
      setFeeAlertsWhatsAppOptIn(false);
      setAnnouncementWhatsAppOptIn(false);
      setLibraryLinkWhatsAppOptIn(false);
      setGuardianWhatsAppCheckStatus('idle');
      setGuardianWhatsAppCheckNumber('');
      setGuardianWhatsAppCheckMessage('');
    }

    setWhatsapp(nextPhone);
  };

  const handleCheckGuardianWhatsApp = async () => {
    if (!isWhatsappComplete || guardianWhatsAppCheckStatus === 'checking') return;
    const submittedNumber = whatsapp.replace(/\D/g, '');
    const user = auth.currentUser;
    if (!user) {
      showCenterNotification('error', 'Sign-In Required', 'Sign in again before verifying this guardian number.');
      return;
    }
    setGuardianWhatsAppCheckStatus('checking');
    setGuardianWhatsAppCheckNumber('');
    setGuardianWhatsAppCheckMessage('Checking WhatsApp registration…');
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/teacher/whatsapp-number-verification/check', {
        method: 'POST', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbers: [submittedNumber] }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; results?: Array<{ number?: string; status?: string }>; error?: string };
      if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Number verification could not be completed.');
      if (currentGuardianPhoneRef.current.replace(/\D/g, '') !== submittedNumber) return;
      const result = payload.results?.find((item) => String(item.number || '') === submittedNumber);
      const status = result?.status === 'registered' ? 'registered' : result?.status === 'not_registered' ? 'not_registered' : 'failed';
      setGuardianWhatsAppCheckStatus(status);
      setGuardianWhatsAppCheckNumber(submittedNumber);
      setGuardianWhatsAppCheckMessage(status === 'registered' ? 'Registered on WhatsApp.' : status === 'not_registered' ? 'Not registered on WhatsApp.' : 'Verification failed; try again.');
    } catch (cause) {
      if (currentGuardianPhoneRef.current.replace(/\D/g, '') !== submittedNumber) return;
      setGuardianWhatsAppCheckStatus('failed');
      setGuardianWhatsAppCheckNumber(submittedNumber);
      setGuardianWhatsAppCheckMessage(cause instanceof Error ? cause.message : 'Verification failed; try again.');
    }
  };

  // Trigger Center Notification Popup
  const showCenterNotification = (type: 'success' | 'delete' | 'error', title: string, message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ isOpen: true, type, title, message });
    toastTimerRef.current = setTimeout(() => {
      setToast((prev) => ({ ...prev, isOpen: false }));
      toastTimerRef.current = null;
    }, type === 'error' ? 3800 : 2200);
  };

  const notifyFailure = (title: string, error: unknown) => {
    showCenterNotification('error', title, getFriendlyErrorMessage(error));
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Duplicate-submission guard (no visual change: simply ignores a second trigger while one is running)
  const beginOperation = (key: string): boolean => {
    if (pendingOpsRef.current.has(key)) return false;
    pendingOpsRef.current.add(key);
    return true;
  };
  const endOperation = (key: string) => {
    pendingOpsRef.current.delete(key);
  };

  // The verified tenant session for a write. Never falls back to any default tenant.
  const requireSession = (): TenantSession | null => {
    const session = sessionRef.current;
    if (!session || auth.currentUser?.uid !== session.uid) {
      showCenterNotification('error', 'Not Signed In', 'Please sign in with your teacher account to continue.');
      return null;
    }
    return session;
  };

  // True only while the exact same user + tenant session that started an operation is still active
  const isSessionCurrent = (session: TenantSession): boolean =>
    sessionRef.current?.token === session.token && auth.currentUser?.uid === session.uid;

  // A class id is only usable if it belongs to the verified tenant's own loaded class list
  const requireAccessibleClass = (classId: string): boolean => {
    const ok = isClassAccessible(classListRef.current.map((c) => c.id), classId);
    if (!ok) {
      showCenterNotification('error', 'Class Unavailable', 'This class is no longer available in your account.');
    }
    return ok;
  };

  // Working Live Image Upload Handler (downscaled so the class document stays small)
  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;

    try {
      if (!file.type.startsWith('image/')) {
        throw new Error('Please choose an image file.');
      }
      const dataUrl = await fileToCompressedDataUrl(file);
      if (dataUrl) {
        setStudentAvatar(dataUrl);
      }
    } catch (error) {
      notifyFailure('Photo Not Added', error);
    } finally {
      // allow selecting the same file again
      input.value = '';
    }
  };

  // Resets every piece of UI that belongs to one tenant session
  // Clears every piece of UI belonging to the Excel/CSV bulk import feature. Used whenever the
  // destination class changes (or becomes unavailable) so a preview built for one class can never
  // be imported into another.
  const resetExcelImportState = () => {
    setExcelDragActive(false);
    setExcelSelectedFileName(null);
    setExcelParsing(false);
    setExcelImportError('');
    setExcelHeaders([]);
    setExcelRawRows([]);
    setStudentColumnMap(createEmptyStudentColumnMap());
    setNeedsColumnMapping(false);
    setOpenMappingField(null);
    setImportPreviewClassId(null);
    setProcessedStudentRows([]);
    setStudentImportFilter('all');
    setStudentImportPage(1);
    setIsImportingStudents(false);
    setStudentImportProgress(0);
    setStudentImportSummary(null);
    if (excelImportInputRef.current) excelImportInputRef.current.value = '';
  };

  const resetWorkspaceState = () => {
    setClassList([]);
    setClassesLoaded(false);
    setClassesSynced(false);
    setActiveClassId(null);
    setIsCreateClassOpen(false);
    setEditingClass(null);
    setDeleteConfirmClass(null);
    setIsAddStudentOpen(false);
    setEditingStudent(null);
    setDeleteConfirmStudent(null);
    setStudentSearchQuery('');
    setSearchQuery('');
    resetExcelImportState();
  };

  // Back Button & Browser History 404 Prevention
  useEffect(() => {
    const handlePopState = () => {
      if (activeClassId) {
        setActiveClassId(null);
        setIsAddStudentOpen(false);
        setEditingStudent(null);
        setDeleteConfirmStudent(null);
      } else if (isAddStudentOpen || isCreateClassOpen || editingClass || deleteConfirmClass || deleteConfirmStudent) {
        setIsAddStudentOpen(false);
        setIsCreateClassOpen(false);
        setEditingClass(null);
        setDeleteConfirmClass(null);
        setDeleteConfirmStudent(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [activeClassId, isAddStudentOpen, isCreateClassOpen, editingClass, deleteConfirmClass, deleteConfirmStudent]);

  const handleSelectClass = (classId: string) => {
    window.history.pushState({ classId }, '', '#view-class');
    resetExcelImportState();
    setActiveClassId(classId);
  };

  const handleBackToClasses = () => {
    resetExcelImportState();
    if (window.location.hash === '#view-class') {
      window.history.back();
    } else {
      setActiveClassId(null);
    }
  };

  // 1. Listen to Firebase Auth State (the user must be resolved before anything is loaded)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        setCurrentUser(user);
        setAuthLoading(false);
      },
      (error) => {
        console.error('Auth listener error:', error);
        setCurrentUser(null);
        setAuthLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  // 2. Resolve + verify the teacher's tenant once the user is known. Any change of user invalidates
  //    the previous session immediately so late callbacks from the old session are ignored.
  const authUid = currentUser?.uid ?? null;
  const authEmail = currentUser?.email ?? null;

  useEffect(() => {
    sessionRef.current = null;
    resetWorkspaceState();

    if (authLoading) {
      setTenant({ status: 'resolving' });
      return;
    }
    if (!authUid) {
      setTenant({ status: 'unauthenticated' });
      return;
    }

    let cancelled = false;
    setTenant({ status: 'resolving' });

    resolveTeacherTenant({ uid: authUid, email: authEmail }, readTenantProfile).then((resolution) => {
      if (cancelled) return;
      if (resolution.status === 'ready') {
        const token = ++sessionCounterRef.current;
        sessionRef.current = { uid: resolution.uid, tenantId: resolution.tenantId, token };
        setTenant({ status: 'ready', tenantId: resolution.tenantId, uid: resolution.uid, token });
      } else if (resolution.status === 'denied' || resolution.status === 'error') {
        setTenant({ status: resolution.status, reason: resolution.reason });
        showCenterNotification('error', 'Access Problem', resolution.reason);
      } else {
        setTenant({ status: 'unauthenticated' });
      }
    });

    return () => {
      cancelled = true;
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, authUid, authEmail]);

  // 3. Fetch Realtime Classes from Firestore (scoped exclusively to the verified tenant)
  const readyTenantId = tenant.status === 'ready' ? tenant.tenantId : null;
  const readyToken = tenant.status === 'ready' ? tenant.token : null;

  useEffect(() => {
    if (!readyTenantId) {
      setClassList([]);
      setClassesLoaded(false);
      setClassesSynced(false);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    try {
      const userClassesRef = tenantClassesRef(readyTenantId);

      unsubscribe = onSnapshot(
        userClassesRef,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (cancelled) return;

          const fetchedClasses: ClassItem[] = snapshot.docs.map((docSnap) =>
            buildClassItem(docSnap.id, docSnap.data())
          );

          fetchedClasses.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          );

          setClassList(fetchedClasses);
          setClassesLoaded(true);
          setClassesSynced(!snapshot.metadata.fromCache);
        },
        (error) => {
          if (cancelled) return;
          console.error("Firestore Listen Error:", error);
          setClassList([]);
          setClassesLoaded(false);
          setClassesSynced(false);
          notifyFailure('Could Not Load Classes', error);
        }
      );
    } catch (error) {
      console.error("Firestore Listen Setup Error:", error);
      notifyFailure('Could Not Load Classes', error);
    }

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyTenantId, readyToken]);

  const currentClass = useMemo(() => {
    return classList.find((c) => c.id === activeClassId) || null;
  }, [classList, activeClassId]);

  // If the open class disappears on the server (deleted elsewhere), leave the detail view
  useEffect(() => {
    if (activeClassId && classesLoaded && classesSynced && !currentClass) {
      setActiveClassId(null);
      setIsAddStudentOpen(false);
      setEditingStudent(null);
      setDeleteConfirmStudent(null);
      resetExcelImportState();
      if (window.location.hash === '#view-class') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
  }, [activeClassId, classesLoaded, classesSynced, currentClass]);

  useEffect(() => {
    setCurrentPage(1);
  }, [studentSearchQuery, genderFilter, feeFilter, activeClassId]);

  const filteredClasses = useMemo(() => {
    return classList
      .filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.code.toLowerCase().includes(searchQuery.toLowerCase())
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [classList, searchQuery]);

  const sortedAndFilteredStudents = useMemo(() => {
    if (!currentClass) return [];

    const list = [...(currentClass.students || [])];

    list.sort(compareStudentsForList);

    return list.filter((s) => {
      const matchesSearch =
        s.name.toLowerCase().includes(studentSearchQuery.toLowerCase()) ||
        s.rollNo.toLowerCase().includes(studentSearchQuery.toLowerCase());
      const matchesGender = genderFilter === 'All' || s.gender === genderFilter;
      // Fee status is display-only. "Unpaid" covers every student who is not fully paid (Unpaid or Partial).
      const matchesFee =
        feeFilter === 'All' ||
        (feeFilter === 'Paid' ? s.feeStatus === 'Paid' : s.feeStatus !== 'Paid');
      return matchesSearch && matchesGender && matchesFee;
    });
  }, [currentClass, studentSearchQuery, genderFilter, feeFilter]);

  const totalPages = Math.ceil(sortedAndFilteredStudents.length / ITEMS_PER_PAGE) || 1;
  const paginatedStudents = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return sortedAndFilteredStudents.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [sortedAndFilteredStudents, currentPage]);

  // Keep the page inside range when the roster shrinks (e.g. last student of a page deleted)
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // CREATE CLASS FUNCTION
  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!classNameInput.trim() || !classCodeInput.trim()) return;

    const session = requireSession();
    if (!session) return;
    if (!beginOperation('create-class')) return;

    try {
      assertOnline();
      await createClassForTenant(session.tenantId, {
        name: classNameInput,
        code: classCodeInput,
        monthlyFee: monthlyFeeInput
      });
      if (!isSessionCurrent(session)) return;

      setClassNameInput('');
      setClassCodeInput('');
      setMonthlyFeeInput('');
      setIsCreateClassOpen(false);
      showCenterNotification('success', 'Class Created!', 'New academic class added successfully.');
    } catch (error) {
      console.error("Error creating class:", error);
      if (isSessionCurrent(session)) notifyFailure('Could Not Create Class', error);
    } finally {
      endOperation('create-class');
    }
  };

  const handleOpenEditClass = (cls: ClassItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingClass(cls);
    setEditClassNameInput(cls.name);
    setEditClassCodeInput(cls.code);
    setEditMonthlyFeeInput(cls.monthlyFee || '5000');
  };

  const handleSaveEditClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingClass) return;

    const session = requireSession();
    if (!session) return;
    if (!requireAccessibleClass(editingClass.id)) return;

    const opKey = `edit-class:${editingClass.id}`;
    if (!beginOperation(opKey)) return;

    try {
      assertOnline();
      await updateClassForTenant(session.tenantId, editingClass.id, {
        name: editClassNameInput,
        code: editClassCodeInput,
        monthlyFee: editMonthlyFeeInput
      });
      if (!isSessionCurrent(session)) return;

      setEditingClass(null);
      showCenterNotification('success', 'Class Updated!', `${editClassNameInput.trim()} details updated.`);
    } catch (error) {
      console.error("Error updating class:", error);
      if (isSessionCurrent(session)) notifyFailure('Could Not Update Class', error);
    } finally {
      endOperation(opKey);
    }
  };

  const handleConfirmDeleteClass = async () => {
    if (!deleteConfirmClass) return;

    const session = requireSession();
    if (!session) return;
    if (!requireAccessibleClass(deleteConfirmClass.id)) return;

    const targetClass = deleteConfirmClass;
    const opKey = `delete-class:${targetClass.id}`;
    if (!beginOperation(opKey)) return;

    try {
      assertOnline();
      await deleteClassForTenant(session.tenantId, targetClass.id);
      if (!isSessionCurrent(session)) return;

      const deletedClassName = targetClass.name;
      setDeleteConfirmClass(null);
      if (activeClassId === targetClass.id) setActiveClassId(null);
      showCenterNotification('delete', 'Class Deleted', `${deletedClassName} removed from records.`);
    } catch (error) {
      console.error("Error deleting class:", error);
      if (isSessionCurrent(session)) notifyFailure('Could Not Delete Class', error);
    } finally {
      endOperation(opKey);
    }
  };

  const handleOpenAddStudent = (classId?: string) => {
    let targetClass = currentClass;
    if (classId) {
      handleSelectClass(classId);
      targetClass = classList.find((c) => c.id === classId) || null;
    }

    setEditingStudent(null);
    setFullName('');
    setFatherName('');
    setWhatsapp('+92 ');
    currentGuardianPhoneRef.current = '+92 ';
    setGuardianWhatsAppCheckStatus('idle');
    setGuardianWhatsAppCheckNumber('');
    setGuardianWhatsAppCheckMessage('');
    setAttendanceWhatsAppOptIn(false);
    setMonthlyReportWhatsAppOptIn(false);
    setQuizResultsWhatsAppOptIn(false);
    setFeeAlertsWhatsAppOptIn(false);
    setAnnouncementWhatsAppOptIn(false);
    setLibraryLinkWhatsAppOptIn(false);
    setGender('Male');
    setStudentAvatar('');
    setStudentFeeInput(targetClass?.monthlyFee || '5000');

    const existingRolls = (targetClass?.students || [])
      .map((s) => parseInt(s.rollNo, 10))
      .filter((num) => !isNaN(num));

    if (existingRolls.length > 0) {
      const maxRoll = Math.max(...existingRolls);
      setRollNo(String(maxRoll + 1));
    } else {
      setRollNo('1');
    }

    setIsAddStudentOpen(true);
  };

  const handleOpenEditStudent = (student: Student) => {
    setEditingStudent(student);
    setFullName(student.name);
    setFatherName(student.fatherName);
    setWhatsapp(formatPakPhone(student.phone || ''));
    currentGuardianPhoneRef.current = formatPakPhone(student.phone || '');
    setGuardianWhatsAppCheckStatus('idle');
    setGuardianWhatsAppCheckNumber('');
    setGuardianWhatsAppCheckMessage('');
    setAttendanceWhatsAppOptIn(
      student.attendanceWhatsAppOptIn === true &&
      Boolean(String(student.attendanceWhatsAppOptInAt ?? '').trim()) &&
      formatPakPhone(student.attendanceWhatsAppOptInPhone || '') === formatPakPhone(student.phone || '')
    );
    setMonthlyReportWhatsAppOptIn(
      student.parentWhatsAppOptIn === true &&
      Boolean(String(student.parentWhatsAppOptInAt ?? '').trim()) &&
      formatPakPhone(student.parentWhatsAppOptInPhone || '') === formatPakPhone(student.phone || '')
    );
    setQuizResultsWhatsAppOptIn(
      student.quizResultsWhatsAppOptIn === true &&
      Boolean(String(student.quizResultsWhatsAppOptInAt ?? '').trim()) &&
      formatPakPhone(student.quizResultsWhatsAppOptInPhone || '') === formatPakPhone(student.phone || '')
    );
    setFeeAlertsWhatsAppOptIn(
      student.feeAlertsWhatsAppOptIn === true &&
      Boolean(String(student.feeAlertsWhatsAppOptInAt ?? '').trim()) &&
      formatPakPhone(student.feeAlertsWhatsAppOptInPhone || '') === formatPakPhone(student.phone || '')
    );
    setAnnouncementWhatsAppOptIn(
      student.announcementWhatsAppOptIn === true &&
      Boolean(String(student.announcementWhatsAppOptInAt ?? '').trim()) &&
      formatPakPhone(student.announcementWhatsAppOptInPhone || '') === formatPakPhone(student.phone || '')
    );
    setLibraryLinkWhatsAppOptIn(
      student.libraryLinkWhatsAppOptIn === true &&
      Boolean(String(student.libraryLinkWhatsAppOptInAt ?? '').trim()) &&
      formatPakPhone(student.libraryLinkWhatsAppOptInPhone || '') === formatPakPhone(student.phone || '')
    );
    setRollNo(student.rollNo);
    setGender(student.gender || 'Male');
    setStudentAvatar(student.avatar || '');
    setStudentFeeInput(student.studentFee || currentClass?.monthlyFee || '5000');
    setIsAddStudentOpen(true);
  };

  const handleConfirmDeleteStudent = async () => {
    if (!deleteConfirmStudent || !activeClassId || !currentClass) return;

    const session = requireSession();
    if (!session) return;
    if (!requireAccessibleClass(activeClassId)) return;

    const targetStudent = deleteConfirmStudent;
    const classId = activeClassId;
    const opKey = `delete-student:${classId}:${String(getStudentIdentifier(targetStudent) ?? targetStudent._sourceKey)}`;
    if (!beginOperation(opKey)) return;

    try {
      assertOnline();
      // Reads the freshest class document and removes ONLY the matched student (no stale overwrite)
      await removeStudentFromClass(session.tenantId, classId, targetStudent);
      if (!isSessionCurrent(session)) return;

      const deletedName = targetStudent.name;
      setDeleteConfirmStudent(null);
      showCenterNotification('delete', 'Student Removed', `${deletedName} deleted successfully.`);
    } catch (error) {
      console.error("Error deleting student:", error);
      if (isSessionCurrent(session)) notifyFailure('Could Not Remove Student', error);
    } finally {
      endOperation(opKey);
    }
  };

  const handleSaveStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeClassId || !fullName.trim() || !rollNo.trim() || !currentClass) return;
    if (!isWhatsappComplete) return;

    const session = requireSession();
    if (!session) return;
    if (!requireAccessibleClass(activeClassId)) return;

    const classId = activeClassId;
    const opKey = `save-student:${classId}`;
    if (!beginOperation(opKey)) return;

    try {
      assertOnline();

      const values: StudentFormValues = {
        name: fullName,
        fatherName,
        phone: whatsapp,
        attendanceWhatsAppOptIn,
        monthlyReportWhatsAppOptIn,
        quizResultsWhatsAppOptIn,
        feeAlertsWhatsAppOptIn,
        announcementWhatsAppOptIn,
        libraryLinkWhatsAppOptIn,
        rollNo,
        gender,
        studentFee: studentFeeInput,
        avatar: studentAvatar
      };

      const isEditMode = !!editingStudent;
      const studentBeingEdited = editingStudent;
      const classMonthlyFee = currentClass.monthlyFee || '5000';

      // Each call reads the freshest class document inside a transaction and writes only the intended
      // change, so a stale local copy can never overwrite other students or newer fee status updates.
      if (studentBeingEdited) {
        await updateStudentInClass(session.tenantId, classId, studentBeingEdited, values, {
          classMonthlyFee,
          originalAvatar: studentBeingEdited.avatar || ''
        });
      } else {
        await addStudentToClass(session.tenantId, classId, values, {
          classMonthlyFee,
          baseId: Date.now()
        });
      }

      if (!isSessionCurrent(session)) return;

      const savedName = fullName.trim();
      setIsAddStudentOpen(false);
      setEditingStudent(null);

      showCenterNotification(
        'success',
        isEditMode ? 'Student Updated!' : 'Student Saved!',
        isEditMode ? `${savedName}'s details updated.` : `${savedName} registered successfully.`
      );
    } catch (error) {
      console.error("Error saving student:", error);
      if (isSessionCurrent(session)) notifyFailure('Could Not Save Student', error);
    } finally {
      endOperation(opKey);
    }
  };

  // ----------------------------------------------------------------------
  // EXCEL / CSV BULK STUDENT IMPORT — LOGIC
  // Reuses formatPakPhone, getDefaultAvatar, addStudentToClass, StudentFormValues and the
  // existing tenant/class-accessibility guards. Nothing here writes to Firestore directly;
  // every write goes through addStudentToClass's own transaction, exactly like the manual form.
  // ----------------------------------------------------------------------

  const STUDENT_COLUMN_LABELS = STUDENT_IMPORT_FIELD_LABELS as Record<keyof StudentColumnMap, string>;
  const REQUIRED_STUDENT_COLUMNS = STUDENT_IMPORT_REQUIRED_KEYS as (keyof StudentColumnMap)[];
  const autoDetectColumnMap = (headers: string[]): StudentColumnMap => autoDetectStudentColumnMap(headers);

  // Gender normalization specific to the import pipeline: unrecognized or blank values are
  // rejected rather than silently defaulted, unlike the read-only display normalizer above.
  const normalizeGenderForImport = (value: unknown): 'Male' | 'Female' | '' => {
    const v = String(value ?? '').trim().toLowerCase();
    if (v === 'male' || v === 'm') return 'Male';
    if (v === 'female' || v === 'f') return 'Female';
    return '';
  };

  // Validates + normalizes a monthly fee cell. Returns '' (invalid) rather than throwing, so the
  // caller can attach a row-level reason.
  const normalizeFeeForImport = (value: unknown): string => {
    const raw = String(value ?? '').trim();
    if (raw === '') return '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return '';
    return raw;
  };

  // Mirrors the Add/Edit Student form's phone validation (+92 and exactly 10 digits after it),
  // deliberately NOT the worldwide Import Clients normalizer.
  const normalizePakPhoneForImport = (value: unknown): { formatted: string; isComplete: boolean } => {
    const formatted = formatPakPhone(String(value ?? ''));
    const digits = formatted.replace(/\D/g, '').replace(/^92/, '');
    return { formatted, isComplete: digits.length === 10 };
  };

  const parseConsentForImport = (value: unknown): boolean => parseStudentConsent(value);

  const isUsableImageUrl = (value: unknown): boolean => {
    const v = String(value ?? '').trim();
    return /^https?:\/\/.+/i.test(v);
  };

  const handleExcelDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setExcelDragActive(true);
    else if (e.type === 'dragleave') setExcelDragActive(false);
  };

  const handleExcelDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExcelDragActive(false);
    if (!activeClassId) return;
    if (e.dataTransfer.files && e.dataTransfer.files[0]) processExcelFile(e.dataTransfer.files[0]);
  };

  const handleExcelFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) processExcelFile(e.target.files[0]);
  };

  const processExcelFile = (file: File) => {
    if (!activeClassId || !currentClass) {
      setExcelImportError('Open a class first. Students can only be imported into a currently selected class.');
      return;
    }

    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      setExcelImportError('Unsupported file type. Please upload a .xlsx, .xls, or .csv file.');
      showCenterNotification('error', 'Invalid File', 'Please upload an Excel (.xlsx, .xls) or .csv file.');
      return;
    }

    resetExcelImportState();
    setImportPreviewClassId(activeClassId);
    setExcelSelectedFileName(file.name);
    setExcelParsing(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setExcelParsing(false);
      setExcelImportError('Could not read the selected file.');
      showCenterNotification('error', 'File Read Error', 'Could not read the selected file.');
    };
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array', raw: false });

        if (!workbook.SheetNames.length) {
          setExcelParsing(false);
          setExcelImportError('This workbook has no worksheets.');
          return;
        }

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });

        if (jsonRows.length === 0) {
          setExcelParsing(false);
          setExcelImportError('The sheet contains no student rows.');
          showCenterNotification('error', 'Empty File', 'The sheet contains no data.');
          return;
        }

        const headers = Object.keys(jsonRows[0]);
        if (headers.length === 0) {
          setExcelParsing(false);
          setExcelImportError('No column headers were found in the first row.');
          return;
        }

        setExcelHeaders(headers);

        const rawData: ParsedExcelRow[] = jsonRows.map((data, index) => ({
          rowIndex: index + 1,
          data
        }));
        setExcelRawRows(rawData);

        const autoMap = autoDetectColumnMap(headers);
        const missingRequired = REQUIRED_STUDENT_COLUMNS.filter((field) => !autoMap[field]);
        setStudentColumnMap(autoMap);
        setNeedsColumnMapping(missingRequired.length > 0);

        if (missingRequired.length === 0) {
          runStudentRowProcessing(rawData, autoMap, activeClassId);
        }

        setStudentImportPage(1);
        setExcelParsing(false);
      } catch (err) {
        console.error('Excel parse error:', err);
        setExcelParsing(false);
        setExcelImportError('Failed to parse this file. It may be corrupted or malformed.');
        showCenterNotification('error', 'Parse Error', 'Failed to parse file contents.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleStudentColumnMapChange = (field: keyof StudentColumnMap, header: string) => {
    const updatedMap = { ...studentColumnMap, [field]: header };
    setStudentColumnMap(updatedMap);
    setOpenMappingField(null);

    const missingRequired = REQUIRED_STUDENT_COLUMNS.filter((f) => !updatedMap[f]);
    setNeedsColumnMapping(missingRequired.length > 0);

    if (missingRequired.length === 0 && excelRawRows.length > 0 && activeClassId) {
      runStudentRowProcessing(excelRawRows, updatedMap, activeClassId);
    }
  };

  // PURE validation + duplicate detection pass over the parsed spreadsheet rows, run against the
  // destination class's CURRENT roster. Re-run automatically whenever the mapping changes.
  const runStudentRowProcessing = (rows: ParsedExcelRow[], map: StudentColumnMap, targetClassId: string) => {
    const targetClass = classListRef.current.find((c) => c.id === targetClassId) || currentClass;
    const existingRolls = new Set((targetClass?.students || []).map((s) => String(s.rollNo ?? '').trim().toLowerCase()));
    const seenInFile = new Set<string>();

    const processed: ProcessedStudentRow[] = rows.map((r, idx) => {
      const name = String(r.data[map.name] ?? '').trim();
      const fatherNameVal = String(r.data[map.fatherName] ?? '').trim();
      const phoneRaw = String(r.data[map.phone] ?? '').trim();
      const rollNoVal = String(r.data[map.rollNo] ?? '').trim();
      const genderRaw = r.data[map.gender];
      const feeRaw = String(r.data[map.fee] ?? '').trim();
      const consentRawValues = {} as Record<StudentConsentColumnKey, string>;
      const consents = {} as Record<StudentConsentColumnKey, boolean>;
      STUDENT_CONSENT_COLUMNS.forEach((column) => {
        const mappedHeader = map[column.key as StudentConsentColumnKey];
        const rawConsent = mappedHeader ? String(r.data[mappedHeader] ?? '').trim() : '';
        consentRawValues[column.key as StudentConsentColumnKey] = rawConsent;
        consents[column.key as StudentConsentColumnKey] = parseConsentForImport(rawConsent);
      });
      const photoRaw = map.photo ? String(r.data[map.photo] ?? '').trim() : '';

      const genderNormalized = normalizeGenderForImport(genderRaw);
      const feeNormalized = normalizeFeeForImport(feeRaw);
      const { formatted: phoneFormatted, isComplete: phoneComplete } = normalizePakPhoneForImport(phoneRaw);
      const rollKey = rollNoVal.toLowerCase();

      let status: ImportRowStatus = 'valid';
      let errorReason = '';

      if (!name) {
        status = 'invalid';
        errorReason = 'Student name is required.';
      } else if (!fatherNameVal) {
        status = 'invalid';
        errorReason = "Father's name is missing.";
      } else if (!rollNoVal) {
        status = 'invalid';
        errorReason = 'Roll number is required.';
      } else if (!genderNormalized) {
        status = 'invalid';
        errorReason = 'Gender must be Male or Female.';
      } else if (!phoneRaw || !phoneComplete) {
        status = 'invalid';
        errorReason = 'WhatsApp number is invalid or incomplete (needs 10 digits after +92).';
      } else if (feeRaw === '' || feeNormalized === '') {
        status = 'invalid';
        errorReason = 'Monthly fee must be a valid non-negative number.';
      } else if (seenInFile.has(rollKey)) {
        status = 'duplicate';
        errorReason = 'Duplicate roll number within this file.';
      } else if (existingRolls.has(rollKey)) {
        status = 'duplicate';
        errorReason = 'Roll number is already used in this class.';
      }

      if (status !== 'invalid' && rollKey) {
        seenInFile.add(rollKey);
      }

      let avatar = '';
      if (isUsableImageUrl(photoRaw)) {
        avatar = photoRaw;
      } else {
        avatar = getDefaultAvatar(genderNormalized || 'Male');
      }

      return {
        id: `excel_row_${r.rowIndex}_${idx}`,
        rowIndex: r.rowIndex,
        name,
        fatherName: fatherNameVal,
        phoneRaw,
        phoneFormatted,
        rollNo: rollNoVal,
        gender: genderNormalized,
        feeRaw,
        feeNormalized,
        consentRawValues,
        consents,
        photoUrl: photoRaw,
        avatar,
        status,
        errorReason: errorReason || undefined
      };
    });

    setProcessedStudentRows(processed);
    setStudentImportSummary(null);
  };

  const handleVerifyBulkWhatsAppNumbers = async () => {
    if (isBulkWhatsAppChecking || processedStudentRows.length === 0) return;
    const user = auth.currentUser;
    if (!user) {
      showCenterNotification('error', 'Sign-In Required', 'Sign in again before verifying imported guardian numbers.');
      return;
    }
    const validRows = processedStudentRows.filter((row) => normalizePakPhoneForImport(row.phoneRaw).isComplete);
    const uniqueNumbers = [...new Set(validRows.map((row) => row.phoneFormatted.replace(/\D/g, '')).filter(Boolean))];
    const resultMap = new Map<string, 'registered' | 'not_registered' | 'verification_failed'>();
    setIsBulkWhatsAppChecking(true);
    try {
      const token = await user.getIdToken();
      for (let index = 0; index < uniqueNumbers.length; index += 50) {
        const batch = uniqueNumbers.slice(index, index + 50);
        try {
          const response = await fetch('/api/teacher/whatsapp-number-verification/check', {
            method: 'POST', cache: 'no-store',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ numbers: batch }),
          });
          const payload = await response.json().catch(() => ({})) as { success?: boolean; results?: Array<{ number?: string; status?: string }>; error?: string };
          if (!response.ok || payload.success !== true || !Array.isArray(payload.results)) throw new Error(payload.error || 'Batch verification failed.');
          for (const item of payload.results) {
            const number = String(item.number || '').replace(/\D/g, '');
            if (!number || !batch.includes(number)) continue;
            resultMap.set(number, item.status === 'registered' ? 'registered' : item.status === 'not_registered' ? 'not_registered' : 'verification_failed');
          }
          for (const number of batch) if (!resultMap.has(number)) resultMap.set(number, 'verification_failed');
        } catch {
          for (const number of batch) resultMap.set(number, 'verification_failed');
        }
      }
      setProcessedStudentRows((rows) => rows.map((row) => {
        const normalized = normalizePakPhoneForImport(row.phoneRaw);
        if (!normalized.isComplete) return { ...row, whatsappVerificationStatus: 'invalid' };
        const number = row.phoneFormatted.replace(/\D/g, '');
        return { ...row, whatsappVerificationStatus: resultMap.get(number) || 'verification_failed' };
      }));
      const registered = [...resultMap.values()].filter((value) => value === 'registered').length;
      const notRegistered = [...resultMap.values()].filter((value) => value === 'not_registered').length;
      const failed = [...resultMap.values()].filter((value) => value === 'verification_failed').length;
      showCenterNotification('success', 'WhatsApp Check Complete', `${registered} registered, ${notRegistered} not registered, ${failed} verification failed. Import rules were not changed.`);
    } catch (cause) {
      showCenterNotification('error', 'Verification Failed', cause instanceof Error ? cause.message : 'WhatsApp number verification failed.');
    } finally {
      setIsBulkWhatsAppChecking(false);
    }
  };

  const studentImportStats = useMemo(() => {
    const total = processedStudentRows.length;
    const valid = processedStudentRows.filter((r) => r.status === 'valid').length;
    const invalid = processedStudentRows.filter((r) => r.status === 'invalid').length;
    const duplicate = processedStudentRows.filter((r) => r.status === 'duplicate').length;
    return { total, valid, invalid, duplicate };
  }, [processedStudentRows]);

  const filteredStudentImportRows = useMemo(() => {
    if (studentImportFilter === 'all') return processedStudentRows;
    return processedStudentRows.filter((r) => r.status === studentImportFilter);
  }, [processedStudentRows, studentImportFilter]);

  const studentImportTotalPages = Math.ceil(filteredStudentImportRows.length / STUDENT_IMPORT_PAGE_SIZE) || 1;
  const paginatedStudentImportRows = useMemo(() => {
    const start = (studentImportPage - 1) * STUDENT_IMPORT_PAGE_SIZE;
    return filteredStudentImportRows.slice(start, start + STUDENT_IMPORT_PAGE_SIZE);
  }, [filteredStudentImportRows, studentImportPage]);

  const handleCancelExcelImport = () => {
    resetExcelImportState();
  };

  // Downloads a real, correctly formatted .xlsx workbook with a data-entry template plus an
  // Instructions sheet. Uses the same `xlsx` package/approach as the Import Clients page.
  const handleDownloadStudentTemplate = () => {
    if (entitlementLoading) return;
    if (!entitlement?.active) {
      showCenterNotification('error', 'Academy access unavailable', 'Your Academy membership permissions could not be verified. Refresh the page or contact your Academy Admin.');
      return;
    }
    downloadStudentImportWorkbook(canAccessFeature, 'EduTrack_Students_Import_Template.xlsx');
  };

  // Downloads the invalid/duplicate rows as a CSV, each with an Import Error column, so the
  // teacher can fix and re-upload just the problem rows.
  const handleDownloadFailedStudentRows = () => {
    const problemRows = processedStudentRows.filter((r) => r.status !== 'valid' || r.saveStatus === 'failed');
    if (problemRows.length === 0) return;

    const header = ['Row', 'Student Name', "Father's Name", 'WhatsApp', 'Roll Number', 'Gender', 'Monthly Fee', ...STUDENT_CONSENT_COLUMNS.map((column) => column.label), 'Import Error'];
    const escapeCsv = (val: unknown) => {
      const s = String(val ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    problemRows.forEach((r) => {
      const reason = r.saveStatus === 'failed' ? (r.saveError || 'Failed to save this student because of a Firestore error.') : (r.errorReason || '');
      lines.push([
        r.rowIndex,
        r.name,
        r.fatherName,
        r.phoneRaw,
        r.rollNo,
        r.gender || '',
        r.feeRaw,
        ...STUDENT_CONSENT_COLUMNS.map((column) => r.consentRawValues[column.key as StudentConsentColumnKey] ?? ''),
        reason
      ].map(escapeCsv).join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'EduTrack_Import_Issues.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Imports every row currently marked "valid", one at a time, through the existing
  // addStudentToClass transaction — which revalidates roll-number conflicts against the freshest
  // class document, exactly as a manually added student would be. A bad row never blocks the rest.
  const handleExecuteStudentImport = async () => {
    if (!activeClassId || !currentClass) {
      showCenterNotification('error', 'No Class Selected', 'Open a class first, then import students.');
      return;
    }
    if (importPreviewClassId !== activeClassId) {
      showCenterNotification('error', 'Class Changed', 'This preview was prepared for a different class. Please re-upload the file.');
      return;
    }

    const session = requireSession();
    if (!session) return;
    if (!requireAccessibleClass(activeClassId)) return;

    const classId = activeClassId;
    const opKey = `excel-import:${classId}`;
    if (!beginOperation(opKey)) return;

    const targetRows = processedStudentRows.filter((r) => r.status === 'valid');
    if (targetRows.length === 0) {
      showCenterNotification('error', 'No Valid Records', 'There are no valid student records available to import.');
      endOperation(opKey);
      return;
    }

    setIsImportingStudents(true);
    setStudentImportProgress(0);

    let imported = 0;
    let failed = 0;
    const ignoredConsentColumns = new Set<string>();
    const classMonthlyFee = currentClass.monthlyFee || '5000';
    const updatedRows = [...processedStudentRows];

    try {
      assertOnline();
      const latestEntitlement = await refreshEntitlement();
      if (!latestEntitlement?.active) {
        throw new StudentOpError('ACADEMY_ACCESS_UNAVAILABLE', 'Your Academy membership could not be verified. No students were imported.');
      }
      getIgnoredStudentConsentColumnLabels(studentColumnMap, latestEntitlement.featurePermissions)
        .forEach((label) => ignoredConsentColumns.add(label));
      for (let i = 0; i < targetRows.length; i++) {
        const row = targetRows[i];
        const values: StudentFormValues = {
          name: row.name,
          fatherName: row.fatherName,
          phone: row.phoneFormatted,
          rollNo: row.rollNo,
          gender: row.gender as 'Male' | 'Female',
          studentFee: row.feeNormalized,
          avatar: row.avatar,
          ...getStudentConsentFormValues(row.consents, latestEntitlement.featurePermissions),
        };

        try {
          const saveResult = await addStudentToClass(session.tenantId, classId, values, {
            classMonthlyFee,
            baseId: Date.now() + i
          });
          saveResult.ignoredConsentFeatures.forEach((permissionKey) => {
            const ignoredColumn = STUDENT_CONSENT_COLUMNS.find((column) => column.permissionKey === permissionKey);
            if (ignoredColumn) ignoredConsentColumns.add(ignoredColumn.label);
          });
          imported++;
          const idx = updatedRows.findIndex((r) => r.id === row.id);
          if (idx !== -1) updatedRows[idx] = { ...updatedRows[idx], saveStatus: 'success' };
        } catch (rowError) {
          console.error('Row import failed:', row.rowIndex, rowError);
          failed++;
          const idx = updatedRows.findIndex((r) => r.id === row.id);
          if (idx !== -1) {
            updatedRows[idx] = {
              ...updatedRows[idx],
              saveStatus: 'failed',
              saveError: getFriendlyErrorMessage(rowError)
            };
          }
        }

        if (!isSessionCurrent(session)) break;
        setStudentImportProgress(Math.round(((i + 1) / targetRows.length) * 100));
      }

      setProcessedStudentRows(updatedRows);

      const summary: StudentImportSummary = {
        imported,
        skippedInvalid: studentImportStats.invalid,
        skippedDuplicate: studentImportStats.duplicate,
        failed,
        ignoredConsentColumns: [...ignoredConsentColumns].sort()
      };
      setStudentImportSummary(summary);

      if (isSessionCurrent(session)) {
        if (failed === 0) {
          showCenterNotification(
            'success',
            'Import Complete',
            `${imported} student${imported === 1 ? '' : 's'} imported into ${currentClass.name}.`
          );
        } else {
          showCenterNotification(
            'error',
            'Partially Imported',
            `${imported} imported, ${failed} failed. Review the Import Issues list below.`
          );
        }
      }
    } catch (error) {
      console.error('Bulk student import failed:', error);
      if (isSessionCurrent(session)) notifyFailure('Import Failed', error);
    } finally {
      setIsImportingStudents(false);
      endOperation(opKey);
    }
  };

  const navigationTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/' },
    { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/departments' },
    { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
    { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
    { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
  ];

  if (authLoading || tenant.status === 'resolving') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] dark:bg-[#070b13]">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500 drop-shadow-[0_0_12px_rgba(249,115,22,0.6)]" />
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-28 ${isDark ? 'dark' : ''}`}>

      {/* TOP NAVBAR */}
      <div className="w-full bg-white/60 dark:bg-[#070b13]/60 backdrop-blur-md border-b border-slate-200/60 dark:border-slate-800/80 sticky top-0 z-40 shadow-sm transition-all">
        <div className="mx-auto max-w-7xl flex h-14 items-center justify-between px-3 sm:px-6 lg:px-8 gap-2">

          <div className="flex items-center gap-2 flex-1">
            <button
              onClick={() => {
                if (activeClassId) {
                  handleBackToClasses();
                } else {
                  navigate('/');
                }
              }}
              className="flex items-center justify-center h-9 w-9 rounded-xl bg-orange-500/10 hover:bg-orange-500 text-orange-600 dark:text-orange-400 hover:text-white transition-all shadow-[0_0_12px_rgba(249,115,22,0.25)] hover:shadow-[0_0_20px_rgba(249,115,22,0.5)] active:scale-95 shrink-0"
              title="Go Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            <div className="relative w-full max-w-[200px] sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={activeClassId ? "Search in class..." : "Search classes..."}
                value={activeClassId ? studentSearchQuery : searchQuery}
                onChange={(e) => activeClassId ? setStudentSearchQuery(e.target.value) : setSearchQuery(e.target.value)}
                className="w-full rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-[#0c1222]/80 py-1.5 pl-9 pr-3 text-xs font-bold outline-none transition-all focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:focus:ring-orange-500/30 text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/80 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/40 dark:border-slate-700/50 hover:shadow-[0_0_12px_rgba(249,115,22,0.2)]"
            >
              <div className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-md transition-all ${isDark ? 'translate-x-5 bg-slate-950 text-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.5)]' : ''}`}>
                {isDark ? <Moon className="h-3 w-3 fill-current" /> : <Sun className="h-3 w-3 fill-current" />}
              </div>
            </button>

            <Link
              to="/alerts"
              className="relative rounded-xl p-2 text-slate-500 hover:bg-orange-500/10 dark:text-slate-400 dark:hover:bg-[#0c1222] transition-all hover:shadow-[0_0_15px_rgba(249,115,22,0.3)] active:scale-95 flex items-center justify-center"
              title="Notifications"
            >
              <Bell className="h-4 w-4" />
              <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-orange-500 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#070b13] animate-pulse shadow-[0_0_8px_rgba(249,115,22,0.8)]">
                3
              </span>
            </Link>
          </div>
        </div>
      </div>

      {/* MAIN VIEW SYSTEM */}
      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-6 lg:px-8 space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">

        {/* VIEW 1: MAIN CLASSES DIRECTORY */}
        {!activeClassId && (
          <>
            {/* HERO CARD */}
            <div className="relative overflow-hidden rounded-[2.5rem] bg-gradient-to-br from-white via-orange-50/40 to-amber-50/20 dark:from-[#0c1222] dark:via-[#0c1222]/90 dark:to-[#070b13] p-6 sm:p-8 border-2 border-orange-500/40 dark:border-orange-500/50 shadow-[0_0_35px_rgba(249,115,22,0.25)] hover:shadow-[0_0_55px_rgba(249,115,22,0.45)] transition-all duration-500 group">

              <div className="absolute -top-12 -right-12 h-44 w-44 rounded-full bg-orange-500/25 blur-3xl animate-pulse pointer-events-none" />
              <div className="absolute -bottom-12 -left-12 h-44 w-44 rounded-full bg-amber-500/20 blur-3xl animate-pulse pointer-events-none delay-700" />

              <div className="relative z-10 space-y-5">

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400 shadow-[0_0_15px_rgba(249,115,22,0.3)] backdrop-blur-md">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-orange-500"></span>
                    </span>
                    <span className="text-[11px] font-black uppercase tracking-wider">LIVE ENGINE ACTIVE</span>
                  </div>

                  <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-extrabold text-xs shadow-[0_0_12px_rgba(245,158,11,0.2)]">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500 animate-spin" />
                    <span>Total {classList.length} Active Classes Fetched</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-950 dark:text-white drop-shadow-sm flex items-center gap-3">
                    EduTrack
                  </h1>
                  <p className="text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300 max-w-xl leading-relaxed">
                    Intelligent Management & Analytics System for Colleges and Universities.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Button
                    onClick={() => setIsCreateClassOpen(true)}
                    className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white rounded-2xl font-black text-xs px-5 py-3 shadow-[0_0_20px_rgba(249,115,22,0.4)] hover:shadow-[0_0_30px_rgba(249,115,22,0.6)] transition-all active:scale-95 flex items-center gap-2"
                  >
                    <Plus className="h-4 w-4" /> Create New Class
                  </Button>
                </div>

              </div>
            </div>

            {/* CLASS CARDS GRID */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredClasses.map((cls) => (
                <div
                  key={cls.id}
                  className="bg-white/90 dark:bg-[#0c1222]/90 border border-slate-200/80 dark:border-slate-800/80 rounded-3xl p-5 shadow-sm hover:shadow-[0_0_25px_rgba(249,115,22,0.22)] dark:hover:shadow-[0_0_30px_rgba(249,115,22,0.3)] dark:hover:border-orange-500/40 transition-all duration-300 hover:-translate-y-1 space-y-4 group relative backdrop-blur-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div
                      onClick={() => handleSelectClass(cls.id)}
                      className="cursor-pointer flex items-center gap-3 flex-1 min-w-0"
                    >
                      <div className="h-11 w-11 rounded-2xl bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center font-black shrink-0 border border-orange-500/20 shadow-[0_0_12px_rgba(249,115,22,0.15)] group-hover:scale-105 transition-transform">
                        <BookOpen className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-black text-slate-900 dark:text-slate-100 group-hover:text-orange-500 transition-colors truncate">
                          {cls.name}
                        </h3>
                        <span className="text-[10px] font-extrabold text-slate-400 bg-slate-100 dark:bg-slate-900 px-2 py-0.5 rounded-md inline-block mt-1 border border-slate-200 dark:border-slate-800">
                          Code: {cls.code}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => handleOpenEditClass(cls, e)}
                        className="p-1.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 hover:shadow-[0_0_12px_rgba(16,185,129,0.4)] transition-all active:scale-95"
                        title="Edit Class"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirmClass(cls);
                        }}
                        className="p-1.5 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 hover:shadow-[0_0_12px_rgba(244,63,94,0.4)] transition-all active:scale-95"
                        title="Delete Class"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/60">
                    <div className="bg-slate-50 dark:bg-[#070b13] p-2.5 rounded-2xl text-center border border-slate-100 dark:border-slate-800/40">
                      <span className="text-[9px] font-extrabold uppercase text-slate-400 block">Enrolled</span>
                      <span className="text-sm font-black text-slate-800 dark:text-slate-200 flex items-center justify-center gap-1 mt-0.5">
                        <Users className="h-3.5 w-3.5 text-orange-500" /> {(cls.students || []).length}
                      </span>
                    </div>
                    <div className="bg-slate-50 dark:bg-[#070b13] p-2.5 rounded-2xl text-center border border-slate-100 dark:border-slate-800/40">
                      <span className="text-[9px] font-extrabold uppercase text-slate-400 block">Monthly Fee</span>
                      <span className="text-xs font-black text-emerald-600 dark:text-emerald-400 mt-1 block drop-shadow-[0_0_8px_rgba(16,185,129,0.2)]">
                        PKR {safeNumber(cls.monthlyFee || 0).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => handleOpenAddStudent(cls.id)}
                      className="flex-1 py-2.5 px-3 rounded-2xl bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 dark:text-orange-400 font-extrabold text-xs transition-all flex items-center justify-center gap-1.5 border border-orange-500/20 hover:shadow-[0_0_15px_rgba(249,115,22,0.25)] active:scale-95"
                    >
                      <UserPlus className="h-3.5 w-3.5" /> Add Student
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* VIEW 2: CLASS DETAIL PAGE */}
        {activeClassId && currentClass && (
          <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200 max-w-4xl mx-auto">

            <div className="flex items-center justify-between">
              <button
                onClick={handleBackToClasses}
                className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-black text-lg hover:text-orange-500 transition-colors group"
              >
                <div className="p-1 rounded-xl group-hover:bg-orange-500/10 group-hover:text-orange-500">
                  <ChevronLeft className="h-6 w-6" />
                </div>
                <span>{currentClass.name}</span>
              </button>

              <button className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 transition-colors">
                <MoreVertical className="h-5 w-5" />
              </button>
            </div>

            {/* SEARCH + ADD BUTTON */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search student or roll..."
                  value={studentSearchQuery}
                  onChange={(e) => setStudentSearchQuery(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#0c1222] py-2.5 pl-9 pr-3 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <Button
                onClick={() => handleOpenAddStudent()}
                className="bg-orange-500 hover:bg-orange-600 text-white rounded-2xl font-black text-xs px-4 py-2.5 shadow-[0_0_15px_rgba(249,115,22,0.35)] shrink-0 active:scale-95 transition-all"
              >
                Add Student
              </Button>
            </div>

            {/* ===================================================================== */}
            {/* IMPORT STUDENTS — PREMIUM EXCEL/CSV BULK IMPORT SECTION               */}
            {/* ===================================================================== */}
            <div className="bg-white/90 dark:bg-[#0c1222]/90 border border-slate-200/80 dark:border-slate-800/80 rounded-[2rem] p-5 sm:p-6 shadow-sm space-y-5">

              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1.5 flex-1 min-w-[220px]">
                  <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                    <FolderInput className="h-5 w-5 text-orange-500" /> Import Students
                  </h3>
                  <p className="text-[11px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 leading-relaxed max-w-xl">
                    Import multiple students directly from Excel or CSV. Automatically validate student details, detect duplicate roll numbers, and review problematic records before importing.
                  </p>
                  <div className="inline-flex items-center gap-1.5 mt-1 px-3 py-1 rounded-full border border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-[10px] font-black">
                    <GraduationCap className="h-3 w-3" /> Importing students into: {currentClass.name}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (!activeClassId) { showCenterNotification('error', 'No Class Selected', 'Open an assigned class before importing students.'); return; }
                    excelImportInputRef.current?.click();
                  }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-black text-xs shadow-[0_0_20px_rgba(249,115,22,0.4)] hover:shadow-[0_0_30px_rgba(249,115,22,0.6)] transition-all active:scale-95"
                >
                  <Upload className="h-3.5 w-3.5" /> Choose File
                </button>
              </div>

              {/* HIDDEN FILE INPUT — SEPARATE FROM THE STUDENT PHOTO REF ABOVE */}
              <input
                type="file"
                ref={excelImportInputRef}
                onChange={handleExcelFileChange}
                accept=".xlsx,.xls,.csv"
                className="hidden"
              />

              {/* DROPZONE */}
              <div
                onDragEnter={handleExcelDrag}
                onDragLeave={handleExcelDrag}
                onDragOver={handleExcelDrag}
                onDrop={handleExcelDrop}
                onClick={() => excelImportInputRef.current?.click()}
                className={`border-2 border-dashed rounded-3xl p-6 sm:p-10 text-center cursor-pointer transition-all flex flex-col items-center justify-center space-y-3 ${
                  excelDragActive
                    ? 'border-orange-500 bg-orange-500/10'
                    : 'border-slate-300 dark:border-slate-800 hover:border-orange-500/50 hover:bg-orange-500/5'
                }`}
              >
                <div className="w-14 h-14 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center border border-orange-500/20">
                  {excelParsing ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : excelSelectedFileName ? (
                    <CheckCircle2 className="h-7 w-7 text-emerald-500" />
                  ) : (
                    <Upload className="h-7 w-7" />
                  )}
                </div>

                <div className="space-y-1">
                  <h4 className="text-xs sm:text-sm font-black text-slate-900 dark:text-white break-all">
                    {excelSelectedFileName ? excelSelectedFileName : 'Drag & Drop your Excel or CSV file here'}
                  </h4>
                  <p className="text-[10px] sm:text-xs font-bold text-slate-400">
                    Supports .xlsx, .xls, and .csv formats
                  </p>
                </div>

                <div className="flex flex-wrap gap-2.5 pt-1 justify-center">
                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!activeClassId) {
                        showCenterNotification('error', 'No Class Selected', 'Open a class first, then import students.');
                        return;
                      }
                      excelImportInputRef.current?.click();
                    }}
                    className="bg-orange-500 hover:bg-orange-600 text-white rounded-2xl font-black text-xs px-5 py-2.5 active:scale-95"
                  >
                    Browse Files
                  </Button>

                  <Button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownloadStudentTemplate();
                    }}
                    variant="outline"
                    disabled={entitlementLoading || entitlement?.active !== true}
                    className="border-orange-500/40 text-orange-600 dark:text-orange-400 hover:bg-orange-500/10 rounded-2xl font-black text-xs px-4 py-2.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {entitlementLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />} {entitlementLoading ? 'Loading Permissions...' : 'Download Template'}
                  </Button>
                </div>
              </div>

              {/* FILE-LEVEL ERROR (unsupported type / empty / unreadable) */}
              {excelImportError && (
                <div className="flex items-start gap-2 p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <p className="text-xs font-bold leading-relaxed">{excelImportError}</p>
                </div>
              )}

              {/* COLUMN MAPPING — shown whenever a required column couldn't be auto-detected */}
              {excelHeaders.length > 0 && needsColumnMapping && (
                <div className="bg-amber-500/5 border-2 border-amber-500/30 rounded-3xl p-5 space-y-4">
                  <div className="flex items-start gap-2">
                    <FileWarning className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-xs font-black text-amber-700 dark:text-amber-400">Column Mapping Needed</h4>
                      <p className="text-[11px] font-bold text-amber-600/90 dark:text-amber-400/80 mt-0.5">
                        We couldn't confidently match every required column. Please select the correct Excel column for each field below.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(Object.keys(STUDENT_COLUMN_LABELS) as (keyof StudentColumnMap)[]).map((field) => {
                      const isRequired = REQUIRED_STUDENT_COLUMNS.includes(field);
                      return (
                        <div key={field} className="space-y-1.5">
                          <label className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                            {STUDENT_COLUMN_LABELS[field]} {isRequired ? <span className="text-rose-500">*</span> : <span className="text-slate-400">(optional)</span>}
                          </label>
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setOpenMappingField(openMappingField === field ? null : field)}
                              className={`w-full flex items-center justify-between rounded-xl bg-white dark:bg-[#070b13] border-2 ${
                                !studentColumnMap[field] && isRequired ? 'border-rose-400' : 'border-slate-200 dark:border-slate-800'
                              } py-2.5 px-3.5 text-xs font-black text-slate-900 dark:text-white text-left`}
                            >
                              <span className="truncate">{studentColumnMap[field] || 'Select column...'}</span>
                              <ChevronDown className={`h-3.5 w-3.5 text-orange-500 shrink-0 transition-transform ${openMappingField === field ? 'rotate-180' : ''}`} />
                            </button>

                            {openMappingField === field && (
                              <div className="absolute top-full left-0 right-0 mt-1.5 z-30 bg-white dark:bg-[#0c1222] border-2 border-orange-500/40 rounded-2xl shadow-xl overflow-hidden py-1.5 max-h-44 overflow-y-auto">
                                {!isRequired && (
                                  <button
                                    type="button"
                                    onClick={() => handleStudentColumnMapChange(field, '')}
                                    className="w-full text-left px-4 py-2 text-[11px] font-bold text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                  >
                                    None
                                  </button>
                                )}
                                {excelHeaders.map((header) => (
                                  <button
                                    key={header}
                                    type="button"
                                    onClick={() => handleStudentColumnMapChange(field, header)}
                                    className={`w-full text-left px-4 py-2 text-[11px] font-black flex items-center justify-between ${
                                      studentColumnMap[field] === header
                                        ? 'bg-orange-500/10 text-orange-500'
                                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                                    }`}
                                  >
                                    <span className="truncate">{header}</span>
                                    {studentColumnMap[field] === header && <Check className="h-3 w-3 shrink-0" />}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* PREVIEW: STATS + FILTER TABS + TABLE */}
              {processedStudentRows.length > 0 && (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-900/60 dark:bg-blue-950/20">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-black text-slate-800 dark:text-slate-100">WhatsApp Number Verification</p>
                        <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Unique guardian numbers are checked in provider batches of up to 50. Verification does not alter import eligibility or notification consent.</p>
                      </div>
                      <Button type="button" variant="outline" disabled={isBulkWhatsAppChecking || isImportingStudents} onClick={() => void handleVerifyBulkWhatsAppNumbers()} className="rounded-xl text-[10px] font-black">
                        {isBulkWhatsAppChecking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                        {isBulkWhatsAppChecking ? 'Checking Numbers…' : 'Verify WhatsApp Numbers'}
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[9px] font-bold">
                      <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-600">Registered: {processedStudentRows.filter((row) => row.whatsappVerificationStatus === 'registered').length}</span>
                      <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-600">Not registered: {processedStudentRows.filter((row) => row.whatsappVerificationStatus === 'not_registered').length}</span>
                      <span className="rounded-full bg-rose-500/10 px-2 py-1 text-rose-600">Invalid: {processedStudentRows.filter((row) => row.whatsappVerificationStatus === 'invalid').length}</span>
                      <span className="rounded-full bg-slate-500/10 px-2 py-1 text-slate-600 dark:text-slate-300">Failed: {processedStudentRows.filter((row) => row.whatsappVerificationStatus === 'verification_failed').length}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="bg-slate-50 dark:bg-[#070b13] p-3 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
                      <span className="text-[9px] font-black uppercase text-slate-400 block">Total Rows</span>
                      <span className="text-lg font-black text-slate-900 dark:text-white">{studentImportStats.total}</span>
                    </div>
                    <div className="bg-emerald-500/10 p-3 rounded-2xl border border-emerald-500/20 text-center">
                      <span className="text-[9px] font-black uppercase text-emerald-600 dark:text-emerald-400 block">Valid</span>
                      <span className="text-lg font-black text-emerald-600 dark:text-emerald-400">{studentImportStats.valid}</span>
                    </div>
                    <div className="bg-rose-500/10 p-3 rounded-2xl border border-rose-500/20 text-center">
                      <span className="text-[9px] font-black uppercase text-rose-600 dark:text-rose-400 block">Invalid</span>
                      <span className="text-lg font-black text-rose-600 dark:text-rose-400">{studentImportStats.invalid}</span>
                    </div>
                    <div className="bg-amber-500/10 p-3 rounded-2xl border border-amber-500/20 text-center">
                      <span className="text-[9px] font-black uppercase text-amber-600 dark:text-amber-400 block">Duplicate</span>
                      <span className="text-lg font-black text-amber-600 dark:text-amber-400">{studentImportStats.duplicate}</span>
                    </div>
                  </div>

                  {/* FILTER TABS */}
                  <div className="flex flex-wrap gap-1.5">
                    {([
                      { key: 'all', label: `All (${studentImportStats.total})` },
                      { key: 'valid', label: `Valid (${studentImportStats.valid})` },
                      { key: 'invalid', label: `Invalid (${studentImportStats.invalid})` },
                      { key: 'duplicate', label: `Duplicate (${studentImportStats.duplicate})` }
                    ] as const).map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => {
                          setStudentImportFilter(tab.key);
                          setStudentImportPage(1);
                        }}
                        className={`px-3 py-1.5 rounded-xl text-[10px] font-black transition-all ${
                          studentImportFilter === tab.key
                            ? 'bg-orange-500 text-white shadow-[0_0_10px_rgba(249,115,22,0.35)]'
                            : 'bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* PREVIEW TABLE */}
                  <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden overflow-x-auto">
                    <div className="bg-slate-100 dark:bg-slate-900 flex text-[9px] font-black uppercase text-slate-400 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 min-w-[640px]">
                      <div className="w-10">Row</div>
                      <div className="w-1/5">Name</div>
                      <div className="w-16 text-center">Roll</div>
                      <div className="w-1/5">WhatsApp</div>
                      <div className="w-16 text-center">Gender</div>
                      <div className="w-20 text-right">Fee</div>
                      <div className="flex-1">Status / Reason</div>
                    </div>

                    <div className="divide-y divide-slate-100 dark:divide-slate-800/60 min-w-[640px] max-h-[420px] overflow-y-auto">
                      {paginatedStudentImportRows.length > 0 ? (
                        paginatedStudentImportRows.map((row) => (
                          <div key={row.id} className="flex items-center text-[11px] font-bold px-3 py-2.5 text-slate-800 dark:text-slate-200 hover:bg-orange-500/5">
                            <div className="w-10 text-slate-400 font-mono">{row.rowIndex}</div>
                            <div className="w-1/5 truncate font-extrabold">{row.name || '—'}</div>
                            <div className="w-16 text-center font-mono text-slate-500">{row.rollNo || '—'}</div>
                            <div className="w-1/5 min-w-0 truncate font-mono text-slate-400">
                              {row.phoneFormatted || row.phoneRaw || '—'}
                              {row.whatsappVerificationStatus && <span className={`mt-1 block truncate font-sans text-[9px] font-black ${row.whatsappVerificationStatus === 'registered' ? 'text-emerald-600' : row.whatsappVerificationStatus === 'not_registered' ? 'text-amber-600' : row.whatsappVerificationStatus === 'invalid' ? 'text-rose-600' : 'text-slate-500'}`}>{row.whatsappVerificationStatus === 'registered' ? 'WhatsApp registered' : row.whatsappVerificationStatus === 'not_registered' ? 'Not on WhatsApp' : row.whatsappVerificationStatus === 'invalid' ? 'Invalid number' : 'Verification failed'}</span>}
                            </div>
                            <div className="w-16 text-center">{row.gender || '—'}</div>
                            <div className="w-20 text-right font-mono text-slate-500">{row.feeRaw || '—'}</div>
                            <div className="flex-1 flex items-center gap-1.5 min-w-0">
                              {row.saveStatus === 'success' && (
                                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[10px] font-black flex items-center gap-1 shrink-0">
                                  <CheckCircle2 className="h-3 w-3" /> Imported
                                </span>
                              )}
                              {row.saveStatus === 'failed' && (
                                <span className="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 text-[10px] font-black flex items-center gap-1 shrink-0">
                                  <AlertCircle className="h-3 w-3" /> Save Failed
                                </span>
                              )}
                              {!row.saveStatus && row.status === 'valid' && (
                                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[10px] font-black flex items-center gap-1 shrink-0">
                                  <CheckCircle2 className="h-3 w-3" /> Valid
                                </span>
                              )}
                              {!row.saveStatus && row.status === 'invalid' && (
                                <span className="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 text-[10px] font-black flex items-center gap-1 shrink-0">
                                  <AlertCircle className="h-3 w-3" /> Invalid
                                </span>
                              )}
                              {!row.saveStatus && row.status === 'duplicate' && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 text-[10px] font-black flex items-center gap-1 shrink-0">
                                  <AlertCircle className="h-3 w-3" /> Duplicate
                                </span>
                              )}
                              <span className="text-[10px] font-semibold text-slate-400 truncate">
                                {row.saveStatus === 'failed' ? row.saveError : row.errorReason}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="p-4 text-center text-xs font-bold text-slate-400">No records match this filter.</div>
                      )}
                    </div>
                  </div>

                  {/* PAGINATION */}
                  {studentImportTotalPages > 1 && (
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] font-extrabold text-slate-500 dark:text-slate-400">
                        Pg {studentImportPage}/{studentImportTotalPages} ({filteredStudentImportRows.length})
                      </span>
                      <div className="flex items-center gap-2">
                        <Button
                          onClick={() => setStudentImportPage((p) => Math.max(p - 1, 1))}
                          disabled={studentImportPage === 1}
                          variant="outline"
                          size="sm"
                          className="rounded-full px-3 text-xs font-bold border-slate-200 dark:border-slate-800 disabled:opacity-40"
                        >
                          <ChevronLeft className="h-3.5 w-3.5 mr-0.5" /> Prev
                        </Button>
                        <Button
                          onClick={() => setStudentImportPage((p) => Math.min(p + 1, studentImportTotalPages))}
                          disabled={studentImportPage === studentImportTotalPages}
                          variant="outline"
                          size="sm"
                          className="rounded-full px-3 text-xs font-bold border-slate-200 dark:border-slate-800 disabled:opacity-40"
                        >
                          Next <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* IMPORT PROGRESS */}
                  {isImportingStudents && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-bold text-slate-500">
                        <span>Importing students into {currentClass.name}...</span>
                        <span>{studentImportProgress}%</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-orange-500 transition-all duration-300"
                          style={{ width: `${studentImportProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* FINAL SUMMARY */}
                  {studentImportSummary && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 bg-slate-50 dark:bg-[#070b13] p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800">
                      <div className="text-center">
                        <span className="text-[9px] font-black uppercase text-emerald-500 block">Imported</span>
                        <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">{studentImportSummary.imported}</span>
                      </div>
                      <div className="text-center">
                        <span className="text-[9px] font-black uppercase text-rose-500 block">Invalid Skipped</span>
                        <span className="text-sm font-black text-rose-600 dark:text-rose-400">{studentImportSummary.skippedInvalid}</span>
                      </div>
                      <div className="text-center">
                        <span className="text-[9px] font-black uppercase text-amber-500 block">Duplicates Skipped</span>
                        <span className="text-sm font-black text-amber-600 dark:text-amber-400">{studentImportSummary.skippedDuplicate}</span>
                      </div>
                      <div className="text-center">
                        <span className="text-[9px] font-black uppercase text-slate-500 block">Failed</span>
                        <span className="text-sm font-black text-slate-700 dark:text-slate-300">{studentImportSummary.failed}</span>
                      </div>
                    </div>
                  )}
                  {studentImportSummary?.ignoredConsentColumns.length ? (
                    <div className="rounded-2xl border border-amber-300/70 bg-amber-50/80 px-3.5 py-3 text-[11px] font-bold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                      Academy permissions do not allow these uploaded consent columns. They were ignored and saved as No: {studentImportSummary.ignoredConsentColumns.join(', ')}.
                    </div>
                  ) : null}

                  {/* ACTION BUTTONS */}
                  <div className="flex flex-wrap justify-end gap-2.5 pt-1">
                    {(studentImportStats.invalid > 0 || studentImportStats.duplicate > 0 || studentImportSummary?.failed) && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleDownloadFailedStudentRows}
                        className="rounded-2xl text-xs font-bold border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400"
                      >
                        <Download className="h-3.5 w-3.5 mr-1.5" /> Download Issues (CSV)
                      </Button>
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCancelExcelImport}
                      className="rounded-2xl text-xs font-bold border-slate-200 dark:border-slate-800"
                      disabled={isImportingStudents}
                    >
                      Cancel
                    </Button>

                    <Button
                      type="button"
                      disabled={isImportingStudents || studentImportStats.valid === 0 || needsColumnMapping}
                      onClick={handleExecuteStudentImport}
                      className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white rounded-2xl font-black text-xs px-6 shadow-md transition-all active:scale-95 flex items-center gap-2"
                    >
                      {isImportingStudents ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Importing...
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4" /> Import Valid Students ({studentImportStats.valid})
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* FILTER CARD */}
            <div className="bg-gradient-to-br from-white via-slate-50 to-orange-50/20 dark:from-[#0c1222] dark:via-[#0c1222] dark:to-orange-950/20 border border-slate-200/80 dark:border-slate-800/80 rounded-3xl p-3 shadow-md space-y-2 backdrop-blur-sm">
              <div className="flex items-center gap-1.5 text-xs font-black text-slate-800 dark:text-slate-100">
                <SlidersHorizontal className="h-3.5 w-3.5 text-orange-500" />
                <span>Filters</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-100 dark:bg-slate-900/80 p-1 rounded-xl flex items-center border border-slate-200 dark:border-slate-800">
                  <span className="text-[9px] font-black uppercase text-slate-400 px-1.5 hidden sm:inline">
                    Gender:
                  </span>
                  <div className="flex-1 grid grid-cols-3 gap-0.5">
                    {(['All', 'Male', 'Female'] as const).map((g) => (
                      <button
                        key={g}
                        onClick={() => setGenderFilter(g)}
                        className={`py-1 rounded-lg font-black text-[10px] transition-all ${
                          genderFilter === g
                            ? 'bg-orange-500 text-white shadow-[0_0_10px_rgba(249,115,22,0.4)]'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {g === 'All' ? 'All' : g === 'Male' ? 'M' : 'F'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-100 dark:bg-slate-900/80 p-1 rounded-xl flex items-center border border-slate-200 dark:border-slate-800">
                  <span className="text-[9px] font-black uppercase text-slate-400 px-1.5 hidden sm:inline">
                    Fee:
                  </span>
                  <div className="flex-1 grid grid-cols-3 gap-0.5">
                    {(['All', 'Paid', 'Unpaid'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setFeeFilter(f)}
                        className={`py-1 rounded-lg font-black text-[10px] transition-all ${
                          feeFilter === f
                            ? 'bg-orange-500 text-white shadow-[0_0_10px_rgba(249,115,22,0.4)]'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* SINGLE SCREEN TABLE */}
            <div className="bg-white dark:bg-[#0c1222] border border-slate-200/70 dark:border-slate-800/60 rounded-3xl p-3 shadow-sm space-y-2">

              {/* TABLE HEADER */}
              <div className="flex items-center justify-between text-[9px] sm:text-[10px] font-black text-slate-400 uppercase tracking-wider px-2 py-1.5 border-b border-slate-100 dark:border-slate-800/60 w-full">
                <div className="flex-1 min-w-0 pr-1">Student Name & Info</div>
                <div className="w-8 shrink-0 text-center">Roll</div>
                <div className="shrink-0 px-1 text-center min-w-[50px]">Fee</div>
                <div className="shrink-0 text-right pl-1 min-w-[55px]">Actions</div>
              </div>

              {/* TABLE BODY */}
              {paginatedStudents.length === 0 ? (
                <div className="text-center py-8 text-xs font-bold text-slate-400">
                  No students found.
                </div>
              ) : (
                paginatedStudents.map((student) => {
                  const defaultClassFee = safeNumber(currentClass.monthlyFee || 0);
                  const effectiveStudentFee = safeNumber(student.studentFee || currentClass.monthlyFee || 0);
                  const isDeserving = effectiveStudentFee < defaultClassFee;

                  return (
                    <div
                      key={`${String(getStudentIdentifier(student) ?? 'no-id')}::${student._sourceKey ?? ''}`}
                      className="flex items-center justify-between gap-1 px-2 py-2.5 rounded-2xl hover:bg-orange-500/5 dark:hover:bg-slate-900/60 transition-colors border-b border-slate-100 dark:border-slate-800/40 last:border-0 w-full group"
                    >
                      {/* COLUMN 1: STUDENT NAME & INFO */}
                      <div className="flex items-center gap-2 min-w-0 flex-1 pr-1">
                        <img
                          src={student.avatar}
                          alt={student.name}
                          className="h-8 w-8 sm:h-9 sm:w-9 rounded-full object-cover shrink-0 border border-slate-200 dark:border-slate-800 shadow-sm"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 flex-wrap">
                            <p className="text-xs font-black text-slate-900 dark:text-slate-100 truncate max-w-[90px] sm:max-w-none group-hover:text-orange-500 transition-colors">
                              {student.name}
                            </p>
                            {isDeserving && (
                              <span className="inline-flex items-center gap-0.5 bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 border border-emerald-500/30 text-[8px] font-black px-1.5 py-0.2 rounded-full shrink-0 shadow-[0_0_8px_rgba(16,185,129,0.2)]">
                                <Tag className="h-2 w-2" /> Deserving
                              </span>
                            )}
                          </div>
                          <p className="text-[9px] font-bold text-slate-400 truncate mt-0.5">
                            {student.phone} • {student.gender || 'Male'} • PKR {effectiveStudentFee.toLocaleString()}
                          </p>
                        </div>
                      </div>

                      {/* COLUMN 2: ROLL NUMBER */}
                      <div className="w-8 shrink-0 text-center text-xs font-black text-slate-800 dark:text-slate-200">
                        {student.rollNo}
                      </div>

                      {/* COLUMN 3: FEE STATUS BADGE */}
                      <div className="shrink-0 px-1 text-center min-w-[50px]">
                        <span className={`inline-block text-[8px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-tight ${
                          student.feeStatus === 'Paid'
                            ? 'bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/25 dark:text-emerald-400 border border-emerald-500/30 shadow-[0_0_8px_rgba(16,185,129,0.2)]'
                            : 'bg-rose-500/15 text-rose-600 dark:bg-rose-500/25 dark:text-rose-400 border border-rose-500/30 shadow-[0_0_8px_rgba(244,63,94,0.2)]'
                        }`}>
                          {student.feeStatus}
                        </span>
                      </div>

                      {/* COLUMN 4: ACTION BUTTONS */}
                      <div className="shrink-0 flex items-center justify-end gap-1 pl-1 min-w-[55px]">
                        <button
                          onClick={() => handleOpenEditStudent(student)}
                          className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 hover:shadow-[0_0_10px_rgba(16,185,129,0.4)] transition-all active:scale-95"
                          title="Edit Student"
                        >
                          <Edit2 className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setDeleteConfirmStudent(student)}
                          className="p-1.5 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 hover:shadow-[0_0_10px_rgba(244,63,94,0.4)] transition-all active:scale-95"
                          title="Delete Student"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}

              {/* PAGINATION CONTROLS */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800/60 px-1">
                  <span className="text-[10px] font-black text-slate-400">
                    Pg {currentPage}/{totalPages} ({sortedAndFilteredStudents.length})
                  </span>

                  <div className="flex items-center gap-1.5">
                    <button
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                      className="flex items-center gap-0.5 px-2.5 py-1 rounded-xl border border-slate-200 dark:border-slate-800 text-[10px] font-black disabled:opacity-40 hover:bg-orange-500 hover:text-white transition-all hover:shadow-[0_0_10px_rgba(249,115,22,0.3)]"
                    >
                      <ChevronLeft className="h-3 w-3" /> Prev
                    </button>

                    <button
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                      className="flex items-center gap-0.5 px-2.5 py-1 rounded-xl border border-slate-200 dark:border-slate-800 text-[10px] font-black disabled:opacity-40 hover:bg-orange-500 hover:text-white transition-all hover:shadow-[0_0_10px_rgba(249,115,22,0.3)]"
                    >
                      Next <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}

            </div>

          </div>
        )}

      </main>

      {/* CENTER ANIMATED GLOWING NOTIFICATION TOAST */}
      {toast.isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in zoom-in-90 duration-200">
          <div className={`bg-white dark:bg-[#0c1222] border rounded-3xl p-6 max-w-xs w-full text-center space-y-3 relative shadow-2xl transition-all duration-300 ${
            toast.type === 'success'
              ? 'border-emerald-500/50 shadow-[0_0_50px_rgba(16,185,129,0.4)]'
              : 'border-rose-500/50 shadow-[0_0_50px_rgba(244,63,94,0.4)]'
          }`}>
            <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center animate-bounce ${
              toast.type === 'success'
                ? 'bg-emerald-500/20 text-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.3)]'
                : 'bg-rose-500/20 text-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.3)]'
            }`}>
              {toast.type === 'success' ? (
                <CheckCircle2 className="h-8 w-8" />
              ) : toast.type === 'error' ? (
                <AlertTriangle className="h-8 w-8" />
              ) : (
                <Trash2 className="h-8 w-8" />
              )}
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-black text-slate-900 dark:text-white">
                {toast.title}
              </h3>
              <p className="text-xs font-bold text-slate-500 dark:text-slate-400 leading-snug">
                {toast.message}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CLASS CONFIRMATION MODAL */}
      {deleteConfirmClass && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border border-rose-500/40 rounded-3xl max-w-sm w-full p-6 shadow-[0_0_50px_rgba(244,63,94,0.3)] relative text-center space-y-4">

            <div className="w-12 h-12 bg-rose-500/10 text-rose-500 rounded-2xl flex items-center justify-center mx-auto border border-rose-500/30 shadow-[0_0_15px_rgba(244,63,94,0.2)]">
              <AlertTriangle className="h-6 w-6" />
            </div>

            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-white">
                Delete Class?
              </h3>
              <p className="text-xs font-bold text-slate-400 mt-1">
                Are you sure you want to delete <span className="text-rose-500 font-extrabold">{deleteConfirmClass.name}</span>? All enrolled student records for this class will also be removed.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              <Button
                onClick={() => setDeleteConfirmClass(null)}
                className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-2xl font-black text-xs py-3 transition-colors"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmDeleteClass}
                className="bg-rose-500 hover:bg-rose-600 text-white rounded-2xl font-black text-xs py-3 shadow-[0_0_15px_rgba(244,63,94,0.4)] transition-all active:scale-95"
              >
                Yes, Delete Class
              </Button>
            </div>

          </div>
        </div>
      )}

      {/* DELETE STUDENT CONFIRMATION MODAL */}
      {deleteConfirmStudent && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border border-rose-500/40 rounded-3xl max-w-sm w-full p-6 shadow-[0_0_50px_rgba(244,63,94,0.3)] relative text-center space-y-4">

            <div className="w-12 h-12 bg-rose-500/10 text-rose-500 rounded-2xl flex items-center justify-center mx-auto border border-rose-500/30 shadow-[0_0_15px_rgba(244,63,94,0.2)]">
              <AlertTriangle className="h-6 w-6" />
            </div>

            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-white">
                Confirm Deletion?
              </h3>
              <p className="text-xs font-bold text-slate-400 mt-1">
                Are you sure you want to remove <span className="text-rose-500 font-extrabold">{deleteConfirmStudent.name}</span>?
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              <Button
                onClick={() => setDeleteConfirmStudent(null)}
                className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-2xl font-black text-xs py-3 transition-colors"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmDeleteStudent}
                className="bg-rose-500 hover:bg-rose-600 text-white rounded-2xl font-black text-xs py-3 shadow-[0_0_15px_rgba(244,63,94,0.4)] transition-all active:scale-95"
              >
                Yes, Delete
              </Button>
            </div>

          </div>
        </div>
      )}

      {/* MODAL 1: CREATE NEW CLASS */}
      {isCreateClassOpen && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 rounded-3xl max-w-md w-full p-6 shadow-[0_0_50px_rgba(0,0,0,0.3)] dark:shadow-[0_0_50px_rgba(249,115,22,0.15)] relative my-auto">
            <button
              onClick={() => setIsCreateClassOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors"
            >
              <X className="h-5 w-5" />
            </button>

            <h3 className="text-lg font-black text-slate-900 dark:text-white mb-4">Create New Class</h3>

            <form onSubmit={handleCreateClass} className="space-y-4">
              <div>
                <label className="text-xs font-extrabold text-slate-600 dark:text-slate-300 block mb-1">Class Name</label>
                <input
                  type="text"
                  placeholder="e.g. Class 10 A"
                  value={classNameInput}
                  onChange={(e) => setClassNameInput(e.target.value)}
                  required
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-600 dark:text-slate-300 block mb-1">Class Code</label>
                <input
                  type="text"
                  placeholder="e.g. 10A"
                  value={classCodeInput}
                  onChange={(e) => setClassCodeInput(e.target.value)}
                  required
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-600 dark:text-slate-300 block mb-1">Monthly Fee (PKR)</label>
                <input
                  type="number"
                  placeholder="e.g. 5000"
                  value={monthlyFeeInput}
                  onChange={(e) => setMonthlyFeeInput(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <Button type="submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white rounded-xl py-3 font-black text-xs mt-2 shadow-[0_0_20px_rgba(249,115,22,0.35)] transition-all active:scale-95">
                Create Class
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: EDIT CLASS */}
      {editingClass && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 rounded-3xl max-w-md w-full p-6 shadow-[0_0_50px_rgba(0,0,0,0.3)] dark:shadow-[0_0_50px_rgba(249,115,22,0.15)] relative my-auto">
            <button
              onClick={() => setEditingClass(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors"
            >
              <X className="h-5 w-5" />
            </button>

            <h3 className="text-lg font-black text-slate-900 dark:text-white mb-4 flex items-center gap-2">
              <Edit2 className="h-5 w-5 text-orange-500" /> Edit Class Details
            </h3>

            <form onSubmit={handleSaveEditClass} className="space-y-4">
              <div>
                <label className="text-xs font-extrabold text-slate-600 dark:text-slate-300 block mb-1">Class Name</label>
                <input
                  type="text"
                  placeholder="e.g. Class 10 A"
                  value={editClassNameInput}
                  onChange={(e) => setEditClassNameInput(e.target.value)}
                  required
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-600 dark:text-slate-300 block mb-1">Class Code</label>
                <input
                  type="text"
                  placeholder="e.g. 10A"
                  value={editClassCodeInput}
                  onChange={(e) => setEditClassCodeInput(e.target.value)}
                  required
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-600 dark:text-slate-300 block mb-1">Monthly Fee (PKR)</label>
                <input
                  type="number"
                  placeholder="e.g. 5000"
                  value={editMonthlyFeeInput}
                  onChange={(e) => setEditMonthlyFeeInput(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <Button type="submit" className="w-full bg-orange-500 hover:bg-orange-600 text-white rounded-xl py-3 font-black text-xs mt-2 shadow-[0_0_20px_rgba(249,115,22,0.35)] transition-all active:scale-95">
                Update Class Details
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: ADD / EDIT STUDENT */}
      {isAddStudentOpen && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center animate-in fade-in zoom-in-95 duration-200">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 rounded-3xl max-w-sm w-full p-6 shadow-[0_0_50px_rgba(0,0,0,0.3)] dark:shadow-[0_0_50px_rgba(249,115,22,0.15)] relative space-y-4 max-h-[85vh] overflow-y-auto my-auto">

            <div className="flex items-center justify-between">
              <button
                onClick={() => setIsAddStudentOpen(false)}
                className="p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="text-xs font-extrabold text-orange-500 uppercase tracking-wider">
                {editingStudent ? 'Edit Student' : 'Add Student'}
              </span>
            </div>

            {/* HIDDEN FILE INPUT FOR PHOTO UPLOAD */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handlePhotoSelect}
              accept="image/*"
              className="hidden"
            />

            {/* LIVE PHOTO PREVIEW & UPLOAD TRIGGER */}
            <div className="flex justify-center">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="relative w-20 h-20 rounded-full border-2 border-dashed border-orange-400 bg-orange-50/30 dark:bg-slate-900/40 flex flex-col items-center justify-center text-center cursor-pointer shadow-[0_0_15px_rgba(249,115,22,0.2)] hover:scale-105 transition-all overflow-hidden group"
              >
                {studentAvatar ? (
                  <>
                    <img src={studentAvatar} alt="Live Avatar" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <Camera className="h-5 w-5 text-white" />
                    </div>
                  </>
                ) : (
                  <>
                    <Upload className="h-5 w-5 text-orange-500 mb-0.5" />
                    <span className="text-[9px] font-black text-orange-600 dark:text-orange-400">Upload Photo</span>
                  </>
                )}
              </div>
            </div>

            <form onSubmit={handleSaveStudent} className="space-y-3">
              <div>
                <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Full Name</label>
                <input
                  type="text"
                  placeholder="Enter full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070b13] px-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Father's Name</label>
                <input
                  type="text"
                  placeholder="Enter father's name"
                  value={fatherName}
                  onChange={(e) => setFatherName(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070b13] px-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300 block mb-1">Gender</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setGender('Male')}
                    className={`py-2 rounded-xl text-xs font-extrabold border transition-all ${
                      gender === 'Male'
                        ? 'border-orange-500 bg-orange-500/10 text-orange-600 dark:text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.2)]'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] text-slate-400'
                    }`}
                  >
                    👦 Male
                  </button>
                  <button
                    type="button"
                    onClick={() => setGender('Female')}
                    className={`py-2 rounded-xl text-xs font-extrabold border transition-all ${
                      gender === 'Female'
                        ? 'border-orange-500 bg-orange-500/10 text-orange-600 dark:text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.2)]'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070b13] text-slate-400'
                    }`}
                  >
                    👧 Female
                  </button>
                </div>
              </div>

              {/* WHATSAPP NUMBER VALIDATION INPUT WITH RED -> GREEN EFFECT */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300 uppercase">
                    PARENT / GUARDIAN WHATSAPP
                  </label>
                  <span className={`text-[10px] font-black transition-colors ${
                    isWhatsappComplete
                      ? 'text-emerald-500'
                      : whatsappDigitCount > 0
                      ? 'text-rose-500'
                      : 'text-slate-400'
                  }`}>
                    {whatsappDigitCount}/10 Digits
                  </span>
                </div>

                <div className="relative">
                  <input
                    type="text"
                    placeholder="+92 300 1234567"
                    value={whatsapp}
                    onChange={handlePhoneChange}
                    required
                    className={`w-full rounded-2xl px-4 py-2.5 text-xs font-bold outline-none transition-all pr-10 text-slate-900 dark:text-white ${
                      isWhatsappComplete
                        ? 'border-2 border-emerald-500 bg-emerald-50/10 dark:bg-emerald-950/10 focus:ring-2 focus:ring-emerald-500/30'
                        : whatsappDigitCount > 0
                        ? 'border-2 border-rose-500 bg-rose-50/10 dark:bg-rose-950/10 focus:ring-2 focus:ring-rose-500/30'
                        : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070b13] focus:border-orange-500'
                    }`}
                  />

                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                    {isWhatsappComplete ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500 animate-in zoom-in-75 duration-200" />
                    ) : whatsappDigitCount > 0 ? (
                      <AlertCircle className="h-5 w-5 text-rose-500 animate-in zoom-in-75 duration-200" />
                    ) : null}
                  </div>
                </div>

                {/* WARNING / SUCCESS SUB-TEXT */}
                {!isWhatsappComplete && whatsappDigitCount > 0 && (
                  <p className="text-[10px] font-extrabold text-rose-500 mt-1.5 flex items-center gap-1 animate-in fade-in duration-200">
                    Please enter remaining {remainingWhatsappDigits} digits after +92.
                  </p>
                )}

                {isWhatsappComplete && (
                  <p className="text-[10px] font-semibold text-slate-500 mt-1.5">Number format is valid. Check whether it is registered on WhatsApp below.</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={!isWhatsappComplete || guardianWhatsAppCheckStatus === 'checking'} onClick={() => void handleCheckGuardianWhatsApp()} className="rounded-xl text-[10px] font-black">
                    {guardianWhatsAppCheckStatus === 'checking' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                    {guardianWhatsAppCheckStatus === 'checking' ? 'Checking…' : 'Verify on WhatsApp'}
                  </Button>
                  {guardianWhatsAppCheckNumber === whatsapp.replace(/\D/g, '') && guardianWhatsAppCheckMessage && (
                    <span role="status" className={`text-[10px] font-bold ${guardianWhatsAppCheckStatus === 'registered' ? 'text-emerald-600' : guardianWhatsAppCheckStatus === 'not_registered' ? 'text-amber-600' : 'text-rose-600'}`}>{guardianWhatsAppCheckMessage}</span>
                  )}
                </div>
                <p className="mt-1 text-[9px] text-slate-400">Lookup does not send a message and never enables consent automatically.</p>
              </div>

              {/* FULL-WIDTH ATTENDANCE CONSENT CARD */}
              <label className={`flex w-full min-h-[76px] items-center gap-3 rounded-2xl border px-4 py-3 cursor-pointer transition-all duration-200 focus-within:ring-2 focus-within:ring-orange-400/30 ${
                attendanceWhatsAppOptIn
                  ? 'border-orange-400 bg-orange-50 text-orange-800 shadow-sm dark:border-orange-500/70 dark:bg-orange-500/10 dark:text-orange-300'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-orange-300 dark:border-slate-800 dark:bg-[#0c1222] dark:text-slate-300'
              }`}>
                <input
                  type="checkbox"
                  checked={attendanceWhatsAppOptIn}
                  disabled={!canAccessFeature('attendance_alerts')}
                  onChange={(e) => setAttendanceWhatsAppOptIn(e.target.checked)}
                  aria-label="Attendance WhatsApp consent"
                  className="sr-only"
                />
                <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-black ${
                  attendanceWhatsAppOptIn
                    ? 'border-orange-500 bg-orange-500 text-white'
                    : 'border-slate-300 text-transparent dark:border-slate-600'
                }`}>
                  {attendanceWhatsAppOptIn ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 text-sm font-extrabold">
                  Attendance Alerts
                </span>
                {!canAccessFeature('attendance_alerts') ? <button type="button" onClick={() => void requestLockedConsentFeature('attendance_alerts')} className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-500 dark:bg-slate-800">LOCKED · Request</button> : null}
                <span className={`text-[10px] font-black ${
                  attendanceWhatsAppOptIn
                    ? 'text-orange-600 dark:text-orange-400'
                    : 'text-slate-400'
                }`}>
                  {attendanceWhatsAppOptIn ? 'ON' : 'OFF'}
                </span>
              </label>

              {/* COMPACT WHATSAPP CONSENT CARDS */}
              <div className="grid grid-cols-2 gap-2 sm:gap-3">

                <label className={`flex min-h-[68px] cursor-pointer items-center gap-2 rounded-2xl border p-3 transition-all duration-200 focus-within:ring-2 focus-within:ring-emerald-400/30 ${
                  monthlyReportWhatsAppOptIn
                    ? 'border-emerald-400 bg-emerald-50 text-emerald-800 shadow-sm dark:border-emerald-500/70 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300 dark:border-slate-800 dark:bg-[#0c1222] dark:text-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={monthlyReportWhatsAppOptIn}
                    disabled={!canAccessFeature('monthly_reports')}
                    onChange={(e) => setMonthlyReportWhatsAppOptIn(e.target.checked)}
                    aria-label="Monthly PDF WhatsApp consent"
                    className="sr-only"
                  />
                  <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-black ${monthlyReportWhatsAppOptIn ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 text-transparent dark:border-slate-600'}`}>
                    {monthlyReportWhatsAppOptIn ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] font-extrabold leading-tight">Monthly PDF</span>
                  {!canAccessFeature('monthly_reports') ? <button type="button" onClick={() => void requestLockedConsentFeature('monthly_reports')} className="rounded-full bg-slate-100 px-1.5 py-1 text-[8px] font-black text-slate-500 dark:bg-slate-800">LOCKED</button> : null}
                  <span className={`text-[9px] font-black ${monthlyReportWhatsAppOptIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                    {monthlyReportWhatsAppOptIn ? 'ON' : 'OFF'}
                  </span>
                </label>

                <label className={`flex min-h-[68px] cursor-pointer items-center gap-2 rounded-2xl border p-3 transition-all duration-200 focus-within:ring-2 focus-within:ring-blue-400/30 ${
                  quizResultsWhatsAppOptIn
                    ? 'border-blue-400 bg-blue-50 text-blue-800 shadow-sm dark:border-blue-500/70 dark:bg-blue-500/10 dark:text-blue-300'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 dark:border-slate-800 dark:bg-[#0c1222] dark:text-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={quizResultsWhatsAppOptIn}
                    disabled={!canAccessFeature('quiz_result_notifications')}
                    onChange={(e) => setQuizResultsWhatsAppOptIn(e.target.checked)}
                    aria-label="Quiz results WhatsApp consent"
                    className="sr-only"
                  />
                  <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-black ${quizResultsWhatsAppOptIn ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-300 text-transparent dark:border-slate-600'}`}>
                    {quizResultsWhatsAppOptIn ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] font-extrabold leading-tight">Quiz Results</span>
                  {!canAccessFeature('quiz_result_notifications') ? <button type="button" onClick={() => void requestLockedConsentFeature('quiz_result_notifications')} className="rounded-full bg-slate-100 px-1.5 py-1 text-[8px] font-black text-slate-500 dark:bg-slate-800">LOCKED</button> : null}
                  <span className={`text-[9px] font-black ${quizResultsWhatsAppOptIn ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}>
                    {quizResultsWhatsAppOptIn ? 'ON' : 'OFF'}
                  </span>
                </label>

                <label className={`flex min-h-[68px] cursor-pointer items-center gap-2 rounded-2xl border p-3 transition-all duration-200 focus-within:ring-2 focus-within:ring-amber-400/30 ${
                  feeAlertsWhatsAppOptIn
                    ? 'border-amber-400 bg-amber-50 text-amber-800 shadow-sm dark:border-amber-500/70 dark:bg-amber-500/10 dark:text-amber-300'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300 dark:border-slate-800 dark:bg-[#0c1222] dark:text-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={feeAlertsWhatsAppOptIn}
                    disabled={!canAccessFeature('fee_alerts')}
                    onChange={(e) => setFeeAlertsWhatsAppOptIn(e.target.checked)}
                    aria-label="Fee alerts WhatsApp consent"
                    className="sr-only"
                  />
                  <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-black ${feeAlertsWhatsAppOptIn ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-300 text-transparent dark:border-slate-600'}`}>
                    {feeAlertsWhatsAppOptIn ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] font-extrabold leading-tight">Fee Alerts</span>
                  {!canAccessFeature('fee_alerts') ? <button type="button" onClick={() => void requestLockedConsentFeature('fee_alerts')} className="rounded-full bg-slate-100 px-1.5 py-1 text-[8px] font-black text-slate-500 dark:bg-slate-800">LOCKED</button> : null}
                  <span className={`text-[9px] font-black ${feeAlertsWhatsAppOptIn ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                    {feeAlertsWhatsAppOptIn ? 'ON' : 'OFF'}
                  </span>
                </label>

                <label className={`flex min-h-[68px] cursor-pointer items-center gap-2 rounded-2xl border p-3 transition-all duration-200 focus-within:ring-2 focus-within:ring-violet-400/30 ${
                  announcementWhatsAppOptIn
                    ? 'border-violet-400 bg-violet-50 text-violet-800 shadow-sm dark:border-violet-500/70 dark:bg-violet-500/10 dark:text-violet-300'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300 dark:border-slate-800 dark:bg-[#0c1222] dark:text-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={announcementWhatsAppOptIn}
                    disabled={!canAccessFeature('announcements')}
                    onChange={(e) => setAnnouncementWhatsAppOptIn(e.target.checked)}
                    aria-label="School announcements WhatsApp consent"
                    className="sr-only"
                  />
                  <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-black ${announcementWhatsAppOptIn ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-300 text-transparent dark:border-slate-600'}`}>
                    {announcementWhatsAppOptIn ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] font-extrabold leading-tight">Announcements</span>
                  {!canAccessFeature('announcements') ? <button type="button" onClick={() => void requestLockedConsentFeature('announcements')} className="rounded-full bg-slate-100 px-1.5 py-1 text-[8px] font-black text-slate-500 dark:bg-slate-800">LOCKED</button> : null}
                  <span className={`text-[9px] font-black ${announcementWhatsAppOptIn ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400'}`}>
                    {announcementWhatsAppOptIn ? 'ON' : 'OFF'}
                  </span>
                </label>

                <label className={`col-span-2 flex min-h-[68px] items-center gap-2 rounded-2xl border p-3 transition-all ${libraryLinkWhatsAppOptIn ? 'border-cyan-400 bg-cyan-50 text-cyan-800 dark:border-cyan-500/70 dark:bg-cyan-500/10 dark:text-cyan-300' : 'border-slate-200 bg-white text-slate-600 dark:border-slate-800 dark:bg-[#0c1222] dark:text-slate-300'} ${!canAccessFeature('library_link_whatsapp') ? 'cursor-not-allowed opacity-80' : 'cursor-pointer hover:border-cyan-300'}`}>
                  <input type="checkbox" checked={libraryLinkWhatsAppOptIn} disabled={!canAccessFeature('library_link_whatsapp')} onChange={(e) => setLibraryLinkWhatsAppOptIn(e.target.checked)} aria-label="Library resource WhatsApp consent" className="sr-only" />
                  <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-black ${libraryLinkWhatsAppOptIn ? 'border-cyan-500 bg-cyan-500 text-white' : 'border-slate-300 text-transparent dark:border-slate-600'}`}>{libraryLinkWhatsAppOptIn ? '✓' : ''}</span>
                  <span className="min-w-0 flex-1 text-[11px] font-extrabold leading-tight">Auto-share Notes & Library links on WhatsApp</span>
                  {!canAccessFeature('library_link_whatsapp') ? <button type="button" onClick={() => void requestLockedConsentFeature('library_link_whatsapp')} className="rounded-full bg-slate-100 px-1.5 py-1 text-[8px] font-black text-slate-500 dark:bg-slate-800">LOCKED · Request</button> : <span className="text-[9px] font-black text-cyan-600">{libraryLinkWhatsAppOptIn ? 'ON' : 'OFF'}</span>}
                </label>
              </div>

              <div>
                <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Roll Number</label>
                <input
                  type="text"
                  placeholder="Enter roll number"
                  value={rollNo}
                  onChange={(e) => setRollNo(e.target.value)}
                  required
                  className="w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070b13] px-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Monthly Fee (PKR)</label>
                  <span className="text-[10px] text-orange-500 font-bold">Default: PKR {currentClass?.monthlyFee || '5000'}</span>
                </div>
                <input
                  type="number"
                  placeholder="Enter monthly fee"
                  value={studentFeeInput}
                  onChange={(e) => setStudentFeeInput(e.target.value)}
                  required
                  className="w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070b13] px-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 text-slate-900 dark:text-white"
                />
              </div>

              <div className="pt-2">
                <Button
                  type="submit"
                  disabled={!isWhatsappComplete}
                  className={`w-full py-5 rounded-2xl font-black text-xs transition-all active:scale-95 ${
                    isWhatsappComplete
                      ? 'bg-orange-500 hover:bg-orange-600 text-white shadow-[0_0_20px_rgba(249,115,22,0.35)]'
                      : 'bg-slate-300 dark:bg-slate-800 text-slate-500 cursor-not-allowed opacity-70'
                  }`}
                >
                  {editingStudent ? 'Update Student' : 'Save Student'}
                </Button>
              </div>
            </form>

          </div>
        </div>
      )}

      {/* PREMIUM INFO MODAL — self-contained; no route exists to verify, so this explains the
          feature and performs no payment processing or permission changes. */}
      {/* STICKY BOTTOM NAVIGATION POOL */}
      <div className="fixed bottom-0 left-0 right-0 z-40 px-4 pb-4 pt-2 bg-gradient-to-t from-[#f8fafc] via-[#f8fafc]/90 to-transparent dark:from-[#070b13] dark:via-[#070b13]/90">
        <nav className="mx-auto max-w-md bg-white/80 dark:bg-[#0c1222]/90 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/40 rounded-3xl shadow-[0_15px_35px_-5px_rgba(0,0,0,0.08)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] px-3 py-2 flex items-center justify-between">
          {navigationTabs.map((tab) => {
            const IconComponent = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <Link
                key={tab.id}
                to={tab.href}
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id === 'classes' && activeClassId) {
                    handleBackToClasses();
                  }
                }}
                className="flex flex-col items-center justify-center flex-1 py-1 relative group"
              >
                <div
                  className={`p-2 rounded-2xl transition-all duration-300 relative ${
                    isActive
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30 scale-105'
                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  <IconComponent className="h-4 w-4" />
                </div>

                <span
                  className={`text-[9px] font-bold tracking-tight mt-1 transition-colors ${
                    isActive
                      ? 'text-orange-600 dark:text-orange-400 font-extrabold'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {tab.label}
                </span>

                {isActive && (
                  <div className="absolute top-0 h-1 w-1 bg-orange-500 rounded-full shadow-[0_0_8px_#f97316]" />
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
