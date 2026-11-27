import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft, BadgeCheck, Ban, BookOpen, CalendarDays, CheckCircle2, ChevronRight,
  CircleDollarSign, CreditCard, FilePlus2, Filter, GraduationCap, Info, Printer,
  RefreshCw, Search, ShieldAlert, Sparkles, Users, Wallet, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { auth } from '@/lib/firebase';
import { academyManagementRequest, collectAcademyFeePayment } from '@/lib/academyApi';
import {
  getClassInvoiceTotals, getExtraLineItems, getLineItemStatus, getPreviousBillingMonth,
  getStudentClassLineTotals, hasUnsupportedMonthlyBillingCycle, sumMonthlyEnrolmentPreview,
} from '@/lib/academyFeesDomain.mjs';
import {
  buttonClass, Empty, Field, inputClass, Loading, Notice, PageHeading, Panel,
  secondaryButtonClass, selectClass,
} from './AcademyAdminUI';
import './AcademyFeesPage.css';

type ExtraCharge = { id: string; label: string; amount: number; billingFrequency: 'one_time' | 'monthly'; appliesToMonth: string };
type Enrolment = {
  id?: string; classId: string; className?: string; classCode?: string; subjectId: string;
  subjectName: string; teacherUid: string; teacherName?: string; feeAmountMonthly: number;
  billingFrequency?: string; active?: boolean;
};
type Student = {
  id: string; name: string; rollNo: string; gender?: string; fatherName?: string; phone?: string;
  avatar?: string; avatarStoragePath?: string; primaryClassId?: string; status?: string;
  enrollments: Enrolment[]; feeAlertsWhatsAppOptIn?: boolean; extraCharges?: ExtraCharge[];
  extraChargesVersion?: number; createdAt?: string;
};
type Subject = { id: string; name: string; code?: string; monthlyFee?: number; active?: boolean; billingFrequency?: string; teacherUid?: string | null; teacherName?: string | null; assigned?: boolean };
type ClassRecord = { id: string; name: string; section?: string; classCode: string; status?: string; academicYear?: string; subjects?: Subject[]; subjectCount?: number };
type LineItem = { lineItemId: string; kind?: string; classId?: string; subjectId?: string; subjectName: string; amount: number; paidAmount: number; remainingBalance: number; teacherUid?: string; teacherName?: string };
type Invoice = {
  id: string; invoiceId: string; studentId: string; studentName: string; rollNo: string;
  billingMonth: string; totalAmount: number; paidAmount: number; remainingBalance: number;
  status: string; lineItems: LineItem[]; createdAt?: string; issuedAt?: string;
};
type Payment = {
  id: string; paymentId: string; invoiceId: string; studentId: string; amount: number;
  paymentMethod: string; paymentReference?: string; collectorEmail?: string;
  collectorRole?: string; createdAt?: string; allocations?: Array<{ classId?: string; subjectId?: string; amount: number }>;
};
type FeeStatus = 'PAID' | 'UNPAID' | 'PARTIAL' | 'NOT_INVOICED' | 'CANCELLED';
type ChargeDraft = { id: string; label: string; amount: string; billingFrequency: 'one_time' | 'monthly'; appliesToMonth: string };

const money = (value: number) => `PKR ${Number(value || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
const validMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const currentPakistanMonth = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
};
const monthLabel = (month: string) => {
  if (!validMonth(month)) return month;
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PK', { month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date(Date.UTC(year, monthNumber - 1, 15, 12)));
};
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `charge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const initials = (value: string) => value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'ST';
const isActiveStudent = (student: Student) => student.status !== 'archived' && student.status !== 'inactive';
const getStatus = (invoice: Invoice | undefined, classId: string): FeeStatus => {
  if (!invoice) return 'NOT_INVOICED';
  if (invoice.status === 'void') return 'CANCELLED';
  const totals = getStudentClassLineTotals(invoice, classId);
  if (!totals) return 'NOT_INVOICED';
  return getLineItemStatus(totals) as FeeStatus;
};
const statusClasses: Record<FeeStatus, string> = {
  PAID: 'fees-status-paid', UNPAID: 'fees-status-unpaid', PARTIAL: 'fees-status-partial', NOT_INVOICED: 'fees-status-empty', CANCELLED: 'fees-status-empty',
};
const statusLabel: Record<FeeStatus, string> = { PAID: 'Paid', UNPAID: 'Unpaid', PARTIAL: 'Partial', NOT_INVOICED: 'Not invoiced', CANCELLED: 'Cancelled' };

