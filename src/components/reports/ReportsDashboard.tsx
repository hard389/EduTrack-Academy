import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';

// FIREBASE IMPORTS
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import {
  calculateMonthlyStudentMetrics,
  getFeeStatusForStudent,
  getMonthlyFeeRecords,
  getReportMonthDateRange,
  isAuthorizedTeacherProfile,
  normalizeGradingRemarksMap,
  normalizeReportMonth,
  normalizeReportRoster,
  normalizeTenantEmail,
  resolvePersonalizedRemark,
  REMARK_CATEGORY_ORDER,
  type GradingRemarkPreset,
  type GradingRemarksMap,
  type ReportCategory,
  type ReportDocument,
  type StudentReportMetrics,
} from '@/components/reports/ReportsDashboard.logic';
import { 
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  serverTimestamp,
  query,
  where,
  documentId,
  Timestamp,
  type DocumentData,
} from 'firebase/firestore';

// UI ICONS (Lucide React)
import {
  Home,
  GraduationCap,
  Users,
  Wallet,
  Settings,
  ArrowLeft,
  Check,
  Zap,
  BookOpen,
  Award,
  AlertCircle,
  TrendingUp,
  ThumbsUp,
  Loader2,
  Sun,
  Moon,
  Search,
  AlertTriangle,
  ExternalLink,
  ShieldAlert,
  X,
  ChevronLeft,
  ChevronRight,
  Printer,
  Sparkles,
  FileCheck,
  UserCheck,
  Calendar,
  Send,
  Eye,
  Building2,
  Mail,
  Phone,
  type LucideIcon,
} from 'lucide-react';

// HELPER: Dynamic Month Info & Label Formatting
const getTwoMonthsInfo = () => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const currDate = new Date(currentYear, currentMonth, 1);
  const prevDate = new Date(currentYear, currentMonth - 1, 1);

  const currentKey = `${currDate.getFullYear()}-${String(currDate.getMonth() + 1).padStart(2, '0')}`;
  const previousKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const currentLabel = currDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const previousLabel = prevDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  return { currentKey, previousKey, currentLabel, previousLabel };
};

const normalizeConsentPhone = (value: unknown): string => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`;
  return digits;
};

const formatMonthLabel = (monthKey: string) => {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  if (isNaN(year) || isNaN(month)) return monthKey;

  const date = new Date(year, month - 1, 1);
  const monthName = date.toLocaleString('default', { month: 'long', year: 'numeric' });

  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return monthKey === currentKey ? `Current: ${monthName}` : monthName;
};

// Parse displayed attendance/quiz metrics without guessing when a value is unavailable.
// Supports values such as `92%`, `9/10`, `9/10 (90%)`, and numeric percentages.
const parseMetricPercentage = (value: unknown, allowBareNumeric = true): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!allowBareNumeric && value > 1 && value < 20) return null;
    const normalized = value >= 0 && value <= 1 ? value * 100 : value;
    return normalized >= 0 && normalized <= 100 ? normalized : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /^(?:—|-|n\/a|unavailable|loading(?:…|\.\.\.)?)$/i.test(text)) return null;

  const percentMatch = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    const percent = Number(percentMatch[1]);
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
  }

  const fractionMatch = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0 || numerator < 0) return null;
    const percent = (numerator / denominator) * 100;
    return percent >= 0 && percent <= 100 ? percent : null;
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  if (!allowBareNumeric && numeric > 1 && numeric < 20) return null;
  const normalized = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Number.isFinite(normalized) && normalized >= 0 && normalized <= 100 ? normalized : null;
};

// TYPES & SCHEMAS
export type CategoryType = ReportCategory;
export type NavTab = 'home' | 'classes' | 'attendance' | 'fees' | 'settings';

export interface GradingCriteria {
  homework: string;
  behavior: string;
  participation: string;
  performance: string;
}

// Per-teacher report field configuration stored at
// users/{teacherEmail}/settings/report_config -> reportMetrics.
// Missing flags retain the legacy report layout for existing accounts.
type ReportFieldConfig = {
  homeworkEnabled: boolean;
  behaviorEnabled: boolean;
  participationEnabled: boolean;
  performanceEnabled: boolean;
  teacherRemarksRequired: boolean;
};

const DEFAULT_REPORT_FIELD_CONFIG: ReportFieldConfig = {
  homeworkEnabled: true,
  behaviorEnabled: true,
  participationEnabled: true,
  performanceEnabled: true,
  teacherRemarksRequired: true,
};

type MonthlyReportPreparationResult = {
  success: true;
  status: "prepared_for_vercel" | "already_prepared";
  jobId: string;
  message?: string;
  messageSent: false;
  pdfDelivered: false;
};

async function prepareMonthlyReportWithVercel(
  input: {
    classId: string;
    studentId: string;
    monthKey: string;
    source: "manual" | "automatic";
  },
  expectedEmail: string,
): Promise<MonthlyReportPreparationResult> {
  const user = auth.currentUser;

  if (
    !user ||
    user.email?.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    throw new Error("The authenticated teacher session changed.");
  }

  const idToken = await user.getIdToken();

  const response = await fetch("/api/teacher/monthly-reports/prepare", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Monthly report preparation failed (${response.status}).`;

    throw new Error(message);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("success" in payload) ||
    payload.success !== true ||
    !("status" in payload) ||
    (payload.status !== "prepared_for_vercel" && payload.status !== "already_prepared") ||
    !("jobId" in payload) ||
    typeof payload.jobId !== "string" ||
    !payload.jobId
  ) {
    throw new Error("The monthly report API returned an invalid preparation response.");
  }

  return payload as MonthlyReportPreparationResult;
}

type MonthlyReportDispatchResult = {
  success: true;
  status: "unknown_outcome";
  jobId: string;
  message?: string;
  messageSent: "unconfirmed";
  pdfDelivered: false;
  providerHttpStatus?: number | null;
};

async function dispatchMonthlyReportWithVercel(
  jobId: string,
  expectedEmail: string,
): Promise<MonthlyReportDispatchResult> {
  const user = auth.currentUser;

  if (
    !user ||
    user.email?.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    throw new Error("The authenticated teacher session changed.");
  }

  const idToken = await user.getIdToken();

  const response = await fetch("/api/teacher/monthly-reports/dispatch", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jobId }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Monthly report dispatch failed (${response.status}).`;

    throw new Error(message);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("success" in payload) ||
    payload.success !== true ||
    !("status" in payload) ||
    payload.status !== "unknown_outcome" ||
    !("jobId" in payload) ||
    payload.jobId !== jobId ||
    !("messageSent" in payload) ||
    payload.messageSent !== "unconfirmed" ||
    !("pdfDelivered" in payload) ||
    payload.pdfDelivered !== false
  ) {
    throw new Error("The monthly report dispatch API returned an invalid response.");
  }

  return payload as MonthlyReportDispatchResult;
}

type MonthlyReportReconciliationResult = {
  success: true;
  status: "delivered" | "unknown_outcome";
  jobId: string;
  message?: string;
  messageSent: boolean | "unconfirmed";
  pdfDelivered: boolean;
  providerStatus?: string;
};

async function reconcileMonthlyReportWithVercel(
  jobId: string,
  expectedEmail: string,
): Promise<MonthlyReportReconciliationResult> {
  const user = auth.currentUser;

  if (
    !user ||
    user.email?.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    throw new Error("The authenticated teacher session changed.");
  }

  const idToken = await user.getIdToken();

  const response = await fetch("/api/teacher/monthly-reports/reconcile", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jobId }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Report status lookup failed (${response.status}).`;

    throw new Error(message);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("success" in payload) ||
    payload.success !== true ||
    !("status" in payload) ||
    (payload.status !== "delivered" && payload.status !== "unknown_outcome") ||
    !("jobId" in payload) ||
    payload.jobId !== jobId
  ) {
    throw new Error("The report status API returned an invalid response.");
  }

  return payload as MonthlyReportReconciliationResult;
}

export interface Student {
  id: string | number;
  name: string;
  fatherName: string;
  rollNo: string;
  avatar?: string;
  attendanceRate?: string;
  quizScore?: string;
  category?: CategoryType | null;
  phone?: string;
  fatherPhone?: string;
  parentWhatsAppOptIn?: boolean;
  feeStatus?: string;
  homeworkGrade?: string;
  behaviorGrade?: string;
  participationGrade?: string;
  performanceGrade?: string;
  homeworkRemark?: string;
  behaviorRemark?: string;
  participationRemark?: string;
  performanceRemark?: string;
  remarks?: string;
  remarksByCategory?: GradingRemarkPreset[];
  isConfigured?: boolean;
  // This records API acceptance only; delivery confirmation is a separate WhatsApp webhook status.
  lastWhatsAppAcceptedMonth?: string;
  lastWhatsAppSentMonth?: string;
  lastWhatsAppDeliveredMonth?: string;
  whatsAppJobId?: string;
  whatsAppStatus?: string;
  whatsAppLastError?: string;
}

export interface ClassItem {
  id: string;
  name: string;
  code: string;
  students: Student[];
}

export interface QuizStudentScore {
  id?: string | number;
  rollNo: string | number;
  name?: string;
  gender?: string;
  marksObtained: number;
}

export const CATEGORY_GRADES_MAP: Record<CategoryType, GradingCriteria> = {
  Excellent: { homework: 'A+', behavior: 'A+', participation: 'A+', performance: 'A+' },
  Good:      { homework: 'A',  behavior: 'A',  participation: 'B+', performance: 'A' },
  Average:   { homework: 'B',  behavior: 'B',  participation: 'B',  performance: 'C+' },
  Poor:      { homework: 'C',  behavior: 'D',  participation: 'C',  performance: 'D' }
};

export const CATEGORY_CONFIG: Record<CategoryType, { color: string; badgeBg: string; textColor: string; icon: LucideIcon }> = {
  Excellent: {
    color: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500 shadow-emerald-500/20',
    badgeBg: 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30',
    textColor: 'text-emerald-500 dark:text-emerald-400',
    icon: Award
  },
  Good: {
    color: 'border-blue-500/50 bg-blue-500/10 text-blue-500 shadow-blue-500/20',
    badgeBg: 'bg-blue-500 text-white shadow-lg shadow-blue-500/30',
    textColor: 'text-blue-500 dark:text-blue-400',
    icon: ThumbsUp
  },
  Average: {
    color: 'border-amber-500/50 bg-amber-500/10 text-amber-500 shadow-amber-500/20',
    badgeBg: 'bg-amber-500 text-white shadow-lg shadow-amber-500/20',
    textColor: 'text-amber-500 dark:text-amber-400',
    icon: TrendingUp
  },
  Poor: {
    color: 'border-rose-500/50 bg-rose-500/10 text-rose-500 shadow-rose-500/20',
    badgeBg: 'bg-rose-500 text-white shadow-lg shadow-rose-500/30',
    textColor: 'text-rose-500 dark:text-rose-400',
    icon: AlertCircle
  }
};

