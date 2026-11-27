import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import { useApp } from '@/contexts/AppContext';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Filter,
  Loader2,
  Megaphone,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sun,
  Trash2,
  TrendingUp,
  Wallet,
  X,
  Moon,
  Users,
  GraduationCap,
  BarChart3,
  Info,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { isOwnedActiveTeacherProfile, normalizeTenantEmail, tenantAlertsPath, tenantClassesPath } from './alerts.logic';
import './alerts-premium.css';

type AlertCategory = 'Announcements' | 'Fees' | 'Attendance' | 'Exams' | 'WhatsApp';
type Priority = 'high' | 'medium' | 'normal';
type TenantContext = { tenantId: string; uid: string; academyId: string; generation: number };
type AlertRow = {
  id: string;
  title: string;
  message: string;
  category: AlertCategory;
  priority: Priority;
  targetClass: string;
  createdAt: string | null;
  isRead: boolean;
  legacy: boolean;
  status?: string;
  academyPublished?: boolean;
  whatsappReconciliationRequired?: boolean;
  whatsappReconciliationStatus?: string | null;
  whatsappSourceStatus?: string | null;
  whatsappQueueType?: string | null;
  whatsappSourceCollection?: string | null;
  whatsappJobId?: string | null;
  whatsappDispatchId?: string | null;
  whatsappRecipientId?: string | null;
  whatsappRecipientLast4?: string | null;
  whatsappProviderMessageId?: string | null;
};
type ClassRow = { id: string; name: string; code?: string };
type Counts = {
  total: number;
  providerAccepted: number;
  deliveryConfirmed: number | null;
  failed: number;
  pending: number;
  unknown: number;
};
type CategoryAnalytics = {
  key: string;
  label: string;
  dataAvailable: boolean;
  deliveryTrackingAvailable: boolean;
  counts: Counts;
  sourceDocuments: number;
};
type Analytics = {
  month: string;
  timezone: string;
  daysInMonth: number;
  summary: Omit<Counts, 'deliveryConfirmed'> & { deliveryConfirmed: number };
  categories: CategoryAnalytics[];
  dailyActivity: Array<{ day: number; date: string; total: number; providerAccepted: number; deliveryConfirmed: number; failed: number; pending: number; unknown: number }>;
  comparison: null | { previousMonth: string; previousTotal: number; currentTotal: number; change: number; percentChange: number | null };
  historicalDataNote: string | null;
  partialDataNote?: string | null;
  countingPolicy: string;
  complete?: boolean;
};
type FailedMessage = {
  id: string;
  category: string;
  className: string;
  studentName: string | null;
  failedAt: string;
  expiresAt: string;
  attemptCount: number;
  failureReason: string;
  canRetry: boolean;
  retryJobId?: string;
  dispatchId?: string;
  recipientId?: string;
  alertId?: string;
};
type DashboardResponse = { success: true; analytics: Analytics; failedMessages: FailedMessage[]; failedMessagesMayBeIncomplete?: boolean };

const ALERT_CATEGORIES: Exclude<AlertCategory, 'WhatsApp'>[] = ['Announcements', 'Fees', 'Attendance', 'Exams'];
const READABLE_ALERT_CATEGORIES: AlertCategory[] = [...ALERT_CATEGORIES, 'WhatsApp'];
const PRIORITIES: Priority[] = ['normal', 'medium', 'high'];
const CATEGORY_STYLE: Record<string, { icon: React.ElementType; className: string; label: string }> = {
  Announcements: { icon: Megaphone, className: 'alerts-category-orange', label: 'Announcement' },
  Fees: { icon: Wallet, className: 'alerts-category-emerald', label: 'Fee alert' },
  Attendance: { icon: CalendarDays, className: 'alerts-category-blue', label: 'Attendance' },
  Exams: { icon: GraduationCap, className: 'alerts-category-violet', label: 'Exam' },
  WhatsApp: { icon: MessageCircle, className: 'alerts-category-blue', label: 'WhatsApp review' },
};
const CHART_COLORS = ['#f97316', '#0ea5e9', '#8b5cf6', '#10b981', '#ef4444'];
const currentMonthKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
};
const timestampToDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    const date = (value.toDate as () => Date)();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};
const formatDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Karachi' }).format(new Date(value))
  : 'Date unavailable';
const remainingTime = (value: string, now: number) => {
  const delta = Math.max(0, new Date(value).getTime() - now);
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
};
const isValidCategory = (value: unknown): value is AlertCategory => READABLE_ALERT_CATEGORIES.includes(value as AlertCategory);

function isTeacherCreatedAlert(data: Record<string, unknown>, uid: string, documentId: string, academyId: string): boolean {
  if (!isValidCategory(data.category)) return false;
  if (typeof data.title !== 'string' || !data.title.trim() || typeof data.message !== 'string' || !data.message.trim()) return false;
  // Queue alerts are written by the trusted worker into this already-verified tenant's
  // notifications subcollection. Require the stable ID and the complete queue reference;
  // never accept an arbitrary category=WhatsApp document as a reconciliation request.
  if (data.category === 'WhatsApp') {
    return /^wa_[a-f0-9]{48}$/.test(documentId)
      && data.sender === 'EduTrack WhatsApp Queue'
      && data.whatsappReconciliationRequired === true
      && typeof data.whatsappQueueType === 'string'
      && typeof data.whatsappSourceCollection === 'string'
      && typeof data.whatsappJobId === 'string';
  }
  if (data.sourceType === 'academy_admin') {
    return data.academyId === academyId
      && typeof data.academyNotificationId === 'string'
      && documentId === `academy_${data.academyNotificationId}`
      && data.status === 'published'
      && data.createdByRole === 'academy_admin';
  }
  if (data.sourceType === 'teacher_created') return data.createdByUid === uid && data.createdByRole === 'teacher';
  // Legacy migration policy: before provenance was added, the only notification writer
  // besides the manual form was the monthly-report system writer, which always stores `type`.
  // Require the complete manual-alert shape; sender alone is never sufficient.
  return data.sourceType === undefined
    && data.type === undefined
    && data.notificationType === undefined
    && data.kind === undefined
    && data.sender === 'Tigerr_Alert System'
    && typeof data.targetClass === 'string';
}

