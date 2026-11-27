import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  CalendarCheck,
  CreditCard,
  GraduationCap,
  ReceiptText,
  RefreshCw,
  Sparkles,
  Users,
  UserCheck,
  ClipboardList,
  Percent,
  Wallet,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Link } from 'react-router-dom';
import { auth } from '@/lib/firebase';
import { academyManagementRequest } from '@/lib/academyApi';
import { Empty, Loading, Notice } from './AcademyAdminUI';
import {
  AcademyHeroCard,
  AcademyQuickAccess,
  AcademyStatCard,
  AnalyticsChartCard,
  FeePositionCard,
  ImportantInformationCard,
} from './AcademyDashboardComponents';

type Summary = {
  teachers: number;
  activeTeachers: number;
  students: number;
  activeStudents: number;
  classes: number;
  activeClasses: number;
  totalSubjectEnrolments: number;
  todayPresent: number;
  todayAbsent: number;
  attendancePercentage: number;
  attendanceDate: string;
  invoices: number;
  activeInvoices: number;
  payments: number;
  billedAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  postedExpenses?: number;
  netCashMovement?: number;
  totalFeesGenerated?: number;
  totalFeesCollected?: number;
  outstandingFees?: number;
};

type DashboardData = {
  academy: { academyId: string; academyName: string };
  summary: Summary;
  meta?: { limited?: boolean };
};

type AnalyticsData = {
  summary: {
    totalStudents: number;
    activeStudents: number;
    totalClasses: number;
    totalSubjectEnrolments: number;
    attendanceRecords: number;
    quizzes: number;
    postedExpenses: number;
  };
  monthly: Array<{
    month: string;
    newStudents: number;
    present: number;
    absent: number;
    collected: number;
    outstanding: number;
  }>;
  classDistribution: Array<{ classId: string; className: string; students: number }>;
  subjectDistribution: Array<{ subjectName: string; students: number }>;
  quizPerformance: Array<{
    quizId: string;
    title: string;
    subjectName: string;
    className: string;
    date: string;
    averagePercentage: number | null;
  }>;
  meta: { limited: boolean };
};

const chartColors = {
  blue: '#3b82f6',
  cyan: '#06b6d4',
  green: '#10b981',
  orange: '#f59e0b',
  rose: '#f43f5e',
  violet: '#8b5cf6',
  slate: '#94a3b8',
};
const pieColors = [chartColors.blue, chartColors.cyan, chartColors.violet, chartColors.green, chartColors.orange, chartColors.rose];
const money = (value: number) => `PKR ${Number(value || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;
const number = (value: number) => Number(value || 0).toLocaleString('en-PK');
const localMonth = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const monthOffset = (offset: number) => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - offset);
  return localMonth(date);
};
const formatMonth = (value: string) => {
  const [year, month] = value.split('-').map(Number);
  if (!year || !month) return value;
  return new Date(year, month - 1, 1).toLocaleDateString('en-PK', { month: 'short', year: '2-digit' });
};
const moneyTick = (value: number) => {
  const amount = Number(value || 0);
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}m`;
  if (amount >= 1_000) return `${Math.round(amount / 1_000)}k`;
  return String(amount);
};

