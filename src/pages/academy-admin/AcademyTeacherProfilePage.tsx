import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, BadgeCheck, BookOpen, CalendarDays, CheckCircle2, ChevronRight,
  CreditCard, Download, FileDown, GraduationCap, Mail, Pencil, Phone, RefreshCw,
  Save, Search, ShieldCheck, Users, Wallet, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { auth, storage } from '@/lib/firebase';
import { academyManagementRequest, getAcademyAccess } from '@/lib/academyApi';
import {
  AcademyTeacherRow, TeacherAvatar, TeacherPermission, TeacherPermissionGroups,
  displayDate, displayDateTime, moneyPKR,
} from './AcademyTeacherModuleUI';
import { buttonClass, Cell, Empty, Field, inputClass, Loading, Notice, Panel, secondaryButtonClass, Table } from './AcademyAdminUI';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

type ProfileResponse = {
  success: true;
  academy: { academyId: string; academyName: string };
  teacher: AcademyTeacherRow;
  summary: { assignedClasses: number; assignedStudents: number; assignedSubjects: number; totalFeesGenerated: number; totalFeesCollected: number; outstandingFees: number; collectedThisMonth: number };
  classes: Array<{ id: string; name: string; classCode: string; section: string; academicYear: string; status: string; studentCount: number; subjects: Array<{ id: string; name: string; code: string; monthlyFee: number; status: string }> }>;
  students: Array<{ id: string; name: string; rollNo: string; fatherName: string; phone: string; status: string; classes: Array<{ id: string; name: string }>; subjects: string[] }>;
  feeRecords: Array<{ id: string; invoiceId: string; invoiceNumber: string; studentId: string; studentName: string; className: string; subjectName: string; invoiceDate: string | null; dueDate: string | null; billingMonth: string; totalAmount: number; paidAmount: number; remainingBalance: number; status: string; currency: string }>;
  payments: Array<{ id: string; invoiceId: string; studentId: string; studentName: string; amount: number; paymentMethod: string; paymentReference: string; createdAt: string | null }>;
  monthlyCollections: Array<{ month: string; amount: number }>;
  permissionDefinitions: TeacherPermission[];
  meta?: { limited?: boolean };
};

type Tab = 'overview' | 'classes' | 'students' | 'financial' | 'permissions';
const validateImage = (file: File) => /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 3 * 1024 * 1024;
const dateFromInput = (value: string) => value ? new Date(`${value}T00:00:00`).getTime() : null;