export default function ReportsDashboard() {
  // userEmail is set only after the authenticated Firebase identity is verified against users/{email}.
  const [userEmail, setUserEmail] = useState<string>('');
  const [tenantProfileDoc, setTenantProfileDoc] = useState<DocumentData | null>(null);
  const [profileDataDoc, setProfileDataDoc] = useState<DocumentData | null>(null);
  const authGenerationRef = useRef(0);

  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawClassDocs, setRawClassDocs] = useState<Array<{ id: string; data: DocumentData }>>([]);
  const [loading, setLoading] = useState(true);

  const monthsInfo = useMemo(() => getTwoMonthsInfo(), []);
  const [selectedMonth, setSelectedMonth] = useState<string>(monthsInfo.currentKey);
  const [availableMonths, setAvailableMonths] = useState<{ key: string; label: string }[]>([
    { key: monthsInfo.currentKey, label: `Current: ${monthsInfo.currentLabel}` }
  ]);

  const [realtimeMetricState, setRealtimeMetricState] = useState<{ scope: string; metrics: Record<string, StudentReportMetrics>; loaded: boolean; error?: boolean } | null>(null);
  const [reportState, setReportState] = useState<{ scope: string; byStudent: Record<string, DocumentData> } | null>(null);
  const [feeRecordState, setFeeRecordState] = useState<{ scope: string; records: Record<string, DocumentData>; loaded: boolean; error?: boolean } | null>(null);
  
  const [activeNav, setActiveNav] = useState<NavTab>('classes');
  const [activeClassId, setActiveClassId] = useState<string | null>(null);
  const [activeCategoryTab, setActiveCategoryTab] = useState<CategoryType>('Excellent');
  const [selectedStudentIds, setSelectedStudentIds] = useState<(string | number)[]>([]);
  // Smart filters are optional and start disabled, preserving the current unfiltered workflow.
  const [useAttendanceFilter, setUseAttendanceFilter] = useState(false);
  const [attendanceThreshold, setAttendanceThreshold] = useState(90);
  const [useQuizFilter, setUseQuizFilter] = useState(false);
  const [quizThreshold, setQuizThreshold] = useState(70);

  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 5;

  const [showReportPreviewModal, setShowReportPreviewModal] = useState<boolean>(false);
  const [singleStudentModal, setSingleStudentModal] = useState<Student | null>(null);
  const [remarksPreviewCategory, setRemarksPreviewCategory] = useState<CategoryType | null>(null);

  const [isSettingsConfigured, setIsSettingsConfigured] = useState<boolean>(true);
  const [showAlertModal, setShowAlertModal] = useState<boolean>(false);
  const [notification, setNotification] = useState<{ show: boolean; title: string; message: string }>({ show: false, title: '', message: '' });
  const [bulkWhatsAppProgress, setBulkWhatsAppProgress] = useState<{
    scope: string;
    total: number;
    completed: number;
    attempted: number;
    skipped: number;
    failed: number;
    currentStudent: string;
    finished: boolean;
  } | null>(null);
  const bulkWhatsAppSendingRef = useRef(false);

  const [dynamicCriteria, setDynamicCriteria] = useState<Record<CategoryType, GradingCriteria>>(CATEGORY_GRADES_MAP);
  const [gradingRemarksMap, setGradingRemarksMap] = useState<GradingRemarksMap>(() => normalizeGradingRemarksMap(null));
  const [reportFieldConfigState, setReportFieldConfigState] = useState<{
    scope: string;
    config: ReportFieldConfig;
    loaded: boolean;
    error?: boolean;
  } | null>(null);
  const [printMode, setPrintMode] = useState<'single' | 'all' | null>(null);
  const assignmentSaveInProgressRef = useRef(false);

  // Profile identity is read only from this authenticated teacher's own tenant profile
  // and settings/profile_data document. The nested `profile` object is the current schema.
  const teacherProfile = useMemo(() => {
    const settingsDoc = profileDataDoc || {};
    const tenantDoc = tenantProfileDoc || {};
    const nestedSettings = settingsDoc.profile && typeof settingsDoc.profile === 'object' && !Array.isArray(settingsDoc.profile)
      ? settingsDoc.profile as DocumentData
      : settingsDoc;
    const nestedTenant = tenantDoc.profile && typeof tenantDoc.profile === 'object' && !Array.isArray(tenantDoc.profile)
      ? tenantDoc.profile as DocumentData
      : {};
    const clean = (...values: unknown[]): string => {
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const text = value.trim();
        if (text && !/^(?:undefined|null|\[object Object\])$/i.test(text)) return text;
      }
      return '';
    };
    return {
      name: clean(nestedSettings.name, nestedSettings.teacherName, settingsDoc.teacherName, tenantDoc.teacherName, tenantDoc.name, nestedTenant.name) || 'Teacher name not configured',
      academyName: clean(nestedSettings.schoolName, nestedSettings.academyName, settingsDoc.schoolName, settingsDoc.academyName, tenantDoc.schoolName, tenantDoc.academyName, nestedTenant.schoolName, nestedTenant.academyName) || 'Academy name not configured',
      avatarUrl: clean(nestedSettings.avatarUrl, nestedSettings.profileImage, nestedSettings.photoURL, nestedSettings.photoUrl, settingsDoc.avatarUrl, settingsDoc.profileImage, tenantDoc.profileImage, tenantDoc.avatarUrl, nestedTenant.avatarUrl, nestedTenant.profileImage),
      email: clean(nestedSettings.email, settingsDoc.email, tenantDoc.email),
      phone: clean(nestedSettings.phone, settingsDoc.phone, tenantDoc.whatsappNumber, tenantDoc.phone, nestedTenant.phone),
      role: clean(nestedSettings.role, settingsDoc.role, tenantDoc.role, nestedTenant.role),
    };
  }, [profileDataDoc, tenantProfileDoc]);

  const teacherInitials = useMemo(() => {
    const actualName = teacherProfile.name === 'Teacher name not configured' ? '' : teacherProfile.name;
    const initials = actualName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
    return initials || 'T';
  }, [teacherProfile.name]);

  const currentReportScope = userEmail && activeClassId
    ? `${userEmail}|${activeClassId}|${selectedMonth}`
    : '';
  const reportFieldConfigReady = Boolean(
    userEmail && reportFieldConfigState?.scope === userEmail &&
    reportFieldConfigState.loaded && !reportFieldConfigState.error
  );
  const reportFieldConfigError = Boolean(
    userEmail && reportFieldConfigState?.scope === userEmail && reportFieldConfigState.error
  );
  const reportFieldConfig = reportFieldConfigReady && reportFieldConfigState?.scope === userEmail
    ? reportFieldConfigState.config
    : DEFAULT_REPORT_FIELD_CONFIG;
  const currentReportScopeRef = useRef(currentReportScope);
  currentReportScopeRef.current = currentReportScope;
  const whatsAppPreparingRef = useRef<Set<string>>(new Set());
  const metricScope = currentReportScope;
  const activeReports = reportState?.scope === currentReportScope ? reportState.byStudent : {};
  const currentFeeRecords = feeRecordState?.scope === currentReportScope ? feeRecordState.records : {};
  const realtimeMetrics = realtimeMetricState?.scope === metricScope ? realtimeMetricState.metrics : {};
  const activeClassIsOwned = Boolean(userEmail && activeClassId && rawClassDocs.some((item) => item.id === activeClassId));
  const activeRosterIds = useMemo(() => {
    const activeDoc = rawClassDocs.find((item) => item.id === activeClassId);
    return activeDoc ? normalizeReportRoster(activeDoc.data.students, activeDoc.data).map((student) => student.id) : [];
  }, [rawClassDocs, activeClassId]);

  const classList: ClassItem[] = useMemo(() => rawClassDocs.map(({ id: classId, data }) => {
    const roster = normalizeReportRoster(data.students, data);
    const students: Student[] = roster.map(({ id: stId, data: st }) => {
      const metrics = classId === activeClassId ? realtimeMetrics[stId] : undefined;
      const monthlyReport = classId === activeClassId ? activeReports[stId] : undefined;
      const reportMonthMatches = Boolean(monthlyReport && normalizeReportMonth(monthlyReport.monthKey) === selectedMonth);
      const rawCategory = reportMonthMatches ? monthlyReport?.category : null;
      const category: CategoryType | null =
        rawCategory === 'Excellent' || rawCategory === 'Good' || rawCategory === 'Average' || rawCategory === 'Poor'
          ? rawCategory
          : null;
      // Unassigned students do not receive fabricated grades from an arbitrary category.
      const grades: GradingCriteria = category
        ? (dynamicCriteria[category] || CATEGORY_GRADES_MAP[category])
        : { homework: '', behavior: '', participation: '', performance: '' };
      const feeRecord = classId === activeClassId ? currentFeeRecords[stId] : undefined;
      const feeIsLoading = classId === activeClassId && feeRecordState?.scope === currentReportScope && !feeRecordState.loaded;
      const feeLoadFailed = classId === activeClassId && feeRecordState?.scope === currentReportScope && feeRecordState.error === true;

      const name = typeof st.name === 'string' ? st.name.trim() : '';
      const fatherName = typeof st.fatherName === 'string' ? st.fatherName.trim() : '';

      // Match the server-side guardian-contact policy: consent is valid only
      // while the consented number still matches one of the roster's current contacts.
      const consentPhone = normalizeConsentPhone(st.parentWhatsAppOptInPhone);
      const consentPhoneMatchesCurrentContact =
        st.parentWhatsAppOptIn === true &&
        typeof st.parentWhatsAppOptInAt === 'string' &&
        Boolean(st.parentWhatsAppOptInAt.trim()) &&
        Boolean(consentPhone) &&
        [st.phone, st.fatherPhone, st.parentPhone, st.guardianPhone]
          .some((value) => normalizeConsentPhone(value) === consentPhone);
      const reportRemarkItems = Array.isArray(monthlyReport?.remarkItems)
        ? monthlyReport.remarkItems.filter((item: unknown): item is GradingRemarkPreset =>
            Boolean(item && typeof item === 'object' && !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).remarkText === 'string' &&
              typeof (item as Record<string, unknown>).category === 'string' &&
              (REMARK_CATEGORY_ORDER as readonly string[]).includes(String((item as Record<string, unknown>).category))))
        : [];
      const gradeValue = (reportValue: unknown, rosterValue: unknown, fallback: string): string => {
        if (typeof reportValue === 'string' && reportValue.trim()) return reportValue.trim();
        if (typeof rosterValue === 'string' && rosterValue.trim()) return rosterValue.trim();
        return fallback;
      };

      return {
        id: stId,
        name,
        fatherName,
        rollNo: st.rollNo === undefined || st.rollNo === null || String(st.rollNo).trim() === '' ? '' : String(st.rollNo).trim(),
        avatar: typeof st.avatar === 'string' && st.avatar.trim()
          ? st.avatar
          : `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name || stId)}`,
        attendanceRate: metrics?.attendancePct || '—',
        quizScore: metrics?.quizDisplay || '—',
        category,
        phone: typeof st.phone === 'string' ? st.phone : '',
        fatherPhone: typeof st.fatherPhone === 'string' ? st.fatherPhone : (typeof st.phone === 'string' ? st.phone : ''),
        parentWhatsAppOptIn: consentPhoneMatchesCurrentContact,
        feeStatus: feeIsLoading ? 'Loading…' : feeLoadFailed ? 'Unavailable' : getFeeStatusForStudent(feeRecord, st.feeStatus, selectedMonth === monthsInfo.currentKey),
        homeworkGrade: gradeValue(undefined, st.homeworkGrade, grades.homework),
        behaviorGrade: gradeValue(undefined, st.behaviorGrade, grades.behavior),
        participationGrade: gradeValue(undefined, st.participationGrade, grades.participation),
        performanceGrade: gradeValue(undefined, st.performanceGrade, grades.performance),
        remarks: typeof monthlyReport?.remarks === 'string'
          ? monthlyReport.remarks
          : (typeof st.remarks === 'string' ? st.remarks : undefined),
        remarksByCategory: reportRemarkItems,
        isConfigured: Boolean(reportMonthMatches && category),
        lastWhatsAppAcceptedMonth: typeof monthlyReport?.lastWhatsAppAcceptedMonth === 'string'
          ? monthlyReport.lastWhatsAppAcceptedMonth
          : (typeof st.lastWhatsAppAcceptedMonth === 'string' ? st.lastWhatsAppAcceptedMonth : ''),
        lastWhatsAppSentMonth: typeof monthlyReport?.lastWhatsAppSentMonth === 'string'
          ? monthlyReport.lastWhatsAppSentMonth
          : (typeof st.lastWhatsAppSentMonth === 'string' ? st.lastWhatsAppSentMonth : ''),
        lastWhatsAppDeliveredMonth: typeof monthlyReport?.lastWhatsAppDeliveredMonth === 'string'
          ? monthlyReport.lastWhatsAppDeliveredMonth
          : (typeof st.lastWhatsAppDeliveredMonth === 'string' ? st.lastWhatsAppDeliveredMonth : ''),
        whatsAppJobId: typeof monthlyReport?.whatsAppJobId === 'string'
          ? monthlyReport.whatsAppJobId
          : (typeof st.whatsAppJobId === 'string' ? st.whatsAppJobId : ''),
        whatsAppStatus: typeof monthlyReport?.whatsAppStatus === 'string'
          ? monthlyReport.whatsAppStatus
          : (typeof st.whatsAppStatus === 'string' ? st.whatsAppStatus : ''),
        whatsAppLastError: typeof monthlyReport?.whatsAppLastError === 'string'
          ? monthlyReport.whatsAppLastError
          : (typeof st.whatsAppLastError === 'string' ? st.whatsAppLastError : ''),
      };
    });

    students.sort((a, b) => {
      const numA = parseInt(a.rollNo.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.rollNo.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

    return {
      id: classId,
      name: data.className || data.name || 'Unnamed Class',
      code: data.subject || data.code || 'NO-CODE',
      students,
    };
  }), [rawClassDocs, activeClassId, currentReportScope, realtimeMetricState, realtimeMetrics, activeReports, currentFeeRecords, feeRecordState, dynamicCriteria, selectedMonth, monthsInfo.currentKey]);

  // AUTHENTICATION + TENANT PROFILE VERIFICATION (fail closed; no email/UID fallback).
  useEffect(() => {
    let disposed = false;
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(
      auth,
      (user) => {
        const generation = ++authGenerationRef.current;
        unsubscribeProfile?.();
        unsubscribeProfile = null;

        // Clear all previous-session data immediately so teacher A's records cannot flash for teacher B.
        setUserEmail('');
        setTenantProfileDoc(null);
        setProfileDataDoc(null);
        setRawClassDocs([]);
        setRealtimeMetricState(null);
        setReportState(null);
        setFeeRecordState(null);
        setAvailableMonths([{ key: monthsInfo.currentKey, label: `Current: ${monthsInfo.currentLabel}` }]);
        setActiveClassId(null);
        setSelectedStudentIds([]);
        setSingleStudentModal(null);
        setShowReportPreviewModal(false);
        setRemarksPreviewCategory(null);
        setDynamicCriteria(CATEGORY_GRADES_MAP);
        setGradingRemarksMap(normalizeGradingRemarksMap(null));
        setIsSettingsConfigured(false);
        setLoading(Boolean(user));

        if (!user?.uid || !user.email) {
          setLoading(false);
          return;
        }

        const tenantEmail = normalizeTenantEmail(user.email);
        if (!tenantEmail) {
          console.error('[Reports] Refusing tenant access because the authenticated email is invalid.');
          setLoading(false);
          return;
        }

        unsubscribeProfile = onSnapshot(
          doc(db, 'users', tenantEmail),
          (profileSnapshot) => {
            if (disposed || generation !== authGenerationRef.current) return;
            const profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
            if (!isAuthorizedTeacherProfile(profile, { uid: user.uid, email: tenantEmail })) {
              console.error('[Reports] Tenant profile verification failed; no tenant data will be loaded.');
              setUserEmail('');
              setTenantProfileDoc(null);
              setProfileDataDoc(null);
              setRawClassDocs([]);
              setRealtimeMetricState(null);
              setReportState(null);
              setFeeRecordState(null);
              setLoading(false);
              return;
            }
            setTenantProfileDoc(profile as DocumentData);
            setUserEmail(tenantEmail);
          },
          (error) => {
            if (disposed || generation !== authGenerationRef.current) return;
            console.error('[Reports] Tenant profile listener failed:', error);
            setUserEmail('');
            setTenantProfileDoc(null);
            setProfileDataDoc(null);
            setRawClassDocs([]);
            setRealtimeMetricState(null);
            setReportState(null);
            setFeeRecordState(null);
            setLoading(false);
          }
        );
      },
      (error) => {
        if (disposed) return;
        console.error('[Reports] Authentication state listener failed:', error);
        ++authGenerationRef.current;
        setUserEmail('');
        setTenantProfileDoc(null);
        setProfileDataDoc(null);
        setRawClassDocs([]);
        setRealtimeMetricState(null);
        setReportState(null);
        setFeeRecordState(null);
        setLoading(false);
      }
    );

    return () => {
      disposed = true;
      ++authGenerationRef.current;
      unsubscribeProfile?.();
      unsubscribeAuth();
    };
  }, [monthsInfo]);

  // LIVE TEACHER / ACADEMY IDENTITY: users/{teacherEmail}/settings/profile_data.
  // The profile document shown in Firebase stores display fields under `profile`.
  useEffect(() => {
    if (!userEmail) {
      setProfileDataDoc(null);
      return;
    }

    let cancelled = false;
    const profileDataRef = doc(db, 'users', userEmail, 'settings', 'profile_data');
    const unsubscribe = onSnapshot(profileDataRef, (snapshot) => {
      if (cancelled) return;
      setProfileDataDoc(snapshot.exists() ? snapshot.data() : null);
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Teacher profile data listener failed:', error);
      setProfileDataDoc(null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const showToast = (title: string, message: string) => {
    setNotification({ show: true, title, message });
    setTimeout(() => setNotification({ show: false, title: '', message: '' }), 4000);
  };

  const getCardClass = () => {
    return isDarkMode 
      ? 'bg-[#0e131f] border-slate-800 text-slate-100 shadow-xl' 
      : 'bg-white border-slate-200 text-slate-900 shadow-sm';
  };

  const getInnerCardClass = () => {
    return isDarkMode 
      ? 'bg-[#171e2e] border-slate-700/60 text-slate-200' 
      : 'bg-slate-50 border-slate-200/60 text-slate-800';
  };

  // AUTOMATIC CLEANUP: on/after day 5, purge only the previous month's automatic report configs.
  // The deterministic notification ID prevents duplicate reset notifications when listeners refresh.
  useEffect(() => {
    if (!activeClassId || !userEmail || !activeClassIsOwned || new Date().getDate() < 5) return;

    let cancelled = false;
    const autoCleanOldReports = async () => {
      try {
        const reportsRef = collection(db, 'users', userEmail, 'classes', activeClassId, 'reports');
        const previousMonthQuery = query(reportsRef, where('monthKey', '==', monthsInfo.previousKey));
        const snapshot = await getDocs(previousMonthQuery);
        if (cancelled) return;

        for (const reportSnap of snapshot.docs) {
          if (cancelled) return;
          const data = reportSnap.data();
          if (data.monthKey === monthsInfo.previousKey && data.mode === 'automatic') {
            await deleteDoc(doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', reportSnap.id));
          }
        }

        if (cancelled) return;
        const notificationRef = doc(
          db,
          'users',
          userEmail,
          'notifications',
          `reports_reset_${activeClassId}_${monthsInfo.currentKey}`
        );
        await setDoc(notificationRef, {
          title: 'Reports Reset Notification',
          message: `On Date 5, previous month Automatic reports configurations have been cleared for class ${activeClassId}. Re-generate reports required.`,
          type: 'reports_reset',
          createdAt: serverTimestamp(),
          read: false,
        }, { merge: true });
      } catch (err) {
        if (!cancelled) console.error('[Reports] Automatic report cleanup failed:', err);
      }
    };

    void autoCleanOldReports();
    return () => { cancelled = true; };
  }, [activeClassId, userEmail, activeClassIsOwned, monthsInfo]);

  // LISTEN TO TENANT-SCOPED GRADING RULES. Preset arrays and legacy strings are both supported.
  useEffect(() => {
    if (!userEmail) {
      setGradingRemarksMap(normalizeGradingRemarksMap(null));
      setIsSettingsConfigured(false);
      return;
    }

    const rulesDocRef = doc(db, 'users', userEmail, 'settings', 'grading_rules');
    const unsubscribe = onSnapshot(rulesDocRef, (docSnap) => {
      if (!docSnap.exists()) {
        setGradingRemarksMap(normalizeGradingRemarksMap(null));
        setDynamicCriteria(CATEGORY_GRADES_MAP);
        setIsSettingsConfigured(false);
        return;
      }

      const data = docSnap.data();
      setGradingRemarksMap(normalizeGradingRemarksMap(data.remarksMap));
      // An existing grading-rules document is enough to allow assignments. If a particular
      // rating has no saved comments, that report explicitly says so instead of fabricating text.
      setIsSettingsConfigured(true);

      const rulesMap = data.rulesMap || data.criteriaMap || {};
      const updatedCriteria: Record<CategoryType, GradingCriteria> = { ...CATEGORY_GRADES_MAP };
      (['Excellent', 'Good', 'Average', 'Poor'] as CategoryType[]).forEach((category) => {
        const rawCriteria = rulesMap && typeof rulesMap === 'object' ? rulesMap[category] : undefined;
        if (!rawCriteria || typeof rawCriteria !== 'object') return;
        updatedCriteria[category] = {
          homework: typeof rawCriteria.homework === 'string' && rawCriteria.homework.trim()
            ? rawCriteria.homework.trim() : CATEGORY_GRADES_MAP[category].homework,
          behavior: typeof rawCriteria.behavior === 'string' && rawCriteria.behavior.trim()
            ? rawCriteria.behavior.trim() : CATEGORY_GRADES_MAP[category].behavior,
          participation: typeof rawCriteria.participation === 'string' && rawCriteria.participation.trim()
            ? rawCriteria.participation.trim() : CATEGORY_GRADES_MAP[category].participation,
          performance: typeof rawCriteria.performance === 'string' && rawCriteria.performance.trim()
            ? rawCriteria.performance.trim() : CATEGORY_GRADES_MAP[category].performance,
        };
      });
      setDynamicCriteria(updatedCriteria);
    }, (error) => {
      console.error('[Reports] Grading rules listener failed:', error);
      setGradingRemarksMap(normalizeGradingRemarksMap(null));
      setIsSettingsConfigured(false);
    });

    return () => unsubscribe();
  }, [userEmail]);

  // LISTEN TO THIS TEACHER'S REPORT FIELD CONFIGURATION.
  // The Settings page stores the flags under users/{email}/settings/report_config.reportMetrics.
  useEffect(() => {
    if (!userEmail) {
      setReportFieldConfigState(null);
      return;
    }

    const scope = userEmail;
    setReportFieldConfigState({ scope, config: DEFAULT_REPORT_FIELD_CONFIG, loaded: false });
    const configRef = doc(db, 'users', userEmail, 'settings', 'report_config');
    const unsubscribe = onSnapshot(configRef, (snapshot) => {
      const documentData = snapshot.exists() ? snapshot.data() : {};
      const rawMetrics = documentData.reportMetrics &&
        typeof documentData.reportMetrics === 'object' && !Array.isArray(documentData.reportMetrics)
        ? documentData.reportMetrics as Record<string, unknown>
        : {};
      const readFlag = (key: keyof ReportFieldConfig): boolean =>
        typeof rawMetrics[key] === 'boolean'
          ? rawMetrics[key] as boolean
          : DEFAULT_REPORT_FIELD_CONFIG[key];

      setReportFieldConfigState({
        scope,
        loaded: true,
        config: {
          homeworkEnabled: readFlag('homeworkEnabled'),
          behaviorEnabled: readFlag('behaviorEnabled'),
          participationEnabled: readFlag('participationEnabled'),
          performanceEnabled: readFlag('performanceEnabled'),
          teacherRemarksRequired: readFlag('teacherRemarksRequired'),
        },
      });
    }, (error) => {
      console.error('[Reports] Report field configuration listener failed:', error);
      setReportFieldConfigState({
        scope,
        config: DEFAULT_REPORT_FIELD_CONFIG,
        loaded: false,
        error: true,
      });
    });

    return () => unsubscribe();
  }, [userEmail]);

  // CLASSES: canonical roster is the `students` field on each class document (array or legacy map).
  useEffect(() => {
    if (!userEmail) {
      setRawClassDocs([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const classesRef = collection(db, 'users', userEmail, 'classes');
    const unsubscribe = onSnapshot(classesRef, (snapshot) => {
      if (cancelled) return;
      setRawClassDocs(snapshot.docs.map((classSnap) => ({ id: classSnap.id, data: classSnap.data() })));
      setLoading(false);
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Tenant classes listener failed:', error);
      setRawClassDocs([]);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail]);

  // REPORT ASSIGNMENTS + MONTH MENU: reads stay under the authenticated tenant and selected class.
  useEffect(() => {
    if (!userEmail || !activeClassId || !activeClassIsOwned) {
      setReportState(null);
      return;
    }

    let cancelled = false;
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setReportState(null);
    const reportsRef = collection(db, 'users', userEmail, 'classes', activeClassId, 'reports');
    const unsubscribe = onSnapshot(reportsRef, (snapshot) => {
      if (cancelled) return;
      const byStudent: Record<string, DocumentData> = {};
      const monthKeys = new Set<string>([monthsInfo.currentKey, selectedMonth]);

      const rosterIds = new Set(activeRosterIds.map(String));
      snapshot.docs.forEach((reportSnap) => {
        const data = reportSnap.data();
        const idMonthMatch = /_(\d{4}-\d{2})$/.exec(reportSnap.id);
        const monthKey = normalizeReportMonth(data.monthKey) || normalizeReportMonth(idMonthMatch?.[1]);
        if (monthKey) monthKeys.add(monthKey);
        if (monthKey !== selectedMonth) return;
        if (data.classId !== undefined && String(data.classId) !== activeClassId) return;

        const idStudentId = reportSnap.id.endsWith(`_${selectedMonth}`)
          ? reportSnap.id.slice(0, -(`_${selectedMonth}`).length)
          : '';
        const rawStudentId = data.studentId ?? idStudentId;
        if (rawStudentId === undefined || rawStudentId === null || String(rawStudentId).trim() === '') return;
        const studentId = String(rawStudentId);
        if (!rosterIds.has(studentId)) return;
        byStudent[studentId] = { ...data, studentId, monthKey };
      });

      const keys = Array.from(monthKeys).sort((a, b) => b.localeCompare(a));
      setAvailableMonths(keys.map((key) => ({ key, label: formatMonthLabel(key) })));
      setReportState({ scope, byStudent });
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Monthly report listener failed:', error);
      setAvailableMonths([
        { key: monthsInfo.currentKey, label: `Current: ${monthsInfo.currentLabel}` },
        ...(selectedMonth !== monthsInfo.currentKey ? [{ key: selectedMonth, label: formatMonthLabel(selectedMonth) }] : []),
      ]);
      setReportState({ scope, byStudent: {} });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail, activeClassId, activeClassIsOwned, activeRosterIds, selectedMonth, monthsInfo]);

  // MONTHLY FEES: read only users/{teacher}/fees/{classId}_{YYYY-MM}; fee status is not guessed.
  useEffect(() => {
    if (!userEmail || !activeClassId || !activeClassIsOwned) {
      setFeeRecordState(null);
      return;
    }

    let cancelled = false;
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setFeeRecordState({ scope, records: {}, loaded: false });
    const feeRef = doc(db, 'users', userEmail, 'fees', `${activeClassId}_${selectedMonth}`);
    const unsubscribe = onSnapshot(feeRef, (snapshot) => {
      if (cancelled) return;
      const feeData = snapshot.exists() ? snapshot.data() : null;
      const records = getMonthlyFeeRecords(feeData, activeClassId, selectedMonth);
      setFeeRecordState({ scope, records, loaded: true });
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Monthly fee record listener failed:', error);
      setFeeRecordState({ scope, records: {}, loaded: true, error: true });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail, activeClassId, activeClassIsOwned, selectedMonth]);

  // ATTENDANCE + QUIZZES: class-roster-only metrics for the exact selected calendar month.
  useEffect(() => {
    if (!userEmail || !activeClassId || !activeClassIsOwned || !selectedMonth) {
      setRealtimeMetricState(null);
      return;
    }

    const range = getReportMonthDateRange(selectedMonth);
    if (!range) {
      setRealtimeMetricState(null);
      return;
    }

    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setRealtimeMetricState({ scope, metrics: {}, loaded: false });
    if (activeRosterIds.length === 0) return;

    let cancelled = false;
    let attendanceLoaded = false;
    let attendanceLoadFailed = false;
    let quizLoadFailed = false;
    let attendanceRows: ReportDocument[] = [];
    let quizFallbackStarted = false;
    let quizFallbackLoaded = false;
    let quizFallbackRows: ReportDocument[] = [];
    const quizRowsByQuery: Array<ReportDocument[] | null> = [null, null, null];
    const quizUnsubscribers: Array<() => void> = [];
    let unsubscribeQuizFallback: (() => void) | null = null;

    const getQuizRows = (): ReportDocument[] => {
      if (quizFallbackStarted) return quizFallbackRows;
      const byId = new Map<string, ReportDocument>();
      quizRowsByQuery.forEach((rows) => {
        (rows || []).forEach((row) => byId.set(row.id, row));
      });
      return Array.from(byId.values());
    };

    const publishMetrics = () => {
      if (cancelled || !attendanceLoaded) return;
      if (quizFallbackStarted ? !quizFallbackLoaded : quizRowsByQuery.some((rows) => rows === null)) return;
      const quizRows = getQuizRows();
      const metrics = calculateMonthlyStudentMetrics(
        activeRosterIds,
        attendanceRows,
        quizRows,
        activeClassId,
        selectedMonth
      );
      setRealtimeMetricState({ scope, metrics, loaded: true, error: attendanceLoadFailed || quizLoadFailed });
    };

    const attendanceRef = collection(db, 'users', userEmail, 'attendance');
    // The documented schema IDs are `{classId}_{YYYY-MM-DD}`. Query by the bounded
    // document-ID interval so legacy records without `classId`/`date` fields are not missed,
    // while still reading only the selected tenant, class and month.
    const monthlyAttendanceQuery = query(
      attendanceRef,
      where(documentId(), '>=', `${activeClassId}_${range.startDate}`),
      where(documentId(), '<', `${activeClassId}_${range.nextMonthStartDate}`)
    );
    const unsubscribeAttendance = onSnapshot(monthlyAttendanceQuery, (snapshot) => {
      if (cancelled) return;
      attendanceRows = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
      attendanceLoaded = true;
      publishMetrics();
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Monthly attendance listener failed:', error);
      attendanceRows = [];
      attendanceLoaded = true;
      attendanceLoadFailed = true;
      publishMetrics();
    });

    const quizRef = collection(db, 'users', userEmail, 'classes', activeClassId, 'quizzes');
    const monthLabel = range.start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const quizQueries = [
      query(quizRef, where('monthKey', 'in', [selectedMonth, monthLabel])),
      query(quizRef, where('date', '>=', range.startDate), where('date', '<=', range.endDate)),
      query(quizRef, where('createdAt', '>=', Timestamp.fromDate(range.start)), where('createdAt', '<', Timestamp.fromDate(range.nextMonthStart))),
    ];

    const startQuizFallback = () => {
      if (cancelled || quizFallbackStarted) return;
      quizFallbackStarted = true;
      quizUnsubscribers.forEach((unsubscribe) => unsubscribe());
      quizFallbackRows = [];
      unsubscribeQuizFallback = onSnapshot(quizRef, (snapshot) => {
        if (cancelled) return;
        quizFallbackRows = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
        quizFallbackLoaded = true;
        quizLoadFailed = false;
        publishMetrics();
      }, (error) => {
        if (cancelled) return;
        console.error('[Reports] Class quiz listener failed:', error);
        quizFallbackRows = [];
        quizFallbackLoaded = true;
        quizLoadFailed = true;
        publishMetrics();
      });
    };

    quizQueries.forEach((quizQuery, queryIndex) => {
      const unsubscribe = onSnapshot(quizQuery, (snapshot) => {
        if (cancelled || quizFallbackStarted) return;
        quizRowsByQuery[queryIndex] = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
        publishMetrics();
      }, (error) => {
        if (cancelled) return;
        console.warn('[Reports] Monthly quiz query failed; switching to the selected class fallback query:', error);
        startQuizFallback();
      });
      quizUnsubscribers.push(unsubscribe);
    });

    return () => {
      cancelled = true;
      unsubscribeAttendance();
      quizUnsubscribers.forEach((unsubscribe) => unsubscribe());
      unsubscribeQuizFallback?.();
    };
  }, [userEmail, activeClassId, activeClassIsOwned, activeRosterIds, selectedMonth]);

  const filteredClasses = useMemo(() => {
    return classList.filter(c => 
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      c.code.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [classList, searchQuery]);

  const currentClass = useMemo(() => {
    return classList.find((c) => c.id === activeClassId) || null;
  }, [classList, activeClassId]);

  const getResolvedRemarksForStudent = (
    student: Student,
    rating: CategoryType | null = student.category ?? null,
  ): GradingRemarkPreset[] => {
    if (!rating) return [];
    const cleanAndDeduplicate = (items: GradingRemarkPreset[]): GradingRemarkPreset[] => {
      const seen = new Set<string>();
      return items
        .map((item) => ({
          id: item.id,
          category: item.category,
          remarkText: resolvePersonalizedRemark(item.remarkText, student).trim(),
        }))
        .filter((item) => {
          const key = item.remarkText.replace(/\s+/g, ' ').trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };

    const currentPresets = gradingRemarksMap[rating] || [];
    const resolvedCurrent = cleanAndDeduplicate(currentPresets);
    if (resolvedCurrent.length) return resolvedCurrent;

    // A report saved by an older app version may contain real, student-specific remarks.
    const persistedItems = Array.isArray(student.remarksByCategory) ? student.remarksByCategory : [];
    const resolvedPersistedItems = cleanAndDeduplicate(persistedItems);
    if (resolvedPersistedItems.length) return resolvedPersistedItems;

    const legacyRemark = resolvePersonalizedRemark(student.remarks, student).trim();
    return legacyRemark ? [{ id: `legacy-${String(student.id)}`, category: 'Remarks', remarkText: legacyRemark }] : [];
  };

  const reportSnapshotReady = Boolean(currentReportScope && reportState?.scope === currentReportScope);
  const metricSnapshotReady = Boolean(currentReportScope && realtimeMetricState?.scope === currentReportScope && realtimeMetricState.loaded && !realtimeMetricState.error);
  const feeSnapshotReady = Boolean(currentReportScope && feeRecordState?.scope === currentReportScope && feeRecordState.loaded && !feeRecordState.error);
  const unassignedForPreview = useMemo(() => {
    if (!currentClass) return [];
    return currentClass.students.filter((student) => !student.category || !student.isConfigured);
  }, [currentClass]);
  const allReportsReady = Boolean(
    currentClass && currentClass.students.length > 0 && activeClassIsOwned &&
    reportFieldConfigReady && reportSnapshotReady && metricSnapshotReady && feeSnapshotReady &&
    unassignedForPreview.length === 0
  );
  const allReportsBlockedReason = !currentClass
    ? 'Select a class first.'
    : currentClass.students.length === 0
      ? 'This class has no students in its current roster.'
      : unassignedForPreview.length > 0
        ? `Save a rating for ${unassignedForPreview.length} remaining student(s): ${unassignedForPreview.slice(0, 5).map((student) => student.name || 'Name not available').join(', ')}${unassignedForPreview.length > 5 ? ', …' : ''}.`
        : reportFieldConfigError
          ? 'This teacher’s report field configuration could not be loaded. Check Firestore permissions and try again before printing.'
          : (realtimeMetricState?.scope === currentReportScope && realtimeMetricState.error) || (feeRecordState?.scope === currentReportScope && feeRecordState.error)
            ? 'Attendance/quiz or fee data could not be loaded. Check the connection and access permissions before printing all reports.'
            : !reportFieldConfigReady || !reportSnapshotReady || !metricSnapshotReady || !feeSnapshotReady
              ? 'Report field configuration and live report, attendance/quiz, and fee listeners are still loading for this class and month.'
              : '';

  useEffect(() => {
    if (!singleStudentModal) return;
    if (!reportFieldConfigReady) {
      setSingleStudentModal(null);
      setPrintMode(null);
      return;
    }
    const liveStudent = currentClass?.students.find((student) => String(student.id) === String(singleStudentModal.id));
    if (!liveStudent?.category || !liveStudent.isConfigured) {
      setSingleStudentModal(null);
      return;
    }
    const fieldsChanged = Boolean(liveStudent && JSON.stringify(liveStudent) !== JSON.stringify(singleStudentModal));
    if (liveStudent && fieldsChanged) setSingleStudentModal(liveStudent);
  }, [currentClass, singleStudentModal, reportFieldConfigReady]);

  useEffect(() => {
    if (showReportPreviewModal && !allReportsReady) {
      setShowReportPreviewModal(false);
      setPrintMode(null);
    }
  }, [showReportPreviewModal, allReportsReady]);

  useEffect(() => {
    const clearPrintMode = () => setPrintMode(null);
    window.addEventListener('afterprint', clearPrintMode);
    return () => window.removeEventListener('afterprint', clearPrintMode);
  }, []);

  const unassignedStudents = useMemo(() => {
    if (!currentClass) return [];
    return currentClass.students.filter((s) => !s.category);
  }, [currentClass]);

  const hasActiveMetricFilters = useAttendanceFilter || useQuizFilter;
  const filterMetricsReady = Boolean(
    currentReportScope &&
    realtimeMetricState?.scope === currentReportScope &&
    realtimeMetricState.loaded &&
    !realtimeMetricState.error
  );

  const filteredUnassignedStudents = useMemo(() => {
    // Do not accidentally select everyone when a selected filter's live metrics are unavailable.
    if (hasActiveMetricFilters && !filterMetricsReady) return [];

    return unassignedStudents.filter((student) => {
      const rawMetrics = realtimeMetrics[String(student.id)] as unknown as Record<string, unknown> | undefined;

      if (useAttendanceFilter) {
        const attendancePercent = parseMetricPercentage(rawMetrics?.attendancePct ?? student.attendanceRate, true);
        if (attendancePercent === null || attendancePercent < attendanceThreshold) return false;
      }

      if (useQuizFilter) {
        const obtainedValue = rawMetrics?.quizObtained;
        const totalValue = rawMetrics?.quizTotal;
        const obtained = obtainedValue === undefined || obtainedValue === null || obtainedValue === '' ? NaN : Number(obtainedValue);
        const total = totalValue === undefined || totalValue === null || totalValue === '' ? NaN : Number(totalValue);
        const quizPercent = Number.isFinite(obtained) && Number.isFinite(total) && total > 0 && obtained >= 0
          ? Math.min(100, Math.max(0, (obtained / total) * 100))
          : parseMetricPercentage(
              rawMetrics?.quizPct ?? rawMetrics?.quizPercentage ?? rawMetrics?.quizDisplay ?? student.quizScore,
              false,
            );
        if (quizPercent === null || quizPercent < quizThreshold) return false;
      }

      // When both filters are active, a student must pass both criteria.
      return true;
    });
  }, [
    unassignedStudents,
    realtimeMetrics,
    hasActiveMetricFilters,
    filterMetricsReady,
    useAttendanceFilter,
    attendanceThreshold,
    useQuizFilter,
    quizThreshold,
  ]);

  const totalPages = Math.ceil(filteredUnassignedStudents.length / pageSize) || 1;
  const paginatedUnassignedStudents = useMemo(() => {
    const startIdx = (currentPage - 1) * pageSize;
    return filteredUnassignedStudents.slice(startIdx, startIdx + pageSize);
  }, [filteredUnassignedStudents, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeCategoryTab, activeClassId, selectedMonth, useAttendanceFilter, attendanceThreshold, useQuizFilter, quizThreshold]);

  const toggleStudentSelection = (studentId: string | number) => {
    setSelectedStudentIds((prev) =>
      prev.some((id) => String(id) === String(studentId))
        ? prev.filter((id) => String(id) !== String(studentId))
        : [...prev, studentId]
    );
  };

  const areAllFilteredStudentsSelected = filteredUnassignedStudents.length > 0 &&
    filteredUnassignedStudents.every((student) =>
      selectedStudentIds.some((id) => String(id) === String(student.id))
    );

  const handleSelectAllFilteredStudents = () => {
    if (filteredUnassignedStudents.length === 0 || (hasActiveMetricFilters && !filterMetricsReady)) return;
    const filteredIds = new Set(filteredUnassignedStudents.map((student) => String(student.id)));
    if (areAllFilteredStudentsSelected) {
      setSelectedStudentIds((previous) => previous.filter((id) => !filteredIds.has(String(id))));
      return;
    }
    setSelectedStudentIds((previous) => {
      const alreadySelected = new Set(previous.map(String));
      const newlySelected = filteredUnassignedStudents
        .filter((student) => !alreadySelected.has(String(student.id)))
        .map((student) => student.id);
      return [...previous, ...newlySelected];
    });
  };

  const handleClearStudentFilters = () => {
    setUseAttendanceFilter(false);
    setUseQuizFilter(false);
    setSelectedStudentIds([]);
    setCurrentPage(1);
  };

  const handleSendAllMonthlyReports = async () => {
    if (bulkWhatsAppSendingRef.current) return;

    if (
      !allReportsReady ||
      !currentClass ||
      !activeClassId ||
      !userEmail ||
      !activeClassIsOwned
    ) {
      showToast(
        "Reports Not Ready",
        allReportsBlockedReason || "Select a valid class and complete all monthly reports first.",
      );
      return;
    }

    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    const students = [...currentClass.students];

    if (students.length === 0) {
      showToast("No Reports", "There are no students in this class.");
      return;
    }

    bulkWhatsAppSendingRef.current = true;

    let completed = 0;
    let attempted = 0;
    let skipped = 0;
    let failed = 0;

    setBulkWhatsAppProgress({
      scope,
      total: students.length,
      completed: 0,
      attempted: 0,
      skipped: 0,
      failed: 0,
      currentStudent: "Starting monthly report batch...",
      finished: false,
    });

    const publishProgress = (currentStudent: string) => {
      setBulkWhatsAppProgress((previous) => {
        if (!previous || previous.scope !== scope) return previous;

        return {
          ...previous,
          completed,
          attempted,
          skipped,
          failed,
          currentStudent,
        };
      });
    };

    try {
      for (const student of students) {
        if (currentReportScopeRef.current !== scope) {
          break;
        }

        const studentId = String(student.id);
        const studentName = student.name || `Student ${student.rollNo || studentId}`;
        const existingStatus = student.whatsAppStatus || "";
        const alreadyProcessed =
          student.lastWhatsAppAcceptedMonth === selectedMonth ||
          student.lastWhatsAppDeliveredMonth === selectedMonth;

        // Consent, category completion and monthly duplicate protection.
        if (
          !student.category ||
          !student.isConfigured ||
          student.parentWhatsAppOptIn !== true ||
          alreadyProcessed ||
          existingStatus === "sending" ||
          existingStatus === "unknown_outcome"
        ) {
          skipped += 1;
          completed += 1;
          publishProgress(studentName);
          continue;
        }

        const attemptKey =
          `${userEmail}|${activeClassId}|${studentId}|${selectedMonth}`;

        if (whatsAppPreparingRef.current.has(attemptKey)) {
          skipped += 1;
          completed += 1;
          publishProgress(studentName);
          continue;
        }

        whatsAppPreparingRef.current.add(attemptKey);

        let jobId =
          typeof student.whatsAppJobId === "string"
            ? student.whatsAppJobId
            : "";

        let dispatchInvoked = false;

        publishProgress(studentName);

        try {
          // Reuse a prepared job. Otherwise prepare it through the
          // existing idempotent server endpoint.
          if (!jobId || existingStatus !== "prepared_for_vercel") {
            const preparation = await prepareMonthlyReportWithVercel(
              {
                classId: activeClassId,
                studentId,
                monthKey: selectedMonth,
                source: "manual",
              },
              userEmail,
            );

            jobId = preparation.jobId;

            setReportState((previous) => {
              if (currentReportScopeRef.current !== scope) return previous;

              const byStudent = previous?.scope === scope
                ? { ...previous.byStudent }
                : {};

              byStudent[studentId] = {
                ...(byStudent[studentId] || {}),
                whatsAppJobId: jobId,
                whatsAppStatus: "prepared_for_vercel",
              };

              return { scope, byStudent };
            });
          }

          if (!jobId) {
            throw new Error("No monthly report job ID was returned.");
          }

          dispatchInvoked = true;

          const result = await dispatchMonthlyReportWithVercel(
            jobId,
            userEmail,
          );

          attempted += 1;

          setReportState((previous) => {
            if (currentReportScopeRef.current !== scope) return previous;

            const byStudent = previous?.scope === scope
              ? { ...previous.byStudent }
              : {};

            byStudent[studentId] = {
              ...(byStudent[studentId] || {}),
              whatsAppJobId: jobId,
              whatsAppStatus: result.status,
              whatsAppLastError:
                result.message || "Provider delivery remains unconfirmed.",
            };

            return { scope, byStudent };
          });
        } catch (error: unknown) {
          if (dispatchInvoked) {
            // A lost response may mean the provider already received the
            // request. Conservatively lock this item against another send.
            attempted += 1;

            if (jobId) {
              setReportState((previous) => {
                if (currentReportScopeRef.current !== scope) return previous;

                const byStudent = previous?.scope === scope
                  ? { ...previous.byStudent }
                  : {};

                byStudent[studentId] = {
                  ...(byStudent[studentId] || {}),
                  whatsAppJobId: jobId,
                  whatsAppStatus: "unknown_outcome",
                  whatsAppLastError:
                    "Dispatch response was interrupted. Manual review required; do not resend.",
                };

                return { scope, byStudent };
              });
            }
          } else {
            failed += 1;
          }

          console.warn(
            "[Reports] A monthly bulk-report item could not be processed.",
            error instanceof Error ? error.name : "UnknownError",
          );
        } finally {
          whatsAppPreparingRef.current.delete(attemptKey);
        }

        completed += 1;
        publishProgress(studentName);
      }
    } finally {
      const paused = currentReportScopeRef.current !== scope;

      bulkWhatsAppSendingRef.current = false;

      setBulkWhatsAppProgress((previous) => {
        if (!previous || previous.scope !== scope) return previous;

        return {
          ...previous,
          completed,
          attempted,
          skipped,
          failed,
          currentStudent: paused
            ? "Paused because the selected class or month changed."
            : "Monthly report batch processing completed.",
          finished: true,
        };
      });

      if (!paused) {
        showToast(
          "Monthly Reports Processed",
          `${attempted} dispatch request(s) attempted, ${skipped} skipped, ${failed} preparation/dispatch error(s). Provider delivery remains unconfirmed where status is unknown.`,
        );
      }
    }
  };

  const handleSaveCategoryAssignment = async () => {
    if (assignmentSaveInProgressRef.current) return;
    if (!isSettingsConfigured) {
      setShowAlertModal(true);
      return;
    }
    if (!activeClassId || !currentClass || selectedStudentIds.length === 0 || !userEmail) return;
    if (!activeClassIsOwned || !classList.some((cls) => cls.id === activeClassId)) return;

    const selectedIdsCopy = selectedStudentIds.filter((studentId) =>
      currentClass.students.some((student) =>
        String(student.id) === String(studentId) && !student.category
      )
    );
    if (selectedIdsCopy.length === 0) {
      setSelectedStudentIds([]);
      showToast('No Students Selected', 'Select one or more currently unassigned students to save a rating.');
      return;
    }

    assignmentSaveInProgressRef.current = true;
    const savedIds: string[] = [];
    const failedNames: string[] = [];
    const preparationFailedNames: string[] = [];
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;

    try {
      for (const studentId of selectedIdsCopy) {
        const student = currentClass.students.find((item) => String(item.id) === String(studentId));
        if (!student) continue;

        const presets = gradingRemarksMap[activeCategoryTab] || [];
        const resolvedRemarks = getResolvedRemarksForStudent(student, activeCategoryTab);
        const remarks = resolvedRemarks.map((item) => item.remarkText).filter(Boolean).join('\n');
        const remarksTemplate = presets.map((item) => `${item.category}: ${item.remarkText}`).join('\n') || (typeof student.remarks === 'string' ? student.remarks : '');
        const metrics = realtimeMetrics[String(student.id)];
        const studentReportId = `${student.id}_${selectedMonth}`;
        const reportRef = doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', studentReportId);
        const reportData = {
          studentId: String(student.id),
          studentName: student.name || '',
          fatherName: student.fatherName || '',
          rollNo: student.rollNo || '',
          classId: activeClassId,
          className: currentClass.name,
          category: activeCategoryTab,
          monthKey: selectedMonth,
          homeworkGrade: student.homeworkGrade || dynamicCriteria[activeCategoryTab].homework,
          behaviorGrade: student.behaviorGrade || dynamicCriteria[activeCategoryTab].behavior,
          participationGrade: student.participationGrade || dynamicCriteria[activeCategoryTab].participation,
          performanceGrade: student.performanceGrade || dynamicCriteria[activeCategoryTab].performance,
          attendanceRate: metrics?.attendancePct || '—',
          presentDays: metrics?.presentDays ?? null,
          totalAttendanceDays: metrics?.totalDays ?? null,
          quizScore: metrics?.quizDisplay || '—',
          quizObtained: metrics?.quizObtained ?? null,
          quizTotal: metrics?.quizTotal ?? null,
          feeStatus: student.feeStatus === 'Loading…' || student.feeStatus === 'Unavailable'
            ? null
            : (student.feeStatus || 'Unrecorded'),
          // `remarks` and `remarkItems` are student-specific resolved text. The source
          // templates are preserved separately only for future audit/backward compatibility.
          remarks,
          remarksTemplate,
          remarkItems: resolvedRemarks,
          updatedAt: serverTimestamp(),
          mode: 'automatic',
        };

        try {
          await setDoc(reportRef, reportData, { merge: true });
          savedIds.push(String(student.id));

          // Update local state only after Firestore accepted this student's write.
          setReportState((previous) => {
            if (currentReportScopeRef.current !== scope) return previous;
            const byStudent = previous?.scope === scope ? { ...previous.byStudent } : {};
            byStudent[String(student.id)] = {
              ...(byStudent[String(student.id)] || {}),
              ...reportData,
              updatedAt: new Date(),
              isConfigured: true,
            };
            return { scope, byStudent };
          });

          const notificationRef = doc(
            db,
            'users',
            userEmail,
            'notifications',
            `report_generated_${activeClassId}_${student.id}_${selectedMonth}`,
          );
          await setDoc(notificationRef, {
            title: 'Automatic Report Generated',
            message: `Report generated for ${student.name || 'student name unavailable'} (Roll: ${student.rollNo || '—'}) in category ${activeCategoryTab}.`,
            type: 'report_generated',
            createdAt: serverTimestamp(),
            read: false,
          }, { merge: true }).catch((notificationError) => {
            console.error('[Reports] Report saved but notification write failed:', notificationError);
          });

          // Prepare WhatsApp independently after the report is saved.
          // The server rechecks the current guardian consent and phone number.
          if (student.parentWhatsAppOptIn === true) {
            try {
              const preparation = await prepareMonthlyReportWithVercel(
                {
                  classId: activeClassId,
                  studentId: String(student.id),
                  monthKey: selectedMonth,
                  source: "automatic",
                },
                userEmail,
              );

              setReportState((previous) => {
                if (currentReportScopeRef.current !== scope) return previous;

                const byStudent = previous?.scope === scope
                  ? { ...previous.byStudent }
                  : {};

                byStudent[String(student.id)] = {
                  ...(byStudent[String(student.id)] || {}),
                  whatsAppStatus: "prepared_for_vercel",
                  whatsAppJobId: preparation.jobId,
                };

                return { scope, byStudent };
              });
            } catch (preparationError) {
              console.warn(
                `[Reports] Report saved, but WhatsApp preparation failed for student ${student.id}.`,
                preparationError,
              );
              preparationFailedNames.push(
                student.name || `Student ID ${student.id}`,
              );
            }
          }
        } catch (writeError) {
          console.error(`[Reports] Could not save report for student ${student.id}:`, writeError);
          failedNames.push(student.name || `Student ID ${student.id}`);
        }
      }

      setSelectedStudentIds((previous) => previous.filter((id) => !savedIds.includes(String(id))));
      if (savedIds.length > 0) {
        showToast('Report Saved', `Successfully saved ${savedIds.length} student report(s) as ${activeCategoryTab}.`);
      }
      if (failedNames.length > 0) {
        showToast('Some Reports Failed', `Could not save: ${failedNames.join(', ')}. Those students remain unassigned.`);
      }
      if (preparationFailedNames.length > 0) {
        showToast(
          'WhatsApp Preparation Pending',
          `Reports were saved, but notification jobs could not be prepared for: ${preparationFailedNames.join(', ')}. No WhatsApp messages were sent.`,
        );
      }
    } finally {
      assignmentSaveInProgressRef.current = false;
    }
  };

  const handleRemoveFromCategory = async (studentId: string | number) => {
    if (!activeClassId || !currentClass || !userEmail) return;
    if (!activeClassIsOwned || !currentClass.students.some((item) => String(item.id) === String(studentId))) return;
    const student = currentClass.students.find((item) => String(item.id) === String(studentId));
    if (!student) return;

    try {
      const reportDocId = `${studentId}_${selectedMonth}`;
      const reportDocRef = doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', reportDocId);
      // Persist an explicit unassigned state so a legacy class.category cannot reappear.
      await setDoc(reportDocRef, {
        studentId: String(student.id),
        studentName: student.name || '',
        fatherName: student.fatherName || '',
        rollNo: student.rollNo || '',
        classId: activeClassId,
        monthKey: selectedMonth,
        category: null,
        remarks: '',
        remarkItems: [],
        mode: 'automatic',
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSingleStudentModal(null);
      showToast('Category Reset', 'Student moved back to the unassigned list.');
    } catch (error) {
      console.error('[Reports] Failed to remove student from category:', error);
      showToast('Category Reset Failed', 'The saved assignment was not changed. Please retry.');
    }
  };

  const navItems: { id: NavTab; label: string; icon: LucideIcon }[] = [
    { id: "home", label: "Home", icon: Home },
    { id: "classes", label: "Classes", icon: GraduationCap },
    { id: "attendance", label: "Attendance", icon: Users },
    { id: "fees", label: "Fees", icon: Wallet },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  const RenderReportCard = ({ student }: { student: Student }) => {
    const cat = student.category;
    if (!cat || !student.isConfigured) {
      return (
        <div className="mx-auto max-w-md rounded-2xl border border-amber-500/40 bg-amber-50 p-5 text-sm font-semibold text-amber-800">
          Save a rating for this student and reporting month before opening a finalized report.
        </div>
      );
    }

    const catConfig = CATEGORY_CONFIG[cat];
    const catCriteria = dynamicCriteria[cat] || CATEGORY_GRADES_MAP[cat];
    const metrics = realtimeMetrics[String(student.id)];
    const metricStateMatches = realtimeMetricState?.scope === currentReportScope;
    const metricDataLoading = !metricStateMatches || realtimeMetricState?.loaded !== true;
    const metricDataFailed = metricStateMatches && realtimeMetricState?.error === true;
    const resolvedRemarks = getResolvedRemarksForStudent(student, cat);
    const evaluationRowsSource: Array<{ label: string; grade: string; remarkCategory: string; configKey: keyof Pick<ReportFieldConfig, 'homeworkEnabled' | 'behaviorEnabled' | 'participationEnabled' | 'performanceEnabled'> }> = [
      { label: 'Homework', grade: student.homeworkGrade || catCriteria.homework, remarkCategory: 'Homework', configKey: 'homeworkEnabled' },
      { label: 'Behavior', grade: student.behaviorGrade || catCriteria.behavior, remarkCategory: 'Behavior', configKey: 'behaviorEnabled' },
      { label: 'Participation', grade: student.participationGrade || catCriteria.participation, remarkCategory: 'Participation', configKey: 'participationEnabled' },
      { label: 'Performance', grade: student.performanceGrade || catCriteria.performance, remarkCategory: 'Performance', configKey: 'performanceEnabled' },
    ];
    const evaluationRows = evaluationRowsSource.filter(
      (row) => reportFieldConfig[row.configKey],
    );
    // Follow the teacher's Report Fields settings exactly: when the remarks text area is
    // disabled, omit the Teacher Remarks column and its Overall Remarks row from the report.
    const showTeacherRemarks = reportFieldConfig.teacherRemarksRequired;
    const showOverallRemarks = showTeacherRemarks;
    const showEvaluationSection = evaluationRows.length > 0 || showOverallRemarks;
    const getRemarkTextForCategory = (category: string): string => {
      const seen = new Set<string>();
      return resolvedRemarks
        .filter((item) => item.category === category)
        .map((item) => item.remarkText.trim())
        .filter((remarkText) => {
          const key = remarkText.replace(/\s+/g, ' ').toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .join(' ');
    };
    const overallRemarkText = getRemarkTextForCategory('Remarks') || (
      resolvedRemarks.length === 0
        ? `No saved remarks are available for the ${cat} rating. Please review Grading Rules to add feedback.`
        : 'No overall remark is configured for this rating.'
    );
    const attendancePercent = metrics?.attendancePct || student.attendanceRate || '—';
    const quizPercent = metrics?.quizDisplay || student.quizScore || '—';
    const reportMonthLabel = formatMonthLabel(selectedMonth).replace(/^Current: /, '');
    const safeTeacherName = teacherProfile.name === 'Teacher name not configured' ? '' : teacherProfile.name;
    const safeAcademyName = teacherProfile.academyName === 'Academy name not configured' ? 'Academy name not configured' : teacherProfile.academyName;
    const profileImageUrl = teacherProfile.avatarUrl;

    return (
      <article className="report-card relative mx-auto w-full max-w-3xl overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white text-slate-900 shadow-[0_24px_70px_rgba(15,23,42,0.12)] print:max-w-none print:rounded-xl print:border-slate-300 print:shadow-none">
        <div className="h-2.5 w-full bg-gradient-to-r from-orange-600 via-orange-400 to-amber-300" />
        <div className="report-card-content space-y-6 p-5 sm:p-7 print:space-y-4 print:p-5">
          <header className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <div className="relative h-[4.25rem] w-[4.25rem] shrink-0 overflow-hidden rounded-2xl border border-orange-200 bg-orange-50 shadow-sm">
                <span className="absolute inset-0 flex items-center justify-center text-xl font-black tracking-wide text-orange-600">{teacherInitials}</span>
                {profileImageUrl && (
                  <img
                    src={profileImageUrl}
                    alt={safeTeacherName ? `${safeTeacherName} profile` : 'Teacher profile'}
                    className="absolute inset-0 h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                  />
                )}
              </div>
              <div className="min-w-0">
                <p className="mb-1 inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.23em] text-orange-600">
                  <Building2 className="h-3.5 w-3.5" /> ACADEMY REPORT
                </p>
                <h2 className="break-words text-xl font-black leading-tight tracking-tight text-slate-950 sm:text-2xl">{safeAcademyName}</h2>
                <p className="mt-1 text-sm font-semibold text-slate-600">Student Performance Report</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold text-slate-500">
                  {safeTeacherName && <span>Prepared by {safeTeacherName}</span>}
                  {teacherProfile.role && <span className="capitalize">{teacherProfile.role}</span>}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-row items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-black shadow-sm ${catConfig.badgeBg}`}>
                <Award className="h-3.5 w-3.5" /> {cat}
              </span>
              <div className="text-left sm:text-right">
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">Reporting Period</p>
                <p className="mt-0.5 text-sm font-extrabold text-slate-800">{reportMonthLabel}</p>
              </div>
            </div>
          </header>

          <section className="report-student-card relative overflow-hidden rounded-2xl border border-orange-100 bg-gradient-to-br from-orange-50 via-white to-amber-50 p-4 sm:p-5 print:bg-orange-50">
            <div className="absolute right-0 top-0 h-24 w-24 translate-x-7 -translate-y-7 rounded-full border-[12px] border-orange-100/70" />
            <div className="relative grid grid-cols-1 gap-x-7 gap-y-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-600">Student of the Month</p>
                <h3 className="mt-1 break-words text-2xl font-black leading-tight text-slate-950 sm:text-[1.75rem]">{student.name || 'Student name not available'}</h3>
              </div>
              <div className="border-t border-orange-100 pt-3 sm:border-t-0 sm:pt-0">
                <p className="text-[9px] font-extrabold uppercase tracking-[0.16em] text-slate-500">Father / Guardian</p>
                <p className="mt-1 break-words text-sm font-bold text-slate-800">{student.fatherName || 'Not provided in student record'}</p>
              </div>
              <div className="border-t border-orange-100 pt-3 sm:border-t-0 sm:pt-0">
                <p className="text-[9px] font-extrabold uppercase tracking-[0.16em] text-slate-500">Class & Roll Number</p>
                <p className="mt-1 break-words text-sm font-bold text-slate-800">{currentClass?.name || 'Class not available'} <span className="mx-1 text-orange-400">/</span> {student.rollNo || 'Roll number not recorded'}</p>
              </div>
            </div>
          </section>

          <section className="report-overview-section space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-600">01 / Monthly overview</p>
                <h3 className="mt-1 text-base font-black text-slate-900">Learning & Wellbeing</h3>
              </div>
              <p className="text-[10px] font-semibold text-slate-400">{reportMonthLabel}</p>
            </div>
            <div className="report-overview-grid grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="report-metric-card rounded-2xl border border-emerald-100 bg-emerald-50/80 p-4 print:bg-emerald-50">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.14em] text-emerald-700">Attendance</p>
                  <span className="rounded-lg bg-white/80 px-2 py-1 text-[9px] font-bold text-emerald-700">Monthly</span>
                </div>
                <p className="report-metric-value mt-2 text-2xl font-black tracking-tight text-emerald-900">{attendancePercent}</p>
                <p className="report-metric-description mt-1 text-[10px] font-medium leading-relaxed text-emerald-800/80">
                  {metricDataLoading ? 'Loading attendance data…' : metricDataFailed ? 'Live metrics could not be fully loaded' : metrics ? `${metrics.presentDays} attended of ${metrics.totalDays} recorded days` : 'Attendance data unavailable'}
                </p>
              </div>
              <div className="report-metric-card rounded-2xl border border-orange-100 bg-orange-50/80 p-4 print:bg-orange-50">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.14em] text-orange-700">Quiz Average</p>
                  <span className="rounded-lg bg-white/80 px-2 py-1 text-[9px] font-bold text-orange-700">Assessment</span>
                </div>
                <p className="report-metric-value mt-2 text-2xl font-black tracking-tight text-orange-900">{quizPercent}</p>
                <p className="report-metric-description mt-1 text-[10px] font-medium leading-relaxed text-orange-800/80">
                  {metricDataLoading ? 'Loading quiz data…' : metricDataFailed ? 'Live metrics could not be fully loaded' : metrics && metrics.quizTotal > 0 ? `${metrics.quizObtained} / ${metrics.quizTotal} total marks recorded` : 'No quiz marks recorded'}
                </p>
              </div>
              <div className="report-metric-card rounded-2xl border border-sky-100 bg-sky-50/80 p-4 print:bg-sky-50">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.14em] text-sky-700">Fee Status</p>
                  <span className="rounded-lg bg-white/80 px-2 py-1 text-[9px] font-bold text-sky-700">{reportMonthLabel}</span>
                </div>
                <p className="report-metric-value mt-2 break-words text-xl font-black tracking-tight text-sky-900">{student.feeStatus || 'Unrecorded'}</p>
                <p className="report-metric-description mt-1 text-[10px] font-medium leading-relaxed text-sky-800/80">Fee status shown from the selected month's saved records.</p>
              </div>
            </div>
          </section>

          {showEvaluationSection && (
          <section className="report-evaluation-section space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-600">02 / Teacher evaluation & feedback</p>
                <h3 className="mt-1 text-base font-black text-slate-900">Academic & Personal Development</h3>
              </div>
              <span className="shrink-0 rounded-full border border-orange-100 bg-orange-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-orange-700">{cat} feedback</span>
            </div>

            <div className="report-evaluation-table overflow-hidden rounded-2xl border border-slate-200">
              <table className="w-full table-fixed border-collapse text-left">
                <thead className="bg-slate-900 text-white">
                  <tr>
                    <th
                      scope="col"
                      className={`${showTeacherRemarks ? 'w-[22%] border-r border-slate-700' : 'w-[76%] border-r border-slate-700'} px-3 py-3 text-[9px] font-black uppercase tracking-[0.12em]`}
                    >
                      Evaluation Criteria
                    </th>
                    {showTeacherRemarks && (
                      <th scope="col" className="w-[64%] border-r border-slate-700 px-3 py-3 text-[9px] font-black uppercase tracking-[0.12em]">
                        Teacher Remarks
                      </th>
                    )}
                    <th scope="col" className={`${showTeacherRemarks ? 'w-[14%]' : 'w-[24%]'} px-2 py-3 text-center text-[9px] font-black uppercase tracking-[0.12em]`}>Grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {evaluationRows.map((row, index) => {
                    const remarkText = getRemarkTextForCategory(row.remarkCategory);
                    return (
                      <tr key={row.label} className="align-top">
                        <td className={`${showTeacherRemarks ? 'border-r border-slate-100' : ''} px-3 py-3 align-middle`}>
                          <div className="report-evaluation-criteria flex items-center gap-2.5">
                            <span className="report-evaluation-number flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-[10px] font-black text-orange-600">{String(index + 1).padStart(2, '0')}</span>
                            <span className="text-xs font-bold text-slate-700">{row.label}</span>
                          </div>
                        </td>
                        {showTeacherRemarks && (
                          <td className="border-r border-slate-100 px-3 py-3">
                            <p className="report-evaluation-remark whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">{remarkText || '—'}</p>
                          </td>
                        )}
                        <td className="px-2 py-3 text-center align-middle">
                          <span className="report-evaluation-grade inline-block min-w-12 rounded-lg border border-orange-100 bg-orange-50 px-2.5 py-1.5 text-center text-xs font-black text-orange-700">{row.grade || '—'}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {showOverallRemarks && (
                    <tr className="report-overall-remarks-row bg-orange-50/70">
                      <td className="border-r border-orange-100 px-3 py-3 align-top">
                        <div className="report-evaluation-criteria flex items-center gap-2.5">
                          <span className="report-evaluation-number flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-[10px] font-black text-orange-700">{String(evaluationRows.length + 1).padStart(2, '0')}</span>
                          <span className="text-xs font-black text-slate-800">Overall Remarks</span>
                        </div>
                      </td>
                      <td colSpan={2} className="px-3 py-3">
                        <p className="report-evaluation-remark whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">{overallRemarkText}</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          )}

          <footer className="report-footer grid grid-cols-1 gap-5 border-t border-slate-200 pt-5 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-2">
              <p className="text-[9px] font-black uppercase tracking-[0.19em] text-orange-600">Issued by</p>
              <p className="text-sm font-black text-slate-900">{safeAcademyName}</p>
              {safeTeacherName && <p className="text-xs font-semibold text-slate-600">{safeTeacherName}{teacherProfile.role ? ` · ${teacherProfile.role}` : ''}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-medium text-slate-500">
                {teacherProfile.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{teacherProfile.phone}</span>}
                {teacherProfile.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{teacherProfile.email}</span>}
              </div>
              <p className="pt-1 text-[9px] font-medium text-slate-400">Report period: {reportMonthLabel} · Class: {currentClass?.name || 'Class not available'}</p>
            </div>
            <div className="min-w-48 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-3 text-center">
              <p className="mb-1 text-[8px] font-black uppercase tracking-[0.16em] text-slate-400">Authorized Teacher Signature</p>
              <p className="report-teacher-signature min-h-8 whitespace-nowrap text-2xl leading-tight text-slate-800" style={{ fontFamily: '"Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive', transform: 'rotate(-4deg)' }}>
                {safeTeacherName || 'Signature not configured'}
              </p>
              <div className="mt-1 border-t border-slate-400 pt-1 text-[9px] font-bold text-slate-600">{safeTeacherName || 'Teacher name unavailable'}</div>
            </div>
          </footer>

          {/* WhatsApp sending is available through the class-level Send Reports button only. */}
        </div>
      </article>
    );
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark bg-[#080c14] text-slate-100' : 'bg-[#faf9f6] text-slate-900'} pb-32 font-sans relative`}>
      <style>{`
        @page { size: A4 portrait; margin: 5mm; }
        @media print {
          html, body { width: 100% !important; height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; background: #fff !important; color: #111827 !important; }
          body * { visibility: hidden !important; }
          /* Hide everything outside the selected print area without hiding its ancestors or its contents. */
          body:has(.report-print-area.print-active) *:not(:has(.report-print-area.print-active)):not(.report-print-area.print-active):not(.report-print-area.print-active *) { display: none !important; }
          body:has(.report-print-area.print-active) *:has(.report-print-area.print-active) { display: block !important; position: static !important; inset: auto !important; width: auto !important; min-width: 0 !important; max-width: none !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; transform: none !important; }
          .report-print-area.print-active, .report-print-area.print-active * { visibility: visible !important; }
          .report-print-area:not(.print-active) { display: none !important; }
          .report-print-area.print-active { display: block !important; position: static !important; width: 100% !important; max-width: none !important; max-height: none !important; height: auto !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; background: #fff !important; color: #111827 !important; box-shadow: none !important; backdrop-filter: none !important; }
          .report-modal-overlay:has(.report-print-area.print-active), .report-modal-shell:has(.report-print-area.print-active) { display: block !important; position: static !important; width: 100% !important; max-width: none !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
          .report-modal-shell > div:first-child { display: none !important; }
          .report-card { width: 100% !important; max-width: none !important; margin: 0 !important; border: 1px solid #d1d5db !important; border-radius: 6px !important; box-shadow: none !important; break-inside: auto !important; page-break-inside: auto !important; }
          .report-card + .report-card { break-before: page !important; page-break-before: always !important; margin-top: 0 !important; }
          .report-card-content { padding: 3mm !important; }
          .report-card-content > * + * { margin-top: 7px !important; }
          .report-card-content header { gap: 7px !important; padding-bottom: 7px !important; }
          .report-card-content header > div:first-child { gap: 8px !important; }
          .report-card-content header > div:first-child > div:first-child { width: 38px !important; height: 38px !important; border-radius: 9px !important; }
          .report-card-content header h2 { font-size: 16px !important; line-height: 1.1 !important; }
          .report-card-content header .text-sm { font-size: 9px !important; line-height: 1.2 !important; }
          .report-card-content header .mt-2 { margin-top: 3px !important; }
          .report-card-content header .rounded-full { padding: 4px 8px !important; font-size: 8px !important; }
          .report-student-card { padding: 8px 12px !important; border-radius: 10px !important; }
          .report-student-card .grid { gap: 5px 14px !important; }
          .report-student-card h3 { margin-top: 2px !important; font-size: 17px !important; line-height: 1.1 !important; }
          .report-student-card .pt-3 { padding-top: 4px !important; }
          .report-overview-section > .flex { gap: 6px !important; }
          .report-overview-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 6px !important; }
          .report-metric-card { padding: 8px !important; border-radius: 10px !important; }
          .report-metric-value { margin-top: 4px !important; font-size: 15px !important; line-height: 1.1 !important; }
          .report-metric-description { margin-top: 3px !important; font-size: 7px !important; line-height: 1.25 !important; }
          .report-evaluation-section { margin-top: 0 !important; }
          .report-evaluation-section > .flex { gap: 6px !important; }
          .report-evaluation-section h3 { margin-top: 2px !important; font-size: 12px !important; line-height: 1.1 !important; }
          .report-evaluation-table { border-radius: 8px !important; }
          .report-evaluation-table th { padding: 6px 7px !important; font-size: 7px !important; line-height: 1.15 !important; }
          .report-evaluation-table td { padding: 5px 7px !important; }
          .report-evaluation-criteria { gap: 5px !important; }
          .report-evaluation-number { width: 19px !important; height: 19px !important; border-radius: 6px !important; font-size: 7px !important; }
          .report-evaluation-criteria > span:last-child { font-size: 8px !important; line-height: 1.15 !important; }
          .report-evaluation-remark { font-size: 7.7px !important; line-height: 1.25 !important; }
          .report-evaluation-grade { min-width: 0 !important; padding: 3px 5px !important; font-size: 8px !important; line-height: 1.1 !important; }
          .report-overall-remarks-row td { background: #fff7ed !important; }
          .report-footer { grid-template-columns: minmax(0, 1fr) auto !important; align-items: end !important; gap: 10px !important; padding-top: 6px !important; }
          .report-footer > div:first-child > * + * { margin-top: 3px !important; }
          .report-footer .text-sm { font-size: 9px !important; }
          .report-footer .text-xs { font-size: 8px !important; }
          .report-footer .report-teacher-signature { min-height: 0 !important; font-size: 18px !important; }
          .report-footer > div:last-child { min-width: 145px !important; padding: 6px 10px !important; border-radius: 8px !important; }
          .report-print-controls, .remarks-preview-overlay { display: none !important; }
          .report-card section, .report-card header, .report-card footer, .report-evaluation-table tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          .report-print-area button, .report-print-area input { display: none !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>

      {/* TOAST NOTIFICATION */}
      {notification.show && (
        <div className="fixed top-5 right-5 z-[200] bg-orange-500 text-white px-5 py-3.5 rounded-2xl shadow-2xl shadow-orange-500/40 flex items-center gap-3">
          <Sparkles className="h-5 w-5" />
          <div>
            <h5 className="text-xs font-black uppercase tracking-wider">{notification.title}</h5>
            <p className="text-[11px] font-bold text-orange-100">{notification.message}</p>
          </div>
        </div>
      )}

      {/* CATEGORY REMARKS PREVIEW: templates are hidden on category cards until requested. */}
      {remarksPreviewCategory && (
        <div className="remarks-preview-overlay fixed inset-0 z-[125] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="category-remarks-title">
          <div className={`w-full max-w-xl overflow-hidden rounded-3xl border shadow-2xl ${isDarkMode ? 'border-slate-700 bg-[#0e131f] text-slate-100' : 'border-orange-100 bg-white text-slate-900'}`}>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-orange-500/5 p-5 dark:border-slate-800">
              <div className="flex items-start gap-3">
                <div className={`rounded-xl p-2.5 ${CATEGORY_CONFIG[remarksPreviewCategory].badgeBg}`}>
                  {React.createElement(CATEGORY_CONFIG[remarksPreviewCategory].icon, { className: 'h-5 w-5' })}
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-500">Saved Grading Rules</p>
                  <h3 id="category-remarks-title" className="mt-1 text-lg font-black">{remarksPreviewCategory} Remarks</h3>
                  <p className="mt-1 text-xs font-medium text-slate-500">These are the saved templates for this rating. Student and father-name fields are personalized in each student's own report.</p>
                </div>
              </div>
              <button onClick={() => setRemarksPreviewCategory(null)} className="rounded-xl border border-slate-200 p-2 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800" aria-label="Close remarks preview">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto p-5">
              {(gradingRemarksMap[remarksPreviewCategory] || []).length ? (
                (gradingRemarksMap[remarksPreviewCategory] || []).map((preset) => {
                  const previewText = preset.remarkText
                    .replace(/\{\{\s*name\s*\}\}/g, 'Student name')
                    .replace(/\{\{\s*father_name\s*\}\}/g, "Father's name");
                  return (
                    <div key={preset.id} className={`rounded-2xl border p-4 ${isDarkMode ? 'border-slate-700 bg-slate-900/60' : 'border-orange-100 bg-orange-50/50'}`}>
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-orange-600">{preset.category}</p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{previewText}</p>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-2xl border border-dashed border-amber-400 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
                  No saved remarks are available for {remarksPreviewCategory}. Add them in the existing Grading Rules tab; this view does not invent default comments.
                </div>
              )}
            </div>
            <div className="flex justify-end border-t border-slate-200 p-4 dark:border-slate-800">
              <Button onClick={() => setRemarksPreviewCategory(null)} className="rounded-xl bg-orange-500 px-5 text-white hover:bg-orange-600">Close</Button>
            </div>
          </div>
        </div>
      )}

      {/* MISSING SETTINGS WARNING MODAL */}
      {showAlertModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
          <div className={`max-w-md w-full rounded-3xl p-6 border-2 border-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.35)] relative ${
            isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
          }`}>
            <button
              onClick={() => setShowAlertModal(false)}
              className="absolute top-4 right-4 p-2 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4 text-slate-400" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="h-12 w-12 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-500 flex-shrink-0">
                <ShieldAlert className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-rose-500 uppercase tracking-tight">System Alert: Rules Missing!</h3>
                <p className="text-[11px] text-slate-400 font-bold">Action Required in Firestore Database</p>
              </div>
            </div>

            <p className="text-xs font-semibold leading-relaxed mb-4 text-slate-600 dark:text-slate-300">
              Ager yeh rules save nahi honge to system reports generate nahi kar sake ga! <strong className="text-orange-500 font-black">First add Grading Rules in Setting Page!</strong>
            </p>

            <div className={`p-3 rounded-2xl border mb-5 font-mono text-[11px] space-y-1 ${getInnerCardClass()}`}>
              <div className="text-[10px] uppercase tracking-wider font-extrabold text-orange-500">
                📁 Database Document Path:
              </div>
              <div className="truncate font-bold text-slate-700 dark:text-slate-200">
                users / {userEmail || 'LOGGED_IN_USER_EMAIL'} / settings / grading_rules
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowAlertModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-black text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                Cancel
              </button>
              <Button
                onClick={() => window.location.href = '/settings'}
                className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-5 py-2.5 shadow-lg shadow-orange-500/30 flex items-center gap-2"
              >
                <span>Go To Setting Page</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* SINGLE STUDENT PERFORMANCE REPORT MODAL */}
      {singleStudentModal && singleStudentModal.category && singleStudentModal.isConfigured && (
        <div className="report-modal-overlay fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className={`report-modal-shell max-w-2xl w-full max-h-[90vh] overflow-y-auto rounded-3xl p-6 border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.3)] relative ${
            isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
          }`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black">
                  <UserCheck className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black">Student Performance Report</h3>
                  <p className="text-[11px] text-slate-400 font-bold">{singleStudentModal.name || 'Name not available'} • Roll No: {singleStudentModal.rollNo || '—'}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => {
                    setPrintMode('single');
                    window.setTimeout(() => window.print(), 0);
                  }}
                  className="report-print-controls bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-lg shadow-orange-500/20 flex items-center gap-1.5"
                >
                  <Printer className="h-4 w-4" />
                  <span>Print Card</span>
                </Button>
                <button
                  onClick={() => { setSingleStudentModal(null); setPrintMode(null); }}
                  className="report-print-controls p-2 rounded-xl border border-slate-700 hover:bg-slate-800"
                >
                  <X className="h-5 w-5 text-slate-400" />
                </button>
              </div>
            </div>

            <div id="single-report-print-area" className={`report-print-area ${printMode === 'single' ? 'print-active' : ''}`}>
              <RenderReportCard student={singleStudentModal} />
            </div>
          </div>
        </div>
      )}

      {/* ALL REPORTS PREVIEW MODAL */}
      {showReportPreviewModal && currentClass && allReportsReady && (
        <div className="report-modal-overlay fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className={`report-modal-shell max-w-4xl w-full max-h-[90vh] overflow-y-auto rounded-3xl p-6 border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.3)] relative ${
            isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
          }`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black">
                  <FileCheck className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black">All Class Reports</h3>
                  <p className="text-[11px] text-slate-400 font-bold">{currentClass.name} • Total: {currentClass.students.length} Students</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => {
                    if (!allReportsReady) {
                      showToast('Preview Not Ready', allReportsBlockedReason || 'Every student must have a saved rating first.');
                      return;
                    }
                    setPrintMode('all');
                    window.setTimeout(() => window.print(), 0);
                  }}
                  disabled={!allReportsReady}
                  className="report-print-controls bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-lg shadow-orange-500/20 flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Printer className="h-4 w-4" />
                  <span>Print All</span>
                </Button>
                <button
                  onClick={() => { setShowReportPreviewModal(false); setPrintMode(null); }}
                  className="report-print-controls p-2 rounded-xl border border-slate-700 hover:bg-slate-800"
                >
                  <X className="h-5 w-5 text-slate-400" />
                </button>
              </div>
            </div>

            <div id="all-reports-print-area" className={`report-print-area py-6 space-y-8 ${printMode === 'all' ? 'print-active' : ''}`}>
              {currentClass.students.filter((student) => student.category && student.isConfigured).map((student) => (
                <RenderReportCard key={student.id} student={student} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TOP HEADER */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
        <div className={`w-full px-5 py-4 rounded-3xl border-2 border-orange-500/80 shadow-[0_0_20px_rgba(249,115,22,0.25)] flex flex-wrap items-center justify-between gap-4 ${
          isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
        }`}>
          <div className="flex items-center gap-3.5">
            <button 
              onClick={() => setActiveClassId(null)}
              className="flex items-center justify-center h-10 w-10 rounded-2xl bg-orange-500 text-white shadow-md shadow-orange-500/30"
            >
              <ArrowLeft className="h-5 w-5 stroke-[2.5]" />
            </button>

            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-orange-500/40 bg-orange-500/10 text-orange-500 dark:text-orange-400 text-[10px] font-extrabold uppercase mb-1">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-500"></span>
                LIVE FIRESTORE ENGINE
              </div>
              <h1 className="text-base sm:text-lg font-black tracking-wide uppercase">
                ACADEMIC REPORTS DASHBOARD
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/40 rounded-2xl px-3 py-1.5">
            <Calendar className="h-4 w-4 text-orange-500" />
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="bg-transparent text-xs font-black outline-none cursor-pointer text-slate-800 dark:text-slate-100"
            >
              {availableMonths.map((m) => (
                <option key={m.key} value={m.key} className="bg-white dark:bg-[#0e131f] text-slate-900 dark:text-white">
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT AREA */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {!isSettingsConfigured && (
          <div className="w-full bg-rose-500/10 border-2 border-rose-500/80 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg shadow-rose-500/10">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-rose-500 text-white font-black">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-xs font-black text-rose-500">First Add Grading Rules In Setting Page!</h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 font-bold">
                  Document Path: 
                </p>
              </div>
            </div>

            <Button
              onClick={() => window.location.href = '/settings'}
              className="bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-md shadow-rose-500/20 whitespace-nowrap flex items-center gap-1.5"
            >
              <span>Go to Settings Page</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className={`w-full px-4 py-3 rounded-2xl border-2 border-orange-500/70 shadow-[0_0_15px_rgba(249,115,22,0.2)] flex items-center justify-between gap-3 ${
          isDarkMode ? 'bg-[#0e131f]' : 'bg-white'
        }`}>
          <div className={`relative flex-1 max-w-md flex items-center rounded-xl border px-3 py-2 ${getCardClass()}`}>
            <Search className="h-4 w-4 text-slate-400 mr-2" />
            <input
              type="text"
              placeholder="Search class or student..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-xs font-bold outline-none w-full text-slate-900 dark:text-slate-100"
            />
          </div>

          <button
            onClick={() => setIsDarkMode((prev) => !prev)}
            className={`h-8 w-14 rounded-full p-1 flex items-center border shadow-sm ${
              isDarkMode ? 'bg-slate-800 border-slate-600 justify-end' : 'bg-slate-200 border-slate-300 justify-start'
            }`}
          >
            <div className={`h-6 w-6 rounded-full flex items-center justify-center shadow-sm ${
              isDarkMode ? 'bg-orange-500 text-white' : 'bg-white text-slate-700'
            }`}>
              {isDarkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </div>
          </button>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Loader2 className="h-10 w-10 text-orange-500 animate-spin" />
            <p className="text-xs font-bold text-slate-400">Loading Firestore Realtime Database...</p>
          </div>
        )}

        {!loading && !activeClassId && (
          <div className="space-y-6">
            <div className={`relative overflow-hidden rounded-3xl p-6 sm:p-8 border-2 border-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.25)] ${
              isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
            }`}>
              <div className="relative z-10 space-y-3">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-orange-500/50 bg-orange-500/10 text-orange-500 dark:text-orange-400 text-xs font-black uppercase tracking-wider">
                  <span className="h-2 w-2 rounded-full bg-orange-500"></span>
                  LIVE ENGINE ACTIVE
                </div>
                <h2 className="text-2xl sm:text-4xl font-black tracking-tight">Tuition Management System</h2>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-300 max-w-xl font-medium">
                  Select a class to generate automated weekly performance report cards with live quiz marks for <span className="text-orange-500 font-bold">{formatMonthLabel(selectedMonth)}</span>.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredClasses.length === 0 ? (
                <div className={`col-span-full text-center py-12 text-slate-400 font-bold text-xs ${getCardClass()} rounded-3xl border border-dashed`}>
                  No classes found in Firebase database.
                </div>
              ) : (
                filteredClasses.map((cls) => (
                  <div
                    key={cls.id}
                    onClick={() => setActiveClassId(cls.id)}
                    className={`group border-2 border-orange-500/60 hover:border-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.15)] hover:shadow-[0_0_20px_rgba(249,115,22,0.3)] rounded-3xl p-6 cursor-pointer relative overflow-hidden ${
                      isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-12 w-12 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black">
                        <BookOpen className="h-6 w-6" />
                      </div>
                      <span className="text-[10px] font-black text-orange-500 dark:text-orange-400 bg-orange-500/10 px-3 py-1 rounded-xl uppercase border border-orange-500/20">
                        {cls.code}
                      </span>
                    </div>

                    <h3 className="text-base font-black group-hover:text-orange-500 mb-1">
                      {cls.name}
                    </h3>
                    <p className="text-xs text-slate-400 font-medium mb-4">Realtime Enrolled Roster</p>

                    <div className={`flex items-center justify-between pt-4 border-t text-xs font-bold ${
                      isDarkMode ? 'border-slate-800' : 'border-slate-100'
                    }`}>
                      <span className="text-slate-400">Total Students:</span>
                      <span className={`px-3 py-1 rounded-lg border border-orange-500/20 text-orange-500 font-black ${getInnerCardClass()}`}>
                        {cls.students.length} Enrolled
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {!loading && activeClassId && currentClass && (
          <div className="space-y-6 max-w-5xl mx-auto">

            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <button
                onClick={() => setActiveClassId(null)}
                className="group inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-orange-500 text-white font-extrabold text-xs shadow-lg shadow-orange-500/20 hover:bg-orange-600"
              >
                <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
                <span>Move to Class Directory</span>
              </button>

              <div className="p-2 rounded-2xl border-2 border-orange-500/80 shadow-[0_0_15px_rgba(249,115,22,0.25)] flex items-center gap-2 text-xs font-black text-orange-500">
                <Zap className="h-4 w-4" /> Automatic Reporting Mode Active
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-xl border border-orange-500/40 bg-orange-500/10">
                  <span className="px-2 py-0.5 rounded-lg bg-orange-500 text-white text-[10px] font-black uppercase">
                    Step 1
                  </span>
                  <span className="text-xs font-black text-orange-500 dark:text-orange-400 uppercase tracking-wider">
                    Select Category ({formatMonthLabel(selectedMonth)})
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(['Excellent', 'Good', 'Average', 'Poor'] as CategoryType[]).map((cat) => {
                    const isSelected = activeCategoryTab === cat;
                    const count = currentClass.students.filter((s) => s.category === cat).length;
                    const config = CATEGORY_CONFIG[cat];

                    return (
                      <button
                        key={cat}
                        onClick={() => {
                          setActiveCategoryTab(cat);
                          setSelectedStudentIds([]);
                        }}
                        className={`p-4 rounded-2xl border-2 font-black text-xs flex flex-col items-center justify-center gap-1.5 relative overflow-hidden ${
                          isSelected
                            ? `${config.color} border-orange-500 shadow-lg shadow-orange-500/20`
                            : `${getCardClass()}`
                        }`}
                      >
                        <span className="text-sm font-black">{cat}</span>
                        <span className={`text-[10px] font-bold ${getInnerCardClass()} px-2 py-0.5 rounded-full`}>
                          {count} Assigned
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={`border-2 border-orange-500/70 shadow-[0_0_20px_rgba(249,115,22,0.2)] rounded-3xl p-5 space-y-4 ${
                isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
              }`}>
                <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b ${
                  isDarkMode ? 'border-slate-800' : 'border-slate-100'
                }`}>
                  <div>
                    <h4 className="text-xs font-black">
                      Unassigned Student Cards ({unassignedStudents.length}) - {formatMonthLabel(selectedMonth)}
                    </h4>
                    <p className="text-[10px] text-slate-400 font-bold">
                      Select students and save a rating to unlock individual reports. Current rating: <span className={CATEGORY_CONFIG[activeCategoryTab].textColor}>"{activeCategoryTab}"</span>.
                    </p>
                  </div>

                  <Button
                    disabled={selectedStudentIds.length === 0}
                    onClick={handleSaveCategoryAssignment}
                    className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-md shadow-orange-500/20 disabled:opacity-40"
                  >
                    <Check className="h-3.5 w-3.5 mr-1 stroke-[3]" /> Save ({selectedStudentIds.length}) To {activeCategoryTab}
                  </Button>
                </div>

                {unassignedStudents.length > 0 && (
                  <div className={`rounded-2xl border p-4 space-y-3 ${
                    isDarkMode
                      ? 'border-orange-500/30 bg-gradient-to-br from-orange-500/10 via-slate-900/70 to-amber-500/5'
                      : 'border-orange-200 bg-gradient-to-br from-orange-50/90 via-white to-amber-50/70 shadow-sm'
                  }`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white flex items-center justify-center shadow-md shadow-orange-500/20">
                          <Search className="h-4 w-4" />
                        </div>
                        <div>
                          <h4 className="text-xs font-black">Smart Student Filters</h4>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold">Match attendance and quiz results before assigning {activeCategoryTab}.</p>
                        </div>
                      </div>
                      <span className="self-start sm:self-auto rounded-full border border-orange-200 dark:border-orange-900/60 bg-white/80 dark:bg-slate-950/60 px-3 py-1 text-[10px] font-black text-orange-600 dark:text-orange-300">
                        {filteredUnassignedStudents.length} MATCHING
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className={`rounded-xl border p-3 space-y-2 ${
                        useAttendanceFilter ? 'border-emerald-400 bg-emerald-500/5' : 'border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/50'
                      }`}>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useAttendanceFilter}
                            onChange={(event) => {
                              setUseAttendanceFilter(event.target.checked);
                              setSelectedStudentIds([]);
                              setCurrentPage(1);
                            }}
                            className="h-4 w-4 accent-emerald-500"
                            aria-label="Enable attendance filter"
                          />
                          <span className="text-[11px] font-black">Attendance at least</span>
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={attendanceThreshold}
                            disabled={!useAttendanceFilter}
                            onChange={(event) => {
                              const raw = event.target.value;
                              const value = raw === '' ? 0 : Number(raw);
                              if (!Number.isFinite(value)) return;
                              setAttendanceThreshold(Math.min(100, Math.max(0, value)));
                              setSelectedStudentIds([]);
                              setCurrentPage(1);
                            }}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-bold outline-none focus:border-emerald-500 disabled:opacity-45"
                            aria-label="Minimum attendance percentage"
                          />
                          <span className="text-xs font-black text-emerald-600 dark:text-emerald-400">%</span>
                        </div>
                      </div>

                      <div className={`rounded-xl border p-3 space-y-2 ${
                        useQuizFilter ? 'border-blue-400 bg-blue-500/5' : 'border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/50'
                      }`}>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useQuizFilter}
                            onChange={(event) => {
                              setUseQuizFilter(event.target.checked);
                              setSelectedStudentIds([]);
                              setCurrentPage(1);
                            }}
                            className="h-4 w-4 accent-blue-500"
                            aria-label="Enable quiz marks filter"
                          />
                          <span className="text-[11px] font-black">Quiz marks at least</span>
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={quizThreshold}
                            disabled={!useQuizFilter}
                            onChange={(event) => {
                              const raw = event.target.value;
                              const value = raw === '' ? 0 : Number(raw);
                              if (!Number.isFinite(value)) return;
                              setQuizThreshold(Math.min(100, Math.max(0, value)));
                              setSelectedStudentIds([]);
                              setCurrentPage(1);
                            }}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-bold outline-none focus:border-blue-500 disabled:opacity-45"
                            aria-label="Minimum quiz marks percentage"
                          />
                          <span className="text-xs font-black text-blue-600 dark:text-blue-400">%</span>
                        </div>
                      </div>
                    </div>

                    {hasActiveMetricFilters && !filterMetricsReady && (
                      <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                        Attendance/quiz metrics are loading or unavailable for this month. Filtered selection stays disabled until the metrics are verified.
                      </p>
                    )}

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1">
                      <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                        {hasActiveMetricFilters
                          ? 'Both enabled filters must match. Changing a filter clears the current selection to prevent accidental assignments.'
                          : 'Filters are off, so all unassigned students remain visible.'}
                      </p>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <Button
                          type="button"
                          disabled={filteredUnassignedStudents.length === 0 || (hasActiveMetricFilters && !filterMetricsReady)}
                          onClick={handleSelectAllFilteredStudents}
                          className="rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white text-[10px] font-black shadow-md shadow-orange-500/20 disabled:opacity-40"
                        >
                          <Check className="h-3.5 w-3.5 mr-1" />
                          {areAllFilteredStudentsSelected ? 'Deselect Filtered' : 'Select All Filtered'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!useAttendanceFilter && !useQuizFilter && selectedStudentIds.length === 0}
                          onClick={handleClearStudentFilters}
                          className="rounded-xl text-[10px] font-black border-slate-300 dark:border-slate-700"
                        >
                          Clear Filters
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {unassignedStudents.length === 0 ? (
                  <div className="py-8 text-center space-y-3 bg-emerald-500/10 border-2 border-dashed border-emerald-500/40 rounded-2xl p-4">
                    <div className="h-12 w-12 rounded-full bg-emerald-500 text-white mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/30">
                      <Sparkles className="h-6 w-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-emerald-500">All Class Students Categorized!</h4>
                      <p className="text-xs text-slate-400 font-bold mt-1">
                        You can view individual report cards by clicking any student below or click preview all.
                      </p>
                    </div>

                    <Button
                      type="button"
                      disabled={
                        !allReportsReady ||
                        (bulkWhatsAppProgress?.scope === currentReportScope &&
                          !bulkWhatsAppProgress.finished)
                      }
                      onClick={() => void handleSendAllMonthlyReports()}
                      className="bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-700 hover:to-teal-600 text-white rounded-2xl text-xs font-black px-6 py-3 shadow-xl shadow-emerald-500/30 ring-1 ring-emerald-400/40 inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Send className="h-4 w-4" />
                      <span>Send Reports</span>
                    </Button>

                    <Button
                      disabled={!allReportsReady}
                      onClick={() => {
                        if (!allReportsReady) {
                          showToast('Preview Not Ready', allReportsBlockedReason || 'Wait for the current month data to finish loading.');
                          return;
                        }
                        setPrintMode(null);
                        setShowReportPreviewModal(true);
                      }}
                      className="bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl text-xs font-black px-6 py-3 shadow-xl shadow-emerald-500/30 inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <FileCheck className="h-4 w-4" />
                      <span>Preview All Performance Reports</span>
                    </Button>

                    {bulkWhatsAppProgress?.scope === currentReportScope && (
                      <div
                        role="status"
                        aria-live="polite"
                        className="mx-auto w-full max-w-2xl rounded-2xl border border-emerald-300 bg-emerald-50/90 dark:bg-emerald-950/40 dark:border-emerald-700 p-4 text-left shadow-[0_0_26px_rgba(16,185,129,0.22)] ring-1 ring-emerald-400/30"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="relative flex h-3 w-3 shrink-0">
                              {!bulkWhatsAppProgress.finished && (
                                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                              )}
                              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                            </span>
                            <span className="text-xs font-black text-emerald-800 dark:text-emerald-200">
                              {bulkWhatsAppProgress.finished
                                ? "Monthly Reports Processing Complete"
                                : "Sending Monthly Reports"}
                            </span>
                          </div>
                          <span className="text-sm font-black tabular-nums text-emerald-700 dark:text-emerald-300">
                            {Math.round(
                              (bulkWhatsAppProgress.completed /
                                Math.max(1, bulkWhatsAppProgress.total)) * 100,
                            )}%
                          </span>
                        </div>

                        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-emerald-200/70 dark:bg-emerald-900/80">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-600 shadow-[0_0_14px_rgba(16,185,129,0.65)] transition-all duration-500 ease-out"
                            style={{
                              width: `${Math.round(
                                (bulkWhatsAppProgress.completed /
                                  Math.max(1, bulkWhatsAppProgress.total)) * 100,
                              )}%`,
                            }}
                          />
                        </div>

                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold text-emerald-800 dark:text-emerald-200">
                          <span>
                            {bulkWhatsAppProgress.completed} / {bulkWhatsAppProgress.total} students processed
                          </span>
                          <span>
                            Attempted: {bulkWhatsAppProgress.attempted}
                            {" · "}Skipped: {bulkWhatsAppProgress.skipped}
                            {" · "}Errors: {bulkWhatsAppProgress.failed}
                          </span>
                        </div>

                        <p className="mt-2 truncate text-[10px] text-emerald-700 dark:text-emerald-300">
                          {bulkWhatsAppProgress.currentStudent}
                        </p>

                        {bulkWhatsAppProgress.finished && (
                          <p className="mt-2 text-[10px] leading-relaxed font-semibold text-amber-700 dark:text-amber-300">
                            Progress measures processed reports, not confirmed WhatsApp delivery. Unknown outcomes are not resent automatically. Each student report is protected by the server-side monthly duplicate lock.
                          </p>
                        )}
                      </div>
                    )}

                    {!allReportsReady && <p className="mx-auto max-w-xl text-xs font-semibold text-amber-600">{allReportsBlockedReason}</p>}
                  </div>
                ) : filteredUnassignedStudents.length === 0 ? (
                  <div className={`py-8 text-center space-y-2 rounded-2xl border-2 border-dashed p-5 ${
                    isDarkMode ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50/80'
                  }`}>
                    <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-500 mx-auto flex items-center justify-center">
                      <Search className="h-5 w-5" />
                    </div>
                    <h4 className="text-xs font-black">No Matching Students</h4>
                    <p className="mx-auto max-w-lg text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                      {hasActiveMetricFilters && !filterMetricsReady
                        ? 'Wait for attendance and quiz metrics to load successfully, or clear the filters to view all unassigned students.'
                        : 'No unassigned students match the active criteria. Lower a threshold or clear filters to see more students.'}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleClearStudentFilters}
                      className="rounded-xl text-[10px] font-black border-orange-300 dark:border-orange-900"
                    >
                      Clear Filters
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2.5 min-h-[280px]">
                      {paginatedUnassignedStudents.map((student) => {
                        const isChecked = selectedStudentIds.some((id) => String(id) === String(student.id));
                        
                        const liveMetrics = realtimeMetrics[String(student.id)] || {
                          attendancePct: '—',
                          quizDisplay: '—',
                        };

                        return (
                          <div
                            key={student.id}
                            className={`flex items-center justify-between p-3.5 rounded-2xl border ${
                              isChecked
                                ? 'bg-orange-500/20 border-orange-500 shadow-sm'
                                : `${getInnerCardClass()}`
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleStudentSelection(student.id);
                                }}
                                className={`h-5 w-5 rounded-full border cursor-pointer flex items-center justify-center ${
                                  isChecked ? 'bg-orange-500 border-orange-500 text-white' : 'border-slate-400 bg-transparent'
                                }`}
                              >
                                {isChecked && <Check className="h-3 w-3 stroke-[3]" />}
                              </div>

                              <div className="flex items-center gap-3 group">
                                <img src={student.avatar} alt="" className="h-9 w-9 rounded-full object-cover bg-slate-700 border border-slate-600" />

                                <div>
                                  <p className="text-xs font-black group-hover:text-orange-500 flex items-center gap-1.5">
                                    {student.name || 'Name not available'}
                                  </p>
                                  <p className="text-[10px] text-slate-400 font-bold">Roll No: {student.rollNo || '—'}</p>
                                  <p className="text-[10px] font-semibold text-amber-600">Rating must be saved before preview</p>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-2" aria-label="Preview unavailable until rating is saved">
                              <span className="text-[10px] font-black bg-emerald-500/10 text-emerald-500 px-2.5 py-1 rounded-xl border border-emerald-500/20">
                                Att: {liveMetrics.attendancePct}
                              </span>
                              <span className="text-[10px] font-black bg-orange-500/10 text-orange-500 px-2.5 py-1 rounded-xl border border-orange-500/20">
                                Quiz: {liveMetrics.quizDisplay}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {totalPages > 1 && (
                      <div className={`flex items-center justify-between pt-3 border-t text-xs font-bold ${
                        isDarkMode ? 'border-slate-800' : 'border-slate-100'
                      }`}>
                        <span className="text-[11px] text-slate-400">
                          Page <strong className="text-orange-500">{currentPage}</strong> of {totalPages} ({filteredUnassignedStudents.length} Matching Students)
                        </span>

                        <div className="flex items-center gap-2">
                          <button
                            disabled={currentPage === 1}
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            className="p-1.5 rounded-xl border border-slate-700 disabled:opacity-30 hover:bg-orange-500 hover:text-white"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>

                          <span className="text-[10px] font-black px-2.5 py-1 rounded-lg bg-orange-500/10 text-orange-500">
                            {currentPage} / {totalPages}
                          </span>

                          <button
                            disabled={currentPage === totalPages}
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            className="p-1.5 rounded-xl border border-slate-700 disabled:opacity-30 hover:bg-orange-500 hover:text-white"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                    Categorized Roster Cards ({formatMonthLabel(selectedMonth)})
                  </h4>

                  <Button
                    disabled={!allReportsReady}
                    title={allReportsReady ? 'Preview all saved reports' : allReportsBlockedReason}
                    onClick={() => {
                      if (!allReportsReady) {
                        showToast('Preview Not Ready', allReportsBlockedReason || 'Every student must have a saved rating first.');
                        return;
                      }
                      setPrintMode(null);
                      setShowReportPreviewModal(true);
                    }}
                    className="bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-black px-3 py-1.5 shadow-md shadow-emerald-500/20 flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <FileCheck className="h-3.5 w-3.5" />
                    <span>Preview / Print All Reports</span>
                  </Button>
                </div>
                {!allReportsReady && (
                  <p className="text-[11px] font-semibold text-amber-600" role="status">{allReportsBlockedReason}</p>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(['Excellent', 'Good', 'Average', 'Poor'] as CategoryType[]).map((cat) => {
                    const catStudents = currentClass.students.filter((s) => s.category === cat);
                    const catConfig = CATEGORY_CONFIG[cat];
                    const CategoryIcon = catConfig.icon;

                    return (
                      <div
                        key={cat}
                        className={`border-2 border-orange-500/50 rounded-3xl p-5 space-y-3 relative overflow-hidden shadow-[0_0_15px_rgba(249,115,22,0.15)] ${
                          isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
                        }`}
                      >
                        <div className={`flex items-center justify-between border-b pb-3 ${
                          isDarkMode ? 'border-slate-800' : 'border-slate-100'
                        }`}>
                          <div className="flex items-center gap-2.5">
                            <div className={`p-2 rounded-xl ${catConfig.badgeBg}`}>
                              <CategoryIcon className="h-4 w-4" />
                            </div>
                            <div>
                              <h5 className={`text-sm font-black ${catConfig.textColor}`}>{cat}</h5>
                              <p className="text-[10px] text-slate-400 font-bold">{catStudents.length} Students Assigned</p>
                            </div>
                          </div>
                        </div>

                        <div className={`flex items-center justify-between gap-3 rounded-2xl border p-3 ${isDarkMode ? 'border-slate-700 bg-slate-900/60' : 'border-slate-100 bg-slate-50'}`}>
                          <div className="min-w-0">
                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-300">Teacher remarks</p>
                            <p className="mt-1 text-[10px] font-medium text-slate-400">
                              {gradingRemarksMap[cat]?.length ? `${gradingRemarksMap[cat].length} saved remark preset${gradingRemarksMap[cat].length === 1 ? '' : 's'}` : 'No saved remarks for this rating'}
                            </p>
                          </div>
                          <Button
                            onClick={() => setRemarksPreviewCategory(cat)}
                            variant="outline"
                            className="shrink-0 rounded-xl border-orange-200 bg-white px-3 py-2 text-[10px] font-black text-orange-600 hover:bg-orange-50 dark:border-slate-700 dark:bg-slate-800 dark:text-orange-400"
                          >
                            <Eye className="mr-1.5 h-3.5 w-3.5" /> View Remarks
                          </Button>
                        </div>

                        {catStudents.length === 0 ? (
                          <p className="text-[11px] text-slate-400 font-bold py-2 text-center">No students assigned yet.</p>
                        ) : (
                          <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                            {catStudents.map((s) => (
                              <div 
                                key={s.id} 
                                className={`flex items-center justify-between p-2.5 rounded-xl ${getInnerCardClass()} border`}
                              >
                                <div className="flex items-center gap-2">
                                  <img src={s.avatar} className="h-7 w-7 rounded-full bg-slate-700" alt="" />
                                  <div>
                                    <span className="text-xs font-black block">{s.name || 'Name not available'}</span>
                                    <span className="text-[9px] text-slate-400 font-bold">Roll: {s.rollNo || '—'}</span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => {
                                      if (!reportFieldConfigReady) {
                                        showToast(
                                          reportFieldConfigError ? 'Report Configuration Unavailable' : 'Report Configuration Loading',
                                          reportFieldConfigError
                                            ? 'This teacher’s report field configuration could not be loaded. Check Firestore access and try again.'
                                            : 'Please wait until this teacher’s report field settings finish loading.'
                                        );
                                        return;
                                      }
                                      if (!s.category || !s.isConfigured) {
                                        showToast('Report Unavailable', 'Save this student’s rating for the selected month first.');
                                        return;
                                      }
                                      setPrintMode(null);
                                      setSingleStudentModal(s);
                                    }}
                                    disabled={!reportFieldConfigReady || !s.category || !s.isConfigured}
                                    className="text-[10px] bg-orange-500 text-white font-black px-2 py-1 rounded-lg hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    View Report
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveFromCategory(s.id);
                                    }}
                                    className="text-[10px] text-rose-500 hover:text-rose-600 font-black px-2 py-1 rounded-lg hover:bg-rose-500/10"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

          </div>
        )}

      </main>

      {/* BOTTOM NAVBAR */}
      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
        <div className={`flex items-center justify-between rounded-full px-6 py-3 shadow-lg border w-[380px] ${
          isDarkMode ? 'bg-[#0e131f] border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
        }`}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;

            return (
              <button
                key={item.id}
                onClick={() => setActiveNav(item.id)}
                className={`flex flex-col items-center gap-1 w-14 ${
                  active 
                    ? 'text-orange-500 font-black' 
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-orange-500' : ''}`} />
                <span className="text-[10px] font-bold">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}
