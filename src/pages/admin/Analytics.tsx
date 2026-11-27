import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { User } from 'firebase/auth';
import {
  Activity,
  AlertCircle,
  BadgeCheck,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cpu,
  Database,
  Download,
  Gauge,
  GraduationCap,
  Layers3,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Signal,
  Users,
  Zap,
} from 'lucide-react';

/**
 * EduTrack Admin Analytics
 *
 * Mounts as a child route of AdminDashboard and consumes its Outlet context.
 * All figures and charts are derived from protected admin endpoints. No fake
 * series, placeholder revenue, or fabricated activity events are generated.
 *
 * Expected API contracts:
 * GET /api/admin/dashboard
 *
 * The endpoint must verify the Firebase ID token and administrator role on
 * the trusted backend. This frontend does not replace backend authorization.
 */

type AdminOutletContext = {
  adminUser: User | null;
  localDark: boolean;
};

type NullableNumber = number | null;
type AccountStatus = 'active' | 'disabled' | 'unknown';

type Teacher = {
  uid: string;
  name: string;
  email: string;
  createdAt: string | null;
  active: boolean | null;
  classCount: NullableNumber;
  enrollmentCount: NullableNumber;
  uniqueStudentCount: NullableNumber;
  whatsappNumber: string | null;
};

type RegistrationPoint = { month: string; count: number };
type DashboardPayload = {
  generatedAt: string | null;
  summary: {
    totalTeachers: NullableNumber;
    activeTeachers: NullableNumber;
    disabledTeachers: NullableNumber;
    totalClasses: NullableNumber;
    totalEnrollments: NullableNumber;
    uniqueStudents: NullableNumber;
  };
  teachers: Teacher[];
  registrations: RegistrationPoint[];
  coverage: { complete: boolean; warnings: string[] };
};

type ApiFailure = Error & { status?: number };

const DASHBOARD_ENDPOINT = import.meta.env.VITE_ADMIN_DASHBOARD_ENDPOINT || '/api/admin/dashboard';
const REFRESH_INTERVAL_MS = 5 * 60_000;

const emptyDashboard: DashboardPayload = {
  generatedAt: null,
  summary: {
    totalTeachers: null,
    activeTeachers: null,
    disabledTeachers: null,
    totalClasses: null,
    totalEnrollments: null,
    uniqueStudents: null,
  },
  teachers: [],
  registrations: [],
  coverage: { complete: false, warnings: [] },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toCount = (value: unknown): NullableNumber => {
  const parsed = toNumber(value);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : null;
};

const toIsoDate = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (isRecord(value)) {
    const seconds = toNumber(value.seconds ?? value._seconds);
    if (seconds !== null) {
      const parsed = new Date(seconds * 1000);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
  }
  return null;
};

const normalizeTeacher = (value: unknown): Teacher | null => {
  if (!isRecord(value)) return null;
  const role = (toText(value.role) || 'teacher').toLowerCase();
  if (role !== 'teacher') return null;
  const email = toText(value.email) || '';
  const uid = toText(value.uid) || toText(value.id) || email;
  if (!uid) return null;

  let active: boolean | null = null;
  if (typeof value.active === 'boolean') active = value.active;
  else if (typeof value.isActive === 'boolean') active = value.isActive;
  else if (typeof value.status === 'string') {
    const status = value.status.toLowerCase();
    if (status === 'active') active = true;
    if (status === 'disabled' || status === 'inactive') active = false;
  }

  return {
    uid,
    name: toText(value.teacherName) || toText(value.name) || toText(value.displayName) || email.split('@')[0] || 'Unnamed teacher',
    email,
    createdAt: toIsoDate(value.createdAt),
    active,
    classCount: toCount(value.classCount ?? value.totalClasses ?? value.classesCount),
    enrollmentCount: toCount(value.enrollmentCount ?? value.totalEnrollments ?? value.studentEnrollments),
    uniqueStudentCount: toCount(value.uniqueStudentCount),
    whatsappNumber: toText(value.whatsappNumber) || toText(value.phone),
  };
};

const parseDashboard = (raw: unknown): DashboardPayload => {
  if (!isRecord(raw) || !isRecord(raw.summary) || !Array.isArray(raw.teachers)) {
    throw new Error('Admin dashboard response is missing the required summary or teachers array.');
  }
  const summarySource = raw.summary;
  const coverageSource = isRecord(raw.coverage) ? raw.coverage : {};
  const registrationsSource = Array.isArray(raw.registrationsByMonth)
    ? raw.registrationsByMonth
    : Array.isArray(raw.monthlyRegistrations)
      ? raw.monthlyRegistrations
      : [];

  const registrations = registrationsSource
    .filter(isRecord)
    .map((point) => ({
      month: toText(point.month) || toText(point.key) || '',
      count: toCount(point.count ?? point.registrations) ?? -1,
    }))
    .filter((point) => /^\d{4}-\d{2}$/.test(point.month) && point.count >= 0)
    .sort((a, b) => a.month.localeCompare(b.month));

  const warnings = Array.isArray(coverageSource.warnings)
    ? coverageSource.warnings.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    generatedAt: toIsoDate(raw.generatedAt ?? raw.updatedAt),
    summary: {
      totalTeachers: toCount(summarySource.totalTeachers ?? summarySource.totalCustomers ?? summarySource.teacherCount),
      activeTeachers: toCount(summarySource.activeTeachers ?? summarySource.activeCustomers ?? summarySource.activeCount),
      disabledTeachers: toCount(summarySource.disabledTeachers ?? summarySource.disabledCustomers ?? summarySource.disabledCount),
      totalClasses: toCount(summarySource.totalClasses ?? summarySource.classCount),
      totalEnrollments: toCount(summarySource.totalEnrollments ?? summarySource.totalEnrolments ?? summarySource.enrollmentCount),
      uniqueStudents: toCount(summarySource.uniqueStudents ?? summarySource.uniqueStudentCount),
    },
    teachers: raw.teachers.map(normalizeTeacher).filter((teacher): teacher is Teacher => teacher !== null),
    registrations,
    coverage: { complete: coverageSource.complete === true, warnings },
  };
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
};

