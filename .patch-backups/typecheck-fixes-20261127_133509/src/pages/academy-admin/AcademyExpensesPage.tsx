import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementType, ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, BarChart3, BookOpen,
  Building2, Bus, CalendarDays, Check, CheckCircle2, CircleDollarSign, Clock3, Download,
  Eye, FileText, Filter, GraduationCap, Landmark, LoaderCircle, Megaphone, Monitor,
  Package, Pencil, Plus, Receipt, RefreshCw, Search, ShieldCheck, Sparkles, Trash2,
  Users, Wallet, Wifi, Wrench, X, XCircle, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from 'sonner';
import { auth } from '@/lib/firebase';
import { academyManagementRequest } from '@/lib/academyApi';

const CATEGORIES = [
  'Teacher/staff salaries', 'Building rent', 'Utilities', 'Internet/phone',
  'Stationery and classroom supplies', 'Books and learning materials',
  'Maintenance and repairs', 'Furniture/equipment', 'Transport',
  'Cleaning/security', 'Marketing/advertising', 'Software/services', 'Miscellaneous',
];
const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'card', label: 'Card' }, { value: 'online', label: 'Online' },
  { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' },
];
const CHART_COLORS = ['#f97316', '#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];

type AllocationMethod = 'none' | 'all_active' | 'selected_equal' | 'custom';
type ExpenseStatus = 'posted' | 'draft' | 'void';
type Teacher = { uid: string; name: string; designation?: string; email?: string; photoUrl?: string; active: boolean; emailVerified: boolean };
type TeacherAllocation = {
  teacherUid: string;
  teacherNameSnapshot: string;
  designationSnapshot?: string;
  teacherPhotoUrlSnapshot?: string;
  allocatedAmount: number;
  allocationMethod?: string;
};
type Expense = {
  id: string; expenseId: string; academyId?: string; title: string; category: string; amount: number; currency: string;
  expenseDate: string; vendor?: string; paymentMethod: string; reference?: string; status: ExpenseStatus;
  description?: string; voidReason?: string; allocationMethod?: AllocationMethod;
  allocationTotal?: number; unallocatedAmount?: number; teacherAllocations?: TeacherAllocation[];
  createdAt?: string | null; postedAt?: string | null; createdByUid?: string; createdByNameSnapshot?: string; postedByUid?: string; postedByNameSnapshot?: string; voidedByNameSnapshot?: string;
};
type Summary = {
  totalPosted: number; totalDraft: number; totalVoided: number; postedCount: number; draftCount: number;
  voidCount: number; transactionCount: number; totalAllocated: number; totalUnallocated: number;
  averagePosted: number; highestCategory: { name: string; amount: number } | null; byCategory: Record<string, number>;
  malformedAmountCount?: number; unknownStatusCount?: number; complete?: boolean;
};
type MonthPoint = { month: string; posted: number; draft: number; voided: number; postedCount: number };
type ExpenseResponse = { academy?: { academyId: string; academyName: string }; month: string; expenses: Expense[]; summary: Summary; monthlyTrend: MonthPoint[]; activeTeacherCount: number | null; meta: { expensesLimited: boolean; trendLimited: boolean; teacherListLimited: boolean; trendMalformedCount?: number } };
type TeacherResponse = { teachers: Teacher[]; limited: boolean };
type ExpenseAudit = { id: string; event?: string; actorUid?: string; actorNameSnapshot?: string; createdAt?: string | null; reason?: string; amount?: number; category?: string; allocationTotal?: number; allocationCount?: number };
type ExpenseDetailsResponse = { expense: Expense; auditHistory: ExpenseAudit[]; auditHistoryLimited: boolean };
type ExpenseForm = {
  title: string; category: string; amount: string; expenseDate: string; vendor: string; paymentMethod: string;
  reference: string; description: string; status: 'posted' | 'draft'; allocationMethod: AllocationMethod;
  selectedTeacherUids: string[]; customAllocations: Record<string, string>; reason: string;
};

const money = (value: unknown) => `PKR ${Number(value ?? 0).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const amountNumber = (value: string) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const fromCents = (value: number) => Number((value / 100).toFixed(2));
const pakistanMonth = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
};
const pakistanDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const labelMonth = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PK', { month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date(Date.UTC(year, number - 1, 15, 12)));
};
const inputClass = 'w-full rounded-2xl border border-slate-200/90 bg-white/90 px-3.5 py-3 text-sm font-medium text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-400 focus:ring-4 focus:ring-orange-100/70 dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-100 dark:focus:border-orange-500 dark:focus:ring-orange-500/10';
const buttonPrimary = 'inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 text-sm font-extrabold text-white shadow-lg shadow-orange-500/20 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-orange-500/25 disabled:pointer-events-none disabled:opacity-50';
const buttonSecondary = 'inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm font-bold text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50/60 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:bg-white/[0.06]';
const panelClass = 'rounded-[26px] border border-white/80 bg-white/90 p-4 shadow-[0_16px_45px_-36px_rgba(15,23,42,.35)] ring-1 ring-slate-200/60 backdrop-blur-xl dark:border-white/[0.08] dark:bg-slate-900/75 dark:ring-white/[0.05] sm:p-5';
const statusBadge = (status: ExpenseStatus) => status === 'posted'
  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300'
  : status === 'draft'
    ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300'
    : 'border-slate-200 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300';
const freshForm = (): ExpenseForm => ({
  title: '', category: CATEGORIES[0], amount: '', expenseDate: pakistanDate(), vendor: '', paymentMethod: 'cash',
  reference: '', description: '', status: 'posted', allocationMethod: 'none', selectedTeacherUids: [], customAllocations: {}, reason: '',
});

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-slate-950/55 p-3 backdrop-blur-md sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" className={`my-auto max-h-[94vh] w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} overflow-y-auto rounded-[30px] border border-white/70 bg-white p-5 shadow-[0_35px_100px_-35px_rgba(15,23,42,.65)] dark:border-white/10 dark:bg-slate-950 sm:p-7`}>
      <div className="mb-6 flex items-start justify-between gap-4"><div><div className="text-[10px] font-black uppercase tracking-[.2em] text-orange-600">EduTrack · Finance</div><h2 className="mt-1 text-xl font-black tracking-tight text-slate-900 dark:text-white sm:text-2xl">{title}</h2>{subtitle && <p className="mt-1 text-sm leading-5 text-slate-500 dark:text-slate-400">{subtitle}</p>}</div><button type="button" onClick={onClose} aria-label="Close dialog" className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-slate-200 text-slate-500 transition hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/10"><X className="h-5 w-5"/></button></div>
      {children}
    </section>
  </div>;
}

function Metric({ label, value, note, icon: Icon, tone = 'orange' }: { label: string; value: string; note?: string; icon: ElementType; tone?: string }) {
  const tones: Record<string, string> = {
    orange: 'border-orange-200/80 from-orange-50/90 to-white text-orange-600 dark:border-orange-400/20 dark:from-orange-500/10 dark:to-slate-900',
    green: 'border-emerald-200/80 from-emerald-50/90 to-white text-emerald-600 dark:border-emerald-400/20 dark:from-emerald-500/10 dark:to-slate-900',
    blue: 'border-sky-200/80 from-sky-50/90 to-white text-sky-600 dark:border-sky-400/20 dark:from-sky-500/10 dark:to-slate-900',
    amber: 'border-amber-200/80 from-amber-50/90 to-white text-amber-600 dark:border-amber-400/20 dark:from-amber-500/10 dark:to-slate-900',
    rose: 'border-rose-200/80 from-rose-50/90 to-white text-rose-600 dark:border-rose-400/20 dark:from-rose-500/10 dark:to-slate-900',
    violet: 'border-violet-200/80 from-violet-50/90 to-white text-violet-600 dark:border-violet-400/20 dark:from-violet-500/10 dark:to-slate-900',
  };
  return <div className={`rounded-[24px] border bg-gradient-to-br p-4 shadow-[0_14px_35px_-28px_rgba(15,23,42,.35)] ${tones[tone] || tones.orange}`}><div className="flex items-center justify-between gap-3"><span className="text-[10px] font-black uppercase tracking-[.13em] text-slate-500 dark:text-slate-400">{label}</span><span className="grid h-9 w-9 place-items-center rounded-2xl bg-white/90 shadow-sm dark:bg-slate-950/60"><Icon className="h-4 w-4"/></span></div><div className="mt-3 break-words text-2xl font-black tracking-tight text-slate-950 dark:text-white">{value}</div>{note && <div className="mt-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{note}</div>}</div>;
}

export default function AcademyExpensesPage() {
  const [month, setMonth] = useState(pakistanMonth());
  const [data, setData] = useState<ExpenseResponse | null>(null);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [teacherListLimited, setTeacherListLimited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [postConfirmationOpen, setPostConfirmationOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState<ExpenseForm>(freshForm);
  const [viewing, setViewing] = useState<Expense | null>(null);
  const [auditRows, setAuditRows] = useState<ExpenseAudit[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditHistoryLimited, setAuditHistoryLimited] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [voidTarget, setVoidTarget] = useState<Expense | null>(null);
  const [postTarget, setPostTarget] = useState<Expense | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [teacherDetail, setTeacherDetail] = useState<ReturnType<typeof buildTeacherOverview>[number] | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [allocationFilter, setAllocationFilter] = useState('all');
  const [teacherFilter, setTeacherFilter] = useState('all');
  const [page, setPage] = useState(1);
  const createRequestKey = useRef<{ signature: string; key: string } | null>(null);
  const loadGenerationRef = useRef(0);
  const PAGE_SIZE = 5;

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const user = auth.currentUser;
    if (!user) {
      setData(null); setTeachers([]); setTeacherListLimited(false);
      setError('Your session has expired. Sign in again.'); setLoading(false); return;
    }
    setLoading(true); setError(''); setData(null); setTeachers([]); setTeacherListLimited(false);
    try {
      const [expenseResult, teacherResult] = await Promise.all([
        academyManagementRequest<Omit<ExpenseResponse, 'success'>>(user, { action: 'expenses', month }),
        academyManagementRequest<TeacherResponse>(user, { action: 'expense-teachers' }),
      ]);
      if (generation !== loadGenerationRef.current) return;
      setData(expenseResult as ExpenseResponse);
      setTeachers(teacherResult.teachers || []);
      setTeacherListLimited(Boolean(teacherResult.limited || expenseResult.meta?.teacherListLimited));
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      const message = cause instanceof Error ? cause.message : 'Academy expenses could not be loaded.';
      setError(message); toast.error('Expenses could not be loaded', { description: message });
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const expenses = data?.expenses ?? [];
  const summary = data?.summary;
  const categoryOptions = useMemo(() => [...new Set([...CATEGORIES, ...expenses.map((expense) => expense.category).filter(Boolean)])].sort(), [expenses]);
  const teacherOverview = useMemo(() => buildTeacherOverview(expenses, teachers, !teacherListLimited), [expenses, teachers, teacherListLimited]);

  const filteredExpenses = useMemo(() => expenses.filter((expense) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [expense.title, expense.vendor, expense.reference, expense.description, expense.category].some((value) => String(value || '').toLowerCase().includes(query));
    const matchesCategory = categoryFilter === 'all' || expense.category === categoryFilter;
    const matchesStatus = statusFilter === 'all' || expense.status === statusFilter;
    const allocationTotal = Number(expense.allocationTotal || 0);
    const matchesAllocation = allocationFilter === 'all'
      || (allocationFilter === 'allocated' && allocationTotal > 0 && Number(expense.unallocatedAmount || 0) <= 0)
      || (allocationFilter === 'unallocated' && allocationTotal <= 0)
      || (allocationFilter === 'partial' && allocationTotal > 0 && Number(expense.unallocatedAmount || 0) > 0);
    const matchesTeacher = teacherFilter === 'all' || (expense.teacherAllocations || []).some((item) => item.teacherUid === teacherFilter);
    return matchesSearch && matchesCategory && matchesStatus && matchesAllocation && matchesTeacher;
  }), [expenses, search, categoryFilter, statusFilter, allocationFilter, teacherFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredExpenses.length / PAGE_SIZE));
  const pageExpenses = filteredExpenses.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [month, search, categoryFilter, statusFilter, allocationFilter, teacherFilter]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const setFormField = <K extends keyof ExpenseForm>(key: K, value: ExpenseForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const openCreate = () => { createRequestKey.current = null; setEditing(null); setForm(freshForm()); setFormOpen(true); };
  const openDetails = async (expense: Expense) => {
    setViewing(expense); setAuditRows([]); setAuditError(''); setAuditHistoryLimited(false); setAuditLoading(true);
    const user = auth.currentUser;
    if (!user) { setAuditError('Your session has expired.'); setAuditLoading(false); return; }
    try {
      const details = await academyManagementRequest<ExpenseDetailsResponse>(user, { action: 'expense-details', expenseId: expense.id });
      setViewing(details.expense); setAuditRows(details.auditHistory || []); setAuditHistoryLimited(Boolean(details.auditHistoryLimited));
    } catch (cause) { setAuditError(cause instanceof Error ? cause.message : 'Audit history could not be loaded.'); }
    finally { setAuditLoading(false); }
  };
  const openEdit = (expense: Expense) => {
    if (expense.status !== 'draft') return;
    createRequestKey.current = null;
    const selectedTeacherUids = (expense.teacherAllocations || []).map((item) => item.teacherUid).filter((uid) => teachers.some((teacher) => teacher.uid === uid && teacher.active && teacher.emailVerified));
    const customAllocations = Object.fromEntries((expense.teacherAllocations || []).filter((item) => selectedTeacherUids.includes(item.teacherUid)).map((item) => [item.teacherUid, String(item.allocatedAmount)]));
    setEditing(expense);
    setForm({
      title: expense.title, category: expense.category, amount: String(expense.amount), expenseDate: expense.expenseDate,
      vendor: expense.vendor || '', paymentMethod: expense.paymentMethod || 'cash', reference: expense.reference || '',
      description: expense.description || '', status: 'draft', allocationMethod: expense.allocationMethod || 'none',
      selectedTeacherUids, customAllocations, reason: '',
    });
    setFormOpen(true);
  };

  const allocationPreview = useMemo(() => {
    const amountCents = Math.max(0, cents(amountNumber(form.amount)));
    if (form.allocationMethod === 'none') return { rows: [] as Array<{ teacher: Teacher; amount: number }>, allocated: 0, unallocated: fromCents(amountCents), valid: true, error: '' };
    const selected = form.allocationMethod === 'all_active'
      ? teachers
      : teachers.filter((teacher) => form.selectedTeacherUids.includes(teacher.uid));
    if (!selected.length) return { rows: [], allocated: 0, unallocated: fromCents(amountCents), valid: false, error: teachers.length ? 'Select at least one active teacher.' : 'No active, verified teachers are available.' };
    let rows: Array<{ teacher: Teacher; amount: number }> = [];
    if (form.allocationMethod === 'custom') {
      rows = selected.map((teacher) => ({ teacher, amount: amountNumber(form.customAllocations[teacher.uid] || '0') }));
    } else {
      const base = Math.floor(amountCents / selected.length);
      const remainder = amountCents - base * selected.length;
      rows = [...selected].sort((a, b) => a.uid.localeCompare(b.uid)).map((teacher, index) => ({ teacher, amount: fromCents(base + (index < remainder ? 1 : 0)) }));
    }
    const allocatedCents = rows.reduce((total, row) => total + cents(row.amount), 0);
    const valid = rows.every((row) => row.amount > 0) && allocatedCents === amountCents && amountCents > 0;
    return { rows, allocated: fromCents(allocatedCents), unallocated: fromCents(Math.max(0, amountCents - allocatedCents)), valid, error: valid ? '' : 'Custom allocations must be positive and add up to the full expense amount.' };
  }, [form.amount, form.allocationMethod, form.selectedTeacherUids, form.customAllocations, teachers]);

  const toggleTeacher = (uid: string) => setForm((current) => {
    const exists = current.selectedTeacherUids.includes(uid);
    const selectedTeacherUids = exists ? current.selectedTeacherUids.filter((item) => item !== uid) : [...current.selectedTeacherUids, uid];
    const customAllocations = { ...current.customAllocations };
    if (!exists && !customAllocations[uid]) customAllocations[uid] = '';
    if (exists) delete customAllocations[uid];
    return { ...current, selectedTeacherUids, customAllocations };
  });

  const saveExpense = async (targetStatus: 'posted' | 'draft') => {
    const user = auth.currentUser;
    if (!user) return;
    if (!form.title.trim() || !form.category || amountNumber(form.amount) <= 0 || !form.expenseDate) {
      toast.error('Complete the required expense details.'); return;
    }
    if (form.allocationMethod !== 'none' && !allocationPreview.valid) { toast.error(allocationPreview.error || 'Check the teacher allocation.'); return; }
    if (editing && !form.reason.trim()) { toast.error('Add a reason for this draft edit.'); return; }
    setSaving(true);
    try {
      const allocationPayload = {
        allocationMethod: form.allocationMethod,
        selectedTeacherUids: form.allocationMethod === 'all_active' ? [] : form.selectedTeacherUids,
        customAllocations: form.allocationMethod === 'custom' ? form.selectedTeacherUids.map((teacherUid) => ({ teacherUid, allocatedAmount: Number(form.customAllocations[teacherUid] || 0) })) : [],
      };
      if (editing) {
        await academyManagementRequest(user, {
          action: 'update-expense', expenseId: editing.id, ...form, ...allocationPayload,
          amount: amountNumber(form.amount), status: 'draft', reason: form.reason.trim(), currency: 'PKR',
        });
        toast.success('Draft expense updated', { description: 'The original expense ID and creation history were preserved.' });
      } else {
        const requestSignature = JSON.stringify({
          title: form.title.trim(), category: form.category, amount: amountNumber(form.amount), expenseDate: form.expenseDate,
          vendor: form.vendor.trim(), paymentMethod: form.paymentMethod, reference: form.reference.trim(), description: form.description.trim(),
          status: targetStatus, allocationMethod: allocationPayload.allocationMethod,
          selectedTeacherUids: [...allocationPayload.selectedTeacherUids].sort(),
          customAllocations: [...allocationPayload.customAllocations].sort((a, b) => a.teacherUid.localeCompare(b.teacherUid)),
        });
        if (!createRequestKey.current || createRequestKey.current.signature !== requestSignature) {
          const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          createRequestKey.current = { signature: requestSignature, key };
        }
        const result = await academyManagementRequest<{ duplicate?: boolean; expenseId?: string }>(user, {
          action: 'create-expense', ...form, ...allocationPayload,
          amount: amountNumber(form.amount), status: targetStatus, currency: 'PKR', idempotencyKey: createRequestKey.current.key,
        });
        toast.success(result.duplicate ? 'Expense was already saved' : targetStatus === 'posted' ? 'Expense posted successfully' : 'Expense draft saved', {
          description: result.duplicate ? 'The retry was safely deduplicated; no second expense was created.' : 'The expense card is now saved in the Academy ledger.',
        });
      }
      createRequestKey.current = null; setPostConfirmationOpen(false); setFormOpen(false); setEditing(null); setForm(freshForm()); await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Expense could not be saved.';
      toast.error('Expense save failed', { description: message }); setError(message);
    } finally { setSaving(false); }
  };

  const runDeleteDraft = async () => {
    const user = auth.currentUser;
    if (!user || !deleteTarget || !actionReason.trim()) return;
    setSaving(true);
    try {
      await academyManagementRequest(user, { action: 'delete-draft-expense', expenseId: deleteTarget.id, reason: actionReason.trim() });
      toast.success('Draft expense deleted', { description: 'An audit snapshot was retained.' }); setDeleteTarget(null); setActionReason(''); await load();
    } catch (cause) { toast.error('Draft could not be deleted', { description: cause instanceof Error ? cause.message : 'Please retry.' }); }
    finally { setSaving(false); }
  };

  const runVoid = async () => {
    const user = auth.currentUser;
    if (!user || !voidTarget || !actionReason.trim()) return;
    setSaving(true);
    try {
      await academyManagementRequest(user, { action: 'void-expense', expenseId: voidTarget.id, reason: actionReason.trim() });
      toast.success('Expense voided', { description: 'The posted record and allocation snapshot remain in history.' }); setVoidTarget(null); setActionReason(''); await load();
    } catch (cause) { toast.error('Expense could not be voided', { description: cause instanceof Error ? cause.message : 'Please retry.' }); }
    finally { setSaving(false); }
  };

  const runPostDraft = async () => {
    const user = auth.currentUser;
    if (!user || !postTarget || !actionReason.trim()) return;
    setSaving(true);
    try {
      await academyManagementRequest(user, { action: 'post-draft-expense', expenseId: postTarget.id, reason: actionReason.trim() });
      toast.success('Draft posted', { description: 'Teacher allocations were revalidated against current active membership.' }); setPostTarget(null); setActionReason(''); await load();
    } catch (cause) { toast.error('Draft could not be posted', { description: cause instanceof Error ? cause.message : 'Please retry.' }); }
    finally { setSaving(false); }
  };

  const exportPdf = () => {
    if (!data) { toast.error('There is no expense report to export.'); return; }
    if (data.meta.expensesLimited || data.meta.trendLimited || summary?.complete === false) {
      toast.error('This report reached a data safety limit. Narrow the report or review the incomplete records first.'); return;
    }
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('EduTrack · Academy Expense Report', 14, 16);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(`${data.academy?.academyName || 'Academy'} · Academy ID: ${data.academy?.academyId || 'Unavailable'}`, 14, 23);
    doc.text(`${labelMonth(month)} · Timezone: Asia/Karachi`, 14, 29);
    doc.text(`Generated: ${new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Karachi' }).format(new Date())}`, 14, 35);
    autoTable(doc, {
      startY: 41,
      head: [['Posted (PKR)', 'Draft (PKR)', 'Voided (PKR)', 'Posted Entries', 'Allocated (PKR)', 'Unallocated (PKR)']],
      body: [[money(summary?.totalPosted), money(summary?.totalDraft), money(summary?.totalVoided), String(summary?.postedCount ?? 0), money(summary?.totalAllocated), money(summary?.totalUnallocated)]],
      styles: { fontSize: 9, cellPadding: 3 }, headStyles: { fillColor: [249, 115, 22] },
    });
    const lastY = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 55;
    autoTable(doc, {
      startY: lastY + 8,
      head: [['Date', 'Expense', 'Category', 'Vendor', 'Payment Method', 'Reference', 'Amount (PKR)', 'Status', 'Allocated (PKR)']],
      body: expenses.map((expense) => [expense.expenseDate, expense.title, expense.category, expense.vendor || '—', expense.paymentMethod, expense.reference || '—', money(expense.amount), expense.status.toUpperCase(), money(expense.allocationTotal || 0)]),
      styles: { fontSize: 7.5, cellPadding: 2 }, headStyles: { fillColor: [30, 41, 59] },
      didDrawPage: () => { doc.setFontSize(8); doc.text('EduTrack · Internal Academy Report', 14, 202); },
    });
    const teacherY = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 60;
    autoTable(doc, {
      startY: teacherY + 8,
      head: [['Teacher', 'Designation', 'Allocation Entries', 'Total Allocated (PKR)', 'Last Allocation']],
      body: teacherOverview.map((teacher) => [teacher.name, teacher.designation || '—', String(teacher.entries), money(teacher.totalAllocated), teacher.lastAllocationDate || '—']),
      styles: { fontSize: 8, cellPadding: 2.5 }, headStyles: { fillColor: [14, 116, 144] },
    });
    doc.save(`EduTrack-Academy-Expenses-${month}.pdf`);
    toast.success('Monthly expense PDF exported.');
  };

  const postedExpenses = summary?.totalPosted ?? 0;
  const activeTeacherCount = data ? data.activeTeacherCount ?? (teacherListLimited ? null : teachers.length) : null;
  const activeTeacherCountLabel = activeTeacherCount === null ? '—' : String(activeTeacherCount);
  const chartCategories = Object.entries(summary?.byCategory || {}).map(([name, value]) => ({ name, value }));
  const hasAnyExpenses = expenses.length > 0;

  return <div className="space-y-6 pb-8">
    <header className="flex flex-col gap-4 rounded-[28px] border border-white/80 bg-white/90 p-4 shadow-[0_18px_55px_-42px_rgba(15,23,42,.5)] ring-1 ring-slate-200/60 backdrop-blur-xl dark:border-white/[0.08] dark:bg-slate-900/75 dark:ring-white/[0.05] sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-[18px] bg-gradient-to-br from-orange-500 to-amber-400 text-white shadow-lg shadow-orange-500/25"><Wallet className="h-6 w-6"/></div><div><div className="text-[10px] font-black uppercase tracking-[.2em] text-orange-600 dark:text-orange-300">Academy Management · Finance</div><h1 className="text-xl font-black tracking-tight text-slate-950 dark:text-white sm:text-2xl">Academy Expenses</h1><p className="text-xs text-slate-500 dark:text-slate-400">Record, manage, analyse and allocate Academy operating expenses.</p></div></div>
      <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => void load()} className={buttonSecondary} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}/> Refresh</button><button type="button" onClick={exportPdf} className={buttonSecondary} disabled={!data || loading}><Download className="h-4 w-4"/> Export PDF</button><button type="button" onClick={openCreate} className={buttonPrimary}><Plus className="h-4 w-4"/> Record Expense</button></div>
    </header>

    <section className="relative overflow-hidden rounded-[30px] border border-orange-200/80 bg-gradient-to-br from-white via-orange-50/70 to-amber-100/80 p-5 shadow-[0_25px_65px_-42px_rgba(234,88,12,.45)] dark:border-orange-400/20 dark:from-slate-900 dark:via-slate-900 dark:to-orange-950/30 sm:p-7">
      <div className="pointer-events-none absolute -right-12 -top-24 h-64 w-64 rounded-full bg-orange-300/20 blur-3xl dark:bg-orange-500/10"/>
      <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(500px,1.15fr)] xl:items-center">
        <div><div className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-white/80 px-3 py-1.5 text-[10px] font-black uppercase tracking-[.18em] text-orange-700 dark:border-orange-400/20 dark:bg-slate-950/40 dark:text-orange-300"><Sparkles className="h-3.5 w-3.5"/> Financial command centre</div><h2 className="mt-3 max-w-xl text-3xl font-black leading-tight tracking-tight text-slate-950 dark:text-white sm:text-4xl">Every expense, <span className="text-orange-600 dark:text-orange-300">clearly accounted.</span></h2><p className="mt-3 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">A transparent monthly view of operating costs, posting status and teacher cost allocation—without changing historical records.</p><div className="mt-5 flex flex-wrap items-center gap-2"><label className="inline-flex items-center gap-2 rounded-2xl border border-orange-200 bg-white/90 px-3 py-2.5 text-xs font-bold text-slate-600 shadow-sm dark:border-white/10 dark:bg-slate-950/50 dark:text-slate-300"><CalendarDays className="h-4 w-4 text-orange-600"/><span>Reporting month</span><input aria-label="Reporting month" type="month" value={month} onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} className="min-w-0 bg-transparent font-extrabold text-slate-900 outline-none dark:text-white"/></label><span className="rounded-full border border-white/80 bg-white/70 px-3 py-2 text-[11px] font-bold text-slate-500 dark:border-white/10 dark:bg-slate-950/40 dark:text-slate-400">Asia/Karachi</span></div></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <HeroMetric icon={Wallet} label="Posted expenses" value={summary ? money(summary.totalPosted) : '—'} tone="orange"/>
          <HeroMetric icon={Clock3} label="Draft value" value={summary ? money(summary.totalDraft) : '—'} tone="amber"/>
          <HeroMetric icon={XCircle} label="Voided entries" value={summary ? String(summary.voidCount) : '—'} tone="rose"/>
          <HeroMetric icon={Users} label="Active teachers" value={activeTeacherCountLabel} tone="blue"/>
          <HeroMetric icon={CircleDollarSign} label="Allocated" value={summary ? money(summary.totalAllocated) : '—'} tone="green"/>
          <HeroMetric icon={ArrowDownRight} label="Unallocated" value={summary ? money(summary.totalUnallocated) : '—'} tone="violet"/>
        </div>
      </div>
    </section>

    {error && <div role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0"/>{error}<button className="ml-auto text-xs font-bold underline" type="button" onClick={() => void load()}>Retry</button></div>}
    {data?.meta.expensesLimited && <DataWarning>More than 1,000 expenses exist in this month. The list and totals are bounded to the first 1,000 records; treat the displayed figures as incomplete until a paginated ledger is reviewed.</DataWarning>}
    {data?.meta.trendLimited && <DataWarning>Monthly trend reached its read safety limit. The chart may not include every historical expense.</DataWarning>}
    {Boolean(data?.meta.trendMalformedCount) && <DataWarning>{data?.meta.trendMalformedCount} historical trend records had invalid dates or amounts and were omitted from the chart.</DataWarning>}
    {data?.meta.teacherListLimited && <DataWarning>The active teacher list reached its safety limit. All-teacher allocation is blocked if the server cannot verify the complete list.</DataWarning>}
    {summary?.complete === false && <DataWarning>Some stored expense or allocation amounts are malformed. Affected amounts were not silently treated as zero; verify the records before exporting totals.</DataWarning>}

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Monthly posted total" value={summary ? money(summary.totalPosted) : '—'} note={summary ? `${summary.postedCount} posted entries` : 'Waiting for ledger data'} icon={Receipt} tone="orange"/>
      <Metric label="Draft expenses" value={summary ? money(summary.totalDraft) : '—'} note={summary ? `${summary.draftCount} drafts · excluded from cash-flow` : 'Waiting for ledger data'} icon={Clock3} tone="amber"/>
      <Metric label="Voided entries" value={summary ? money(summary.totalVoided) : '—'} note={summary ? `${summary.voidCount} retained historical records` : 'Waiting for ledger data'} icon={XCircle} tone="rose"/>
      <Metric label="Transactions this month" value={summary ? String(summary.transactionCount) : '—'} note="Posted, draft and voided records" icon={FileText} tone="blue"/>
      <Metric label="Highest expense category" value={summary ? summary.highestCategory?.name || '—' : '—'} note={summary?.highestCategory ? money(summary.highestCategory.amount) : summary ? 'No posted category totals' : 'Waiting for ledger data'} icon={BarChart3} tone="violet"/>
      <Metric label="Average posted expense" value={summary ? money(summary.averagePosted) : '—'} note="Posted total divided by posted entries" icon={Activity} tone="green"/>
      <Metric label="Average per active teacher" value={summary && activeTeacherCount !== null && activeTeacherCount > 0 ? money(postedExpenses / activeTeacherCount) : '—'} note={!summary ? 'Waiting for ledger data' : activeTeacherCount === null ? 'Teacher count exceeds the safe preview limit' : activeTeacherCount > 0 ? `${activeTeacherCount} active, verified teachers` : 'No active teachers available'} icon={Users} tone="blue"/>
      <Metric label="Allocated / unallocated" value={summary ? `${money(summary.totalAllocated)} / ${money(summary.totalUnallocated)}` : '—'} note="Posted allocation reconciliation" icon={CircleDollarSign} tone="orange"/>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.35fr_.95fr]">
      <div className={panelClass}><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="text-[10px] font-black uppercase tracking-[.18em] text-orange-600">Six-month view</div><h3 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Monthly expense trend</h3><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Posted cash-flow is separated from saved draft values.</p></div><span className="rounded-full bg-orange-50 px-3 py-1 text-[10px] font-bold text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">PKR · Asia/Karachi</span></div>
        {loading ? <ChartLoading/> : (data?.monthlyTrend || []).length ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data?.monthlyTrend}><defs><linearGradient id="expensePostedFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f97316" stopOpacity={.28}/><stop offset="100%" stopColor="#f97316" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false}/><XAxis dataKey="month" tickFormatter={(value) => String(value).slice(5)} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false}/><YAxis tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false}/><Tooltip formatter={(value) => money(value)} labelFormatter={(value) => labelMonth(String(value))}/><Legend/><Area type="monotone" dataKey="posted" name="Posted" stroke="#f97316" strokeWidth={3} fill="url(#expensePostedFill)"/><Area type="monotone" dataKey="draft" name="Draft" stroke="#f59e0b" strokeDasharray="5 4" fill="transparent"/></AreaChart></ResponsiveContainer></div> : <ChartEmpty>No expense records are available for this reporting period.</ChartEmpty>}
      </div>
      <div className={panelClass}><div className="mb-4"><div className="text-[10px] font-black uppercase tracking-[.18em] text-orange-600">Cost composition</div><h3 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Category breakdown</h3><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Posted expenses only. Draft and voided values are excluded.</p></div>
        {loading ? <ChartLoading/> : chartCategories.length ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={chartCategories} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={3}>{chartCategories.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]}/>)}</Pie><Tooltip formatter={(value) => money(value)}/><Legend verticalAlign="bottom" height={40} wrapperStyle={{ fontSize: 10 }}/></PieChart></ResponsiveContainer></div> : <ChartEmpty>No posted category totals for this month.</ChartEmpty>}
      </div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.4fr_.8fr]">
      <div className={panelClass}><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="text-[10px] font-black uppercase tracking-[.18em] text-orange-600">Cost allocation</div><h3 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Teacher expense distribution</h3><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Historical teacher identity and posted allocation snapshots for {labelMonth(month)}.</p></div><span className="rounded-full border border-slate-200 px-3 py-1 text-[10px] font-bold text-slate-500 dark:border-white/10">No payroll deductions</span></div>
        {loading ? <ChartLoading/> : teacherOverview.length ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={teacherOverview.slice(0, 10)} layout="vertical" margin={{ left: 10, right: 18 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0"/><XAxis type="number" tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false}/><Tooltip formatter={(value) => money(value)}/><Bar dataKey="totalAllocated" name="Allocated expense" fill="#0ea5e9" radius={[0, 8, 8, 0]} barSize={18}/></BarChart></ResponsiveContainer></div> : <ChartEmpty>No posted teacher allocations exist for this month.</ChartEmpty>}
      </div>
      <div className={panelClass}><div className="text-[10px] font-black uppercase tracking-[.18em] text-orange-600">Posting integrity</div><h3 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Monthly ledger status</h3><div className="mt-4 space-y-3">{[
        { label: 'Posted entries', count: summary?.postedCount ?? 0, amount: summary?.totalPosted ?? 0, tone: 'bg-emerald-500' },
        { label: 'Draft entries', count: summary?.draftCount ?? 0, amount: summary?.totalDraft ?? 0, tone: 'bg-amber-500' },
        { label: 'Voided entries', count: summary?.voidCount ?? 0, amount: summary?.totalVoided ?? 0, tone: 'bg-slate-400' },
      ].map((item) => <div key={item.label} className="rounded-2xl border border-slate-100 bg-slate-50/80 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-300"><span className={`h-2.5 w-2.5 rounded-full ${item.tone}`}/>{item.label}</div><span className="text-xs font-black text-slate-950 dark:text-white">{item.count}</span></div><div className="mt-1 text-lg font-black text-slate-900 dark:text-white">{money(item.amount)}</div></div>)}</div><div className="mt-4 rounded-2xl border border-orange-100 bg-orange-50/70 p-3 text-xs leading-5 text-orange-900 dark:border-orange-400/10 dark:bg-orange-500/10 dark:text-orange-200"><ShieldCheck className="mr-1 inline h-4 w-4"/> Posted expenses are never hard-deleted. Drafts can be deleted with an audit snapshot; posted entries require a reasoned void action.</div></div>
    </section>

    <section className={panelClass}>
      <div className="mb-5 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between"><div><div className="text-[10px] font-black uppercase tracking-[.18em] text-orange-600">Transaction management</div><h3 className="mt-1 text-xl font-black text-slate-950 dark:text-white">Expense register</h3><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{filteredExpenses.length} matching records · {labelMonth(month)}</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={openCreate} className={buttonPrimary}><Plus className="h-4 w-4"/> Add Expense</button><button type="button" className={buttonSecondary} onClick={exportPdf}><Download className="h-4 w-4"/> Report</button></div></div>
      <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.5fr)_repeat(4,minmax(130px,1fr))]"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input className={`${inputClass} pl-10`} placeholder="Search title, vendor, reference…" value={search} onChange={(event) => setSearch(event.target.value)}/></div><select aria-label="Category filter" className={inputClass} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{categoryOptions.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Status filter" className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="posted">Posted</option><option value="draft">Draft</option><option value="void">Voided</option></select><select aria-label="Allocation filter" className={inputClass} value={allocationFilter} onChange={(event) => setAllocationFilter(event.target.value)}><option value="all">All allocation states</option><option value="allocated">Allocated</option><option value="partial">Partially allocated</option><option value="unallocated">Unallocated</option></select><select aria-label="Teacher filter" className={inputClass} value={teacherFilter} onChange={(event) => setTeacherFilter(event.target.value)}><option value="all">All teachers</option>{teacherOverview.map((teacher) => <option key={teacher.teacherUid} value={teacher.teacherUid}>{teacher.name}</option>)}</select></div>
      {loading ? <div className="py-12 text-center text-sm font-semibold text-slate-500"><LoaderCircle className="mx-auto mb-2 h-6 w-6 animate-spin text-orange-500"/>Loading the Academy ledger…</div> : !data ? <EmptyLuxury icon={AlertCircle} title="Expense ledger unavailable" message="The Academy expense records could not be loaded. Retry before treating the register or its totals as empty." action={<button type="button" onClick={() => void load()} className={buttonSecondary}><RefreshCw className="h-4 w-4"/> Retry loading</button>}/> : !hasAnyExpenses ? <EmptyLuxury icon={Receipt} title="No expenses recorded for this month" message="Add the first operating expense. Your saved record will appear here as a premium expense card." action={<button type="button" onClick={openCreate} className={buttonPrimary}><Plus className="h-4 w-4"/> Record first expense</button>}/> : !pageExpenses.length ? <EmptyLuxury icon={Filter} title="No matching expenses" message="Try another search term or reset the selected filters."/> : <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">{pageExpenses.map((expense) => <ExpenseCard key={expense.id} expense={expense} onView={() => void openDetails(expense)} onEdit={() => openEdit(expense)} onDelete={() => { setDeleteTarget(expense); setActionReason(''); }} onVoid={() => { setVoidTarget(expense); setActionReason(''); }} onPost={() => { setPostTarget(expense); setActionReason(''); }}/>)}</div>}
      {filteredExpenses.length > 0 && <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 dark:border-white/[0.06] sm:flex-row sm:items-center sm:justify-between"><p className="text-xs font-semibold text-slate-500">Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredExpenses.length)} of {filteredExpenses.length} records</p><div className="flex items-center gap-2"><button type="button" className={buttonSecondary} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span className="rounded-xl bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">{page} / {totalPages}</span><button type="button" className={buttonSecondary} disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button></div></div>}
    </section>

    <section className={panelClass}><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><div className="text-[10px] font-black uppercase tracking-[.18em] text-orange-600">Teacher-wise ledger</div><h3 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Monthly teacher allocations</h3><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Allocation is an internal cost-reporting split, not a salary deduction or teacher payment.</p></div><span className="rounded-full border border-slate-200 px-3 py-1 text-[10px] font-bold text-slate-500 dark:border-white/10">{teacherOverview.length} teachers with allocations</span></div>
      {loading ? <ChartLoading/> : teacherOverview.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{teacherOverview.map((teacher) => <button type="button" key={teacher.teacherUid} onClick={() => setTeacherDetail(teacher)} className="group rounded-[22px] border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/70 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-lg hover:shadow-orange-500/5 dark:border-white/[0.08] dark:from-slate-900 dark:to-slate-950"><div className="flex items-center gap-3"><TeacherAvatar teacher={teacher}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-black text-slate-900 dark:text-white">{teacher.name}</span><span className="block truncate text-[11px] text-slate-500">{teacher.designation || 'Academy teacher'}</span></span><span className={`rounded-full px-2 py-1 text-[9px] font-black ${teacher.isActive ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300'}`}>{teacher.isStatusUnknown ? 'STATUS UNAVAILABLE' : teacher.isActive ? 'ACTIVE' : 'HISTORICAL'}</span></div><div className="mt-4 flex items-end justify-between gap-3"><div><div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Allocated expenses</div><div className="mt-1 text-xl font-black text-slate-950 dark:text-white">{money(teacher.totalAllocated)}</div></div><div className="text-right"><div className="text-[10px] font-bold text-slate-500">{teacher.entries} entries</div><div className="mt-1 text-[10px] text-slate-400">Last · {teacher.lastAllocationDate || '—'}</div></div></div><div className="mt-3 flex items-center justify-between text-[11px] font-bold text-orange-600 dark:text-orange-300"><span>View allocation details</span><ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5"/></div></button>)}</div> : <ChartEmpty>No teacher allocation snapshots have been saved for this month.</ChartEmpty>}
    </section>

    {formOpen && <Modal wide title={editing ? 'Edit expense draft' : 'Record a new expense'} subtitle={editing ? 'Draft changes keep the same expense ID. Add an edit reason for the audit trail.' : 'Save as a draft or post the expense to the Academy financial ledger.'} onClose={() => { if (!saving) { setPostConfirmationOpen(false); setFormOpen(false); setEditing(null); } }}>
      <form onSubmit={(event) => { event.preventDefault(); if (editing || form.status === 'draft') void saveExpense('draft'); else setPostConfirmationOpen(true); }} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <FormField label="Expense title *"><input className={inputClass} value={form.title} onChange={(event) => setFormField('title', event.target.value)} required maxLength={140} placeholder="e.g. November electricity bill"/></FormField>
          <FormField label="Expense category *"><select className={inputClass} value={form.category} onChange={(event) => setFormField('category', event.target.value)}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></FormField>
          <FormField label="Amount (PKR) *"><input className={inputClass} type="number" min="0.01" max="100000000" step="0.01" value={form.amount} onChange={(event) => setFormField('amount', event.target.value)} required placeholder="0.00"/></FormField>
          <FormField label="Expense date *"><input className={inputClass} type="date" value={form.expenseDate} onChange={(event) => setFormField('expenseDate', event.target.value)} required/></FormField>
          <FormField label="Vendor / payee"><input className={inputClass} value={form.vendor} onChange={(event) => setFormField('vendor', event.target.value)} maxLength={120} placeholder="Supplier or recipient"/></FormField>
          <FormField label="Payment method"><select className={inputClass} value={form.paymentMethod} onChange={(event) => setFormField('paymentMethod', event.target.value)}>{PAYMENT_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></FormField>
          <FormField label="Reference number"><input className={inputClass} value={form.reference} onChange={(event) => setFormField('reference', event.target.value)} maxLength={100} placeholder="Receipt / bank reference"/></FormField>
          {!editing && <FormField label="Save status"><select className={inputClass} value={form.status} onChange={(event) => setFormField('status', event.target.value as 'posted' | 'draft')}><option value="posted">Post now</option><option value="draft">Save as draft</option></select></FormField>}
          <div className="md:col-span-2 xl:col-span-3"><FormField label="Description"><textarea className={`${inputClass} min-h-24 resize-y`} value={form.description} onChange={(event) => setFormField('description', event.target.value)} maxLength={1000} placeholder="Add context, invoice note or internal details…"/></FormField></div>
        </div>
        <div className="rounded-[24px] border border-orange-200/80 bg-gradient-to-br from-orange-50/80 to-white p-4 dark:border-orange-400/20 dark:from-orange-500/10 dark:to-slate-900 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.18em] text-orange-700 dark:text-orange-300"><Users className="h-4 w-4"/> Expense distribution</div><h3 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Allocate across active teachers</h3><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">A reporting allocation only. This does not deduct salary or create teacher payments.</p></div><span className="rounded-full border border-orange-200 bg-white/80 px-3 py-1.5 text-[10px] font-bold text-orange-700 dark:border-orange-400/20 dark:bg-slate-950/50 dark:text-orange-300">{teachers.length} active & verified</span></div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{[
            { value: 'none', title: 'No allocation', description: 'Keep the full expense unallocated', icon: Wallet },
            { value: 'all_active', title: 'All active teachers', description: 'Equal split across every eligible teacher', icon: Users },
            { value: 'selected_equal', title: 'Select teachers', description: 'Choose teachers for an equal split', icon: CheckCircle2 },
            { value: 'custom', title: 'Custom amounts', description: 'Set a different amount per teacher', icon: Landmark },
          ].map((option) => { const Icon = option.icon; const active = form.allocationMethod === option.value; return <button key={option.value} type="button" onClick={() => setForm((current) => ({ ...current, allocationMethod: option.value as AllocationMethod, selectedTeacherUids: option.value === 'all_active' ? [] : current.selectedTeacherUids, customAllocations: option.value === 'all_active' || option.value === 'none' ? {} : current.customAllocations }))} className={`rounded-2xl border p-3 text-left transition ${active ? 'border-orange-400 bg-white shadow-md shadow-orange-500/10 ring-2 ring-orange-100 dark:bg-slate-950/70 dark:ring-orange-500/10' : 'border-slate-200 bg-white/70 hover:border-orange-200 dark:border-white/10 dark:bg-slate-950/30'}`}><div className="flex items-center justify-between"><Icon className={`h-5 w-5 ${active ? 'text-orange-600' : 'text-slate-400'}`}/>{active && <CheckCircle2 className="h-4 w-4 text-orange-600"/>}</div><div className="mt-2 text-xs font-black text-slate-900 dark:text-white">{option.title}</div><div className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{option.description}</div></button>; })}</div>
          {form.allocationMethod === 'none' ? <div className="mt-4 flex items-center justify-between rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-xs dark:border-white/10 dark:bg-slate-950/30"><span className="font-bold text-slate-600 dark:text-slate-300">Unallocated expense amount</span><strong className="text-base font-black text-slate-950 dark:text-white">{money(form.amount ? amountNumber(form.amount) : 0)}</strong></div> : <>
            {form.allocationMethod !== 'all_active' && <div className="mt-4"><label className="mb-2 block text-xs font-extrabold text-slate-700 dark:text-slate-200">Search and select active teachers</label><TeacherPicker teachers={teachers} selected={form.selectedTeacherUids} onToggle={toggleTeacher}/></div>}
            {form.allocationMethod === 'all_active' && <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-xs leading-5 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200">All {teachers.length} active, verified teachers in this Academy will be revalidated by the server at save time. A new draft will be recalculated when it is posted.</div>}
            {form.allocationMethod === 'custom' && form.selectedTeacherUids.length > 0 && <div className="mt-4 space-y-2">{teachers.filter((teacher) => form.selectedTeacherUids.includes(teacher.uid)).map((teacher) => <div key={teacher.uid} className="grid grid-cols-[minmax(0,1fr)_minmax(120px,.65fr)] items-center gap-3 rounded-2xl border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-950/40"><div className="flex min-w-0 items-center gap-2"><TeacherAvatar teacher={teacher}/><span className="min-w-0"><span className="block truncate text-xs font-extrabold text-slate-900 dark:text-white">{teacher.name}</span><span className="block truncate text-[10px] text-slate-500">{teacher.designation || 'Teacher'}</span></span></div><input className={inputClass} type="number" min="0.01" step="0.01" placeholder="PKR amount" value={form.customAllocations[teacher.uid] || ''} onChange={(event) => setForm((current) => ({ ...current, customAllocations: { ...current.customAllocations, [teacher.uid]: event.target.value } }))}/></div>)}</div>}
            <div className="mt-4 grid gap-2 sm:grid-cols-3"><AllocationMetric label="Teachers selected" value={String(allocationPreview.rows.length)} /><AllocationMetric label="Allocated total" value={money(allocationPreview.allocated)}/><AllocationMetric label="Unallocated" value={money(allocationPreview.unallocated)}/></div>
            {allocationPreview.rows.length > 0 && <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white/90 dark:border-white/10 dark:bg-slate-950/40"><div className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-slate-100 px-4 py-2.5 text-[9px] font-black uppercase tracking-wider text-slate-400 dark:border-white/[0.06]"><span>Teacher snapshot</span><span>Allocation</span></div>{allocationPreview.rows.map((row) => <div key={row.teacher.uid} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-50 px-4 py-2.5 last:border-0 dark:border-white/[0.04]"><span className="truncate text-xs font-bold text-slate-700 dark:text-slate-200">{row.teacher.name}</span><strong className="text-xs font-black text-slate-950 dark:text-white">{money(row.amount)}</strong></div>)}</div>}
            {!allocationPreview.valid && <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-rose-600 dark:text-rose-300"><AlertCircle className="h-4 w-4"/>{allocationPreview.error}</p>}
          </>}
          {teachers.length === 0 && form.allocationMethod !== 'none' && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">No active, email-verified Academy teachers were returned. Choose No allocation or add/activate an eligible teacher.</p>}
          {teacherListLimited && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">The teacher directory is limited for safety. The server will reject an incomplete all-active allocation rather than silently omit teachers.</p>}
        </div>
        {editing && <FormField label="Reason for draft edit *"><textarea className={`${inputClass} min-h-20`} value={form.reason} onChange={(event) => setFormField('reason', event.target.value)} required maxLength={500} placeholder="Explain why this draft is being changed…"/></FormField>}
        <div className="flex flex-col-reverse justify-between gap-3 border-t border-slate-100 pt-4 dark:border-white/[0.06] sm:flex-row sm:items-center"><p className="max-w-md text-[10px] leading-4 text-slate-400">Posting records an Academy expense. Teacher allocation is only a cost-distribution snapshot and never creates a salary deduction.</p><div className="flex flex-wrap justify-end gap-2"><button type="button" className={buttonSecondary} onClick={() => { setPostConfirmationOpen(false); setFormOpen(false); setEditing(null); }} disabled={saving}>Cancel</button>{!editing && <button type="button" className={buttonSecondary} onClick={() => void saveExpense('draft')} disabled={saving || (form.allocationMethod !== 'none' && !allocationPreview.valid)}>{saving ? 'Saving…' : 'Save as Draft'}</button>}<button type="submit" className={buttonPrimary} disabled={saving || (form.allocationMethod !== 'none' && !allocationPreview.valid) || (editing && !form.reason.trim())}>{saving ? 'Saving…' : editing ? 'Save Draft Changes' : form.status === 'draft' ? 'Save Draft' : 'Review & Post Expense'}</button></div></div>
      </form>
    </Modal>}

    {postConfirmationOpen && <Modal title="Confirm expense posting" subtitle="Posting adds this expense to the Academy's posted financial totals. Posted records cannot be edited; corrections require a void with an audit reason." onClose={() => setPostConfirmationOpen(false)}>
      <div className="rounded-2xl border border-orange-200 bg-gradient-to-br from-orange-50 to-white p-4 dark:border-orange-400/20 dark:from-orange-500/10 dark:to-slate-900"><div className="text-sm font-black text-slate-950 dark:text-white">{form.title || 'Untitled expense'}</div><div className="mt-1 text-xs text-slate-500">{form.category} · {form.expenseDate}</div><div className="mt-3 text-2xl font-black tracking-tight text-orange-700 dark:text-orange-300">{money(amountNumber(form.amount))}</div><div className="mt-3 grid grid-cols-3 gap-2"><AllocationMetric label="Teachers" value={String(allocationPreview.rows.length)}/><AllocationMetric label="Allocated" value={money(allocationPreview.allocated)}/><AllocationMetric label="Unallocated" value={money(allocationPreview.unallocated)}/></div></div>
      <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">Teacher allocations are stored as a historical cost-allocation snapshot only. This action does not create payroll or teacher-payment records.</p>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className={buttonSecondary} onClick={() => setPostConfirmationOpen(false)} disabled={saving}>Review again</button><button type="button" className={buttonPrimary} onClick={() => { setPostConfirmationOpen(false); void saveExpense('posted'); }} disabled={saving || !allocationPreview.valid && form.allocationMethod !== 'none'}><CheckCircle2 className="h-4 w-4"/>{saving ? 'Posting…' : 'Confirm & Post Expense'}</button></div>
    </Modal>}

    {viewing && <Modal title="Expense details" subtitle="Persistent Academy expense record and its saved allocation snapshot." onClose={() => { setViewing(null); setAuditRows([]); setAuditError(''); }} wide><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[
      ['Expense title', viewing.title], ['Category', viewing.category], ['Amount', money(viewing.amount)], ['Expense date', viewing.expenseDate], ['Vendor / payee', viewing.vendor || '—'], ['Payment method', paymentLabel(viewing.paymentMethod)], ['Reference', viewing.reference || '—'], ['Status', viewing.status.toUpperCase()], ['Created by', viewing.createdByNameSnapshot || viewing.createdByUid || 'Unavailable'], ['Created at', viewing.createdAt || 'Unavailable'], ['Posted at', viewing.postedAt || 'Not posted'], ['Void reason', viewing.voidReason || '—'],
    ].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-100 bg-slate-50/80 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]"><div className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</div><div className="mt-1 break-words text-sm font-bold text-slate-900 dark:text-white">{value}</div></div>)}</div><div className="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-white/10"><div className="text-xs font-black text-slate-900 dark:text-white">Description</div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">{viewing.description || 'No description provided.'}</p></div><div className="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-white/10"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs font-black text-slate-900 dark:text-white">Teacher allocations</div><span className="text-xs font-black text-orange-600">{money(viewing.allocationTotal || 0)} allocated</span></div>{(viewing.teacherAllocations || []).length ? <div className="mt-3 space-y-2">{(viewing.teacherAllocations || []).map((item) => <div key={item.teacherUid} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 dark:bg-white/[0.04]"><span className="min-w-0"><span className="block truncate text-xs font-bold text-slate-800 dark:text-slate-200">{item.teacherNameSnapshot}</span><span className="block text-[10px] text-slate-500">{item.designationSnapshot || 'Teacher'} · Snapshot</span></span><strong className="text-xs font-black text-slate-950 dark:text-white">{money(item.allocatedAmount)}</strong></div>)}</div> : <p className="mt-3 text-xs text-slate-500">No teacher allocation was saved for this expense.</p>}<div className="mt-3 flex justify-between border-t border-slate-100 pt-3 text-xs dark:border-white/[0.06]"><span className="text-slate-500">Unallocated amount</span><strong className="font-black text-slate-900 dark:text-white">{money(viewing.unallocatedAmount ?? viewing.amount)}</strong></div></div><div className="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-white/10"><div className="flex items-center justify-between gap-3"><div className="text-xs font-black text-slate-900 dark:text-white">Audit history</div>{auditLoading && <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400"><LoaderCircle className="h-3 w-3 animate-spin"/> Loading</span>}</div>{auditError && <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">{auditError}</p>}{!auditLoading && !auditError && !auditRows.length && <p className="mt-2 text-xs text-slate-500">No separate audit events were returned for this expense.</p>}{auditRows.length > 0 && <div className="mt-3 space-y-2">{auditRows.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3 dark:bg-white/[0.04]"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] font-black uppercase tracking-wider text-orange-700 dark:text-orange-300">{String(row.event || 'expense.updated').replaceAll('.', ' ')}</span><span className="text-[10px] text-slate-400">{row.createdAt || 'Timestamp unavailable'}</span></div><div className="mt-1 text-[10px] text-slate-500">Actor: {row.actorNameSnapshot || row.actorUid || 'Unavailable'}{row.amount !== undefined ? ` · ${money(row.amount)}` : ''}{row.allocationCount !== undefined ? ` · ${row.allocationCount} teacher allocations` : ''}</div>{row.reason && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{row.reason}</p>}</div>)}</div>}{auditHistoryLimited && <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">Showing the latest 50 audit events.</p>}</div></Modal>}

    {teacherDetail && <Modal title={teacherDetail.name} subtitle={`Teacher expense allocations · ${labelMonth(month)}`} onClose={() => setTeacherDetail(null)}><div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.04]"><TeacherAvatar teacher={{ uid: teacherDetail.teacherUid, name: teacherDetail.name, photoUrl: teacherDetail.photoUrl, active: teacherDetail.isActive, emailVerified: true }}/><div className="min-w-0 flex-1"><div className="font-black text-slate-900 dark:text-white">{teacherDetail.name}</div><div className="text-xs text-slate-500">{teacherDetail.designation || 'Academy teacher'}</div><div className="mt-1 text-[10px] font-bold text-slate-500">{teacherDetail.isStatusUnknown ? 'Current status unavailable in the bounded directory' : teacherDetail.isActive ? 'Currently active' : 'Historical allocation snapshot'}</div></div><div className="text-right"><div className="text-[9px] font-black uppercase text-slate-400">Monthly total</div><div className="text-lg font-black text-orange-600">{money(teacherDetail.totalAllocated)}</div></div></div><div className="mt-4 space-y-2">{teacherDetail.expenses.map((item) => <div key={`${item.expenseId}-${item.expenseDate}`} className="rounded-2xl border border-slate-100 p-3 dark:border-white/[0.06]"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-black text-slate-900 dark:text-white">{item.title}</div><div className="mt-1 text-[10px] text-slate-500">{item.category} · {item.expenseDate} · {item.allocationMethod.replace('_', ' ')}</div></div><strong className="text-xs font-black text-slate-950 dark:text-white">{money(item.allocatedAmount)}</strong></div></div>)}</div><p className="mt-4 text-[10px] leading-4 text-slate-400">These values are expense allocation snapshots only. They do not represent payroll deductions or amounts paid to this teacher.</p></Modal>}

    {deleteTarget && <Modal title="Delete this draft?" subtitle="Draft deletion is permanent for the expense document; an audit snapshot is retained." onClose={() => { setDeleteTarget(null); setActionReason(''); }}><ConfirmRecord expense={deleteTarget} action="delete this draft" reason={actionReason} onReason={setActionReason}/><div className="mt-5 flex justify-end gap-2"><button className={buttonSecondary} type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="inline-flex items-center gap-2 rounded-2xl bg-rose-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50" disabled={saving || !actionReason.trim()} onClick={() => void runDeleteDraft()}><Trash2 className="h-4 w-4"/>{saving ? 'Deleting…' : 'Confirm delete draft'}</button></div></Modal>}
    {voidTarget && <Modal title="Void posted expense?" subtitle="The posted record and its teacher allocation snapshot will remain in history." onClose={() => { setVoidTarget(null); setActionReason(''); }}><ConfirmRecord expense={voidTarget} action="void this posted record" reason={actionReason} onReason={setActionReason}/><div className="mt-5 flex justify-end gap-2"><button className={buttonSecondary} type="button" onClick={() => setVoidTarget(null)}>Cancel</button><button className="inline-flex items-center gap-2 rounded-2xl bg-rose-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50" disabled={saving || !actionReason.trim()} onClick={() => void runVoid()}><XCircle className="h-4 w-4"/>{saving ? 'Voiding…' : 'Confirm void'}</button></div></Modal>}
    {postTarget && <Modal title="Post this expense draft?" subtitle="The draft will become part of the posted Academy expense register." onClose={() => { setPostTarget(null); setActionReason(''); }}><ConfirmRecord expense={postTarget} action="post this expense" reason={actionReason} onReason={setActionReason}/><div className="mt-5 flex justify-end gap-2"><button className={buttonSecondary} type="button" onClick={() => setPostTarget(null)}>Cancel</button><button className={buttonPrimary} type="button" disabled={saving || !actionReason.trim()} onClick={() => void runPostDraft()}><CheckCircle2 className="h-4 w-4"/>{saving ? 'Posting…' : 'Confirm post'}</button></div></Modal>}
  </div>;
}

function buildTeacherOverview(expenses: Expense[], teachers: Teacher[], teacherStatusComplete: boolean) {
  const current = new Map(teachers.map((teacher) => [teacher.uid, teacher]));
  const grouped = new Map<string, { teacherUid: string; name: string; designation: string; photoUrl: string; isActive: boolean; isStatusUnknown: boolean; totalCents: number; entries: number; lastAllocationDate: string; expenses: Array<{ expenseId: string; title: string; category: string; expenseDate: string; allocationMethod: string; allocatedAmount: number }> }>();
  for (const expense of expenses) {
    if (expense.status !== 'posted') continue;
    for (const allocation of expense.teacherAllocations || []) {
      const uid = allocation.teacherUid;
      if (!uid) continue;
      const live = current.get(uid);
      const row = grouped.get(uid) || { teacherUid: uid, name: allocation.teacherNameSnapshot || live?.name || 'Former teacher', designation: allocation.designationSnapshot || live?.designation || '', photoUrl: allocation.teacherPhotoUrlSnapshot || live?.photoUrl || '', isActive: Boolean(live?.active && live.emailVerified), isStatusUnknown: !live && !teacherStatusComplete, totalCents: 0, entries: 0, lastAllocationDate: '', expenses: [] };
      const valueCents = cents(Number(allocation.allocatedAmount || 0));
      row.totalCents += valueCents; row.entries += 1;
      if (expense.expenseDate > row.lastAllocationDate) row.lastAllocationDate = expense.expenseDate;
      row.expenses.push({ expenseId: expense.id, title: expense.title, category: expense.category, expenseDate: expense.expenseDate, allocationMethod: allocation.allocationMethod || expense.allocationMethod || 'custom', allocatedAmount: fromCents(valueCents) });
      grouped.set(uid, row);
    }
  }
  return [...grouped.values()].map((row) => ({ ...row, totalAllocated: fromCents(row.totalCents) })).sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name)).map(({ totalCents: _totalCents, ...row }) => row);
}

