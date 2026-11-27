import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ElementType, FormEvent, ReactNode } from 'react';
import {
  AlertTriangle, Archive, ArrowLeft, BellRing, BarChart3, CalendarDays,
  CheckCircle2, ChevronDown, Clock3, Filter, Info, Loader2, Megaphone,
  MessageCircle, Moon, Pencil, Plus, RefreshCw, Search, Send, ShieldAlert, Sun,
  Users, Wallet, X,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { auth } from '@/lib/firebase';
import { academyManagementRequest } from '@/lib/academyApi';
import { useApp } from '@/contexts/AppContext';
import './alerts-premium.css';

type AlertCategory = 'Announcements' | 'Fees' | 'Attendance' | 'Exams' | 'WhatsApp';
type Priority = 'low' | 'normal' | 'medium' | 'high' | 'urgent';
type AdminAlertCategory = Exclude<AlertCategory, 'WhatsApp'>;
type ClassRow = { id: string; name: string; code?: string; section?: string; status?: string; subjects?: Array<{ id: string; name: string }> };
type AlertRow = {
  id: string;
  sourceId: string;
  source: 'teacher' | 'academy_admin';
  teacherUid?: string;
  teacherName?: string;
  teacherEmail?: string;
  title: string;
  message: string;
  category: AlertCategory;
  priority: Priority;
  targetClass: string;
  targetClassId?: string | null;
  subjectId?: string | null;
  audience?: string;
  status?: string;
  isRead: boolean;
  createdAt: string | null;
  sender?: string;
  whatsappDispatchStatus?: string;
  whatsappReconciliationRequired?: boolean;
  whatsappReconciliationStatus?: string | null;
  whatsappSourceStatus?: string | null;
  whatsappQueueType?: string | null;
  whatsappRecipientLast4?: string | null;
};
type Counts = { total: number; providerAccepted: number; deliveryConfirmed: number | null; failed: number; pending: number; unknown: number };
type CategoryAnalytics = { key: string; label: string; dataAvailable: boolean; deliveryTrackingAvailable: boolean; sourceDocuments: number; counts: Counts };
type Analytics = {
  month: string;
  timezone: string;
  daysInMonth: number;
  summary: Counts & { expiredRetryJobs?: number; dataCoverageComplete?: boolean };
  categories: CategoryAnalytics[];
  dailyActivity: Array<{ day: number; date: string; total: number; providerAccepted: number; deliveryConfirmed: number; failed: number; pending: number; unknown: number }>;
  comparison?: { previousMonth: string; previousTotal: number; currentTotal: number; change: number; percentChange: number | null } | null;
  historicalDataNote?: string | null;
  partialDataNote?: string | null;
  countingPolicy?: string;
  complete?: boolean;
};
type FailedMessage = {
  id: string;
  teacherUid?: string;
  teacherName?: string;
  teacherEmail?: string;
  category: string;
  className?: string;
  studentName?: string | null;
  failedAt?: string;
  expiresAt?: string;
  attemptCount?: number;
  failureReason?: string;
  canRetry?: boolean;
  retryJobId?: string;
  dispatchId?: string;
  recipientId?: string;
  alertId?: string;
};
type Dashboard = {
  analytics: Analytics;
  failedMessages: FailedMessage[];
  failedMessagesMayBeIncomplete?: boolean;
  workspaceCount?: number;
  analyticsWorkspaceCount?: number;
};
type ApiResult<T> = { success: true } & T;

const PRIORITIES: Priority[] = ['normal', 'medium', 'high', 'urgent'];
const CHART_COLORS = ['#f97316', '#0ea5e9', '#8b5cf6', '#10b981', '#ef4444'];
const currentMonthKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
};
const formatDate = (value: string | null | undefined) => value
  ? new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Karachi' }).format(new Date(value))
  : 'Date unavailable';
const numberLabel = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('en-PK');
const safeText = (value: unknown) => typeof value === 'string' ? value : '';

async function callAcademy<T>(body: Record<string, unknown>): Promise<ApiResult<T>> {
  const user = auth.currentUser;
  if (!user) throw new Error('Your Academy Admin session has expired. Sign in again.');
  return academyManagementRequest<T>(user, body);
}

function Metric({ icon: Icon, label, value, tone = '' }: { icon: ElementType; label: string; value: string; tone?: string }) {
  return <div className={`alerts-hero-metric rounded-3xl border bg-white/85 p-4 shadow-sm ${tone}`}><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-black uppercase tracking-wide text-slate-500">{label}</span><Icon className="h-4 w-4"/></div><p className="mt-2 text-2xl font-black tracking-tight text-slate-900">{value}</p></div>;
}
function SummaryTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className={`alerts-summary-tile ${tone} rounded-3xl border bg-card p-4 shadow-sm`}><p className="text-xs font-bold text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-black tracking-tight">{value}</p></div>;
}
function ChartHeading({ title, detail }: { title: string; detail: string }) {
  return <div className="mb-3"><h3 className="font-black">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>;
}
function ChartEmpty() { return <div className="flex h-full min-h-48 items-center justify-center rounded-2xl border border-dashed border-border text-center text-xs text-muted-foreground">No persisted activity for this chart.</div>; }
function EmptyPanel({ icon: Icon, title, description, action }: { icon: ElementType; title: string; description: string; action?: ReactNode }) {
  return <div className="flex min-h-56 flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card/70 p-7 text-center"><div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 dark:bg-orange-950/30"><Icon className="h-6 w-6"/></div><h3 className="font-extrabold">{title}</h3><p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>{action && <div className="mt-4">{action}</div>}</div>;
}

