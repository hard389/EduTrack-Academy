import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { CheckCircle2, CreditCard, Eye, Gift, Loader2, Pencil, Plus, RefreshCw, Receipt, ShieldCheck, Trash2, Users, X, XCircle } from 'lucide-react';
import { FEATURE_PERMISSION_CATALOG } from '../../../server/subscriptionFeaturePermissions.mjs';

type Props = { adminUser: User; localDark: boolean };
type PaymentMethodDraft = {
  id: string;
  name: string;
  type: 'bank' | 'mobile_wallet' | 'other';
  providerName: string;
  accountTitle: string;
  accountNumber: string;
  iban: string;
  mobileNumber: string;
  branch: string;
  instructions: string;
};

function createPaymentMethodDraft(): PaymentMethodDraft {
  return {
    id: `payment-method-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '', type: 'bank', providerName: '', accountTitle: '', accountNumber: '',
    iban: '', mobileNumber: '', branch: '', instructions: '',
  };
}

function readPaymentMethodDrafts(value: unknown): PaymentMethodDraft[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const type = record.type === 'mobile_wallet' || record.type === 'other' ? record.type : 'bank';
    const read = (key: string) => typeof record[key] === 'string' ? String(record[key]) : '';
    return [{
      id: read('id') || `payment-method-${index + 1}`,
      name: read('name'), type, providerName: read('providerName'),
      accountTitle: read('accountTitle'), accountNumber: read('accountNumber'),
      iban: read('iban'), mobileNumber: read('mobileNumber'), branch: read('branch'),
      instructions: read('instructions'),
    }];
  });
}

function migrateLegacyPaymentInstructions(value: string): { method: PaymentMethodDraft | null; instructions: string } {
  const lines = value.split(/\r?\n/);
  const readLine = (labels: string[]) => {
    for (const line of lines) {
      const match = line.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
      if (match && labels.includes(match[1].trim().toLowerCase())) return match[2].trim();
    }
    return '';
  };
  const bank = readLine(['bank', 'bank name']);
  const accountTitle = readLine(['account title', 'account name']);
  const accountNumber = readLine(['account number', 'account no', 'account no.', 'a/c number', 'a/c no', 'a/c no.']);
  const iban = readLine(['iban']);
  const mobileNumber = readLine(['mobile number', 'wallet number']);
  if (!accountNumber && !iban && !mobileNumber) return { method: null, instructions: value };

  const labels = new Set(['bank', 'bank name', 'account title', 'account name', 'account number', 'account no', 'account no.', 'a/c number', 'a/c no', 'a/c no.', 'iban', 'mobile number', 'wallet number']);
  const instructions = lines.filter((line) => {
    const match = line.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
    return !match || !labels.has(match[1].trim().toLowerCase());
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const type: PaymentMethodDraft['type'] = mobileNumber && !bank && !accountNumber && !iban ? 'mobile_wallet' : 'bank';
  return {
    method: {
      id: 'legacy-payment-method',
      name: type === 'mobile_wallet' ? 'Mobile wallet' : 'Bank transfer',
      type,
      providerName: bank,
      accountTitle,
      accountNumber,
      iban,
      mobileNumber,
      branch: '',
      instructions: '',
    },
    instructions,
  };
}

type FeaturePermissionKey = typeof FEATURE_PERMISSION_CATALOG[number]['key'];
type PermissionState = 'enabled' | 'disabled' | 'configurable';
type FeaturePermissionMap = Record<FeaturePermissionKey, PermissionState>;

const SHARED_FEATURE_DEFAULTS: Omit<FeaturePermissionMap, 'fortnightly_reports' | 'weekly_reports' | 'attendance_analytics' | 'advanced_analytics' | 'fee_tracking' | 'fee_alerts' | 'custom_alerts' | 'quiz_result_notifications'> = {
  student_management: 'enabled', class_management: 'enabled', attendance_management: 'enabled',
  attendance_alerts: 'configurable', monthly_reports: 'enabled', quiz_management: 'enabled',
  notes_library: 'enabled', library_link_whatsapp: 'configurable', announcements: 'enabled',
};
function defaultFeaturePermissionMap(tier: 'basic' | 'advance' | 'pro'): FeaturePermissionMap {
  return {
    ...SHARED_FEATURE_DEFAULTS,
    announcements: tier === 'basic' ? 'disabled' : 'enabled',
    library_link_whatsapp: tier === 'basic' ? 'disabled' : tier === 'advance' ? 'configurable' : 'enabled',
    fee_alerts: tier === 'basic' ? 'disabled' : tier === 'advance' ? 'configurable' : 'enabled',
    fortnightly_reports: tier === 'basic' ? 'disabled' : 'enabled',
    weekly_reports: tier === 'pro' ? 'enabled' : 'disabled',
    attendance_analytics: tier === 'basic' ? 'disabled' : 'enabled',
    advanced_analytics: tier === 'pro' ? 'enabled' : 'disabled',
    fee_tracking: tier === 'basic' ? 'configurable' : 'enabled',
    custom_alerts: tier === 'basic' ? 'disabled' : 'enabled',
    quiz_result_notifications: tier === 'basic' ? 'disabled' : tier === 'advance' ? 'configurable' : 'disabled',
  };
}
function createFeaturePermissionMap(state: PermissionState = 'disabled'): FeaturePermissionMap {
  return Object.fromEntries(FEATURE_PERMISSION_CATALOG.map((feature) => [feature.key, state])) as FeaturePermissionMap;
}
function normalizeFeaturePermissionMap(value: unknown): FeaturePermissionMap {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(FEATURE_PERMISSION_CATALOG.map((feature) => {
    const current = source[feature.key];
    const normalized = current === true ? 'enabled' : current === false ? 'disabled' : current;
    return [feature.key, normalized === 'enabled' || normalized === 'disabled' || normalized === 'configurable' ? normalized : 'disabled'];
  })) as FeaturePermissionMap;
}

type Plan = {
  id: string; name: string; description: string;
  amountPaisa: number; pricingMode: 'per_student' | 'lump_sum';
  perStudentAmountPaisa?: number; lumpSumAmountPaisa?: number;
  parentPlanId?: string | null; extraFeatures?: string[];
  featureVisibilityMode?: 'hide' | 'locked'; features: string[];
  featurePermissions: FeaturePermissionMap; active: boolean; deleted: boolean;
  announcementQuotaPerClass?: number; announcementExtraPackSize?: number; announcementExtraPackPricePaisa?: number;
};
function getPlanPerStudentAmount(plan: Plan): number {
  return plan.perStudentAmountPaisa ?? (plan.pricingMode === 'per_student' ? plan.amountPaisa : 0);
}
function getPlanLumpSumAmount(plan: Plan): number {
  return plan.lumpSumAmountPaisa ?? (plan.pricingMode === 'lump_sum' ? plan.amountPaisa : 0);
}
function getAutoInvoiceAddOnIds(teacher: Teacher, plan?: Plan, catalog?: AddOnCatalogItem[]): string[] {
  const permissions = teacher.accessMode === 'postpaid_monthly'
    ? teacher.postpaidPlanSnapshot?.featurePermissions ?? {}
    : plan?.featurePermissions ?? teacher.featurePermissions ?? {};
  const activeCatalogIds = catalog
    ? new Set(catalog.filter((item) => item.active && !item.deleted).map((item) => item.id))
    : null;
  return (teacher.activeAddOns ?? [])
    .filter((addon) => {
      const featureKey = addon.featureKey || addon.featureKeys?.[0] || '';
      const permission = featureKey ? (permissions as Record<string, unknown>)[featureKey] : undefined;
      return (!featureKey || (permission !== 'enabled' && permission !== true)) &&
        Boolean(addon.catalogId) && (!activeCatalogIds || activeCatalogIds.has(addon.catalogId!));
    })
    .map((addon) => addon.catalogId)
    .filter((id): id is string => Boolean(id));
}
function getPlanAncestors(plan: Plan, allPlans: Plan[]): Plan[] {
  const ancestors: Plan[] = [];
  const visited = new Set<string>([plan.id]);
  let parentId = plan.parentPlanId || null;
  while (parentId && ancestors.length < 20 && !visited.has(parentId)) {
    const parent = allPlans.find((candidate) => candidate.id === parentId && !candidate.deleted);
    if (!parent) break;
    ancestors.push(parent);
    visited.add(parent.id);
    parentId = parent.parentPlanId || null;
  }
  return ancestors;
}
type Offer = { id: string; name: string; description: string; discountType: 'percentage' | 'fixed'; discountValue: number; validFrom: string; validUntil: string; planIds: string[]; active: boolean };
type Teacher = { uid: string; email: string; name: string; active: boolean; planId?: string | null; planName?: string | null; pricingMode?: 'per_student' | 'lump_sum'; planPricePaisa?: number; featurePermissions?: FeaturePermissionMap; subscriptionStatus?: string; subscriptionStartedAt?: string | null; subscriptionExpiresAt?: string | null; subscriptionPeriodId?: string | null; accessMode?: string; featureVisibilityMode?: 'hide' | 'locked'; postpaidPlanId?: string | null; postpaidPlanName?: string | null; postpaidPlanSnapshot?: { id?: string; name?: string; description?: string; amountPaisa?: number; pricingMode?: 'per_student' | 'lump_sum'; perStudentAmountPaisa?: number; lumpSumAmountPaisa?: number; featurePermissions?: FeaturePermissionMap; featureVisibilityMode?: 'hide' | 'locked'; features?: string[] } | null; postpaidUsageBillingPeriod?: string | null; postpaidUsageStartedAt?: string | null; postpaidUsageExpiresAt?: string | null; postpaidInvoiceId?: string | null; postpaidInvoiceStatus?: string | null; activeAddOns?: Array<{ id: string; catalogId?: string | null; name: string; description?: string; featureKey?: string; featureKeys: string[]; monthlyPricePaisa?: number; expiresAt: string | null }>; pendingAddOnRequests?: Array<{ id: string; featureKey: string; featureName: string; requestedAt: string | null }> };
type AddOnRequest = { id: string; featureKey: string; featureName: string; requestedAt: string | null; teacherUid: string; teacherEmail: string; teacherName: string };
type Invoice = { id: string; invoiceNumber: string; teacherUid: string; teacherEmail: string; teacherName: string; billingPeriod: string; planSnapshot: { name?: string; pricingMode?: 'per_student' | 'lump_sum'; billableStudentCount?: number; featurePermissions?: FeaturePermissionMap } | null; addOnSnapshots?: Array<{ catalogId: string; name: string; featureKey: string; monthlyPricePaisa: number }>; charges: Array<{ description: string; amountPaisa: number }>; subtotalPaisa: number; discountPaisa: number; totalPaisa: number; status: string; paymentStatus: string; dueDate: string; createdAt: string | null };
type AddOnCatalogItem = { id: string; name: string; description: string; featureKey: FeaturePermissionKey; monthlyPricePaisa: number; billingPeriod: 'monthly'; active: boolean; deleted: boolean };
type SubscriptionAuditLog = { id: string; action: string; teacherUid: string; teacherEmail: string; teacherName: string; adminEmail: string; reason: string; paymentBypassed: boolean; createdAt: string | null; previous: Record<string, unknown> | null; next: Record<string, unknown> | null };
type PaymentRecord = { id: string; invoiceId: string; invoiceNumber: string; teacherUid: string; teacherEmail: string; teacherName: string; billingPeriod: string; amountPaisa: number; currency: 'PKR'; method: string; paymentReference: string | null; status: string; approvedAt: string | null };
type BulkInvoiceResultItem = { teacherUid: string | null; teacherEmail: string | null; teacherName: string; planName?: string | null; billingPeriod?: string; invoiceNumber?: string; totalPaisa?: number; status: 'created' | 'skipped' | 'failed'; reason?: string; offerApplied?: boolean; offerNotApplied?: boolean; addOnsIncluded?: number };
type BulkInvoiceResult = { success: boolean; billingPeriod: string; managedCustomers: number; eligibleCustomers: number; createdCount: number; skippedCount: number; failedCount: number; offerNotAppliedCount: number; results: BulkInvoiceResultItem[] };
type Snapshot = { success: boolean; teachers: Teacher[]; addOnRequests: AddOnRequest[]; plans: Plan[]; offers: Offer[]; addOnCatalog: AddOnCatalogItem[]; invoices: Invoice[]; payments: PaymentRecord[]; auditLogs: SubscriptionAuditLog[]; summary: { teachers: number; activePlans: number; activeOffers: number; unpaidInvoices: number; outstandingPaisa: number } };
type PaymentReview = { receiptId: string; invoiceId: string; invoiceNumber: string; teacherUid: string; teacherEmail: string; teacherName: string; billingPeriod: string; planName: string; totalPaisa: number; currency: 'PKR'; paymentReference: string; submittedAt: string | null };
type ReviewSnapshot = { success: boolean; reviews: PaymentReview[]; pendingCount: number };
type ApiError = { error?: string };

const money = (paisa: number) => new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 2 }).format((paisa || 0) / 100);
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const currentMonth = () => localDate().slice(0, 7);
const inputClass = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-orange-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';
const cardClass = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-[#0c1222]';

async function requestApi<T>(user: User, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<T> {
  const token = await user.getIdToken();
  const response = await fetch('/api/admin/subscriptions', {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload === 'object' && payload !== null && 'error' in payload && typeof (payload as ApiError).error === 'string' ? (payload as ApiError).error! : `Subscription API failed (${response.status}).`);
  return payload as T;
}

export default function Subscriptions({ adminUser, localDark }: Props) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [paymentInstructions, setPaymentInstructions] = useState('');
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodDraft[]>([]);
  const [allowUnassignedFullAccess, setAllowUnassignedFullAccess] = useState(true);
  const [defaultFeatureVisibilityMode, setDefaultFeatureVisibilityMode] = useState<'hide' | 'locked'>('hide');
  const [loadingPaymentInstructions, setLoadingPaymentInstructions] = useState(true);
  const [savingPaymentInstructions, setSavingPaymentInstructions] = useState(false);
  const [tab, setTab] = useState<'customers' | 'invoices' | 'plans' | 'offers' | 'paymentReview' | 'payments' | 'addOns'>('customers');
  const [reviews, setReviews] = useState<PaymentReview[]>([]);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewSearch, setReviewSearch] = useState('');
  const [reviewBillingPeriod, setReviewBillingPeriod] = useState('all');
  const [reviewDateFrom, setReviewDateFrom] = useState('');
  const [reviewDateTo, setReviewDateTo] = useState('');
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewPageSize, setReviewPageSize] = useState(10);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [addOnTeacherUid, setAddOnTeacherUid] = useState('');
  const [activeAddOnSearch, setActiveAddOnSearch] = useState('');
  const [activeAddOnCustomer, setActiveAddOnCustomer] = useState('all');
  const [activeAddOnFeature, setActiveAddOnFeature] = useState('all');
  const [activeAddOnExpiry, setActiveAddOnExpiry] = useState('all');
  const [activeAddOnPage, setActiveAddOnPage] = useState(1);
  const [activeAddOnPageSize, setActiveAddOnPageSize] = useState(10);
  const [addOnFeatureKey, setAddOnFeatureKey] = useState<FeaturePermissionKey>('fee_alerts');
  const [preview, setPreview] = useState<{ receiptId: string; url: string; label: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

  const [planName, setPlanName] = useState('');
  const [planDescription, setPlanDescription] = useState('');
  const [planPerStudentPrice, setPlanPerStudentPrice] = useState('');
  const [planLumpSumPrice, setPlanLumpSumPrice] = useState('');
  const [planParentId, setPlanParentId] = useState('');
  const [planFeatures, setPlanFeatures] = useState('');
  const [planExtraFeatures, setPlanExtraFeatures] = useState('');
  const [planFeaturePermissions, setPlanFeaturePermissions] = useState<FeaturePermissionMap>(createFeaturePermissionMap());
  const [planFeatureVisibilityMode, setPlanFeatureVisibilityMode] = useState<'hide' | 'locked'>('hide');
  const [planAnnouncementQuota, setPlanAnnouncementQuota] = useState('4');
  const [planAnnouncementPackSize, setPlanAnnouncementPackSize] = useState('4');
  const [planAnnouncementPackPrice, setPlanAnnouncementPackPrice] = useState('0');
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);

  const [offerName, setOfferName] = useState('');
  const [offerDescription, setOfferDescription] = useState('');
  const [offerType, setOfferType] = useState<'percentage' | 'fixed'>('percentage');
  const [offerValue, setOfferValue] = useState('');
  const [offerFrom, setOfferFrom] = useState(localDate());
  const [offerUntil, setOfferUntil] = useState(localDate(new Date(Date.now() + 30 * 86400000)));
  const [offerPlanIds, setOfferPlanIds] = useState<string[]>([]);
  const [editingOfferId, setEditingOfferId] = useState<string | null>(null);

  const [teacherUid, setTeacherUid] = useState('');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [invoiceMode, setInvoiceMode] = useState<'single' | 'bulk'>('single');
  const [bulkInvoiceResult, setBulkInvoiceResult] = useState<BulkInvoiceResult | null>(null);
  const [billingPeriod, setBillingPeriod] = useState(currentMonth());
  const [planId, setPlanId] = useState('');
  const [invoicePricingMode, setInvoicePricingMode] = useState<'per_student' | 'lump_sum'>('per_student');
  const [offerId, setOfferId] = useState('');
  const [dueDate, setDueDate] = useState(localDate(new Date(Date.now() + 7 * 86400000)));
  const [notes, setNotes] = useState('');
  const [charges, setCharges] = useState<Array<{ description: string; amount: string }>>([{ description: '', amount: '' }]);
  const [selectedAddOnCatalogIds, setSelectedAddOnCatalogIds] = useState<string[]>([]);

  // Subscription invoice table: search, filters and pagination.
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState('all');
  const [invoicePaymentStatusFilter, setInvoicePaymentStatusFilter] = useState('all');
  const [invoiceBillingPeriodFilter, setInvoiceBillingPeriodFilter] = useState('all');
  const [invoicePage, setInvoicePage] = useState(1);
  const [invoicePageSize, setInvoicePageSize] = useState(10);

  const [customerManageUid, setCustomerManageUid] = useState('');
  const [customerOperation, setCustomerOperation] = useState<'assign' | 'change' | 'extend' | 'suspend' | 'reactivate' | 'cancel'>('assign');
  const [customerPlanId, setCustomerPlanId] = useState('');
  const [customerStartsAt, setCustomerStartsAt] = useState(localDate());
  const [customerExpiresAt, setCustomerExpiresAt] = useState(localDate(new Date(Date.now() + 30 * 86400000)));
  const [customerReason, setCustomerReason] = useState('');
  const [customerAdminConfirmed, setCustomerAdminConfirmed] = useState(false);

  const [addOnName, setAddOnName] = useState('');
  const [addOnDescription, setAddOnDescription] = useState('');
  const [addOnCatalogFeatureKey, setAddOnCatalogFeatureKey] = useState<FeaturePermissionKey>('fee_alerts');
  const [addOnMonthlyPrice, setAddOnMonthlyPrice] = useState('');
  const [editingAddOnCatalogId, setEditingAddOnCatalogId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await requestApi<Snapshot>(adminUser, 'GET');
      setData(result);
      if (!teacherUid && result.teachers.length) {
        const firstTeacher = result.teachers[0];
        setTeacherUid(firstTeacher.uid);
        setTeacherSearch(firstTeacher.email);
        const savedPlanId = firstTeacher.postpaidPlanId || firstTeacher.planId || '';
        setPlanId(savedPlanId);
        if (firstTeacher.postpaidUsageBillingPeriod) setBillingPeriod(firstTeacher.postpaidUsageBillingPeriod);
        const firstPlan = result.plans.find((plan) => plan.id === savedPlanId);
        const savedPricingMode = firstTeacher.pricingMode || firstTeacher.postpaidPlanSnapshot?.pricingMode || firstPlan?.pricingMode;
        if (savedPricingMode === 'per_student' || savedPricingMode === 'lump_sum') setInvoicePricingMode(savedPricingMode);
        setSelectedAddOnCatalogIds(getAutoInvoiceAddOnIds(firstTeacher, firstPlan, result.addOnCatalog));
      }
      if (!customerManageUid && result.teachers.length) setCustomerManageUid(result.teachers[0].uid);
      if (!addOnTeacherUid && result.teachers.length) setAddOnTeacherUid(result.teachers[0].uid);
      if (!planId && result.plans.some((plan) => plan.active)) setPlanId(result.plans.find((plan) => plan.active)!.id);
      if (!customerPlanId && result.plans.some((plan) => plan.active)) setCustomerPlanId(result.plans.find((plan) => plan.active)!.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load subscription management.');
    } finally {
      setLoading(false);
    }
  }, [adminUser, teacherUid, planId, addOnTeacherUid, customerManageUid, customerPlanId]);

  useEffect(() => { void load(); }, [load]);

  const loadReviews = useCallback(async () => {
    setReviewLoading(true);
    try {
      const token = await adminUser.getIdToken();
      const response = await fetch('/api/admin/subscription-reviews', { method: 'GET', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok || !payload || typeof payload !== 'object' || !('reviews' in payload) || !Array.isArray((payload as { reviews?: unknown }).reviews)) {
        throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof (payload as ApiError).error === 'string' ? (payload as ApiError).error! : `Payment review request failed (${response.status}).`);
      }
      setReviews((payload as ReviewSnapshot).reviews);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load pending payment proofs.');
    } finally { setReviewLoading(false); }
  }, [adminUser]);

  useEffect(() => { void loadReviews(); }, [loadReviews]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const loadPaymentInstructions = useCallback(async () => {
    setLoadingPaymentInstructions(true);
    try {
      const token = await adminUser.getIdToken();
      const response = await fetch('/api/admin/subscription-settings', { method: 'GET', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok || !payload || typeof payload !== 'object' || !('paymentInstructions' in payload)) throw new Error('Could not load payment instructions.');
      const settings = payload as { paymentInstructions?: unknown; paymentMethods?: unknown; allowUnassignedFullAccess?: unknown; defaultFeatureVisibilityMode?: unknown };
      const value = typeof settings.paymentInstructions === 'string' ? settings.paymentInstructions : '';
      const savedMethods = readPaymentMethodDrafts(settings.paymentMethods);
      const legacy = savedMethods.length ? null : migrateLegacyPaymentInstructions(value);
      setPaymentInstructions(legacy ? legacy.instructions : value);
      setPaymentMethods(savedMethods.length ? savedMethods : (legacy?.method ? [legacy.method] : []));
      setAllowUnassignedFullAccess(settings.allowUnassignedFullAccess !== false);
      setDefaultFeatureVisibilityMode(settings.defaultFeatureVisibilityMode === 'locked' ? 'locked' : 'hide');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load payment instructions.');
    } finally { setLoadingPaymentInstructions(false); }
  }, [adminUser]);

  useEffect(() => { void loadPaymentInstructions(); }, [loadPaymentInstructions]);

  const savePaymentInstructions = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingPaymentInstructions(true); setError(''); setNotice('');
    try {
      const token = await adminUser.getIdToken();
      const response = await fetch('/api/admin/subscription-settings', {
        method: 'PUT', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentInstructions, paymentMethods, allowUnassignedFullAccess, defaultFeatureVisibilityMode }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : `Save failed (${response.status}).`);
      setNotice('Subscription registration and payment settings saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save payment instructions.');
    } finally { setSavingPaymentInstructions(false); }
  };

  const activePlans = useMemo(() => (data?.plans ?? []).filter((plan) => plan.active), [data]);
  const selectedInvoiceTeacher = data?.teachers.find((teacher) => teacher.uid === teacherUid);
  const savedPostpaidPlan = selectedInvoiceTeacher?.accessMode === 'postpaid_monthly' ? selectedInvoiceTeacher.postpaidPlanSnapshot : null;
  const postpaidPlanFallback: Plan | undefined = savedPostpaidPlan && selectedInvoiceTeacher?.postpaidPlanId ? {
    id: selectedInvoiceTeacher.postpaidPlanId,
    name: savedPostpaidPlan.name || selectedInvoiceTeacher.postpaidPlanName || 'Saved plan',
    description: savedPostpaidPlan.description || 'Plan snapshot saved at teacher registration',
    amountPaisa: Number(savedPostpaidPlan.amountPaisa) || 0,
    pricingMode: savedPostpaidPlan.pricingMode === 'per_student' ? 'per_student' : 'lump_sum',
    perStudentAmountPaisa: Number(savedPostpaidPlan.perStudentAmountPaisa) || 0,
    lumpSumAmountPaisa: Number(savedPostpaidPlan.lumpSumAmountPaisa) || 0,
    parentPlanId: null, extraFeatures: [], featureVisibilityMode: savedPostpaidPlan.featureVisibilityMode === 'locked' ? 'locked' : 'hide',
    features: Array.isArray(savedPostpaidPlan.features) ? savedPostpaidPlan.features : [],
    featurePermissions: normalizeFeaturePermissionMap(savedPostpaidPlan.featurePermissions), active: true, deleted: false,
  } : undefined;
  const selectedInvoicePlan = activePlans.find((plan) => plan.id === planId) || (postpaidPlanFallback?.id === planId ? postpaidPlanFallback : undefined);
  const invoicePlanIsSaved = Boolean(selectedInvoiceTeacher?.postpaidPlanId || selectedInvoiceTeacher?.planId);
  const postpaidInvoiceBlocked = Boolean(selectedInvoiceTeacher?.accessMode === 'postpaid_monthly' && (
    !selectedInvoiceTeacher.postpaidUsageExpiresAt || new Date(selectedInvoiceTeacher.postpaidUsageExpiresAt).getTime() > Date.now() ||
    ['unpaid', 'payment_pending', 'pending_review'].includes((selectedInvoiceTeacher.postpaidInvoiceStatus || '').toLowerCase())
  ));
  const activeOffers = useMemo(() => {
    const today = localDate();
    return (data?.offers ?? []).filter((offer) => offer.active && offer.validFrom <= today && offer.validUntil >= today &&
      (!offer.planIds?.length || (Boolean(planId) && offer.planIds.includes(planId))));
  }, [data, planId]);
  const bulkOffers = useMemo(() => {
    const today = localDate();
    return (data?.offers ?? []).filter((offer) => offer.active && offer.validFrom <= today && offer.validUntil >= today);
  }, [data]);
  const teachersWithPlans = useMemo(() => (data?.teachers ?? []).filter((teacher) => Boolean(teacher.postpaidPlanId || teacher.planId)), [data]);
  const selectedManagedTeacher = data?.teachers.find((teacher) => teacher.uid === customerManageUid);
  const activeAddOnCatalog = useMemo(() => (data?.addOnCatalog ?? []).filter((item) => item.active && !item.deleted), [data]);

  // Active customer add-ons are derived from the existing subscription snapshot.
  const activeCustomerAddOns = useMemo(
    () => (data?.teachers ?? []).flatMap((teacher) =>
      (teacher.activeAddOns ?? []).map((addon) => ({ ...addon, teacher }))
    ),
    [data?.teachers]
  );

  const activeAddOnCustomerOptions = useMemo(
    () => Array.from(new Map(
      activeCustomerAddOns.map((item) => [
        item.teacher.uid,
        { uid: item.teacher.uid, name: item.teacher.name, email: item.teacher.email }
      ])
    ).values()).sort((a, b) => a.name.localeCompare(b.name)),
    [activeCustomerAddOns]
  );

  const activeAddOnFeatureOptions = useMemo(
    () => Array.from(new Set(activeCustomerAddOns.flatMap((item) => item.featureKeys))).sort(),
    [activeCustomerAddOns]
  );

  const filteredActiveAddOns = useMemo(() => {
    const query = activeAddOnSearch.trim().toLowerCase();

    return activeCustomerAddOns.filter((item) => {
      const matchesSearch = !query || [
        item.name,
        item.teacher.name,
        item.teacher.email,
        ...item.featureKeys,
      ].some((value) => (value ?? '').toLowerCase().includes(query));

      const matchesCustomer =
        activeAddOnCustomer === 'all' || item.teacher.uid === activeAddOnCustomer;

      const matchesFeature =
        activeAddOnFeature === 'all' || item.featureKeys.includes(activeAddOnFeature);

      const expiryDate = item.expiresAt ? item.expiresAt.slice(0, 10) : '';

      const matchesExpiry =
        activeAddOnExpiry === 'all' ||
        (activeAddOnExpiry === 'dated' && expiryDate !== '') ||
        (activeAddOnExpiry === 'undated' && expiryDate === '');

      return matchesSearch && matchesCustomer && matchesFeature && matchesExpiry;
    });
  }, [
    activeCustomerAddOns,
    activeAddOnSearch,
    activeAddOnCustomer,
    activeAddOnFeature,
    activeAddOnExpiry,
  ]);

  const activeAddOnTotalPages = Math.max(
    1,
    Math.ceil(filteredActiveAddOns.length / activeAddOnPageSize)
  );

  const safeActiveAddOnPage = Math.min(activeAddOnPage, activeAddOnTotalPages);

  const paginatedActiveAddOns = useMemo(() => {
    const start = (safeActiveAddOnPage - 1) * activeAddOnPageSize;
    return filteredActiveAddOns.slice(start, start + activeAddOnPageSize);
  }, [filteredActiveAddOns, safeActiveAddOnPage, activeAddOnPageSize]);

  const activeAddOnRangeStart = filteredActiveAddOns.length
    ? (safeActiveAddOnPage - 1) * activeAddOnPageSize + 1
    : 0;

  const activeAddOnRangeEnd = Math.min(
    safeActiveAddOnPage * activeAddOnPageSize,
    filteredActiveAddOns.length
  );

  // Available filter values are derived from the existing invoice records.
  const invoiceStatusOptions = useMemo(
    () => Array.from(new Set((data?.invoices ?? []).map((invoice) => invoice.status).filter(Boolean))).sort(),
    [data?.invoices]
  );

  const invoicePaymentStatusOptions = useMemo(
    () => Array.from(new Set((data?.invoices ?? []).map((invoice) => invoice.paymentStatus).filter(Boolean))).sort(),
    [data?.invoices]
  );

  const invoiceBillingPeriodOptions = useMemo(
    () => Array.from(new Set((data?.invoices ?? []).map((invoice) => invoice.billingPeriod).filter(Boolean))).sort().reverse(),
    [data?.invoices]
  );

  const filteredInvoices = useMemo(() => {
    const query = invoiceSearch.trim().toLowerCase();

    return (data?.invoices ?? []).filter((invoice) => {
      const matchesSearch = !query || [
        invoice.invoiceNumber,
        invoice.teacherName,
        invoice.teacherEmail,
      ].some((value) => (value ?? '').toLowerCase().includes(query));

      const matchesInvoiceStatus =
        invoiceStatusFilter === 'all' || invoice.status === invoiceStatusFilter;

      const matchesPaymentStatus =
        invoicePaymentStatusFilter === 'all' || invoice.paymentStatus === invoicePaymentStatusFilter;

      const matchesBillingPeriod =
        invoiceBillingPeriodFilter === 'all' || invoice.billingPeriod === invoiceBillingPeriodFilter;

      return matchesSearch &&
        matchesInvoiceStatus &&
        matchesPaymentStatus &&
        matchesBillingPeriod;
    });
  }, [
    data?.invoices,
    invoiceSearch,
    invoiceStatusFilter,
    invoicePaymentStatusFilter,
    invoiceBillingPeriodFilter,
  ]);

  const invoiceTotalPages = Math.max(1, Math.ceil(filteredInvoices.length / invoicePageSize));
  const safeInvoicePage = Math.min(invoicePage, invoiceTotalPages);

  const paginatedInvoices = useMemo(() => {
    const start = (safeInvoicePage - 1) * invoicePageSize;
    return filteredInvoices.slice(start, start + invoicePageSize);
  }, [filteredInvoices, safeInvoicePage, invoicePageSize]);

  const invoiceRangeStart = filteredInvoices.length
    ? (safeInvoicePage - 1) * invoicePageSize + 1
    : 0;

  const invoiceRangeEnd = Math.min(
    safeInvoicePage * invoicePageSize,
    filteredInvoices.length
  );

  const reviewBillingPeriodOptions = useMemo(
    () => Array.from(new Set(reviews.map((review) => review.billingPeriod).filter(Boolean))).sort().reverse(),
    [reviews]
  );

  const filteredReviews = useMemo(() => {
    const query = reviewSearch.trim().toLowerCase();

    return reviews.filter((review) => {
      const matchesSearch = !query || [
        review.invoiceNumber,
        review.teacherName,
        review.teacherEmail,
        review.paymentReference,
      ].some((value) => (value ?? '').toLowerCase().includes(query));

      const matchesBillingPeriod =
        reviewBillingPeriod === 'all' || review.billingPeriod === reviewBillingPeriod;

      const submittedDate = review.submittedAt ? review.submittedAt.slice(0, 10) : '';
      const matchesDateFrom = !reviewDateFrom || (submittedDate !== '' && submittedDate >= reviewDateFrom);
      const matchesDateTo = !reviewDateTo || (submittedDate !== '' && submittedDate <= reviewDateTo);

      return matchesSearch && matchesBillingPeriod && matchesDateFrom && matchesDateTo;
    });
  }, [reviews, reviewSearch, reviewBillingPeriod, reviewDateFrom, reviewDateTo]);

  const reviewTotalPages = Math.max(1, Math.ceil(filteredReviews.length / reviewPageSize));
  const safeReviewPage = Math.min(reviewPage, reviewTotalPages);

  const paginatedReviews = useMemo(() => {
    const start = (safeReviewPage - 1) * reviewPageSize;
    return filteredReviews.slice(start, start + reviewPageSize);
  }, [filteredReviews, safeReviewPage, reviewPageSize]);

  const reviewRangeStart = filteredReviews.length
    ? (safeReviewPage - 1) * reviewPageSize + 1
    : 0;

  const reviewRangeEnd = Math.min(
    safeReviewPage * reviewPageSize,
    filteredReviews.length
  );

  const openReceiptPreview = async (review: PaymentReview) => {
    setPreviewLoading(review.receiptId); setError('');
    try {
      const token = await adminUser.getIdToken();
      const response = await fetch(`/api/admin/subscription-receipt?receiptId=${encodeURIComponent(review.receiptId)}`, { method: 'GET', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => ({}));
        throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof (payload as ApiError).error === 'string' ? (payload as ApiError).error! : `Receipt preview failed (${response.status}).`);
      }
      const blob = await response.blob();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('The server returned an unsupported receipt image.');
      const url = URL.createObjectURL(blob);
      setPreview({ receiptId: review.receiptId, url, label: `${review.invoiceNumber} · ${review.teacherName}` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the private payment screenshot.');
    } finally { setPreviewLoading(null); }
  };

  const reviewPayment = async (review: PaymentReview, action: 'approve' | 'reject') => {
    setReviewBusy(review.receiptId); setError(''); setNotice('');
    try {
      const token = await adminUser.getIdToken();
      const response = await fetch('/api/admin/subscription-reviews', {
        method: 'POST', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, receiptId: review.receiptId, reviewNote: reviewNotes[review.receiptId] || '' }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof (payload as ApiError).error === 'string' ? (payload as ApiError).error! : `Payment review failed (${response.status}).`);
      setNotice(action === 'approve'
        ? `Payment approved for ${review.invoiceNumber}. The subscription period is now recorded from the invoice month.`
        : `Payment proof rejected for ${review.invoiceNumber}. The teacher can submit a new screenshot.`);
      if (preview?.receiptId === review.receiptId) setPreview(null);
      await Promise.all([load(), loadReviews()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The payment review action failed.');
    } finally { setReviewBusy(null); }
  };

  const runAction = async (body: Record<string, unknown>, success: string): Promise<boolean> => {
    setBusy(true); setError(''); setNotice('');
    try {
      await requestApi(adminUser, 'POST', body);
      setNotice(success);
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The subscription action failed.');
      return false;
    } finally { setBusy(false); }
  };

  const selectInvoiceTeacher = (uid: string) => {
    const selectedTeacher = data?.teachers.find((item) => item.uid === uid);
    setTeacherUid(uid);
    setBulkInvoiceResult(null);
    if (!selectedTeacher) {
      setTeacherSearch('');
      setPlanId('');
      setSelectedAddOnCatalogIds([]);
      return;
    }

    setTeacherSearch(selectedTeacher.email);
    const savedId = selectedTeacher.postpaidPlanId || selectedTeacher.planId || '';
    setPlanId(savedId);
    if (selectedTeacher.postpaidUsageBillingPeriod) setBillingPeriod(selectedTeacher.postpaidUsageBillingPeriod);
    const availablePlan = activePlans.find((item) => item.id === savedId);
    const savedMode = selectedTeacher.pricingMode || selectedTeacher.postpaidPlanSnapshot?.pricingMode;
    const preferredMode = savedMode === 'per_student' || savedMode === 'lump_sum'
      ? savedMode
      : availablePlan?.pricingMode === 'per_student' ? 'per_student' : 'lump_sum';
    setInvoicePricingMode(preferredMode);
    setSelectedAddOnCatalogIds(getAutoInvoiceAddOnIds(selectedTeacher, availablePlan, data?.addOnCatalog));
    const selectedOffer = data?.offers.find((offer) => offer.id === offerId);
    if (selectedOffer?.planIds?.length && !selectedOffer.planIds.includes(savedId)) setOfferId('');
  };

  const submitBulkInvoices = async () => {
    if (!teachersWithPlans.length) {
      setError('There are no active customers with an assigned subscription plan.');
      return;
    }
    const selectedOffer = bulkOffers.find((offer) => offer.id === offerId);
    const offerText = selectedOffer ? ` The selected offer “${selectedOffer.name}” will be applied only to plans it supports.` : '';
    const confirmed = window.confirm(
      `Generate monthly subscription invoices for up to ${teachersWithPlans.length} customers? Each invoice will use that customer's saved plan, saved pricing option, verified student count (when per-student), and currently active paid monthly add-ons.${offerText} Customers with no plan, an unfinished postpaid month, an existing invoice, or invalid data will be skipped.`,
    );
    if (!confirmed) return;

    setBusy(true); setError(''); setNotice(''); setBulkInvoiceResult(null);
    try {
      const result = await requestApi<BulkInvoiceResult>(adminUser, 'POST', {
        action: 'bulkGenerateInvoices', billingPeriod, offerId: offerId || null, dueDate, notes,
      });
      setBulkInvoiceResult(result);
      setNotice(`Bulk invoice run complete: ${result.createdCount} created, ${result.skippedCount} skipped, ${result.failedCount} failed.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Bulk invoice generation failed.');
    } finally { setBusy(false); }
  };

  const resetPlanForm = () => {
    setEditingPlanId(null); setPlanName(''); setPlanDescription('');
    setPlanAnnouncementQuota('4'); setPlanAnnouncementPackSize('4'); setPlanAnnouncementPackPrice('0');
    setPlanPerStudentPrice(''); setPlanLumpSumPrice(''); setPlanParentId('');
    setPlanFeatures(''); setPlanExtraFeatures('');
    setPlanFeaturePermissions(createFeaturePermissionMap()); setPlanFeatureVisibilityMode('hide');
  };

  const startPlanEdit = (plan: Plan) => {
    setEditingPlanId(plan.id); setPlanName(plan.name); setPlanDescription(plan.description);
    const perStudent = getPlanPerStudentAmount(plan);
    const lumpSum = getPlanLumpSumAmount(plan);
    setPlanPerStudentPrice(perStudent > 0 ? String(perStudent / 100) : '');
    setPlanLumpSumPrice(lumpSum > 0 ? String(lumpSum / 100) : '');
    setPlanParentId(plan.parentPlanId || '');
    setPlanFeatures((plan.features || []).join('\n'));
    setPlanExtraFeatures((plan.extraFeatures || []).join('\n'));
    setPlanFeaturePermissions(normalizeFeaturePermissionMap(plan.featurePermissions));
    setPlanFeatureVisibilityMode(plan.featureVisibilityMode === 'locked' ? 'locked' : 'hide');
    setPlanAnnouncementQuota(String(plan.announcementQuotaPerClass ?? 4));
    setPlanAnnouncementPackSize(String(plan.announcementExtraPackSize ?? 4));
    setPlanAnnouncementPackPrice(String(((plan.announcementExtraPackPricePaisa ?? 0) / 100)));
    setTab('plans'); setError(''); setNotice('');
  };

  const submitPlan = async (event: FormEvent) => {
    event.preventDefault();
    const perStudentRupees = Number(planPerStudentPrice);
    const lumpSumRupees = Number(planLumpSumPrice);
    const announcementQuota = Number(planAnnouncementQuota);
    const announcementPackSize = Number(planAnnouncementPackSize);
    const announcementPackPrice = Number(planAnnouncementPackPrice);
    if (!Number.isInteger(announcementQuota) || announcementQuota < 4 || announcementQuota > 500) { setError('Set 4 to 500 announcements per class.'); return; }
    if (!Number.isInteger(announcementPackSize) || announcementPackSize < 1 || announcementPackSize > 100) { setError('Set an extra announcement pack size from 1 to 100.'); return; }
    if (!Number.isFinite(announcementPackPrice) || announcementPackPrice < 0 || announcementPackPrice > 10_000_000 || (announcementQuota > 4 && announcementPackPrice <= 0)) { setError('A positive extra-pack price is required when quota is greater than 4.'); return; }
    if (!planName.trim()) { setError('Enter a plan name.'); return; }
    if (!Number.isFinite(perStudentRupees) || perStudentRupees <= 0 || perStudentRupees > 10_000_000) {
      setError('Enter a valid Per Student monthly price greater than zero.'); return;
    }
    if (!Number.isFinite(lumpSumRupees) || lumpSumRupees <= 0 || lumpSumRupees > 10_000_000) {
      setError('Enter a valid Lump Sum monthly price greater than zero.'); return;
    }
    const action = editingPlanId ? 'updatePlan' : 'createPlan';
    const saved = await runAction({
      action,
      ...(editingPlanId ? { planId: editingPlanId } : {}),
      name: planName,
      description: planDescription,
      perStudentAmountPaisa: Math.round(perStudentRupees * 100),
      lumpSumAmountPaisa: Math.round(lumpSumRupees * 100),
      parentPlanId: planParentId || null,
      features: planFeatures.split('\n').map((item) => item.trim()).filter(Boolean),
      extraFeatures: planExtraFeatures.split('\n').map((item) => item.trim()).filter(Boolean),
      featurePermissions: planFeaturePermissions,
      featureVisibilityMode: planFeatureVisibilityMode,
      announcementQuotaPerClass: announcementQuota,
      announcementExtraPackSize: announcementPackSize,
      announcementExtraPackPricePaisa: Math.round(announcementPackPrice * 100),
    }, editingPlanId ? 'Subscription plan updated.' : 'Subscription plan created.');
    if (saved) resetPlanForm();
  };

  const archivePlan = async (plan: Plan) => {
    if (!window.confirm(`Archive ${plan.name}? Existing invoices will keep their saved plan details.`)) return;
    const archived = await runAction({ action: 'deletePlan', planId: plan.id }, 'Plan archived. Historical invoices remain unchanged.');
    if (archived && editingPlanId === plan.id) resetPlanForm();
  };

  const submitOffer = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(offerValue);
    if (!Number.isFinite(value) || value <= 0) { setError('Enter a valid discount value.'); return; }
    const saved = await runAction({
      action: editingOfferId ? 'updateOffer' : 'createOffer',
      ...(editingOfferId ? { offerId: editingOfferId } : {}),
      name: offerName,
      description: offerDescription,
      discountType: offerType,
      discountValue: offerType === 'fixed' ? Math.round(value * 100) : Math.round(value),
      validFrom: offerFrom,
      validUntil: offerUntil,
      planIds: offerPlanIds,
    }, editingOfferId ? 'Promotional offer updated.' : 'Promotional offer created.');
    if (saved) resetOfferForm();
  };

  const resetOfferForm = () => {
    setEditingOfferId(null); setOfferName(''); setOfferDescription(''); setOfferType('percentage');
    setOfferValue(''); setOfferFrom(localDate()); setOfferUntil(localDate(new Date(Date.now() + 30 * 86400000)));
    setOfferPlanIds([]);
  };

  const startOfferEdit = (offer: Offer) => {
    setEditingOfferId(offer.id);
    setOfferName(offer.name);
    setOfferDescription(offer.description);
    setOfferType(offer.discountType);
    setOfferValue(String(offer.discountType === 'fixed' ? offer.discountValue / 100 : offer.discountValue));
    setOfferFrom(offer.validFrom);
    setOfferUntil(offer.validUntil);
    setOfferPlanIds(offer.planIds ?? []);
    setTab('offers'); setError(''); setNotice('');
  };

  const submitCustomerSubscription = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!customerManageUid) { setError('Select a customer first.'); return; }
    if (customerReason.trim().length < 10) { setError('Enter a clear reason (at least 10 characters) for the administrator action.'); return; }
    if ((customerOperation === 'assign' || customerOperation === 'change') && !customerPlanId) { setError('Select a subscription plan.'); return; }
    const teacher = data?.teachers.find((item) => item.uid === customerManageUid);
    const warning = customerOperation === 'assign' || customerOperation === 'change'
      ? `This grants ${teacher?.name ?? 'the selected customer'} access to the chosen plan without a payment approval. Continue only for an approved administrator exception.`
      : `Confirm ${customerOperation} for ${teacher?.name ?? 'the selected customer'}?`;
    if (!window.confirm(warning)) return;
    const saved = await runAction({
      action: 'manageCustomerSubscription',
      teacherUid: customerManageUid,
      operation: customerOperation,
      ...(customerOperation === 'assign' || customerOperation === 'change' ? { planId: customerPlanId, startsAt: customerStartsAt, expiresAt: customerExpiresAt } : {}),
      ...(customerOperation === 'extend' ? { expiresAt: customerExpiresAt } : {}),
      reason: customerReason.trim(),
      adminConfirmed: customerAdminConfirmed,
    }, 'Customer subscription control updated. Entitlement projection refreshed.');
    if (saved) { setCustomerReason(''); setCustomerAdminConfirmed(false); }
  };

  const resetAddOnCatalogForm = () => {
    setEditingAddOnCatalogId(null); setAddOnName(''); setAddOnDescription('');
    setAddOnCatalogFeatureKey('fee_alerts'); setAddOnMonthlyPrice('');
  };

  const startAddOnCatalogEdit = (item: AddOnCatalogItem) => {
    setEditingAddOnCatalogId(item.id);
    setAddOnName(item.name);
    setAddOnDescription(item.description);
    setAddOnCatalogFeatureKey(item.featureKey);
    setAddOnMonthlyPrice(String(item.monthlyPricePaisa / 100));
    setTab('addOns');
  };

  const submitAddOnCatalog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const price = Number(addOnMonthlyPrice);
    if (!addOnName.trim() || !Number.isFinite(price) || price <= 0 || price > 10000000) {
      setError('Enter an add-on name and a valid monthly PKR price.'); return;
    }
    const saved = await runAction({
      action: editingAddOnCatalogId ? 'updateAddOnCatalogItem' : 'createAddOnCatalogItem',
      ...(editingAddOnCatalogId ? { addOnCatalogId: editingAddOnCatalogId } : {}),
      name: addOnName.trim(), description: addOnDescription,
      featureKey: addOnCatalogFeatureKey,
      monthlyPricePaisa: Math.round(price * 100),
    }, editingAddOnCatalogId ? 'Paid add-on catalog item updated.' : 'Paid add-on catalog item created.');
    if (saved) resetAddOnCatalogForm();
  };

  const toggleAddOnCatalog = (item: AddOnCatalogItem) => void runAction({ action: 'updateAddOnCatalogItem', addOnCatalogId: item.id, active: !item.active }, item.active ? 'Paid add-on disabled for new invoices.' : 'Paid add-on enabled for new invoices.');

  const archiveAddOnCatalog = (item: AddOnCatalogItem) => {
    if (!window.confirm(`Archive ${item.name}? Existing paid invoices and customer add-on grants will remain unchanged.`)) return;
    void runAction({ action: 'archiveAddOnCatalogItem', addOnCatalogId: item.id }, 'Paid add-on catalog item archived.');
  };

  const submitInvoice = async (event: FormEvent) => {
    event.preventDefault();
    if (!teacherUid) { setError('Select a teacher first.'); return; }
    const parsedCharges = charges.filter((item) => item.description.trim() || item.amount.trim()).map((item) => ({ description: item.description.trim(), amountPaisa: Math.round(Number(item.amount) * 100) }));
    if (parsedCharges.some((item) => !item.description || !Number.isSafeInteger(item.amountPaisa) || item.amountPaisa < 0)) { setError('Check each additional charge description and amount.'); return; }
    const created = await runAction({ action: 'generateInvoice', teacherUid, billingPeriod, planId: planId || null, pricingMode: invoicePricingMode, offerId: offerId || null, addOnCatalogIds: selectedAddOnCatalogIds, dueDate, notes, charges: parsedCharges }, 'Monthly subscription invoice generated. The teacher can see it in their Subscription page.');
    if (created) { setNotes(''); setOfferId(''); setCharges([{ description: '', amount: '' }]); }
  };

  const togglePlan = (plan: Plan) => void runAction({ action: 'updatePlan', planId: plan.id, active: !plan.active }, plan.active ? 'Plan disabled.' : 'Plan enabled/restored.');
  const toggleOffer = (offer: Offer) => void runAction({ action: 'updateOffer', offerId: offer.id, active: !offer.active }, `Offer ${offer.active ? 'disabled' : 'enabled'}.`);

  const surface = localDark ? 'text-slate-100' : 'text-slate-900';
  const muted = localDark ? 'text-slate-400' : 'text-slate-500';

  return <div className={`mx-auto max-w-7xl space-y-6 ${surface}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-500">Admin Subscriptions</p><h1 className="mt-1 text-2xl font-black">Subscriptions</h1><p className={`mt-1 text-sm ${muted}`}>Manage teacher plans, invoices, payment reviews and approved payments in one place.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold dark:border-slate-700"><RefreshCw size={15} className={loading ? 'animate-spin' : ''}/> Refresh</button>
    </div>

    {error && <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">{notice}</div>}

    <form onSubmit={savePaymentInstructions} className={`${cardClass} space-y-4`}>
      <div><h2 className="text-lg font-extrabold">Teacher payment instructions</h2><p className={`mt-1 text-xs ${muted}`}>Configure separate bank or wallet methods for teachers. Each saved method appears in its own card with copyable payment details. This remains a manual proof workflow; no payment gateway is integrated.</p></div>

      <section className="space-y-2 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
        <div><h3 className="text-sm font-extrabold">Additional payment instructions</h3><p className={`mt-1 text-xs ${muted}`}>General guidance shown below the payment method cards. Existing saved instructions are preserved here.</p></div>
        <textarea rows={4} maxLength={5000} value={paymentInstructions} onChange={(event) => setPaymentInstructions(event.target.value)} placeholder="After transferring, mention your academy name in the reference and submit the transaction receipt for administrator verification…" className={inputClass} />
        <p className={`text-right text-[11px] ${muted}`}>{paymentInstructions.length}/5000 characters</p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-extrabold">Payment methods</h3><p className={`mt-1 text-xs ${muted}`}>Add up to 8 methods. Account number, IBAN, mobile number or method instructions must be provided.</p></div><button type="button" disabled={paymentMethods.length >= 8 || loadingPaymentInstructions || savingPaymentInstructions} onClick={() => setPaymentMethods((current) => [...current, createPaymentMethodDraft()])} className="inline-flex items-center gap-2 rounded-xl border border-orange-300 px-3 py-2 text-xs font-extrabold text-orange-700 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-900 dark:text-orange-300 dark:hover:bg-orange-950/30"><Plus size={14}/> Add payment method</button></div>
        {!paymentMethods.length ? <div className={`rounded-2xl border border-dashed border-slate-300 p-5 text-center text-sm ${muted} dark:border-slate-700`}>No separate payment methods yet. Add a bank account, mobile wallet or another payment option.</div> : paymentMethods.map((method, index) => <article key={method.id} className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-extrabold">Payment method {index + 1}</p><p className={`text-[11px] ${muted}`}>Displayed as an independent payment card to teachers</p></div><button type="button" onClick={() => setPaymentMethods((current) => current.filter((item) => item.id !== method.id))} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300"><Trash2 size={13}/> Remove</button></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-bold">Method title<input required maxLength={80} value={method.name} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, name: event.target.value } : item))} placeholder="e.g. MCB Bank Transfer" className={inputClass}/></label>
            <label className="block text-xs font-bold">Method type<select value={method.type} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, type: event.target.value as PaymentMethodDraft['type'] } : item))} className={inputClass}><option value="bank">Bank transfer</option><option value="mobile_wallet">Mobile wallet</option><option value="other">Other payment method</option></select></label>
            <label className="block text-xs font-bold">Bank / Wallet provider<input maxLength={100} value={method.providerName} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, providerName: event.target.value } : item))} placeholder="e.g. MCB Bank Limited / Easypaisa" className={inputClass}/></label>
            <label className="block text-xs font-bold">Account title<input maxLength={120} value={method.accountTitle} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, accountTitle: event.target.value } : item))} placeholder="Name on the account" className={inputClass}/></label>
            <label className="block text-xs font-bold">Account number<input maxLength={80} value={method.accountNumber} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, accountNumber: event.target.value } : item))} placeholder="Enter account number" className={inputClass}/></label>
            <label className="block text-xs font-bold">IBAN<input maxLength={60} value={method.iban} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, iban: event.target.value } : item))} placeholder="PK…" className={inputClass}/></label>
            <label className="block text-xs font-bold">Mobile / wallet number<input maxLength={40} value={method.mobileNumber} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, mobileNumber: event.target.value } : item))} placeholder="03XX XXXXXXX" className={inputClass}/></label>
            <label className="block text-xs font-bold">Branch / location<input maxLength={80} value={method.branch} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, branch: event.target.value } : item))} placeholder="Optional branch details" className={inputClass}/></label>
          </div>
          <label className="block text-xs font-bold">Method-specific instructions<textarea rows={2} maxLength={1000} value={method.instructions} onChange={(event) => setPaymentMethods((current) => current.map((item) => item.id === method.id ? { ...item, instructions: event.target.value } : item))} placeholder="Optional instructions for using this payment method" className={inputClass}/></label>
        </article>)}
      </section>

      <div className="grid gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allowUnassignedFullAccess} onChange={(event) => setAllowUnassignedFullAccess(event.target.checked)} className="mt-1 accent-orange-500" /><span><strong className="block">Allow unassigned full-access registration</strong><span className="text-xs text-amber-700 dark:text-amber-300">When enabled, anyone who explicitly skips plan selection receives full teacher-product access without paying. This is a deliberate public bypass of paid plans, not paid-plan security.</span></span></label>
        <label className="space-y-1 text-sm"><strong className="block">Default locked-feature visibility</strong><select value={defaultFeatureVisibilityMode} onChange={(event) => setDefaultFeatureVisibilityMode(event.target.value as 'hide' | 'locked')} className={inputClass}><option value="hide">Hide unavailable features</option><option value="locked">Show unavailable features as locked</option></select></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2"><span className={`text-xs ${muted}`}>{paymentMethods.length} payment method{paymentMethods.length === 1 ? '' : 's'} configured</span><button disabled={savingPaymentInstructions || loadingPaymentInstructions} className="rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{savingPaymentInstructions ? 'Saving…' : 'Save payment settings'}</button></div>
    </form>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[
        { label: 'Managed teachers', value: data?.summary.teachers ?? 0, icon: Users },
        { label: 'Active plans', value: data?.summary.activePlans ?? 0, icon: CreditCard },
        { label: 'Active offers', value: data?.summary.activeOffers ?? 0, icon: Gift },
        { label: 'Outstanding', value: money(data?.summary.outstandingPaisa ?? 0), icon: Receipt },
      ].map((item) => <div key={item.label} className={cardClass}><div className="flex items-center justify-between"><span className={`text-xs font-bold uppercase tracking-wide ${muted}`}>{item.label}</span><item.icon size={18} className="text-orange-500"/></div><p className="mt-3 text-2xl font-black tabular-nums">{item.value}</p></div>)}
    </div>

    <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3 dark:border-slate-800">
      {(['customers', 'invoices', 'plans', 'offers', 'paymentReview', 'payments', 'addOns'] as const).map((key) => <button key={key} type="button" onClick={() => setTab(key)} className={`rounded-xl px-4 py-2 text-sm font-bold capitalize ${tab === key ? 'bg-orange-500 text-white' : 'border border-slate-300 dark:border-slate-700'}`}>{key === 'customers' ? 'Customer subscriptions' : key === 'paymentReview' ? 'Payment review' : key === 'payments' ? 'Payment register' : key === 'addOns' ? 'Add-ons' : key}{key === 'paymentReview' && reviews.length > 0 ? <span className="ml-2 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] text-white">{reviews.length}</span> : null}{key === 'addOns' && (data?.addOnRequests?.length ?? 0) > 0 ? <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] text-white">{data?.addOnRequests.length}</span> : null}</button>)}
    </div>

    {tab === 'customers' && <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className={`${cardClass} space-y-3`}>
        <div><h2 className="text-lg font-extrabold">Customer subscription directory</h2><p className={`mt-1 text-xs ${muted}`}>Current plan, entitlement status and expiry for each managed teacher.</p></div>
        <label className="block text-sm font-semibold">Select customer<select value={customerManageUid} onChange={(event) => setCustomerManageUid(event.target.value)} className={inputClass}><option value="">Choose teacher</option>{(data?.teachers ?? []).map((teacher) => <option key={teacher.uid} value={teacher.uid}>{teacher.name} · {teacher.email}</option>)}</select></label>
        {selectedManagedTeacher ? <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong>{selectedManagedTeacher.name}</strong><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${selectedManagedTeacher.subscriptionStatus === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{(selectedManagedTeacher.subscriptionStatus || 'no_plan').replace(/_/g, ' ')}</span></div>
          <p className={`text-xs ${muted}`}>{selectedManagedTeacher.email}</p>
          <div className="grid grid-cols-2 gap-3 pt-2 text-sm"><div><p className={`text-xs ${muted}`}>Current plan</p><p className="font-bold">{selectedManagedTeacher.planName || 'No plan assigned'}</p></div><div><p className={`text-xs ${muted}`}>Access mode</p><p className="font-bold">{(selectedManagedTeacher.accessMode || 'unknown').replace(/_/g, ' ')}</p></div><div><p className={`text-xs ${muted}`}>Starts</p><p className="font-bold">{selectedManagedTeacher.subscriptionStartedAt ? new Date(selectedManagedTeacher.subscriptionStartedAt).toLocaleDateString('en-PK') : '—'}</p></div><div><p className={`text-xs ${muted}`}>Expires</p><p className="font-bold">{selectedManagedTeacher.subscriptionExpiresAt ? new Date(selectedManagedTeacher.subscriptionExpiresAt).toLocaleDateString('en-PK') : '—'}</p></div></div>
          <p className={`pt-2 text-xs ${muted}`}>Active add-ons: {selectedManagedTeacher.activeAddOns?.length ?? 0} · Pending requests: {selectedManagedTeacher.pendingAddOnRequests?.length ?? 0}</p>
        </div> : <p className={`rounded-xl border border-dashed border-slate-300 p-5 text-sm ${muted}`}>Select a teacher to inspect subscription access.</p>}
      </div>
      <form onSubmit={submitCustomerSubscription} className={`${cardClass} space-y-4`}>
        <div><h2 className="text-lg font-extrabold">Administrator subscription controls</h2><p className={`mt-1 text-xs ${muted}`}>Every manual action requires a reason and is written to the subscription audit log.</p></div>
        <label className="block text-sm font-semibold">Action<select value={customerOperation} onChange={(event) => setCustomerOperation(event.target.value as typeof customerOperation)} className={inputClass}>
          <option value="assign">Assign plan (manual access grant)</option><option value="change">Change plan (manual access grant)</option><option value="extend">Extend current subscription</option><option value="suspend">Suspend access immediately</option><option value="reactivate">Reactivate eligible subscription</option><option value="cancel">Cancel subscription</option>
        </select></label>
        {(customerOperation === 'assign' || customerOperation === 'change') && <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm font-semibold sm:col-span-3">New plan<select required value={customerPlanId} onChange={(event) => setCustomerPlanId(event.target.value)} className={inputClass}><option value="">Select active plan</option>{activePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · Student {money(getPlanPerStudentAmount(plan))} · Fixed {money(getPlanLumpSumAmount(plan))}</option>)}</select></label>
          <label className="block text-sm font-semibold">Access starts<input required type="date" value={customerStartsAt} onChange={(event) => setCustomerStartsAt(event.target.value)} className={inputClass}/></label>
          <label className="block text-sm font-semibold sm:col-span-2">Access through (inclusive)<input required type="date" min={customerStartsAt} value={customerExpiresAt} onChange={(event) => setCustomerExpiresAt(event.target.value)} className={inputClass}/></label>
          <p className={`sm:col-span-3 text-xs text-amber-700 dark:text-amber-300`}>This is an explicit administrator override and bypasses payment approval. Use only when the school has authorized a complimentary or manually granted subscription.</p>
        </div>}
        {customerOperation === 'extend' && <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700"><p className="text-sm">Current expiry: <strong>{selectedManagedTeacher?.subscriptionExpiresAt ? new Date(selectedManagedTeacher.subscriptionExpiresAt).toLocaleDateString('en-PK') : 'Not available'}</strong></p><label className="block text-sm font-semibold">New access through (inclusive)<input required type="date" value={customerExpiresAt} onChange={(event) => setCustomerExpiresAt(event.target.value)} className={inputClass}/></label><p className={`text-xs ${muted}`}>The new date must be later than the current active subscription expiry.</p></div>}
        <label className="block text-sm font-semibold">Administrator reason<textarea required minLength={10} maxLength={500} rows={3} value={customerReason} onChange={(event) => setCustomerReason(event.target.value)} placeholder="Explain why this manual subscription action is being made…" className={inputClass}/></label>
        <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><input type="checkbox" checked={customerAdminConfirmed} onChange={(event) => setCustomerAdminConfirmed(event.target.checked)} className="mt-0.5"/><span>I confirm this is an authorized administrator action. For assign/change, I understand that access is granted without payment approval and the reason will be recorded.</span></label>
        <button disabled={busy || loading || !customerManageUid || !customerAdminConfirmed} className="rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">Apply subscription action</button>
      </form>
      <div className={`${cardClass} xl:col-span-2`}>
        <div className="mb-3"><h2 className="text-lg font-extrabold">Recent subscription admin activity</h2><p className={`mt-1 text-xs ${muted}`}>Manual plan grants, plan changes, extensions, suspensions, reactivations and cancellations are recorded with the administrator and reason.</p></div>
        {!data?.auditLogs?.length ? <p className={`text-sm ${muted}`}>No administrator subscription override events have been recorded yet.</p> : <div className="space-y-2">{data.auditLogs.slice(0, 20).map((entry) => <article key={entry.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div className="flex flex-wrap items-start justify-between gap-2"><div><strong className="text-sm">{entry.action.replace(/_/g, ' ')}</strong><p className={`mt-1 text-xs ${muted}`}>{entry.teacherName || entry.teacherEmail} · Admin {entry.adminEmail || '—'}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${entry.paymentBypassed ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>{entry.paymentBypassed ? 'Payment bypass override' : 'Admin action'}</span></div><p className="mt-2 text-xs">{entry.reason}</p><p className={`mt-1 text-[11px] ${muted}`}>{entry.createdAt ? new Date(entry.createdAt).toLocaleString('en-PK') : 'Time unavailable'}</p></article>)}</div>}
      </div>
    </div>}

    {tab === 'addOns' && <div className="space-y-4">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <form onSubmit={submitAddOnCatalog} className={`${cardClass} space-y-3`}>
          <div><h2 className="text-lg font-extrabold">{editingAddOnCatalogId ? 'Edit paid add-on' : 'Paid add-on catalog'}</h2><p className={`mt-1 text-xs ${muted}`}>Configure a separate monthly price for one ERP feature. The add-on is activated only after its subscription invoice payment is approved.</p></div>
          <label className="block text-sm font-semibold">Add-on name<input required maxLength={100} value={addOnName} onChange={(event) => setAddOnName(event.target.value)} className={inputClass}/></label>
          <label className="block text-sm font-semibold">Description<textarea rows={2} maxLength={600} value={addOnDescription} onChange={(event) => setAddOnDescription(event.target.value)} className={inputClass}/></label>
          <label className="block text-sm font-semibold">ERP feature<select value={addOnCatalogFeatureKey} onChange={(event) => setAddOnCatalogFeatureKey(event.target.value as FeaturePermissionKey)} className={inputClass}>{FEATURE_PERMISSION_CATALOG.map((feature) => <option key={feature.key} value={feature.key}>{feature.label}</option>)}</select></label>
          <label className="block text-sm font-semibold">Monthly price (PKR)<input required min="0.01" step="0.01" type="number" value={addOnMonthlyPrice} onChange={(event) => setAddOnMonthlyPrice(event.target.value)} className={inputClass}/></label>
          <div className="flex flex-wrap gap-2"><button disabled={busy} className="rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{editingAddOnCatalogId ? 'Save add-on' : 'Create paid add-on'}</button>{editingAddOnCatalogId && <button type="button" disabled={busy} onClick={resetAddOnCatalogForm} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold dark:border-slate-700">Cancel edit</button>}</div>
        </form>
        <div className={`${cardClass} space-y-3`}>
          <div><h2 className="text-lg font-extrabold">Paid add-on products</h2><p className={`mt-1 text-xs ${muted}`}>Prices are saved as invoice snapshots. Changing a catalog price does not rewrite historical invoices.</p></div>
          {!data?.addOnCatalog?.length ? <p className={`rounded-xl border border-dashed border-slate-300 p-5 text-sm ${muted}`}>No paid add-ons have been configured.</p> : <div className="space-y-2">{data.addOnCatalog.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{item.name}</strong><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${item.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>{item.deleted ? 'Archived' : item.active ? 'Active' : 'Disabled'}</span></div><p className={`mt-1 text-xs ${muted}`}>{item.featureKey.replace(/_/g, ' ')} · {money(item.monthlyPricePaisa)} / month</p><p className={`text-xs ${muted}`}>{item.description}</p></div>
            <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || item.deleted} onClick={() => startAddOnCatalogEdit(item)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700">Edit</button><button type="button" disabled={busy || item.deleted} onClick={() => toggleAddOnCatalog(item)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700">{item.active ? 'Disable' : 'Enable'}</button>{!item.deleted && <button type="button" disabled={busy} onClick={() => archiveAddOnCatalog(item)} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 dark:border-rose-900 dark:text-rose-300">Archive</button>}</div>
          </div>)}</div>}
        </div>
      </div>
      <div className={cardClass}><h2 className="text-lg font-extrabold">Customer add-on requests</h2><p className={`mt-1 text-xs ${muted}`}>Approving a teacher request remains a complimentary administrator grant until the current subscription expires. Paid add-ons are managed separately in the catalog above and included in monthly invoices.</p></div>
      {(data?.addOnRequests ?? []).length === 0 ? <div className={`${cardClass} py-10 text-center text-sm ${muted}`}>No pending add-on requests.</div> : (data?.addOnRequests ?? []).map((request) => <div key={`${request.teacherUid}:${request.id}`} className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-0"><p className="font-extrabold">{request.featureName || request.featureKey}</p><p className={`mt-1 text-xs ${muted}`}>{request.teacherName} · {request.teacherEmail}</p><p className={`mt-1 text-[11px] ${muted}`}>Requested {request.requestedAt ? new Date(request.requestedAt).toLocaleString() : 'recently'}</p></div>
        <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => { if (window.confirm(`Approve ${request.featureName} for ${request.teacherName} until their current subscription expires?`)) void runAction({ action: 'reviewAddOnRequest', decision: 'approve', teacherUid: request.teacherUid, requestId: request.id }, `${request.featureName} add-on approved for ${request.teacherName}.`); }} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Approve</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`Reject ${request.featureName} request from ${request.teacherName}?`)) void runAction({ action: 'reviewAddOnRequest', decision: 'reject', teacherUid: request.teacherUid, requestId: request.id }, 'Add-on request rejected.'); }} className="rounded-xl border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 dark:border-rose-800 dark:text-rose-300 disabled:opacity-50">Reject</button></div>
      </div>)}
      <div className={`${cardClass} grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end`}>
        <label className="block text-sm font-semibold">Customer<select value={addOnTeacherUid} onChange={(event) => setAddOnTeacherUid(event.target.value)} className={inputClass}><option value="">Select customer</option>{(data?.teachers ?? []).map((teacher) => <option key={teacher.uid} value={teacher.uid}>{teacher.name} · {teacher.email}</option>)}</select></label>
        <label className="block text-sm font-semibold">Feature add-on<select value={addOnFeatureKey} onChange={(event) => setAddOnFeatureKey(event.target.value as FeaturePermissionKey)} className={inputClass}>{FEATURE_PERMISSION_CATALOG.map((feature) => <option key={feature.key} value={feature.key}>{feature.label}</option>)}</select></label>
        <button type="button" disabled={busy || !addOnTeacherUid} onClick={() => { const teacher = data?.teachers.find((item) => item.uid === addOnTeacherUid); if (teacher && window.confirm(`Grant ${addOnFeatureKey.replace(/_/g, ' ')} to ${teacher.name} until their current subscription expires?`)) void runAction({ action: 'assignCustomerAddOn', teacherUid: addOnTeacherUid, featureKey: addOnFeatureKey }, 'Customer add-on granted.'); }} className="rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">Assign add-on</button>
      </div>
      <div className={`${cardClass} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-extrabold">Active customer add-ons</h3>
            <p className={`mt-1 text-xs ${muted}`}>
              Search and filter active add-on grants without changing customer access.
            </p>
          </div>
          <span className="rounded-full bg-orange-500/10 px-3 py-1 text-xs font-bold text-orange-600">
            {activeCustomerAddOns.length} total
          </span>
        </div>

        {activeCustomerAddOns.length > 0 && <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="block text-xs font-bold">
              Search add-ons
              <input
                type="search"
                value={activeAddOnSearch}
                onChange={(event) => {
                  setActiveAddOnSearch(event.target.value);
                  setActiveAddOnPage(1);
                }}
                placeholder="Add-on, customer or email..."
                className={`${inputClass} mt-1`}
              />
            </label>

            <label className="block text-xs font-bold">
              Customer
              <select
                value={activeAddOnCustomer}
                onChange={(event) => {
                  setActiveAddOnCustomer(event.target.value);
                  setActiveAddOnPage(1);
                }}
                className={`${inputClass} mt-1`}
              >
                <option value="all">All customers</option>
                {activeAddOnCustomerOptions.map((customer) => (
                  <option key={customer.uid} value={customer.uid}>
                    {customer.name} · {customer.email}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-bold">
              ERP feature
              <select
                value={activeAddOnFeature}
                onChange={(event) => {
                  setActiveAddOnFeature(event.target.value);
                  setActiveAddOnPage(1);
                }}
                className={`${inputClass} mt-1`}
              >
                <option value="all">All features</option>
                {activeAddOnFeatureOptions.map((feature) => (
                  <option key={feature} value={feature}>
                    {feature.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-bold">
              Expiry information
              <select
                value={activeAddOnExpiry}
                onChange={(event) => {
                  setActiveAddOnExpiry(event.target.value);
                  setActiveAddOnPage(1);
                }}
                className={`${inputClass} mt-1`}
              >
                <option value="all">All expiry records</option>
                <option value="dated">Expiry date available</option>
                <option value="undated">No expiry date</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-100 py-3 dark:border-slate-800">
            <p className={`text-xs ${muted}`}>
              Showing <strong>{activeAddOnRangeStart}–{activeAddOnRangeEnd}</strong> of{' '}
              <strong>{filteredActiveAddOns.length}</strong> matching add-ons
            </p>

            <button
              type="button"
              onClick={() => {
                setActiveAddOnSearch('');
                setActiveAddOnCustomer('all');
                setActiveAddOnFeature('all');
                setActiveAddOnExpiry('all');
                setActiveAddOnPage(1);
              }}
              className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700"
            >
              Clear filters
            </button>
          </div>
        </>}

        {activeCustomerAddOns.length === 0 ? (
          <p className={`py-5 text-xs ${muted}`}>No active add-ons.</p>
        ) : filteredActiveAddOns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center dark:border-slate-700">
            <p className="text-sm font-bold">No matching add-ons found</p>
            <p className={`mt-1 text-xs ${muted}`}>Try changing your search or filters.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {paginatedActiveAddOns.map((item) => (
              <div
                key={`${item.teacher.uid}:${item.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700"
              >
                <div>
                  <strong>{item.name}</strong>
                  <p className={`text-xs ${muted}`}>
                    {item.teacher.name} · {item.featureKeys.join(', ')} · Expires{' '}
                    {item.expiresAt ? new Date(item.expiresAt).toLocaleDateString() : '—'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Revoke ${item.name} from ${item.teacher.name}?`)) {
                      void runAction(
                        { action: 'revokeCustomerAddOn', teacherUid: item.teacher.uid, addOnId: item.id },
                        `${item.name} revoked from ${item.teacher.name}.`
                      );
                    }
                  }}
                  className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 dark:border-rose-800 dark:text-rose-300"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}

        {filteredActiveAddOns.length > 0 && (
          <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <label className={`text-xs font-semibold ${muted}`} htmlFor="active-addon-page-size">
                Rows per page
              </label>
              <select
                id="active-addon-page-size"
                value={activeAddOnPageSize}
                onChange={(event) => {
                  setActiveAddOnPageSize(Number(event.target.value));
                  setActiveAddOnPage(1);
                }}
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-bold dark:border-slate-700 dark:bg-slate-950"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
              <span className={`text-xs ${muted}`}>
                Page {safeActiveAddOnPage} of {activeAddOnTotalPages}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safeActiveAddOnPage <= 1}
                onClick={() => setActiveAddOnPage((current) => Math.max(1, current - 1))}
                className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700"
              >
                Previous
              </button>
              <span className="min-w-9 rounded-lg bg-orange-500 px-3 py-2 text-center text-xs font-black text-white">
                {safeActiveAddOnPage}
              </span>
              <button
                type="button"
                disabled={safeActiveAddOnPage >= activeAddOnTotalPages}
                onClick={() => setActiveAddOnPage((current) => Math.min(activeAddOnTotalPages, current + 1))}
                className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>}

    {tab === 'plans' && <div className="grid gap-5">
      <div className={`${cardClass} space-y-2 xl:col-span-2`}>
        <div><h2 className="text-sm font-extrabold">Default permission matrix migration</h2><p className={`mt-1 text-xs ${muted}`}>Updates only existing plans named exactly Basic, Advance or Pro. New plans are not created, and historical invoices / approved-period permission snapshots are not rewritten.</p></div>
        <button type="button" disabled={busy || loading} onClick={() => { if (window.confirm('Apply the default On / Off / Configurable matrix to existing Basic, Advance and Pro plans? This changes their current catalog permissions but does not rewrite existing invoice or approved subscription snapshots.')) void runAction({ action: 'applyDefaultPermissionMatrix' }, 'Default permission matrix applied to matching existing plans.'); }} className="rounded-xl border border-orange-400 px-4 py-2.5 text-sm font-bold text-orange-700 dark:text-orange-300 disabled:opacity-50">Apply default matrix to existing plans</button>
      </div>
      <form onSubmit={submitPlan} className={`${cardClass} space-y-3`}>
        <h2 className="text-lg font-extrabold">{editingPlanId ? 'Edit monthly plan' : 'Create monthly plan'}</h2>
        <label className="block text-sm font-semibold">Plan name<input required maxLength={100} value={planName} onChange={(e) => setPlanName(e.target.value)} className={inputClass}/></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-semibold">Per Student Monthly Price (PKR)<input required min="0.01" step="0.01" type="number" value={planPerStudentPrice} onChange={(e) => setPlanPerStudentPrice(e.target.value)} className={inputClass}/><span className={`mt-1 block text-xs ${muted}`}>Monthly rate for each verified unique student.</span></label>
          <label className="block text-sm font-semibold">Fixed Lump Sum Monthly Price (PKR)<input required min="0.01" step="0.01" type="number" value={planLumpSumPrice} onChange={(e) => setPlanLumpSumPrice(e.target.value)} className={inputClass}/><span className={`mt-1 block text-xs ${muted}`}>One fixed monthly amount, independent of student count.</span></label>
        </div>
        <p className={`text-xs ${muted}`}>Both prices are stored on the same plan. Choose the applicable pricing option when generating each invoice.</p>
        <label className="block text-sm font-semibold">Description<textarea rows={2} maxLength={600} value={planDescription} onChange={(e) => setPlanDescription(e.target.value)} className={inputClass}/></label>
        <section className={`${cardClass} space-y-3`}>
          <div><h3 className="text-sm font-extrabold">Class announcement allowance</h3><p className={`mt-1 text-xs ${muted}`}>Base allowance is 4 announcements per class per billing month. Additional allowance is billed per class on the next invoice.</p></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm font-semibold">Announcements / class / month<input type="number" min="4" max="500" step="1" value={planAnnouncementQuota} onChange={(e) => setPlanAnnouncementQuota(e.target.value)} className={inputClass}/></label>
            <label className="block text-sm font-semibold">Extra pack size<input type="number" min="1" max="100" step="1" value={planAnnouncementPackSize} onChange={(e) => setPlanAnnouncementPackSize(e.target.value)} className={inputClass}/></label>
            <label className="block text-sm font-semibold">Extra pack price / class (PKR)<input type="number" min="0" step="0.01" value={planAnnouncementPackPrice} onChange={(e) => setPlanAnnouncementPackPrice(e.target.value)} className={inputClass}/></label>
          </div>
        </section>
        <label className="block text-sm font-semibold">Inherit feature list from (optional)<select value={planParentId} onChange={(e) => setPlanParentId(e.target.value)} className={inputClass}><option value="">No parent plan · standalone</option>{(data?.plans ?? []).filter((candidate) => candidate.active && !candidate.deleted && candidate.id !== editingPlanId).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select><span className={`mt-1 block text-xs ${muted}`}>The selected parent's features appear in expandable sections on this card.</span></label>
        <label className="block text-sm font-semibold">Unavailable feature visibility<select value={planFeatureVisibilityMode} onChange={(event) => setPlanFeatureVisibilityMode(event.target.value as 'hide' | 'locked')} className={inputClass}><option value="hide">Hide unavailable features</option><option value="locked">Show unavailable features as locked</option></select></label>
        <label className="block text-sm font-semibold">Plan features (one per line)<textarea rows={4} value={planFeatures} onChange={(e) => setPlanFeatures(e.target.value)} className={inputClass}/><span className={`mt-1 block text-xs ${muted}`}>Use this for the plan's own included features, such as the Base Plan feature list.</span></label>
        <label className="block text-sm font-semibold">Extra / Exclusive Features (one per line)<textarea rows={3} value={planExtraFeatures} onChange={(e) => setPlanExtraFeatures(e.target.value)} className={inputClass}/><span className={`mt-1 block text-xs ${muted}`}>These are highlighted separately on the plan card to show what this tier adds.</span></label>
        <section className={`${cardClass} space-y-3`} aria-labelledby="plan-feature-permissions-heading">
          <div>
            <h3 id="plan-feature-permissions-heading" className="text-sm font-extrabold">Plan Feature Permissions</h3>
            <p className={`mt-1 text-xs ${muted}`}>Choose which currently implemented ERP features this subscription plan includes. New plans start with all permissions disabled; older plans retain their existing access until you edit them.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => setPlanFeaturePermissions(defaultFeaturePermissionMap('basic'))} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold dark:border-slate-700">Basic preset</button>
            <button type="button" disabled={busy} onClick={() => setPlanFeaturePermissions(defaultFeaturePermissionMap('advance'))} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold dark:border-slate-700">Advance preset</button>
            <button type="button" disabled={busy} onClick={() => setPlanFeaturePermissions(defaultFeaturePermissionMap('pro'))} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold dark:border-slate-700">Pro preset</button>
            <button type="button" disabled={busy} onClick={() => setPlanFeaturePermissions(createFeaturePermissionMap())} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold dark:border-slate-700">Clear all</button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {FEATURE_PERMISSION_CATALOG.map((feature) => (
              <div key={feature.key} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold">{feature.label}</span>
                  <select aria-label={`${feature.label} permission`} value={planFeaturePermissions[feature.key]} onChange={(event) => setPlanFeaturePermissions((current) => ({ ...current, [feature.key]: event.target.value as PermissionState }))} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold dark:border-slate-700 dark:bg-slate-950">
                    <option value="enabled">On</option>
                    <option value="disabled">Off</option>
                    <option value="configurable">Configurable</option>
                  </select>
                </div>
                <span className={`mt-1 block text-xs font-normal ${muted}`}>{feature.description}</span>
              </div>
            ))}
          </div>
          <p className={`text-xs ${muted}`}>Configurable means the plan exposes the control; tenant settings, explicit requests, guardian consent and independent server switches still apply.</p>
        </section>
        <div className="flex flex-wrap gap-2"><button disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><Plus size={15}/> {editingPlanId ? 'Save changes' : 'Create plan'}</button>{editingPlanId && <button type="button" disabled={busy} onClick={resetPlanForm} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold dark:border-slate-700">Cancel edit</button>}</div>
      </form>
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-extrabold">Existing plans</h2><p className={`mt-1 text-xs ${muted}`}>Each card uses the plan details, prices, and features entered by the administrator.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{data?.plans.length ?? 0} plans</span></div>
        {loading ? <p className={muted}>Loading plans…</p> : !data?.plans.length ? <p className={muted}>No subscription plans have been created yet.</p> : <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
          {(data?.plans ?? []).map((plan, planIndex) => {
            const ancestors = getPlanAncestors(plan, data?.plans ?? []);
            const extra = plan.extraFeatures ?? [];
            const ownFeatures = plan.features ?? [];
            // Presentation-only palette rotates across dynamically loaded plans.
            // It does not assign plan names, prices, permissions, or tiers.
            const palette = [
              { border: 'border-blue-200', icon: 'bg-blue-100 text-blue-700', panel: 'bg-blue-50 text-blue-800', title: 'text-blue-700' },
              { border: 'border-emerald-400', icon: 'bg-emerald-100 text-emerald-700', panel: 'bg-emerald-50 text-emerald-800', title: 'text-emerald-700' },
              { border: 'border-violet-400', icon: 'bg-violet-100 text-violet-700', panel: 'bg-violet-50 text-violet-800', title: 'text-violet-700' },
            ];
            const tone = palette[planIndex % palette.length];
            const iconMark = ['◇', '♛', '✦'][planIndex % 3];
            return <article key={plan.id} className={`relative flex min-w-0 min-h-[560px] flex-col break-words rounded-3xl border-2 bg-white p-5 shadow-sm dark:bg-[#0c1222] ${tone.border}`}>
              <div className="flex items-start gap-3">
                <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-2xl ${tone.icon}`}>{iconMark}</div>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-black">{plan.name}</h3><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${plan.deleted ? 'bg-rose-100 text-rose-800' : plan.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{plan.deleted ? 'Archived' : plan.active ? 'Active' : 'Disabled'}</span></div><p className={`mt-1 text-sm ${muted}`}>{plan.description}</p></div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60"><p className="text-xs font-semibold">Per Student</p><p className="mt-1 text-xl font-black text-emerald-700 dark:text-emerald-400">{getPlanPerStudentAmount(plan) > 0 ? money(getPlanPerStudentAmount(plan)) : 'Not set'}</p><p className={`text-[11px] ${muted}`}>/ student / month</p></div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60"><p className="text-xs font-semibold">Lump Sum</p><p className="mt-1 text-xl font-black text-emerald-700 dark:text-emerald-400">{getPlanLumpSumAmount(plan) > 0 ? money(getPlanLumpSumAmount(plan)) : 'Not set'}</p><p className={`text-[11px] ${muted}`}>/ month (fixed)</p></div>
              </div>

              <p className={`mt-4 text-xs ${muted}`}>{FEATURE_PERMISSION_CATALOG.filter((feature) => plan.featurePermissions?.[feature.key] !== 'disabled').length} permissions available</p>

              {extra.length > 0 && <section className={`mt-4 rounded-2xl p-4 ${tone.panel}`}><h4 className={`mb-3 font-extrabold ${tone.title}`}>✦ Exclusive Features ({extra.length})</h4><ul className="space-y-2 text-sm font-medium">{extra.map((feature) => <li key={feature} className="flex items-start gap-2"><span className="font-black text-emerald-700">✓</span><span>{feature}</span></li>)}</ul></section>}

              {ownFeatures.length > 0 && <section className="mt-3"><h4 className="mb-2 font-extrabold">Plan Features ({ownFeatures.length})</h4><ul className="space-y-1.5 text-sm">{ownFeatures.map((feature) => <li key={feature} className="flex items-start gap-2"><span className="font-black text-emerald-600">✓</span><span>{feature}</span></li>)}</ul></section>}

              {ancestors.map((ancestor) => {
                const inheritedFeatures = [...(ancestor.features ?? []), ...(ancestor.extraFeatures ?? [])];
                return <details key={ancestor.id} className="mt-3 rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-700"><summary className="cursor-pointer list-none font-bold text-sm">▱ All {ancestor.name} Features ({inheritedFeatures.length})</summary><ul className={`mt-3 space-y-1.5 pl-1 text-xs ${muted}`}>{inheritedFeatures.map((feature, index) => <li key={`${ancestor.id}-${index}`}>✓ {feature}</li>)}</ul></details>;
              })}

              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                <button type="button" disabled={busy} onClick={() => startPlanEdit(plan)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700"><Pencil size={13}/> Edit</button>
                <button type="button" disabled={busy} onClick={() => togglePlan(plan)} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700">{plan.deleted ? 'Restore' : plan.active ? 'Disable' : 'Enable'}</button>
                {!plan.deleted && <button type="button" disabled={busy} onClick={() => void archivePlan(plan)} className="inline-flex items-center gap-1.5 rounded-xl border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 dark:border-rose-900 dark:text-rose-300"><Trash2 size={13}/> Delete</button>}
              </div>
            </article>;
          })}
        </div>}
      </div>    </div>}

    {tab === 'offers' && <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <form onSubmit={submitOffer} className={`${cardClass} space-y-3`}>
        <h2 className="text-lg font-extrabold">{editingOfferId ? 'Edit promotional offer' : 'Create promotional offer'}</h2>
        <label className="block text-sm font-semibold">Offer name<input required maxLength={100} value={offerName} onChange={(e) => setOfferName(e.target.value)} className={inputClass}/></label>
        <label className="block text-sm font-semibold">Description<textarea rows={2} value={offerDescription} onChange={(e) => setOfferDescription(e.target.value)} className={inputClass}/></label>
        <div className="grid grid-cols-2 gap-3"><label className="block text-sm font-semibold">Discount type<select value={offerType} onChange={(e) => setOfferType(e.target.value as 'percentage' | 'fixed')} className={inputClass}><option value="percentage">Percentage</option><option value="fixed">Fixed PKR</option></select></label><label className="block text-sm font-semibold">Discount value<input required type="number" min="0.01" step={offerType === 'fixed' ? '0.01' : '1'} value={offerValue} onChange={(e) => setOfferValue(e.target.value)} className={inputClass}/></label></div>
        <div className="grid grid-cols-2 gap-3"><label className="block text-sm font-semibold">Starts<input type="date" required value={offerFrom} onChange={(e) => setOfferFrom(e.target.value)} className={inputClass}/></label><label className="block text-sm font-semibold">Ends<input type="date" required min={offerFrom} value={offerUntil} onChange={(e) => setOfferUntil(e.target.value)} className={inputClass}/></label></div>
        <section className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div><h3 className="text-sm font-bold">Applicable plans</h3><p className={`text-xs ${muted}`}>Choose one or more plans. Leave all unchecked to apply the offer to every plan.</p></div><div className="grid gap-2 sm:grid-cols-2">{activePlans.map((plan) => <label key={plan.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2 text-xs dark:border-slate-800"><input type="checkbox" checked={offerPlanIds.includes(plan.id)} onChange={(event) => setOfferPlanIds((current) => event.target.checked ? [...current, plan.id] : current.filter((id) => id !== plan.id))}/><span>{plan.name}</span></label>)}</div><p className={`text-[11px] ${muted}`}>{offerPlanIds.length ? `${offerPlanIds.length} selected plan(s)` : 'All active plans'}</p></section>
        <div className="flex flex-wrap gap-2"><button disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><Plus size={15}/> {editingOfferId ? 'Save offer changes' : 'Create offer'}</button>{editingOfferId && <button type="button" disabled={busy} onClick={resetOfferForm} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold dark:border-slate-700">Cancel edit</button>}</div>
      </form>
      <div className="space-y-3"><h2 className="text-lg font-extrabold">Existing offers</h2>{loading ? <p className={muted}>Loading offers…</p> : (data?.offers ?? []).map((offer) => <div key={offer.id} className={`${cardClass} flex flex-wrap items-start justify-between gap-3`}><div><div className="flex items-center gap-2"><h3 className="font-extrabold">{offer.name}</h3><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${offer.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>{offer.active ? 'Active' : 'Disabled'}</span></div><p className="mt-1 text-xl font-black">{offer.discountType === 'percentage' ? `${offer.discountValue}% off` : `${money(offer.discountValue)} off`}</p><p className={`text-xs ${muted}`}>{offer.validFrom} through {offer.validUntil}</p><p className={`mt-1 text-sm ${muted}`}>{offer.description}</p><p className={`mt-1 text-xs ${muted}`}>Plans: {offer.planIds?.length ? activePlans.filter((plan) => offer.planIds.includes(plan.id)).map((plan) => plan.name).join(', ') || 'Selected plans (some may now be archived)' : 'All active plans'}</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => startOfferEdit(offer)} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700">Edit</button><button type="button" disabled={busy} onClick={() => toggleOffer(offer)} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700">{offer.active ? 'Disable' : 'Enable'}</button></div></div>)}</div>
    </div>}

    {tab === 'paymentReview' && <div className="space-y-4">
      <div className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold">Pending payment proofs</h2><p className={`mt-1 text-xs ${muted}`}>Review the private screenshot and invoice details. Approval marks the invoice paid and records the subscription only for its billed month.</p></div><button type="button" disabled={reviewLoading} onClick={() => void loadReviews()} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700"><RefreshCw size={14}/> Refresh queue</button></div>
      </div>
      {!reviewLoading && reviews.length > 0 && <div className={`${cardClass} space-y-4`}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="block text-xs font-bold">
            Search payments
            <input
              type="search"
              value={reviewSearch}
              onChange={(event) => { setReviewSearch(event.target.value); setReviewPage(1); }}
              placeholder="Teacher, email, invoice or reference"
              className={`${inputClass} mt-1`}
            />
          </label>
          <label className="block text-xs font-bold">
            Billing month
            <select
              value={reviewBillingPeriod}
              onChange={(event) => { setReviewBillingPeriod(event.target.value); setReviewPage(1); }}
              className={`${inputClass} mt-1`}
            >
              <option value="all">All billing months</option>
              {reviewBillingPeriodOptions.map((period) => (
                <option key={period} value={period}>{period}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-bold">
            Submitted from
            <input
              type="date"
              value={reviewDateFrom}
              max={reviewDateTo || undefined}
              onChange={(event) => { setReviewDateFrom(event.target.value); setReviewPage(1); }}
              className={`${inputClass} mt-1`}
            />
          </label>
          <label className="block text-xs font-bold">
            Submitted to
            <input
              type="date"
              value={reviewDateTo}
              min={reviewDateFrom || undefined}
              onChange={(event) => { setReviewDateTo(event.target.value); setReviewPage(1); }}
              className={`${inputClass} mt-1`}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={`text-xs ${muted}`}>
            Showing <strong>{reviewRangeStart}–{reviewRangeEnd}</strong> of <strong>{filteredReviews.length}</strong> matching proofs
          </p>
          <button
            type="button"
            onClick={() => {
              setReviewSearch('');
              setReviewBillingPeriod('all');
              setReviewDateFrom('');
              setReviewDateTo('');
              setReviewPage(1);
            }}
            className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Clear filters
          </button>
        </div>
      </div>}
      {reviewLoading ? <div className={`${cardClass} py-10 text-center text-sm ${muted}`}><Loader2 className="mx-auto mb-2 animate-spin" size={18}/>Loading payment proofs…</div> : !filteredReviews.length ? <div className={`${cardClass} py-10 text-center`}><CheckCircle2 className="mx-auto mb-2 text-emerald-500" size={24}/><p className="font-bold">No payment proofs waiting for review</p><p className={`mt-1 text-sm ${muted}`}>New teacher submissions will appear here.</p></div> : paginatedReviews.map((review) => <article key={review.receiptId} className={`${cardClass} space-y-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-extrabold">{review.invoiceNumber}</h3><span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-800">Pending review</span></div><p className={`mt-1 text-sm ${muted}`}>{review.teacherName} · {review.teacherEmail}</p><p className={`mt-1 text-xs ${muted}`}>{review.billingPeriod}{review.planName ? ` · ${review.planName}` : ''}{review.submittedAt ? ` · Submitted ${new Date(review.submittedAt).toLocaleString('en-PK')}` : ''}</p></div><div className="text-right"><p className="text-xl font-black tabular-nums">{money(review.totalPaisa)}</p><p className={`text-xs ${muted}`}>Invoice total</p></div></div>
        {review.paymentReference && <p className={`text-sm ${muted}`}>Transaction reference: <span className="font-semibold text-slate-800 dark:text-slate-100">{review.paymentReference}</span></p>}
        <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={previewLoading === review.receiptId || reviewBusy === review.receiptId} onClick={() => void openReceiptPreview(review)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold dark:border-slate-700">{previewLoading === review.receiptId ? <Loader2 size={15} className="animate-spin"/> : <Eye size={15}/>} View private screenshot</button><button type="button" disabled={reviewBusy === review.receiptId} onClick={() => void reviewPayment(review, 'reject')} className="inline-flex items-center gap-2 rounded-xl border border-rose-300 px-3 py-2 text-sm font-bold text-rose-700 disabled:opacity-50 dark:border-rose-900 dark:text-rose-300"><XCircle size={15}/> Reject</button><button type="button" disabled={reviewBusy === review.receiptId} onClick={() => void reviewPayment(review, 'approve')} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{reviewBusy === review.receiptId ? <Loader2 size={15} className="animate-spin"/> : <CheckCircle2 size={15}/>} Approve payment</button></div>
        <label className={`block text-xs font-semibold ${muted}`}>Optional note (shown to the teacher when rejected)<textarea rows={2} maxLength={500} value={reviewNotes[review.receiptId] || ''} onChange={(event) => setReviewNotes((current) => ({ ...current, [review.receiptId]: event.target.value }))} placeholder="For example: transaction amount or reference is not clear." className={`${inputClass} mt-1`}/></label>
      </article>)}
      {!reviewLoading && filteredReviews.length > 0 && <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`text-xs font-semibold ${muted}`} htmlFor="review-page-size">Rows per page</label>
          <select
            id="review-page-size"
            value={reviewPageSize}
            onChange={(event) => { setReviewPageSize(Number(event.target.value)); setReviewPage(1); }}
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-bold dark:border-slate-700 dark:bg-slate-950"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
          <span className={`text-xs ${muted}`}>Page {safeReviewPage} of {reviewTotalPages}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={safeReviewPage <= 1}
            onClick={() => setReviewPage((current) => Math.max(1, current - 1))}
            className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Previous
          </button>
          <span className="min-w-9 rounded-lg bg-orange-500 px-3 py-2 text-center text-xs font-black text-white">
            {safeReviewPage}
          </span>
          <button
            type="button"
            disabled={safeReviewPage >= reviewTotalPages}
            onClick={() => setReviewPage((current) => Math.min(reviewTotalPages, current + 1))}
            className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Next
          </button>
        </div>
      </div>}
    </div>}


    {tab === 'payments' && <div className="space-y-4">
      <div className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-extrabold">Payment Register</h2><p className={`mt-1 text-xs ${muted}`}>Only administrator-approved teacher payment proofs appear here.</p></div>
          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">{data?.payments.length ?? 0} approved payments</span>
        </div>
        {loading ? <p className={`py-8 text-center text-sm ${muted}`}>Loading payment register…</p>
          : !data?.payments.length ? <p className={`py-8 text-center text-sm ${muted}`}>No approved subscription payments yet.</p>
          : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm">
            <thead><tr className={`border-b text-xs uppercase tracking-wide ${muted}`}><th className="py-3 pr-3">Payment date</th><th className="py-3 pr-3">Invoice</th><th className="py-3 pr-3">Teacher</th><th className="py-3 pr-3">Billing month</th><th className="py-3 pr-3">Method</th><th className="py-3 pr-3">Reference</th><th className="py-3 text-right">Amount</th></tr></thead>
            <tbody>{data.payments.map((payment) => <tr key={payment.id} className="border-b border-slate-100 dark:border-slate-800">
              <td className="py-3 pr-3">{payment.approvedAt ? new Date(payment.approvedAt).toLocaleDateString('en-PK') : '—'}</td>
              <td className="py-3 pr-3 font-bold">{payment.invoiceNumber}</td>
              <td className="py-3 pr-3"><div className="font-semibold">{payment.teacherName}</div><div className={`text-xs ${muted}`}>{payment.teacherEmail}</div></td>
              <td className="py-3 pr-3">{payment.billingPeriod}</td><td className="py-3 pr-3">{payment.method}</td><td className="py-3 pr-3">{payment.paymentReference || '—'}</td>
              <td className="py-3 text-right font-bold tabular-nums">{money(payment.amountPaisa)}</td>
            </tr>)}</tbody>
          </table></div>}
      </div>
    </div>}

    {tab === 'invoices' && <div className="space-y-5">
      <div className={`${cardClass} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-extrabold">Invoice generation</h2><p className={`mt-1 text-xs ${muted}`}>Plan, pricing and recurring add-ons load automatically from each customer's saved subscription.</p></div>
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-900">
            <button type="button" onClick={() => { setInvoiceMode('single'); setBulkInvoiceResult(null); }} className={`rounded-lg px-3 py-2 text-xs font-bold ${invoiceMode === 'single' ? 'bg-orange-500 text-white shadow-sm' : muted}`}>Single customer</button>
            <button type="button" onClick={() => { setInvoiceMode('bulk'); setBulkInvoiceResult(null); }} className={`rounded-lg px-3 py-2 text-xs font-bold ${invoiceMode === 'bulk' ? 'bg-orange-500 text-white shadow-sm' : muted}`}>Bulk invoices</button>
          </div>
        </div>
        {invoiceMode === 'single' ? <form onSubmit={submitInvoice} className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="block text-sm font-semibold xl:col-span-2">Find customer by name or email
              <input required list="subscription-customer-options" value={teacherSearch} onChange={(event) => {
                const value = event.target.value;
                setTeacherSearch(value);
                const searchValue = value.trim().toLowerCase();
                const match = data?.teachers.find((teacher) => teacher.email.toLowerCase() === searchValue || teacher.name.toLowerCase() === searchValue);
                if (match) selectInvoiceTeacher(match.uid);
                else if (teacherUid) { setTeacherUid(''); setPlanId(''); setSelectedAddOnCatalogIds([]); }
              }} placeholder="Type e.g. base@gmail.com" className={inputClass}/>
              <datalist id="subscription-customer-options">{(data?.teachers ?? []).map((teacher) => <option key={teacher.uid} value={teacher.email} label={teacher.name}/>)}</datalist>
            </label>
            <label className="block text-sm font-semibold">Billing month<input required type="month" value={billingPeriod} onChange={(event) => setBillingPeriod(event.target.value)} className={inputClass}/></label>
            <label className="block text-sm font-semibold">Offer<select value={offerId} onChange={(event) => setOfferId(event.target.value)} className={inputClass}><option value="">No offer</option>{activeOffers.map((offer) => <option key={offer.id} value={offer.id}>{offer.name}</option>)}</select></label>
          </div>
          {selectedInvoiceTeacher && <div className="rounded-xl border border-orange-200 bg-orange-50/70 p-4 dark:border-orange-900/60 dark:bg-orange-950/20">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-extrabold">{selectedInvoiceTeacher.name}</p><p className="text-xs text-slate-600 dark:text-slate-300">{selectedInvoiceTeacher.email}</p></div><span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-orange-700 dark:bg-slate-900 dark:text-orange-300">Auto-filled subscription</span></div>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Saved plan</p><p className="font-bold">{selectedInvoiceTeacher.planName || selectedInvoicePlan?.name || 'No plan assigned'}</p></div>
              <div><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Saved pricing</p><p className="font-bold">{selectedInvoiceTeacher.pricingMode === 'per_student' ? 'Per student' : 'Lump sum'}</p></div>
              <div><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Active paid add-ons</p><p className="font-bold">{selectedInvoiceTeacher.activeAddOns?.length ?? 0}</p></div>
            </div>
            {(selectedInvoiceTeacher.activeAddOns?.length ?? 0) > 0 && <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{selectedInvoiceTeacher.activeAddOns?.map((addon) => addon.name).join(' · ')}</p>}
          </div>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="block text-sm font-semibold">Plan<select disabled={invoicePlanIsSaved} value={planId} onChange={(event) => {
              const nextId = event.target.value;
              const selected = activePlans.find((candidate) => candidate.id === nextId);
              setPlanId(nextId); setSelectedAddOnCatalogIds([]);
              const preferredMode = selectedInvoiceTeacher?.pricingMode || selected?.pricingMode;
              setInvoicePricingMode(preferredMode === 'lump_sum' ? 'lump_sum' : 'per_student');
              const selectedOffer = data?.offers.find((offer) => offer.id === offerId);
              if (selectedOffer?.planIds?.length && !selectedOffer.planIds.includes(nextId)) setOfferId('');
            }} className={inputClass}><option value="">No plan / charges only</option>{activePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · Student {money(getPlanPerStudentAmount(plan))} · Fixed {money(getPlanLumpSumAmount(plan))}</option>)}{postpaidPlanFallback && !activePlans.some((plan) => plan.id === postpaidPlanFallback.id) && <option value={postpaidPlanFallback.id}>{postpaidPlanFallback.name} · Saved at registration</option>}</select></label>
            <label className="block text-sm font-semibold">Invoice pricing option<select disabled={!selectedInvoicePlan || invoicePlanIsSaved} value={invoicePricingMode} onChange={(event) => setInvoicePricingMode(event.target.value as 'per_student' | 'lump_sum')} className={inputClass}><option value="per_student" disabled={!selectedInvoicePlan || getPlanPerStudentAmount(selectedInvoicePlan) <= 0}>Per Student · {selectedInvoicePlan ? money(getPlanPerStudentAmount(selectedInvoicePlan)) : '—'} / verified student</option><option value="lump_sum" disabled={!selectedInvoicePlan || getPlanLumpSumAmount(selectedInvoicePlan) <= 0}>Lump Sum · {selectedInvoicePlan ? money(getPlanLumpSumAmount(selectedInvoicePlan)) : '—'} / month fixed</option></select></label>
            <label className="block text-sm font-semibold">Payment due date<input required type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className={inputClass}/></label>
          </div>
          {selectedInvoiceTeacher?.accessMode === 'postpaid_monthly' && <div role="status" className="rounded-xl border border-blue-300 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200"><strong>Postpaid monthly:</strong> {selectedInvoiceTeacher.postpaidPlanName || savedPostpaidPlan?.name || 'Saved plan'} · Usage period {selectedInvoiceTeacher.postpaidUsageBillingPeriod || 'not set'} · {selectedInvoiceTeacher.postpaidUsageExpiresAt ? `ends ${new Date(selectedInvoiceTeacher.postpaidUsageExpiresAt).toLocaleString()}` : 'expiry unavailable'}. Plan and price remain locked to registration terms; generate only after the usage month ends.</div>}
          <section className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div><h3 className="text-sm font-bold">Paid monthly add-ons</h3><p className={`text-xs ${muted}`}>{invoicePlanIsSaved ? 'The customer’s active paid monthly add-ons are loaded automatically and locked to their saved subscription.' : 'Choose any add-ons for this first subscription invoice. They become active after payment approval.'}</p></div>
            {!activeAddOnCatalog.length ? <p className={`text-xs ${muted}`}>No active paid add-ons. Create products in the Add-ons tab first.</p> : <div className="grid gap-2 sm:grid-cols-2">{activeAddOnCatalog.map((item) => <label key={item.id} className={`flex items-start gap-2 rounded-lg border border-slate-100 p-3 text-xs dark:border-slate-800 ${!planId ? 'opacity-50' : ''}`}><input type="checkbox" disabled={!planId || invoicePlanIsSaved} checked={selectedAddOnCatalogIds.includes(item.id)} onChange={(event) => setSelectedAddOnCatalogIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} className="mt-0.5"/><span className="min-w-0"><strong className="block">{item.name} · {money(item.monthlyPricePaisa)}/month</strong><span className={muted}>{item.featureKey.replace(/_/g, ' ')} · {item.description}</span></span></label>)}</div>}
            {!planId && <p className="text-xs text-amber-700 dark:text-amber-300">Select a subscription plan before adding paid add-ons.</p>}
            {selectedAddOnCatalogIds.length > 0 && <p className="text-xs font-bold">{selectedAddOnCatalogIds.length} paid add-on(s) selected · {money(activeAddOnCatalog.filter((item) => selectedAddOnCatalogIds.includes(item.id)).reduce((sum, item) => sum + item.monthlyPricePaisa, 0))} / month before offer discount</p>}
          </section>
          <div className="space-y-2"><div className="flex items-center justify-between"><h3 className="text-sm font-bold">Additional charges (optional)</h3><button type="button" onClick={() => setCharges((current) => [...current, { description: '', amount: '' }])} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-bold dark:border-slate-700"><Plus size={13}/> Add charge</button></div>
            {charges.map((charge, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_150px_38px] gap-2"><input aria-label={`Charge ${index + 1} description`} placeholder="Charge description" value={charge.description} onChange={(event) => setCharges((items) => items.map((item, i) => i === index ? { ...item, description: event.target.value } : item))} className={inputClass}/><input aria-label={`Charge ${index + 1} amount in PKR`} type="number" min="0" step="0.01" placeholder="PKR" value={charge.amount} onChange={(event) => setCharges((items) => items.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))} className={inputClass}/><button type="button" aria-label="Remove charge" onClick={() => setCharges((items) => items.length > 1 ? items.filter((_, i) => i !== index) : [{ description: '', amount: '' }])} className="flex items-center justify-center rounded-xl border border-slate-300 dark:border-slate-700"><XCircle size={17}/></button></div>)}
          </div>
          <label className="block text-sm font-semibold">Invoice notes (optional)<input maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} className={inputClass}/></label>
          <button disabled={busy || loading || !teacherUid || postpaidInvoiceBlocked} title={postpaidInvoiceBlocked ? 'A postpaid invoice can be generated only after the usage month has ended and no invoice is awaiting payment.' : undefined} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? <Loader2 size={15} className="animate-spin"/> : <Receipt size={15}/>} Generate customer invoice</button>
        </form> : <div className="space-y-4">
          <div className="rounded-xl border border-orange-200 bg-orange-50/70 p-4 dark:border-orange-900/60 dark:bg-orange-950/20"><p className="font-extrabold">One-click bulk invoices</p><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Each customer gets an individual invoice based on their saved plan and pricing mode, verified roster count for per-student plans, and their own active paid monthly add-ons.</p><p className="mt-2 text-xs font-bold text-orange-800 dark:text-orange-300">{teachersWithPlans.length} customer(s) with an assigned plan · {data?.teachers.length ?? 0} active managed customer(s)</p></div>
          <div className="grid gap-3 md:grid-cols-3"><label className="block text-sm font-semibold">Billing month (standard plans)<input required type="month" value={billingPeriod} onChange={(event) => setBillingPeriod(event.target.value)} className={inputClass}/></label><label className="block text-sm font-semibold">Offer<select value={offerId} onChange={(event) => setOfferId(event.target.value)} className={inputClass}><option value="">No offer</option>{bulkOffers.map((offer) => <option key={offer.id} value={offer.id}>{offer.name} · {offer.planIds.length ? 'selected plans' : 'all plans'}</option>)}</select></label><label className="block text-sm font-semibold">Payment due date<input required type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className={inputClass}/></label></div>
          <label className="block text-sm font-semibold">Invoice notes (optional)<input maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Common note for generated invoices" className={inputClass}/></label>
          <p className={`text-xs ${muted}`}>Postpaid customers use their own completed usage month. A plan-specific offer applies only to matching plans. Customers with no plan, unfinished postpaid months, duplicate invoices or invalid data are safely skipped. Access is not activated until payment is reviewed and approved.</p>
          <button type="button" onClick={() => void submitBulkInvoices()} disabled={busy || loading || teachersWithPlans.length === 0} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? <Loader2 size={15} className="animate-spin"/> : <Users size={15}/>} Generate all eligible invoices</button>
        </div>}
      </div>
      {bulkInvoiceResult && <div className={`${cardClass} space-y-3`}>
        <div><h2 className="text-lg font-extrabold">Bulk generation report</h2><p className={`text-xs ${muted}`}>Period: {bulkInvoiceResult.billingPeriod} · Offer not applicable to {bulkInvoiceResult.offerNotAppliedCount} customer(s)</p></div>
        <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950/30"><p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">Created</p><p className="text-2xl font-black">{bulkInvoiceResult.createdCount}</p></div><div className="rounded-xl bg-amber-50 p-3 dark:bg-amber-950/30"><p className="text-xs font-bold text-amber-700 dark:text-amber-300">Skipped</p><p className="text-2xl font-black">{bulkInvoiceResult.skippedCount}</p></div><div className="rounded-xl bg-rose-50 p-3 dark:bg-rose-950/30"><p className="text-xs font-bold text-rose-700 dark:text-rose-300">Failed</p><p className="text-2xl font-black">{bulkInvoiceResult.failedCount}</p></div></div>
        <div className="max-h-96 overflow-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="sticky top-0 bg-slate-50 dark:bg-slate-900"><tr><th className="p-2">Customer</th><th className="p-2">Plan</th><th className="p-2">Month</th><th className="p-2">Invoice / issue</th><th className="p-2">Result</th></tr></thead><tbody>{bulkInvoiceResult.results.map((item, index) => <tr key={`${item.teacherUid ?? item.teacherEmail ?? 'row'}-${index}`} className="border-t border-slate-100 dark:border-slate-800"><td className="p-2"><strong>{item.teacherName}</strong><div className={muted}>{item.teacherEmail || '—'}</div></td><td className="p-2">{item.planName || '—'}</td><td className="p-2">{item.billingPeriod || bulkInvoiceResult.billingPeriod}</td><td className="p-2">{item.invoiceNumber || item.reason || '—'}{item.offerNotApplied ? <div className="text-amber-700">Offer not applicable</div> : null}</td><td className="p-2"><span className={`rounded-full px-2 py-1 font-bold ${item.status === 'created' ? 'bg-emerald-100 text-emerald-800' : item.status === 'skipped' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`}>{item.status}</span></td></tr>)}</tbody></table></div>
      </div>}
      <div className={cardClass}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">Subscription invoices</h2>
            <p className={`mt-1 text-xs ${muted}`}>Search, filter and manage invoice records generated by this subscription module.</p>
          </div>
          <span className="rounded-full bg-orange-500/10 px-3 py-1 text-xs font-bold text-orange-600">
            {data?.invoices.length ?? 0} records
          </span>
        </div>

        {loading ? (
          <div className={`py-8 text-center text-sm ${muted}`}>Loading invoices…</div>
        ) : !data?.invoices.length ? (
          <div className={`py-8 text-center text-sm ${muted}`}>No subscription invoices have been generated yet.</div>
        ) : (
          <div className="space-y-4">

            {/* Invoice search and filters */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="block text-xs font-bold">
                Search invoices
                <input
                  type="search"
                  value={invoiceSearch}
                  onChange={(event) => {
                    setInvoiceSearch(event.target.value);
                    setInvoicePage(1);
                  }}
                  placeholder="Invoice number, teacher or email..."
                  className={`${inputClass} mt-1.5`}
                />
              </label>

              <label className="block text-xs font-bold">
                Invoice status
                <select
                  value={invoiceStatusFilter}
                  onChange={(event) => {
                    setInvoiceStatusFilter(event.target.value);
                    setInvoicePage(1);
                  }}
                  className={`${inputClass} mt-1.5`}
                >
                  <option value="all">All invoice statuses</option>
                  {invoiceStatusOptions.map((status) => (
                    <option key={status} value={status}>
                      {status.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-bold">
                Payment status
                <select
                  value={invoicePaymentStatusFilter}
                  onChange={(event) => {
                    setInvoicePaymentStatusFilter(event.target.value);
                    setInvoicePage(1);
                  }}
                  className={`${inputClass} mt-1.5`}
                >
                  <option value="all">All payment statuses</option>
                  {invoicePaymentStatusOptions.map((status) => (
                    <option key={status} value={status}>
                      {status.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-bold">
                Billing month
                <select
                  value={invoiceBillingPeriodFilter}
                  onChange={(event) => {
                    setInvoiceBillingPeriodFilter(event.target.value);
                    setInvoicePage(1);
                  }}
                  className={`${inputClass} mt-1.5`}
                >
                  <option value="all">All billing months</option>
                  {invoiceBillingPeriodOptions.map((period) => (
                    <option key={period} value={period}>{period}</option>
                  ))}
                </select>
              </label>
            </div>

            {/* Results summary and page size */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-100 py-3 dark:border-slate-800">
              <div>
                <p className="text-sm font-bold">
                  Showing {invoiceRangeStart}–{invoiceRangeEnd} of {filteredInvoices.length}
                </p>
                <p className={`mt-0.5 text-xs ${muted}`}>
                  {filteredInvoices.length === (data?.invoices.length ?? 0)
                    ? 'All invoice records'
                    : `Filtered from ${data?.invoices.length ?? 0} total records`}
                </p>
              </div>

              <label className="flex items-center gap-2 text-xs font-semibold">
                Rows per page
                <select
                  value={invoicePageSize}
                  onChange={(event) => {
                    setInvoicePageSize(Number(event.target.value));
                    setInvoicePage(1);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </label>
            </div>

            {/* Invoice table */}
            {filteredInvoices.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center dark:border-slate-700">
                <Receipt size={26} className="mx-auto mb-2 text-slate-400" />
                <p className="font-bold">No matching invoices found</p>
                <p className={`mt-1 text-xs ${muted}`}>
                  Try changing your search or filters.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setInvoiceSearch('');
                    setInvoiceStatusFilter('all');
                    setInvoicePaymentStatusFilter('all');
                    setInvoiceBillingPeriodFilter('all');
                    setInvoicePage(1);
                  }}
                  className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold dark:border-slate-700"
                >
                  Clear all filters
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead>
                    <tr className={`border-b text-xs uppercase tracking-wide ${muted}`}>
                      <th className="py-3 pr-3">Invoice</th>
                      <th className="py-3 pr-3">Teacher</th>
                      <th className="py-3 pr-3">Period</th>
                      <th className="py-3 pr-3">Total</th>
                      <th className="py-3 pr-3">Due</th>
                      <th className="py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedInvoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-3 pr-3 font-bold">{invoice.invoiceNumber}</td>
                        <td className="py-3 pr-3">
                          <div className="font-semibold">{invoice.teacherName}</div>
                          <div className={`text-xs ${muted}`}>{invoice.teacherEmail}</div>
                        </td>
                        <td className="py-3 pr-3">{invoice.billingPeriod}</td>
                        <td className="py-3 pr-3 font-bold tabular-nums">{money(invoice.totalPaisa)}</td>
                        <td className="py-3 pr-3">{invoice.dueDate}</td>
                        <td className="py-3">
                          <div className="flex flex-col items-start gap-1">
                            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold capitalize text-amber-800">
                              {invoice.status.replace(/_/g, ' ')}
                            </span>
                            <span className="text-[10px] font-semibold capitalize text-slate-500 dark:text-slate-400">
                              Payment: {invoice.paymentStatus.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination controls */}
            {filteredInvoices.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <p className={`text-xs ${muted}`}>
                  Page {safeInvoicePage} of {invoiceTotalPages}
                </p>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={safeInvoicePage <= 1}
                    onClick={() => setInvoicePage((current) => Math.max(1, current - 1))}
                    className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    Previous
                  </button>

                  <span className="min-w-9 rounded-lg bg-orange-500 px-3 py-2 text-center text-xs font-black text-white">
                    {safeInvoicePage}
                  </span>

                  <button
                    type="button"
                    disabled={safeInvoicePage >= invoiceTotalPages}
                    onClick={() => setInvoicePage((current) => Math.min(invoiceTotalPages, current + 1))}
                    className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>}

    {busy && <p className={`flex items-center gap-2 text-xs ${muted}`}><Loader2 size={13} className="animate-spin"/> Saving subscription changes…</p>}
    <p className={`flex items-start gap-2 text-xs ${muted}`}><ShieldCheck size={14} className="mt-0.5 shrink-0"/> Plans, offers, invoices and payment decisions are saved server-side under the authenticated administrator workspace. Teachers cannot change invoice totals or subscription status from the browser.</p>
    {preview && <div role="dialog" aria-modal="true" aria-label="Private payment screenshot" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(null)}><div className="relative max-h-[90vh] max-w-5xl rounded-2xl bg-white p-3 shadow-2xl dark:bg-slate-950" onClick={(event) => event.stopPropagation()}><div className="mb-2 flex items-center justify-between gap-3"><p className="text-sm font-bold">{preview.label}</p><button type="button" aria-label="Close screenshot" onClick={() => setPreview(null)} className="rounded-lg border border-slate-300 p-2 dark:border-slate-700"><X size={16}/></button></div><img src={preview.url} alt={`Private payment proof for ${preview.label}`} className="max-h-[78vh] max-w-full rounded-lg object-contain"/></div></div>}
  </div>;
}