function mapAlert(id: string, data: Record<string, unknown>): AlertRow | null {
  if (!isValidCategory(data.category)) return null;
  const created = timestampToDate(data.createdAt);
  const priority = data.priority === 'high' || data.priority === 'medium' ? data.priority : 'normal';
  return {
    id,
    title: String(data.title ?? '').trim(),
    message: String(data.message ?? '').trim(),
    category: data.category,
    priority,
    targetClass: typeof data.targetClass === 'string' && data.targetClass.trim() ? data.targetClass.trim() : 'All Classes',
    createdAt: created?.toISOString() ?? null,
    isRead: data.isRead === true,
    status: typeof data.status === 'string' ? data.status : 'active',
    legacy: data.category === 'WhatsApp' ? false : data.sourceType !== 'teacher_created' && data.sourceType !== 'academy_admin',
    academyPublished: data.sourceType === 'academy_admin',
    ...(data.category === 'WhatsApp' ? {
      whatsappReconciliationRequired: data.whatsappReconciliationRequired === true,
      whatsappReconciliationStatus: typeof data.whatsappReconciliationStatus === 'string' ? data.whatsappReconciliationStatus : null,
      whatsappSourceStatus: typeof data.whatsappSourceStatus === 'string' ? data.whatsappSourceStatus : null,
      whatsappQueueType: typeof data.whatsappQueueType === 'string' ? data.whatsappQueueType : null,
      whatsappSourceCollection: typeof data.whatsappSourceCollection === 'string' ? data.whatsappSourceCollection : null,
      whatsappJobId: typeof data.whatsappJobId === 'string' ? data.whatsappJobId : null,
      whatsappDispatchId: typeof data.whatsappDispatchId === 'string' ? data.whatsappDispatchId : null,
      whatsappRecipientId: typeof data.whatsappRecipientId === 'string' ? data.whatsappRecipientId : null,
      whatsappRecipientLast4: typeof data.whatsappRecipientLast4 === 'string' ? data.whatsappRecipientLast4 : null,
      whatsappProviderMessageId: typeof data.whatsappProviderMessageId === 'string' ? data.whatsappProviderMessageId : null,
    } : {}),
  };
}