export default function AcademyFeesPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [month, setMonth] = useState(currentPakistanMonth);
  const [classSearch, setClassSearch] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  const [genderFilter, setGenderFilter] = useState<'all' | 'Male' | 'Female'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | FeeStatus>('all');
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedStudentId, setExpandedStudentId] = useState<string | null>(null);
  const [paymentInvoice, setPaymentInvoice] = useState<Invoice | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [cancelInvoiceTarget, setCancelInvoiceTarget] = useState<Invoice | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [extraChargeStudent, setExtraChargeStudent] = useState<Student | null>(null);
  const [showExtraChargePicker, setShowExtraChargePicker] = useState(false);
  const [chargeDrafts, setChargeDrafts] = useState<ChargeDraft[]>([]);
  const [chargeReason, setChargeReason] = useState('');
  const [showBillingNote, setShowBillingNote] = useState(false);
  const paymentOperationRef = useRef<{ basis: string; key: string } | null>(null);

  const load = useCallback(async (silent = false) => {
    const user = auth.currentUser;
    if (!user) { setError('Your Academy Admin session has expired. Sign in again.'); setLoading(false); return; }
    if (!silent) setLoading(true);
    setError('');
    try {
      const [studentResult, classResult, invoiceResult, paymentResult] = await Promise.all([
        academyManagementRequest<{ students: Student[] }>(user, { action: 'students' }),
        academyManagementRequest<{ classes: ClassRecord[] }>(user, { action: 'classes' }),
        academyManagementRequest<{ invoices: Invoice[] }>(user, { action: 'invoices' }),
        academyManagementRequest<{ payments: Payment[] }>(user, { action: 'payments' }),
      ]);
      setStudents((studentResult.students ?? []).filter(isActiveStudent));
      setClasses((classResult.classes ?? []).filter((item) => item.status !== 'archived' && item.status !== 'inactive'));
      setInvoices(invoiceResult.invoices ?? []);
      setPayments(paymentResult.payments ?? []);
      const limits: string[] = [];
      if ((classResult.classes ?? []).length >= 300) limits.push('classes (300)');
      if ((studentResult.students ?? []).length >= 500) limits.push('students (500)');
      if ((invoiceResult.invoices ?? []).length >= 500) limits.push('invoices (500)');
      if ((paymentResult.payments ?? []).length >= 1000) limits.push('payments (1,000)');
      if (limits.length) setError(`Finance data reached an API safety limit: ${limits.join(', ')}. Some records may be outside this response; do not treat displayed totals as complete until the records are reviewed.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Finance records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCurrentPage(1); setExpandedStudentId(null); }, [month, genderFilter, statusFilter, studentSearch]);

  const selectedClass = useMemo(() => classes.find((item) => item.id === selectedClassId) ?? null, [classes, selectedClassId]);
  const visibleClasses = useMemo(() => {
    const query = classSearch.trim().toLowerCase();
    return classes.filter((item) => !query || `${item.name} ${item.section ?? ''} ${item.classCode}`.toLowerCase().includes(query));
  }, [classes, classSearch]);
  const previousMonth = useMemo(() => { try { return getPreviousBillingMonth(month); } catch { return ''; } }, [month]);

  const currentInvoiceByStudent = useMemo(() => new Map(
    invoices.filter((invoice) => invoice.billingMonth === month).map((invoice) => [invoice.studentId, invoice]),
  ), [invoices, month]);
  const previousInvoiceByStudent = useMemo(() => new Map(
    invoices.filter((invoice) => invoice.billingMonth === previousMonth && invoice.status !== 'void').map((invoice) => [invoice.studentId, invoice]),
  ), [invoices, previousMonth]);

  const classStudents = useMemo(() => {
    if (!selectedClass) return [];
    return students.filter((student) => student.primaryClassId === selectedClass.id || (student.enrollments ?? []).some((item) => item.classId === selectedClass.id));
  }, [students, selectedClass]);

  const visibleStudents = useMemo(() => {
    if (!selectedClass) return [];
    const query = studentSearch.trim().toLowerCase();
    return classStudents.filter((student) => {
      const status = getStatus(currentInvoiceByStudent.get(student.id), selectedClass.id);
      const gender = String(student.gender ?? '').toLowerCase();
      const matchesGender = genderFilter === 'all' || gender === genderFilter.toLowerCase();
      const matchesStatus = statusFilter === 'all' || status === statusFilter;
      const matchesSearch = !query || `${student.name} ${student.rollNo} ${student.id} ${student.fatherName ?? ''}`.toLowerCase().includes(query);
      return matchesGender && matchesStatus && matchesSearch;
    }).sort((a, b) => String(a.rollNo).localeCompare(String(b.rollNo), undefined, { numeric: true, sensitivity: 'base' }));
  }, [classStudents, selectedClass, currentInvoiceByStudent, genderFilter, statusFilter, studentSearch]);

  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(visibleStudents.length / pageSize));
  const pageStudents = visibleStudents.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const selectedStats = useMemo(() => {
    if (!selectedClass) return null;
    let billed = 0; let collected = 0; let pending = 0; let previousDues = 0;
    let hasCurrentAssessment = false; let hasPreviousAssessment = false;
    let paidCount = 0; let unpaidCount = 0; let partialCount = 0; let notInvoicedCount = 0;
    for (const student of classStudents) {
      const invoice = currentInvoiceByStudent.get(student.id);
      const isCancelled = invoice?.status === 'void';
      const totals = invoice && !isCancelled ? getStudentClassLineTotals(invoice, selectedClass.id) : null;
      const status: FeeStatus = isCancelled ? 'CANCELLED' : getLineItemStatus(totals) as FeeStatus;
      if (totals) {
        hasCurrentAssessment = true;
        billed += totals.billed; collected += totals.paid; pending += totals.due;
      }
      if (status === 'PAID') paidCount++;
      else if (status === 'UNPAID') unpaidCount++;
      else if (status === 'PARTIAL') partialCount++;
      else notInvoicedCount++;
      const prevInvoice = previousInvoiceByStudent.get(student.id);
      const prevTotals = prevInvoice ? getStudentClassLineTotals(prevInvoice, selectedClass.id) : null;
      if (prevTotals) { hasPreviousAssessment = true; previousDues += prevTotals.due; }
    }
    return {
      students: classStudents.length, paidCount, unpaidCount, partialCount, notInvoicedCount,
      billed: hasCurrentAssessment ? billed : null,
      collected: hasCurrentAssessment ? collected : null,
      pending: hasCurrentAssessment ? pending : null,
      previousDues: hasPreviousAssessment ? previousDues : null,
    };
  }, [selectedClass, classStudents, currentInvoiceByStudent, previousInvoiceByStudent]);

  const directoryStats = useMemo(() => {
    const enrolledIds = new Set(students.flatMap((student) => (student.enrollments ?? []).map((item) => item.classId)));
    const currentTotals = classes.map((item) => getClassInvoiceTotals(invoices, item.id, month)).filter(Boolean);
    const billedAvailable = currentTotals.length > 0;
    return {
      classes: classes.length,
      students: students.length,
      billed: billedAvailable ? currentTotals.reduce((sum, row) => sum + (row?.billed ?? 0), 0) : null,
      collected: billedAvailable ? currentTotals.reduce((sum, row) => sum + (row?.paid ?? 0), 0) : null,
      classesWithEnrolments: enrolledIds.size,
    };
  }, [classes, students, invoices, month]);

  const generateInvoice = async (student: Student) => {
    const user = auth.currentUser;
    if (!user || !selectedClass) return;
    if (!student.enrollments?.length) { toast.error('No active subject enrolments', { description: 'This student has no active subject enrolments to invoice.' }); return; }
    if (hasUnsupportedMonthlyBillingCycle(student.enrollments)) {
      toast.error('Billing schedule needs configuration', { description: 'This student has termly/yearly subjects. The current central invoice engine only has a verified monthly schedule; no invoice was created.' });
      return;
    }
    setBusy(`invoice:${student.id}`); setError(''); setMessage('');
    try {
      await academyManagementRequest(user, { action: 'generate-invoice', studentId: student.id, month });
      toast.success('Invoice issued', { description: `The consolidated invoice for ${student.name} is ready for ${monthLabel(month)}.` });
      await load(true);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Invoice could not be generated.';
      setError(text); toast.error('Invoice not issued', { description: text });
    } finally { setBusy(''); }
  };

  const openPayment = (invoice: Invoice) => {
    setPaymentInvoice(invoice);
    setPaymentAmount(String(invoice.remainingBalance));
    setPaymentReference('');
    setPaymentMethod('cash');
    paymentOperationRef.current = null;
  };

  const submitPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user || !paymentInvoice) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > paymentInvoice.remainingBalance) {
      setError(`Enter an amount greater than zero and no more than ${money(paymentInvoice.remainingBalance)}.`);
      return;
    }
    const basis = `${paymentInvoice.invoiceId || paymentInvoice.id}|${amount.toFixed(2)}|${paymentMethod}|${paymentReference.trim()}`;
    if (!paymentOperationRef.current || paymentOperationRef.current.basis !== basis) {
      paymentOperationRef.current = { basis, key: makeId() };
    }
    setBusy(`payment:${paymentInvoice.id}`); setError('');
    try {
      const result = await collectAcademyFeePayment(user, {
        invoiceId: paymentInvoice.invoiceId || paymentInvoice.id,
        amount, paymentMethod, paymentReference: paymentReference.trim(),
        idempotencyKey: paymentOperationRef.current.key,
      });
      setPaymentInvoice(null); setPaymentAmount(''); setPaymentReference(''); paymentOperationRef.current = null;
      toast.success(result.duplicate ? 'Payment already recorded' : 'Payment posted', { description: 'The central Academy invoice and payment ledger have been refreshed.' });
      await load(true);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Payment could not be posted. Retry with the same details to safely reuse the operation key.';
      setError(text); toast.error('Payment result needs review', { description: text });
      // Keep the same operation key after an ambiguous failure. A retry with unchanged details is idempotent.
    } finally { setBusy(''); }
  };

  const cancelInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user || !cancelInvoiceTarget || !cancelReason.trim()) return;
    setBusy(`cancel:${cancelInvoiceTarget.id}`); setError('');
    try {
      await academyManagementRequest(user, { action: 'cancel-invoice', invoiceId: cancelInvoiceTarget.invoiceId || cancelInvoiceTarget.id, reason: cancelReason.trim() });
      setCancelInvoiceTarget(null); setCancelReason('');
      toast.success('Invoice cancelled', { description: 'The zero-payment invoice was voided with an audit reason; no payment history was deleted.' });
      await load(true);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Invoice could not be cancelled.';
      setError(text); toast.error('Invoice was not cancelled', { description: text });
    } finally { setBusy(''); }
  };

  const openExtraCharges = (student: Student) => {
    const existing = (student.extraCharges ?? []).map((item, index) => ({
      id: item.id || `legacy-${index}-${makeId().slice(0, 8)}`,
      label: String(item.label ?? ''),
      amount: String(item.amount ?? ''),
      billingFrequency: item.billingFrequency === 'monthly' ? 'monthly' : 'one_time',
      appliesToMonth: item.appliesToMonth || '',
    } as ChargeDraft));
    setExtraChargeStudent(student);
    setChargeDrafts(existing);
    setChargeReason('');
  };

  const saveExtraCharges = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user || !extraChargeStudent || !chargeReason.trim()) return;
    const charges = chargeDrafts.map((charge) => ({
      id: charge.id, label: charge.label.trim(), amount: Number(charge.amount),
      billingFrequency: charge.billingFrequency,
      appliesToMonth: charge.billingFrequency === 'one_time' ? charge.appliesToMonth : '',
    }));
    setBusy(`extras:${extraChargeStudent.id}`); setError('');
    try {
      await academyManagementRequest(user, {
        action: 'update-student-extra-charges', studentId: extraChargeStudent.id,
        expectedVersion: Number(extraChargeStudent.extraChargesVersion ?? 0), extraCharges: charges,
        reason: chargeReason.trim(),
      });
      setExtraChargeStudent(null); setChargeDrafts([]);
      toast.success('Extra charges updated', { description: 'These charges affect future invoices only. Issued invoices and receipts remain unchanged.' });
      await load(true);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Extra charges could not be saved.';
      setError(text); toast.error('Extra charges not saved', { description: text });
    } finally { setBusy(''); }
  };

  const activeFeeAlertsConsent = classStudents.filter((student) => student.feeAlertsWhatsAppOptIn === true).length;
  const openExtraChargePicker = () => setShowExtraChargePicker(true);

  const printReport = () => {
    if (!selectedClass) return;
    window.print();
  };

  const classDetail = selectedClass && selectedStats;

  return <div className="academy-fees-page">
    <div className="academy-fees-screen-only">
      <PageHeading
        eyebrow="ACADEMY MANAGEMENT · FINANCE"
        title="Fees & Collections"
        description="Class-wise fee register backed by the Academy's consolidated invoice and payment ledger."
        action={<div className="flex flex-wrap gap-2">
          {selectedClass && <button type="button" className={secondaryButtonClass} onClick={printReport}><Printer className="h-4 w-4"/> Print Report</button>}
          {selectedClass && <button type="button" className={secondaryButtonClass} onClick={openExtraChargePicker} disabled={!classStudents.length}><Wallet className="h-4 w-4"/> Extra Charges</button>}
          <button type="button" className={secondaryButtonClass} onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}/> Refresh</button>
        </div>}
      />
      {error && <Notice>{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
    </div>

    <div className="fees-hero no-print">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-2xl">
          <div className="fees-kicker"><Sparkles className="h-3.5 w-3.5"/> EDU TRACK FINANCE REGISTER</div>
          <h2>{selectedClass ? `${selectedClass.name}${selectedClass.section ? ` · ${selectedClass.section}` : ''}` : 'Fee collection, clearly organised.'}</h2>
          <p>{selectedClass ? `Class ${selectedClass.classCode} · Billing period ${monthLabel(month)} · Consolidated Academy invoice ledger` : 'Choose a class to review actual invoices, payments, previous balances and subject tuition.'}</p>
        </div>
        <div className="fees-month-control">
          <label htmlFor="fees-month">Billing month</label>
          <input id="fees-month" type="month" value={month} onChange={(event) => { if (validMonth(event.target.value)) setMonth(event.target.value); }} className={inputClass}/>
        </div>
      </div>
      <div className="fees-hero-metrics">
        <div><span>{selectedClass ? 'Students' : 'Active Classes'}</span><strong>{selectedClass ? selectedStats?.students ?? 0 : directoryStats.classes}</strong></div>
        <div><span>{selectedClass ? 'Paid' : 'Active Students'}</span><strong>{selectedClass ? selectedStats?.paidCount ?? 0 : directoryStats.students}</strong></div>
        <div><span>{selectedClass ? 'Collected' : 'Collected · Month'}</span><strong>{selectedClass ? (selectedStats?.collected === null ? '—' : money(selectedStats?.collected ?? 0)) : (directoryStats.collected === null ? '—' : money(directoryStats.collected ?? 0))}</strong></div>
        <div><span>{selectedClass ? 'Pending Dues' : 'Invoiced · Month'}</span><strong>{selectedClass ? (selectedStats?.pending === null ? '—' : money(selectedStats?.pending ?? 0)) : (directoryStats.billed === null ? '—' : money(directoryStats.billed))}</strong></div>
      </div>
    </div>

    {loading ? <Panel><Loading label="Loading Academy classes, students, invoices and payments…"/></Panel> : !selectedClass ? <>
      <section className="fees-directory-tools no-print">
        <div>
          <div className="fees-section-kicker">01 / CLASS DIRECTORY</div>
          <h2>Select Class & Month</h2>
          <p>Open a class to inspect its student fee register. No class is selected automatically.</p>
        </div>
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-slate-400"/>
          <input className={`${inputClass} pl-10`} value={classSearch} onChange={(event) => setClassSearch(event.target.value)} placeholder="Search by class name or code…" aria-label="Search classes"/>
        </div>
      </section>
      {classes.length === 0 ? <Panel><Empty>No active Academy classes were returned. Create or activate a class in Classes & Subjects first.</Empty></Panel> : visibleClasses.length === 0 ? <Panel><Empty>No classes match your search.</Empty></Panel> : <div className="fees-class-grid no-print">
        {visibleClasses.map((item) => {
          const enrolled = students.filter((student) => student.primaryClassId === item.id || (student.enrollments ?? []).some((row) => row.classId === item.id));
          const subjects = (item.subjects ?? []).filter((subject) => subject.active !== false);
          const invoiceTotals = getClassInvoiceTotals(invoices, item.id, month);
          const monthlyEstimate = enrolled.reduce((sum, student) => sum + sumMonthlyEnrolmentPreview(student.enrollments, item.id), 0);
          const hasNonMonthly = enrolled.some((student) => hasUnsupportedMonthlyBillingCycle(student.enrollments.filter((row) => row.classId === item.id)));
          return <button type="button" key={item.id} className="fees-class-card text-left" onClick={() => { setSelectedClassId(item.id); setStudentSearch(''); setGenderFilter('all'); setStatusFilter('all'); setCurrentPage(1); }}>
            <div className="flex items-start justify-between gap-3">
              <div className="fees-class-icon"><BookOpen className="h-6 w-6"/></div>
              <span className={`fees-state-pill ${item.status === 'active' ? 'fees-status-paid' : 'fees-status-partial'}`}>{item.status || 'Available'}</span>
            </div>
            <div className="mt-4">
              <h3>{item.name}{item.section ? ` ${item.section}` : ''}</h3>
              <p className="fees-class-code">Code: {item.classCode || item.id}</p>
            </div>
            <div className="fees-class-stats">
              <div><span>ENROLLED</span><strong><Users className="h-4 w-4"/>{enrolled.length}</strong></div>
              <div><span>SUBJECTS</span><strong><BookOpen className="h-4 w-4"/>{subjects.length}</strong></div>
              <div><span>MONTHLY PREVIEW</span><strong>{monthlyEstimate === null || (hasNonMonthly && monthlyEstimate === 0) ? '—' : money(monthlyEstimate)}</strong></div>
              <div><span>COLLECTED · {month}</span><strong>{invoiceTotals ? money(invoiceTotals.paid) : '—'}</strong></div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs font-extrabold text-orange-700 dark:border-white/10 dark:text-orange-300">
              <span>Open Fee Register</span><ChevronRight className="h-4 w-4"/>
            </div>
          </button>;
        })}
      </div>}
      <div className="fees-info-note no-print"><Info className="h-4 w-4 shrink-0"/><span>Class-card collection totals use invoice line items assigned to that class. Missing invoice history is shown as unavailable rather than being treated as a verified zero.</span></div>
    </> : <>
      <div className="fees-register-top no-print">
        <button type="button" className={secondaryButtonClass} onClick={() => { setSelectedClassId(null); setStudentSearch(''); setExpandedStudentId(null); }}><ArrowLeft className="h-4 w-4"/> Back to Classes</button>
        <div className="min-w-0 flex-1">
          <div className="fees-section-kicker">02 / CLASS FEE REGISTER</div>
          <h2>{selectedClass.name}{selectedClass.section ? ` · ${selectedClass.section}` : ''}</h2>
          <p>{selectedClass.classCode} · {monthLabel(month)} · {selectedClass.academicYear || 'Academic year not specified'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => setShowBillingNote(true)}><Info className="h-4 w-4"/> Billing Rules</button>
          <button type="button" className={secondaryButtonClass} onClick={printReport}><Printer className="h-4 w-4"/> Print Report</button>
        </div>
      </div>

      <section className="fees-summary-grid no-print">
        <div className="fees-summary-card tone-orange"><span>STUDENTS</span><strong>{selectedStats?.students ?? '—'}</strong></div>
        <div className="fees-summary-card tone-green"><span>PAID</span><strong>{selectedStats?.paidCount ?? '—'}</strong></div>
        <div className="fees-summary-card tone-rose"><span>UNPAID</span><strong>{selectedStats?.unpaidCount ?? '—'}</strong></div>
        <div className="fees-summary-card tone-amber"><span>PARTIAL</span><strong>{selectedStats?.partialCount ?? '—'}</strong></div>
        <div className="fees-summary-card tone-blue"><span>COLLECTED</span><strong>{selectedStats?.collected === null ? '—' : money(selectedStats?.collected ?? 0)}</strong></div>
        <div className="fees-summary-card tone-amber"><span>PENDING DUES</span><strong>{selectedStats?.pending === null ? '—' : money(selectedStats?.pending ?? 0)}</strong></div>
        <div className="fees-summary-card tone-violet"><span>PREV. MONTH DUES</span><strong>{selectedStats?.previousDues === null ? '—' : money(selectedStats?.previousDues ?? 0)}</strong></div>
      </section>
      {(selectedStats?.partialCount ?? 0) > 0 && <div className="fees-info-note no-print"><Info className="h-4 w-4 shrink-0"/><span>{selectedStats?.partialCount} student(s) have partial payments. Partial balances remain tied to their issued invoice.</span></div>}

      <section className="fees-filter-panel no-print">
        <div className="fees-filter-title"><Filter className="h-4 w-4"/> Filters</div>
        <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.5fr)_1fr_1fr]">
          <div className="relative"><Search className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-slate-400"/><input className={`${inputClass} pl-10`} value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Search student, roll or ID…"/></div>
          <Field label="Gender"><select className={selectClass} value={genderFilter} onChange={(event) => setGenderFilter(event.target.value as typeof genderFilter)}><option value="all">All genders</option><option value="Male">Male</option><option value="Female">Female</option></select></Field>
          <Field label="Fee status"><select className={selectClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All students</option><option value="PAID">Paid</option><option value="UNPAID">Unpaid</option><option value="PARTIAL">Partial</option><option value="NOT_INVOICED">Not invoiced</option><option value="CANCELLED">Cancelled</option></select></Field>
        </div>
      </section>

      <section className="fees-student-list">
        <div className="fees-list-heading no-print"><div><div className="fees-section-kicker">STUDENT LEDGER</div><h3>Fee register</h3><p>{visibleStudents.length} matching students · {monthLabel(month)}</p></div><div className="flex flex-wrap gap-2">
          <button type="button" className="fees-bulk-button" disabled title="Bulk settlement is disabled because an invoice can contain subjects from multiple classes. Collect the consolidated invoice to avoid charging another class by mistake."><CheckCircle2 className="h-4 w-4"/> Mark All Paid</button>
          <button type="button" className="fees-bulk-button is-muted" disabled title="Invoice status is ledger-derived. Paid receipts cannot be reversed by a Mark All Unpaid action."><Ban className="h-4 w-4"/> Mark All Unpaid</button>
        </div></div>
        {pageStudents.length === 0 ? <Empty>No students match these filters. Clear a filter or verify active subject enrolments in the Students module.</Empty> : <div className="space-y-3">
          {pageStudents.map((student) => {
            const invoice = currentInvoiceByStudent.get(student.id);
            const lineTotals = invoice ? getStudentClassLineTotals(invoice, selectedClass.id) : null;
            const status = getStatus(invoice, selectedClass.id);
            const previousInvoice = previousInvoiceByStudent.get(student.id);
            const previousTotals = previousInvoice ? getStudentClassLineTotals(previousInvoice, selectedClass.id) : null;
            const classEnrollments = (student.enrollments ?? []).filter((row) => row.classId === selectedClass.id);
            const monthlyPreview = sumMonthlyEnrolmentPreview(classEnrollments, selectedClass.id);
            const nonMonthly = hasUnsupportedMonthlyBillingCycle(classEnrollments);
            const extras = invoice ? getExtraLineItems(invoice) : [];
            const studentPayments = invoice ? payments.filter((payment) => payment.invoiceId === (invoice.invoiceId || invoice.id)) : [];
            const canPay = Boolean(invoice && invoice.status !== 'void' && invoice.remainingBalance > 0);
            return <article className="fees-student-card" key={student.id}>
              <div className="fees-student-main">
                <div className="fees-avatar">{student.avatar ? <img src={student.avatar} alt=""/> : <span>{initials(student.name)}</span>}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h4>{student.name}</h4><span className={`fees-state-pill ${statusClasses[status]}`}>{statusLabel[status]}</span></div>
                  <p>Roll {student.rollNo || '—'} · {student.gender || 'Gender not recorded'}{student.fatherName ? ` · Guardian: ${student.fatherName}` : ''}</p>
                  <div className="fees-subject-chips">{classEnrollments.map((item) => <span key={`${item.classId}:${item.subjectId}`}>{item.subjectName}</span>)}</div>
                  <div className="fees-student-meta">{nonMonthly ? <span className="text-amber-700 dark:text-amber-300">Non-monthly billing cycle needs schedule</span> : <span>Monthly subject preview {money(monthlyPreview)}</span>}{student.extraCharges?.length ? <span>{student.extraCharges.length} extra charge(s)</span> : null}</div>
                </div>
                <div className="fees-student-amounts">
                  <div><span>CLASS FEE DUE</span><strong>{lineTotals ? money(lineTotals.billed) : '—'}</strong></div>
                  <div><span>COLLECTED</span><strong className="text-emerald-700 dark:text-emerald-300">{lineTotals ? money(lineTotals.paid) : '—'}</strong></div>
                  <div><span>PREV. DUE</span><strong>{previousTotals ? money(previousTotals.due) : '—'}</strong></div>
                </div>
                <div className="fees-student-actions no-print">
                  {invoice ? <>
                    {canPay && <button type="button" className={buttonClass} onClick={() => openPayment(invoice)}><CreditCard className="h-4 w-4"/> Pay Dues</button>}
                    {invoice.status === 'void' ? <span className="fees-state-pill fees-status-empty">Cancelled</span> : invoice.paidAmount === 0 && <button type="button" className={secondaryButtonClass} onClick={() => { setCancelInvoiceTarget(invoice); setCancelReason(''); }}><Ban className="h-4 w-4"/> Cancel</button>}
                  </> : <button type="button" className={buttonClass} disabled={busy === `invoice:${student.id}` || nonMonthly || !classEnrollments.length} onClick={() => void generateInvoice(student)}><FilePlus2 className="h-4 w-4"/>{busy === `invoice:${student.id}` ? 'Creating…' : 'Generate Invoice'}</button>}
                  <button type="button" className={secondaryButtonClass} onClick={() => openExtraCharges(student)}><Wallet className="h-4 w-4"/> Extras</button>
                  {invoice && <button type="button" className={secondaryButtonClass} onClick={() => setExpandedStudentId((value) => value === student.id ? null : student.id)}>{expandedStudentId === student.id ? 'Hide History' : 'History'}</button>}
                </div>
              </div>
              {invoice && (expandedStudentId === student.id) && <div className="fees-student-history">
                <div className="fees-history-grid">
                  <div><span>CONSOLIDATED INVOICE</span><strong>{money(invoice.totalAmount)}</strong><small>{invoice.invoiceId || invoice.id} · {invoice.billingMonth}</small></div>
                  <div><span>INVOICE BALANCE</span><strong>{money(invoice.remainingBalance)}</strong><small>{invoice.status}</small></div>
                  <div><span>EXTRA CHARGES</span><strong>{extras.length ? money(extras.reduce((sum, item) => sum + Number(item.amount || 0), 0)) : '—'}</strong><small>Included in invoice snapshot, not added twice</small></div>
                </div>
                <div className="mt-4"><h5>Invoice line items</h5><div className="mt-2 space-y-2">{(invoice.lineItems ?? []).map((item) => <div className="fees-line-item" key={item.lineItemId}><span>{item.subjectName}{item.kind === 'extra_charge' ? ' · Extra' : ''}</span><strong>{money(item.amount)}</strong><span>Paid {money(item.paidAmount)}</span><span>Due {money(item.remainingBalance)}</span></div>)}</div></div>
                <div className="mt-4"><h5>Payment history</h5>{studentPayments.length === 0 ? <p className="mt-2 text-xs text-slate-500">No payment receipts are recorded for this invoice.</p> : <div className="mt-2 space-y-2">{studentPayments.map((payment) => <div key={payment.id} className="fees-line-item"><span>{payment.createdAt ? new Date(payment.createdAt).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) : 'Date unavailable'}</span><strong>{money(payment.amount)}</strong><span>{payment.paymentMethod}</span><span>{payment.paymentReference || payment.paymentId || payment.id}</span></div>)}</div>}</div>
              </div>}
            </article>;
          })}
        </div>}
        <div className="fees-pagination no-print"><span>Showing {visibleStudents.length ? (currentPage - 1) * pageSize + 1 : 0} to {Math.min(currentPage * pageSize, visibleStudents.length)} of {visibleStudents.length} students</span><div><button type="button" className={secondaryButtonClass} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1}>Previous</button><strong>{currentPage}/{pageCount}</strong><button type="button" className={secondaryButtonClass} onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))} disabled={currentPage >= pageCount}>Next</button></div></div>
      </section>

      <section className="fees-reminder-panel no-print">
        <div className="fees-reminder-icon"><ShieldAlert className="h-5 w-5"/></div>
        <div className="min-w-0 flex-1"><h3>WhatsApp Fee Alerts</h3><p>{activeFeeAlertsConsent} student(s) in this class currently have a saved Fee Alerts consent flag. The scheduled reminder worker still reads its legacy teacher-workspace settings and ledger; this Academy Admin page does not change that schedule.</p></div>
        <span className="fees-state-pill fees-status-empty">Schedule managed in existing worker</span>
      </section>
      <div className="fees-info-note no-print"><Info className="h-4 w-4 shrink-0"/><span>Class totals are scoped to invoice lines carrying this class ID. A payment action settles the full consolidated student invoice, which may include another class or extra charges; the modal shows that full balance before posting.</span></div>
    </>}

    {/* Print-only class summary and register. Browser Print can save this report as a multi-page PDF. */}
    {selectedClass && selectedStats && <section className="fees-print-report">
      <div className="fees-print-heading"><div><div className="text-xs font-bold uppercase tracking-widest">EduTrack · Academy Finance</div><h1>Fees Register</h1><p>{selectedClass.name} {selectedClass.section ?? ''} · {selectedClass.classCode} · {monthLabel(month)}</p></div><div className="text-right text-xs">Generated {new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}<br/>Timezone: Asia/Karachi</div></div>
      <div className="fees-print-stats"><span>Students: {selectedStats.students}</span><span>Paid: {selectedStats.paidCount}</span><span>Unpaid: {selectedStats.unpaidCount}</span><span>Partial: {selectedStats.partialCount}</span><span>Collected: {selectedStats.collected === null ? 'Unavailable' : money(selectedStats.collected)}</span><span>Pending: {selectedStats.pending === null ? 'Unavailable' : money(selectedStats.pending)}</span><span>Previous dues: {selectedStats.previousDues === null ? 'Unavailable' : money(selectedStats.previousDues)}</span></div>
      <table className="fees-print-table"><thead><tr><th>Student</th><th>Roll</th><th>Subjects</th><th>Billed</th><th>Paid</th><th>Remaining</th><th>Status</th></tr></thead><tbody>
        {classStudents.map((student) => {
          const invoice = currentInvoiceByStudent.get(student.id);
          const totals = invoice ? getStudentClassLineTotals(invoice, selectedClass.id) : null;
          const status = getStatus(invoice, selectedClass.id);
          return <tr key={student.id}><td>{student.name}</td><td>{student.rollNo || '—'}</td><td>{(student.enrollments ?? []).filter((row) => row.classId === selectedClass.id).map((row) => row.subjectName).join(', ') || '—'}</td><td>{totals ? money(totals.billed) : '—'}</td><td>{totals ? money(totals.paid) : '—'}</td><td>{totals ? money(totals.due) : '—'}</td><td>{statusLabel[status]}</td></tr>;
        })}
      </tbody></table>
      <p className="fees-print-footnote">Financial values are based on saved central invoice line-item snapshots. Unissued amounts are not represented as confirmed dues. Previously issued invoices, payments and receipts are not recalculated by this report.</p>
    </section>}

    {paymentInvoice && <div className="fees-modal-backdrop no-print"><div role="dialog" aria-modal="true" aria-labelledby="fees-payment-title" className="fees-modal">
      <div className="fees-modal-heading"><div><div className="fees-section-kicker">CENTRAL PAYMENT LEDGER</div><h2 id="fees-payment-title">Collect payment</h2><p>{paymentInvoice.studentName} · {paymentInvoice.billingMonth}</p></div><button type="button" aria-label="Close" className="fees-close-button" onClick={() => setPaymentInvoice(null)}><X className="h-5 w-5"/></button></div>
      <div className="fees-payment-summary"><div><span>Invoice total</span><strong>{money(paymentInvoice.totalAmount)}</strong></div><div><span>Already paid</span><strong>{money(paymentInvoice.paidAmount)}</strong></div><div><span>Outstanding invoice balance</span><strong>{money(paymentInvoice.remainingBalance)}</strong></div></div>
      <div className="fees-modal-note"><Info className="h-4 w-4 shrink-0"/><span>This is a consolidated invoice for the student. It may contain subjects from more than one class and student extra charges. The payment will be allocated against the full invoice, not only the currently selected class.</span></div>
      <div className="mt-4"><h3 className="text-sm font-extrabold">Included invoice items</h3><div className="mt-2 max-h-36 space-y-2 overflow-y-auto">{(paymentInvoice.lineItems ?? []).map((item) => <div key={item.lineItemId} className="fees-line-item"><span>{item.subjectName}</span><strong>{money(item.amount)}</strong><span>Due {money(item.remainingBalance)}</span></div>)}</div></div>
      <form onSubmit={submitPayment} className="mt-5 space-y-3">
        <Field label="Payment amount (PKR)"><input className={inputClass} type="number" min="0.01" max={paymentInvoice.remainingBalance} step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} required/></Field>
        <Field label="Payment method"><select className={selectClass} value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="online">Online</option><option value="cheque">Cheque</option><option value="other">Other</option></select></Field>
        <Field label="Reference / receipt number (optional)"><input className={inputClass} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} maxLength={100}/></Field>
        <div className="flex justify-end gap-2 pt-2"><button type="button" className={secondaryButtonClass} onClick={() => setPaymentInvoice(null)}>Cancel</button><button type="submit" className={buttonClass} disabled={busy === `payment:${paymentInvoice.id}`}>{busy === `payment:${paymentInvoice.id}` ? 'Posting…' : 'Post Payment'}</button></div>
      </form>
    </div></div>}

    {cancelInvoiceTarget && <div className="fees-modal-backdrop no-print"><form role="dialog" aria-modal="true" onSubmit={(event) => void cancelInvoice(event)} className="fees-modal">
      <div className="fees-modal-heading"><div><div className="fees-section-kicker">AUDITED INVOICE ACTION</div><h2>Cancel unpaid invoice?</h2><p>{cancelInvoiceTarget.studentName} · {cancelInvoiceTarget.billingMonth} · {money(cancelInvoiceTarget.totalAmount)}</p></div><button type="button" aria-label="Close" className="fees-close-button" onClick={() => setCancelInvoiceTarget(null)}><X className="h-5 w-5"/></button></div>
      <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">Only zero-payment invoices can be cancelled here. Existing payments and receipts cannot be removed or reversed.</p>
      <div className="mt-4"><Field label="Cancellation reason"><textarea className={`${inputClass} min-h-24`} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} required maxLength={500}/></Field></div>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setCancelInvoiceTarget(null)}>Keep invoice</button><button type="submit" disabled={busy === `cancel:${cancelInvoiceTarget.id}`} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white">{busy === `cancel:${cancelInvoiceTarget.id}` ? 'Cancelling…' : 'Confirm cancellation'}</button></div>
    </form></div>}

    {showExtraChargePicker && selectedClass && <div className="fees-modal-backdrop no-print"><div role="dialog" aria-modal="true" aria-labelledby="fees-extra-picker-title" className="fees-modal">
      <div className="fees-modal-heading"><div><div className="fees-section-kicker">SELECT A STUDENT</div><h2 id="fees-extra-picker-title">Manage Extra Charges</h2><p>Choose which student profile to update for {selectedClass.name}.</p></div><button type="button" aria-label="Close" className="fees-close-button" onClick={() => setShowExtraChargePicker(false)}><X className="h-5 w-5"/></button></div>
      <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">{classStudents.map((student) => <button type="button" key={student.id} className="fees-extra-student-choice" onClick={() => { setShowExtraChargePicker(false); openExtraCharges(student); }}><span><strong>{student.name}</strong><small>Roll {student.rollNo || '—'} · {student.extraCharges?.length ?? 0} configured charges</small></span><ChevronRight className="h-4 w-4"/></button>)}</div>
    </div></div>}

    {extraChargeStudent && <div className="fees-modal-backdrop no-print"><form role="dialog" aria-modal="true" onSubmit={(event) => void saveExtraCharges(event)} className="fees-modal">
      <div className="fees-modal-heading"><div><div className="fees-section-kicker">STUDENT INVOICE ADD-ONS</div><h2>Extra Charges</h2><p>{extraChargeStudent.name} · {selectedClass?.name} · Future invoices only</p></div><button type="button" aria-label="Close" className="fees-close-button" onClick={() => setExtraChargeStudent(null)}><X className="h-5 w-5"/></button></div>
      <div className="fees-modal-note"><Info className="h-4 w-4 shrink-0"/><span>These charges belong to the student profile, not only this class. They appear on the student's consolidated invoice and are snapshotted when issued. Editing this list never changes existing invoices or payment receipts.</span></div>
      <div className="mt-4 space-y-3">
        {chargeDrafts.map((charge, index) => <div key={charge.id} className="fees-charge-editor">
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Purpose"><input className={inputClass} value={charge.label} onChange={(event) => setChargeDrafts((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, label: event.target.value } : item))} maxLength={120} required/></Field><Field label="Amount (PKR)"><input className={inputClass} type="number" min="0.01" step="0.01" value={charge.amount} onChange={(event) => setChargeDrafts((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, amount: event.target.value } : item))} required/></Field></div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Field label="Billing"><select className={selectClass} value={charge.billingFrequency} onChange={(event) => setChargeDrafts((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, billingFrequency: event.target.value as ChargeDraft['billingFrequency'] } : item))}><option value="one_time">One time</option><option value="monthly">Monthly recurring</option></select></Field>{charge.billingFrequency === 'one_time' ? <Field label="Applies to month"><input className={inputClass} type="month" value={charge.appliesToMonth} onChange={(event) => setChargeDrafts((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, appliesToMonth: event.target.value } : item))} required/></Field> : <div className="flex items-end text-xs text-slate-500">This charge is added to each future monthly invoice while retained.</div>}<div className="flex items-end"><button type="button" className="fees-remove-charge" onClick={() => setChargeDrafts((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><X className="h-4 w-4"/> Remove</button></div></div>
        </div>)}
        {chargeDrafts.length === 0 && <Empty>No extra charges are configured for this student.</Empty>}
      </div>
      <button type="button" className={secondaryButtonClass} disabled={chargeDrafts.length >= 20} onClick={() => setChargeDrafts((rows) => [...rows, { id: makeId(), label: '', amount: '', billingFrequency: 'one_time', appliesToMonth: month }])}><Sparkles className="h-4 w-4"/> Add charge</button>
      <div className="mt-4"><Field label="Reason for change"><textarea className={`${inputClass} min-h-20`} value={chargeReason} onChange={(event) => setChargeReason(event.target.value)} required maxLength={500} placeholder="Describe why these extra charges are being changed…"/></Field></div>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setExtraChargeStudent(null)}>Cancel</button><button type="submit" className={buttonClass} disabled={busy === `extras:${extraChargeStudent.id}`}><Wallet className="h-4 w-4"/>{busy === `extras:${extraChargeStudent.id}` ? 'Saving…' : 'Save Extra Charges'}</button></div>
    </form></div>}

    {showBillingNote && <div className="fees-modal-backdrop no-print"><div role="dialog" aria-modal="true" className="fees-modal">
      <div className="fees-modal-heading"><div><div className="fees-section-kicker">BILLING POLICY</div><h2>How this register calculates fees</h2></div><button type="button" aria-label="Close" className="fees-close-button" onClick={() => setShowBillingNote(false)}><X className="h-5 w-5"/></button></div>
      <ul className="fees-policy-list">
        <li>Issued invoice line-item amounts and paid allocations are authoritative snapshots. This page never recalculates an issued invoice.</li>
        <li>New monthly invoices use the canonical active subject enrolments and the server-side invoice generator.</li>
        <li>The subject catalogue allows Monthly, Termly and Yearly labels, but the current central invoice engine has no stored term calendar or due-month schedule for Termly/Yearly. New invoice creation is blocked for students with those cycles rather than charging them every month.</li>
        <li>Previous-month dues are shown from the previous month's issued invoice. They are not silently added to the current invoice.</li>
        <li>Payments are posted to a consolidated student invoice. If it contains multiple classes or add-ons, the full outstanding amount is shown before payment.</li>
      </ul>
      <div className="mt-5 flex justify-end"><button type="button" className={buttonClass} onClick={() => setShowBillingNote(false)}>Close</button></div>
    </div></div>}
  </div>;
}
