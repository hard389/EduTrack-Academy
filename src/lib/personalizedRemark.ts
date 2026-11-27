/**
 * Shared, pure helpers for reusable grading-remark templates.
 *
 * The real EduTrack student schema stores `name` and `fatherName` on entries
 * inside users/{teacherEmail}/classes/{classId}. The resolver deliberately
 * accepts a normalized student identity rather than reading Firestore itself,
 * so each report caller must pass the record matching its own student ID.
 */

export type RatingLevel = 'Excellent' | 'Good' | 'Average' | 'Poor';
export type RemarkCategory = 'Homework' | 'Behavior' | 'Participation' | 'Performance' | 'Remarks';
export type PersonalizedRemarkVariable = 'name' | 'first_name' | 'father_name';

export interface RemarkPresetRecord {
  id: string;
  category: RemarkCategory;
  remarkText: string;
  [key: string]: unknown;
}

export type NormalizedRemarksMap = Record<RatingLevel, RemarkPresetRecord[]>;

/** Values from the exact student record selected by the report workflow. */
export interface PersonalizedRemarkStudent {
  /** Existing EduTrack student field: `name` (full name). */
  name?: string | null;
  /** Optional explicit first name; if absent, the first token of `name` is used. */
  firstName?: string | null;
  /** Existing EduTrack student field: `fatherName`. */
  fatherName?: string | null;
}

export interface PersonalizedRemarkResolution {
  /** Final user-facing text. Missing fields become explicit, non-fabricated markers. */
  text: string;
  /** Variables whose student field was blank or unavailable. */
  missingVariables: PersonalizedRemarkVariable[];
  /** True when the original template contained one or more supported variables. */
  hasVariables: boolean;
}

export interface TextInsertionResult {
  value: string;
  cursorPosition: number;
}

export const RATING_LEVELS: readonly RatingLevel[] = ['Excellent', 'Good', 'Average', 'Poor'];
export const REMARK_CATEGORIES: readonly RemarkCategory[] = [
  'Homework', 'Behavior', 'Participation', 'Performance', 'Remarks',
];

const KNOWN_VARIABLES: readonly PersonalizedRemarkVariable[] = ['name', 'first_name', 'father_name'];
const VARIABLE_PATTERN = /\{\{\s*(name|first_name|father_name)\s*\}\}/g;
const MISSING_VALUE_TEXT: Record<PersonalizedRemarkVariable, string> = {
  name: '[student name unavailable]',
  first_name: '[first name unavailable]',
  father_name: "[father's name not recorded]",
};

function cleanField(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || /^(?:n\/?a|not available|not recorded|undefined|null)$/i.test(trimmed)) return '';
  return trimmed;
}

/**
 * Replaces every supported token without evaluating code or mutating the template.
 * Missing fields are replaced by explicit markers and also returned as warnings.
 */
export function resolvePersonalizedRemark(
  template: string | null | undefined,
  student?: PersonalizedRemarkStudent | null,
): PersonalizedRemarkResolution {
  const source = typeof template === 'string' ? template : '';
  const missing = new Set<PersonalizedRemarkVariable>();
  const hasVariables = KNOWN_VARIABLES.some((variable) =>
    new RegExp(`\\{\\{\\s*${variable}\\s*\\}\\}`).test(source),
  );

  const name = cleanField(student?.name);
  const explicitFirstName = cleanField(student?.firstName);
  const firstName = explicitFirstName || (name ? name.split(/\s+/u)[0] : '');
  const fatherName = cleanField(student?.fatherName);

  const values: Record<PersonalizedRemarkVariable, string> = {
    name,
    first_name: firstName,
    father_name: fatherName,
  };

  const text = source.replace(VARIABLE_PATTERN, (_token, rawVariable: string) => {
    const variable = rawVariable as PersonalizedRemarkVariable;
    const value = values[variable];
    if (value) return value;
    missing.add(variable);
    return MISSING_VALUE_TEXT[variable];
  });

  return { text, missingVariables: Array.from(missing), hasVariables };
}

/** Cursor-safe insertion helper shared by GradingTab and focused unit tests. */
export function insertTextAtSelection(
  currentText: string,
  insertion: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): TextInsertionResult {
  const text = typeof currentText === 'string' ? currentText : '';
  const startCandidate = typeof selectionStart === 'number' && Number.isFinite(selectionStart)
    ? selectionStart
    : text.length;
  const start = Math.max(0, Math.min(text.length, Math.trunc(startCandidate)));
  const endCandidate = typeof selectionEnd === 'number' && Number.isFinite(selectionEnd)
    ? selectionEnd
    : start;
  const end = Math.max(start, Math.min(text.length, Math.trunc(endCandidate)));
  const token = typeof insertion === 'string' ? insertion : '';
  const value = `${text.slice(0, start)}${token}${text.slice(end)}`;
  return { value, cursorPosition: start + token.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRemarkCategory(value: unknown): value is RemarkCategory {
  return typeof value === 'string' && (REMARK_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Reads both the current array-based format and the legacy per-rating string format.
 * A legacy string becomes one Remarks preset so it is retained when the user saves.
 */
export function normalizeRemarksMap(value: unknown): NormalizedRemarksMap {
  const raw = isRecord(value) ? value : {};
  const result = {} as NormalizedRemarksMap;

  for (const level of RATING_LEVELS) {
    const entry = raw[level];
    if (typeof entry === 'string') {
      result[level] = entry.trim()
        ? [{ id: `legacy-${level.toLowerCase()}`, category: 'Remarks', remarkText: entry }]
        : [];
      continue;
    }

    if (!Array.isArray(entry)) {
      result[level] = [];
      continue;
    }

    result[level] = entry.reduce<RemarkPresetRecord[]>((items, candidate, index) => {
      if (!isRecord(candidate) || typeof candidate.remarkText !== 'string' || !isRemarkCategory(candidate.category)) {
        return items;
      }
      const id = typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id
        : `${level.toLowerCase()}-${index + 1}`;
      // Spread unknown fields to avoid silently discarding legacy preset metadata.
      items.push({ ...candidate, id, category: candidate.category, remarkText: candidate.remarkText });
      return items;
    }, []);
  }

  return result;
}

/** Firestore payload builder keeps the established remarksMap shape and template tokens. */
export function serializeRemarksMap(value: unknown): NormalizedRemarksMap {
  const normalized = normalizeRemarksMap(value);
  return {
    Excellent: normalized.Excellent.map((item) => ({ ...item })),
    Good: normalized.Good.map((item) => ({ ...item })),
    Average: normalized.Average.map((item) => ({ ...item })),
    Poor: normalized.Poor.map((item) => ({ ...item })),
  };
}

/**
 * Existing ReportsDashboard chooses a rating but does not expose a preset-category picker.
 * Prefer the general Remarks template, then Performance, then the first saved preset.
 * Legacy string templates remain supported; source text is returned without interpolation.
 */
export function getRemarkTemplateForRating(remarksMapValue: unknown, level: RatingLevel): string | null {
  const raw = isRecord(remarksMapValue) ? remarksMapValue[level] : undefined;
  if (typeof raw === 'string') return raw.trim() ? raw : null;
  if (!Array.isArray(raw)) return null;

  const presets = normalizeRemarksMap({ [level]: raw })[level]
    .filter((item) => item.remarkText.trim());
  const preferred = presets.find((item) => item.category === 'Remarks')
    || presets.find((item) => item.category === 'Performance')
    || presets[0];
  return preferred ? preferred.remarkText : null;
}