function HeroMetric({ label, value, icon: Icon, tone }: { label: string; value: string; icon: ElementType; tone: string }) {
  const tones: Record<string, string> = { orange: 'text-orange-600', amber: 'text-amber-600', rose: 'text-rose-600', blue: 'text-sky-600', green: 'text-emerald-600', violet: 'text-violet-600' };
  return <div className="rounded-[21px] border border-white/80 bg-white/85 p-3 shadow-[0_14px_34px_-26px_rgba(15,23,42,.35)] backdrop-blur dark:border-white/10 dark:bg-slate-950/45"><div className="flex items-center justify-between gap-2"><span className="text-[9px] font-black uppercase tracking-[.13em] text-slate-500 dark:text-slate-400">{label}</span><Icon className={`h-4 w-4 ${tones[tone] || tones.orange}`}/></div><div className="mt-2 break-words text-base font-black tracking-tight text-slate-950 dark:text-white sm:text-lg">{value}</div></div>;
}
function FormField({ label, children }: { label: string; children: ReactNode }) { return <label className="block space-y-2"><span className="block text-xs font-extrabold text-slate-700 dark:text-slate-300">{label}</span>{children}</label>; }
function AllocationMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-white/80 bg-white/85 px-3 py-2.5 dark:border-white/10 dark:bg-slate-950/40"><div className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</div><div className="mt-1 text-sm font-black text-slate-950 dark:text-white">{value}</div></div>; }
function TeacherAvatar({ teacher }: { teacher: { uid: string; name: string; photoUrl?: string; active?: boolean; emailVerified?: boolean } }) {
  return teacher.photoUrl ? <img src={teacher.photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-2xl border border-slate-200 object-cover dark:border-white/10"/> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-orange-100 to-amber-100 text-xs font-black text-orange-700 dark:from-orange-500/20 dark:to-amber-500/10 dark:text-orange-200">{teacher.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>;
}
function TeacherPicker({ teachers, selected, onToggle }: { teachers: Teacher[]; selected: string[]; onToggle: (uid: string) => void }) {
  const [query, setQuery] = useState('');
  const visible = teachers.filter((teacher) => `${teacher.name} ${teacher.designation || ''} ${teacher.email || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-950/30"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input className={`${inputClass} pl-10`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search active teachers…"/></div><div className="mt-3 grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">{visible.map((teacher) => { const active = selected.includes(teacher.uid); return <button key={teacher.uid} type="button" onClick={() => onToggle(teacher.uid)} className={`flex items-center gap-2 rounded-xl border p-2 text-left transition ${active ? 'border-orange-300 bg-orange-50 dark:border-orange-400/30 dark:bg-orange-500/10' : 'border-slate-100 hover:border-orange-200 dark:border-white/[0.06]'}`}><TeacherAvatar teacher={teacher}/><span className="min-w-0 flex-1"><span className="block truncate text-xs font-extrabold text-slate-900 dark:text-white">{teacher.name}</span><span className="block truncate text-[10px] text-slate-500">{teacher.designation || teacher.email || 'Active teacher'}</span></span><span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${active ? 'border-orange-500 bg-orange-500 text-white' : 'border-slate-300 text-transparent dark:border-white/20'}`}><Check className="h-3 w-3"/></span></button>; })}</div>{!visible.length && <p className="py-4 text-center text-xs text-slate-500">No matching active teachers found.</p>}<div className="mt-2 text-[10px] font-semibold text-slate-400">{selected.length} selected · Only active, email-verified teachers are listed.</div></div>;
}
function ExpenseCard({ expense, onView, onEdit, onDelete, onVoid, onPost }: { expense: Expense; onView: () => void; onEdit: () => void; onDelete: () => void; onVoid: () => void; onPost: () => void }) {
  const allocations = expense.teacherAllocations || [];
  const statusTone = statusBadge(expense.status);
  const CategoryIcon = categoryIconFor(expense.category);
  const allocationState = allocations.length === 0 ? 'Unallocated' : Number(expense.unallocatedAmount || 0) > 0 ? 'Partially allocated' : 'Allocated';
  return <article className="group relative overflow-hidden rounded-[25px] border border-slate-200/80 bg-white p-4 shadow-[0_15px_38px_-31px_rgba(15,23,42,.45)] transition hover:-translate-y-1 hover:border-orange-200 hover:shadow-[0_23px_48px_-30px_rgba(234,88,12,.22)] dark:border-white/[0.08] dark:bg-slate-900/85 dark:hover:border-orange-400/25"><div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-amber-400 to-orange-200 opacity-90"/><div className="flex items-start gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-[17px] bg-gradient-to-br from-orange-100 to-amber-100 text-orange-700 shadow-sm dark:from-orange-500/20 dark:to-amber-500/10 dark:text-orange-200"><CategoryIcon className="h-5 w-5"/></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="min-w-0 flex-1 truncate text-sm font-black text-slate-950 dark:text-white">{expense.title}</h4><span className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider ${statusTone}`}>{expense.status}</span><span className={`rounded-full border px-2.5 py-1 text-[9px] font-black ${allocationState === 'Allocated' ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/20 dark:bg-sky-500/10 dark:text-sky-300' : allocationState === 'Partially allocated' ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-300' : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400'}`}>{allocationState}</span></div><p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{expense.category} · {expense.expenseDate}</p></div></div><div className="mt-4 grid grid-cols-2 gap-2"><CardStat label="Total expense" value={money(expense.amount)} tone="orange"/><CardStat label="Allocated" value={allocations.length ? money(expense.allocationTotal || 0) : '—'} tone="blue"/><CardStat label="Unallocated" value={expense.allocationMethod === 'none' || !expense.allocationMethod ? money(expense.amount) : money(expense.unallocatedAmount || 0)} tone="amber"/><CardStat label="Teachers" value={allocations.length ? String(allocations.length) : '—'} tone="green"/></div><div className="mt-3 grid gap-1 text-[10px] text-slate-500 dark:text-slate-400">{expense.vendor && <div className="truncate"><span className="font-bold text-slate-600 dark:text-slate-300">Payee:</span> {expense.vendor}</div>}<div><span className="font-bold text-slate-600 dark:text-slate-300">Method:</span> {paymentLabel(expense.paymentMethod)}{expense.reference ? ` · Ref ${expense.reference}` : ''}</div>{expense.voidReason && <div className="line-clamp-2 text-rose-600 dark:text-rose-300">Void reason: {expense.voidReason}</div>}</div>{allocations.length > 0 && <details className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]"><summary className="cursor-pointer list-none text-[10px] font-extrabold text-slate-600 dark:text-slate-300">{allocations.length} teacher allocation snapshots · {expense.allocationMethod?.replace('_', ' ') || 'custom'} <span className="float-right">⌄</span></summary><div className="mt-2 space-y-1.5">{allocations.map((item) => <div key={item.teacherUid} className="flex items-center justify-between gap-2 text-[10px]"><span className="truncate text-slate-500">{item.teacherNameSnapshot}</span><strong className="text-slate-800 dark:text-slate-200">{money(item.allocatedAmount)}</strong></div>)}</div></details>}<div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-white/[0.06]"><button type="button" className={`${buttonSecondary} min-h-9 flex-1 px-3 py-2 text-[11px]`} onClick={onView}><Eye className="h-3.5 w-3.5"/> Details</button>{expense.status === 'draft' && <><button type="button" className={`${buttonSecondary} min-h-9 px-3 py-2 text-[11px]`} onClick={onEdit}><Pencil className="h-3.5 w-3.5"/> Edit</button><button type="button" className={`${buttonSecondary} min-h-9 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300`} onClick={onPost}><CheckCircle2 className="h-3.5 w-3.5"/> Post</button><button type="button" aria-label="Delete draft expense" className="grid h-9 w-9 place-items-center rounded-xl border border-rose-200 text-rose-600 transition hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-300 dark:hover:bg-rose-500/10" onClick={onDelete}><Trash2 className="h-4 w-4"/></button></>}{expense.status === 'posted' && <button type="button" className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-rose-200 px-3 py-2 text-[11px] font-extrabold text-rose-700 transition hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-300 dark:hover:bg-rose-500/10" onClick={onVoid}><XCircle className="h-3.5 w-3.5"/> Void</button>}</div></article>;
}
function CardStat({ label, value, tone }: { label: string; value: string; tone: string }) { const styles: Record<string, string> = { orange: 'text-orange-700 dark:text-orange-300', blue: 'text-sky-700 dark:text-sky-300', amber: 'text-amber-700 dark:text-amber-300', green: 'text-emerald-700 dark:text-emerald-300' }; return <div className="rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.03]"><div className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</div><div className={`mt-1 truncate text-xs font-black ${styles[tone] || styles.orange}`}>{value}</div></div>; }
function ChartEmpty({ children }: { children: ReactNode }) { return <div className="grid h-64 place-items-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-5 text-center text-xs font-medium text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">{children}</div>; }
function ChartLoading() { return <div className="grid h-64 place-items-center text-xs font-semibold text-slate-400"><LoaderCircle className="mb-2 h-6 w-6 animate-spin text-orange-500"/>Loading chart data…</div>; }
function DataWarning({ children }: { children: ReactNode }) { return <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0"/>{children}</div>; }
function EmptyLuxury({ icon: Icon, title, message, action }: { icon: ElementType; title: string; message: string; action?: ReactNode }) { return <div className="rounded-[24px] border border-dashed border-slate-200 bg-gradient-to-br from-slate-50 to-white px-5 py-12 text-center dark:border-white/10 dark:from-white/[0.03] dark:to-transparent"><span className="mx-auto grid h-14 w-14 place-items-center rounded-[20px] bg-orange-100 text-orange-600 dark:bg-orange-500/10 dark:text-orange-300"><Icon className="h-6 w-6"/></span><h4 className="mt-4 text-base font-black text-slate-900 dark:text-white">{title}</h4><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">{message}</p>{action && <div className="mt-4">{action}</div>}</div>; }
function ConfirmRecord({ expense, action, reason, onReason }: { expense: Expense; action: string; reason: string; onReason: (value: string) => void }) { return <><div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.04]"><div className="text-sm font-black text-slate-900 dark:text-white">{expense.title}</div><div className="mt-1 text-xs text-slate-500">{expense.category} · {expense.expenseDate} · {money(expense.amount)}</div><p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">You are about to {action}. This action is recorded against this Academy expense.</p></div><FormField label="Reason (required for audit)"><textarea className={`${inputClass} mt-2 min-h-24`} value={reason} onChange={(event) => onReason(event.target.value)} required maxLength={500} placeholder="Enter a clear reason…"/></FormField></>; }
function categoryIconFor(category: string): ElementType {
  const value = category.toLowerCase();
  if (/salary|staff|teacher/.test(value)) return Users;
  if (/rent|building|property/.test(value)) return Building2;
  if (/electric|power|utility|water/.test(value)) return Zap;
  if (/internet|phone|software|service/.test(value)) return Wifi;
  if (/book|learning|stationery|classroom/.test(value)) return BookOpen;
  if (/maintenance|repair|cleaning/.test(value)) return Wrench;
  if (/transport|travel/.test(value)) return Bus;
  if (/marketing|advertis/.test(value)) return Megaphone;
  if (/equipment|computer|furniture/.test(value)) return Monitor;
  if (/security/.test(value)) return ShieldCheck;
  if (/misc|other/.test(value)) return Package;
  if (/exam|academic/.test(value)) return GraduationCap;
  return Receipt;
}

function paymentLabel(value: string) { return PAYMENT_METHODS.find((method) => method.value === value)?.label || value || '—'; }
