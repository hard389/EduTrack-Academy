import { useCallback, useEffect, useState } from 'react';
import { Activity, BarChart3, RefreshCw, Users } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { auth } from '@/lib/firebase';
import { academyManagementRequest } from '@/lib/academyApi';
import { Empty, Field, inputClass, Loading, Notice, PageHeading, Panel, secondaryButtonClass } from './AcademyAdminUI';

type Analytics = {
  summary: { totalStudents: number; activeStudents: number; totalClasses: number; totalSubjectEnrolments: number; attendanceRecords: number; quizzes: number; postedExpenses: number };
  monthly: Array<{ month: string; newStudents: number; present: number; absent: number; collected: number; outstanding: number }>;
  classDistribution: Array<{ classId: string; className: string; students: number }>;
  subjectDistribution: Array<{ subjectName: string; students: number }>;
  quizPerformance: Array<{ quizId: string; title: string; subjectName: string; className: string; date: string; averagePercentage: number | null }>;
  meta: { limited: boolean };
};
const money = (value: number) => `PKR ${Number(value || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;
const monthValue = (offset: number) => { const date = new Date(); date.setMonth(date.getMonth() - offset, 1); return date.toISOString().slice(0, 7); };

export default function AcademyAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [fromMonth, setFromMonth] = useState(monthValue(5));
  const [toMonth, setToMonth] = useState(monthValue(0));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [quizPage, setQuizPage] = useState(1);
  const quizPageSize = 5;

  const load = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) { setError('Sign in again to view analytics.'); setLoading(false); return; }
    setLoading(true); setError('');
    setQuizPage(1);
    try {
      const result = await academyManagementRequest<Analytics>(user, { action: 'analytics', fromMonth, toMonth });
      setData(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Analytics could not be loaded.'); }
    finally { setLoading(false); }
  }, [fromMonth, toMonth]);

  useEffect(() => { void load(); }, [load]);

  const quizPageCount = Math.max(1, Math.ceil((data?.quizPerformance.length ?? 0) / quizPageSize));
  const visibleQuizzes = (data?.quizPerformance ?? []).slice((quizPage - 1) * quizPageSize, quizPage * quizPageSize);

  const kpis = data ? [
    { label: 'Active students', value: data.summary.activeStudents, icon: Users },
    { label: 'Classes', value: data.summary.totalClasses, icon: BarChart3 },
    { label: 'Subject enrolments', value: data.summary.totalSubjectEnrolments, icon: Activity },
    { label: 'Attendance records', value: data.summary.attendanceRecords, icon: Activity },
  ] : [];

  return (
    <>
      <PageHeading title="Academy analytics" description="Academy-wide indicators calculated from canonical student, enrolment, attendance, quiz and fee records. The aggregation is bounded; no demo values are used." action={<button className={secondaryButtonClass} type="button" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> Refresh</button>} />
      {error && <Notice>{error}</Notice>}
      <Panel className="mb-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="From month"><input className={inputClass} type="month" value={fromMonth} max={toMonth} onChange={(event) => setFromMonth(event.target.value)} /></Field>
          <Field label="To month"><input className={inputClass} type="month" value={toMonth} min={fromMonth} onChange={(event) => setToMonth(event.target.value)} /></Field>
          <div className="flex items-end"><button className="inline-flex w-full items-center justify-center rounded-xl bg-orange-500 px-4 py-3 text-sm font-black text-white hover:bg-orange-600" type="button" onClick={() => void load()}>Apply range</button></div>
        </div>
      </Panel>
      {loading ? <Loading /> : !data ? <Empty>No analytics data is available.</Empty> : (
        <>
          {data.meta.limited && <Notice>The aggregation reached a safety read limit. These charts use the bounded records returned and may not represent the full Academy history. Narrow the date range or configure a reviewed server-side aggregation before treating these as final totals.</Notice>}
          <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((item) => {
              const Icon = item.icon;
              return <Panel key={item.label}><div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-500">{item.label}<Icon className="h-5 w-5 text-orange-600" /></div><div className="mt-3 text-3xl font-black text-slate-900 dark:text-white">{item.value.toLocaleString('en-PK')}</div></Panel>;
            })}
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <Panel>
              <h2 className="mb-1 font-black text-slate-900 dark:text-white">Student enrolment trend</h2>
              <p className="mb-4 text-xs text-slate-500">New canonical student profiles by creation month</p>
              {data.monthly.length ? <div className="h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.monthly}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis allowDecimals={false} /><Tooltip /><Line type="monotone" dataKey="newStudents" name="New students" stroke="#f97316" strokeWidth={3} /></LineChart></ResponsiveContainer></div> : <Empty>No dated enrolment records in this range.</Empty>}
            </Panel>
            <Panel>
              <h2 className="mb-1 font-black text-slate-900 dark:text-white">Monthly attendance trend</h2>
              <p className="mb-4 text-xs text-slate-500">Present and absent marks from saved canonical registers</p>
              {data.monthly.length ? <div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.monthly}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis allowDecimals={false} /><Tooltip /><Legend /><Bar dataKey="present" name="Present" fill="#10b981" radius={[5, 5, 0, 0]} /><Bar dataKey="absent" name="Absent" fill="#f43f5e" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div> : <Empty>No attendance data in this range.</Empty>}
            </Panel>
            <Panel>
              <h2 className="mb-1 font-black text-slate-900 dark:text-white">Fee collection and outstanding</h2>
              <p className="mb-4 text-xs text-slate-500">PKR amounts from invoice snapshots</p>
              {data.monthly.some((row) => row.collected || row.outstanding) ? <div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.monthly}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} /><Tooltip formatter={(value) => money(Number(value))} /><Legend /><Bar dataKey="collected" name="Collected" fill="#0ea5e9" radius={[5, 5, 0, 0]} /><Bar dataKey="outstanding" name="Outstanding" fill="#f59e0b" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div> : <Empty>No fee collection records in this range.</Empty>}
            </Panel>
            <Panel>
              <h2 className="mb-1 font-black text-slate-900 dark:text-white">Class-wise student distribution</h2>
              <p className="mb-4 text-xs text-slate-500">Counts are based on active subject enrolments</p>
              {data.classDistribution.length ? <div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.classDistribution} layout="vertical" margin={{ left: 12, right: 12 }}><CartesianGrid strokeDasharray="3 3" /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="className" width={90} /><Tooltip /><Bar dataKey="students" name="Subject enrolments" fill="#8b5cf6" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div> : <Empty>No active class enrolments.</Empty>}
            </Panel>
            <Panel>
              <h2 className="mb-1 font-black text-slate-900 dark:text-white">Subject distribution</h2>
              <p className="mb-4 text-xs text-slate-500">Active enrolments by subject</p>
              {data.subjectDistribution.length ? <div className="h-72"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data.subjectDistribution} dataKey="students" nameKey="subjectName" outerRadius={100} label>{data.subjectDistribution.map((row, index) => <Cell key={row.subjectName} fill={['#f97316', '#0ea5e9', '#8b5cf6', '#10b981', '#eab308', '#ec4899'][index % 6]} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer></div> : <Empty>No subject distribution is available.</Empty>}
            </Panel>
            <Panel>
              <h2 className="mb-1 font-black text-slate-900 dark:text-white">Quiz performance</h2>
              <p className="mb-4 text-xs text-slate-500">Average percentage by saved canonical quiz</p>
              {data.quizPerformance.length ? (
                <>
                  <div className="space-y-2">{visibleQuizzes.map((quiz) => <div key={quiz.quizId} className="rounded-xl border border-slate-200 p-3 dark:border-white/10"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-bold text-slate-900 dark:text-white">{quiz.title}</div><div className="text-xs text-slate-500">{quiz.className} · {quiz.subjectName} · {quiz.date}</div></div><div className="text-lg font-black text-orange-600">{quiz.averagePercentage === null ? '—' : `${quiz.averagePercentage.toFixed(1)}%`}</div></div></div>)}</div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-white/10">
                    <span>Showing {(quizPage - 1) * quizPageSize + 1}–{Math.min(quizPage * quizPageSize, data.quizPerformance.length)} of {data.quizPerformance.length}</span>
                    <div className="flex items-center gap-2">
                      <button className={secondaryButtonClass} type="button" disabled={quizPage <= 1} onClick={() => setQuizPage((page) => Math.max(1, page - 1))}>Previous</button>
                      <span className="font-bold text-slate-700 dark:text-slate-200">{quizPage} / {quizPageCount}</span>
                      <button className={secondaryButtonClass} type="button" disabled={quizPage >= quizPageCount} onClick={() => setQuizPage((page) => Math.min(quizPageCount, page + 1))}>Next</button>
                    </div>
                  </div>
                </>
              ) : <Empty>No canonical quiz results are available in this range.</Empty>}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
