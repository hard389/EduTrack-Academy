import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  Activity,
  AlertCircle,
  Award,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  GraduationCap,
  LayoutDashboard,
  MessageCircle,
  Loader2,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { auth } from '@/lib/firebase';

/**
 * EduTrack Admin Portal
 *
 * Frontend data contract:
 * GET VITE_ADMIN_DASHBOARD_ENDPOINT (default /api/admin/dashboard)
 *   { admin?, generatedAt?, summary: {...}, teachers: [...], registrationsByMonth?: [...], coverage?: {...} }
 * POST /api/admin/customers/:uid/status
 * POST /api/admin/customers/:uid/password-reset
 *
 * Every endpoint used here must verify the Firebase ID token and administrator role server-side.
 */

type ConnectionState = 'checking' | 'connected' | 'disconnected';
type PageKey = 'dashboard' | 'customers' | 'analytics' | 'whatsapp' | 'subscriptions' | 'grading-presets' | 'teacher-announcements' | 'unknown';
type AccountStatus = 'active' | 'disabled' | 'unknown';
type NullableNumber = number | null;

type TeacherSummary = {
  id: string;
  uid: string;
  name: string;
  email: string;
  role: string;
  createdAt: string | null;
  active: boolean | null;
  whatsappNumber: string | null;
  profileImage: string | null;
  classCount: NullableNumber;
  enrollmentCount: NullableNumber;
  uniqueStudentCount: NullableNumber;
};

type RegistrationMonth = { month: string; count: number };
type DashboardSummary = {
  totalTeachers: NullableNumber;
  activeTeachers: NullableNumber;
  disabledTeachers: NullableNumber;
  totalClasses: NullableNumber;
  totalEnrollments: NullableNumber;
  uniqueStudents: NullableNumber;
};
type DashboardData = {
  admin: { displayName: string | null; email: string | null };
  summary: DashboardSummary;
  teachers: TeacherSummary[];
  registrationsByMonth: RegistrationMonth[];
  coverage: { complete: boolean; warnings: string[] };
  generatedAt: string | null;
};
type ApiError = Error & { status?: number };

const DASHBOARD_ENDPOINT = import.meta.env.VITE_ADMIN_DASHBOARD_ENDPOINT || '/api/admin/dashboard';
const CUSTOMERS_ENDPOINT = import.meta.env.VITE_ADMIN_CUSTOMERS_ENDPOINT || '/api/admin/customers';
const POLL_INTERVAL_MS = 5 * 60_000;

