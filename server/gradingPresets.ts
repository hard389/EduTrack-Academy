import { FieldValue } from 'firebase-admin/firestore';
import { getFirebaseAdminFirestore, verifyAdminRequest } from './firebaseAdmin.js';
import { verifyTeacherRequest } from './teacherAuth.js';

export type GradingRatingLevel = 'Excellent' | 'Good' | 'Average' | 'Poor';
export type GradingRemarkCategory = 'Homework' | 'Behavior' | 'Participation' | 'Performance' | 'Remarks';
export type GradingPresetMap = Record<GradingRatingLevel, Record<GradingRemarkCategory, string>>;

export const GRADING_RATING_LEVELS: readonly GradingRatingLevel[] = ['Excellent', 'Good', 'Average', 'Poor'];
export const GRADING_REMARK_CATEGORIES: readonly GradingRemarkCategory[] = [
  'Homework', 'Behavior', 'Participation', 'Performance', 'Remarks',
];

/**
 * Initial platform defaults migrated from the former teacher-side AUTO_FILL_REMARKS map.
 * Admin edits are persisted centrally at platformSettings/gradingPresets and take precedence.
 */
export const DEFAULT_GRADING_PRESETS: GradingPresetMap = {
  Excellent: {
    Homework: 'Dear {{father_name}}, {{name}} consistently completes homework excellently and shows wonderful dedication to learning.',
    Behavior: 'Dear {{father_name}}, {{name}} demonstrates excellent manners, respect, and kindness toward teachers and classmates.',
    Participation: 'Dear {{father_name}}, {{name}} actively participates in class and shares thoughtful ideas with confidence.',
    Performance: 'Dear {{father_name}}, {{name}} demonstrates outstanding academic progress and an excellent understanding of the lessons.',
    Remarks: 'Dear {{father_name}}, {{name}} is doing a wonderful job; keep up the excellent work and continue shining!',
  },
  Good: {
    Homework: 'Dear {{father_name}}, {{name}} completes homework regularly and shows good effort and understanding.',
    Behavior: 'Dear {{father_name}}, {{name}} behaves respectfully and maintains a positive attitude toward others.',
    Participation: 'Dear {{father_name}}, {{name}} participates well in class and shows a genuine interest in learning.',
    Performance: 'Dear {{father_name}}, {{name}} is making good academic progress and applying learned concepts effectively.',
    Remarks: 'Dear {{father_name}}, {{name}} is doing well; consistent effort will help achieve even greater success.',
  },
  Average: {
    Homework: 'Dear {{father_name}}, {{name}} is encouraged to complete homework regularly and pay greater attention to detail.',
    Behavior: 'Dear {{father_name}}, {{name}} is encouraged to maintain respectful behavior and develop positive classroom habits.',
    Participation: 'Dear {{father_name}}, {{name}} can improve further by participating more actively in classroom activities.',
    Performance: 'Dear {{father_name}}, {{name}} is developing a basic understanding of the lessons and would benefit from regular practice.',
    Remarks: 'Dear {{father_name}}, with continued support and consistent effort, {{name}} can make encouraging progress.',
  },
  Poor: {
    Homework: 'Dear {{father_name}}, {{name}} needs encouragement to complete homework regularly and seek help when needed.',
    Behavior: 'Dear {{father_name}}, {{name}} is encouraged to follow classroom rules and develop respectful, positive behavior.',
    Participation: 'Dear {{father_name}}, your encouragement can help {{name}} participate more actively and confidently in class.',
    Performance: 'Dear {{father_name}}, {{name}} would benefit from additional practice, regular revision, and focused academic support.',
    Remarks: 'Dear {{father_name}}, working together with the school can help {{name}} build confidence and achieve better results.',
  },
};

export type GradingPresetsRequest = {
  method?: string;
  headers?: { authorization?: string | string[]; [key: string]: string | string[] | undefined };
  body?: unknown;
};

export class GradingPresetsError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GradingPresetsError';
  }
}