export default function AcademyTeacherProfilePage() {
  const { uid = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [saving, setSaving] = useState(false);
  const [permissionDraft, setPermissionDraft] = useState<Record<string, boolean>>({});
  const [studentQuery, setStudentQuery] = useState('');
  const [studentStatusFilter, setStudentStatusFilter] = useState('all');
  const [feeQuery, setFeeQuery] = useState('');
  const [feeStatus, setFeeStatus] = useState('all');
  const [feeFrom, setFeeFrom] = useState('');
  const [feeTo, setFeeTo] = useState('');
  const [paymentFrom, setPaymentFrom] = useState('');
  const [paymentTo, setPaymentTo] = useState('');
  const [feePage, setFeePage] = useState(1);
  const [studentPage, setStudentPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const [classPage, setClassPage] = useState(1);
  const pageSize = 5;

  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesignation, setEditDesignation] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editReason, setEditReason] = useState('');
  const [statusReason, setStatusReason] = useState('');
  const [editPhoto, setEditPhoto] = useState<File | null>(null);
  const [editPhotoPreview, setEditPhotoPreview] = useState('');
  const [removeEditPhoto, setRemoveEditPhoto] = useState(false);

  const load = useCallback(async (quiet = false) => {
    const user = auth.currentUser;
    if (!user) { setError('Your Academy session has expired.'); setLoading(false); return; }
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const result = await academyManagementRequest<Omit<ProfileResponse, 'success'>>(user, { action: 'teacher-profile', teacherUid: uid });
      setData(result as ProfileResponse); setPermissionDraft({ ...result.teacher.permissions });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Teacher profile could not be loaded.';
      setError(message); if (!quiet) toast.error('Profile unavailable', { description: message });
    } finally { setLoading(false); setRefreshing(false); }
  }, [uid]);
  useEffect(() => { void load(); }, [load]);

  const studentsFiltered = useMemo(() => (data?.students ?? []).filter((student) => {
    const search = studentQuery.trim().toLowerCase();
    const matchesSearch = !search || [student.name, student.rollNo, student.fatherName, student.phone, ...student.classes.map((item) => item.name), ...student.subjects].some((value) => (value || '').toLowerCase().includes(search));
    return matchesSearch && (studentStatusFilter === 'all' || student.status.toLowerCase() === studentStatusFilter.toLowerCase());
  }), [data, studentQuery, studentStatusFilter]);
  const feeRecordsFiltered = useMemo(() => (data?.feeRecords ?? []).filter((record) => {
    const search = feeQuery.trim().toLowerCase();
    const matchSearch = !search || [record.studentName, record.className, record.subjectName, record.invoiceNumber, record.billingMonth].some((value) => (value || '').toLowerCase().includes(search));
    const matchStatus = feeStatus === 'all' || record.status === feeStatus;
    const timestamp = record.invoiceDate ? new Date(record.invoiceDate).getTime() : null;
    const from = dateFromInput(feeFrom); const to = dateFromInput(feeTo);
    return matchSearch && matchStatus && (from === null || (timestamp !== null && timestamp >= from)) && (to === null || (timestamp !== null && timestamp <= to + 86_399_999));
  }), [data, feeQuery, feeStatus, feeFrom, feeTo]);
  const paymentRowsFiltered = useMemo(() => (data?.payments ?? []).filter((payment) => {
    const timestamp = payment.createdAt ? new Date(payment.createdAt).getTime() : null;
    const from = dateFromInput(paymentFrom); const to = dateFromInput(paymentTo);
    return (from === null || (timestamp !== null && timestamp >= from)) && (to === null || (timestamp !== null && timestamp <= to + 86_399_999));
  }), [data, paymentFrom, paymentTo]);
  const visibleFeeRecords = useMemo(() => feeRecordsFiltered.slice((feePage - 1) * pageSize, feePage * pageSize), [feeRecordsFiltered, feePage]);
  const visibleStudents = useMemo(() => studentsFiltered.slice((studentPage - 1) * pageSize, studentPage * pageSize), [studentsFiltered, studentPage]);
  const visiblePayments = useMemo(() => paymentRowsFiltered.slice((paymentPage - 1) * pageSize, paymentPage * pageSize), [paymentRowsFiltered, paymentPage]);
  const feePageCount = Math.max(1, Math.ceil(feeRecordsFiltered.length / pageSize));
  const studentPageCount = Math.max(1, Math.ceil(studentsFiltered.length / pageSize));
  const paymentPageCount = Math.max(1, Math.ceil(paymentRowsFiltered.length / pageSize));
  const visibleClasses = (data?.classes ?? []).slice((classPage - 1) * pageSize, classPage * pageSize);
  const classPageCount = Math.max(1, Math.ceil((data?.classes.length ?? 0) / pageSize));

  useEffect(() => {
    if (!editPhoto) { setEditPhotoPreview(''); return; }
    const url = URL.createObjectURL(editPhoto); setEditPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [editPhoto]);
  useEffect(() => { setFeePage(1); }, [feeQuery, feeStatus, feeFrom, feeTo]);
  useEffect(() => { setStudentPage(1); }, [studentQuery, studentStatusFilter]);
  useEffect(() => { setPaymentPage(1); }, [paymentFrom, paymentTo]);
  useEffect(() => { if (paymentPage > paymentPageCount) setPaymentPage(paymentPageCount); }, [paymentPage, paymentPageCount]);
  useEffect(() => { if (classPage > classPageCount) setClassPage(classPageCount); }, [classPage, classPageCount]);

  const openEdit = () => {
    if (!data) return;
    setEditName(data.teacher.name); setEditDesignation(data.teacher.designation || ''); setEditPhone(data.teacher.whatsappNumber || ''); setEditEmail(data.teacher.contactEmail || data.teacher.email);
    setEditReason(''); setEditPhoto(null); setRemoveEditPhoto(false); setEditOpen(true);
  };
  const saveEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const user = auth.currentUser; if (!user || !data || !editReason.trim()) return;
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i.test(editEmail.trim().toLowerCase())) { setError('Enter a valid contact Gmail ending in @gmail.com.'); return; }
    if (editPhoto && !validateImage(editPhoto)) { setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); return; }
    setSaving(true); setError('');
    try {
      let profileImageStoragePath: string | undefined;
      let profileImage: string | undefined;
      if (editPhoto) {
        const { academyId } = await getAcademyAccess(user);
        const upload = await uploadBytes(ref(storage, `academies/${academyId}/teachers/${uid}/profile/avatar`), editPhoto, { contentType: editPhoto.type, customMetadata: { academyId, teacherUid: uid } });
        profileImageStoragePath = upload.ref.fullPath;
        profileImage = await getDownloadURL(upload.ref);
      }
      await academyManagementRequest(user, { action: 'update-teacher', teacherUid: uid, displayName: editName.trim(), designation: editDesignation.trim(), contactPhone: editPhone.trim(), contactEmail: editEmail.trim().toLowerCase(), ...(profileImageStoragePath ? { profileImageStoragePath, profileImage } : {}), ...(removeEditPhoto ? { removeProfileImage: true } : {}), reason: editReason.trim() });
      if (removeEditPhoto && data.teacher.profileImageStoragePath) {
        try { await deleteObject(ref(storage, data.teacher.profileImageStoragePath)); } catch { toast.warning('Photo reference removed', { description: 'The profile now uses its default avatar, but the old Storage object may need a manual cleanup.' }); }
      }
      toast.success('Teacher profile updated'); setEditOpen(false); setEditPhoto(null); setRemoveEditPhoto(false); await load(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Teacher profile could not be updated.'; setError(message); toast.error('Update failed', { description: message }); }
    finally { setSaving(false); }
  };
  const savePermissions = async () => {
    const user = auth.currentUser; if (!user) return;
    setSaving(true); setError('');
    try {
      await academyManagementRequest(user, { action: 'update-teacher-permissions', teacherUid: uid, permissions: permissionDraft });
      toast.success('Permissions saved'); await load(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Permissions could not be saved.'; setError(message); toast.error('Permission save failed', { description: message }); }
    finally { setSaving(false); }
  };
  const updateStatus = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const user = auth.currentUser; if (!user || !data || !statusReason.trim()) return;
    setSaving(true); setError('');
    try {
      await academyManagementRequest(user, { action: 'set-teacher-active', teacherUid: uid, active: !data.teacher.active, reason: statusReason.trim() });
      toast.success(data.teacher.active ? 'Teacher deactivated' : 'Teacher reactivated'); setStatusOpen(false); setStatusReason(''); await load(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Teacher status could not be updated.'; setError(message); toast.error('Status update failed', { description: message }); }
    finally { setSaving(false); }
  };

  const exportPdf = () => {
    if (!data) return;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFillColor(12, 74, 145); doc.rect(0, 0, pageWidth, 34, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('EduTrack', 14, 14);
    doc.setFontSize(10); doc.text(data.teacher.email, 14, 22);
    doc.setFontSize(15); doc.text('Teacher Fee Records', pageWidth - 14, 14, { align: 'right' });
    doc.setFontSize(9); doc.text(data.teacher.name, pageWidth - 14, 22, { align: 'right' });
    doc.setTextColor(40, 50, 65); doc.setFontSize(9);
    doc.text(`Academy: ${data.academy.academyName} (${data.academy.academyId})`, 14, 43);
    doc.text(`Report generated: ${new Date().toLocaleString('en-PK')}`, 14, 49);
    doc.text(`Date range: ${feeFrom || 'Any'} to ${feeTo || 'Any'} · Status: ${feeStatus}`, 14, 55);
    const totals = feeRecordsFiltered.reduce((sum, item) => ({ billed: sum.billed + item.totalAmount, paid: sum.paid + item.paidAmount, remaining: sum.remaining + item.remainingBalance }), { billed: 0, paid: 0, remaining: 0 });
    doc.setFont('helvetica', 'bold');
    doc.text(`Total billed: ${moneyPKR(totals.billed)}`, 14, 64);
    doc.text(`Collected: ${moneyPKR(totals.paid)}`, 100, 64);
    doc.text(`Outstanding: ${moneyPKR(totals.remaining)}`, 185, 64);
    doc.text(`Collected this month (all teacher-scoped records): ${moneyPKR(data.summary.collectedThisMonth)}`, 14, 72);
    autoTable(doc, {
      startY: 79,
      head: [['Student', 'Class', 'Invoice', 'Invoice date', 'Due date', 'Total', 'Paid', 'Balance', 'Status']],
      body: feeRecordsFiltered.map((item) => [item.studentName, item.className, item.invoiceNumber, displayDate(item.invoiceDate), displayDate(item.dueDate), moneyPKR(item.totalAmount), moneyPKR(item.paidAmount), moneyPKR(item.remainingBalance), item.status]),
      theme: 'striped', styles: { fontSize: 7, cellPadding: 2.3, overflow: 'linebreak' }, headStyles: { fillColor: [20, 100, 170], textColor: 255 },
      margin: { left: 14, right: 14, bottom: 16 },
    });
    const pages = doc.getNumberOfPages();
    for (let index = 1; index <= pages; index += 1) {
      doc.setPage(index); doc.setFontSize(8); doc.setTextColor(100, 110, 125);
      doc.text('EduTrack · Teacher-scoped Academy financial summary · Not salary or commission', 14, doc.internal.pageSize.getHeight() - 8);
      doc.text(`Page ${index} of ${pages}`, pageWidth - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
    }
    const safeName = data.teacher.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'teacher';
    doc.save(`edutrack-${safeName}-fee-records.pdf`);
  };

  if (loading) return <div className="py-10"><Loading label="Loading teacher profile and assigned records…"/></div>;
  if (!data) return <div className="space-y-4"><Link to="/academy-admin/teachers" className="inline-flex items-center gap-2 text-sm font-bold text-blue-700 dark:text-cyan-300"><ArrowLeft className="h-4 w-4"/> Back to Teachers</Link>{error && <Notice>{error}</Notice>}<Panel><Empty>Teacher profile could not be displayed. Return to the teacher list and try again.</Empty></Panel></div>;

  const { teacher, summary } = data;
  const tabOptions: Array<{ key: Tab; label: string }> = [
    { key: 'overview', label: 'Overview' }, { key: 'classes', label: 'Assigned classes' },
    { key: 'students', label: 'Students' }, { key: 'financial', label: 'Financial overview' }, { key: 'permissions', label: 'Permissions' },
  ];
  const currentFeeSummary = feeRecordsFiltered.reduce((sum, item) => ({ billed: sum.billed + item.totalAmount, paid: sum.paid + item.paidAmount, remaining: sum.remaining + item.remainingBalance }), { billed: 0, paid: 0, remaining: 0 });

  return <div className="space-y-6 pb-24">
    <div className="flex flex-wrap items-center justify-between gap-3"><Link to="/academy-admin/teachers" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"><ArrowLeft className="h-4 w-4"/> Back to Teachers</Link><button type="button" onClick={() => void load(true)} disabled={refreshing} className={secondaryButtonClass}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}/>{refreshing ? 'Refreshing…' : 'Refresh profile'}</button></div>
    {error && <Notice>{error}</Notice>}
    {data.meta?.limited && <Notice>Some linked collections reached the configured query limits. The displayed information is based on the records returned by the bounded profile query and may be incomplete for very large Academies.</Notice>}

    <section className="relative overflow-hidden rounded-[28px] border border-blue-100 bg-gradient-to-br from-white via-blue-50 to-cyan-50 p-5 shadow-xl shadow-blue-900/5 dark:border-blue-400/15 dark:from-slate-900 dark:via-blue-950/50 dark:to-cyan-950/30 sm:p-7"><div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-cyan-300/25 blur-3xl"/><div className="relative flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between"><div className="flex min-w-0 items-center gap-4 sm:gap-5"><TeacherAvatar teacher={teacher} size="xl"/><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-2xl font-black text-slate-950 dark:text-white sm:text-3xl">{teacher.name}</h1><span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase ${teacher.active && teacher.emailVerified ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : teacher.emailVerified ? 'bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'}`}>{teacher.active && teacher.emailVerified ? 'Active' : teacher.emailVerified ? 'Inactive' : 'Pending verification'}</span></div><p className="mt-1 text-sm font-bold text-blue-700 dark:text-cyan-300">{teacher.designation || 'Teacher'}</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600 dark:text-slate-300"><span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5"/>{teacher.email}</span><span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5"/>{teacher.whatsappNumber || 'No contact number'}</span><span className="inline-flex items-center gap-1.5"><BadgeCheck className="h-3.5 w-3.5"/>{teacher.emailVerified ? 'Email verified' : 'Email not verified'}</span></div><p className="mt-2 text-[10px] text-slate-500">{data.academy.academyName} · Academy ID {data.academy.academyId} · Added {displayDate(teacher.createdAt)}</p></div></div><div className="flex flex-wrap gap-2"><button type="button" onClick={openEdit} className={secondaryButtonClass}><Pencil className="h-4 w-4"/> Edit profile</button><button type="button" onClick={() => setTab('permissions')} className={secondaryButtonClass}><ShieldCheck className="h-4 w-4"/> Manage permissions</button><button type="button" onClick={() => { setStatusReason(''); setStatusOpen(true); }} disabled={!teacher.active && !teacher.emailVerified} className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-white ${teacher.active ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'} disabled:opacity-40`}>{teacher.active ? 'Deactivate' : 'Reactivate'}</button></div></div></section>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{[
      { label: 'Assigned classes', value: summary.assignedClasses, icon: BookOpen, color: 'blue' },
      { label: 'Assigned students', value: summary.assignedStudents, icon: GraduationCap, color: 'cyan' },
      { label: 'Assigned subjects', value: summary.assignedSubjects, icon: Users, color: 'violet' },
      { label: 'Fees generated', value: moneyPKR(summary.totalFeesGenerated), icon: Wallet, color: 'orange' },
      { label: 'Fees collected', value: moneyPKR(summary.totalFeesCollected), icon: CreditCard, color: 'emerald' },
      { label: 'Outstanding', value: moneyPKR(summary.outstandingFees), icon: Activity, color: 'rose' },
    ].map((item) => <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-slate-900/80"><div className="flex items-center justify-between gap-2"><span className="text-[11px] font-bold text-slate-500">{item.label}</span><span className={`grid h-9 w-9 place-items-center rounded-xl ${item.color === 'blue' ? 'bg-blue-50 text-blue-700' : item.color === 'cyan' ? 'bg-cyan-50 text-cyan-700' : item.color === 'violet' ? 'bg-violet-50 text-violet-700' : item.color === 'orange' ? 'bg-orange-50 text-orange-700' : item.color === 'emerald' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'} dark:bg-white/5 dark:text-cyan-300`}><item.icon className="h-4 w-4"/></span></div><p className="mt-3 break-words text-xl font-black text-slate-950 dark:text-white">{item.value}</p></div>)}</div>

    <div className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 dark:border-white/10 dark:bg-slate-900">{tabOptions.map((item) => <button key={item.key} type="button" onClick={() => setTab(item.key)} className={`shrink-0 rounded-xl px-3.5 py-2.5 text-xs font-black transition ${tab === item.key ? 'bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white'}`}>{item.label}</button>)}</div>

    {tab === 'overview' && <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]"><Panel><div className="mb-4 flex items-center justify-between"><div><h2 className="text-base font-black text-slate-950 dark:text-white">Assigned classes</h2><p className="mt-1 text-xs text-slate-500">Only active subject-level assignments for this teacher.</p></div><div className="flex items-center gap-3"><Link to="/academy-admin/classes" className="text-xs font-black text-cyan-700 dark:text-cyan-300">Manage assignments</Link><button type="button" onClick={() => setTab('classes')} className="text-xs font-black text-blue-700 dark:text-cyan-300">View all <ChevronRight className="inline h-3.5 w-3.5"/></button></div></div>{data.classes.length ? <div className="grid gap-3 md:grid-cols-2">{data.classes.slice(0, 4).map((item) => <div key={item.id} className="rounded-2xl border border-blue-100 bg-gradient-to-br from-white to-blue-50/70 p-4 dark:border-blue-400/10 dark:from-slate-900 dark:to-blue-950/20"><div className="flex items-start justify-between gap-2"><div><h3 className="font-black text-slate-900 dark:text-white">{item.name} {item.section}</h3><p className="mt-1 font-mono text-[10px] text-blue-700 dark:text-cyan-300">{item.classCode || item.id}</p></div><span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-black uppercase text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{item.status}</span></div><div className="mt-3 flex items-center gap-3 text-xs text-slate-500"><span><Users className="mr-1 inline h-3.5 w-3.5"/>{item.studentCount} students</span><span><BookOpen className="mr-1 inline h-3.5 w-3.5"/>{item.subjects.length} subjects</span></div><div className="mt-3 flex flex-wrap gap-1.5">{item.subjects.map((subject) => <span key={subject.id} className="rounded-lg border border-blue-100 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 dark:border-white/10 dark:bg-slate-950/40 dark:text-slate-300">{subject.name}</span>)}</div></div>)}</div> : <Empty>No active class assignments are recorded for this teacher.</Empty>}</Panel>
      <Panel><div className="mb-4"><h2 className="text-base font-black text-slate-950 dark:text-white">Financial snapshot</h2><p className="mt-1 text-xs text-slate-500">Amounts from invoice line items assigned to this teacher.</p></div><div className="space-y-4"><div><div className="mb-1 flex justify-between text-xs"><span className="font-bold text-slate-500">Collected</span><strong className="text-emerald-700 dark:text-emerald-300">{moneyPKR(summary.totalFeesCollected)}</strong></div><div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" style={{ width: `${summary.totalFeesGenerated > 0 ? Math.min(100, (summary.totalFeesCollected / summary.totalFeesGenerated) * 100) : 0}%` }}/></div></div><div className="grid grid-cols-2 gap-3"><div className="rounded-xl bg-orange-50 p-3 dark:bg-orange-500/10"><p className="text-[10px] font-bold text-orange-800 dark:text-orange-300">Outstanding</p><p className="mt-1 break-words text-base font-black text-slate-900 dark:text-white">{moneyPKR(summary.outstandingFees)}</p></div><div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10"><p className="text-[10px] font-bold text-emerald-800 dark:text-emerald-300">This month</p><p className="mt-1 break-words text-base font-black text-slate-900 dark:text-white">{moneyPKR(summary.collectedThisMonth)}</p></div></div><p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 dark:border-amber-400/15 dark:bg-amber-500/10 dark:text-amber-200">These figures are fees for the teacher’s assigned subject line items—not teacher salary, personal earnings or commission. Each invoice line is attributed through its saved teacher UID or matching active class/subject assignment.</p><button type="button" onClick={() => setTab('financial')} className="text-xs font-black text-blue-700 dark:text-cyan-300">Open financial overview <ChevronRight className="inline h-3.5 w-3.5"/></button></div></Panel></div>}

    {tab === 'classes' && <Panel><div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-base font-black text-slate-950 dark:text-white">Assigned classes & subjects</h2><p className="mt-1 text-xs text-slate-500">Class membership is derived from active teacherAssignments records.</p></div><Link to="/academy-admin/classes" className="text-xs font-black text-blue-700 dark:text-cyan-300">Open class management</Link></div>{data.classes.length ? <div className="grid gap-4 md:grid-cols-2">{visibleClasses.map((item) => <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-white/10 dark:bg-slate-950/40"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-lg font-black text-slate-900 dark:text-white">{item.name} {item.section}</h3><p className="mt-1 font-mono text-[10px] text-orange-700 dark:text-orange-300">{item.classCode || item.id} · {item.academicYear || 'No academic year'}</p></div><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-black uppercase text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{item.status}</span></div><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"><Users className="mr-1 inline h-3.5 w-3.5"/>{item.studentCount} students</span><span className="rounded-xl bg-cyan-50 px-3 py-2 text-xs font-bold text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300"><BookOpen className="mr-1 inline h-3.5 w-3.5"/>{item.subjects.length} assigned subjects</span></div><div className="mt-4 space-y-2">{item.subjects.map((subject) => <div key={subject.id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2 dark:border-white/[0.06]"><div><p className="text-xs font-bold text-slate-800 dark:text-slate-200">{subject.name}</p><p className="mt-0.5 text-[10px] text-slate-500">{subject.code || 'No subject code'}</p></div><strong className="text-xs text-slate-700 dark:text-slate-300">{moneyPKR(subject.monthlyFee)}/mo</strong></div>)}</div></article>)}</div> : <Empty>No assigned classes or subject records were found.</Empty>}{(data.classes.length > pageSize) && <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-white/10"><span className="text-xs text-slate-500">Page {classPage} of {classPageCount} · {data.classes.length} assigned classes</span><div className="flex gap-2"><button type="button" disabled={classPage <= 1} onClick={() => setClassPage((page) => Math.max(1, page - 1))} className={secondaryButtonClass}>Previous</button><button type="button" disabled={classPage >= classPageCount} onClick={() => setClassPage((page) => Math.min(classPageCount, page + 1))} className={secondaryButtonClass}>Next</button></div></div>}</Panel>}

    {tab === 'students' && <Panel><div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-base font-black text-slate-950 dark:text-white">Assigned students</h2><p className="mt-1 text-xs text-slate-500">Unique student list from this teacher’s active subject enrolments.</p></div><span className="w-fit rounded-full bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">{studentsFiltered.length} students</span></div><label className="relative mb-4 block max-w-xl"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input className={`${inputClass} pl-10`} value={studentQuery} onChange={(event) => setStudentQuery(event.target.value)} placeholder="Search student, roll number, class or subject…"/></label><select className={`${inputClass} mb-4 max-w-xs`} value={studentStatusFilter} onChange={(event) => setStudentStatusFilter(event.target.value)}><option value="all">All student statuses</option>{[...new Set(data.students.map((student) => student.status).filter((status) => status && status !== 'unknown'))].sort().map((status) => <option key={status} value={status}>{status}</option>)}</select>{studentsFiltered.length ? <><div className="hidden md:block"><Table headers={['Student','Roll no.','Assigned classes','Subjects','Status']}>{visibleStudents.map((student) => <tr key={student.id}><Cell><div className="font-bold text-slate-900 dark:text-white">{student.name}</div><div className="text-[10px] text-slate-500">{student.fatherName}</div></Cell><Cell>{student.rollNo || '—'}</Cell><Cell>{student.classes.map((item) => item.name).join(', ') || '—'}</Cell><Cell>{student.subjects.join(', ') || '—'}</Cell><Cell><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase text-slate-600 dark:bg-white/10 dark:text-slate-300">{student.status}</span></Cell></tr>)}</Table></div><div className="grid gap-3 md:hidden">{visibleStudents.map((student) => <article key={student.id} className="rounded-xl border border-slate-200 p-3 dark:border-white/10"><div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-black text-slate-900 dark:text-white">{student.name}</h3><p className="mt-1 text-[10px] text-slate-500">Roll no. {student.rollNo || '—'} · {student.fatherName || 'No guardian name'}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600 dark:bg-white/10 dark:text-slate-300">{student.status}</span></div><p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Classes: {student.classes.map((item) => item.name).join(', ') || '—'}</p><p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Subjects: {student.subjects.join(', ') || '—'}</p></article>)}</div></> : <Empty>No assigned students match your search.</Empty>}{studentsFiltered.length > pageSize && <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-white/10"><span className="text-xs text-slate-500">Page {studentPage} of {studentPageCount} · {studentsFiltered.length} students</span><div className="flex gap-2"><button type="button" disabled={studentPage <= 1} onClick={() => setStudentPage((page) => Math.max(1, page - 1))} className={secondaryButtonClass}>Previous</button><button type="button" disabled={studentPage >= studentPageCount} onClick={() => setStudentPage((page) => Math.min(studentPageCount, page + 1))} className={secondaryButtonClass}>Next</button></div></div>}</Panel>}

    {tab === 'financial' && <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[{ label: 'Total billed', value: moneyPKR(currentFeeSummary.billed) }, { label: 'Collected', value: moneyPKR(currentFeeSummary.paid) }, { label: 'Outstanding', value: moneyPKR(currentFeeSummary.remaining) }, { label: 'Collected this month', value: moneyPKR(summary.collectedThisMonth) }].map((item) => <Panel key={item.label}><p className="text-xs font-bold text-slate-500">{item.label}</p><p className="mt-2 break-words text-xl font-black text-slate-950 dark:text-white">{item.value}</p></Panel>)}</div>
      <Panel><div className="mb-4"><h2 className="text-base font-black text-slate-950 dark:text-white">Collected vs outstanding</h2><p className="mt-1 text-xs text-slate-500">Current teacher-assigned invoice line balances, based on saved fee records.</p></div>{summary.totalFeesGenerated > 0 ? <div className="h-56 w-full"><ResponsiveContainer width="100%" height="100%"><BarChart data={[{ status: 'Collected', amount: summary.totalFeesCollected }, { status: 'Outstanding', amount: summary.outstandingFees }]}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="status" tick={{ fontSize: 11 }}/><YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `₨${Number(value).toLocaleString('en-PK')}`}/><Tooltip formatter={(value: number) => moneyPKR(Number(value))}/><Bar dataKey="amount" name="PKR amount" fill="#0d9488" radius={[8, 8, 0, 0]}/></BarChart></ResponsiveContainer></div> : <Empty>No assigned invoice line items are available for a financial chart.</Empty>}</Panel>
      <Panel><div className="mb-4"><h2 className="text-base font-black text-slate-950 dark:text-white">Monthly fee collection</h2><p className="mt-1 text-xs text-slate-500">Cash receipts are assigned to the teacher using payment allocations and invoice line-item IDs.</p></div>{data.monthlyCollections.length ? <div className="h-72 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.monthlyCollections}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="month" tick={{ fontSize: 11 }}/><YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `₨${Number(value).toLocaleString('en-PK')}`}/><Tooltip formatter={(value: number) => moneyPKR(Number(value))}/><Line type="monotone" dataKey="amount" name="Allocated collections" stroke="#0891b2" strokeWidth={3} dot={{ r: 3 }}/></LineChart></ResponsiveContainer></div> : <Empty>No allocated payment history is available for this teacher yet. The chart is not populated with estimated values.</Empty>}</Panel>
      <Panel><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-black text-slate-950 dark:text-white">Fee records</h2><p className="mt-1 text-xs text-slate-500">One row per invoice line item assigned to this teacher.</p></div><button type="button" onClick={exportPdf} disabled={!feeRecordsFiltered.length} className={buttonClass}><FileDown className="h-4 w-4"/> Export PDF</button></div><div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_150px_150px_150px]"><label className="relative block"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input className={`${inputClass} pl-10`} value={feeQuery} onChange={(event) => setFeeQuery(event.target.value)} placeholder="Search student, invoice, class…"/></label><select className={inputClass} value={feeStatus} onChange={(event) => setFeeStatus(event.target.value)}><option value="all">All statuses</option><option value="PAID">Paid</option><option value="PARTIAL">Partial</option><option value="UNPAID">Unpaid</option></select><input type="date" aria-label="Invoice date from" className={inputClass} value={feeFrom} onChange={(event) => setFeeFrom(event.target.value)}/><input type="date" aria-label="Invoice date to" className={inputClass} value={feeTo} onChange={(event) => setFeeTo(event.target.value)}/></div>{feeRecordsFiltered.length ? <div className="overflow-x-auto"><Table headers={['Student','Class / subject','Invoice','Invoice date','Due date','Total','Paid','Balance','Status']}>{visibleFeeRecords.map((record) => <tr key={record.id}><Cell><div className="font-bold text-slate-900 dark:text-white">{record.studentName}</div><div className="text-[10px] text-slate-500">{record.studentId}</div></Cell><Cell><div className="font-bold">{record.className}</div><div className="text-[10px] text-slate-500">{record.subjectName}</div></Cell><Cell>{record.invoiceNumber}</Cell><Cell>{displayDate(record.invoiceDate)}</Cell><Cell>{displayDate(record.dueDate)}</Cell><Cell>{moneyPKR(record.totalAmount)}</Cell><Cell className="font-bold text-emerald-700 dark:text-emerald-300">{moneyPKR(record.paidAmount)}</Cell><Cell className="font-bold text-orange-700 dark:text-orange-300">{moneyPKR(record.remainingBalance)}</Cell><Cell><span className={`rounded-full px-2 py-1 text-[9px] font-black ${record.status === 'PAID' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : record.status === 'PARTIAL' ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'}`}>{record.status}</span></Cell></tr>)}</Table></div> : <Empty>No teacher-scoped fee line items match the selected filters.</Empty>}{feeRecordsFiltered.length > pageSize && <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-white/10"><span className="text-xs text-slate-500">Page {feePage} of {feePageCount} · {feeRecordsFiltered.length} fee records</span><div className="flex gap-2"><button type="button" disabled={feePage <= 1} onClick={() => setFeePage((page) => Math.max(1, page - 1))} className={secondaryButtonClass}>Previous</button><button type="button" disabled={feePage >= feePageCount} onClick={() => setFeePage((page) => Math.min(feePageCount, page + 1))} className={secondaryButtonClass}>Next</button></div></div>}</Panel>
      <Panel><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-black text-slate-950 dark:text-white">Payment history</h2><p className="mt-1 text-xs text-slate-500">Only payment allocation amounts belonging to this teacher’s assigned invoice lines are included.</p></div><span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{paymentRowsFiltered.length} records</span></div><div className="mb-4 grid gap-3 sm:grid-cols-2"><Field label="Payment date from"><input type="date" className={inputClass} value={paymentFrom} onChange={(event) => setPaymentFrom(event.target.value)}/></Field><Field label="Payment date to"><input type="date" className={inputClass} value={paymentTo} onChange={(event) => setPaymentTo(event.target.value)}/></Field></div>{paymentRowsFiltered.length ? <><Table headers={['Payment date','Student','Invoice','Method','Reference','Teacher allocation']}>{visiblePayments.map((payment) => <tr key={payment.id}><Cell>{displayDateTime(payment.createdAt)}</Cell><Cell>{payment.studentName}</Cell><Cell>{payment.invoiceId}</Cell><Cell>{payment.paymentMethod || '—'}</Cell><Cell>{payment.paymentReference || '—'}</Cell><Cell className="font-black text-emerald-700 dark:text-emerald-300">{moneyPKR(payment.amount)}</Cell></tr>)}</Table>{paymentRowsFiltered.length > pageSize && <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-white/10"><span className="text-xs text-slate-500">Page {paymentPage} of {paymentPageCount} · {paymentRowsFiltered.length} payment records</span><div className="flex gap-2"><button type="button" disabled={paymentPage <= 1} onClick={() => setPaymentPage((page) => Math.max(1, page - 1))} className={secondaryButtonClass}>Previous</button><button type="button" disabled={paymentPage >= paymentPageCount} onClick={() => setPaymentPage((page) => Math.min(paymentPageCount, page + 1))} className={secondaryButtonClass}>Next</button></div></div>}</> : <Empty>No allocated payments match the selected date range.</Empty>}</Panel></div>}

    {tab === 'permissions' && <Panel><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-black text-slate-950 dark:text-white">Teacher module permissions</h2><p className="mt-1 text-xs text-slate-500">Existing permission keys only. Academy Admin access is not assignable to a teacher account.</p></div><button type="button" disabled={saving} onClick={() => void savePermissions()} className={buttonClass}><Save className="h-4 w-4"/>{saving ? 'Saving…' : 'Save permissions'}</button></div><TeacherPermissionGroups definitions={data.permissionDefinitions} value={permissionDraft} onChange={setPermissionDraft} disabled={saving}/></Panel>}

    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 dark:border-amber-400/15 dark:bg-amber-500/10 dark:text-amber-200"><strong>Account lifecycle and data retention:</strong> Hard deletion is not available in the current Academy teacher service. Deactivate/reactivate uses the existing audited account lifecycle, disables or enables Firebase Auth, and retains linked academic and financial history. The Firebase sign-in email remains fixed; the editable Contact Gmail is synchronized with Teacher Settings.</div>

    {editOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-950/65 p-4 backdrop-blur-sm"><form onSubmit={(event) => void saveEdit(event)} className="my-auto w-full max-w-2xl space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-blue-700 dark:text-cyan-300">Teacher management</p><h2 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Edit teacher profile</h2></div><button type="button" onClick={() => setEditOpen(false)} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5"><X className="h-5 w-5"/></button></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Teacher name"><input className={inputClass} value={editName} onChange={(event) => setEditName(event.target.value)} required/></Field><Field label="Login email (Firebase identity)"><input className={`${inputClass} opacity-70`} value={teacher.email} readOnly/><span className="text-[10px] text-slate-500">The Firebase sign-in identity remains unchanged.</span></Field><Field label="Contact Gmail (@gmail.com)"><input type="email" className={inputClass} value={editEmail} onChange={(event) => setEditEmail(event.target.value)} required/><span className="text-[10px] text-slate-500">This editable contact address syncs with Teacher Settings.</span></Field><Field label="Designation"><input className={inputClass} value={editDesignation} onChange={(event) => setEditDesignation(event.target.value)}/></Field><Field label="WhatsApp / contact"><input className={inputClass} type="tel" inputMode="tel" value={editPhone} onChange={(event) => setEditPhone(event.target.value)}/></Field></div><div className="rounded-2xl border border-slate-200 p-3 dark:border-white/10"><div className="flex flex-wrap items-center gap-3"><TeacherAvatar teacher={teacher} size="md"/><div className="min-w-0 flex-1"><p className="text-sm font-black text-slate-900 dark:text-white">Profile photo</p><p className="text-[10px] text-slate-500">JPG, PNG or WebP · Maximum 3 MB</p></div><input type="file" accept="image/jpeg,image/png,image/webp" className="max-w-full text-xs" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && !validateImage(file)) { setEditPhoto(null); setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); event.target.value = ''; return; } setError(''); setEditPhoto(file); setRemoveEditPhoto(false); }}/>{(teacher.profileImageStoragePath || teacher.profileImage) && !editPhoto && <button type="button" onClick={() => setRemoveEditPhoto((value) => !value)} className="text-xs font-bold text-rose-600">{removeEditPhoto ? 'Undo removal' : 'Remove photo'}</button>}</div>{editPhotoPreview && <img src={editPhotoPreview} alt="New teacher profile photo preview" className="mt-3 h-20 w-20 rounded-xl object-cover"/>}{removeEditPhoto && <p className="mt-2 text-xs text-rose-700">The profile will show its default avatar after saving.</p>}</div><Field label="Reason for change"><textarea className={`${inputClass} min-h-20`} value={editReason} onChange={(event) => setEditReason(event.target.value)} required maxLength={500}/></Field>{error && <Notice>{error}</Notice>}<div className="flex justify-end gap-2"><button type="button" onClick={() => setEditOpen(false)} className={secondaryButtonClass} disabled={saving}>Cancel</button><button type="submit" className={buttonClass} disabled={saving || !editReason.trim()}>{saving ? 'Saving…' : 'Save changes'}</button></div></form></div>}
    {statusOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm"><form onSubmit={(event) => void updateStatus(event)} className="w-full max-w-lg space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900"><h2 className="text-lg font-black text-slate-950 dark:text-white">{teacher.active ? 'Deactivate teacher?' : 'Reactivate teacher?'}</h2><p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{teacher.active ? 'The teacher will no longer be able to sign in. Assigned records and financial history will be retained.' : 'The verified teacher will regain account access with their existing permissions.'}</p><Field label="Reason (required for audit)"><textarea className={`${inputClass} min-h-24`} value={statusReason} onChange={(event) => setStatusReason(event.target.value)} required maxLength={500}/></Field>{error && <Notice>{error}</Notice>}<div className="flex justify-end gap-2"><button type="button" onClick={() => setStatusOpen(false)} className={secondaryButtonClass} disabled={saving}>Cancel</button><button type="submit" className={`rounded-xl px-4 py-2.5 text-sm font-black text-white disabled:opacity-50 ${teacher.active ? 'bg-rose-600' : 'bg-emerald-600'}`} disabled={saving || !statusReason.trim()}>{saving ? 'Updating…' : 'Confirm'}</button></div></form></div>}
  </div>;
}