const NAV_ITEMS: Array<{ key: PageKey; label: string; path: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: 'Dashboard', path: '/admin/dashboard', icon: LayoutDashboard },
  { key: 'subscriptions', label: 'Subscriptions', path: '/admin/subscriptions', icon: Wallet },
  { key: 'customers', label: 'Manage Customers', path: '/admin/customers', icon: Users },
  { key: 'analytics', label: 'Analytics', path: '/admin/analytics', icon: BarChart3 },
  { key: 'whatsapp', label: 'WhatsApp', path: '/admin/whatsapp', icon: MessageCircle },
  { key: 'grading-presets', label: 'Grading Presets', path: '/admin/grading-presets', icon: Award },
  { key: 'teacher-announcements', label: 'Teacher Notices', path: '/admin/announcements', icon: Megaphone },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const textValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeDate = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (isRecord(value)) {
    if (typeof value.toDate === 'function') {
      try {
        const date = (value.toDate as () => unknown)();
        return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
      } catch {
        return null;
      }
    }
    const seconds = finiteNumber(value.seconds ?? value._seconds);
    if (seconds !== null) {
      const date = new Date(seconds * 1000);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
};

const normalizeCount = (value: unknown): NullableNumber => {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.floor(number) : null;
};

const normalizeTeacher = (raw: unknown, index: number): TeacherSummary | null => {
  if (!isRecord(raw)) return null;
  const role = (textValue(raw.role) || 'teacher').toLowerCase();
  // The API is expected to return teacher/customer accounts only; exclude explicitly non-teacher roles.
  if (role !== 'teacher') return null;
  const email = textValue(raw.email) || '';
  const uid = textValue(raw.uid) || textValue(raw.id) || email;
  if (!uid || (!email && !textValue(raw.uid) && !textValue(raw.id))) return null;
  const active = typeof raw.active === 'boolean'
    ? raw.active
    : typeof raw.isActive === 'boolean'
      ? raw.isActive
      : typeof raw.status === 'string'
        ? raw.status.toLowerCase() === 'active'
          ? true
          : raw.status.toLowerCase() === 'disabled' || raw.status.toLowerCase() === 'inactive'
            ? false
            : null
        : null;
  return {
    id: textValue(raw.id) || uid || `teacher-${index}`,
    uid,
    name: textValue(raw.teacherName) || textValue(raw.name) || textValue(raw.displayName) || email.split('@')[0] || 'Unnamed teacher',
    email,
    role,
    createdAt: normalizeDate(raw.createdAt),
    active,
    whatsappNumber: textValue(raw.whatsappNumber) || textValue(raw.phone) || null,
    profileImage: textValue(raw.profileImage) || textValue(raw.photoURL) || null,
    classCount: normalizeCount(raw.classCount ?? raw.totalClasses ?? raw.classesCount),
    enrollmentCount: normalizeCount(raw.enrollmentCount ?? raw.totalEnrollments ?? raw.studentEnrollments),
    uniqueStudentCount: normalizeCount(raw.uniqueStudentCount),
  };
};

const parseDashboardResponse = (raw: unknown): DashboardData => {
  if (!isRecord(raw)) throw new Error('The admin dashboard API returned an invalid response.');
  if (!isRecord(raw.summary) || !Array.isArray(raw.teachers)) {
    throw new Error('The admin dashboard API response must include summary and teachers. Check the backend response contract.');
  }
  const sourceSummary = raw.summary;
  const teachers = raw.teachers.map(normalizeTeacher).filter((teacher): teacher is TeacherSummary => teacher !== null);
  const sourceCoverage = isRecord(raw.coverage) ? raw.coverage : {};
  const complete = sourceCoverage.complete === true;
  const summary: DashboardSummary = {
    totalTeachers: normalizeCount(sourceSummary.totalTeachers ?? sourceSummary.totalCustomers ?? sourceSummary.teacherCount),
    activeTeachers: normalizeCount(sourceSummary.activeTeachers ?? sourceSummary.activeCustomers ?? sourceSummary.activeCount),
    disabledTeachers: normalizeCount(sourceSummary.disabledTeachers ?? sourceSummary.disabledCustomers ?? sourceSummary.disabledCount),
    totalClasses: normalizeCount(sourceSummary.totalClasses ?? sourceSummary.classCount),
    totalEnrollments: normalizeCount(sourceSummary.totalEnrollments ?? sourceSummary.totalEnrolments ?? sourceSummary.enrollmentCount),
    uniqueStudents: normalizeCount(sourceSummary.uniqueStudents ?? sourceSummary.uniqueStudentCount),
  };
  if (complete) {
    if (summary.totalTeachers === null) summary.totalTeachers = teachers.length;
    if (summary.activeTeachers === null && teachers.every((teacher) => teacher.active !== null)) {
      summary.activeTeachers = teachers.filter((teacher) => teacher.active === true).length;
    }
    if (summary.disabledTeachers === null && teachers.every((teacher) => teacher.active !== null)) {
      summary.disabledTeachers = teachers.filter((teacher) => teacher.active === false).length;
    }
    if (summary.totalClasses === null && teachers.every((teacher) => teacher.classCount !== null)) {
      summary.totalClasses = teachers.reduce((sum, teacher) => sum + (teacher.classCount || 0), 0);
    }
    if (summary.totalEnrollments === null && teachers.every((teacher) => teacher.enrollmentCount !== null)) {
      summary.totalEnrollments = teachers.reduce((sum, teacher) => sum + (teacher.enrollmentCount || 0), 0);
    }
  }
  const registrationsRaw = Array.isArray(raw.registrationsByMonth)
    ? raw.registrationsByMonth
    : Array.isArray(raw.monthlyRegistrations)
      ? raw.monthlyRegistrations
      : [];
  const registrationsByMonth = registrationsRaw
    .filter(isRecord)
    .map((item) => ({
      month: textValue(item.month) || textValue(item.key) || '',
      count: normalizeCount(item.count ?? item.registrations) ?? -1,
    }))
    .filter((item) => /^\d{4}-\d{2}$/.test(item.month) && item.count >= 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  const warnings = Array.isArray(sourceCoverage.warnings)
    ? sourceCoverage.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  return {
    admin: {
      displayName: isRecord(raw.admin) ? textValue(raw.admin.displayName) || textValue(raw.admin.name) : null,
      email: isRecord(raw.admin) ? textValue(raw.admin.email) : null,
    },
    summary,
    teachers,
    registrationsByMonth,
    coverage: { complete, warnings },
    generatedAt: normalizeDate(raw.generatedAt ?? raw.updatedAt),
  };
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
};

const localDateInputValue = (date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const formatCount = (value: NullableNumber): string =>
  value === null ? 'Unavailable' : new Intl.NumberFormat('en-PK').format(value);

const formatDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
};

const monthRangeStart = (monthCount: number): string => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - Math.max(1, monthCount) + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

const formatMonth = (value: string): string => {
  const date = new Date(`${value}-01T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit' }).format(date);
};

async function fetchJson<T>(url: string, user: User, init: RequestInit = {}): Promise<T> {
  const token = await user.getIdToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const bodyText = await response.text();
  let body: unknown = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  if (!response.ok) {
    const serverMessage = isRecord(body) ? textValue(body.message) || textValue(body.error) : null;
    const message = response.status === 404
      ? `Admin API endpoint not found (${url}). Deploy the protected backend route or set the VITE_* endpoint variable.`
      : response.status === 401
        ? 'Your session is no longer authorized. Sign in again.'
        : response.status === 403
          ? 'Access denied. This account is not authorized for administrator operations.'
          : serverMessage || `Request failed with HTTP ${response.status}.`;
    const error = new Error(message) as ApiError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function Modal({ title, onClose, children, localDark }: { title: string; onClose: () => void; children: ReactNode; localDark: boolean }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className={`max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border shadow-2xl ${localDark ? 'border-slate-700 bg-[#0c1222] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}>
        <div className={`sticky top-0 z-10 flex items-center justify-between border-b px-5 py-4 ${localDark ? 'border-slate-800 bg-[#0c1222]' : 'border-slate-200 bg-white'}`}>
          <h2 className="text-base font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-2 opacity-70 transition hover:bg-slate-500/10 hover:opacity-100"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </section>
    </div>
  );
}

function EmptyState({ title, detail, localDark, action }: { title: string; detail: string; localDark: boolean; action?: ReactNode }) {
  return (
    <div className={`flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed px-5 py-8 text-center ${localDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
      <FileText size={24} className="mb-3 opacity-40" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-lg text-xs leading-5 opacity-65">{detail}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

function Skeleton({ localDark, height = 'h-24' }: { localDark: boolean; height?: string }) {
  return <div className={`${height} animate-pulse rounded-xl ${localDark ? 'bg-slate-800/70' : 'bg-slate-200/80'}`} aria-hidden="true" />;
}

function StatusPill({ status, localDark }: { status: AccountStatus; localDark: boolean }) {
  const styles = status === 'active'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500'
    : status === 'disabled'
      ? 'border-rose-500/25 bg-rose-500/10 text-rose-500'
      : `border-slate-500/25 ${localDark ? 'bg-slate-700/40 text-slate-300' : 'bg-slate-100 text-slate-600'}`;
  const label = status === 'unknown' ? 'Unknown' : status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles}`}>{label}</span>;
}

function MetricCard({ label, value, description, icon: Icon, tone, localDark }: {
  label: string; value: string; description: string; icon: typeof Users; tone: string; localDark: boolean;
}) {
  return (
    <article className={`rounded-2xl border p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg sm:p-5 ${localDark ? 'border-slate-800 bg-[#0c1222]' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold opacity-65">{label}</p>
          <p className="mt-3 break-words text-2xl font-bold tracking-tight sm:text-3xl">{value}</p>
        </div>
        <div className={`rounded-xl p-2.5 ${tone}`}><Icon size={19} /></div>
      </div>
      <p className="mt-3 text-xs leading-5 opacity-60">{description}</p>
    </article>
  );
}

function BarList({ title, subtitle, items, localDark, emptyDetail }: {
  title: string; subtitle: string; items: Array<{ label: string; value: number }>; localDark: boolean; emptyDetail: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <section className={`rounded-2xl border p-5 ${localDark ? 'border-slate-800 bg-[#0c1222]' : 'border-slate-200 bg-white'}`}>
      <div className="mb-5">
        <h3 className="text-sm font-bold">{title}</h3>
        <p className="mt-1 text-xs opacity-60">{subtitle}</p>
      </div>
      {items.length === 0 ? <EmptyState title="No verified chart data" detail={emptyDetail} localDark={localDark} /> : (
        <div className="space-y-4">
          {items.map((item) => (
            <div key={item.label}>
              <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                <span className="max-w-[75%] truncate font-medium" title={item.label}>{item.label}</span>
                <span className="tabular-nums opacity-70">{item.value.toLocaleString('en-PK')}</span>
              </div>
              <div className={`h-2.5 overflow-hidden rounded-full ${localDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <div className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-400 transition-all duration-500" style={{ width: `${Math.max(item.value > 0 ? 2 : 0, (item.value / max) * 100)}%` }} title={`${item.value} records`} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RegistrationChart({ data, months, onMonthsChange, localDark }: {
  data: RegistrationMonth[]; months: number; onMonthsChange: (value: number) => void; localDark: boolean;
}) {
  const currentMonth = localDateInputValue().slice(0, 7);
  const minimumMonth = monthRangeStart(months);
  const shown = data.filter((item) => item.month >= minimumMonth && item.month <= currentMonth);
  const max = Math.max(1, ...shown.map((item) => item.count));
  return (
    <section className={`rounded-2xl border p-5 ${localDark ? 'border-slate-800 bg-[#0c1222]' : 'border-slate-200 bg-white'}`}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-sm font-bold">Monthly teacher registrations</h3><p className="mt-1 text-xs opacity-60">Based on verified account-created timestamps.</p></div>
        <select aria-label="Registration chart historical range" value={months} onChange={(event) => onMonthsChange(Number(event.target.value))} className={`rounded-lg border px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-orange-500 ${localDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'}`}>
          <option value={6}>Last 6 months</option><option value={12}>Last 12 months</option><option value={24}>Last 24 months</option>
        </select>
      </div>
      {shown.length === 0 ? <EmptyState title="Historical registration data is not available yet" detail="The admin service must return registrationsByMonth calculated from verified createdAt values. No historical values are fabricated." localDark={localDark} /> : (
        <div className="flex h-48 items-end gap-2 border-b pb-1 sm:gap-3">
          {shown.map((item) => (
            <div key={item.month} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${formatMonth(item.month)}: ${item.count} registrations`}>
              <span className="text-[10px] font-semibold tabular-nums opacity-70">{item.count}</span>
              <div className="flex h-[72%] w-full items-end justify-center">
                <div className="w-full max-w-10 rounded-t-md bg-gradient-to-t from-orange-600 to-amber-400 transition-all duration-300 group-hover:brightness-110" style={{ height: `${Math.max(item.count > 0 ? 4 : 0, (item.count / max) * 100)}%` }} />
              </div>
              <span className="max-w-full truncate text-[9px] opacity-60 sm:text-[10px]">{formatMonth(item.month)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CustomerTable({
  teachers, loading, error, localDark, onSelect, onRefresh, isRefreshLoading, showClassMetrics = true,
}: {
  teachers: TeacherSummary[]; loading: boolean; error: string | null; localDark: boolean;
  onSelect: (teacher: TeacherSummary) => void; onRefresh: () => void; isRefreshLoading: boolean; showClassMetrics?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled' | 'unknown'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortBy, setSortBy] = useState<'name' | 'createdAt' | 'classes' | 'enrolments'>('name');
  const filtered = useMemo(() => teachers.filter((teacher) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [teacher.name, teacher.email, teacher.uid].some((value) => value.toLowerCase().includes(query));
    const status: AccountStatus = teacher.active === true ? 'active' : teacher.active === false ? 'disabled' : 'unknown';
    return matchesSearch && (statusFilter === 'all' || status === statusFilter);
  }).sort((a, b) => {
    if (sortBy === 'createdAt') return (b.createdAt || '').localeCompare(a.createdAt || '');
    if (sortBy === 'classes') return (b.classCount ?? -1) - (a.classCount ?? -1);
    if (sortBy === 'enrolments') return (b.enrollmentCount ?? -1) - (a.enrollmentCount ?? -1);
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }), [teachers, search, statusFilter, sortBy]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const shown = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const subtle = localDark ? 'text-slate-400' : 'text-slate-500';
  const inputClass = `rounded-lg border px-3 py-2 text-xs outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 ${localDark ? 'border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500' : 'border-slate-200 bg-white text-slate-900 placeholder:text-slate-400'}`;
  return (
    <section className={`overflow-hidden rounded-2xl border ${localDark ? 'border-slate-800 bg-[#0c1222]' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-col gap-4 border-b border-slate-500/15 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div><h3 className="text-sm font-bold">Teachers & customers</h3><p className={`mt-1 text-xs ${subtle}`}>Records returned by the authorized admin service.</p></div>
        <button type="button" onClick={onRefresh} disabled={isRefreshLoading} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-500/20 px-3 py-2 text-xs font-semibold transition hover:border-orange-500/50 disabled:opacity-50"><RefreshCw size={14} className={isRefreshLoading ? 'animate-spin' : ''} /> Refresh</button>
      </div>
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
        <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 opacity-45" size={15} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} aria-label="Search teachers by name, email or UID" placeholder="Search name, email, or UID" className={`${inputClass} w-full pl-9`} /></div>
        <select aria-label="Filter customers by account status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); setPage(1); }} className={inputClass}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="unknown">Unknown status</option>
        </select>
        <select aria-label="Sort customer accounts" value={sortBy} onChange={(event) => { setSortBy(event.target.value as typeof sortBy); setPage(1); }} className={inputClass}><option value="name">Sort: Name</option><option value="createdAt">Newest created</option><option value="classes">Most classes</option><option value="enrolments">Most enrolments</option></select>
        <select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} className={inputClass}><option value={10}>10 rows</option><option value={25}>25 rows</option><option value={50}>50 rows</option></select>
      </div>
      {error ? <div role="alert" className="mx-4 mb-4 flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-500 sm:mx-5"><AlertCircle size={16} className="mt-0.5 shrink-0" />{error}</div> : null}
      {loading && teachers.length === 0 ? <div className="space-y-3 p-5">{[0, 1, 2].map((item) => <Skeleton key={item} localDark={localDark} height="h-12" />)}</div> : filtered.length === 0 ? <div className="p-5"><EmptyState title="No matching customer accounts" detail="Try a different search or filter. No example accounts are inserted into this table." localDark={localDark} /></div> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] border-collapse text-left text-xs">
              <thead className={localDark ? 'bg-slate-900/70 text-slate-400' : 'bg-slate-50 text-slate-500'}><tr><th className="px-5 py-3 font-semibold">Teacher</th><th className="px-4 py-3 font-semibold">Email / UID</th><th className="px-4 py-3 font-semibold">Created</th><th className="px-4 py-3 font-semibold">Status</th>{showClassMetrics ? <><th className="px-4 py-3 text-right font-semibold">Classes</th><th className="px-4 py-3 text-right font-semibold">Enrolments</th></> : null}<th className="px-5 py-3 text-right font-semibold">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-500/10">
                {shown.map((teacher) => {
                  const status: AccountStatus = teacher.active === true ? 'active' : teacher.active === false ? 'disabled' : 'unknown';
                  return <tr key={teacher.uid} className="transition hover:bg-orange-500/[0.035]">
                    <td className="px-5 py-3.5"><div className="flex min-w-0 items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-orange-500/10 text-xs font-bold text-orange-500">{teacher.profileImage ? <img src={teacher.profileImage} alt="" className="h-full w-full object-cover" loading="lazy" /> : teacher.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0"><p className="max-w-48 truncate font-semibold" title={teacher.name}>{teacher.name}</p><p className={`mt-1 text-[10px] ${subtle}`}>{teacher.role}</p></div></div></td>
                    <td className="px-4 py-3.5"><p className="max-w-48 truncate font-medium" title={teacher.email}>{teacher.email || '—'}</p><p className={`mt-1 max-w-48 truncate text-[10px] ${subtle}`} title={teacher.uid}>UID: {teacher.uid}</p></td>
                    <td className={`whitespace-nowrap px-4 py-3.5 ${subtle}`}>{formatDate(teacher.createdAt)}</td><td className="px-4 py-3.5"><StatusPill status={status} localDark={localDark} /></td>
                    {showClassMetrics ? <><td className="px-4 py-3.5 text-right tabular-nums">{formatCount(teacher.classCount)}</td><td className="px-4 py-3.5 text-right tabular-nums">{formatCount(teacher.enrollmentCount)}</td></> : null}
                    <td className="px-5 py-3.5 text-right"><button type="button" onClick={() => onSelect(teacher)} className="inline-flex items-center gap-1 rounded-lg border border-slate-500/20 px-2.5 py-2 font-semibold transition hover:border-orange-500/50 hover:text-orange-500">Manage <ChevronRight size={13} /></button></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <div className={`flex flex-col gap-3 border-t border-slate-500/15 px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-5 ${subtle}`}>
            <span>Showing {filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length} returned accounts</span>
            <div className="flex items-center gap-2"><button type="button" aria-label="Previous page" onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} className="rounded-lg border border-slate-500/20 p-1.5 disabled:opacity-30"><ChevronLeft size={15} /></button><span>Page {currentPage} of {pageCount}</span><button type="button" aria-label="Next page" onClick={() => setPage(Math.min(pageCount, currentPage + 1))} disabled={currentPage >= pageCount} className="rounded-lg border border-slate-500/20 p-1.5 disabled:opacity-30"><ChevronRight size={15} /></button></div>
          </div>
        </>
      )}
    </section>
  );
}

export default function AdminDashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const dashboardRef = useRef<DashboardData | null>(null);
  const dashboardRequestId = useRef(0);
  const dashboardAbortController = useRef<AbortController | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<Date | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [localDark, setLocalDark] = useState<boolean>(() => {
    try { return window.localStorage.getItem('edutrack-admin-surface-theme') === 'dark'; } catch { return false; }
  });
  const [globalDark, setGlobalDark] = useState<boolean>(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [registrationMonths, setRegistrationMonths] = useState(12);
  const [enrollmentLimit, setEnrollmentLimit] = useState<'5' | '10' | 'all'>('5');
  const [selectedTeacher, setSelectedTeacher] = useState<TeacherSummary | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<{ teacher: TeacherSummary; active: boolean } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const normalizedAdminPath = location.pathname.replace(/\/+$/, '') || '/';
  const activePage: PageKey = normalizedAdminPath === '/admin' || normalizedAdminPath === '/admin/dashboard'
    ? 'dashboard'
    : normalizedAdminPath === '/admin/subscriptions'
      ? 'subscriptions'
      : normalizedAdminPath === '/admin/customers'
        ? 'customers'
        : normalizedAdminPath === '/admin/analytics'
          ? 'analytics'
          : normalizedAdminPath === '/admin/whatsapp'
            ? 'whatsapp'
            : normalizedAdminPath === '/admin/grading-presets'
              ? 'grading-presets'
              : normalizedAdminPath === '/admin/announcements'
                ? 'teacher-announcements'
                : 'unknown';
  const displayName = dashboard?.admin.displayName || user?.displayName || user?.email?.split('@')[0] || 'Administrator';
  const SurfaceThemeIcon = localDark ? Moon : Sun;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      dashboardAbortController.current?.abort();
      dashboardRequestId.current += 1;
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setDashboard(null);
        dashboardRef.current = null;
        setConnection('disconnected');
        setDashboardError('Sign in with an authorized administrator account to load this portal.');
        setLastSuccessfulSync(null);
      } else {
        setDashboardError(null);
        setConnection('checking');
        setDashboard(null);
        dashboardRef.current = null;
        setLastSuccessfulSync(null);
      }
    }, (error) => {
      dashboardAbortController.current?.abort();
      dashboardRequestId.current += 1;
      dashboardRef.current = null;
      setUser(null);
      setDashboard(null);
      setAuthReady(true);
      setConnection('disconnected');
      setDashboardError(`Firebase authentication could not be resolved: ${getErrorMessage(error)}`);
    });
    return () => unsubscribe();
  }, []);

  // Fallback global-theme bridge: synchronizes with Tailwind's root .dark class. If the project has
  // a dedicated ThemeProvider, replace these root-class operations with that provider's API.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setGlobalDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem('edutrack-admin-surface-theme', localDark ? 'dark' : 'light'); } catch { /* storage may be blocked */ }
  }, [localDark]);

  const loadDashboard = useCallback(async (silent = false) => {
    if (!user) return;
    dashboardAbortController.current?.abort();
    const controller = new AbortController();
    dashboardAbortController.current = controller;
    const requestId = ++dashboardRequestId.current;
    if (!silent || !dashboardRef.current) setDashboardLoading(true);
    if (!dashboardRef.current) setConnection('checking');
    setDashboardError(null);
    try {
      const raw = await fetchJson<unknown>(DASHBOARD_ENDPOINT, user, { method: 'GET', signal: controller.signal, cache: 'no-store' });
      const parsed = parseDashboardResponse(raw);
      if (requestId !== dashboardRequestId.current) return;
      dashboardRef.current = parsed;
      setDashboard(parsed);
      const now = new Date();
      setLastSuccessfulSync(now);
      setLastUpdated(now);
      setConnection('connected');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId !== dashboardRequestId.current) return;
      setConnection('disconnected');
      setDashboardError(getErrorMessage(error));
    } finally {
      if (requestId === dashboardRequestId.current) setDashboardLoading(false);
    }
  }, [user]);

  useEffect(() => () => {
    dashboardAbortController.current?.abort();
  }, []);

  useEffect(() => {
    if (!user || activePage !== 'dashboard') return;
    let interval: number | null = null;
    const startPolling = () => {
      if (interval !== null || document.visibilityState !== 'visible') return;
      interval = window.setInterval(() => { void loadDashboard(true); }, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadDashboard(true);
        startPolling();
      } else {
        stopPolling();
      }
    };
    if (document.visibilityState === 'visible') {
      void loadDashboard();
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, loadDashboard, activePage]);

  const toggleGlobalTheme = () => {
    const nextDark = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', nextDark);
    try { window.localStorage.setItem('theme', nextDark ? 'dark' : 'light'); } catch { /* storage may be blocked */ }
    setGlobalDark(nextDark);
  };

  const handleLogout = async () => {
    setSignOutBusy(true);
    try {
      await signOut(auth);
      navigate('/admin/login', { replace: true });
    } catch (error) {
      setDashboardError(`Could not sign out: ${getErrorMessage(error)}`);
    } finally {
      setSignOutBusy(false);
    }
  };

  const changeCustomerStatus = async () => {
    if (!user || !pendingStatusChange) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      const { teacher, active } = pendingStatusChange;
      await fetchJson(`${CUSTOMERS_ENDPOINT}/${encodeURIComponent(teacher.uid)}/status`, user, {
        method: 'POST', body: JSON.stringify({ active }),
      });
      setActionMessage({ kind: 'success', text: `${teacher.name}'s account status was updated by the admin service.` });
      setSelectedTeacher((current) => current && current.uid === teacher.uid ? { ...current, active } : current);
      setPendingStatusChange(null);
      await loadDashboard(true);
    } catch (error) {
      setActionMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setActionBusy(false);
    }
  };

  const sendPasswordReset = async (teacher: TeacherSummary) => {
    if (!user) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      await fetchJson(`${CUSTOMERS_ENDPOINT}/${encodeURIComponent(teacher.uid)}/password-reset`, user, {
        method: 'POST', body: JSON.stringify({}),
      });
      setActionMessage({ kind: 'success', text: `Password-reset request submitted for ${teacher.email || 'the selected account'}.` });
    } catch (error) {
      setActionMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setActionBusy(false);
    }
  };

  const summary = dashboard?.summary;
  const accountChart = useMemo(() => {
    const active = summary?.activeTeachers ?? (dashboard?.coverage.complete && dashboard.teachers.every((teacher) => teacher.active !== null) ? dashboard.teachers.filter((teacher) => teacher.active === true).length : null);
    const disabled = summary?.disabledTeachers ?? (dashboard?.coverage.complete && dashboard.teachers.every((teacher) => teacher.active !== null) ? dashboard.teachers.filter((teacher) => teacher.active === false).length : null);
    return { active, disabled };
  }, [summary, dashboard]);
  const enrolmentRows = useMemo(() => {
    const rows = (dashboard?.teachers || []).filter((teacher) => teacher.enrollmentCount !== null).map((teacher) => ({ label: teacher.name, value: teacher.enrollmentCount as number }));
    rows.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    return enrollmentLimit === 'all' ? rows : rows.slice(0, Number(enrollmentLimit));
  }, [dashboard, enrollmentLimit]);
  const classRows = useMemo(() => {
    const rows = (dashboard?.teachers || []).filter((teacher) => teacher.classCount !== null).map((teacher) => ({ label: teacher.name, value: teacher.classCount as number }));
    return rows.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 10);
  }, [dashboard]);
  const surfaceClass = localDark ? 'border-slate-800 bg-[#0c1222] text-slate-100' : 'border-slate-200 bg-white text-slate-900';
  const todayDisplay = new Intl.DateTimeFormat('en-PK', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
  const connectionLabel = connection === 'connected' ? 'Dashboard API connected' : connection === 'checking' ? 'Checking dashboard API' : 'Disconnected';

  if (!authReady) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-700 dark:bg-[#070b13] dark:text-slate-200"><div className="text-center"><Loader2 className="mx-auto mb-3 animate-spin text-orange-500" size={28} /><p className="text-sm">Checking administrator session…</p></div></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors dark:bg-[#070b13] dark:text-slate-100">
      <header className={`sticky top-0 z-40 border-b backdrop-blur-xl ${localDark ? 'border-slate-800 bg-[#070b13]/95 text-slate-100' : 'border-slate-200 bg-white/95 text-slate-900'}`}>
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <Link to="/admin/dashboard" className="flex min-w-0 items-center gap-3" aria-label="EduTrack Admin Dashboard">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-400 text-white shadow-lg shadow-orange-500/20"><GraduationCap size={23} /></div>
            <div className="min-w-0"><p className="truncate text-sm font-extrabold tracking-tight">EduTrack</p><p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-orange-500">Admin Portal</p></div>
          </Link>
          <nav aria-label="Admin primary navigation" className="hidden items-center gap-1 lg:flex">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return <Link key={item.key} to={item.path} aria-current={activePage === item.key ? 'page' : undefined} className={`inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition ${activePage === item.key ? 'bg-orange-500/10 text-orange-500' : 'opacity-65 hover:bg-slate-500/10 hover:opacity-100'}`}><Icon size={15} />{item.label}</Link>;
            })}
          </nav>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button type="button" onClick={toggleGlobalTheme} aria-label={`Switch global application theme to ${globalDark ? 'light' : 'dark'}`} title="Global application theme" className="rounded-xl border border-slate-500/20 p-2.5 transition hover:border-orange-500/50 hover:text-orange-500">{globalDark ? <Sun size={16} /> : <Moon size={16} />}</button>
            <button type="button" onClick={() => setLocalDark((value) => !value)} aria-label={`Switch card and navigation surfaces to ${localDark ? 'light' : 'dark'}`} title="Card and navigation appearance" className={`flex h-9 w-[58px] items-center rounded-full border p-1 transition ${localDark ? 'justify-end border-slate-700 bg-slate-900' : 'justify-start border-slate-300 bg-slate-100'}`}><span className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-500 text-white shadow"><SurfaceThemeIcon size={13} /></span></button>
            <div className="relative hidden xl:block"><button type="button" aria-expanded={profileMenuOpen} aria-label="Open administrator account menu" onClick={() => setProfileMenuOpen((value) => !value)} className="flex max-w-48 items-center gap-2 rounded-xl px-2 py-1.5 text-left transition hover:bg-slate-500/10"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-xs font-bold text-orange-500">{displayName.slice(0, 1).toUpperCase()}</div><div className="min-w-0"><p className="truncate text-xs font-bold">{displayName}</p><p className="max-w-36 truncate text-[10px] opacity-60">{user?.email || 'Admin session'}</p></div><ChevronRight size={13} className={`opacity-55 transition ${profileMenuOpen ? 'rotate-90' : ''}`} /></button>{profileMenuOpen ? <div className={`absolute right-0 top-full mt-2 w-60 rounded-xl border p-3 shadow-xl ${localDark ? 'border-slate-700 bg-[#0c1222]' : 'border-slate-200 bg-white'}`}><p className="truncate text-xs font-bold">{displayName}</p><p className="mt-1 break-all text-[10px] opacity-60">{user?.email}</p><div className="my-3 border-t border-slate-500/15" /><button type="button" onClick={() => { setProfileMenuOpen(false); void handleLogout(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold text-rose-500 hover:bg-rose-500/10"><LogOut size={14} /> Sign out</button></div> : null}</div>
            <button type="button" onClick={handleLogout} disabled={signOutBusy} title="Sign out" aria-label="Sign out" className="rounded-xl border border-slate-500/20 p-2.5 transition hover:border-rose-500/40 hover:text-rose-500 disabled:opacity-50">{signOutBusy ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}</button>
            <button type="button" className="rounded-xl border border-slate-500/20 p-2.5 lg:hidden" aria-label="Toggle mobile navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((value) => !value)}>{mobileNavOpen ? <X size={17} /> : <Menu size={17} />}</button>
          </div>
        </div>
        {mobileNavOpen ? <nav aria-label="Mobile admin navigation" className={`grid grid-cols-2 gap-2 border-t p-3 lg:hidden ${localDark ? 'border-slate-800 bg-[#070b13]' : 'border-slate-200 bg-white'}`}>{NAV_ITEMS.map((item) => { const Icon = item.icon; return <Link key={item.key} to={item.path} onClick={() => setMobileNavOpen(false)} className={`flex items-center gap-2 rounded-xl px-3 py-3 text-xs font-semibold ${activePage === item.key ? 'bg-orange-500/10 text-orange-500' : 'opacity-70 hover:bg-slate-500/10'}`}><Icon size={15} />{item.label}</Link>; })}</nav> : null}
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
{activePage === 'dashboard' ? (
        <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-orange-500"><ShieldCheck size={14} /> Administration workspace <span className="text-slate-400">/</span> {NAV_ITEMS.find((item) => item.key === activePage)?.label}</div><h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{activePage === 'dashboard' ? `Welcome back, ${displayName}` : activePage === 'customers' ? 'Manage customers' : activePage === 'analytics' ? 'Network analytics' : activePage === 'subscriptions' ? 'Subscriptions' : activePage === 'grading-presets' ? 'Grading Presets' : activePage === 'teacher-announcements' ? 'Teacher Portal Notices' : 'WhatsApp'}</h1><p className="mt-2 text-sm opacity-65">{todayDisplay} <span className="px-1.5 opacity-40">·</span> {activePage === 'dashboard' ? 'One clear view of your school network.' : activePage === 'customers' ? 'Review teacher accounts and authorized account actions.' : activePage === 'analytics' ? 'Explore trends calculated from verified admin data.' : activePage === 'subscriptions' ? 'Manage EduTrack teacher subscriptions.' : activePage === 'grading-presets' ? 'Manage the shared English remarks used by teacher Auto Fill.' : activePage === 'teacher-announcements' ? 'Publish glowing in-app notices to authenticated teacher dashboards.' : 'Manage WhatsApp integrations and delivery controls.'}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${connection === 'connected' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500' : connection === 'checking' ? 'border-amber-500/25 bg-amber-500/10 text-amber-500' : 'border-rose-500/25 bg-rose-500/10 text-rose-500'}`}><span className={`h-1.5 w-1.5 rounded-full ${connection === 'connected' ? 'bg-emerald-500' : connection === 'checking' ? 'animate-pulse bg-amber-500' : 'bg-rose-500'}`} />{connectionLabel}</span>
            <button type="button" onClick={() => void loadDashboard()} disabled={dashboardLoading} className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition hover:border-orange-500/50 disabled:opacity-50 ${surfaceClass}`}><RefreshCw size={14} className={dashboardLoading ? 'animate-spin' : ''} /> Refresh</button>
          </div>
        </div>
        ) : null}

        {activePage === 'dashboard' && !user ? <div role="alert" className={`mb-6 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between ${surfaceClass}`}><div><h2 className="font-bold">Administrator sign-in required</h2><p className="mt-1 text-sm opacity-65">Sign in first. The protected API must then confirm your administrator role before organization data is returned.</p></div><Link to="/admin/login" className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-orange-600">Go to sign in <ArrowRight size={15} /></Link></div> : null}

        {activePage === 'dashboard' && user && dashboardError ? <div role="alert" className="mb-6 flex items-start gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/5 p-4 text-sm"><AlertCircle size={19} className="mt-0.5 shrink-0 text-rose-500" /><div className="min-w-0 flex-1"><p className="font-bold text-rose-500">{connection === 'disconnected' ? 'Admin data service unavailable' : 'Admin data warning'}</p><p className="mt-1 leading-6 opacity-80">{dashboardError}</p><p className="mt-2 text-xs opacity-65">The dashboard stays disconnected until a valid authorized response is received. No sample data is substituted.</p></div><button type="button" onClick={() => void loadDashboard()} className="rounded-lg border border-rose-500/25 px-3 py-2 text-xs font-semibold text-rose-500 hover:bg-rose-500/10">Retry</button></div> : null}
        {activePage === 'dashboard' && connection === 'disconnected' && dashboard && lastSuccessfulSync ? <div role="status" className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400"><AlertCircle size={15} className="mt-0.5 shrink-0" /><span>Showing the last successful dashboard response from {lastSuccessfulSync.toLocaleString()}. The data may be stale until the admin API responds successfully again.</span></div> : null}
        {activePage === 'dashboard' && actionMessage ? <div role="status" className={`mb-5 flex items-start justify-between gap-3 rounded-xl border p-3 text-sm ${actionMessage.kind === 'success' ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-500' : 'border-rose-500/25 bg-rose-500/5 text-rose-500'}`}><span className="flex items-start gap-2"><CheckCircle2 size={16} className="mt-0.5 shrink-0" />{actionMessage.text}</span><button aria-label="Dismiss message" onClick={() => setActionMessage(null)}><X size={15} /></button></div> : null}
        {activePage === 'dashboard' && dashboard?.coverage.warnings.length ? <div role="status" className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400"><AlertCircle size={15} className="mt-0.5 shrink-0" /><div><p className="font-bold">Partial data coverage</p><ul className="mt-1 list-inside list-disc space-y-1">{dashboard.coverage.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div></div> : null}

        {activePage === 'dashboard' ? <div className="space-y-6">
          <section className="relative overflow-hidden rounded-3xl border border-orange-500/20 bg-gradient-to-br from-[#101827] via-[#111827] to-[#1c1520] p-5 text-white shadow-xl shadow-slate-900/5 sm:p-7 lg:p-8">
            <div className="pointer-events-none absolute -right-14 -top-24 h-64 w-64 rounded-full bg-orange-500/10 blur-3xl" /><div className="pointer-events-none absolute -bottom-28 right-1/3 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl" />
            <div className="relative flex flex-col justify-between gap-6 lg:flex-row lg:items-center"><div className="max-w-3xl"><span className="inline-flex items-center gap-2 rounded-full border border-orange-300/20 bg-orange-300/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-orange-300"><Activity size={13} /> Education network overview</span><h2 className="mt-4 max-w-2xl text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">One clear view of your school network</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Monitor teacher accounts, class enrolments, and network activity from one place. Every number shown here comes from the authorized admin data service.</p></div><div className="relative min-w-[220px] rounded-2xl border border-white/10 bg-white/[0.045] p-4 backdrop-blur"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-300">Data service</span><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${connection === 'connected' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{connection === 'connected' ? 'Connected' : connection === 'checking' ? 'Checking' : 'Disconnected'}</span></div><div className="mt-4 flex items-center gap-2"><Clock3 size={15} className="text-orange-300" /><span className="text-xs text-slate-300">Last successful sync</span></div><p className="mt-1 text-sm font-bold">{lastSuccessfulSync ? lastSuccessfulSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not synced yet'}</p><p className="mt-2 text-[10px] text-slate-400">Refresh interval: 5 minutes</p></div></div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {dashboardLoading && !dashboard ? [0, 1, 2, 3, 4, 5].map((item) => <Skeleton key={item} localDark={localDark} height="h-36" />) : <>
              <MetricCard label="Teacher accounts" value={formatCount(summary?.totalTeachers ?? null)} description={dashboard?.coverage.complete ? 'Verified total across returned teacher accounts.' : 'Organization-wide total is shown only when supplied by the admin service.'} icon={Users} tone="bg-indigo-500/10 text-indigo-500" localDark={localDark} />
              <MetricCard label="Active accounts" value={formatCount(summary?.activeTeachers ?? accountChart.active)} description="Profile status flags reported by the admin service; not a direct Auth disablement check unless backend verifies it." icon={CheckCircle2} tone="bg-emerald-500/10 text-emerald-500" localDark={localDark} />
              <MetricCard label="Disabled accounts" value={formatCount(summary?.disabledTeachers ?? accountChart.disabled)} description="Accounts flagged disabled by the profile/admin service." icon={ShieldCheck} tone="bg-rose-500/10 text-rose-500" localDark={localDark} />
              <MetricCard label="Total classes" value={formatCount(summary?.totalClasses ?? null)} description="Only populated when the service can verify coverage across teacher accounts." icon={BookOpen} tone="bg-violet-500/10 text-violet-500" localDark={localDark} />
              <MetricCard label="Class enrolments" value={formatCount(summary?.totalEnrollments ?? null)} description="Class enrolments are not the same as unique students; a student may belong to multiple classes." icon={GraduationCap} tone="bg-orange-500/10 text-orange-500" localDark={localDark} />
              <MetricCard label="Unique students" value={formatCount(summary?.uniqueStudents ?? null)} description="Requires reliable cross-class student identifiers and deduplication by the admin service." icon={Users} tone="bg-cyan-500/10 text-cyan-500" localDark={localDark} />
            </>}</section>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-bold">Class enrolments by teacher</h3><p className="mt-1 text-xs opacity-60">Sorted by enrolled class records, not unique students.</p></div><select aria-label="Number of teachers in enrolment chart" value={enrollmentLimit} onChange={(event) => setEnrollmentLimit(event.target.value as typeof enrollmentLimit)} className={`rounded-lg border px-3 py-2 text-xs ${localDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'}`}><option value="5">Top 5</option><option value="10">Top 10</option><option value="all">All returned</option></select></div>{dashboardLoading && !dashboard ? <Skeleton localDark={localDark} height="h-60" /> : <BarList title="Class enrolments by teacher" subtitle="Actual enrolment totals per teacher; not distinct students." items={enrolmentRows} localDark={localDark} emptyDetail="The API did not return verified enrolment counts for any teacher." />}</div>
            <section className={`rounded-2xl border p-5 ${surfaceClass}`}><h3 className="text-sm font-bold">Teacher account status</h3><p className="mt-1 text-xs opacity-60">Based on reported profile status flags.</p>{accountChart.active === null || accountChart.disabled === null ? <div className="mt-4"><EmptyState title="Account status distribution unavailable" detail="The admin service must supply complete active/disabled counts or verified status for the full returned account set." localDark={localDark} /></div> : <div className="mt-6"><div className={`flex h-4 overflow-hidden rounded-full ${localDark ? 'bg-slate-800' : 'bg-slate-100'}`}><div className="bg-emerald-500 transition-all" style={{ width: `${(accountChart.active + accountChart.disabled) ? accountChart.active / (accountChart.active + accountChart.disabled) * 100 : 0}%` }} /><div className="bg-rose-500 transition-all" style={{ width: `${(accountChart.active + accountChart.disabled) ? accountChart.disabled / (accountChart.active + accountChart.disabled) * 100 : 0}%` }} /></div><div className="mt-5 grid grid-cols-2 gap-4"><div className={`rounded-xl p-4 ${localDark ? 'bg-slate-900/70' : 'bg-slate-50'}`}><div className="flex items-center gap-2 text-xs opacity-65"><span className="h-2 w-2 rounded-full bg-emerald-500" />Active</div><p className="mt-2 text-2xl font-bold">{accountChart.active.toLocaleString('en-PK')}</p></div><div className={`rounded-xl p-4 ${localDark ? 'bg-slate-900/70' : 'bg-slate-50'}`}><div className="flex items-center gap-2 text-xs opacity-65"><span className="h-2 w-2 rounded-full bg-rose-500" />Disabled</div><p className="mt-2 text-2xl font-bold">{accountChart.disabled.toLocaleString('en-PK')}</p></div></div></div>}</section>
            <BarList title="Class distribution by teacher" subtitle="Top 10 teachers by class count; only verified counts are plotted." items={classRows} localDark={localDark} emptyDetail="Class counts were not included in the admin data response." />
            <RegistrationChart data={dashboard?.registrationsByMonth || []} months={registrationMonths} onMonthsChange={setRegistrationMonths} localDark={localDark} />
          </div>
          {lastUpdated ? <p className="text-right text-[11px] opacity-50">Last response received {lastUpdated.toLocaleString()} {connection === 'connected' ? '· polling every 5 minutes' : '· connection currently unavailable'}</p> : null}
          <CustomerTable teachers={dashboard?.teachers || []} loading={dashboardLoading} error={connection === 'disconnected' && !dashboard ? dashboardError : null} localDark={localDark} onSelect={setSelectedTeacher} onRefresh={() => void loadDashboard()} isRefreshLoading={dashboardLoading} />
        </div> : <Outlet context={{ adminUser: user, localDark }} />}

        {activePage === 'dashboard' && connection === 'connected' && lastSuccessfulSync ? <p className="mt-8 text-right text-[10px] opacity-45">Last successful sync: {lastSuccessfulSync.toLocaleString()} · polling interval 5 minutes</p> : null}
      </main>

      {selectedTeacher ? <Modal title="Customer account details" onClose={() => { setSelectedTeacher(null); setActionMessage(null); }} localDark={localDark}><div className="space-y-5"><div className="flex items-center gap-4"><div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-orange-500/10 text-lg font-bold text-orange-500">{selectedTeacher.profileImage ? <img src={selectedTeacher.profileImage} alt="" className="h-full w-full object-cover" /> : selectedTeacher.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0"><h3 className="text-lg font-bold">{selectedTeacher.name}</h3><p className="break-all text-sm opacity-65">{selectedTeacher.email || 'Email unavailable'}</p><div className="mt-2"><StatusPill status={selectedTeacher.active === true ? 'active' : selectedTeacher.active === false ? 'disabled' : 'unknown'} localDark={localDark} /></div></div></div><div className="grid gap-3 sm:grid-cols-2">{[{ label: 'Account UID', value: selectedTeacher.uid }, { label: 'Created', value: formatDate(selectedTeacher.createdAt) }, { label: 'Role', value: selectedTeacher.role }, { label: 'WhatsApp', value: selectedTeacher.whatsappNumber || 'Not provided' }, { label: 'Classes', value: formatCount(selectedTeacher.classCount) }, { label: 'Class enrolments', value: formatCount(selectedTeacher.enrollmentCount) }].map((field) => <div key={field.label} className={`rounded-xl border p-3 ${localDark ? 'border-slate-700 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}><p className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{field.label}</p><p className="mt-1 break-all text-sm font-semibold">{field.value}</p></div>)}</div><p className="text-xs leading-5 opacity-55">Sensitive student records are not displayed here. Account status actions must be performed by the protected backend and will not be simulated locally.</p><div className="flex flex-col gap-2 border-t border-slate-500/15 pt-4 sm:flex-row sm:flex-wrap"><button type="button" disabled={actionBusy || !selectedTeacher.email} onClick={() => void sendPasswordReset(selectedTeacher)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-500/20 px-4 py-2.5 text-xs font-bold hover:border-orange-500/50 hover:text-orange-500 disabled:opacity-40"><Mail size={15} /> Send password reset</button>{selectedTeacher.uid === user?.uid ? <p className="text-xs text-amber-500">Self-disable is blocked in this interface.</p> : selectedTeacher.active !== null ? <button type="button" disabled={actionBusy} onClick={() => setPendingStatusChange({ teacher: selectedTeacher, active: selectedTeacher.active === false })} className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40 ${selectedTeacher.active ? 'bg-rose-500 hover:bg-rose-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>{selectedTeacher.active ? <X size={15} /> : <Check size={15} />}{selectedTeacher.active ? 'Disable account' : 'Enable account'}</button> : <p className="text-xs text-amber-500">Cannot change status until the service returns a verified active flag.</p>}<button type="button" onClick={() => { setSelectedTeacher(null); navigate('/admin/subscriptions'); }} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-500/20 px-4 py-2.5 text-xs font-bold hover:border-orange-500/50">View subscriptions <ArrowRight size={14} /></button></div></div></Modal> : null}

      {pendingStatusChange ? <Modal title={`${pendingStatusChange.active ? 'Enable' : 'Disable'} customer account?`} onClose={() => setPendingStatusChange(null)} localDark={localDark}><div className="space-y-4"><p className="text-sm leading-6">You are about to <strong>{pendingStatusChange.active ? 'enable' : 'disable'}</strong> <strong>{pendingStatusChange.teacher.name}</strong> ({pendingStatusChange.teacher.email || pendingStatusChange.teacher.uid}). This operation will be sent to the trusted admin backend; the page will update only after it succeeds.</p><p className="text-xs leading-5 text-amber-500">The backend must coordinate the Firestore profile flag and Firebase Authentication state as required by your security model.</p><div className="flex justify-end gap-2"><button type="button" onClick={() => setPendingStatusChange(null)} className="rounded-xl border border-slate-500/20 px-4 py-2.5 text-xs font-semibold">Cancel</button><button type="button" disabled={actionBusy} onClick={() => void changeCustomerStatus()} className="rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{actionBusy ? 'Submitting…' : 'Confirm change'}</button></div></div></Modal> : null}



    </div>
  );
}
