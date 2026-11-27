import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, ArrowLeft, CheckCircle2, CreditCard, GraduationCap,
  Pencil, RefreshCw, ShieldCheck, UserPlus, Users, Verified,
} from 'lucide-react';
import { toast } from 'sonner';
import { getBlob, ref, uploadBytes } from 'firebase/storage';
import { auth, storage } from '@/lib/firebase';
import { academyManagementRequest, getAcademyAccess } from '@/lib/academyApi';
import {
  buttonClass, Cell, Empty, Field, inputClass, Loading, Notice, PageHeading,
  Panel, selectClass, Table, secondaryButtonClass,
} from './AcademyAdminUI';

type ConsentKey = 'attendanceWhatsAppOptIn' | 'parentWhatsAppOptIn' | 'quizResultsWhatsAppOptIn' | 'feeAlertsWhatsAppOptIn' | 'announcementWhatsAppOptIn' | 'libraryLinkWhatsAppOptIn';
type Subject = { id: string; name: string; code: string; monthlyFee: number; billingFrequency?: string; teacherUid?: string | null; teacherName?: string | null; assigned?: boolean };
type ClassRecord = { id: string; name: string; classCode: string; grade?: string; section?: string; academicYear?: string; status: string; subjects: Subject[] };
type Enrollment = { id?: string; classId: string; subjectId: string; subjectName: string; teacherUid: string; feeAmountMonthly: number; billingFrequency?: string; active?: boolean };
type Student = {
  id: string; name: string; rollNo: string; fatherName?: string; phone?: string; gender?: string;
  admissionDate?: string; avatar?: string; avatarStoragePath?: string; status?: string;
  primaryClassId?: string; paymentStatus?: 'Paid' | 'Unpaid'; outstandingBalance?: number;
  paymentStatusByClass?: Record<string, { status: 'Paid' | 'Unpaid'; outstandingBalance: number; billedAmount: number; paidAmount: number }>;
  paymentStatusMayBeIncomplete?: boolean; enrollments: Enrollment[];
};
type Ledger = {
  academyName: string;
  student: Student;
  invoices: Array<{ id: string; invoiceNumber?: string; billingMonth?: string; totalAmount?: number; paidAmount?: number; remainingBalance?: number; status?: string; issuedAt?: string | null; dueDate?: string | null }>;
  payments: Array<{ id: string; invoiceId?: string; amount?: number; paymentMethod?: string; paymentReference?: string; receiptNumber?: string; createdAt?: string | null; note?: string }>;
  totals: { billed: number; paid: number; outstanding: number };
  limited: boolean;
};