async function authorizedRequest(path: string, body?: Record<string, unknown>) {
  const user = auth.currentUser;
  if (!user) throw new Error('Your session has expired. Sign in again.');
  const token = await user.getIdToken();
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' || (payload as Record<string, unknown>).success !== true) {
    const message = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
      ? String((payload as Record<string, unknown>).error)
      : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as Record<string, unknown>;
}

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { canAccessFeature, isDarkMode, toggleDarkMode } = useApp();
  const hasCustomAlerts = canAccessFeature('custom_alerts');
  const hasAnnouncements = canAccessFeature('announcements');
  const [tenant, setTenant] = useState<TenantContext | null>(null);
  const [tenantLoading, setTenantLoading] = useState(true);
  const generationRef = useRef(0);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState('');
  const [pageError, setPageError] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey());
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [classFilter, setClassFilter] = useState('All');
  const [activeSection, setActiveSection] = useState<'alerts' | 'failed' | 'analytics'>('alerts');
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [newCategory, setNewCategory] = useState<AlertCategory>('Announcements');
  const [newPriority, setNewPriority] = useState<Priority>('normal');
  const [newClass, setNewClass] = useState('All Classes');
  const [sendAnnouncementWhatsApp, setSendAnnouncementWhatsApp] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [reconcilingAlertId, setReconcilingAlertId] = useState<string | null>(null);
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);

  const sessionIsActive = useCallback((context: TenantContext) => {
    const user = auth.currentUser;
    return Boolean(user && tenant && tenant.generation === context.generation && tenant.uid === context.uid && tenant.tenantId === context.tenantId && user.uid === context.uid && normalizeTenantEmail(user.email) === context.tenantId && generationRef.current === context.generation);
  }, [tenant]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
      const generation = ++generationRef.current;
      setTenant(null);
      setAlerts([]);
      setClasses([]);
      setDashboard(null);
      setTenantLoading(Boolean(user));
      setAlertsLoading(Boolean(user));
      if (!user) {
        setTenantLoading(false);
        setAlertsLoading(false);
        return;
      }
      const email = normalizeTenantEmail(user.email);
      if (!email || email.includes('/')) {
        setTenantLoading(false);
        setAlertsLoading(false);
        setPageError('An active teacher workspace could not be verified for this account.');
        return;
      }
      try {
        const snapshot = await getDoc(doc(db, 'users', email));
        if (generation !== generationRef.current || auth.currentUser?.uid !== user.uid) return;
        if (!snapshot.exists() || !isOwnedActiveTeacherProfile(snapshot.data(), user.uid, user.email)) {
          setTenantLoading(false);
          setAlertsLoading(false);
          setPageError('This account does not own an active teacher workspace.');
          return;
        }
        setTenant({ tenantId: email, uid: user.uid, academyId: String(snapshot.data().academyId ?? ''), generation });
        setTenantLoading(false);
      } catch (error) {
        if (generation !== generationRef.current) return;
        setTenantLoading(false);
        setAlertsLoading(false);
        setPageError(error instanceof Error ? error.message : 'Teacher workspace verification failed.');
      }
    });
    return () => {
      generationRef.current += 1;
      unsubscribe();
    };
  }, []);

  const refreshAlerts = useCallback(async (context = tenant) => {
    if (!context || auth.currentUser?.uid !== context.uid) return;
    const path = tenantAlertsPath(context.tenantId);
    if (!path) return;
    setAlertsLoading(true);
    try {
      // The route itself requires alerts.view. Rules now authorize the whole private
      // teacher notification workspace with that permission, so Academy-published
      // alerts can arrive even when the teacher cannot create announcements or alerts.
      const snapshot = await getDocs(collection(db, path));
      if (auth.currentUser?.uid !== context.uid || generationRef.current !== context.generation) return;
      const rows = snapshot.docs
        .filter((item) => isTeacherCreatedAlert(item.data(), context.uid, item.id, context.academyId))
        .map((item) => mapAlert(item.id, item.data() as Record<string, unknown>))
        .filter((item): item is AlertRow => Boolean(item) && item.status !== 'archived')
        .sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0));
      setAlerts(rows);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Teacher-created alerts could not be loaded.');
      setAlerts([]);
    } finally {
      setAlertsLoading(false);
    }
  }, [tenant]);

  const refreshClasses = useCallback(async (context = tenant) => {
    if (!context || auth.currentUser?.uid !== context.uid) return;
    const path = tenantClassesPath(context.tenantId);
    if (!path) return;
    try {
      const snapshot = await getDocs(collection(db, path));
      if (auth.currentUser?.uid !== context.uid || generationRef.current !== context.generation) return;
      setClasses(snapshot.docs.map((item) => {
        const data = item.data();
        return { id: item.id, name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : typeof data.className === 'string' && data.className.trim() ? data.className.trim() : item.id, code: typeof data.code === 'string' ? data.code : undefined };
      }));
    } catch (error) {
      console.error('[Alerts] Class list fetch failed.', error);
      setClasses([]);
    }
  }, [tenant]);

  const refreshDashboard = useCallback(async (context = tenant, month = selectedMonth) => {
    if (!context || auth.currentUser?.uid !== context.uid) return;
    setDashboardLoading(true);
    setDashboardError('');
    try {
      const payload = await authorizedRequest(`/api/teacher/whatsapp/alerts-dashboard?month=${encodeURIComponent(month)}`);
      if (auth.currentUser?.uid !== context.uid || generationRef.current !== context.generation) return;
      setDashboard(payload as unknown as DashboardResponse);
    } catch (error) {
      if (auth.currentUser?.uid !== context.uid || generationRef.current !== context.generation) return;
      setDashboardError(error instanceof Error ? error.message : 'WhatsApp analytics could not be loaded.');
      setDashboard(null);
    } finally {
      setDashboardLoading(false);
    }
  }, [selectedMonth, tenant]);

  useEffect(() => {
    if (!tenant || auth.currentUser?.uid !== tenant.uid) return;
    const path = tenantAlertsPath(tenant.tenantId);
    if (!path) return;
    setAlertsLoading(true);
    const unsubscribe = onSnapshot(collection(db, path), (snapshot) => {
      if (auth.currentUser?.uid !== tenant.uid || generationRef.current !== tenant.generation) return;
      const rows = snapshot.docs
        .filter((item) => isTeacherCreatedAlert(item.data(), tenant.uid, item.id, tenant.academyId))
        .map((item) => mapAlert(item.id, item.data() as Record<string, unknown>))
        .filter((item): item is AlertRow => Boolean(item) && item.status !== 'archived')
        .sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0));
      setAlerts(rows);
      setAlertsLoading(false);
    }, (error) => {
      if (auth.currentUser?.uid !== tenant.uid || generationRef.current !== tenant.generation) return;
      setPageError(error.message || 'Teacher alerts could not be synchronized.');
      setAlerts([]);
      setAlertsLoading(false);
    });
    void refreshClasses(tenant);
    void refreshDashboard(tenant, selectedMonth);
    return () => unsubscribe();
  }, [tenant, selectedMonth, refreshClasses, refreshDashboard]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const reconciliationAlerts = useMemo(() => alerts.filter((item) =>
    item.category === 'WhatsApp'
    && item.whatsappReconciliationRequired === true
    && !['resolved_sent', 'requeued', 'resolved_automatically'].includes(item.whatsappReconciliationStatus ?? ''),
  ), [alerts]);

  const teacherAlerts = useMemo(() => alerts.filter((item) => item.category !== 'WhatsApp'), [alerts]);

  const visibleAlerts = useMemo(() => teacherAlerts.filter((item) => {
    const text = `${item.title} ${item.message} ${item.targetClass}`.toLowerCase();
    if (search.trim() && !text.includes(search.trim().toLowerCase())) return false;
    if (categoryFilter !== 'All' && item.category !== categoryFilter) return false;
    if (classFilter !== 'All' && item.targetClass !== classFilter) return false;
    return true;
  }), [teacherAlerts, search, categoryFilter, classFilter]);

  const failedMessages = useMemo(() => (dashboard?.failedMessages ?? []).filter((item) => new Date(item.expiresAt).getTime() > now), [dashboard, now]);
  const analytics = dashboard?.analytics;
  const totalAlerts = teacherAlerts.length;
  const monthMessages = analytics?.summary.total ?? null;
  const deliveryConfirmed = analytics?.summary.deliveryConfirmed ?? null;

  const loadAnnouncementDispatch = async (alertId: string, context: TenantContext) => {
    const request = async (body: Record<string, unknown>) => {
      if (!sessionIsActive(context)) throw new Error('The active teacher session changed. WhatsApp dispatch was stopped.');
      return authorizedRequest('/api/whatsapp/announcement-broadcast', body);
    };
    const prepared = await request({ action: 'prepare', alertId });
    const dispatchId = typeof prepared.dispatchId === 'string' ? prepared.dispatchId : '';
    if (!dispatchId) throw new Error('The announcement dispatch could not be prepared.');
    let latest = prepared;
    let pending = typeof latest.pendingCount === 'number' ? latest.pendingCount : 0;
    let iterations = 0;
    while (pending > 0 && iterations < 100) {
      if (!sessionIsActive(context)) throw new Error('The active teacher session changed. Remaining WhatsApp dispatch was stopped.');
      latest = await request({ action: 'dispatch', alertId, dispatchId });
      pending = typeof latest.pendingCount === 'number' ? latest.pendingCount : 0;
      iterations += 1;
      if (latest.status === 'needs_review') break;
    }
    await refreshDashboard(context, selectedMonth);
  };

  const handleCreateAlert = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !tenant || !sessionIsActive(tenant)) return;
    const title = newTitle.trim();
    const message = newMessage.trim();
    if (!title || !message) return;
    if (newCategory === 'Announcements' && !hasAnnouncements) {
      setPageError('Your Academy Admin has not granted announcement permission.');
      return;
    }
    if (newCategory !== 'Announcements' && !hasCustomAlerts) {
      setPageError('Your Academy Admin has not granted custom-alert permission.');
      return;
    }
    if (newClass !== 'All Classes' && !classes.some((item) => item.name === newClass)) {
      setPageError('Select a class from your own class list.');
      return;
    }
    const path = tenantAlertsPath(tenant.tenantId);
    if (!path) return;
    setSaving(true);
    setPageError('');
    const alertId = doc(collection(db, path)).id;
    let quotaReserved = false;
    let alertSaved = false;
    try {
      if (newCategory === 'Announcements') {
        const reserve = await authorizedRequest('/api/teacher/announcements/quota', { action: 'reserve', alertId, targetClass: newClass });
        if (reserve.success !== true) throw new Error('Announcement permission reservation failed.');
        quotaReserved = true;
      }
      const alertRef = doc(db, `${path}/${alertId}`);
      // `alertId` is generated by Firestore. Use a create write directly instead
      // of transaction.get(): the read is evaluated against category-dependent
      // notification read rules and can deny a not-yet-existing document.
      // If an ID collision ever occurs, the restrictive update rule rejects the
      // write because creation-only fields cannot be changed by a teacher.
      await setDoc(alertRef, {
        title,
        message,
        category: newCategory,
        priority: newPriority,
        targetClass: newClass,
        isRead: false,
        sender: 'Tigerr_Alert System',
        sourceType: 'teacher_created',
        createdByUid: tenant.uid,
        createdByRole: 'teacher',
        createdAt: serverTimestamp(),
        timestamp: 'Just now',
        whatsappSent: false,
        ...(newCategory === 'Announcements' ? {
          announcementQuotaReservationId: alertId,
          whatsappDispatchStatus: sendAnnouncementWhatsApp ? 'queued' : 'not_requested',
          ...(sendAnnouncementWhatsApp ? { whatsappEligibleCount: 0, whatsappPendingCount: 0, whatsappAcceptedCount: 0, whatsappRejectedCount: 0, whatsappUnknownOutcomeCount: 0, whatsappSkippedConsentChangedCount: 0 } : {}),
        } : {}),
      });
      alertSaved = true;
      if (quotaReserved) {
        await authorizedRequest('/api/teacher/announcements/quota', { action: 'commit', alertId, targetClass: newClass }).catch((error) => {
          console.warn('[Alerts] Announcement saved; permission reservation remains available for backend reconciliation.', error instanceof Error ? error.name : 'UnknownError');
        });
      }
      setCreateOpen(false);
      setNewTitle('');
      setNewMessage('');
      setNewCategory('Announcements');
      setNewPriority('normal');
      setNewClass('All Classes');
      setSendAnnouncementWhatsApp(false);
      await refreshAlerts(tenant);
      if (newCategory === 'Announcements' && sendAnnouncementWhatsApp) {
        void loadAnnouncementDispatch(alertId, tenant).catch((error) => {
          setPageError(error instanceof Error ? `Announcement saved, but WhatsApp dispatch stopped: ${error.message}` : 'Announcement saved, but WhatsApp dispatch stopped.');
          void refreshDashboard(tenant, selectedMonth);
        });
      }
    } catch (error) {
      if (quotaReserved && !alertSaved) {
        void authorizedRequest('/api/teacher/announcements/quota', { action: 'release', alertId, targetClass: newClass }).catch(() => undefined);
      }
      setPageError(error instanceof Error ? error.message : 'The alert could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAlert = async (item: AlertRow) => {
    if (!tenant || !sessionIsActive(tenant)) return;
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    const path = tenantAlertsPath(tenant.tenantId);
    if (!path) return;
    try {
      await deleteDoc(doc(db, `${path}/${item.id}`));
      setAlerts((current) => current.filter((row) => row.id !== item.id));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'The alert could not be deleted.');
    }
  };

  const handleReconcile = async (item: AlertRow, decision: 'confirmed_sent' | 'confirmed_not_sent') => {
    if (!tenant || !sessionIsActive(tenant) || item.category !== 'WhatsApp'
      || item.whatsappReconciliationRequired !== true || reconcilingAlertId) return;
    const confirmation = decision === 'confirmed_sent'
      ? 'Have you checked the Postabi/provider history and confirmed that this message was sent? EduTrack will mark it as manually confirmed sent and will not send it again. This does not independently confirm delivery.'
      : 'Have you checked the Postabi/provider history and confirmed that this message was NOT sent? EduTrack will return the same queue item to the worker, which will revalidate it before sending.';
    if (!window.confirm(confirmation)) return;
    setReconcilingAlertId(item.id);
    setPageError('');
    try {
      await authorizedRequest('/api/teacher/whatsapp/reconcile', {
        alertId: item.id,
        decision,
      });
      await refreshAlerts(tenant);
      await refreshDashboard(tenant, selectedMonth);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'WhatsApp outcome could not be reconciled. Refresh and check the provider record before trying again.');
      await refreshAlerts(tenant);
    } finally {
      setReconcilingAlertId(null);
    }
  };

  const handleRetry = async (message: FailedMessage) => {
    if (!message.canRetry || !message.dispatchId || !message.recipientId || !message.alertId || retryingId || !tenant || !sessionIsActive(tenant)) return;
    setRetryingId(message.id);
    setPageError('');
    try {
      await authorizedRequest('/api/whatsapp/announcement-broadcast', {
        action: 'retry',
        alertId: message.alertId,
        dispatchId: message.dispatchId,
        recipientId: message.recipientId,
      });
      await refreshDashboard(tenant, selectedMonth);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Retry could not be completed. Check the message outcome before another attempt.');
      await refreshDashboard(tenant, selectedMonth);
    } finally {
      setRetryingId(null);
    }
  };

  const refreshAll = async () => {
    if (!tenant) return;
    await Promise.all([refreshAlerts(tenant), refreshClasses(tenant), refreshDashboard(tenant, selectedMonth)]);
  };

  const monthLabel = new Intl.DateTimeFormat('en-PK', { month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date(`${selectedMonth}-01T00:00:00+05:00`));
  const chartData = analytics?.dailyActivity ?? [];
  const categoryChartData = analytics?.categories.filter((item) => item.dataAvailable).map((item) => ({ name: item.label, accepted: item.counts.providerAccepted, failed: item.counts.failed, total: item.counts.total })) ?? [];
  const statusChartData = analytics ? [
    { name: 'Accepted · not delivered', value: Math.max(0, analytics.summary.providerAccepted - analytics.summary.deliveryConfirmed), color: '#0ea5e9' },
    { name: 'Delivered', value: analytics.summary.deliveryConfirmed, color: '#10b981' },
    { name: 'Failed', value: analytics.summary.failed, color: '#ef4444' },
    { name: 'Pending', value: analytics.summary.pending, color: '#f59e0b' },
    { name: 'Unknown', value: analytics.summary.unknown, color: '#8b5cf6' },
  ].filter((item) => item.value > 0) : [];

  if (tenantLoading) {
    return <div className="alerts-page flex min-h-[60vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-orange-500" /></div>;
  }
  if (!tenant) {
    return <div className="alerts-page mx-auto max-w-3xl p-8"><div className="rounded-3xl border border-border bg-card p-8 text-center"><ShieldAlert className="mx-auto mb-3 h-10 w-10 text-orange-500"/><h1 className="text-2xl font-bold">Alerts & Notices</h1><p className="mt-2 text-sm text-muted-foreground">{pageError || 'An active teacher workspace is required.'}</p></div></div>;
  }

  return (
    <div className={`alerts-page min-h-screen w-full ${isDarkMode ? 'alerts-page-dark' : ''}`}>
      <div className="alerts-page-inner mx-auto max-w-[1680px] space-y-6 px-3 py-4 sm:px-5 lg:px-7 lg:py-6">
        <header className="alerts-header flex flex-col gap-4 rounded-3xl border border-border/70 bg-card/85 p-4 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => navigate(-1)} className="alerts-icon-button" aria-label="Go back"><ArrowLeft className="h-5 w-5" /></button>
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-400 text-white shadow-lg shadow-orange-500/20"><BellRing className="h-6 w-6" /></div>
            <div className="min-w-0"><h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Alerts & Notices</h1><p className="text-xs text-muted-foreground sm:text-sm">Teacher alerts · WhatsApp failures · Monthly insights</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <button onClick={() => void refreshAll()} className="alerts-secondary-button"><RefreshCw className="h-4 w-4"/> Refresh</button>
            <button onClick={toggleDarkMode} className="alerts-secondary-button" aria-label="Toggle theme">{isDarkMode ? <Sun className="h-4 w-4"/> : <Moon className="h-4 w-4"/>}</button>
            {(hasAnnouncements || hasCustomAlerts) && <button onClick={() => setCreateOpen(true)} className="alerts-primary-button"><Plus className="h-4 w-4"/> Send Alert</button>}
          </div>
        </header>

        <section className="alerts-hero relative overflow-hidden rounded-[30px] border border-orange-200/80 p-5 shadow-[0_20px_50px_-36px_rgba(234,88,12,.55)] sm:p-7 lg:p-8">
          <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-orange-300/20 blur-3xl" />
          <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-2xl"><div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-white/75 px-3 py-1 text-[11px] font-bold uppercase tracking-[.14em] text-orange-700"><SparkleIcon /> EduTrack Communication</div><h2 className="text-2xl font-black tracking-tight text-slate-900 sm:text-3xl lg:text-4xl">Keep every update clear.</h2><p className="mt-2 max-w-xl text-sm text-slate-600 sm:text-base">Manage teacher notices, resolve eligible message failures, and review real WhatsApp activity for the selected month.</p></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[650px]">
              <Metric icon={BellRing} label="Total Alerts" value={alertsLoading ? '—' : totalAlerts.toLocaleString()} tone="orange" />
              <Metric icon={AlertTriangle} label="Failed" value={dashboardLoading ? '—' : failedMessages.length.toLocaleString()} tone="red" />
              <Metric icon={MessageCircle} label="Messages · Month" value={dashboardLoading || monthMessages === null ? '—' : monthMessages.toLocaleString()} tone="blue" />
              <Metric icon={CheckCircle2} label="Delivered" value={dashboardLoading || deliveryConfirmed === null ? '—' : deliveryConfirmed.toLocaleString()} tone="green" />
            </div>
          </div>
        </section>

        {pageError && <div role="alert" className="alerts-error-banner"><AlertTriangle className="h-4 w-4 shrink-0"/><span>{pageError}</span><button onClick={() => setPageError('')} aria-label="Dismiss error"><X className="h-4 w-4"/></button></div>}

        <nav className="alerts-section-nav" aria-label="Alerts page sections">
          <button className={activeSection === 'alerts' ? 'active' : ''} onClick={() => setActiveSection('alerts')}><Megaphone className="h-4 w-4"/> Teacher Alerts <span>{teacherAlerts.length}</span></button>
          <button className={activeSection === 'failed' ? 'active' : ''} onClick={() => setActiveSection('failed')}><ShieldAlert className="h-4 w-4"/> WhatsApp Issues <span>{failedMessages.length + reconciliationAlerts.length}</span></button>
          <button className={activeSection === 'analytics' ? 'active' : ''} onClick={() => setActiveSection('analytics')}><BarChart3 className="h-4 w-4"/> Monthly Analytics</button>
        </nav>

        {activeSection === 'alerts' && <section className="space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div><p className="alerts-kicker">01 / Teacher-created</p><h2 className="text-xl font-extrabold tracking-tight">Teacher Alerts</h2><p className="mt-1 text-sm text-muted-foreground">Only notices created by this teacher workspace.</p></div>{(hasAnnouncements || hasCustomAlerts) && <button onClick={() => setCreateOpen(true)} className="alerts-primary-button self-start"><Plus className="h-4 w-4"/> Create New Alert</button>}</div>
          <div className="alerts-filter-panel grid grid-cols-1 gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-sm md:grid-cols-[minmax(0,1fr)_190px_190px]">
            <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, message, class..." className="alerts-input pl-10" /></div>
            <div className="relative"><Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="alerts-input pl-10"><option value="All">All categories</option>{(hasCustomAlerts ? ALERT_CATEGORIES : ['Announcements'] as AlertCategory[]).map((item) => <option key={item}>{item}</option>)}</select></div>
            <div className="relative"><Users className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><select value={classFilter} onChange={(event) => setClassFilter(event.target.value)} className="alerts-input pl-10"><option value="All">All classes</option>{[...new Set(classes.map((item) => item.name))].sort().map((item) => <option key={item}>{item}</option>)}</select></div>
          </div>
          {alertsLoading ? <LoadingPanel label="Loading teacher alerts..."/> : visibleAlerts.length === 0 ? <EmptyPanel icon={Megaphone} title="No teacher alerts found" description="Create an alert or adjust your search and filters." action={(hasAnnouncements || hasCustomAlerts) ? <button className="alerts-primary-button" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4"/> Create Alert</button> : undefined}/> : <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">{visibleAlerts.map((item) => {
            const style = CATEGORY_STYLE[item.category];
            const Icon = style.icon;
            const expanded = expandedAlertId === item.id;
            return <article key={item.id} className="alerts-card group rounded-3xl border border-border/70 bg-card p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg">
              <div className="flex items-start gap-3"><div className={`alerts-category-icon ${style.className}`}><Icon className="h-5 w-5"/></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`alerts-category-pill ${style.className}`}>{style.label}</span><span className={`alerts-priority-pill priority-${item.priority}`}>{item.priority}</span>{item.legacy && <span className="alerts-legacy-pill">Legacy</span>}{item.academyPublished && <span className="alerts-legacy-pill">Academy Admin</span>}</div><h3 className="mt-2 line-clamp-2 text-base font-extrabold text-foreground">{item.title}</h3></div>{!item.academyPublished && <button onClick={() => void handleDeleteAlert(item)} className="alerts-icon-button alerts-delete-button" title="Delete alert" aria-label={`Delete ${item.title}`}><Trash2 className="h-4 w-4"/></button>}</div>
              <p className={`mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground ${expanded ? '' : 'line-clamp-3'}`}>{item.message}</p>
              {item.message.length > 145 && <button className="mt-1 text-xs font-bold text-orange-600 hover:underline" onClick={() => setExpandedAlertId(expanded ? null : item.id)}>{expanded ? 'Show less' : 'View details'}</button>}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><GraduationCap className="h-3.5 w-3.5"/>{item.targetClass}</span><span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5"/>{formatDate(item.createdAt)}</span></div>
            </article>;
          })}</div>}
        </section>}

        {activeSection === 'failed' && <section className="space-y-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="alerts-kicker">02 / WhatsApp issue handling</p><h2 className="text-xl font-extrabold tracking-tight">WhatsApp Issues & Reconciliation</h2><p className="mt-1 text-sm text-muted-foreground">Check provider history before making a manual decision. Unknown outcomes are never resent automatically.</p></div><button className="alerts-secondary-button self-start" onClick={() => { if (tenant) { void refreshDashboard(tenant, selectedMonth); void refreshAlerts(tenant); } }}><RefreshCw className="h-4 w-4"/> Refresh queue</button></div>
          {alertsLoading ? <LoadingPanel label="Checking unresolved provider outcomes..."/> : reconciliationAlerts.length === 0 ? null : <div className="space-y-3"><div><h3 className="font-extrabold">Provider outcome needs review</h3><p className="mt-1 text-xs text-muted-foreground">Use the provider dashboard or message history to verify the outcome. A provider acceptance is not the same as confirmed delivery.</p></div><div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{reconciliationAlerts.map((item) => <article key={item.id} className="alerts-failed-card rounded-3xl border border-amber-200/80 bg-card p-5 shadow-sm"><div className="flex items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><MessageCircle className="h-5 w-5"/></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-extrabold uppercase tracking-wider text-amber-700">{(item.whatsappSourceStatus ?? 'unknown_outcome').replace(/_/g, ' ')}</span><span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold text-amber-800">Review required</span></div><h3 className="mt-1 text-base font-bold">{item.title}</h3><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.message}</p></div></div><div className="mt-4 grid grid-cols-2 gap-2"><MiniValue label="Queue type" value={(item.whatsappQueueType ?? 'unknown').replace(/_/g, ' ')}/><MiniValue label="Recipient" value={item.whatsappRecipientLast4 ? `Ending ${item.whatsappRecipientLast4}` : 'Not available'}/></div>{item.whatsappProviderMessageId && <p className="mt-2 break-all text-[11px] text-muted-foreground">Provider message ID: {item.whatsappProviderMessageId}</p>}<div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row"><button disabled={reconcilingAlertId === item.id} onClick={() => void handleReconcile(item, 'confirmed_sent')} className="alerts-secondary-button flex-1">{reconcilingAlertId === item.id ? <Loader2 className="h-4 w-4 animate-spin"/> : <CheckCircle2 className="h-4 w-4"/>} Confirm sent</button><button disabled={reconcilingAlertId === item.id} onClick={() => void handleReconcile(item, 'confirmed_not_sent')} className="alerts-retry-button flex-1">{reconcilingAlertId === item.id ? <Loader2 className="h-4 w-4 animate-spin"/> : <RefreshCw className="h-4 w-4"/>} Confirm not sent & requeue</button></div></article>)}</div></div>}
          {dashboard?.failedMessagesMayBeIncomplete && <div className="alerts-note rounded-2xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">Only the latest bounded set of WhatsApp issue records is shown to protect Firestore read quota.</div>}
          {dashboardLoading ? <LoadingPanel label="Checking definitive provider failures..."/> : failedMessages.length === 0 ? (reconciliationAlerts.length === 0 && !alertsLoading ? <EmptyPanel icon={CheckCircle2} title="No active WhatsApp issues" description="There are no unresolved provider outcomes or eligible failed messages."/> : null) : <div className="space-y-3"><h3 className="font-extrabold">Definitive provider failures</h3><div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{failedMessages.map((message) => <article key={message.id} className="alerts-failed-card rounded-3xl border border-rose-200/80 bg-card p-5 shadow-sm"><div className="flex items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-50 text-rose-600"><AlertTriangle className="h-5 w-5"/></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-extrabold uppercase tracking-wider text-rose-600">{message.category}</span><span className="rounded-full bg-rose-100 px-2.5 py-1 text-[10px] font-bold text-rose-700">Failed</span></div><h3 className="mt-1 text-base font-bold">{message.className}{message.studentName ? ` · ${message.studentName}` : ''}</h3><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{message.failureReason}</p></div></div><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3"><MiniValue label="Failed at" value={formatDate(message.failedAt)}/><MiniValue label="Attempts" value={String(message.attemptCount)}/><MiniValue label="Expires" value={remainingTime(message.expiresAt, now)} tone="rose"/></div><div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">{message.canRetry ? 'Server verified as safe to retry.' : 'Manual retry is disabled for this provider path.'}</p><button disabled={!message.canRetry || retryingId === message.id} onClick={() => void handleRetry(message)} className="alerts-retry-button">{retryingId === message.id ? <Loader2 className="h-4 w-4 animate-spin"/> : <RefreshCw className="h-4 w-4"/>}{message.canRetry ? 'Retry message' : 'Retry unavailable'}</button></div></article>)}</div></div>}
          <div className="alerts-note flex items-start gap-2 rounded-2xl border border-border/70 bg-card/80 p-4 text-xs text-muted-foreground"><Info className="mt-0.5 h-4 w-4 shrink-0 text-orange-500"/><p>Only confirm an outcome after checking the provider's message history. “Confirm sent” suppresses another send but does not claim delivery was independently confirmed. “Confirm not sent” returns the same persistent queue item to the worker; it does not create a second job.</p></div>
        </section>}

        {activeSection === 'analytics' && <section className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="alerts-kicker">03 / WhatsApp insights</p><h2 className="text-xl font-extrabold tracking-tight">Monthly WhatsApp Analytics</h2><p className="mt-1 text-sm text-muted-foreground">Provider acceptance and confirmed delivery are counted separately.</p></div><div className="flex flex-wrap items-center gap-2"><label className="text-xs font-bold text-muted-foreground" htmlFor="alerts-month">Month</label><input id="alerts-month" type="month" max={currentMonthKey()} value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} className="alerts-input w-auto min-w-[155px]"/></div></div>
          {dashboardError && <div className="alerts-error-banner"><AlertTriangle className="h-4 w-4"/><span>{dashboardError}</span></div>}
          {dashboardLoading ? <LoadingPanel label="Loading monthly WhatsApp analytics..."/> : analytics ? <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"><SummaryTile label="Total" value={analytics.summary.total} tone="orange"/><SummaryTile label="Provider accepted" value={analytics.summary.providerAccepted} tone="blue"/><SummaryTile label="Delivered" value={analytics.summary.deliveryConfirmed} tone="green"/><SummaryTile label="Failed" value={analytics.summary.failed} tone="red"/><SummaryTile label="Pending" value={analytics.summary.pending} tone="amber"/><SummaryTile label="Unknown" value={analytics.summary.unknown} tone="violet"/></div>
            <div className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"><div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between"><div><p className="alerts-kicker">Category summary</p><h3 className="text-lg font-extrabold">{monthLabel}</h3></div><span className="text-xs text-muted-foreground">Timezone: Asia/Karachi</span></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">{analytics.categories.map((category, index) => <CategoryTile key={category.key} category={category} color={CHART_COLORS[index % CHART_COLORS.length]}/>)}</div></div>
            {!analytics.categories.every((category) => category.dataAvailable) && <div className="alerts-note flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-900"><Info className="mt-0.5 h-4 w-4 shrink-0"/><p>Some categories have no persisted historical records in this month. Their empty state is shown as unavailable, not as a verified zero. Historical provider attempt-level records are not available in every legacy dispatch flow.</p></div>}
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2"><div className="alerts-chart-card rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Daily message activity" detail="All persisted outcomes by Pakistan local date"/><div className="h-[280px] w-full">{chartData.some((item) => item.total > 0) ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><defs><linearGradient id="alertsDailyGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f97316" stopOpacity={0.28}/><stop offset="95%" stopColor="#f97316" stopOpacity={0.02}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--alerts-chart-grid)"/><XAxis dataKey="day" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/><YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/><Tooltip/><Area type="monotone" dataKey="total" name="Messages" stroke="#f97316" strokeWidth={2.5} fill="url(#alertsDailyGradient)"/></AreaChart></ResponsiveContainer> : <ChartEmpty />}</div></div>
              <div className="alerts-chart-card rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Category comparison" detail="Accepted and failed message records"/><div className="h-[280px] w-full">{categoryChartData.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={categoryChartData} margin={{ top: 8, right: 8, bottom: 6, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--alerts-chart-grid)"/><XAxis dataKey="name" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/><Tooltip/><Bar dataKey="accepted" name="Provider accepted" fill="#0ea5e9" radius={[6, 6, 0, 0]}/><Bar dataKey="failed" name="Failed" fill="#ef4444" radius={[6, 6, 0, 0]}/></BarChart></ResponsiveContainer> : <ChartEmpty />}</div></div></div>
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,.6fr)]"><div className="alerts-chart-card rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Daily delivery states" detail="Month-wide daily distribution"/><div className="h-[280px] w-full">{chartData.some((item) => item.total > 0) ? <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--alerts-chart-grid)"/><XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}/><YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/><Tooltip/><Bar dataKey="providerAccepted" name="Provider accepted" stackId="a" fill="#0ea5e9"/><Bar dataKey="failed" name="Failed" stackId="a" fill="#ef4444"/><Bar dataKey="pending" name="Pending" stackId="a" fill="#f59e0b"/><Bar dataKey="unknown" name="Unknown" stackId="a" fill="#8b5cf6"/></BarChart></ResponsiveContainer> : <ChartEmpty />}</div></div>
              <div className="alerts-chart-card rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"><ChartHeading title="Outcome breakdown" detail="Latest persisted outcome per source record"/><div className="h-[220px] w-full">{statusChartData.length ? <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={statusChartData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={82} paddingAngle={3}>{statusChartData.map((item) => <Cell key={item.name} fill={item.color}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer> : <ChartEmpty />}</div><div className="flex flex-wrap justify-center gap-x-4 gap-y-2">{statusChartData.map((item) => <span key={item.name} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }}/>{item.name}: {item.value}</span>)}</div></div></div>
            {analytics.comparison && <div className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-card p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="alerts-kicker">Month over month</p><p className="font-bold">Compared with {analytics.comparison.previousMonth}</p><p className="text-xs text-muted-foreground">{analytics.comparison.previousTotal.toLocaleString()} messages in the previous month</p></div><div className="flex items-center gap-2 text-lg font-extrabold"><TrendingUp className="h-5 w-5 text-orange-500"/><span>{analytics.comparison.change >= 0 ? '+' : ''}{analytics.comparison.change.toLocaleString()}</span><span className="text-sm font-semibold text-muted-foreground">{analytics.comparison.percentChange === null ? '—' : `${analytics.comparison.percentChange}%`}</span></div></div>}
            {analytics.historicalDataNote && <p className="text-xs text-muted-foreground">{analytics.historicalDataNote}</p>}
            {analytics.partialDataNote && <div className="alerts-note flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-900"><Info className="mt-0.5 h-4 w-4 shrink-0"/><p>{analytics.partialDataNote}</p></div>}
            <p className="text-[11px] leading-5 text-muted-foreground">{analytics.countingPolicy}</p>
          </> : <EmptyPanel icon={BarChart3} title="Analytics unavailable" description={dashboardError || 'No analytics response is currently available.'} action={<button className="alerts-secondary-button" onClick={() => tenant && void refreshDashboard(tenant, selectedMonth)}><RefreshCw className="h-4 w-4"/> Try again</button>}/>}
        </section>}

        <footer className="flex flex-col gap-2 border-t border-border/60 py-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>EduTrack Alerts · Tenant-secure activity</span><span>Only confirmed delivery receipts count as delivered.</span></footer>
      </div>

      {createOpen && <div className="alerts-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setCreateOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="create-alert-title" className="alerts-modal"><div className="flex items-start justify-between gap-4 border-b border-border/70 p-5"><div><p className="alerts-kicker">New teacher notice</p><h2 id="create-alert-title" className="text-xl font-extrabold">Broadcast New Alert</h2><p className="mt-1 text-xs text-muted-foreground">Save a notice for the selected class or all classes.</p></div><button className="alerts-icon-button" onClick={() => !saving && setCreateOpen(false)} aria-label="Close"><X className="h-5 w-5"/></button></div><form onSubmit={handleCreateAlert} className="space-y-4 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="space-y-1.5 text-xs font-bold">Category<select className="alerts-input" value={newCategory} onChange={(event) => setNewCategory(event.target.value as AlertCategory)}>{(hasCustomAlerts ? ALERT_CATEGORIES : ['Announcements'] as AlertCategory[]).map((item) => <option key={item}>{item}</option>)}</select></label><label className="space-y-1.5 text-xs font-bold">Priority<select className="alerts-input" value={newPriority} onChange={(event) => setNewPriority(event.target.value as Priority)}>{PRIORITIES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select></label></div>
        <label className="block space-y-1.5 text-xs font-bold">Target class<select className="alerts-input" value={newClass} onChange={(event) => setNewClass(event.target.value)}><option>All Classes</option>{classes.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
        <label className="block space-y-1.5 text-xs font-bold">Title<input required maxLength={120} className="alerts-input" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Enter alert title"/></label>
        <label className="block space-y-1.5 text-xs font-bold">Message<textarea required maxLength={2000} rows={5} className="alerts-input resize-y" value={newMessage} onChange={(event) => setNewMessage(event.target.value)} placeholder="Write the notice for students and guardians..."/></label>
        {newCategory === 'Announcements' && <label className="flex items-start gap-3 rounded-2xl border border-orange-200 bg-orange-50/70 p-3 text-sm dark:bg-orange-950/20"><input type="checkbox" className="mt-1 h-4 w-4 accent-orange-500" checked={sendAnnouncementWhatsApp} onChange={(event) => setSendAnnouncementWhatsApp(event.target.checked)} disabled={!hasAnnouncements}/><span><span className="block font-bold">Send branded WhatsApp image</span><span className="block text-xs font-normal text-muted-foreground">Also send this announcement to eligible parent/guardian WhatsApp numbers now. Uses the existing consent-checked announcement broadcast and Academy permission flow.</span></span></label>}
        {pageError && <div className="alerts-error-banner"><AlertTriangle className="h-4 w-4"/>{pageError}</div>}
        <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:justify-end"><button type="button" onClick={() => setCreateOpen(false)} disabled={saving} className="alerts-secondary-button">Cancel</button><button type="submit" disabled={saving || !newTitle.trim() || !newMessage.trim()} className="alerts-primary-button">{saving ? <Loader2 className="h-4 w-4 animate-spin"/> : <Send className="h-4 w-4"/>}{saving ? 'Saving...' : 'Save Alert'}</button></div>
      </form></section></div>}
    </div>
  );
}

function SparkleIcon() { return <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500"/>; }
function Metric({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: string; tone: string }) {
  return <div className={`alerts-hero-metric tone-${tone} rounded-2xl border bg-white/80 p-3 shadow-sm`}><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span><Icon className="h-4 w-4"/></div><p className="mt-2 text-xl font-black text-slate-900 sm:text-2xl">{value}</p></div>;
}
function SummaryTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`alerts-summary-tile tone-${tone} rounded-2xl border border-border/70 bg-card p-4 shadow-sm`}><p className="text-xs font-semibold text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-black tracking-tight">{value.toLocaleString()}</p></div>;
}
function CategoryTile({ category, color }: { category: CategoryAnalytics; color: string }) {
  const value = (number: number | null) => number === null ? '—' : number.toLocaleString();
  return <div className="alerts-category-tile rounded-2xl border border-border/70 bg-background/70 p-4"><div className="mb-3 flex items-center justify-between gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }}/><span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{category.dataAvailable ? 'Tracked' : 'No data'}</span></div><h4 className="font-extrabold">{category.label}</h4><p className="mt-1 text-2xl font-black">{category.dataAvailable ? value(category.counts.total) : '—'}</p><div className="mt-3 space-y-1.5 text-[11px] text-muted-foreground"><div className="flex justify-between gap-2"><span>Accepted</span><strong className="text-foreground">{category.dataAvailable ? value(category.counts.providerAccepted) : '—'}</strong></div><div className="flex justify-between gap-2"><span>Delivered</span><strong className="text-foreground">{category.dataAvailable && category.deliveryTrackingAvailable ? value(category.counts.deliveryConfirmed) : '—'}</strong></div><div className="flex justify-between gap-2"><span>Failed</span><strong className="text-foreground">{category.dataAvailable ? value(category.counts.failed) : '—'}</strong></div></div></div>;
}
function MiniValue({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-xl bg-muted/50 px-3 py-2"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 text-xs font-bold ${tone === 'rose' ? 'text-rose-600' : 'text-foreground'}`}>{value}</p></div>;
}
function ChartHeading({ title, detail }: { title: string; detail: string }) {
  return <div className="mb-3"><h3 className="font-extrabold">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>;
}
function ChartEmpty() { return <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border text-xs text-muted-foreground">No persisted activity for this chart.</div>; }
function LoadingPanel({ label }: { label: string }) { return <div className="flex min-h-44 items-center justify-center gap-3 rounded-3xl border border-border/70 bg-card text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-orange-500"/>{label}</div>; }
function EmptyPanel({ icon: Icon, title, description, action }: { icon: React.ElementType; title: string; description: string; action?: React.ReactNode }) { return <div className="flex min-h-52 flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card/70 p-7 text-center"><div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 dark:bg-orange-950/30"><Icon className="h-6 w-6"/></div><h3 className="font-extrabold">{title}</h3><p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>{action && <div className="mt-4">{action}</div>}</div>; }
