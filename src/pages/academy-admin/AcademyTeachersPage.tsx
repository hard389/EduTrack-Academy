import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BadgeCheck, BookOpen, Camera, CheckCircle2, Eye, EyeOff, FileBadge, Filter,
  GraduationCap, ImagePlus, Mail, Pencil, Phone, Plus, RefreshCw, Save, Search,
  ShieldCheck, UserPlus, Users, Wallet, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { auth, storage } from '@/lib/firebase';
import { academyManagementRequest, createAcademyTeacher, getAcademyAccess } from '@/lib/academyApi';
import {
  AcademyTeacherRow, CORE_PERMISSION_KEYS, TeacherAvatar, TeacherPermission,
  TeacherPermissionGroups, moneyPKR,
} from './AcademyTeacherModuleUI';
import { buttonClass, Empty, Field, inputClass, Loading, Notice, PageHeading, Panel, secondaryButtonClass } from './AcademyAdminUI';

type TeacherData = { teachers: AcademyTeacherRow[]; permissionDefinitions: TeacherPermission[]; meta?: { limited?: boolean } };
type Modal = 'create' | 'edit' | 'permissions' | 'status' | null;
const gmailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i;
const emptyPermissions = (definitions: TeacherPermission[]) => Object.fromEntries(definitions.map((item) => [item.key, false])) as Record<string, boolean>;
const validateImage = (file: File) => /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 3 * 1024 * 1024;

