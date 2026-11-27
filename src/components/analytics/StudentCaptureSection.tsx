import { useMemo } from 'react';
import {
  AlertCircle,
  Award,
  CheckCircle2,
  GraduationCap,
  SlidersHorizontal,
  ThumbsUp,
  TrendingUp,
  XCircle,
} from 'lucide-react';

/**
 * This component deliberately does not query Firestore.
 * AnalyticsPage is the single source of truth for class, attendance, and quiz data.
 * Keeping this component presentational avoids a second listener with a different
 * path/permission contract and prevents local listener failures from replacing
 * the calculated values passed in through capturedStudents.
 */
export type StudentCaptureCriteria =
  | 'Weighted Score'
  | 'Attendance Rate'
  | 'Quiz Marks'
  | 'overallScore'
  | 'manualTag';

interface CaptureClassRecord {
  id: string | number;
  name?: unknown;
  className?: unknown;
  students?: unknown;
}

type CaptureStudentRecord = Record<string, unknown>;

type CapturedStudents = Partial<{
  excellent: CaptureStudentRecord;
  good: CaptureStudentRecord;
  average: CaptureStudentRecord;
  poor: CaptureStudentRecord;
}>;

interface StudentCaptureSectionProps {
  classes: CaptureClassRecord[];
  selectedClassId: string;
  onSelectClassId: (id: string) => void;
  captureCriteria: StudentCaptureCriteria;
  onOpenSettingsModal: () => void;
  capturedStudents: CapturedStudents | Record<string, CaptureStudentRecord | undefined>;
  captureWarning?: string | null;
}

const CATEGORY_META = {
  excellent: {
    label: 'EXCELLENT',
    icon: Award,
    badge: 'bg-emerald-500',
    border: 'border-emerald-200',
    score: 'text-emerald-600',
  },
  good: {
    label: 'GOOD',
    icon: ThumbsUp,
    badge: 'bg-blue-500',
    border: 'border-blue-200',
    score: 'text-blue-600',
  },
  average: {
    label: 'AVERAGE',
    icon: TrendingUp,
    badge: 'bg-amber-500',
    border: 'border-amber-200',
    score: 'text-amber-600',
  },
  poor: {
    label: 'POOR',
    icon: XCircle,
    badge: 'bg-rose-500',
    border: 'border-rose-200',
    score: 'text-rose-600',
  },
} as const;

type CategoryKey = keyof typeof CATEGORY_META;
const CATEGORY_KEYS: CategoryKey[] = ['excellent', 'good', 'average', 'poor'];

const criteriaLabel = (criteria: StudentCaptureCriteria): string => {
  if (criteria === 'overallScore') return 'Overall Score';
  if (criteria === 'manualTag') return 'Manual Tags';
  return criteria;
};

const toValidPercent = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
};

const formatPercent = (raw: unknown): string => {
  const value = toValidPercent(raw);
  return value === null ? '—' : `${Math.round(value * 100) / 100}%`;
};

const primaryMetric = (student: CaptureStudentRecord | undefined, criteria: StudentCaptureCriteria): number | null => {
  if (!student) return null;
  if (criteria === 'Quiz Marks') return toValidPercent(student.quizScore ?? student.quizMarks);
  if (criteria === 'Attendance Rate') return toValidPercent(student.attendance ?? student.attendanceRate);
  if (criteria === 'Weighted Score') return toValidPercent(student.overallScore ?? student.weightedScore);
  if (criteria === 'overallScore') return toValidPercent(student.overallScore);
  return null;
};

const getAvatar = (student: CaptureStudentRecord | undefined): string | null => {
  if (!student) return null;
  const raw = student.avatar ?? student.profileImage ?? student.photoURL ?? student.photoUrl;
  return typeof raw === 'string' && raw.trim() ? raw : null;
};