async function fetchAuthorized<T>(endpoint: string, user: User, signal?: AbortSignal): Promise<T> {
  const token = await user.getIdToken();
  const response = await fetch(endpoint, {
    method: 'GET',
    cache: 'no-store',
    signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  const responseText = await response.text();
  let payload: unknown = null;
  if (responseText) {
    try { payload = JSON.parse(responseText); } catch { payload = responseText; }
  }
  if (!response.ok) {
    const message = isRecord(payload) ? toText(payload.message) || toText(payload.error) : null;
    const friendly = response.status === 404
      ? `Admin API endpoint not found: ${endpoint}. Configure/deploy the protected backend endpoint.`
      : response.status === 401
        ? 'The session is no longer authorized. Sign in again.'
        : response.status === 403
          ? 'Access denied. This account is not authorized for administrator analytics.'
          : message || `Request failed with HTTP ${response.status}.`;
    const failure = new Error(friendly) as ApiFailure;
    failure.status = response.status;
    throw failure;
  }
  return payload as T;
}

const formatCount = (value: NullableNumber): string =>
  value === null ? 'Unavailable' : new Intl.NumberFormat('en-PK').format(value);

const formatMonth = (month: string): string => {
  const date = new Date(`${month}-01T12:00:00`);
  return Number.isNaN(date.getTime()) ? month : new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit' }).format(date);
};

const formatDateTime = (value: string | null): string => {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not reported' : new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const currentDay = (): string => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

function Panel({
  title,
  eyebrow,
  subtitle,
  accent = 'cyan',
  isDark,
  children,
  className = '',
}: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  accent?: 'cyan' | 'green' | 'orange' | 'violet' | 'rose';
  isDark: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const accentText = {
    cyan: 'text-cyan-500', green: 'text-emerald-500', orange: 'text-orange-500', violet: 'text-violet-500', rose: 'text-rose-500',
  }[accent];
  return (
    <section className={`relative min-w-0 overflow-hidden rounded-2xl border p-4 shadow-sm transition-colors sm:p-5 ${isDark ? 'border-slate-800 bg-[#0b1220]/95 text-slate-100 shadow-black/10' : 'border-slate-200 bg-white text-slate-900 shadow-slate-200/40'} ${className}`}>
      <div className={`pointer-events-none absolute left-0 top-0 h-px w-full ${accent === 'green' ? 'bg-emerald-400/60' : accent === 'orange' ? 'bg-orange-400/60' : accent === 'violet' ? 'bg-violet-400/60' : accent === 'rose' ? 'bg-rose-400/60' : 'bg-cyan-400/60'}`} />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? <p className={`mb-1 font-mono text-[9px] font-bold uppercase tracking-[0.23em] ${accentText}`}>{eyebrow}</p> : null}
          <h2 className="text-sm font-extrabold tracking-tight sm:text-base">{title}</h2>
          {subtitle ? <p className={`mt-1 max-w-2xl text-xs leading-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{subtitle}</p> : null}
        </div>
        <div className={`rounded-lg border p-2 ${isDark ? 'border-slate-700/70 bg-slate-900/70' : 'border-slate-200 bg-slate-50'}`}>
          <Activity size={15} className={accentText} />
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyChart({ title, detail, isDark }: { title: string; detail: string; isDark: boolean }) {
  return (
    <div className={`flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed px-5 py-8 text-center ${isDark ? 'border-slate-700 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}>
      <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-500'}`}><Signal size={18} /></div>
      <p className="text-xs font-bold">{title}</p>
      <p className={`mt-1 max-w-md text-[11px] leading-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{detail}</p>
    </div>
  );
}

function KpiCard({
  label, value, detail, icon: Icon, tone, isDark, tag,
}: {
  label: string; value: string; detail: string; icon: typeof Users; tone: 'cyan' | 'green' | 'orange' | 'violet' | 'rose' | 'blue'; isDark: boolean; tag?: string;
}) {
  const tones = {
    cyan: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
    green: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    orange: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
    violet: 'text-violet-400 bg-violet-400/10 border-violet-400/20',
    rose: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
    blue: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  }[tone];
  return (
    <article className={`group relative overflow-hidden rounded-2xl border p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-xl sm:p-5 ${isDark ? 'border-slate-800 bg-[#0b1220] hover:border-slate-700 hover:shadow-black/25' : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-slate-200/60'}`}>
      <div className={`pointer-events-none absolute -right-7 -top-7 h-24 w-24 rounded-full blur-2xl opacity-0 transition group-hover:opacity-100 ${tone === 'green' ? 'bg-emerald-400/10' : tone === 'orange' ? 'bg-orange-400/10' : tone === 'violet' ? 'bg-violet-400/10' : tone === 'rose' ? 'bg-rose-400/10' : tone === 'blue' ? 'bg-blue-400/10' : 'bg-cyan-400/10'}`} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`font-mono text-[9px] font-bold uppercase tracking-[0.17em] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
          <p className="mt-3 break-words text-2xl font-black tracking-tight tabular-nums sm:text-3xl">{value}</p>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${tones}`}><Icon size={19} /></div>
      </div>
      <div className="relative mt-4 flex items-start justify-between gap-2">
        <p className={`text-[10px] leading-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{detail}</p>
        {tag ? <span className={`shrink-0 rounded-md px-1.5 py-1 font-mono text-[8px] font-bold uppercase tracking-wider ${tones}`}>{tag}</span> : null}
      </div>
    </article>
  );
}

function LineChart({ data, isDark }: { data: RegistrationPoint[]; isDark: boolean }) {
  if (data.length < 2) {
    return <EmptyChart title="Registration history needs more data" detail="The protected admin API must return at least two real monthly points in registrationsByMonth. No synthetic history is added." isDark={isDark} />;
  }
  const width = 720;
  const height = 240;
  const padX = 24;
  const padTop = 18;
  const padBottom = 38;
  const chartHeight = height - padTop - padBottom;
  const chartWidth = width - padX * 2;
  const maximum = Math.max(1, ...data.map((d) => d.count));
  const points = data.map((point, index) => ({
    x: padX + (index / (data.length - 1)) * chartWidth,
    y: padTop + chartHeight - (point.count / maximum) * chartHeight,
    ...point,
  }));
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const area = `${line} L ${points[points.length - 1].x} ${height - padBottom} L ${points[0].x} ${height - padBottom} Z`;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]" /><span className={`font-mono text-[10px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>REGISTERED ACCOUNTS / MONTH</span></div>
        <span className={`font-mono text-[9px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>SOURCE: VERIFIED CREATED_AT</span>
      </div>
      <div className={`overflow-hidden rounded-xl border p-2 sm:p-3 ${isDark ? 'border-slate-800 bg-[#070d17]' : 'border-slate-200 bg-slate-50'}`}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Verified monthly teacher registration trend" className="h-auto w-full">
          <defs>
            <linearGradient id="analyticsLineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#34d399" stopOpacity="0.32" /><stop offset="100%" stopColor="#34d399" stopOpacity="0.01" /></linearGradient>
            <filter id="analyticsGlow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          {Array.from({ length: 5 }, (_, i) => {
            const y = padTop + (chartHeight / 4) * i;
            return <g key={i}><line x1={padX} y1={y} x2={width - padX} y2={y} stroke={isDark ? '#233044' : '#dbe3ec'} strokeDasharray="4 6" /><text x={padX - 3} y={y - 4} textAnchor="end" fill={isDark ? '#64748b' : '#94a3b8'} fontSize="9">{Math.round(maximum * (1 - i / 4))}</text></g>;
          })}
          <path d={area} fill="url(#analyticsLineFill)" />
          <path d={line} fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" filter="url(#analyticsGlow)" />
          {points.map((point) => <g key={point.month}><circle cx={point.x} cy={point.y} r="4" fill={isDark ? '#07101b' : '#ffffff'} stroke="#34d399" strokeWidth="2.5"><title>{`${formatMonth(point.month)}: ${point.count} registrations`}</title></circle></g>)}
          {points.map((point, index) => (index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 6) === 0) ? <text key={`${point.month}-label`} x={point.x} y={height - 12} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} fill={isDark ? '#94a3b8' : '#64748b'} fontSize="10">{formatMonth(point.month)}</text> : null)}
        </svg>
      </div>
    </div>
  );
}

function HorizontalBars({ rows, isDark, metricLabel }: { rows: Array<{ label: string; value: number }>; isDark: boolean; metricLabel: string }) {
  if (!rows.length) return <EmptyChart title="No verified records to chart" detail={`The admin data response did not provide usable ${metricLabel.toLowerCase()} values.`} isDark={isDark} />;
  const max = Math.max(1, ...rows.map((row) => row.value));
  const barTones = ['from-emerald-400 to-cyan-400', 'from-cyan-400 to-blue-500', 'from-orange-400 to-amber-400', 'from-violet-400 to-fuchsia-400', 'from-blue-400 to-indigo-400'];
  return (
    <div className="space-y-4">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`}>
          <div className="mb-1.5 flex items-center justify-between gap-3"><span className={`min-w-0 truncate text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`} title={row.label}>{String(index + 1).padStart(2, '0')} <span className="ml-1 opacity-90">{row.label}</span></span><span className={`shrink-0 font-mono text-[11px] font-bold tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{row.value.toLocaleString('en-PK')}</span></div>
          <div className={`h-2 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}><div className={`h-full rounded-full bg-gradient-to-r ${barTones[index % barTones.length]} transition-all duration-700`} style={{ width: `${row.value === 0 ? 0 : Math.max(2, (row.value / max) * 100)}%` }} title={`${row.value} ${metricLabel.toLowerCase()}`} /></div>
        </div>
      ))}
    </div>
  );
}

function DistributionBars({ teachers, metric, isDark }: { teachers: Teacher[]; metric: 'classes' | 'enrolments'; isDark: boolean }) {
  const field = metric === 'classes' ? 'classCount' : 'enrollmentCount';
  const known = teachers.map((teacher) => teacher[field]).filter((value): value is number => value !== null);
  if (!known.length) return <EmptyChart title="Distribution unavailable" detail={`The backend returned no verified ${metric === 'classes' ? 'class counts' : 'enrolment counts'} for the account set.`} isDark={isDark} />;
  const buckets = metric === 'classes'
    ? [{ label: '0', matches: (value: number) => value === 0 }, { label: '1', matches: (value: number) => value === 1 }, { label: '2–3', matches: (value: number) => value >= 2 && value <= 3 }, { label: '4–5', matches: (value: number) => value >= 4 && value <= 5 }, { label: '6+', matches: (value: number) => value >= 6 }]
    : [{ label: '0', matches: (value: number) => value === 0 }, { label: '1–10', matches: (value: number) => value >= 1 && value <= 10 }, { label: '11–25', matches: (value: number) => value >= 11 && value <= 25 }, { label: '26–50', matches: (value: number) => value >= 26 && value <= 50 }, { label: '51+', matches: (value: number) => value >= 51 }];
  const rows = buckets.map((bucket) => ({ label: bucket.label, value: known.filter(bucket.matches).length }));
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="flex h-48 items-end gap-3 sm:gap-5">
      {rows.map((row, index) => <div key={row.label} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${row.value} teacher accounts in ${row.label} ${metric === 'classes' ? 'classes' : 'enrolments'} band`}>
        <span className={`font-mono text-[10px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{row.value}</span>
        <div className={`flex h-[68%] w-full items-end justify-center rounded-t-lg ${isDark ? 'bg-slate-900/70' : 'bg-slate-100'}`}><div className={`w-[72%] rounded-t-md transition-all duration-700 ${index % 2 === 0 ? 'bg-gradient-to-t from-emerald-600 to-emerald-300' : 'bg-gradient-to-t from-cyan-700 to-cyan-300'}`} style={{ height: `${row.value === 0 ? 0 : Math.max(5, (row.value / max) * 100)}%` }} /></div>
        <span className={`font-mono text-[9px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{row.label}</span>
      </div>)}
    </div>
  );
}

function RingChart({ segments, total, isDark, centerLabel }: { segments: Array<{ label: string; value: number; color: string }>; total: number; isDark: boolean; centerLabel: string }) {
  if (total <= 0) return <EmptyChart title="No verified distribution" detail="A meaningful distribution requires non-zero counts from the authorized service." isDark={isDark} />;
  let cursor = 0;
  const stops = segments.map((segment) => {
    const start = cursor;
    const share = Math.max(0, segment.value) / total * 100;
    cursor += share;
    return `${segment.color} ${start}% ${cursor}%`;
  }).join(', ');
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="relative h-40 w-40 shrink-0 rounded-full" style={{ background: `conic-gradient(${stops})` }}>
        <div className={`absolute inset-[17px] flex flex-col items-center justify-center rounded-full ${isDark ? 'bg-[#0b1220]' : 'bg-white'}`}><span className={`font-mono text-2xl font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{total.toLocaleString('en-PK')}</span><span className={`mt-1 text-[9px] font-bold uppercase tracking-[0.16em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{centerLabel}</span></div>
      </div>
      <div className="w-full space-y-3">
        {segments.map((segment) => <div key={segment.label} className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: segment.color }} /><span className={`truncate text-xs ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{segment.label}</span></div><div className="text-right"><span className={`font-mono text-xs font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{segment.value.toLocaleString('en-PK')}</span><span className={`ml-2 font-mono text-[9px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{Math.round((segment.value / total) * 100)}%</span></div></div>)}
      </div>
    </div>
  );
}

export default function AdminAnalytics() {
  const { adminUser, localDark } = useOutletContext<AdminOutletContext>();
  const [rootDark, setRootDark] = useState<boolean>(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  const [dashboard, setDashboard] = useState<DashboardPayload>(emptyDashboard);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardReady, setDashboardReady] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [timeRange, setTimeRange] = useState<6 | 12 | 24>(12);
  const [teacherSearch, setTeacherSearch] = useState('');
  const [teacherSort, setTeacherSort] = useState<'enrolments' | 'classes' | 'name'>('enrolments');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setRootDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const loadAnalytics = useCallback(async (signal: AbortSignal) => {
    if (!adminUser) {
      setDashboardError('Administrator sign-in is required to access analytics.');
      setDashboardReady(false);
      return;
    }

    setDashboardLoading(true);
    setDashboardError(null);

    try {
      const raw = await fetchAuthorized<unknown>(DASHBOARD_ENDPOINT, adminUser, signal);
      if (signal.aborted) return;
      const parsed = parseDashboard(raw);
      setDashboard(parsed);
      setDashboardReady(true);
    } catch (error: unknown) {
      if (!signal.aborted) {
        setDashboardError(errorText(error));
        setDashboardReady(false);
      }
    } finally {
      if (!signal.aborted) {
        setDashboardLoading(false);
        setLastSync(new Date());
      }
    }
  }, [adminUser]);

  useEffect(() => {
    const controller = new AbortController();
    let interval: number | null = null;
    const startPolling = () => {
      if (interval !== null || document.visibilityState !== 'visible') return;
      interval = window.setInterval(() => {
        setRefreshKey((value) => value + 1);
      }, REFRESH_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setRefreshKey((value) => value + 1);
      } else {
        stopPolling();
        controller.abort();
      }
    };
    if (document.visibilityState === 'visible') {
      void loadAnalytics(controller.signal);
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      controller.abort();
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadAnalytics, refreshKey]);

  const isDark = rootDark;
  const surfaceDark = localDark;

  const accountStatus = useMemo(() => {
    const verifiedFlags = dashboard.teachers.filter((teacher) => teacher.active !== null);
    const inferredActive = dashboard.summary.activeTeachers ?? (dashboard.coverage.complete && verifiedFlags.length === dashboard.teachers.length ? verifiedFlags.filter((teacher) => teacher.active === true).length : null);
    const inferredDisabled = dashboard.summary.disabledTeachers ?? (dashboard.coverage.complete && verifiedFlags.length === dashboard.teachers.length ? verifiedFlags.filter((teacher) => teacher.active === false).length : null);
    const total = inferredActive !== null && inferredDisabled !== null ? inferredActive + inferredDisabled : 0;
    return { active: inferredActive, disabled: inferredDisabled, unknown: Math.max(0, total - (inferredActive || 0) - (inferredDisabled || 0)), total };
  }, [dashboard]);

  const filteredRegistrations = useMemo(() => {
    const now = new Date();
    now.setDate(1);
    now.setMonth(now.getMonth() - (timeRange - 1));
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const to = currentDay().slice(0, 7);
    return dashboard.registrations.filter((point) => point.month >= from && point.month <= to);
  }, [dashboard.registrations, timeRange]);

  const visibleTeachers = useMemo(() => {
    const term = teacherSearch.trim().toLowerCase();
    const filtered = dashboard.teachers.filter((teacher) => !term || [teacher.name, teacher.email, teacher.uid].some((item) => item.toLowerCase().includes(term)));
    return filtered.sort((a, b) => {
      if (teacherSort === 'classes') return (b.classCount ?? -1) - (a.classCount ?? -1);
      if (teacherSort === 'name') return a.name.localeCompare(b.name);
      return (b.enrollmentCount ?? -1) - (a.enrollmentCount ?? -1);
    }).slice(0, 8);
  }, [dashboard.teachers, teacherSearch, teacherSort]);

  const enrolmentLeaders = useMemo(() => dashboard.teachers
    .filter((teacher) => teacher.enrollmentCount !== null)
    .sort((a, b) => (b.enrollmentCount ?? 0) - (a.enrollmentCount ?? 0))
    .slice(0, 8)
    .map((teacher) => ({ label: teacher.name, value: teacher.enrollmentCount as number })), [dashboard.teachers]);

  const classLeaders = useMemo(() => dashboard.teachers
    .filter((teacher) => teacher.classCount !== null)
    .sort((a, b) => (b.classCount ?? 0) - (a.classCount ?? 0))
    .slice(0, 8)
    .map((teacher) => ({ label: teacher.name, value: teacher.classCount as number })), [dashboard.teachers]);

  const knownClasses = dashboard.teachers.filter((teacher) => teacher.classCount !== null);
  const knownEnrolments = dashboard.teachers.filter((teacher) => teacher.enrollmentCount !== null);
  const calculatedClasses = knownClasses.reduce((sum, teacher) => sum + (teacher.classCount || 0), 0);
  const calculatedEnrolments = knownEnrolments.reduce((sum, teacher) => sum + (teacher.enrollmentCount || 0), 0);
  const activeRate = accountStatus.total > 0 && accountStatus.active !== null ? Math.round(accountStatus.active / accountStatus.total * 100) : null;
  const dataCoverage = dashboard.teachers.length > 0 ? Math.round(((knownClasses.length + knownEnrolments.length) / (dashboard.teachers.length * 2)) * 100) : null;

  const exportVisibleTeachers = () => {
    if (!dashboardReady || !dashboard.teachers.length) return;
    const rows = [
      ['Teacher', 'Email', 'UID', 'Status', 'Classes', 'Class enrolments', 'Unique students'],
      ...visibleTeachers.map((teacher) => [teacher.name, teacher.email, teacher.uid, teacher.active === true ? 'Active profile flag' : teacher.active === false ? 'Disabled profile flag' : 'Unknown', teacher.classCount ?? '', teacher.enrollmentCount ?? '', teacher.uniqueStudentCount ?? '']),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'edutrack-analytics-teacher-summary.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`relative -mx-4 -my-6 min-h-[calc(100vh-72px)] overflow-hidden px-4 py-6 sm:-mx-6 sm:-my-8 sm:px-6 sm:py-8 lg:-mx-8 lg:px-8 ${isDark ? 'bg-[#050a12] text-slate-100' : 'bg-[#f3f6fb] text-slate-900'}`}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: `linear-gradient(${isDark ? '#8aa4c7' : '#334155'} 1px, transparent 1px), linear-gradient(90deg, ${isDark ? '#8aa4c7' : '#334155'} 1px, transparent 1px)`, backgroundSize: '36px 36px' }} />
      {isDark ? <div className="pointer-events-none absolute -top-28 left-1/4 h-72 w-72 rounded-full bg-emerald-500/10 blur-[100px]" /> : null}
      {isDark ? <div className="pointer-events-none absolute right-0 top-1/3 h-80 w-80 rounded-full bg-cyan-500/10 blur-[110px]" /> : null}

      <div className="relative mx-auto max-w-[1600px] space-y-6">
        <section className={`relative overflow-hidden rounded-3xl border p-5 shadow-2xl sm:p-7 lg:p-8 ${isDark ? 'border-emerald-400/20 bg-gradient-to-br from-[#07131a] via-[#0a1420] to-[#111022] shadow-black/30' : 'border-slate-200 bg-gradient-to-br from-white via-[#f8fbff] to-[#edfdf8] shadow-slate-200/60'}`}>
          <div className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(16,185,129,.035) 4px)' }} />
          <div className="pointer-events-none absolute right-[-36px] top-[-60px] h-64 w-64 rounded-full border border-emerald-400/10" /><div className="pointer-events-none absolute right-[-2px] top-[-27px] h-48 w-48 rounded-full border border-cyan-400/10" />
          <div className="relative flex flex-col justify-between gap-7 xl:flex-row xl:items-center">
            <div className="min-w-0 max-w-4xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[9px] font-black uppercase tracking-[0.22em] ${isDark ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-emerald-600/20 bg-emerald-50 text-emerald-700'}`}><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> NEXUS // ADMIN INTELLIGENCE</span>
                <span className={`rounded-full border px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider ${isDark ? 'border-slate-700 bg-slate-900/70 text-slate-400' : 'border-slate-200 bg-white/80 text-slate-500'}`}>Secure telemetry</span>
              </div>
              <h1 className="mt-5 text-3xl font-black tracking-[-0.05em] sm:text-4xl lg:text-5xl">Network <span className={isDark ? 'text-emerald-300' : 'text-emerald-600'}>intelligence</span></h1>
              <p className={`mt-3 max-w-2xl text-sm leading-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>A live analytical view of your EduTrack school network—teacher accounts, class distribution, enrolments and registration history.</p>
              <div className={`mt-5 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[9px] uppercase tracking-[0.13em] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}><span className="inline-flex items-center gap-2"><Database size={12} className="text-cyan-400" /> Source: protected admin API</span><span className="inline-flex items-center gap-2"><Clock3 size={12} /> Updated: {lastSync ? lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Waiting for first sync'}</span><span className="inline-flex items-center gap-2"><ShieldCheck size={12} className={dashboardReady ? 'text-emerald-400' : 'text-amber-400'} /> {dashboardReady ? 'Dashboard feed verified' : 'Feed awaiting response'}</span></div>
            </div>
            <div className="relative grid shrink-0 grid-cols-2 gap-3 xl:w-[300px]">
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-emerald-400/20 bg-black/20' : 'border-emerald-200 bg-white/80'}`}><p className={`font-mono text-[9px] uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Feed status</p><p className={`mt-2 text-sm font-black ${dashboardReady ? 'text-emerald-400' : 'text-amber-500'}`}>{dashboardLoading ? 'SYNCING' : dashboardReady ? 'ONLINE' : 'OFFLINE'}</p><div className={`mt-3 h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}><div className={`h-full rounded-full transition-all ${dashboardReady ? 'w-full bg-emerald-400' : dashboardLoading ? 'w-1/2 animate-pulse bg-amber-400' : 'w-1/12 bg-rose-500'}`} /></div></div>
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-cyan-400/20 bg-black/20' : 'border-cyan-200 bg-white/80'}`}><p className={`font-mono text-[9px] uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Coverage</p><p className="mt-2 text-sm font-black text-cyan-500">{dashboard.coverage.complete ? 'COMPLETE' : dataCoverage === null ? 'UNKNOWN' : `${dataCoverage}% FIELDS`}</p><p className={`mt-2 text-[9px] leading-4 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Known class/enrolment metrics</p></div>
              <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={dashboardLoading} className={`col-span-2 inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-xs font-black uppercase tracking-[0.12em] transition hover:border-emerald-400/50 hover:text-emerald-500 disabled:opacity-50 ${isDark ? 'border-slate-700 bg-slate-950/60 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}><RefreshCw size={14} className={dashboardLoading ? 'animate-spin' : ''} /> {dashboardLoading ? 'Refreshing telemetry…' : 'Refresh dashboard data'}</button>
            </div>
          </div>
        </section>



        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <KpiCard label="Teacher accounts" value={dashboardReady ? formatCount(dashboard.summary.totalTeachers ?? (dashboard.coverage.complete ? dashboard.teachers.length : null)) : 'Unavailable'} detail="Teacher profiles returned by the admin service." icon={Users} tone="cyan" isDark={surfaceDark} tag="USERS" />
          <KpiCard label="Active profiles" value={dashboardReady ? formatCount(dashboard.summary.activeTeachers) : 'Unavailable'} detail="Profile status flags, not an unverified Auth-state assumption." icon={BadgeCheck} tone="green" isDark={surfaceDark} tag="ACTIVE" />
          <KpiCard label="Disabled profiles" value={dashboardReady ? formatCount(dashboard.summary.disabledTeachers) : 'Unavailable'} detail="Accounts reported as disabled by the service." icon={ShieldAlert} tone="rose" isDark={surfaceDark} tag="REVIEW" />
          <KpiCard label="Academic classes" value={dashboardReady ? formatCount(dashboard.summary.totalClasses ?? (dashboard.coverage.complete && knownClasses.length === dashboard.teachers.length ? calculatedClasses : null)) : 'Unavailable'} detail="Total across returned teacher workspaces, where verified." icon={BookOpen} tone="violet" isDark={surfaceDark} tag="CLASSES" />
          <KpiCard label="Class enrolments" value={dashboardReady ? formatCount(dashboard.summary.totalEnrollments ?? (dashboard.coverage.complete && knownEnrolments.length === dashboard.teachers.length ? calculatedEnrolments : null)) : 'Unavailable'} detail="Enrolments may include a student in multiple classes." icon={GraduationCap} tone="orange" isDark={surfaceDark} tag="ENROLLED" />
          <KpiCard label="Unique students" value={dashboardReady ? formatCount(dashboard.summary.uniqueStudents) : 'Unavailable'} detail="Requires reliable cross-class student deduplication." icon={Users} tone="blue" isDark={surfaceDark} tag="DISTINCT" />
        </section>

        <section className="grid gap-5 xl:grid-cols-5">
          <Panel title="Registration pulse" eyebrow="01 / growth telemetry" subtitle="Verified monthly teacher registrations from createdAt-based historical records." accent="green" isDark={surfaceDark} className="xl:col-span-3">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className={`font-mono text-[9px] uppercase tracking-wider ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`}>Historical window</p><div className={`inline-flex rounded-lg border p-1 ${surfaceDark ? 'border-slate-700 bg-slate-950' : 'border-slate-200 bg-slate-50'}`}>{([6, 12, 24] as const).map((range) => <button key={range} type="button" onClick={() => setTimeRange(range)} className={`rounded-md px-3 py-1.5 font-mono text-[10px] font-bold transition ${timeRange === range ? 'bg-emerald-500 text-slate-950 shadow' : surfaceDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'}`}>{range}M</button>)}</div></div>
            {dashboardLoading && !dashboardReady ? <div className={`h-64 animate-pulse rounded-xl ${surfaceDark ? 'bg-slate-800/50' : 'bg-slate-100'}`} /> : <LineChart data={filteredRegistrations} isDark={surfaceDark} />}
            {dashboardReady ? <p className={`mt-3 font-mono text-[9px] ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`}>POINTS: {filteredRegistrations.length} REAL MONTHLY RECORDS · NO SYNTHETIC SERIES</p> : null}
          </Panel>

          <Panel title="Account posture" eyebrow="02 / status telemetry" subtitle="Current account-status distribution when status counts are verified." accent="cyan" isDark={surfaceDark} className="xl:col-span-2">
            {dashboardLoading && !dashboardReady ? <div className={`h-56 animate-pulse rounded-xl ${surfaceDark ? 'bg-slate-800/50' : 'bg-slate-100'}`} /> : accountStatus.active === null || accountStatus.disabled === null ? <EmptyChart title="Verified status counts unavailable" detail="Return activeTeachers and disabledTeachers from the trusted admin endpoint, or provide complete status flags for every returned teacher." isDark={surfaceDark} /> : <RingChart isDark={surfaceDark} centerLabel="KNOWN FLAGS" total={accountStatus.active + accountStatus.disabled} segments={[{ label: 'Active profiles', value: accountStatus.active, color: '#34d399' }, { label: 'Disabled profiles', value: accountStatus.disabled, color: '#fb7185' }]} />}
            {activeRate !== null ? <div className={`mt-4 flex items-center justify-between rounded-xl border p-3 ${surfaceDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}><div className="flex items-center gap-2"><Gauge size={15} className="text-emerald-400" /><span className="text-xs opacity-70">Active share of known flags</span></div><span className="font-mono text-sm font-black text-emerald-500">{activeRate}%</span></div> : null}
          </Panel>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <Panel title="Enrollment leaders" eyebrow="03 / customer scale" subtitle="Top teacher accounts by class enrolment count. Counts are not distinct students." accent="green" isDark={surfaceDark}>
            {dashboardLoading && !dashboardReady ? <div className={`h-64 animate-pulse rounded-xl ${surfaceDark ? 'bg-slate-800/50' : 'bg-slate-100'}`} /> : <HorizontalBars rows={enrolmentLeaders} isDark={surfaceDark} metricLabel="Enrolments" />}
          </Panel>
          <Panel title="Class leaders" eyebrow="04 / workspace distribution" subtitle="Teachers with the most verified academic classes." accent="violet" isDark={surfaceDark}>
            {dashboardLoading && !dashboardReady ? <div className={`h-64 animate-pulse rounded-xl ${surfaceDark ? 'bg-slate-800/50' : 'bg-slate-100'}`} /> : <HorizontalBars rows={classLeaders} isDark={surfaceDark} metricLabel="Classes" />}
          </Panel>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <Panel title="Class-count distribution" eyebrow="05 / account segments" subtitle="How returned teacher accounts are spread across class-count bands." accent="orange" isDark={surfaceDark}>
            <DistributionBars teachers={dashboard.teachers} metric="classes" isDark={surfaceDark} />
            <p className={`mt-3 font-mono text-[9px] ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`}>BASE: {knownClasses.length} / {dashboard.teachers.length} TEACHERS WITH KNOWN CLASS COUNTS</p>
          </Panel>
          <Panel title="Enrolment distribution" eyebrow="06 / account segments" subtitle="Count of teacher accounts in verified enrolment-size bands." accent="cyan" isDark={surfaceDark}>
            <DistributionBars teachers={dashboard.teachers} metric="enrolments" isDark={surfaceDark} />
            <p className={`mt-3 font-mono text-[9px] ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`}>BASE: {knownEnrolments.length} / {dashboard.teachers.length} TEACHERS WITH KNOWN ENROLMENTS</p>
          </Panel>
        </section>

        <Panel title="Teacher intelligence table" eyebrow="09 / searchable records" subtitle="A compact ranking of real teacher records returned by the protected dashboard service." accent="cyan" isDark={surfaceDark}>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative w-full sm:max-w-sm"><Search size={15} className={`absolute left-3 top-1/2 -translate-y-1/2 ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`} /><input value={teacherSearch} onChange={(event) => setTeacherSearch(event.target.value)} placeholder="Search teacher, email or UID…" aria-label="Search teacher analytics records" className={`w-full rounded-xl border py-2.5 pl-9 pr-3 text-xs outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 ${surfaceDark ? 'border-slate-700 bg-slate-950 text-slate-100 placeholder:text-slate-500' : 'border-slate-200 bg-white text-slate-800 placeholder:text-slate-400'}`} /></div>
            <div className="flex flex-wrap items-center gap-2"><label className={`font-mono text-[9px] uppercase tracking-wider ${surfaceDark ? 'text-slate-500' : 'text-slate-500'}`} htmlFor="analytics-sort">Rank by</label><div className="relative"><select id="analytics-sort" value={teacherSort} onChange={(event) => setTeacherSort(event.target.value as typeof teacherSort)} className={`appearance-none rounded-xl border py-2.5 pl-3 pr-8 text-xs outline-none focus:border-emerald-500 ${surfaceDark ? 'border-slate-700 bg-slate-950 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}><option value="enrolments">Enrolments</option><option value="classes">Classes</option><option value="name">Name A–Z</option></select><ChevronDown size={13} className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`} /></div><button type="button" onClick={exportVisibleTeachers} disabled={!dashboardReady || visibleTeachers.length === 0} className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-bold transition hover:border-cyan-400/40 disabled:opacity-40 ${surfaceDark ? 'border-slate-700 bg-slate-950 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}><Download size={14} /> Export CSV</button></div>
          </div>
          {!dashboardReady ? <EmptyChart title="Teacher data unavailable" detail="Connect the protected admin dashboard endpoint to load the live teacher directory." isDark={surfaceDark} /> : visibleTeachers.length === 0 ? <EmptyChart title="No matching teacher records" detail="Try a different name, email or UID search." isDark={surfaceDark} /> : <div className="overflow-x-auto rounded-xl border border-slate-500/10"><table className="w-full min-w-[760px] text-left text-xs"><thead className={surfaceDark ? 'bg-slate-950 text-slate-500' : 'bg-slate-50 text-slate-500'}><tr><th className="px-4 py-3 font-mono text-[9px] uppercase tracking-wider">Teacher</th><th className="px-4 py-3 font-mono text-[9px] uppercase tracking-wider">Status flag</th><th className="px-4 py-3 text-right font-mono text-[9px] uppercase tracking-wider">Classes</th><th className="px-4 py-3 text-right font-mono text-[9px] uppercase tracking-wider">Enrolments</th><th className="px-4 py-3 text-right font-mono text-[9px] uppercase tracking-wider">Unique students</th><th className="px-4 py-3 font-mono text-[9px] uppercase tracking-wider">Created</th></tr></thead><tbody className={`divide-y ${surfaceDark ? 'divide-slate-800' : 'divide-slate-100'}`}>{visibleTeachers.map((teacher) => <tr key={teacher.uid} className={surfaceDark ? 'hover:bg-white/[0.025]' : 'hover:bg-slate-50'}><td className="px-4 py-3.5"><p className="max-w-64 truncate font-bold" title={teacher.name}>{teacher.name}</p><p className={`mt-1 max-w-64 truncate text-[10px] ${surfaceDark ? 'text-slate-500' : 'text-slate-500'}`} title={teacher.email}>{teacher.email || teacher.uid}</p></td><td className="px-4 py-3.5"><span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold ${teacher.active === true ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-500' : teacher.active === false ? 'border-rose-400/20 bg-rose-400/10 text-rose-500' : 'border-slate-400/20 bg-slate-400/10 text-slate-500'}`}><span className={`h-1.5 w-1.5 rounded-full ${teacher.active === true ? 'bg-emerald-400' : teacher.active === false ? 'bg-rose-400' : 'bg-slate-400'}`} />{teacher.active === true ? 'Active flag' : teacher.active === false ? 'Disabled flag' : 'Unknown'}</span></td><td className="px-4 py-3.5 text-right font-mono tabular-nums">{formatCount(teacher.classCount)}</td><td className="px-4 py-3.5 text-right font-mono tabular-nums">{formatCount(teacher.enrollmentCount)}</td><td className="px-4 py-3.5 text-right font-mono tabular-nums">{formatCount(teacher.uniqueStudentCount)}</td><td className={`px-4 py-3.5 whitespace-nowrap ${surfaceDark ? 'text-slate-400' : 'text-slate-500'}`}>{teacher.createdAt ? new Intl.DateTimeFormat('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(teacher.createdAt)) : '—'}</td></tr>)}</tbody></table></div>}
          <p className={`mt-3 font-mono text-[9px] ${surfaceDark ? 'text-slate-500' : 'text-slate-400'}`}>DISPLAYING UP TO 8 RECORDS · EXPORTED ROWS FOLLOW THE CURRENT SEARCH, SORT AND DISPLAY LIMIT</p>
        </Panel>

        <section className="grid gap-5 lg:grid-cols-3">
          <Panel title="Coverage diagnostics" eyebrow="10 / data integrity" subtitle="Coverage signals based on actual response fields." accent="green" isDark={surfaceDark}>
            <div className="space-y-3">{[
              { label: 'Dashboard endpoint', value: dashboardReady ? 'REACHABLE' : dashboardLoading ? 'CHECKING' : 'UNAVAILABLE', ok: dashboardReady },
              { label: 'Summary completeness', value: dashboard.coverage.complete ? 'CONFIRMED' : 'NOT CONFIRMED', ok: dashboard.coverage.complete },
              { label: 'Historical registrations', value: dashboard.registrations.length ? `${dashboard.registrations.length} POINTS` : 'NOT RETURNED', ok: dashboard.registrations.length > 0 },
            ].map((item) => <div key={item.label} className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 ${surfaceDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}><span className={`text-xs ${surfaceDark ? 'text-slate-300' : 'text-slate-700'}`}>{item.label}</span><span className={`inline-flex items-center gap-1.5 font-mono text-[9px] font-bold ${item.ok ? 'text-emerald-500' : 'text-amber-500'}`}>{item.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}{item.value}</span></div>)}</div>
          </Panel>
          <Panel title="Network signals" eyebrow="11 / operational counters" subtitle="Only count-based signals that can be derived from current verified records." accent="cyan" isDark={surfaceDark}>
            <div className="grid grid-cols-2 gap-3">
              <div className={`rounded-xl border p-3 ${surfaceDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-center gap-2 text-cyan-500"><Layers3 size={14} /><span className="font-mono text-[9px] uppercase">Known classes</span></div>
                <p className="mt-2 text-xl font-black">{knownClasses.length.toLocaleString('en-PK')}</p>
                <p className={`mt-1 text-[9px] ${surfaceDark ? 'text-slate-500' : 'text-slate-500'}`}>Teacher records with class count</p>
              </div>
              <div className={`rounded-xl border p-3 ${surfaceDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-center gap-2 text-emerald-500"><GraduationCap size={14} /><span className="font-mono text-[9px] uppercase">Known enrolments</span></div>
                <p className="mt-2 text-xl font-black">{knownEnrolments.length.toLocaleString('en-PK')}</p>
                <p className={`mt-1 text-[9px] ${surfaceDark ? 'text-slate-500' : 'text-slate-500'}`}>Teacher records with enrolment count</p>
              </div>
            </div>
          </Panel>
          <Panel title="Integrity notes" eyebrow="12 / interpretation" subtitle="Boundaries to keep the numbers honest." accent="orange" isDark={surfaceDark}>
            <ul className={`space-y-3 text-xs leading-5 ${surfaceDark ? 'text-slate-300' : 'text-slate-600'}`}>
              <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-500" /><span>Account status here reflects verified profile flags unless the backend explicitly confirms Firebase Auth state.</span></li>
              <li className="flex gap-2"><Users size={14} className="mt-0.5 shrink-0 text-cyan-500" /><span>Class enrolments are not unique students; the same student may appear in more than one class.</span></li>
              <li className="flex gap-2"><Database size={14} className="mt-0.5 shrink-0 text-orange-500" /><span>Missing history or failed endpoints are marked unavailable instead of generating demo metrics.</span></li>
            </ul>
          </Panel>
        </section>

        <footer className={`flex flex-col justify-between gap-2 border-t pt-4 font-mono text-[9px] uppercase tracking-[0.12em] sm:flex-row sm:items-center ${isDark ? 'border-slate-800 text-slate-600' : 'border-slate-200 text-slate-400'}`}><span className="inline-flex items-center gap-2"><Cpu size={12} /> EduTrack // NEXUS Intelligence Console</span><span className="inline-flex items-center gap-2"><Zap size={12} className="text-emerald-500" /> Auto-refresh: 30s</span><span>Last refresh: {formatDateTime(lastSync?.toISOString() || null)}</span></footer>
      </div>
      <style>{`@keyframes analytics-scan { 0% { transform: translateY(-100%); } 100% { transform: translateY(100vh); } }`}</style>
    </div>
  );
}