export default function AcademyTeachersPage() {
  const [data, setData] = useState<TeacherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [designationFilter, setDesignationFilter] = useState('all');
  const [teacherPage, setTeacherPage] = useState(1);
  const teacherPageSize = 5;
  const [modal, setModal] = useState<Modal>(null);
  const [target, setTarget] = useState<AcademyTeacherRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState('');

  const [teacherName, setTeacherName] = useState('');
  const [designation, setDesignation] = useState('');
  const [email, setEmail] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [permissionDraft, setPermissionDraft] = useState<Record<string, boolean>>({});

  const [editName, setEditName] = useState('');
  const [editDesignation, setEditDesignation] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhoto, setEditPhoto] = useState<File | null>(null);
  const [editPhotoPreview, setEditPhotoPreview] = useState('');
  const [removeEditPhoto, setRemoveEditPhoto] = useState(false);

  useEffect(() => {
    if (!photoFile) { setPhotoPreview(''); return; }
    const url = URL.createObjectURL(photoFile); setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);
  useEffect(() => {
    if (!editPhoto) { setEditPhotoPreview(''); return; }
    const url = URL.createObjectURL(editPhoto); setEditPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [editPhoto]);

  const load = useCallback(async (quiet = false) => {
    const user = auth.currentUser;
    if (!user) { setError('Your Academy session has expired. Please sign in again.'); setLoading(false); return; }
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const result = await academyManagementRequest<{ teachers: AcademyTeacherRow[]; permissionDefinitions: TeacherPermission[]; meta?: { limited?: boolean } }>(user, { action: 'teachers' });
      setData({ teachers: result.teachers ?? [], permissionDefinitions: result.permissionDefinitions ?? [], meta: result.meta });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not load Academy teachers.';
      setError(message); if (!quiet) toast.error('Teachers could not be loaded', { description: message });
    } finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const designations = useMemo(() => [...new Set((data?.teachers ?? []).map((teacher) => teacher.designation?.trim()).filter((item): item is string => Boolean(item)))].sort(), [data]);
  const filteredTeachers = useMemo(() => (data?.teachers ?? []).filter((teacher) => {
    const search = query.trim().toLowerCase();
    const matchesSearch = !search || [teacher.name, teacher.email, teacher.whatsappNumber, teacher.designation].some((value) => (value || '').toLowerCase().includes(search));
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? teacher.active && teacher.emailVerified : statusFilter === 'inactive' ? !teacher.active && teacher.emailVerified : !teacher.emailVerified);
    const matchesDesignation = designationFilter === 'all' || (teacher.designation || 'Unspecified') === designationFilter;
    return matchesSearch && matchesStatus && matchesDesignation;
  }), [data, query, statusFilter, designationFilter]);
  const visibleTeachers = useMemo(() => filteredTeachers.slice((teacherPage - 1) * teacherPageSize, teacherPage * teacherPageSize), [filteredTeachers, teacherPage]);
  const teacherPageCount = Math.max(1, Math.ceil(filteredTeachers.length / teacherPageSize));
  useEffect(() => { setTeacherPage(1); }, [query, statusFilter, designationFilter]);

  const openCreate = () => {
    setTarget(null); setTeacherName(''); setDesignation(''); setEmail(''); setWhatsappNumber('');
    setPassword(''); setConfirmPassword(''); setPhotoFile(null); setReason('');
    setPermissionDraft(emptyPermissions(data?.permissionDefinitions ?? [])); setShowPassword(false); setModal('create');
  };
  const openEdit = (teacher: AcademyTeacherRow) => {
    setTarget(teacher); setEditName(teacher.name); setEditDesignation(teacher.designation || '');
    setEditPhone(teacher.whatsappNumber || ''); setEditEmail(teacher.contactEmail || teacher.email); setEditPhoto(null); setRemoveEditPhoto(false); setReason(''); setModal('edit');
  };
  const openPermissions = (teacher: AcademyTeacherRow) => {
    setTarget(teacher); setPermissionDraft({ ...teacher.permissions }); setModal('permissions');
  };
  const openStatus = (teacher: AcademyTeacherRow) => { setTarget(teacher); setReason(''); setModal('status'); };

  const submitCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    const normalizedEmail = email.trim().toLowerCase();
    if (!teacherName.trim()) return setError('Teacher name is required.');
    if (!gmailPattern.test(normalizedEmail)) return setError('Enter a valid Gmail address ending in @gmail.com.');
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)) return setError('Password must contain at least 8 characters, one uppercase letter and one special character.');
    if (password !== confirmPassword) return setError('Initial password and confirmation do not match.');
    if (photoFile && !validateImage(photoFile)) return setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.');
    const user = auth.currentUser; if (!user) return setError('Your session has expired.');
    setSaving(true);
    try {
      const result = await createAcademyTeacher(user, {
        teacherName: teacherName.trim(), email: normalizedEmail, password,
        whatsappNumber: whatsappNumber.trim() || undefined, designation: designation.trim(), permissions: permissionDraft,
      });
      let photoSaved = true;
      if (photoFile) {
        try {
          // The storage object path is tenant and teacher scoped; the server validates the same path before saving it.
          const { academyId } = await getAcademyAccess(user);
          if (!academyId) throw new Error('The current session did not include an Academy identifier.');
          const teacherPhotoRef = ref(storage, `academies/${academyId}/teachers/${result.teacher.uid}/profile/avatar`);
          const uploaded = await uploadBytes(teacherPhotoRef, photoFile, { contentType: photoFile.type, customMetadata: { academyId, teacherUid: result.teacher.uid } });
          const profileImage = await getDownloadURL(uploaded.ref);
          await academyManagementRequest(user, { action: 'update-teacher', teacherUid: result.teacher.uid, displayName: teacherName.trim(), contactPhone: whatsappNumber.trim(), designation: designation.trim(), profileImageStoragePath: uploaded.ref.fullPath, profileImage, reason: 'Profile photo uploaded during teacher creation' });
        } catch (photoError) {
          photoSaved = false;
          toast.warning('Teacher created, photo not saved', { description: photoError instanceof Error ? photoError.message : 'Check Firebase Storage rules and try editing the profile photo later.' });
        }
      }
      toast.success('Teacher account created', { description: photoSaved ? 'Selected permissions were saved with the teacher membership.' : 'The teacher and selected permissions were saved; the photo can be uploaded later.' });
      setModal(null); setPhotoFile(null); setPassword(''); setConfirmPassword(''); await load(true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Teacher could not be created.';
      setError(message); toast.error('Teacher creation failed', { description: message });
    } finally { setSaving(false); }
  };

  const submitEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const user = auth.currentUser;
    if (!user || !target || !reason.trim()) return;
    if (!gmailPattern.test(editEmail.trim().toLowerCase())) { setError('Enter a valid contact Gmail ending in @gmail.com.'); return; }
    if (editPhoto && !validateImage(editPhoto)) { setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); return; }
    setSaving(true); setError('');
    try {
      let profileImageStoragePath: string | undefined;
      let profileImage: string | undefined;
      if (editPhoto) {
        const { academyId } = await getAcademyAccess(user);
        if (!academyId) throw new Error('The current session did not include an Academy identifier.');
        const uploaded = await uploadBytes(ref(storage, `academies/${academyId}/teachers/${target.uid}/profile/avatar`), editPhoto, { contentType: editPhoto.type, customMetadata: { academyId, teacherUid: target.uid } });
        profileImageStoragePath = uploaded.ref.fullPath;
        profileImage = await getDownloadURL(uploaded.ref);
      }
      await academyManagementRequest(user, { action: 'update-teacher', teacherUid: target.uid, displayName: editName.trim(), contactPhone: editPhone.trim(), contactEmail: editEmail.trim().toLowerCase(), designation: editDesignation.trim(), ...(profileImageStoragePath ? { profileImageStoragePath, profileImage } : {}), ...(removeEditPhoto ? { removeProfileImage: true } : {}), reason: reason.trim() });
      if (removeEditPhoto && target.profileImageStoragePath) {
        try { await deleteObject(ref(storage, target.profileImageStoragePath)); } catch { toast.warning('Photo reference removed', { description: 'The profile now uses its default avatar, but the old Storage object may need a manual cleanup.' }); }
      }
      toast.success('Teacher profile updated'); setModal(null); setEditPhoto(null); setRemoveEditPhoto(false); await load(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Teacher profile could not be updated.'; setError(message); toast.error('Profile update failed', { description: message }); }
    finally { setSaving(false); }
  };

  const submitPermissions = async () => {
    const user = auth.currentUser; if (!user || !target) return;
    setSaving(true); setError('');
    try {
      await academyManagementRequest(user, { action: 'update-teacher-permissions', teacherUid: target.uid, permissions: permissionDraft });
      toast.success('Teacher permissions saved', { description: 'The existing backend authorization model remains in force.' });
      setModal(null); await load(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Permissions could not be saved.'; setError(message); toast.error('Permission update failed', { description: message }); }
    finally { setSaving(false); }
  };

  const submitStatus = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const user = auth.currentUser;
    if (!user || !target || !reason.trim()) return;
    const active = !target.active;
    setSaving(true); setError('');
    try {
      await academyManagementRequest(user, { action: 'set-teacher-active', teacherUid: target.uid, active, reason: reason.trim() });
      toast.success(active ? 'Teacher reactivated' : 'Teacher deactivated', { description: 'Historical attendance, student and financial records were retained.' });
      setModal(null); await load(true);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Teacher status could not be changed.'; setError(message); toast.error('Status update failed', { description: message }); }
    finally { setSaving(false); }
  };

  const closeModal = () => { if (!saving) { setModal(null); setTarget(null); setError(''); } };
  const configurableCount = (teacher: AcademyTeacherRow) => Object.entries(teacher.permissions || {}).filter(([key, enabled]) => enabled && !CORE_PERMISSION_KEYS.has(key)).length;

  return <div className="space-y-6 pb-24">
    <div className="relative overflow-hidden rounded-[28px] border border-blue-100 bg-gradient-to-br from-white via-blue-50 to-cyan-50 p-5 shadow-xl shadow-blue-900/5 dark:border-blue-400/15 dark:from-slate-900 dark:via-blue-950/50 dark:to-cyan-950/30 sm:p-7">
      <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-cyan-300/25 blur-3xl" />
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"><div><div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/80 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-blue-700 dark:border-blue-400/20 dark:bg-slate-900/70 dark:text-cyan-300"><ShieldCheck className="h-3.5 w-3.5"/> Academy management</div><h1 className="mt-4 text-2xl font-black tracking-tight text-slate-950 dark:text-white sm:text-3xl">Teachers &amp; Permissions</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">Manage teacher accounts, assigned access and classroom relationships from one secure workspace.</p><div className="mt-4 flex flex-wrap gap-2 text-xs font-bold text-slate-600 dark:text-slate-300"><span className="rounded-full border border-blue-100 bg-white/80 px-3 py-1.5 dark:border-white/10 dark:bg-white/5">{data?.teachers.length ?? 0} teacher accounts</span><span className="rounded-full border border-emerald-100 bg-white/80 px-3 py-1.5 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300">{data?.teachers.filter((item) => item.active && item.emailVerified).length ?? 0} active</span><span className="rounded-full border border-amber-100 bg-white/80 px-3 py-1.5 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-300">{data?.teachers.filter((item) => !item.emailVerified).length ?? 0} pending verification</span></div></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void load(true)} disabled={refreshing || loading} className={secondaryButtonClass}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}/>{refreshing ? 'Refreshing…' : 'Refresh'}</button><button type="button" onClick={openCreate} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-4 py-3 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:-translate-y-0.5 hover:shadow-xl"><UserPlus className="h-4 w-4"/> Add teacher</button></div></div>
    </div>

    {error && !modal && <Notice>{error}</Notice>}
    {data?.meta?.limited && <Notice kind="success">The current teacher list or assignment snapshot reached a configured query limit. Some metrics may be incomplete; refine the data or request a paginated report before treating counts as exhaustive.</Notice>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[{ label: 'Teacher accounts', value: data?.teachers.length ?? 0, icon: Users, tone: 'blue' }, { label: 'Active & verified', value: data?.teachers.filter((item) => item.active && item.emailVerified).length ?? 0, icon: BadgeCheck, tone: 'emerald' }, { label: 'Teacher-class links', value: data?.teachers.reduce((sum, item) => sum + (item.assignedClassCount ?? 0), 0) ?? 0, icon: BookOpen, tone: 'cyan' }, { label: 'Teacher-student links', value: data?.teachers.reduce((sum, item) => sum + (item.assignedStudentCount ?? 0), 0) ?? 0, icon: GraduationCap, tone: 'orange' }].map((item) => <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-white/10 dark:bg-slate-900/80"><div className="flex items-center justify-between"><p className="text-xs font-bold text-slate-500 dark:text-slate-400">{item.label}</p><span className={`grid h-10 w-10 place-items-center rounded-xl ${item.tone === 'blue' ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : item.tone === 'emerald' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : item.tone === 'cyan' ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300' : 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300'}`}><item.icon className="h-5 w-5"/></span></div><div className="mt-3 text-3xl font-black tracking-tight text-slate-950 dark:text-white">{item.value.toLocaleString('en-PK')}</div></div>)}
    </div>

    <Panel className="!p-4 sm:!p-5">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2"><Users className="h-5 w-5 text-blue-600 dark:text-cyan-300"/><h2 className="text-lg font-black text-slate-950 dark:text-white">Academy teaching team</h2></div><p className="mt-1 text-xs text-slate-500">Real teacher memberships and their active class/subject assignments.</p></div><span className="w-fit rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600 dark:bg-white/10 dark:text-slate-300">{filteredTeachers.length} results</span></div>
      <div className="mb-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_200px_auto]">
        <label className="relative block"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search teacher name, email or contact…" className={`${inputClass} pl-10`}/></label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={inputClass}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="pending">Pending verification</option></select>
        <select value={designationFilter} onChange={(event) => setDesignationFilter(event.target.value)} className={inputClass}><option value="all">All designations</option>{designations.map((item) => <option key={item} value={item}>{item}</option>)}<option value="Unspecified">Unspecified</option></select><button type="button" onClick={() => { setQuery(''); setStatusFilter('all'); setDesignationFilter('all'); }} className={secondaryButtonClass}>Clear filters</button>
      </div>
      {loading ? <Loading label="Loading Academy teaching team…"/> : filteredTeachers.length === 0 ? <Empty>{data?.teachers.length ? 'No teachers match the selected search and filters.' : 'No teachers have been added to this Academy yet. Add the first teacher to get started.'}</Empty> : <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{visibleTeachers.map((teacher) => {
        const active = teacher.active && teacher.emailVerified;
        return <article key={teacher.uid} className="group overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm transition duration-300 hover:-translate-y-1 hover:border-blue-200 hover:shadow-xl hover:shadow-blue-900/10 dark:border-white/10 dark:bg-slate-900/80 dark:hover:border-cyan-400/30">
          <Link to={`/academy-admin/teachers/${teacher.uid}`} className="block p-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:p-5"><div className="flex items-start gap-3"><TeacherAvatar teacher={teacher} size="lg"/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-black text-slate-950 dark:text-white">{teacher.name}</h3><span className={`rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-wide ${active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : teacher.emailVerified ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>{active ? 'Active' : teacher.emailVerified ? 'Inactive' : 'Pending'}</span></div><p className="mt-1 truncate text-xs font-semibold text-blue-700 dark:text-cyan-300">{teacher.designation || 'Teacher'}</p><p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-slate-500"><Mail className="h-3.5 w-3.5 shrink-0"/>{teacher.email}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><Phone className="h-3.5 w-3.5"/>{teacher.whatsappNumber || 'No contact number'}</p></div></div>
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-xl border border-blue-100 bg-blue-50/80 p-2.5 dark:border-blue-400/10 dark:bg-blue-500/[0.07]"><BookOpen className="h-4 w-4 text-blue-700 dark:text-blue-300"/><p className="mt-2 text-lg font-black text-slate-900 dark:text-white">{teacher.assignedClassCount ?? teacher.assignedClassIds?.length ?? 0}</p><p className="text-[10px] font-bold text-slate-500">Classes</p></div><div className="rounded-xl border border-cyan-100 bg-cyan-50/80 p-2.5 dark:border-cyan-400/10 dark:bg-cyan-500/[0.07]"><GraduationCap className="h-4 w-4 text-cyan-700 dark:text-cyan-300"/><p className="mt-2 text-lg font-black text-slate-900 dark:text-white">{teacher.assignedStudentCount ?? 0}</p><p className="text-[10px] font-bold text-slate-500">Students</p></div><div className="rounded-xl border border-violet-100 bg-violet-50/80 p-2.5 dark:border-violet-400/10 dark:bg-violet-500/[0.07]"><BookOpen className="h-4 w-4 text-violet-700 dark:text-violet-300"/><p className="mt-2 text-lg font-black text-slate-900 dark:text-white">{teacher.assignedSubjectCount ?? teacher.assignedSubjectIds?.length ?? 0}</p><p className="text-[10px] font-bold text-slate-500">Subject assignments</p></div><div className="rounded-xl border border-orange-100 bg-orange-50/80 p-2.5 dark:border-orange-400/10 dark:bg-orange-500/[0.07]"><ShieldCheck className="h-4 w-4 text-orange-700 dark:text-orange-300"/><p className="mt-2 text-lg font-black text-slate-900 dark:text-white">{configurableCount(teacher)}</p><p className="text-[10px] font-bold text-slate-500">Permissions</p></div></div>
          </Link>
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/80 p-3 dark:border-white/[0.06] dark:bg-slate-950/30"><Link to={`/academy-admin/teachers/${teacher.uid}`} className="mr-auto inline-flex items-center gap-1.5 px-1 text-xs font-black text-blue-700 hover:text-cyan-700 dark:text-cyan-300">View profile <span aria-hidden>→</span></Link><button type="button" onClick={() => openEdit(teacher)} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-300" title="Edit teacher"><Pencil className="h-4 w-4"/></button><button type="button" onClick={() => openPermissions(teacher)} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-blue-200 hover:text-blue-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-300" title="Manage permissions"><ShieldCheck className="h-4 w-4"/></button><button type="button" onClick={() => openStatus(teacher)} disabled={!teacher.active && !teacher.emailVerified} className={`rounded-lg border p-2 transition disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'border-rose-200 bg-white text-rose-600 hover:bg-rose-50 dark:border-rose-500/20 dark:bg-slate-900 dark:text-rose-300' : 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/20 dark:bg-slate-900 dark:text-emerald-300'}`} title={active ? 'Deactivate teacher' : 'Reactivate teacher'}><UserPlus className="h-4 w-4"/></button></div>
        </article>;
      })}</div>}{filteredTeachers.length > teacherPageSize && <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-white/10"><span className="text-xs text-slate-500">Page {teacherPage} of {teacherPageCount} · {filteredTeachers.length} teachers</span><div className="flex gap-2"><button type="button" disabled={teacherPage <= 1} onClick={() => setTeacherPage((page) => Math.max(1, page - 1))} className={secondaryButtonClass}>Previous</button><button type="button" disabled={teacherPage >= teacherPageCount} onClick={() => setTeacherPage((page) => Math.min(teacherPageCount, page + 1))} className={secondaryButtonClass}>Next</button></div></div>}
    </Panel>

    {modal && <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-950/65 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="teacher-modal-title" className="my-auto max-h-[calc(100dvh-24px)] w-full max-w-5xl overflow-y-auto rounded-[26px] border border-slate-200 bg-slate-50 shadow-2xl dark:border-white/10 dark:bg-slate-950 sm:max-h-[calc(100dvh-48px)]">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white/95 p-4 backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/95 sm:p-5"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-700 dark:text-cyan-300">Academy workspace</p><h2 id="teacher-modal-title" className="mt-1 text-xl font-black text-slate-950 dark:text-white">{modal === 'create' ? 'Add a teacher' : modal === 'edit' ? 'Edit teacher profile' : modal === 'permissions' ? 'Manage teacher permissions' : target?.active ? 'Deactivate teacher' : 'Reactivate teacher'}</h2><p className="mt-1 text-xs text-slate-500">{modal === 'create' ? 'Create the secure account and configure the teacher’s initial access.' : target ? `${target.name} · ${target.email}` : ''}</p></div><button type="button" onClick={closeModal} disabled={saving} aria-label="Close dialog" className="rounded-xl border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-100 dark:border-white/10 dark:bg-slate-800 dark:text-slate-300"><X className="h-5 w-5"/></button></div>
        {error && <div className="px-4 pt-4 sm:px-5"><Notice>{error}</Notice></div>}
        {modal === 'create' && <form onSubmit={(event) => void submitCreate(event)} className="space-y-5 p-4 sm:p-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
            <div className="space-y-4"><section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900"><h3 className="flex items-center gap-2 text-sm font-black text-slate-900 dark:text-white"><Camera className="h-4 w-4 text-blue-600"/> Teacher photo</h3><div className="mt-4 flex items-center gap-4"><div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-100 to-cyan-100 text-blue-700 dark:border-blue-400/20 dark:from-blue-500/10 dark:to-cyan-500/10">{photoPreview ? <img src={photoPreview} alt="Teacher preview" className="h-full w-full object-cover"/> : <ImagePlus className="h-7 w-7"/>}</div><div><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"><Camera className="h-4 w-4"/> Choose photo<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && !validateImage(file)) { setPhotoFile(null); setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); event.target.value = ''; return; } setError(''); setPhotoFile(file); }}/></label>{photoFile && <button type="button" onClick={() => setPhotoFile(null)} className="ml-2 text-xs font-bold text-rose-600">Remove</button>}<p className="mt-2 text-[10px] leading-relaxed text-slate-500">JPG, PNG or WebP · Maximum 3 MB. A default avatar is used when no photo is selected.</p></div></div></section>
              <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900"><h3 className="text-sm font-black text-slate-900 dark:text-white">Personal information</h3><div className="mt-4 space-y-3"><Field label="Teacher name"><input className={inputClass} value={teacherName} onChange={(event) => setTeacherName(event.target.value)} maxLength={100} required placeholder="Full name"/></Field><Field label="Role / designation (display only)"><input className={inputClass} value={designation} onChange={(event) => setDesignation(event.target.value)} maxLength={80} placeholder="e.g. Mathematics Teacher"/><span className="text-[10px] text-slate-500">This label does not grant additional system privileges. The account role remains Teacher.</span></Field><Field label="Gmail address"><input type="email" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required placeholder="teacher@gmail.com"/></Field><Field label="WhatsApp / contact number"><input className={inputClass} type="tel" inputMode="tel" value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value)} maxLength={20} placeholder="+92 300 1234567"/></Field><Field label="Initial password"><div className="relative"><input type={showPassword ? 'text' : 'password'} className={`${inputClass} pr-11`} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required/><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff className="h-4 w-4"/> : <Eye className="h-4 w-4"/>}</button></div></Field><Field label="Confirm password"><input type={showPassword ? 'text' : 'password'} className={inputClass} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required/></Field><p className="rounded-xl bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500 dark:bg-white/[0.04]">Password is sent to Firebase Authentication only. It is not stored in the teacher documents, permission data, logs or profile responses. The teacher must verify the email before sign-in.</p></div></section>
            </div>
            <div className="min-w-0"><div className="mb-3"><h3 className="text-sm font-black text-slate-900 dark:text-white">Initial teacher permissions</h3><p className="mt-1 text-xs text-slate-500">Only the existing permission keys are available. No Academy Admin role or unsupported privilege is created.</p></div><TeacherPermissionGroups definitions={data?.permissionDefinitions ?? []} value={permissionDraft} onChange={setPermissionDraft}/></div>
          </div>
          <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50/95 pt-4 backdrop-blur dark:border-white/10 dark:bg-slate-950/95 sm:flex-row sm:justify-end"><button type="button" className={secondaryButtonClass} onClick={closeModal} disabled={saving}>Cancel</button><button type="submit" className={buttonClass} disabled={saving}><UserPlus className="h-4 w-4"/>{saving ? 'Creating teacher…' : 'Create teacher & save permissions'}</button></div>
        </form>}

        {modal === 'permissions' && <div className="space-y-5 p-4 sm:p-5"><TeacherPermissionGroups definitions={data?.permissionDefinitions ?? []} value={permissionDraft} onChange={setPermissionDraft} disabled={saving}/><div className="flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-white/10"><button type="button" className={secondaryButtonClass} onClick={closeModal} disabled={saving}>Cancel</button><button type="button" className={buttonClass} onClick={() => void submitPermissions()} disabled={saving}><Save className="h-4 w-4"/>{saving ? 'Saving…' : 'Save permissions'}</button></div></div>}

        {modal === 'edit' && target && <form onSubmit={(event) => void submitEdit(event)} className="space-y-5 p-4 sm:p-5"><div className="grid gap-4 md:grid-cols-2"><Field label="Teacher name"><input className={inputClass} value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={120} required/></Field><Field label="Login Gmail (Firebase identity)"><input className={`${inputClass} opacity-70`} value={target.email} readOnly/><span className="text-[10px] text-slate-500">The Firebase login identity remains fixed.</span></Field><Field label="Contact Gmail (@gmail.com)"><input type="email" className={inputClass} value={editEmail} onChange={(event) => setEditEmail(event.target.value)} required/><span className="text-[10px] text-slate-500">Editable and synchronized with the Teacher Settings profile.</span></Field><Field label="Role / designation"><input className={inputClass} value={editDesignation} onChange={(event) => setEditDesignation(event.target.value)} maxLength={80}/></Field><Field label="WhatsApp / contact"><input className={inputClass} value={editPhone} onChange={(event) => setEditPhone(event.target.value)} maxLength={32}/></Field></div><div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900"><div className="flex flex-wrap items-center gap-3"><TeacherAvatar teacher={target} size="md"/><div className="min-w-0 flex-1"><p className="text-sm font-black text-slate-900 dark:text-white">Profile photo</p><p className="text-xs text-slate-500">Choose a replacement image (JPG, PNG or WebP, up to 3 MB).</p></div><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-700 dark:border-white/10 dark:text-slate-200"><Camera className="h-4 w-4"/> Upload<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && !validateImage(file)) { setEditPhoto(null); setError('Photo must be JPG, PNG or WebP and smaller than 3 MB.'); event.target.value = ''; return; } setError(''); setEditPhoto(file); setRemoveEditPhoto(false); }}/></label>{editPhoto && <span className="text-xs font-bold text-emerald-700">New photo selected</span>}{(target.profileImageStoragePath || target.profileImage) && !editPhoto && <button type="button" onClick={() => setRemoveEditPhoto((value) => !value)} className="text-xs font-bold text-rose-600">{removeEditPhoto ? 'Undo photo removal' : 'Remove current photo'}</button>}</div>{editPhotoPreview && <img src={editPhotoPreview} alt="Replacement preview" className="mt-3 h-24 w-24 rounded-2xl object-cover"/>}{removeEditPhoto && <p className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-700">The teacher will use the default avatar after saving.</p>}</div><Field label="Reason for profile change (required for audit)"><textarea className={`${inputClass} min-h-24`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required placeholder="Explain why this profile is being updated…"/></Field><div className="flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-white/10"><button type="button" className={secondaryButtonClass} onClick={closeModal} disabled={saving}>Cancel</button><button type="submit" className={buttonClass} disabled={saving || !reason.trim()}><Save className="h-4 w-4"/>{saving ? 'Saving…' : 'Save profile'}</button></div></form>}

        {modal === 'status' && target && <form onSubmit={(event) => void submitStatus(event)} className="space-y-5 p-4 sm:p-5"><div className={`rounded-2xl border p-4 ${target.active ? 'border-rose-200 bg-rose-50 dark:border-rose-500/20 dark:bg-rose-500/10' : 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/20 dark:bg-emerald-500/10'}`}><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-white text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200">{target.active ? <X className="h-5 w-5"/> : <CheckCircle2 className="h-5 w-5"/>}</div><div><p className="text-sm font-black text-slate-900 dark:text-white">{target.active ? 'Deactivate this teacher?' : 'Reactivate this teacher?'}</p><p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{target.active ? 'Sign-in will be disabled and Academy membership access revoked. Historical class, attendance, quiz and finance records remain.' : 'The teacher will regain access using their existing permissions and assignments. Email verification is required.'}</p></div></div></div><Field label="Reason (required for audit)"><textarea className={`${inputClass} min-h-24`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required placeholder="Provide a clear reason…"/></Field><div className="flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-white/10"><button type="button" className={secondaryButtonClass} onClick={closeModal} disabled={saving}>Cancel</button><button type="submit" disabled={saving || !reason.trim()} className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-white transition disabled:opacity-50 ${target.active ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>{saving ? 'Updating…' : target.active ? 'Confirm deactivation' : 'Confirm reactivation'}</button></div></form>}
      </div>
    </div>}
  </div>;
}