export function StudentCaptureSection({
  classes,
  selectedClassId,
  onSelectClassId,
  captureCriteria,
  onOpenSettingsModal,
  capturedStudents,
  captureWarning = null,
}: StudentCaptureSectionProps) {
  const activeClass = useMemo(
    () => classes.find((item) => item.id === selectedClassId) ?? null,
    [classes, selectedClassId],
  );

  const studentCount = Array.isArray(activeClass?.students) ? activeClass.students.length : 0;
  const captured = capturedStudents;
  const hasAnyCapturedStudent = CATEGORY_KEYS.some((key) => Boolean(captured?.[key]));
  const warningApplies = (captureCriteria === 'Quiz Marks' || captureCriteria === 'Weighted Score') && Boolean(captureWarning);

  return (
    <section className="rounded-[2rem] border-2 border-orange-500 bg-white dark:bg-[#0c1222] p-5 sm:p-6 shadow-[0_0_42px_rgba(249,115,22,0.24)] space-y-4">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
        <div className="min-w-0 space-y-2">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wide text-orange-600">
            <GraduationCap className="h-3.5 w-3.5" /> Class Student Capture
          </div>
          <h2 className="text-sm sm:text-base font-black leading-snug text-slate-900 dark:text-slate-100">
            Class Category Representatives ({studentCount} Students)
          </h2>
          <p className="text-[10px] font-bold text-slate-400">
            Captured based on: <span className="inline-block ml-1 rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-orange-600">{criteriaLabel(captureCriteria)}</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-1 rounded-full border border-slate-200 bg-slate-50 dark:bg-slate-900 dark:border-slate-700 p-1 shrink-0">
          {classes.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectClassId(String(item.id))}
              className={`rounded-full px-4 py-2.5 text-[10px] sm:text-xs font-black transition-colors ${
                item.id === selectedClassId
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
              aria-pressed={item.id === selectedClassId}
            >
              {String(item.name ?? item.className ?? 'Unnamed class')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 dark:bg-slate-900 dark:border-slate-700 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase text-slate-400">
          <SlidersHorizontal className="h-3.5 w-3.5 text-orange-500" /> Filter:
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          {(['Weighted Score', 'Attendance Rate', 'Quiz Marks'] as StudentCaptureCriteria[]).map((criteria) => (
            <button
              key={criteria}
              type="button"
              onClick={onOpenSettingsModal}
              className={`rounded-full px-2.5 py-1.5 text-[10px] font-black transition-colors ${
                captureCriteria === criteria
                  ? 'bg-blue-500 text-white'
                  : 'text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
              title="Open capture settings to change the ranking rule"
            >
              {criteria}
            </button>
          ))}
          <button
            type="button"
            onClick={onOpenSettingsModal}
            className="rounded-full p-1.5 text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Open capture settings"
            title="Capture settings"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {warningApplies && (
        <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-xs font-semibold leading-relaxed text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{captureWarning}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {CATEGORY_KEYS.map((category) => {
          const meta = CATEGORY_META[category];
          const CategoryIcon = meta.icon;
          const student = captured?.[category];
          const mainMetric = primaryMetric(student, captureCriteria);
          const avatar = getAvatar(student);
          const studentName = student ? String(student.name ?? '') : '';
          const hasStudentName = Boolean(studentName.trim());

          return (
            <article key={category} className={`min-w-0 rounded-3xl border ${meta.border} bg-white dark:bg-[#0c1222] p-3.5 sm:p-4 flex flex-col gap-3`}>
              <div className="flex items-center justify-between gap-3">
                <span className={`inline-flex items-center gap-1 rounded-full ${meta.badge} px-2.5 py-1 text-[9px] font-black text-white`}>
                  <CategoryIcon className="h-3 w-3" /> {meta.label}
                </span>
                <span className={`text-[10px] font-black ${meta.score}`}>
                  {captureCriteria === 'manualTag' ? (hasStudentName ? 'TAGGED' : '—') : formatPercent(mainMetric)}
                </span>
              </div>

              {hasStudentName ? (
                <>
                  <div className="flex min-w-0 items-center gap-3">
                    {avatar ? (
                      <img
                        src={avatar}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-9 w-9 shrink-0 rounded-full border-2 border-orange-200 object-cover"
                        onError={(event) => {
                          event.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="h-9 w-9 shrink-0 rounded-full bg-orange-50 text-orange-600 flex items-center justify-center font-black text-xs">
                        {studentName.trim().slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-xs font-black text-slate-900 dark:text-slate-100">{studentName}</p>
                      <p className="mt-0.5 text-[10px] font-bold text-slate-400">
                        Roll: {String(student.rollNo ?? student.rollNumber ?? '—')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 pt-2 text-[9px] font-black text-slate-400">
                    <span>Quiz: {formatPercent(student.quizScore ?? student.quizMarks)}</span>
                    <span>Att: {formatPercent(student.attendance ?? student.attendanceRate)}</span>
                  </div>
                </>
              ) : (
                <div className="flex min-h-[72px] items-center justify-center text-center text-[11px] font-bold text-slate-400">
                  {hasAnyCapturedStudent ? 'No student assigned to this category' : 'No valid score available'}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {!hasAnyCapturedStudent && !warningApplies && (
        <p className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
          <CheckCircle2 className="h-4 w-4 text-slate-400" />
          No ranked student data is available for the selected class and month yet.
        </p>
      )}
    </section>
  );
}

export default StudentCaptureSection;