export default function AcademyAlertsPage() {
  const navigate = useNavigate();
  const { isDarkMode, toggleDarkMode } = useApp();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pageError, setPageError] = useState('');
  const [teacherAlertNote, setTeacherAlertNote] = useState('');
  const [activeSection, setActiveSection] = useState<'alerts' | 'failed' | 'analytics'>('alerts');
  const [search, setSearch] = useState('');
  const [alertsPage, setAlertsPage] = useState(1);
  const [reconciliationPage, setReconciliationPage] = useState(1);
  const [failedPage, setFailedPage] = useState(1);
  const alertsPageSize = 5;
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [classFilter, setClassFilter] = useState('All');
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey());
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [newCategory, setNewCategory] = useState<AdminAlertCategory>('Announcements');
  const [audience, setAudience] = useState<'academy' | 'class' | 'subject'>('academy');
  const [targetClassId, setTargetClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [reconcilingKey, setReconcilingKey] = useState('');

  const loadAlerts = useCallback(async (showSpinner = true) => {
    const user = auth.currentUser;
    if (!user) {
      setPageError('Sign in with an active Academy Admin account to view alerts.');
      setLoading(false);
      return;
    }
    if (showSpinner) setLoading(true);
    setPageError('');
    setTeacherAlertNote('');
    try {
      const [classResult, academyResult, teacherResult] = await Promise.allSettled([
        academyManagementRequest<{ classes: ClassRow[] }>(user, { action: 'classes' }),
        academyManagementRequest<{ notifications: Array<Record<string, unknown>> }>(user, { action: 'notifications' }),
        academyManagementRequest<{ alerts: Array<Record<string, unknown>>; partial?: boolean; partialReason?: string | null; teacherCount?: number }>(user, { action: 'academy-teacher-alerts' }),
      ]);
      if (classResult.status === 'rejected') throw classResult.reason;
      if (academyResult.status === 'rejected') throw academyResult.reason;
      const nextClasses = (classResult.value.classes ?? []).filter((item) => item.status !== 'archived' && item.status !== 'inactive');
      const classMap = new Map(nextClasses.map((item) => [item.id, item]));
      const academyRows: AlertRow[] = (academyResult.value.notifications ?? []).map((row) => {
        const id = safeText(row.id);
        const classId = safeText(row.targetClassId);
        const selectedClass = classMap.get(classId);
        return {
          id, sourceId: id, source: 'academy_admin', title: safeText(row.title), message: safeText(row.message),
          category: (['Announcements', 'Fees', 'Attendance', 'Exams'].includes(safeText(row.category)) ? row.category : 'Announcements') as AdminAlertCategory, priority: (PRIORITIES.includes(row.priority as Priority) ? row.priority : 'normal') as Priority,
          targetClass: selectedClass?.name ?? (safeText(row.audience) === 'academy' ? 'All Classes' : classId || 'Selected class'),
          targetClassId: classId || null, subjectId: safeText(row.subjectId) || null, audience: safeText(row.audience),
          status: safeText(row.status), isRead: false, createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
          sender: 'Academy Admin', whatsappDispatchStatus: safeText(row.whatsappDispatchStatus) || safeText(row.whatsappStatus) || 'not_requested',
        };
      });
      let teacherRows: AlertRow[] = [];
      if (teacherResult.status === 'fulfilled') {
        teacherRows = (teacherResult.value.alerts ?? []).map((row) => {
          const targetName = safeText(row.targetClass);
          const teacherUid = safeText(row.teacherUid);
          return {
            id: safeText(row.id), sourceId: safeText(row.sourceId), source: 'teacher', teacherUid,
            teacherName: safeText(row.teacherName), teacherEmail: safeText(row.teacherEmail), title: safeText(row.title),
            message: safeText(row.message), category: (['Fees', 'Attendance', 'Announcements', 'Exams', 'WhatsApp'].includes(safeText(row.category)) ? row.category : 'Announcements') as AlertCategory,
            priority: (PRIORITIES.includes(row.priority as Priority) ? row.priority : 'normal') as Priority,
            targetClass: targetName, isRead: row.isRead === true, createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
            sender: safeText(row.sender) || safeText(row.teacherName), whatsappDispatchStatus: safeText(row.whatsappDispatchStatus),
            whatsappReconciliationRequired: row.whatsappReconciliationRequired === true,
            whatsappReconciliationStatus: safeText(row.whatsappReconciliationStatus) || null,
            whatsappSourceStatus: safeText(row.whatsappSourceStatus) || null,
            whatsappQueueType: safeText(row.whatsappQueueType) || null,
            whatsappRecipientLast4: safeText(row.whatsappRecipientLast4) || null,
          };
        });
        if (teacherResult.value.partial) setTeacherAlertNote(teacherResult.value.partialReason || 'Some teacher records were omitted by safe query limits or could not be reverified.');
      } else {
        setTeacherAlertNote(teacherResult.reason instanceof Error ? teacherResult.reason.message : 'Teacher-created alerts are temporarily unavailable. Academy notifications remain available.');
      }
      setClasses(nextClasses);
      setAlerts([...academyRows, ...teacherRows].sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0)));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Alerts could not be loaded.';
      setPageError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) { setDashboard(null); setDashboardLoading(false); return; }
    setDashboardLoading(true);
    setDashboardError('');
    try {
      const result = await academyManagementRequest<{
        analytics: Analytics;
        failedMessages: FailedMessage[];
        failedMessagesMayBeIncomplete?: boolean;
        workspaceCount?: number;
        analyticsWorkspaceCount?: number;
      }>(user, { action: 'academy-whatsapp-dashboard', month: selectedMonth });
      setDashboard({ analytics: result.analytics, failedMessages: result.failedMessages ?? [], failedMessagesMayBeIncomplete: result.failedMessagesMayBeIncomplete, workspaceCount: result.workspaceCount ?? 0, analyticsWorkspaceCount: result.analyticsWorkspaceCount ?? 0 });
    } catch (cause) {
      setDashboard(null);
      setDashboardError(cause instanceof Error ? cause.message : 'Monthly WhatsApp analytics could not be loaded.');
    } finally {
      setDashboardLoading(false);
    }
  }, [selectedMonth]);

  useEffect(() => { void loadAlerts(); }, [loadAlerts]);
  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const academyAlerts = useMemo(() => alerts.filter((item) => item.source === 'academy_admin'), [alerts]);
  const teacherAlerts = useMemo(() => alerts.filter((item) => item.source === 'teacher' && item.category !== 'WhatsApp'), [alerts]);
  const reconciliationAlerts = useMemo(() => alerts.filter((item) => item.source === 'teacher' && item.category === 'WhatsApp' && item.whatsappReconciliationRequired && !['resolved_sent', 'requeued', 'resolved_automatically'].includes(item.whatsappReconciliationStatus ?? '')), [alerts]);
  const visibleAlerts = useMemo(() => [...academyAlerts, ...teacherAlerts].filter((item) => {
    const searchable = `${item.title} ${item.message} ${item.targetClass} ${item.teacherName ?? ''}`.toLowerCase();
    if (search.trim() && !searchable.includes(search.trim().toLowerCase())) return false;
    if (categoryFilter !== 'All' && item.category !== categoryFilter) return false;
    if (classFilter !== 'All' && item.targetClass !== classFilter) return false;
    return true;
  }), [academyAlerts, teacherAlerts, search, categoryFilter, classFilter]);
  const alertsPageCount = Math.max(1, Math.ceil(visibleAlerts.length / alertsPageSize));
  const pageAlerts = visibleAlerts.slice((alertsPage - 1) * alertsPageSize, alertsPage * alertsPageSize);
  useEffect(() => { setAlertsPage(1); }, [search, categoryFilter, classFilter]);
  useEffect(() => { if (alertsPage > alertsPageCount) setAlertsPage(alertsPageCount); }, [alertsPage, alertsPageCount]);
  const analytics = dashboard?.analytics;
  const failedMessages = dashboard?.failedMessages ?? [];
  const issuePageSize = 5;
  const reconciliationPageCount = Math.max(1, Math.ceil(reconciliationAlerts.length / issuePageSize));
  const failedPageCount = Math.max(1, Math.ceil(failedMessages.length / issuePageSize));
  const visibleReconciliationAlerts = reconciliationAlerts.slice((reconciliationPage - 1) * issuePageSize, reconciliationPage * issuePageSize);
  const visibleFailedMessages = failedMessages.slice((failedPage - 1) * issuePageSize, failedPage * issuePageSize);
  useEffect(() => { setReconciliationPage(1); setFailedPage(1); }, [selectedMonth, dashboard]);
  useEffect(() => { if (reconciliationPage > reconciliationPageCount) setReconciliationPage(reconciliationPageCount); }, [reconciliationPage, reconciliationPageCount]);
  useEffect(() => { if (failedPage > failedPageCount) setFailedPage(failedPageCount); }, [failedPage, failedPageCount]);
  const totalAlerts = academyAlerts.length + teacherAlerts.length;
  const issueKeys = new Set<string>([
    ...reconciliationAlerts.map((item) => `${item.teacherUid ?? ''}:${item.sourceId}`),
    ...failedMessages.map((item) => `${item.teacherUid ?? ''}:${item.alertId || item.id}`),
  ]);
  const failedCount = issueKeys.size;
  const monthMessages = analytics && (dashboard?.analyticsWorkspaceCount ?? 0) > 0 ? analytics.summary.total : null;
  const delivered = analytics?.categories.some((item) => item.dataAvailable && item.deliveryTrackingAvailable) ? analytics.summary.deliveryConfirmed : null;
  const classById = useMemo(() => new Map(classes.map((row) => [row.id, row])), [classes]);
  const selectedClass = classById.get(targetClassId);
  const selectedClassSubjects = selectedClass?.subjects ?? [];

  const openCreate = () => {
    setEditing(null); setNewTitle(''); setNewMessage(''); setNewCategory('Announcements'); setAudience('academy'); setTargetClassId(''); setSubjectId(''); setPriority('normal'); setCreateOpen(true);
  };
  const openEdit = (item: AlertRow) => {
    if (item.source !== 'academy_admin' || item.status !== 'draft') return;
    setEditing(item); setNewTitle(item.title); setNewMessage(item.message); setNewCategory(item.category === 'WhatsApp' ? 'Announcements' : item.category);
    setAudience((item.audience === 'class' || item.audience === 'subject' ? item.audience : 'academy'));
    setTargetClassId(item.targetClassId || ''); setSubjectId(item.subjectId || ''); setPriority(item.priority); setCreateOpen(true);
  };
  const submitAlert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!newTitle.trim() || !newMessage.trim()) return;
    if (audience !== 'academy' && !targetClassId) { toast.error('Select a target class.'); return; }
    if (audience === 'subject' && !subjectId) { toast.error('Select a target subject.'); return; }
    setSaving(true);
    try {
      await callAcademy({
        action: editing ? 'update-notification' : 'create-notification',
        ...(editing ? { notificationId: editing.id } : {}),
        title: newTitle.trim(), message: newMessage.trim(), category: newCategory, audience,
        targetClassId: audience === 'academy' ? '' : targetClassId,
        subjectId: audience === 'subject' ? subjectId : '', priority,
      });
      toast.success(editing ? 'Draft notification updated' : 'Alert saved to Academy notification centre', { description: 'No WhatsApp message was dispatched.' });
      setCreateOpen(false); setEditing(null); await loadAlerts(false);
    } catch (cause) {
      toast.error('Alert could not be saved', { description: cause instanceof Error ? cause.message : 'Please try again.' });
    } finally { setSaving(false); }
  };
  const publishAlert = async (item: AlertRow) => {
    if (item.source !== 'academy_admin' || item.status !== 'draft') return;
    const approved = window.confirm(`Publish “${item.title}” to the selected Teacher Portal audience? This will create an in-app alert for teachers who have alerts.view permission. It will not send WhatsApp messages.`);
    if (!approved) return;
    try {
      const result = await callAcademy<{ recipientCount: number }>({ action: 'publish-notification', notificationId: item.id });
      toast.success('Alert published to Teacher Portal', { description: `${result.recipientCount} eligible teacher workspace(s) received the alert. No WhatsApp message was sent.` });
      await loadAlerts(false);
    } catch (cause) { toast.error('Alert was not published', { description: cause instanceof Error ? cause.message : 'No teacher notification was sent. Please retry.' }); }
  };
  const archiveAlert = async (item: AlertRow) => {
    if (item.source !== 'academy_admin') return;
    const reason = window.prompt(`Why are you archiving “${item.title}”?`);
    if (!reason?.trim()) return;
    try {
      await callAcademy({ action: 'archive-notification', notificationId: item.id, reason: reason.trim() });
      toast.success('Alert archived. Teacher Portal copies were archived too.');
      await loadAlerts(false);
    } catch (cause) { toast.error('Alert could not be archived', { description: cause instanceof Error ? cause.message : 'Please try again.' }); }
  };
  const reconcile = async (item: AlertRow, decision: 'confirmed_sent' | 'confirmed_not_sent') => {
    if (!item.teacherUid || !item.sourceId || reconcilingKey) return;
    const sent = decision === 'confirmed_sent';
    const approved = window.confirm(sent
      ? `Confirm that you checked the provider history and verified “${item.title}” was sent? This will not resend the message.`
      : `Confirm that you checked the provider history and verified “${item.title}” was NOT sent? The same eligible queue item may be requeued after the worker revalidates it.`);
    if (!approved) return;
    const key = `${item.teacherUid}:${item.sourceId}`;
    setReconcilingKey(key);
    try {
      const result = await callAcademy<{ status: string }>({ action: 'academy-whatsapp-reconcile', teacherUid: item.teacherUid, alertId: item.sourceId, decision });
      toast.success(sent ? 'Provider outcome recorded' : 'Verified not-sent outcome recorded', { description: result.status === 'requeued' ? 'The existing eligible queue item was returned to the worker.' : 'No new delivery was claimed.' });
      await Promise.all([loadAlerts(false), loadDashboard()]);
    } catch (cause) {
      toast.error('Reconciliation was not applied', { description: cause instanceof Error ? cause.message : 'Refresh the queue and try again.' });
    } finally { setReconcilingKey(''); }
  };
  const refreshAll = async () => { setRefreshing(true); await Promise.all([loadAlerts(false), loadDashboard()]); setRefreshing(false); };

  const monthLabel = new Intl.DateTimeFormat('en-PK', { month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date(`${selectedMonth}-01T00:00:00+05:00`));
  const hasChartData = Boolean(analytics && analytics.summary.total > 0);
  const categoryChartData = (analytics?.categories ?? []).filter((item) => item.dataAvailable).map((item) => ({ name: item.label, accepted: item.counts.providerAccepted, delivered: item.counts.deliveryConfirmed ?? 0, failed: item.counts.failed }));
  const summaryDataAvailable = Boolean(analytics && (dashboard?.analyticsWorkspaceCount ?? 0) > 0);
  const statusChartData = analytics ? [
    { name: 'Provider accepted', value: analytics.summary.providerAccepted },
    { name: 'Delivered', value: analytics.summary.deliveryConfirmed ?? 0 },
    { name: 'Failed', value: analytics.summary.failed },
    { name: 'Pending', value: analytics.summary.pending },
    { name: 'Unknown', value: analytics.summary.unknown },
  ].filter((item) => item.value > 0) : [];

  return <div className={`alerts-page academy-alerts-page -mx-2 min-h-[calc(100vh-5rem)] rounded-3xl px-3 py-5 sm:-mx-4 sm:px-5 lg:px-7 ${isDarkMode ? 'alerts-page-dark' : ''}`}>
    <div className="alerts-page-inner mx-auto max-w-[1600px] space-y-6">
      <header className="alerts-header flex flex-wrap items-center justify-between gap-4 rounded-[26px] border bg-card/95 p-4 shadow-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" className="alerts-icon-button" onClick={() => navigate(-1)} aria-label="Go back"><ArrowLeft className="h-5 w-5"/></button>
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-400 text-white shadow-lg shadow-orange-500/20"><BellRing className="h-6 w-6"/></div>
          <div className="min-w-0"><h1 className="text-xl font-black tracking-tight sm:text-2xl">Alerts & Notices</h1><p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">Teacher alerts · WhatsApp failures · Monthly insights</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="alerts-secondary-button" onClick={() => void refreshAll()} disabled={refreshing}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}/> Refresh</button>
          <button type="button" className="alerts-icon-button" onClick={toggleDarkMode} aria-label="Toggle dark mode">{isDarkMode ? <Sun className="h-4 w-4"/> : <Moon className="h-4 w-4"/>}</button>
          <button type="button" className="alerts-primary-button" onClick={openCreate}><Plus className="h-4 w-4"/> Send Alert</button>
        </div>
      </header>

      <section className="alerts-hero grid gap-5 rounded-[30px] border border-orange-200/80 p-5 shadow-[0_18px_45px_-35px_rgba(234,88,12,.65)] sm:p-7 xl:grid-cols-[1.1fr_1fr] xl:items-center">
        <div><span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-white/80 px-3 py-1.5 text-[10px] font-black tracking-[.16em] text-orange-700"><span className="h-1.5 w-1.5 rounded-full bg-orange-500"/> EDUTRACK COMMUNICATION</span><h2 className="mt-3 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">Keep every update clear.</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">Manage teacher notices, resolve eligible message failures, and review real WhatsApp activity for the selected month.</p></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric icon={BellRing} label="Total Alerts" value={String(totalAlerts)}/><Metric icon={AlertTriangle} label="Failed" value={dashboard && (dashboard.analyticsWorkspaceCount ?? 0) > 0 ? String(failedCount) : '—'} tone="tone-red"/><Metric icon={MessageCircle} label="Messages · Month" value={numberLabel(monthMessages)} tone="tone-blue"/><Metric icon={CheckCircle2} label="Delivered" value={numberLabel(delivered)} tone="tone-green"/></div>
      </section>

      {(pageError || teacherAlertNote) && <div className="alerts-error-banner"><Info className="h-4 w-4 shrink-0"/><span>{pageError || teacherAlertNote}</span><button type="button" className="underline" onClick={() => void refreshAll()}>Retry</button></div>}
      {pageError && <p className="text-xs text-muted-foreground">Academy Admin notifications and teacher alerts are loaded through the authorized Academy workspace API. Teacher Portal routes are not used here.</p>}

      <nav className="alerts-section-nav" aria-label="Alerts sections">
        <button type="button" className={activeSection === 'alerts' ? 'active' : ''} onClick={() => setActiveSection('alerts')}><Megaphone className="h-4 w-4"/> Teacher Alerts <span>{teacherAlerts.length + academyAlerts.length}</span></button>
        <button type="button" className={activeSection === 'failed' ? 'active' : ''} onClick={() => setActiveSection('failed')}><ShieldAlert className="h-4 w-4"/> WhatsApp Issues <span>{failedCount}</span></button>
        <button type="button" className={activeSection === 'analytics' ? 'active' : ''} onClick={() => setActiveSection('analytics')}><BarChart3 className="h-4 w-4"/> Monthly Analytics</button>
      </nav>

      {activeSection === 'alerts' && <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="alerts-kicker">01 / TEACHER-CREATED & ACADEMY NOTICES</p><h2 className="mt-1 text-xl font-black">Teacher Alerts</h2><p className="mt-1 text-sm text-muted-foreground">Review teacher-created notices and manage drafts created by this Academy.</p></div><button type="button" className="alerts-primary-button" onClick={openCreate}><Plus className="h-4 w-4"/> Create New Alert</button></div>
        <div className="alerts-filter-panel grid gap-2 rounded-3xl border border-border bg-card p-3 shadow-sm lg:grid-cols-[minmax(220px,1fr)_190px_190px]"><label className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><input className="alerts-input pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, message, class…" aria-label="Search alerts"/></label><label className="relative"><Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><select className="alerts-input appearance-none pl-10" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option>All</option><option>Announcements</option><option>Fees</option><option>Attendance</option><option>Exams</option></select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/></label><label className="relative"><Users className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><select className="alerts-input appearance-none pl-10" value={classFilter} onChange={(event) => setClassFilter(event.target.value)}><option value="All">All classes</option>{classes.map((row) => <option key={row.id} value={row.name}>{row.name} {row.section ?? ''}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/></label></div>
        {loading ? (
          <div className="flex min-h-52 items-center justify-center gap-3 rounded-3xl border border-border bg-card text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-orange-500" />Loading Academy alerts…
          </div>
        ) : visibleAlerts.length === 0 ? (
          <EmptyPanel
            icon={Megaphone}
            title="No teacher alerts found"
            description="Create an Academy draft or adjust your search and filters."
            action={<button type="button" className="alerts-primary-button" onClick={openCreate}><Plus className="h-4 w-4" /> Create Alert</button>}
          />
        ) : (
          <>
            <div className="grid gap-3 xl:grid-cols-2">
              {pageAlerts.map((item) => (
                <article key={`${item.source}:${item.id}`} className="rounded-3xl border border-border bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-5">
                  <div className="flex items-start gap-3">
                    <div className={`alerts-category-icon ${item.category === 'Fees' ? 'alerts-category-emerald' : item.category === 'Attendance' ? 'alerts-category-blue' : item.category === 'Exams' ? 'alerts-category-violet' : 'alerts-category-orange'}`}>
                      {item.category === 'Fees' ? <Wallet className="h-5 w-5" /> : item.category === 'Attendance' ? <CalendarDays className="h-5 w-5" /> : item.category === 'Exams' ? <Users className="h-5 w-5" /> : <Megaphone className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-black">{item.title}</h3>
                        <span className={`alerts-priority-pill priority-${item.priority === 'urgent' || item.priority === 'low' ? 'normal' : item.priority}`}>{item.priority}</span>
                        <span className="alerts-legacy-pill">{item.source === 'teacher' ? 'Teacher created' : 'Academy Admin'}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{item.message}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
                        <span className="alerts-category-pill alerts-category-orange">{item.category}</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{item.targetClass}</span>
                        <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatDate(item.createdAt)}</span>
                        {item.teacherName && <span>By {item.teacherName}</span>}
                      </div>
                      {item.source === 'academy_admin' && (
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                          <span className="text-xs font-semibold capitalize text-muted-foreground">Status · {item.status || 'draft'} · WhatsApp {item.whatsappDispatchStatus || 'not_requested'}</span>
                          <div className="flex gap-2">
                            {item.status === 'draft' && <>
                              <button type="button" className="alerts-secondary-button" onClick={() => openEdit(item)}><Pencil className="h-3.5 w-3.5" /> Edit draft</button>
                              <button type="button" className="alerts-primary-button" onClick={() => void publishAlert(item)}><Send className="h-3.5 w-3.5" /> Publish to Teachers</button>
                            </>}
                            {item.status !== 'archived' && <button type="button" className="alerts-icon-button alerts-delete-button" aria-label="Archive alert" onClick={() => void archiveAlert(item)}><Archive className="h-4 w-4" /></button>}
                          </div>
                        </div>
                      )}
                      {item.source === 'teacher' && <div className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">Teacher-created notice · read-only to Academy Admin</div>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {visibleAlerts.length > alertsPageSize && (
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <span className="text-xs text-muted-foreground">Showing {(alertsPage - 1) * alertsPageSize + 1}–{Math.min(alertsPage * alertsPageSize, visibleAlerts.length)} of {visibleAlerts.length} alerts</span>
                <div className="flex items-center gap-2">
                  <button type="button" className="alerts-secondary-button" disabled={alertsPage <= 1} onClick={() => setAlertsPage((page) => Math.max(1, page - 1))}>Previous</button>
                  <span className="text-xs font-bold">{alertsPage}/{alertsPageCount}</span>
                  <button type="button" className="alerts-secondary-button" disabled={alertsPage >= alertsPageCount} onClick={() => setAlertsPage((page) => Math.min(alertsPageCount, page + 1))}>Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>}

      {activeSection === 'failed' && <section className="space-y-4"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="alerts-kicker">02 / WHATSAPP ISSUE HANDLING</p><h2 className="mt-1 text-xl font-black">WhatsApp Issues & Reconciliation</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Check provider history before making a manual decision. Unknown outcomes are never resent automatically.</p></div><button type="button" className="alerts-secondary-button" onClick={() => void refreshAll()} disabled={refreshing}><RefreshCw className="h-4 w-4"/> Refresh queue</button></div>
        <div><h3 className="font-black">Provider outcome needs review</h3><p className="mt-1 text-xs text-muted-foreground">Provider acceptance is not the same as confirmed delivery. Only verified queue alerts expose reconciliation actions.</p></div>
        {dashboardLoading ? <div className="flex min-h-44 items-center justify-center gap-3 rounded-3xl border border-border bg-card text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-orange-500"/>Refreshing WhatsApp queue…</div> : (reconciliationAlerts.length === 0 && failedMessages.length === 0) ? <EmptyPanel icon={MessageCircle} title="No persisted WhatsApp issues" description="No failed or unresolved WhatsApp queue records were returned for the selected month."/> : <div className="grid gap-4 xl:grid-cols-2">{visibleReconciliationAlerts.map((item) => {
          const key = `${item.teacherUid}:${item.sourceId}`;
          const busy = reconcilingKey === key;
          const status = item.whatsappSourceStatus || 'Outcome requires review';
          return <article key={key} className="alerts-failed-card rounded-3xl border border-amber-300/80 bg-card p-4 shadow-sm sm:p-5"><div className="flex items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"><MessageCircle className="h-5 w-5"/></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="alerts-kicker">{item.category}</span><span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-800">Review required</span></div><h3 className="mt-1 font-black">{item.title}</h3><p className="mt-1 text-sm text-muted-foreground">{item.message}</p><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl bg-muted/60 p-3"><p className="text-[9px] font-bold uppercase text-muted-foreground">Queue type</p><p className="mt-1 break-words text-xs font-bold">{item.whatsappQueueType || 'Notification queue'}</p></div><div className="rounded-2xl bg-muted/60 p-3"><p className="text-[9px] font-bold uppercase text-muted-foreground">Teacher</p><p className="mt-1 truncate text-xs font-bold">{item.teacherName || 'Verified teacher'}</p></div></div><p className="mt-2 text-[11px] text-muted-foreground">Queue state: {status}{item.whatsappRecipientLast4 ? ` · Recipient ending ${item.whatsappRecipientLast4}` : ''}</p><div className="mt-4 grid gap-2 sm:grid-cols-2"><button type="button" className="alerts-secondary-button" disabled={busy} onClick={() => void reconcile(item, 'confirmed_sent')}><CheckCircle2 className="h-4 w-4"/> Confirm sent</button><button type="button" className="alerts-retry-button" disabled={busy} onClick={() => void reconcile(item, 'confirmed_not_sent')}><RefreshCw className="h-4 w-4"/>{busy ? 'Reviewing…' : 'Confirm not sent & requeue'}</button></div></div></div></article>;
        })}
        {visibleFailedMessages.map((item) => {
          const linkedAlert = reconciliationAlerts.find((row) => row.teacherUid === item.teacherUid && row.sourceId === item.alertId);
          return <article key={`failure:${item.id}`} className="alerts-failed-card rounded-3xl border border-rose-200 bg-card p-4 shadow-sm sm:p-5"><div className="flex items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-300"><AlertTriangle className="h-5 w-5"/></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="alerts-kicker">{item.category || 'WhatsApp'} issue</span><span className="rounded-full bg-rose-100 px-2 py-1 text-[10px] font-black text-rose-700">Failed</span><span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-800">Review required</span></div><h3 className="mt-1 font-black">{item.failureReason || 'WhatsApp message needs attention'}</h3><p className="mt-1 text-sm text-muted-foreground">{item.className || 'Class unavailable'}{item.studentName ? ` · ${item.studentName}` : ''} · {item.teacherName || 'Teacher'}</p><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl bg-muted/60 p-3"><p className="text-[9px] font-bold uppercase text-muted-foreground">Attempts</p><p className="mt-1 text-xs font-bold">{numberLabel(item.attemptCount)}</p></div><div className="rounded-2xl bg-muted/60 p-3"><p className="text-[9px] font-bold uppercase text-muted-foreground">Failed at</p><p className="mt-1 text-xs font-bold">{formatDate(item.failedAt)}</p></div></div><p className="mt-2 text-[11px] text-muted-foreground">This provider/queue record is read-only here unless it links to a trusted reconciliation alert.</p>{linkedAlert && <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="alerts-secondary-button" disabled={Boolean(reconcilingKey)} onClick={() => void reconcile(linkedAlert, 'confirmed_sent')}>Confirm sent</button><button type="button" className="alerts-retry-button" disabled={Boolean(reconcilingKey)} onClick={() => void reconcile(linkedAlert, 'confirmed_not_sent')}>Confirm not sent & requeue</button></div>}</div></div></article>;
        })}</div>}
        {reconciliationAlerts.length > issuePageSize && <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3"><span className="text-xs text-muted-foreground">Review items · Page {reconciliationPage} of {reconciliationPageCount} · {reconciliationAlerts.length} records</span><div className="flex gap-2"><button type="button" className="alerts-secondary-button" disabled={reconciliationPage <= 1} onClick={() => setReconciliationPage((page) => Math.max(1, page - 1))}>Previous</button><button type="button" className="alerts-secondary-button" disabled={reconciliationPage >= reconciliationPageCount} onClick={() => setReconciliationPage((page) => Math.min(reconciliationPageCount, page + 1))}>Next</button></div></div>}
        {failedMessages.length > issuePageSize && <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3"><span className="text-xs text-muted-foreground">Failed messages · Page {failedPage} of {failedPageCount} · {failedMessages.length} records</span><div className="flex gap-2"><button type="button" className="alerts-secondary-button" disabled={failedPage <= 1} onClick={() => setFailedPage((page) => Math.max(1, page - 1))}>Previous</button><button type="button" className="alerts-secondary-button" disabled={failedPage >= failedPageCount} onClick={() => setFailedPage((page) => Math.min(failedPageCount, page + 1))}>Next</button></div></div>}
        {dashboard?.failedMessagesMayBeIncomplete && <div className="alerts-note rounded-2xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">Some issue records were omitted by the safe query limits. Refresh or narrow the selected month before reconciling.</div>}
        {dashboardError && <div className="alerts-error-banner"><Info className="h-4 w-4"/>{dashboardError}</div>}
      </section>}

      {activeSection === 'analytics' && <section className="space-y-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="alerts-kicker">03 / WHATSAPP INSIGHTS</p><h2 className="mt-1 text-xl font-black">Monthly WhatsApp Analytics</h2><p className="mt-1 text-sm text-muted-foreground">Provider acceptance and confirmed delivery are counted separately.</p></div><label className="flex items-center gap-2 text-xs font-bold text-muted-foreground">Month<input type="month" className="alerts-input w-auto min-w-40" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}/></label></div>
        {dashboardLoading ? <LoadingAnalytics/> : dashboardError ? <div className="alerts-error-banner"><Info className="h-4 w-4"/>{dashboardError}</div> : analytics ? <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"><SummaryTile label="Total" value={summaryDataAvailable ? numberLabel(analytics.summary.total) : '—'} tone="tone-orange"/><SummaryTile label="Provider accepted" value={summaryDataAvailable ? numberLabel(analytics.summary.providerAccepted) : '—'} tone="tone-blue"/><SummaryTile label="Delivered" value={delivered === null ? '—' : numberLabel(delivered)} tone="tone-green"/><SummaryTile label="Failed" value={summaryDataAvailable ? numberLabel(analytics.summary.failed) : '—'} tone="tone-red"/><SummaryTile label="Pending" value={summaryDataAvailable ? numberLabel(analytics.summary.pending) : '—'} tone="tone-amber"/><SummaryTile label="Unknown" value={summaryDataAvailable ? numberLabel(analytics.summary.unknown) : '—'} tone="tone-violet"/></div>
          <div className="rounded-[28px] border border-border bg-card p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-end justify-between gap-2"><div><p className="alerts-kicker">CATEGORY SUMMARY</p><h3 className="mt-1 text-lg font-black">{monthLabel}</h3></div><p className="text-xs text-muted-foreground">Timezone: Asia/Karachi</p></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">{analytics.categories.map((category, index) => <CategoryTile key={category.key} category={category} color={CHART_COLORS[index % CHART_COLORS.length]}/>)}</div></div>
          {(analytics.partialDataNote || analytics.historicalDataNote) && <div className="alerts-note rounded-2xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200"><Info className="mr-2 inline h-4 w-4"/>{analytics.partialDataNote || analytics.historicalDataNote}</div>}
          <div className="grid gap-4 xl:grid-cols-2"><div className="alerts-chart-card rounded-[28px] border border-border bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Daily message activity" detail="All persisted outcomes by Pakistan local date"/><div className="h-64">{hasChartData ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={analytics.dailyActivity}><defs><linearGradient id="alertsTotalFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f97316" stopOpacity={0.28}/><stop offset="95%" stopColor="#f97316" stopOpacity={0.02}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="var(--alerts-chart-grid)"/><XAxis dataKey="day" tick={{ fontSize: 10 }}/><YAxis allowDecimals={false} tick={{ fontSize: 10 }}/><Tooltip/><Area type="monotone" dataKey="total" name="Total messages" stroke="#f97316" fill="url(#alertsTotalFill)" strokeWidth={2.5}/></AreaChart></ResponsiveContainer> : <ChartEmpty/>}</div></div><div className="alerts-chart-card rounded-[28px] border border-border bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Category comparison" detail="Provider accepted and failed message records"/><div className="h-64">{categoryChartData.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={categoryChartData}><CartesianGrid strokeDasharray="3 3" stroke="var(--alerts-chart-grid)"/><XAxis dataKey="name" tick={{ fontSize: 10 }}/><YAxis allowDecimals={false} tick={{ fontSize: 10 }}/><Tooltip/><Bar dataKey="accepted" name="Provider accepted" fill="#0ea5e9" radius={[6,6,0,0]}/><Bar dataKey="failed" name="Failed" fill="#ef4444" radius={[6,6,0,0]}/></BarChart></ResponsiveContainer> : <ChartEmpty/>}</div></div></div>
          <div className="grid gap-4 xl:grid-cols-[1.45fr_0.75fr]"><div className="alerts-chart-card rounded-[28px] border border-border bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Daily delivery states" detail="Month-wide daily distribution"/><div className="h-72">{hasChartData ? <ResponsiveContainer width="100%" height="100%"><BarChart data={analytics.dailyActivity}><CartesianGrid strokeDasharray="3 3" stroke="var(--alerts-chart-grid)"/><XAxis dataKey="day" tick={{ fontSize: 10 }}/><YAxis allowDecimals={false} tick={{ fontSize: 10 }}/><Tooltip/><Bar dataKey="providerAccepted" name="Provider accepted" stackId="outcome" fill="#0ea5e9"/><Bar dataKey="deliveryConfirmed" name="Delivered" stackId="outcome" fill="#10b981"/><Bar dataKey="failed" name="Failed" stackId="outcome" fill="#ef4444"/><Bar dataKey="pending" name="Pending" stackId="outcome" fill="#f59e0b"/><Bar dataKey="unknown" name="Unknown" stackId="outcome" fill="#8b5cf6"/></BarChart></ResponsiveContainer> : <ChartEmpty/>}</div></div><div className="alerts-chart-card rounded-[28px] border border-border bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Outcome breakdown" detail="Latest persisted outcome per source record"/><div className="h-64">{statusChartData.length ? <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={statusChartData} dataKey="value" nameKey="name" innerRadius={54} outerRadius={88} paddingAngle={3}>{statusChartData.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer> : <ChartEmpty/>}</div></div></div>
          <p className="text-xs text-muted-foreground">{analytics.countingPolicy || 'Counts are based on persisted records. Provider acceptance and confirmed delivery remain separate outcomes.'}</p>
        </> : <EmptyPanel icon={BarChart3} title="Monthly analytics unavailable" description="No verified analytics response was returned for this month."/>}
      </section>}
    </div>

    {createOpen && <div className="alerts-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setCreateOpen(false); }}><section className="alerts-modal p-5 sm:p-7" role="dialog" aria-modal="true" aria-labelledby="alert-modal-title"><div className="mb-5 flex items-start justify-between gap-3"><div><p className="alerts-kicker">ACADEMY NOTIFICATION CENTRE</p><h2 id="alert-modal-title" className="mt-1 text-xl font-black">{editing ? 'Edit draft alert' : 'Create new alert'}</h2><p className="mt-1 text-xs text-muted-foreground">This saves an Academy notification draft. It does not dispatch WhatsApp.</p></div><button type="button" className="alerts-icon-button" onClick={() => setCreateOpen(false)} disabled={saving} aria-label="Close"><X className="h-4 w-4"/></button></div><form onSubmit={submitAlert} className="space-y-4"><label className="block"><span className="mb-1.5 block text-xs font-bold">Category</span><select className="alerts-input" value={newCategory} onChange={(event) => setNewCategory(event.target.value as AdminAlertCategory)}><option value="Announcements">Announcements</option><option value="Fees">Fees</option><option value="Attendance">Attendance</option><option value="Exams">Exams</option></select></label><label className="block"><span className="mb-1.5 block text-xs font-bold">Audience</span><select className="alerts-input" value={audience} onChange={(event) => { setAudience(event.target.value as 'academy' | 'class' | 'subject'); setTargetClassId(''); setSubjectId(''); }}><option value="academy">Entire Academy</option><option value="class">Selected class</option><option value="subject">Selected subject</option></select></label>{audience !== 'academy' && <label className="block"><span className="mb-1.5 block text-xs font-bold">Target class</span><select className="alerts-input" required value={targetClassId} onChange={(event) => { setTargetClassId(event.target.value); setSubjectId(''); }}><option value="">Choose a class</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.name} {row.section ?? ''}</option>)}</select></label>}{audience === 'subject' && <label className="block"><span className="mb-1.5 block text-xs font-bold">Target subject</span><select className="alerts-input" required value={subjectId} onChange={(event) => setSubjectId(event.target.value)}><option value="">Choose a subject</option>{selectedClassSubjects.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}<label className="block"><span className="mb-1.5 block text-xs font-bold">Priority</span><select className="alerts-input" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label className="block"><span className="mb-1.5 block text-xs font-bold">Alert title</span><input className="alerts-input" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={140} required placeholder="Enter a clear alert title"/></label><label className="block"><span className="mb-1.5 block text-xs font-bold">Message</span><textarea className="alerts-input min-h-32 resize-y" value={newMessage} onChange={(event) => setNewMessage(event.target.value)} maxLength={4000} required placeholder="Write the announcement message…"/></label><div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200"><Info className="mr-1.5 inline h-4 w-4"/> WhatsApp sending is not enabled for this Academy Admin draft action. No message will be sent from this form.</div><div className="flex flex-wrap justify-end gap-2"><button type="button" className="alerts-secondary-button" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</button><button type="submit" className="alerts-primary-button" disabled={saving || (audience !== 'academy' && !targetClassId) || (audience === 'subject' && !subjectId)}>{saving ? <Loader2 className="h-4 w-4 animate-spin"/> : <Send className="h-4 w-4"/>}{saving ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}</button></div></form></section></div>}
  </div>;
}

function CategoryTile({ category, color }: { category: CategoryAnalytics; color: string }) {
  const value = (amount: number | null | undefined) => amount === null || amount === undefined ? '—' : amount.toLocaleString('en-PK');
  return <div className="rounded-3xl border border-border bg-card p-4 shadow-sm"><div className="flex items-center justify-between gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }}/><span className="text-[9px] font-black uppercase tracking-wide text-muted-foreground">{category.dataAvailable ? 'Persisted data' : 'No data'}</span></div><h4 className="mt-3 font-black">{category.label}</h4><p className="mt-2 text-2xl font-black">{category.dataAvailable ? value(category.counts.total) : '—'}</p><div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground"><span>Accepted</span><strong>{category.dataAvailable ? value(category.counts.providerAccepted) : '—'}</strong></div><div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>Delivered</span><strong>{category.dataAvailable && category.deliveryTrackingAvailable ? value(category.counts.deliveryConfirmed) : '—'}</strong></div><div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>Failed</span><strong>{category.dataAvailable ? value(category.counts.failed) : '—'}</strong></div></div>;
}
function LoadingAnalytics() { return <div className="flex min-h-60 items-center justify-center gap-3 rounded-3xl border border-border bg-card text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-orange-500"/>Loading monthly analytics…</div>; }