const CONSENTS: Array<{ key: ConsentKey; label: string; detail: string }> = [
  { key: 'attendanceWhatsAppOptIn', label: 'Attendance alerts', detail: 'Student present/absent updates' },
  { key: 'parentWhatsAppOptIn', label: 'Monthly PDF', detail: 'Monthly student report PDF' },
  { key: 'quizResultsWhatsAppOptIn', label: 'Quiz results', detail: 'Quiz marks and performance' },
  { key: 'feeAlertsWhatsAppOptIn', label: 'Fee alerts', detail: 'Invoice and due reminders' },
  { key: 'announcementWhatsAppOptIn', label: 'Announcements', detail: 'Academy/class announcements' },
  { key: 'libraryLinkWhatsAppOptIn', label: 'Notes & Library links', detail: 'Learning resource links' },
];
const emptyConsents = (): Record<ConsentKey, boolean> => ({
  attendanceWhatsAppOptIn: false, parentWhatsAppOptIn: false, quizResultsWhatsAppOptIn: false,
  feeAlertsWhatsAppOptIn: false, announcementWhatsAppOptIn: false, libraryLinkWhatsAppOptIn: false,
});
const money = (value: number) => `PKR ${Number(value || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
const normalizePhone = (value: string) => {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`;
  if (digits.length === 10) digits = `92${digits}`;
  return /^923\d{9}$/.test(digits) ? `+${digits}` : '';
};
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function StudentPhoto({ student }: { student: Pick<Student, 'name' | 'avatar' | 'avatarStoragePath'> }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    if (!student.avatarStoragePath) { setSrc(student.avatar || ''); return () => { active = false; }; }
    setSrc('');
    getBlob(ref(storage, student.avatarStoragePath))
      .then((blob) => { if (active) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => { if (active) setSrc(student.avatar || ''); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [student.avatar, student.avatarStoragePath]);
  return src
    ? <img src={src} alt={`${student.name} profile`} className="h-11 w-11 rounded-2xl object-cover" />
    : <div className="grid h-11 w-11 place-items-center rounded-2xl bg-orange-500/10 text-sm font-black text-orange-700">{student.name.slice(0, 1).toUpperCase()}</div>;
}

export default function AcademyStudentsPage() {
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [academyId, setAcademyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // New admission form.
  const [classId, setClassId] = useState('');
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('Male');
  const [admissionDate, setAdmissionDate] = useState(new Date().toISOString().slice(0, 10));
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [consents, setConsents] = useState<Record<ConsentKey, boolean>>(emptyConsents);
  const [verifiedPhone, setVerifiedPhone] = useState('');
  const [verificationStatus, setVerificationStatus] = useState<'idle' | 'checking' | 'registered' | 'not_registered' | 'failed'>('idle');

  // Class-card / roster view and filters.
  const [activeClassId, setActiveClassId] = useState('');
  const [classPage, setClassPage] = useState(1);
  const [studentPage, setStudentPage] = useState(1);
  const [genderFilter, setGenderFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [studentSearch, setStudentSearch] = useState('');
  const pageSize = 5;

  // Full student edit form.
  const [editStudent, setEditStudent] = useState<Student | null>(null);
  const [editName, setEditName] = useState('');
  const [editFather, setEditFather] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editGender, setEditGender] = useState('Male');
  const [editAdmissionDate, setEditAdmissionDate] = useState('');
  const [editClassId, setEditClassId] = useState('');
  const [editSubjectIds, setEditSubjectIds] = useState<string[]>([]);
  const [editAvatarFile, setEditAvatarFile] = useState<File | null>(null);
  const [editConsents, setEditConsents] = useState<Record<ConsentKey, boolean>>(emptyConsents);
  const [editReason, setEditReason] = useState('');
  const [archiveStudent, setArchiveStudent] = useState<Student | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  // Student fee ledger modal.
  const [ledgerStudent, setLedgerStudent] = useState<Student | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const selectedClass = useMemo(() => classes.find((item) => item.id === classId), [classes, classId]);
  const availableSubjects = selectedClass?.subjects ?? [];
  const selectedRows = availableSubjects.filter((subject) => selectedSubjects.includes(subject.id));
  const monthlyPreview = selectedRows.reduce((sum, subject) => sum + Number(subject.monthlyFee || 0), 0);
  const normalizedPhone = normalizePhone(phone);
  const editClass = useMemo(() => classes.find((item) => item.id === editClassId), [classes, editClassId]);
  const editAvailableSubjects = editClass?.subjects ?? [];
  const activeClass = useMemo(() => classes.find((item) => item.id === activeClassId), [classes, activeClassId]);
  const classPageCount = Math.max(1, Math.ceil(classes.length / pageSize));
  const visibleClasses = classes.slice((classPage - 1) * pageSize, classPage * pageSize);
  useEffect(() => { if (classPage > classPageCount) setClassPage(classPageCount); }, [classPage, classPageCount]);

  const classStudents = useMemo(() => students.filter((student) =>
    (student.enrollments ?? []).some((enrollment) => enrollment.classId === activeClassId && enrollment.active !== false),
  ), [students, activeClassId]);
  const filteredStudents = useMemo(() => classStudents.filter((student) => {
    const matchesGender = genderFilter === 'all' || student.gender?.toLowerCase() === genderFilter;
    const classPaymentStatus = student.paymentStatusByClass?.[activeClassId]?.status ?? 'Unpaid';
    const matchesPayment = paymentFilter === 'all' || classPaymentStatus.toLowerCase() === paymentFilter;
    const matchesSubject = subjectFilter === 'all' || (student.enrollments ?? []).some((enrollment) => enrollment.classId === activeClassId && enrollment.subjectId === subjectFilter && enrollment.active !== false);
    const query = studentSearch.trim().toLowerCase();
    const matchesSearch = !query || [student.name, student.rollNo, student.fatherName, student.phone].some((value) => String(value ?? '').toLowerCase().includes(query));
    return matchesGender && matchesPayment && matchesSubject && matchesSearch;
  }), [classStudents, genderFilter, paymentFilter, subjectFilter, activeClassId, studentSearch]);
  const studentPageCount = Math.max(1, Math.ceil(filteredStudents.length / pageSize));
  const visibleStudents = filteredStudents.slice((studentPage - 1) * pageSize, studentPage * pageSize);

  const load = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) { setError('Sign in again.'); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const [classResult, studentResult, access] = await Promise.all([
        academyManagementRequest<{ classes: ClassRecord[] }>(user, { action: 'classes' }),
        academyManagementRequest<{ students: Student[] }>(user, { action: 'students' }),
        getAcademyAccess(user),
      ]);
      setAcademyId(access.academyId);
      setClasses((classResult.classes ?? []).filter((item) => item.status !== 'archived'));
      setStudents(studentResult.students ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Student records could not be loaded.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setStudentPage(1); }, [genderFilter, paymentFilter, subjectFilter, studentSearch, activeClassId]);

  const toggleSubject = (subjectId: string) => setSelectedSubjects((previous) => previous.includes(subjectId) ? previous.filter((item) => item !== subjectId) : [...previous, subjectId]);
  const setConsent = (key: ConsentKey, checked: boolean) => setConsents((previous) => ({ ...previous, [key]: checked }));
  const setEditConsent = (key: ConsentKey, checked: boolean) => setEditConsents((previous) => ({ ...previous, [key]: checked }));
  const changePhone = (value: string) => { setPhone(value); setVerifiedPhone(''); setVerificationStatus('idle'); };

  const verifyPhone = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized) { toast.error('Invalid guardian number', { description: 'Enter a valid Pakistani mobile number, for example +92 3XX XXXXXXX.' }); return; }
    const user = auth.currentUser;
    if (!user) return;
    setVerificationStatus('checking'); setVerifiedPhone('');
    try {
      const result = await academyManagementRequest<{ results: Array<{ number: string; status: string }> }>(user, { action: 'verify-guardian-whatsapp', numbers: [normalized] });
      const entry = result.results?.[0];
      const registered = entry?.status === 'registered';
      setVerificationStatus(registered ? 'registered' : entry?.status === 'not_registered' ? 'not_registered' : 'failed');
      setVerifiedPhone(registered ? normalized : '');
      if (registered) toast.success('WhatsApp number found', { description: 'The optional check found this number on WhatsApp. Admission does not depend on this result.' });
      else toast.info('WhatsApp check did not confirm this number', { description: 'You can still save the student. This result is informational only.' });
    } catch (cause) {
      setVerificationStatus('failed');
      toast.info('WhatsApp check unavailable', { description: `${cause instanceof Error ? cause.message : 'The scanner could not check this number.'} You can still save the student.` });
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setMessage('');
    if (!name.trim() || !fatherName.trim() || !classId || !selectedSubjects.length || !['Male', 'Female'].includes(gender)) {
      setError('Name, father/guardian name, gender, class and at least one subject are required.'); return;
    }
    if (!normalizedPhone) { setError('Enter a valid Pakistani guardian number (+92 3XX XXXXXXX). WhatsApp registration checking is optional.'); return; }
    if (avatarFile && (!/^image\/(jpeg|png|webp)$/.test(avatarFile.type) || avatarFile.size > 3 * 1024 * 1024)) {
      setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); return;
    }
    const missing = selectedRows.filter((subject) => !subject.assigned || !subject.teacherUid);
    if (missing.length) { setError(`Assign a teacher to: ${missing.map((item) => item.name).join(', ')} before enrolling this student.`); return; }
    const user = auth.currentUser;
    if (!user) { setError('Your session has expired.'); return; }
    setSaving(true);
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const result = await academyManagementRequest<{ rollNo: string; studentId: string }>(user, {
        action: 'create-student', classId, subjectIds: selectedSubjects, idempotencyKey,
        values: { name: name.trim(), fatherName: fatherName.trim(), phone: normalizedPhone, gender, admissionDate, ...consents },
      });
      if (avatarFile && result.studentId && academyId) {
        try {
          const avatarRef = ref(storage, `academies/${academyId}/students/${result.studentId}/profile/avatar`);
          const uploaded = await uploadBytes(avatarRef, avatarFile, { contentType: avatarFile.type, customMetadata: { academyId, studentId: result.studentId } });
          await academyManagementRequest(user, {
            action: 'update-student', studentId: result.studentId, name: name.trim(), fatherName: fatherName.trim(),
            phone: normalizedPhone, gender, admissionDate, avatarStoragePath: uploaded.ref.fullPath,
            reason: 'Profile photo added during admission',
          });
        } catch (photoError) {
          toast.error('Student saved, but photo upload failed', { description: photoError instanceof Error ? photoError.message : 'Check Firebase Storage configuration and rules.' });
        }
      }
      setMessage(`Student added. Assigned roll number: ${result.rollNo}. WhatsApp registration checking is optional and did not control admission.`);
      setName(''); setFatherName(''); setPhone(''); setGender('Male'); setSelectedSubjects([]); setAvatarFile(null);
      setVerifiedPhone(''); setVerificationStatus('idle'); setConsents(emptyConsents());
      toast.success('Student admitted successfully', { description: `Roll number ${result.rollNo} has been assigned.` });
      await load();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : 'Student could not be added.';
      setError(msg); toast.error('Admission failed', { description: msg });
    } finally { setSaving(false); }
  };

  const openEdit = (student: Student) => {
    const preferredClassId = student.primaryClassId || student.enrollments?.find((item) => item.active !== false)?.classId || '';
    const currentEnrolments = (student.enrollments ?? []).filter((item) => item.classId === preferredClassId && item.active !== false);
    setEditStudent(student); setEditName(student.name); setEditFather(student.fatherName ?? ''); setEditPhone(student.phone ?? '');
    setEditGender(student.gender === 'Female' ? 'Female' : 'Male'); setEditAdmissionDate(student.admissionDate || new Date().toISOString().slice(0, 10));
    setEditClassId(preferredClassId); setEditSubjectIds(currentEnrolments.map((item) => item.subjectId)); setEditAvatarFile(null);
    setEditConsents({
      attendanceWhatsAppOptIn: Boolean((student as Student & Record<string, unknown>).attendanceWhatsAppOptIn),
      parentWhatsAppOptIn: Boolean((student as Student & Record<string, unknown>).parentWhatsAppOptIn),
      quizResultsWhatsAppOptIn: Boolean((student as Student & Record<string, unknown>).quizResultsWhatsAppOptIn),
      feeAlertsWhatsAppOptIn: Boolean((student as Student & Record<string, unknown>).feeAlertsWhatsAppOptIn),
      announcementWhatsAppOptIn: Boolean((student as Student & Record<string, unknown>).announcementWhatsAppOptIn),
      libraryLinkWhatsAppOptIn: Boolean((student as Student & Record<string, unknown>).libraryLinkWhatsAppOptIn),
    });
    setEditReason('');
  };
  const toggleEditSubject = (subjectId: string) => setEditSubjectIds((previous) => previous.includes(subjectId) ? previous.filter((item) => item !== subjectId) : [...previous, subjectId]);

  const saveStudent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editStudent) return;
    const user = auth.currentUser; if (!user) return;
    const normalized = editPhone.trim() ? normalizePhone(editPhone) : '';
    if (editPhone.trim() && !normalized) { toast.error('Invalid guardian number'); return; }
    if (!editClassId || !editSubjectIds.length) { toast.error('Select a class and at least one subject.'); return; }
    if (!editReason.trim()) { toast.error('Please provide a reason for this change.'); return; }
    const missing = editAvailableSubjects.filter((subject) => editSubjectIds.includes(subject.id) && (!subject.assigned || !subject.teacherUid));
    if (missing.length) { toast.error('Selected subjects must each have an active assigned teacher.'); return; }
    if (editAvatarFile && (!/^image\/(jpeg|png|webp)$/.test(editAvatarFile.type) || editAvatarFile.size > 3 * 1024 * 1024)) {
      toast.error('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); return;
    }
    setActionBusy(true);
    try {
      let avatarStoragePath: string | undefined;
      if (editAvatarFile) {
        const avatarRef = ref(storage, `academies/${academyId}/students/${editStudent.id}/profile/avatar`);
        const uploaded = await uploadBytes(avatarRef, editAvatarFile, { contentType: editAvatarFile.type, customMetadata: { academyId, studentId: editStudent.id } });
        avatarStoragePath = uploaded.ref.fullPath;
      }
      const result = await academyManagementRequest<{ phoneConsentReset: boolean; rollNo?: string }>(user, {
        action: 'update-student', studentId: editStudent.id,
        name: editName.trim(), fatherName: editFather.trim(), phone: normalized, gender: editGender,
        admissionDate: editAdmissionDate, classId: editClassId, subjectIds: editSubjectIds,
        ...(avatarStoragePath ? { avatarStoragePath } : {}), ...editConsents, reason: editReason.trim(),
      });
      setEditStudent(null); setEditAvatarFile(null);
      toast.success('Student profile updated', {
        description: result.phoneConsentReset
          ? `Guardian phone changed; old phone-specific consents were reset. The class roll number is ${result.rollNo || editStudent.rollNo}.`
          : `Profile, class and subject enrolments were updated. The class roll number is ${result.rollNo || editStudent.rollNo}.`,
      });
      await load();
    } catch (cause) { toast.error('Update failed', { description: cause instanceof Error ? cause.message : 'Student could not be updated.' }); }
    finally { setActionBusy(false); }
  };

  const openLedger = async (student: Student) => {
    const user = auth.currentUser; if (!user) return;
    setLedgerStudent(student); setLedger(null); setLedgerLoading(true);
    try {
      const result = await academyManagementRequest<Ledger>(user, { action: 'student-ledger', studentId: student.id });
      setLedger(result);
    } catch (cause) { toast.error('Fee ledger unavailable', { description: cause instanceof Error ? cause.message : 'Could not load payment history.' }); }
    finally { setLedgerLoading(false); }
  };

  const archive = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!archiveStudent || !archiveReason.trim()) return;
    const user = auth.currentUser; if (!user) return;
    setActionBusy(true);
    try {
      await academyManagementRequest(user, { action: 'archive-student', studentId: archiveStudent.id, reason: archiveReason.trim() });
      setArchiveStudent(null); setArchiveReason('');
      toast.success('Student archived', { description: 'The profile and historical records were retained; active subject enrolments were ended.' });
      await load();
    } catch (cause) { toast.error('Archive failed', { description: cause instanceof Error ? cause.message : 'Student could not be archived.' }); }
    finally { setActionBusy(false); }
  };

  return <>
    <PageHeading title="Students" description="Create one canonical student profile, enrol the student in Academy subjects and manage the class roster. WhatsApp availability checking is optional." action={<button type="button" className={secondaryButtonClass} onClick={() => void load()}><RefreshCw className="h-4 w-4"/> Refresh</button>} />
    {error && <Notice>{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
    {students.some((student) => student.paymentStatusMayBeIncomplete) && <Notice>Fee status may be incomplete because the current invoice query reached its 3,000-record limit. Open a student's fee ledger for that student's complete available history.</Notice>}

    <Panel className="mb-6">
      <div className="mb-5 flex items-center gap-3"><div className="rounded-xl bg-orange-500/10 p-3 text-orange-700 dark:text-orange-300"><UserPlus className="h-5 w-5"/></div><div><h2 className="font-black text-slate-900 dark:text-white">Add Academy student</h2><p className="text-xs text-slate-600 dark:text-slate-400">Choose a class, select subjects and save the canonical student profile.</p></div></div>
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Upload photo"><input className={inputClass} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}/><span className="text-[10px] text-slate-500">JPG, PNG or WebP · Max 3 MB</span></Field>
          <Field label="Student full name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} required maxLength={120}/></Field>
          <Field label="Father / guardian name"><input className={inputClass} value={fatherName} onChange={(event) => setFatherName(event.target.value)} required maxLength={120}/></Field>
          <Field label="Gender"><select className={selectClass} value={gender} onChange={(event) => setGender(event.target.value)}><option value="Male">Male</option><option value="Female">Female</option></select></Field>
          <Field label="Guardian phone (+92)"><input className={inputClass} value={phone} onChange={(event) => changePhone(event.target.value)} placeholder="+923001234567" required/><span className="text-[10px] text-slate-500">A valid phone is required; WhatsApp registration is not.</span></Field>
          <Field label="Admission date"><input className={inputClass} type="date" value={admissionDate} onChange={(event) => setAdmissionDate(event.target.value)} required/></Field>
          <Field label="Class"><select className={selectClass} value={classId} onChange={(event) => { setClassId(event.target.value); setSelectedSubjects([]); }} required><option value="">Choose class</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name} {item.section ? `· ${item.section}` : ''} · {item.classCode}</option>)}</select></Field>
          <div className="flex items-end"><button type="button" className={secondaryButtonClass} onClick={() => void verifyPhone()} disabled={verificationStatus === 'checking'}><ShieldCheck className="h-4 w-4"/>{verificationStatus === 'checking' ? 'Checking…' : 'Check WhatsApp (optional)'}</button></div>
        </div>
        {verificationStatus !== 'idle' && <div role="status" className={`rounded-xl border p-3 text-xs font-semibold ${verificationStatus === 'registered' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200'}`}>{verificationStatus === 'registered' ? <span className="inline-flex items-center gap-2"><Verified className="h-4 w-4"/> {verifiedPhone} is registered on WhatsApp. Admission can proceed.</span> : verificationStatus === 'not_registered' ? 'This number was not found on WhatsApp. Admission can still proceed.' : verificationStatus === 'checking' ? 'Checking registration. Student admission does not wait for this check.' : 'WhatsApp check failed or is unavailable. Student admission can still proceed.'}</div>}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-slate-950/40">
          <div className="mb-3"><h3 className="font-bold text-slate-900 dark:text-white">Guardian messaging consent</h3><p className="text-xs text-slate-500">Each purpose is optional and independent. Registration checking never enables a consent automatically.</p></div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{CONSENTS.map((item) => <label key={item.key} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${consents[item.key] ? 'border-orange-400/60 bg-orange-500/10' : 'border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900'}`}><input type="checkbox" className="h-4 w-4 accent-orange-500" checked={consents[item.key]} onChange={(event) => setConsent(item.key, event.target.checked)}/><span className="min-w-0"><strong className="block text-xs text-slate-800 dark:text-slate-100">{item.label}</strong><small className="text-[11px] text-slate-500">{item.detail}</small></span></label>)}</div>
          <p className="mt-3 text-xs text-slate-500">WhatsApp checking is informational only. Student admission and saving selected consents do not require a successful check.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-slate-950/40">
          <div className="mb-3"><h3 className="font-bold text-slate-900 dark:text-white">Select subject enrolments</h3><p className="text-xs text-slate-500">The responsible teacher and monthly fee come from the Academy subject assignment.</p></div>
          {!classId ? <Empty>Select a class to load its subjects.</Empty> : availableSubjects.length === 0 ? <Empty>This class has no configured subject offerings yet.</Empty> : <div className="grid gap-2 md:grid-cols-2">{availableSubjects.map((subject) => <label key={subject.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${selectedSubjects.includes(subject.id) ? 'border-orange-400/50 bg-orange-500/10' : 'border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900/60'}`}><input type="checkbox" className="mt-1 accent-orange-500" checked={selectedSubjects.includes(subject.id)} disabled={!subject.assigned || !subject.teacherUid} onChange={() => toggleSubject(subject.id)}/><div className="min-w-0 flex-1"><div className="font-bold text-slate-700 dark:text-slate-200">{subject.name}</div><div className="mt-1 text-xs text-slate-500">{subject.code} · {subject.teacherName || 'Teacher unassigned'}</div><div className="mt-1 text-sm font-black text-orange-700 dark:text-orange-300">{money(subject.monthlyFee)} / {subject.billingFrequency || 'month'}</div></div>{subject.assigned && <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400"/>}</label>)}</div>}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3 dark:border-white/10"><div className="text-sm text-slate-600 dark:text-slate-400">Selected monthly tuition preview <strong className="ml-2 text-lg text-slate-900 dark:text-white">{money(monthlyPreview)}</strong></div><span className="text-xs text-slate-500">No payment is collected during admission.</span></div>
        </div>
        <div className="flex items-center justify-between gap-3"><div className="text-xs text-slate-500">Roll number is allocated atomically by the server. Profile photos are private to active Academy members.</div><button type="submit" className={buttonClass} disabled={saving || !selectedRows.length}><UserPlus className="h-4 w-4"/>{saving ? 'Saving student…' : 'Create student & enrolments'}</button></div>
      </form>
    </Panel>

    <Panel>
      {!activeClassId ? <>
        <div className="mb-4 flex items-center gap-2"><GraduationCap className="h-5 w-5 text-orange-700 dark:text-orange-300"/><div><h2 className="font-black text-slate-900 dark:text-white">Academy classes</h2><p className="text-xs text-slate-500">Select a class to open its student roster.</p></div><span className="ml-auto rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600 dark:bg-white/10 dark:text-slate-400">{classes.length}</span></div>
        {loading ? <Loading/> : classes.length === 0 ? <Empty>No classes have been created yet.</Empty> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visibleClasses.map((item) => {
          const enrolled = students.filter((student) => (student.enrollments ?? []).some((enrollment) => enrollment.classId === item.id && enrollment.active !== false)).length;
          const monthly = item.subjects.reduce((sum, subject) => sum + Number(subject.monthlyFee || 0), 0);
          return <button type="button" key={item.id} onClick={() => { setActiveClassId(item.id); setGenderFilter('all'); setPaymentFilter('all'); setSubjectFilter('all'); setStudentSearch(''); }} className="group rounded-3xl border border-slate-200 bg-gradient-to-br from-white to-orange-50/50 p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-lg dark:border-white/10 dark:from-slate-900 dark:to-orange-950/20">
            <div className="flex items-start justify-between gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-orange-500/10 text-orange-700 dark:text-orange-300"><GraduationCap className="h-6 w-6"/></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${item.status === 'active' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>{item.status}</span></div>
            <h3 className="mt-4 text-lg font-black text-slate-900 dark:text-white">{item.name}{item.section ? ` · ${item.section}` : ''}</h3><p className="mt-1 font-mono text-[11px] text-orange-700 dark:text-orange-300">{item.classCode} · {item.academicYear || 'Academic year not set'}</p>
            <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-2xl bg-white/80 p-3 dark:bg-white/[0.04]"><p className="text-[9px] font-black uppercase text-slate-400">Enrolled students</p><p className="mt-1 flex items-center gap-2 text-lg font-black text-slate-900 dark:text-white"><Users className="h-4 w-4 text-orange-600"/>{enrolled}</p></div><div className="rounded-2xl bg-white/80 p-3 dark:bg-white/[0.04]"><p className="text-[9px] font-black uppercase text-slate-400">Subjects</p><p className="mt-1 text-lg font-black text-slate-900 dark:text-white">{item.subjects.length}</p></div></div>
            <div className="mt-3 flex flex-wrap gap-1">{item.subjects.slice(0, 4).map((subject) => <span key={subject.id} className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">{subject.name}</span>)}{item.subjects.length > 4 && <span className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] text-slate-500 dark:bg-white/[0.06]">+{item.subjects.length - 4}</span>}</div>
            <div className="mt-4 flex items-center justify-between border-t border-slate-200/80 pt-3 dark:border-white/10"><span className="text-xs font-bold text-slate-600 dark:text-slate-300">View students</span><span className="rounded-full bg-orange-500 px-3 py-1.5 text-[10px] font-black text-white transition group-hover:bg-orange-600">Open class →</span></div>
            <p className="mt-2 text-[10px] text-slate-500">Tuition reference: {money(monthly)} across configured subjects</p>
          </button>;
        })}</div>}
        {classes.length > pageSize && <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-white/10"><span className="text-xs text-slate-500">Showing {(classPage - 1) * pageSize + 1}–{Math.min(classPage * pageSize, classes.length)} of {classes.length} classes</span><div className="flex gap-2"><button type="button" className={secondaryButtonClass} disabled={classPage <= 1} onClick={() => setClassPage((value) => Math.max(1, value - 1))}>Previous</button><span className="rounded-xl bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">{classPage}/{classPageCount}</span><button type="button" className={secondaryButtonClass} disabled={classPage >= classPageCount} onClick={() => setClassPage((value) => Math.min(classPageCount, value + 1))}>Next</button></div></div>}
      </> : <>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><button type="button" onClick={() => setActiveClassId('')} className={secondaryButtonClass}><ArrowLeft className="h-4 w-4"/> All classes</button><div><h2 className="text-xl font-black text-slate-900 dark:text-white">{activeClass?.name} {activeClass?.section ? `· ${activeClass.section}` : ''}</h2><p className="text-xs text-slate-500">{activeClass?.classCode} · {classStudents.length} enrolled students</p></div></div><span className="rounded-full bg-orange-100 px-3 py-1.5 text-xs font-black text-orange-800 dark:bg-orange-500/10 dark:text-orange-200">Class roster</span></div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Field label="Gender"><select className={selectClass} value={genderFilter} onChange={(event) => setGenderFilter(event.target.value)}><option value="all">All genders</option><option value="male">Male</option><option value="female">Female</option></select></Field><Field label="Fee status"><select className={selectClass} value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}><option value="all">Paid & unpaid</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option></select></Field><Field label="Subject"><select className={selectClass} value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="all">All subjects</option>{(activeClass?.subjects ?? []).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></Field><Field label="Search students"><input className={inputClass} value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Name, roll no., guardian…"/></Field></div>
        <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-slate-500"><span className="rounded-full bg-slate-100 px-3 py-1.5 dark:bg-white/[0.06]">Showing {filteredStudents.length} matching students</span>{subjectFilter !== 'all' && <span className="rounded-full bg-orange-50 px-3 py-1.5 text-orange-700 dark:bg-orange-500/10 dark:text-orange-200">Subject-filtered roster: only enrolled students</span>}</div>
        {loading ? <Loading/> : filteredStudents.length === 0 ? <Empty>No students match these class filters.</Empty> : <div className="overflow-x-auto"><Table headers={['Student','Roll No.','Guardian / Contact','Subjects in this class','Fee status','Actions']}>
          {visibleStudents.map((student) => {
            const classEnrollments = (student.enrollments ?? []).filter((enrollment) => enrollment.classId === activeClassId && enrollment.active !== false);
            const classPayment = student.paymentStatusByClass?.[activeClassId];
            const classPaymentStatus = classPayment?.status ?? 'Unpaid';
            return <tr key={student.id}><Cell><div className="flex items-center gap-3"><StudentPhoto student={student}/><div><strong className="text-slate-900 dark:text-white">{student.name}</strong><div className="text-[11px] text-slate-500">{student.fatherName || '—'} · {student.gender || '—'}</div></div></div></Cell><Cell>{student.rollNo || '—'}</Cell><Cell>{student.phone || '—'}<div className="text-xs text-slate-500">Admitted {dateLabel(student.admissionDate)}</div></Cell><Cell><div className="flex flex-wrap gap-1">{classEnrollments.map((enrollment) => <span key={`${enrollment.classId}:${enrollment.subjectId}`} className="rounded-lg bg-slate-50 px-2 py-1 text-[11px] dark:bg-white/[0.06]">{enrollment.subjectName}</span>)}</div></Cell><Cell><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${classPaymentStatus === 'Paid' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'}`}>{classPaymentStatus}</span>{Number(classPayment?.outstandingBalance ?? 0) > 0 && <div className="mt-1 text-[10px] text-slate-500">Due {money(Number(classPayment?.outstandingBalance))}</div>}</Cell><Cell><div className="flex flex-wrap gap-2"><button type="button" className={secondaryButtonClass} disabled={student.status === 'archived'} onClick={() => openEdit(student)}><Pencil className="h-3.5 w-3.5"/> Edit</button><button type="button" className={secondaryButtonClass} onClick={() => void openLedger(student)}><CreditCard className="h-3.5 w-3.5"/> Ledger</button><button type="button" aria-label={`Archive ${student.name}`} disabled={student.status === 'archived'} onClick={() => { setArchiveStudent(student); setArchiveReason(''); }} className="rounded-xl border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-400/20 dark:text-rose-300"><Archive className="h-3.5 w-3.5"/></button></div></Cell></tr>;
          })}
        </Table></div>}
        {filteredStudents.length > pageSize && <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-white/10"><span className="text-xs text-slate-500">Showing {(studentPage - 1) * pageSize + 1}–{Math.min(studentPage * pageSize, filteredStudents.length)} of {filteredStudents.length} students</span><div className="flex gap-2"><button type="button" disabled={studentPage <= 1} onClick={() => setStudentPage((page) => Math.max(1, page - 1))} className={secondaryButtonClass}>Previous</button><span className="rounded-xl bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">{studentPage}/{studentPageCount}</span><button type="button" disabled={studentPage >= studentPageCount} onClick={() => setStudentPage((page) => Math.min(studentPageCount, page + 1))} className={secondaryButtonClass}>Next</button></div></div>}
      </>}
    </Panel>

    {editStudent && <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"><form onSubmit={(event) => void saveStudent(event)} className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900">
      <h2 className="text-lg font-black text-slate-900 dark:text-white">Edit student profile</h2><p className="mb-4 mt-1 text-xs text-slate-500">All editable admission fields and current subject enrolments are loaded here. Historical invoices and receipts remain unchanged. Changing class allocates a new roll number in that class.</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><Field label="Full name"><input className={inputClass} value={editName} onChange={(event) => setEditName(event.target.value)} required maxLength={120}/></Field><Field label="Father / guardian name"><input className={inputClass} value={editFather} onChange={(event) => setEditFather(event.target.value)} maxLength={120}/></Field><Field label="Guardian WhatsApp"><input className={inputClass} value={editPhone} onChange={(event) => setEditPhone(event.target.value)} placeholder="+92 3XX XXXXXXX"/></Field><Field label="Gender"><select className={selectClass} value={editGender} onChange={(event) => setEditGender(event.target.value)}><option>Male</option><option>Female</option></select></Field><Field label="Admission date"><input className={inputClass} type="date" value={editAdmissionDate} onChange={(event) => setEditAdmissionDate(event.target.value)} required/></Field><Field label="Class"><select className={selectClass} value={editClassId} onChange={(event) => { setEditClassId(event.target.value); setEditSubjectIds([]); }} required>{classes.map((item) => <option key={item.id} value={item.id}>{item.name} {item.section ? `· ${item.section}` : ''}</option>)}</select></Field><Field label="Replace profile photo"><input className={inputClass} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setEditAvatarFile(event.target.files?.[0] ?? null)}/><span className="text-[10px] text-slate-500">Optional · JPG/PNG/WebP · Max 3 MB</span></Field><div className="flex items-end text-xs text-slate-500">Current roll number: <strong className="ml-1 text-slate-900 dark:text-white">{editStudent.rollNo}</strong></div></div>
      <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-slate-950/40"><div className="mb-3"><h3 className="font-bold text-slate-900 dark:text-white">Subject enrolments</h3><p className="text-xs text-slate-500">Select all current and additional subjects for the chosen class.</p></div>{editAvailableSubjects.length === 0 ? <Empty>No active subjects are configured for this class.</Empty> : <div className="grid gap-2 md:grid-cols-2">{editAvailableSubjects.map((subject) => <label key={subject.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${editSubjectIds.includes(subject.id) ? 'border-orange-400/50 bg-orange-500/10' : 'border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900'}`}><input type="checkbox" className="mt-1 accent-orange-500" checked={editSubjectIds.includes(subject.id)} disabled={!subject.assigned || !subject.teacherUid} onChange={() => toggleEditSubject(subject.id)}/><span className="min-w-0 flex-1"><strong className="block text-xs text-slate-800 dark:text-slate-100">{subject.name}</strong><small className="text-[11px] text-slate-500">{subject.teacherName || 'Teacher unassigned'} · {money(subject.monthlyFee)}</small></span></label>)}</div>}</div>
      <div className="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-white/10"><h3 className="mb-3 font-bold text-slate-900 dark:text-white">Guardian messaging consent</h3><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{CONSENTS.map((item) => <label key={item.key} className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/[0.04]"><input type="checkbox" checked={editConsents[item.key]} onChange={(event) => setEditConsent(item.key, event.target.checked)} className="accent-orange-500"/><span>{item.label}</span></label>)}</div><p className="mt-2 text-[10px] text-slate-500">These are explicit consent preferences. The WhatsApp scanner is not required.</p></div>
      <div className="mt-4"><Field label="Reason for change"><textarea className={`${inputClass} min-h-20`} value={editReason} onChange={(event) => setEditReason(event.target.value)} required maxLength={500}/></Field></div>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setEditStudent(null)}>Cancel</button><button type="submit" className={buttonClass} disabled={actionBusy || !editReason.trim()}>{actionBusy ? 'Saving…' : 'Save student changes'}</button></div>
    </form></div>}

    {ledgerStudent && <div className="fixed inset-0 z-[92] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"><div role="dialog" aria-modal="true" className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">Academy payment ledger</p><h2 className="mt-1 text-xl font-black text-slate-900 dark:text-white">{ledgerStudent.name}</h2><p className="mt-1 text-xs text-slate-500">{ledger?.academyName || 'Academy'} · Roll no. {ledgerStudent.rollNo}</p></div><button type="button" className={secondaryButtonClass} onClick={() => { setLedgerStudent(null); setLedger(null); }}>Close</button></div>
      {ledgerLoading ? <div className="py-12"><Loading label="Loading full fee history…"/></div> : !ledger ? <Empty>Fee ledger could not be loaded.</Empty> : <>
        <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl bg-slate-50 p-4 dark:bg-white/[0.04]"><p className="text-[10px] font-black uppercase text-slate-500">Total billed</p><p className="mt-1 text-xl font-black text-slate-900 dark:text-white">{money(ledger.totals.billed)}</p></div><div className="rounded-2xl bg-emerald-50 p-4 dark:bg-emerald-500/10"><p className="text-[10px] font-black uppercase text-emerald-700 dark:text-emerald-300">Payments received</p><p className="mt-1 text-xl font-black text-emerald-800 dark:text-emerald-200">{money(ledger.totals.paid)}</p></div><div className="rounded-2xl bg-orange-50 p-4 dark:bg-orange-500/10"><p className="text-[10px] font-black uppercase text-orange-700 dark:text-orange-300">Outstanding</p><p className="mt-1 text-xl font-black text-orange-800 dark:text-orange-200">{money(ledger.totals.outstanding)}</p></div></div>
        {ledger.limited && <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">The API reached a safety result limit. Ask for a paged ledger API for older records beyond the returned range.</div>}
        <div className="mt-5"><h3 className="mb-2 font-black text-slate-900 dark:text-white">Invoices</h3>{ledger.invoices.length ? <div className="overflow-x-auto"><Table headers={['Billing month','Invoice','Issued','Total','Paid','Balance','Status']}>{ledger.invoices.map((invoice) => <tr key={invoice.id}><Cell>{invoice.billingMonth || '—'}</Cell><Cell>{invoice.invoiceNumber || invoice.id}</Cell><Cell>{dateLabel(invoice.issuedAt)}</Cell><Cell>{money(Number(invoice.totalAmount || 0))}</Cell><Cell className="font-bold text-emerald-700">{money(Number(invoice.paidAmount || 0))}</Cell><Cell className="font-bold">{money(Number(invoice.remainingBalance || 0))}</Cell><Cell>{invoice.status || '—'}</Cell></tr>)}</Table></div> : <Empty>No invoices have been issued for this student.</Empty>}</div>
        <div className="mt-5"><h3 className="mb-2 font-black text-slate-900 dark:text-white">Payment history</h3>{ledger.payments.length ? <div className="space-y-2">{ledger.payments.map((payment) => <div key={payment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-white/10"><div><p className="text-sm font-black text-slate-900 dark:text-white">{payment.paymentMethod || 'Payment'} · {payment.receiptNumber || payment.id}</p><p className="mt-1 text-[11px] text-slate-500">{dateLabel(payment.createdAt)} · {payment.paymentReference || 'No reference'} · Invoice {payment.invoiceId || '—'}</p></div><strong className="text-sm font-black text-emerald-700 dark:text-emerald-300">+ {money(Number(payment.amount || 0))}</strong></div>)}</div> : <Empty>No payment receipts recorded yet.</Empty>}</div>
      </>}
    </div></div>}

    {archiveStudent && <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"><form onSubmit={(event) => void archive(event)} className="w-full max-w-lg rounded-2xl border border-rose-200 bg-white p-5 shadow-2xl dark:border-rose-500/20 dark:bg-slate-900"><h2 className="text-lg font-black text-slate-900 dark:text-white">Archive {archiveStudent.name}?</h2><p className="mt-2 text-sm text-slate-600 dark:text-slate-400">This ends active subject enrolments and removes the student from active rosters. Historical invoices, payments, attendance and audit records are retained.</p><div className="mt-4"><Field label="Archive reason"><textarea className={`${inputClass} min-h-20`} value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} required maxLength={500}/></Field></div><div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setArchiveStudent(null)}>Cancel</button><button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-700" disabled={actionBusy || !archiveReason.trim()}>{actionBusy ? 'Archiving…' : 'Archive student'}</button></div></form></div>}
  </>;
}