export default function AcademyAdminOverview() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [error, setError] = useState('');
  const [analyticsError, setAnalyticsError] = useState('');
  const [fromMonth, setFromMonth] = useState(monthOffset(5));
  const [toMonth, setToMonth] = useState(monthOffset(0));
  const [draftFromMonth, setDraftFromMonth] = useState(monthOffset(5));
  const [draftToMonth, setDraftToMonth] = useState(monthOffset(0));

  const load = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) {
      setError('Sign in again to load your Academy overview.');
      setLoading(false);
      setAnalyticsLoading(false);
      return;
    }

    setLoading(true);
    setAnalyticsLoading(true);
    setError('');
    setAnalyticsError('');

    const [overviewResult, analyticsResult] = await Promise.allSettled([
      academyManagementRequest<DashboardData>(user, { action: 'dashboard' }),
      academyManagementRequest<AnalyticsData>(user, { action: 'analytics', fromMonth, toMonth }),
    ]);

    if (overviewResult.status === 'fulfilled') {
      const overview = overviewResult.value;
      const hasAcademyIdentity = Boolean(
        overview?.academy &&
        typeof overview.academy.academyId === 'string' &&
        typeof overview.academy.academyName === 'string' &&
        overview.summary,
      );
      if (hasAcademyIdentity) {
        setData(overview);
      } else {
        setData(null);
        setError('The Academy dashboard returned incomplete data. Refresh the page; if this continues, redeploy the latest application patch.');
      }
    } else {
      setData(null);
      setError(overviewResult.reason instanceof Error ? overviewResult.reason.message : 'Could not load the Academy overview.');
    }

    if (analyticsResult.status === 'fulfilled') {
      setAnalytics(analyticsResult.value);
    } else {
      setAnalytics(null);
      setAnalyticsError(analyticsResult.reason instanceof Error ? analyticsResult.reason.message : 'Analytics could not be loaded.');
    }

    setLoading(false);
    setAnalyticsLoading(false);
  }, [fromMonth, toMonth]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    if (!data) return [];
    const summary = data.summary;
    return [
      { label: 'Total students', value: number(summary.students), icon: GraduationCap, note: `${number(summary.activeStudents)} active students`, accent: 'blue' as const },
      { label: 'Total teachers', value: number(summary.teachers), icon: Users, note: `${number(summary.activeTeachers)} active teachers`, accent: 'violet' as const },
      { label: 'Active classes', value: number(summary.activeClasses), icon: BookOpen, note: `${number(summary.classes)} total class records`, accent: 'cyan' as const },
      { label: 'Subject enrolments', value: number(summary.totalSubjectEnrolments), icon: ClipboardList, note: 'Active subject links', accent: 'indigo' as const },
      { label: 'Present today', value: number(summary.todayPresent), icon: UserCheck, note: summary.attendanceDate, accent: 'green' as const },
      { label: 'Absent today', value: number(summary.todayAbsent), icon: CalendarCheck, note: 'Saved attendance marks', accent: 'rose' as const },
      { label: 'Attendance rate', value: `${Number(summary.attendancePercentage || 0).toFixed(1)}%`, icon: Percent, note: 'Based on saved marks today', accent: 'green' as const },
      { label: 'Total fees generated', value: money(summary.totalFeesGenerated ?? summary.billedAmount), icon: ReceiptText, note: 'Issued Academy invoices', accent: 'orange' as const },
      { label: 'Fees collected', value: money(summary.totalFeesCollected ?? summary.paidAmount), icon: CreditCard, note: 'Recorded invoice payments', accent: 'green' as const },
      { label: 'Outstanding fees', value: money(summary.outstandingFees ?? summary.outstandingAmount), icon: Activity, note: 'Remaining invoice balance', accent: 'orange' as const },
      { label: 'Active invoices', value: number(summary.activeInvoices), icon: ReceiptText, note: `${number(summary.invoices)} invoice records loaded`, accent: 'blue' as const },
      { label: 'Posted expenses', value: money(summary.postedExpenses ?? 0), icon: Wallet, note: 'Posted financial ledger entries', accent: 'rose' as const },
    ];
  }, [data]);

  const attendanceDistribution = useMemo(() => {
    if (!data) return [];
    return [
      { name: 'Present', value: data.summary.todayPresent },
      { name: 'Absent', value: data.summary.todayAbsent },
    ].filter((item) => item.value > 0);
  }, [data]);

  const studentDistribution = useMemo(() => {
    if (!analytics) return [];
    const otherStatuses = Math.max(0, analytics.summary.totalStudents - analytics.summary.activeStudents);
    return [
      { name: 'Active', value: analytics.summary.activeStudents },
      { name: 'Other statuses', value: otherStatuses },
    ].filter((item) => item.value > 0);
  }, [analytics]);

  const financialSeries = useMemo(() => analytics?.monthly.map((row) => ({
    month: row.month,
    billed: Number(row.collected || 0) + Number(row.outstanding || 0),
    collected: Number(row.collected || 0),
    outstanding: Number(row.outstanding || 0),
  })) ?? [], [analytics]);

  const quizSeries = useMemo(() => (analytics?.quizPerformance ?? [])
    .filter((quiz) => quiz.averagePercentage !== null && Number.isFinite(Number(quiz.averagePercentage)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8)
    .reverse()
    .map((quiz) => ({ title: quiz.title.length > 18 ? `${quiz.title.slice(0, 18)}…` : quiz.title, average: Number(quiz.averagePercentage), fullTitle: quiz.title })), [analytics]);

  const displayName = auth.currentUser?.displayName?.trim();
  const todayLabel = new Intl.DateTimeFormat('en-PK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  return (
    <div className="space-y-7 sm:space-y-8">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200/70 bg-blue-50 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-blue-700 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-cyan-300">
            <Sparkles className="h-3.5 w-3.5" /> Academy control centre
          </div>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-slate-950 dark:text-white sm:text-3xl">Academy Administration</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-400">{displayName ? `Welcome back, ${displayName}. ` : 'Welcome back. '}Here is your academy overview for today.</p>
          <p className="mt-1 text-xs font-semibold text-slate-400 dark:text-slate-500">{todayLabel}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || analyticsLoading} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-4 py-2.5 text-sm font-extrabold text-white shadow-lg shadow-blue-500/20 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-blue-500/25 disabled:cursor-wait disabled:opacity-60">
          <RefreshCw className={`h-4 w-4 ${(loading || analyticsLoading) ? 'animate-spin' : ''}`} /> Refresh overview
        </button>
      </section>

      {error && <Notice>{error}</Notice>}
      {loading ? <Loading label="Loading your academy overview…" /> : !data ? <Empty>Academy overview is not available. Please refresh and try again.</Empty> : (
        <>
          <AcademyHeroCard academyName={data.academy.academyName} academyId={data.academy.academyId} />

          {data.meta?.limited && (
            <div className="rounded-xl border border-amber-300/80 bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              Some totals are based on bounded dashboard reads. Review the full reports for larger historical datasets.
            </div>
          )}

          <section className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-600 dark:text-cyan-300">Academy at a glance</p><h2 className="mt-1 text-xl font-black tracking-tight text-slate-950 dark:text-white">Key statistics</h2></div>
              <span className="hidden text-xs font-semibold text-slate-400 sm:inline">12 live indicators</span>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {stats.map((stat) => <AcademyStatCard key={stat.label} {...stat} />)}
            </div>
          </section>

          <AcademyQuickAccess />

          <section className="space-y-4">
            <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
              <div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-600 dark:text-cyan-300">Decisions backed by records</p><h2 className="mt-1 text-xl font-black tracking-tight text-slate-950 dark:text-white">Academy analytics</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Charts use the academy records returned by the existing analytics service.</p></div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-end">
                <label className="block min-w-0 space-y-1"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">From</span><input aria-label="Analytics from month" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/10 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 sm:w-36" type="month" value={draftFromMonth} max={draftToMonth} onChange={(event) => setDraftFromMonth(event.target.value)} /></label>
                <label className="block min-w-0 space-y-1"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">To</span><input aria-label="Analytics to month" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/10 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 sm:w-36" type="month" value={draftToMonth} min={draftFromMonth} onChange={(event) => setDraftToMonth(event.target.value)} /></label>
                <button type="button" onClick={() => { setFromMonth(draftFromMonth); setToMonth(draftToMonth); }} disabled={loading || analyticsLoading || !draftFromMonth || !draftToMonth || draftFromMonth > draftToMonth} className="col-span-2 inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-extrabold text-blue-700 transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-cyan-300 dark:hover:bg-blue-500/15 sm:col-span-1">
                  <RefreshCw className={`h-3.5 w-3.5 ${analyticsLoading ? 'animate-spin' : ''}`} /> Apply range
                </button>
              </div>
            </div>

            {analytics?.meta?.limited && (
              <div className="rounded-xl border border-amber-300/80 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                The analytics service reached its configured read limit. These visualisations represent the records returned for this request and may not include the entire academy history.
              </div>
            )}
            {analyticsError && <Notice>{analyticsError}</Notice>}
            {analyticsLoading ? <Loading label="Loading academy charts…" /> : !analytics ? <Empty>Analytics are currently unavailable. Your key statistics above are still available.</Empty> : (
              <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <AnalyticsChartCard title="Attendance trends" description="Monthly present and absent marks from saved attendance registers." className="xl:col-span-1">
                  {analytics.monthly.length ? (
                    <div className="h-[260px] min-w-0 sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={analytics.monthly} margin={{ top: 8, right: 12, left: -16, bottom: 2 }}>
                          <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 5" vertical={false} />
                          <XAxis dataKey="month" tickFormatter={formatMonth} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <Tooltip labelFormatter={(label) => formatMonth(String(label))} contentStyle={{ borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 12px 32px rgba(15, 23, 42, .10)' }} />
                          <Legend />
                          <Line type="monotone" dataKey="present" name="Present" stroke={chartColors.green} strokeWidth={3} dot={{ r: 3, fill: chartColors.green }} activeDot={{ r: 6 }} />
                          <Line type="monotone" dataKey="absent" name="Absent" stroke={chartColors.rose} strokeWidth={3} dot={{ r: 3, fill: chartColors.rose }} activeDot={{ r: 6 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No dated attendance records are available in this range.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Today's attendance distribution" description={`Present vs absent based on saved marks for ${data.summary.attendanceDate}.`}>
                  {attendanceDistribution.length ? (
                    <div className="flex h-[260px] min-w-0 items-center justify-center sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={attendanceDistribution} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={4} stroke="none">
                            {attendanceDistribution.map((entry) => <Cell key={entry.name} fill={entry.name === 'Present' ? chartColors.green : chartColors.rose} />)}
                          </Pie>
                          <Tooltip formatter={(value) => number(Number(value))} />
                          <Legend verticalAlign="bottom" height={28} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No attendance marks have been saved for today.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Financial overview" description="Monthly billed amount is calculated from collected plus remaining invoice balances.">
                  {financialSeries.some((row) => row.billed > 0 || row.collected > 0) ? (
                    <div className="h-[260px] min-w-0 sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={financialSeries} margin={{ top: 8, right: 8, left: 0, bottom: 2 }}>
                          <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 5" vertical={false} />
                          <XAxis dataKey="month" tickFormatter={formatMonth} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <YAxis tickFormatter={moneyTick} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <Tooltip labelFormatter={(label) => formatMonth(String(label))} formatter={(value) => money(Number(value))} contentStyle={{ borderRadius: 14, border: '1px solid #e2e8f0' }} />
                          <Legend />
                          <Bar dataKey="billed" name="Billed" fill={chartColors.blue} radius={[6, 6, 0, 0]} />
                          <Bar dataKey="collected" name="Collected" fill={chartColors.green} radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No invoice balances are available in this range.</Empty>}
                  <p className="mt-2 text-[10px] leading-4 text-slate-400">Posted expenses are shown in the statistics above. The current analytics response does not provide a month-by-month expense series.</p>
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Fee collection position" description="Current invoice balance split from the Academy dashboard totals.">
                  {(data.summary.paidAmount + data.summary.outstandingAmount) > 0 ? (
                    <div className="flex h-[260px] min-w-0 items-center justify-center sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={[{ name: 'Collected', value: data.summary.paidAmount }, { name: 'Outstanding', value: data.summary.outstandingAmount }].filter((entry) => entry.value > 0)} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={4} stroke="none">
                            {[{ name: 'Collected', value: data.summary.paidAmount }, { name: 'Outstanding', value: data.summary.outstandingAmount }].filter((entry) => entry.value > 0).map((entry) => <Cell key={entry.name} fill={entry.name === 'Collected' ? chartColors.green : chartColors.orange} />)}
                          </Pie>
                          <Tooltip formatter={(value) => money(Number(value))} />
                          <Legend verticalAlign="bottom" height={28} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No fee balances are available yet.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Student enrolment trend" description="New canonical student profiles grouped by their creation month.">
                  {analytics.monthly.some((row) => row.newStudents > 0) ? (
                    <div className="h-[260px] min-w-0 sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={analytics.monthly} margin={{ top: 8, right: 12, left: -16, bottom: 2 }}>
                          <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 5" vertical={false} />
                          <XAxis dataKey="month" tickFormatter={formatMonth} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <Tooltip labelFormatter={(label) => formatMonth(String(label))} />
                          <Line type="monotone" dataKey="newStudents" name="New students" stroke={chartColors.blue} strokeWidth={3} dot={{ r: 3, fill: chartColors.blue }} activeDot={{ r: 6 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No dated student registrations are available in this range.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Student status overview" description="Active records compared with all other student statuses returned by the service.">
                  {studentDistribution.length ? (
                    <div className="flex h-[260px] min-w-0 items-center justify-center sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={studentDistribution} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={4} stroke="none">
                            {studentDistribution.map((entry) => <Cell key={entry.name} fill={entry.name === 'Active' ? chartColors.blue : chartColors.slate} />)}
                          </Pie>
                          <Tooltip formatter={(value) => number(Number(value))} />
                          <Legend verticalAlign="bottom" height={28} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No student status records are available.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Class-wise subject enrolments" description="Active subject enrolment counts grouped by class; these are enrolments, not unique student totals.">
                  {analytics.classDistribution.length ? (
                    <div className="h-[260px] min-w-0 sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={analytics.classDistribution} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 2 }}>
                          <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 5" horizontal={false} />
                          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <YAxis type="category" dataKey="className" width={88} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                          <Tooltip />
                          <Bar dataKey="students" name="Subject enrolments" fill={chartColors.violet} radius={[0, 6, 6, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No active class enrolments are available.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Subject enrolment distribution" description="Active enrolments grouped by subject.">
                  {analytics.subjectDistribution.length ? (
                    <div className="flex h-[260px] min-w-0 items-center justify-center sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={analytics.subjectDistribution} dataKey="students" nameKey="subjectName" innerRadius="48%" outerRadius="78%" paddingAngle={3} stroke="none">
                            {analytics.subjectDistribution.map((subject, index) => <Cell key={subject.subjectName} fill={pieColors[index % pieColors.length]} />)}
                          </Pie>
                          <Tooltip />
                          <Legend verticalAlign="bottom" height={36} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No subject enrolments are available.</Empty>}
                </AnalyticsChartCard>

                <AnalyticsChartCard title="Quiz performance" description="Average percentage from saved student quiz scores; quizzes without scores are excluded.">
                  {quizSeries.length ? (
                    <div className="h-[260px] min-w-0 sm:h-[290px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={quizSeries} margin={{ top: 8, right: 12, left: -16, bottom: 30 }}>
                          <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 5" vertical={false} />
                          <XAxis dataKey="title" interval={0} angle={-18} textAnchor="end" height={56} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                          <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                          <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} labelFormatter={(label) => quizSeries.find((row) => row.title === label)?.fullTitle ?? label} />
                          <Bar dataKey="average" name="Average score" fill={chartColors.orange} radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <Empty>No scored quizzes are available in this range.</Empty>}
                </AnalyticsChartCard>
              </div>
            )}
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <FeePositionCard billed={money(data.summary.billedAmount)} collected={money(data.summary.paidAmount)} remaining={money(data.summary.outstandingAmount)} />
            <ImportantInformationCard />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white/70 px-4 py-3 text-xs text-slate-500 dark:border-white/[0.07] dark:bg-white/[0.025] dark:text-slate-400">
            <span>Academy dashboard data is loaded from the existing secured management APIs.</span>
            <Link to="/academy-admin/analytics" className="inline-flex items-center gap-1 font-extrabold text-blue-700 transition hover:text-cyan-600 dark:text-cyan-300">Open full analytics <Activity className="h-3.5 w-3.5" /></Link>
          </div>
        </>
      )}
    </div>
  );
}