const presetDocument = () => getFirebaseAdminFirestore().collection('platformSettings').doc('gradingPresets');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fill missing legacy fields with platform defaults while preserving valid saved text. */
export function normalizeGradingPresets(value: unknown): GradingPresetMap {
  const source = isRecord(value) ? value : {};
  const result = {} as GradingPresetMap;

  for (const level of GRADING_RATING_LEVELS) {
    const sourceLevel = isRecord(source[level]) ? source[level] as Record<string, unknown> : {};
    const targetLevel = {} as Record<GradingRemarkCategory, string>;
    for (const category of GRADING_REMARK_CATEGORIES) {
      const candidate = sourceLevel[category];
      targetLevel[category] = typeof candidate === 'string' && candidate.trim()
        ? candidate.trim()
        : DEFAULT_GRADING_PRESETS[level][category];
    }
    result[level] = targetLevel;
  }

  return result;
}

function validateGradingPresets(value: unknown): GradingPresetMap {
  if (!isRecord(value)) {
    throw new GradingPresetsError(400, 'A complete grading presets object is required.');
  }

  const normalized = {} as GradingPresetMap;
  for (const level of GRADING_RATING_LEVELS) {
    const levelValue = value[level];
    if (!isRecord(levelValue)) {
      throw new GradingPresetsError(400, `Missing grading level: ${level}.`);
    }
    const categoryValues = {} as Record<GradingRemarkCategory, string>;
    for (const category of GRADING_REMARK_CATEGORIES) {
      const text = levelValue[category];
      if (typeof text !== 'string' || !text.trim()) {
        throw new GradingPresetsError(400, `${level} / ${category} remark cannot be empty.`);
      }
      if (text.trim().length > 1200) {
        throw new GradingPresetsError(400, `${level} / ${category} remark must be 1,200 characters or fewer.`);
      }
      categoryValues[category] = text.trim();
    }
    normalized[level] = categoryValues;
  }

  return normalized;
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (isRecord(value) && typeof value.toDate === 'function') {
    try {
      const date = (value.toDate as () => Date)();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
    ? new Date(value).toISOString()
    : null;
}

export async function getAdminGradingPresets(request: GradingPresetsRequest) {
  const actor = await verifyAdminRequest({ headers: request.headers ?? {} });
  const ref = presetDocument();
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    const presets = DEFAULT_GRADING_PRESETS;
    await ref.set({
      presets,
      schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actor.uid,
      updatedByEmail: actor.email,
    }, { merge: true });
    return { success: true, presets, updatedAt: new Date().toISOString(), seeded: true };
  }

  const data = snapshot.data() ?? {};
  return {
    success: true,
    presets: normalizeGradingPresets(data.presets),
    updatedAt: toIsoDate(data.updatedAt),
    seeded: false,
  };
}

export async function saveAdminGradingPresets(request: GradingPresetsRequest) {
  const actor = await verifyAdminRequest({ headers: request.headers ?? {} });
  if (!isRecord(request.body)) {
    throw new GradingPresetsError(400, 'A valid JSON request body is required.');
  }

  const presets = validateGradingPresets(request.body.presets);
  await presetDocument().set({
    presets,
    schemaVersion: 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
  }, { merge: true });

  return { success: true, presets, updatedAt: new Date().toISOString() };
}

export async function getTeacherGradingPresets(request: GradingPresetsRequest) {
  const actor = await verifyTeacherRequest({ headers: request.headers ?? {} });
  const snapshot = await actor.db.collection('platformSettings').doc('gradingPresets').get();
  const data = snapshot.data() ?? {};
  return {
    success: true,
    presets: snapshot.exists ? normalizeGradingPresets(data.presets) : DEFAULT_GRADING_PRESETS,
    // Used only to recognize untouched presets created by the old hardcoded Auto Fill.
    // This lets the teacher UI migrate those defaults while preserving custom wording.
    legacyDefaults: DEFAULT_GRADING_PRESETS,
    updatedAt: snapshot.exists ? toIsoDate(data.updatedAt) : null,
  };
}

export function sendGradingPresetsError(
  response: { setHeader(name: string, value: string): void; status(code: number): { json(body: unknown): unknown } },
  error: unknown,
) {
  const rawStatus = Number((error as { status?: unknown })?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  if (status >= 500) {
    console.error('[GradingPresets] Request failed.', error instanceof Error ? error.name : 'UnknownError');
  }
  response.setHeader('Cache-Control', 'no-store');
  const message = status >= 500
    ? 'The grading presets service could not complete the request.'
    : error instanceof Error ? error.message : 'The request is invalid.';
  return response.status(status).json({ success: false, error: message });
}
