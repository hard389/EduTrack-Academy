import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Pencil, Plus, RefreshCw, School, BookOpen, Users, BadgeCheck } from 'lucide-react';
import { toast } from 'sonner';
import { auth } from '@/lib/firebase';
import { academyManagementRequest } from '@/lib/academyApi';
import { buttonClass, Cell, Empty, Field, inputClass, Loading, Notice, PageHeading, Panel, selectClass, Table, secondaryButtonClass } from './AcademyAdminUI';

type Teacher = { uid: string; name: string; email: string; active: boolean; emailVerified: boolean };
type SubjectRow = { name: string; monthlyFee: string; teacherUid: string; billingFrequency: string };
type ClassRecord = { id: string; name: string; classCode: string; grade?: string; section?: string; academicYear?: string; status: string; subjectCount?: number; subjects: Array<{ id: string; name: string; code: string; monthlyFee: number; billingFrequency?: string; teacherUid?: string | null; teacherName?: string | null; assigned?: boolean }> };
type Data = { classes: ClassRecord[]; teachers: Teacher[] };
const emptySubject = (): SubjectRow => ({ name: '', monthlyFee: '0', teacherUid: '', billingFrequency: 'monthly' });
const money = (value: number) => `PKR ${Number(value || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;

export default function AcademyClassesPage() {
  const [data, setData] = useState<Data>({ classes: [], teachers: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [grade, setGrade] = useState('');
  const [section, setSection] = useState('');
  const [academicYear, setAcademicYear] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [subjects, setSubjects] = useState<SubjectRow[]>([emptySubject()]);
  const [editingClass, setEditingClass] = useState<ClassRecord | null>(null);
  const [editingSubject, setEditingSubject] = useState<{ classId: string; subject: ClassRecord['subjects'][number] } | null>(null);
  const [editName, setEditName] = useState('');
  const [editGrade, setEditGrade] = useState('');
  const [editSection, setEditSection] = useState('');
  const [editYear, setEditYear] = useState('');
  const [editSubjectName, setEditSubjectName] = useState('');
  const [editSubjectFee, setEditSubjectFee] = useState('0');
  const [editSubjectTeacherUid, setEditSubjectTeacherUid] = useState('');
  const [editSubjectBillingFrequency, setEditSubjectBillingFrequency] = useState('monthly');
  const [classPage, setClassPage] = useState(1);
  const [subjectPages, setSubjectPages] = useState<Record<string, number>>({});
  const classPageSize = 5;
  const [editReason, setEditReason] = useState('');
  const [changeBusy, setChangeBusy] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ kind: 'class' | 'subject'; classId: string; recordId: string; label: string } | null>(null);
  const [archiveReason, setArchiveReason] = useState('');

  const load = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) { setError('Sign in again to manage Classes & Subjects.'); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await academyManagementRequest<{ classes: ClassRecord[]; teachers: Teacher[] }>(user, { action: 'classes' });
      setData({ classes: result.classes ?? [], teachers: (result.teachers ?? []).filter((teacher) => teacher.active && teacher.emailVerified) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load Academy classes.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const preview = useMemo(() => subjects.reduce((sum, row) => sum + Math.max(0, Number(row.monthlyFee || 0)), 0), [subjects]);
  const classPageCount = Math.max(1, Math.ceil(data.classes.length / classPageSize));
  const visibleClasses = data.classes.slice((classPage - 1) * classPageSize, classPage * classPageSize);
  useEffect(() => { if (classPage > classPageCount) setClassPage(classPageCount); }, [classPage, classPageCount]);
  const updateSubject = (index: number, patch: Partial<SubjectRow>) => setSubjects((previous) => previous.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));

  const openClassEditor = (item: ClassRecord) => { setEditingClass(item); setEditingSubject(null); setEditName(item.name); setEditGrade(item.grade ?? ''); setEditSection(item.section ?? ''); setEditYear(item.academicYear ?? ''); setEditReason(''); };
  const openSubjectEditor = (classId: string, subject: ClassRecord['subjects'][number]) => { setEditingSubject({ classId, subject }); setEditingClass(null); setEditSubjectName(subject.name); setEditSubjectFee(String(subject.monthlyFee)); setEditSubjectTeacherUid(subject.teacherUid ?? ''); setEditSubjectBillingFrequency(subject.billingFrequency ?? 'monthly'); setEditReason(''); };
  const saveChanges = async () => {
    const user = auth.currentUser; if (!user || !editReason.trim()) { setError('Enter a reason for this change.'); return; }
    setChangeBusy(true); setError('');
    try {
      if (editingClass) {
        await academyManagementRequest(user, { action: 'update-class', classId: editingClass.id, name: editName.trim(), grade: editGrade, section: editSection, academicYear: editYear, reason: editReason.trim() });
        toast.success('Class updated', { description: 'The change was recorded in the Academy audit log.' });
      } else if (editingSubject) {
        await academyManagementRequest(user, { action: 'update-subject', subjectId: editingSubject.subject.id, name: editSubjectName.trim(), monthlyFee: Number(editSubjectFee), teacherUid: editSubjectTeacherUid, billingFrequency: editSubjectBillingFrequency, reason: editReason.trim() });
        toast.success('Subject updated', { description: 'The updated fee, billing frequency and teacher assignment apply to active enrolments; issued invoices remain unchanged.' });
      }
      setEditingClass(null); setEditingSubject(null); await load();
    } catch (cause) { const msg = cause instanceof Error ? cause.message : 'The record could not be updated.'; setError(msg); toast.error('Update failed', { description: msg }); }
    finally { setChangeBusy(false); }
  };
  const archiveRecord = (kind: 'class' | 'subject', classId: string, recordId: string, label: string) => {
    setArchiveTarget({ kind, classId, recordId, label }); setArchiveReason('');
  };
  const submitArchive = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const user = auth.currentUser; if (!user || !archiveTarget || !archiveReason.trim()) return;
    setChangeBusy(true); setError('');
    try { await academyManagementRequest(user, archiveTarget.kind === 'class' ? { action: 'archive-class', classId: archiveTarget.classId, reason: archiveReason.trim() } : { action: 'archive-subject', subjectId: archiveTarget.recordId, reason: archiveReason.trim() }); toast.success(`${archiveTarget.kind === 'class' ? 'Class' : 'Subject'} archived`, { description: 'Historical records were preserved and the reason was audit logged.' }); setArchiveTarget(null); setArchiveReason(''); await load(); }
    catch (cause) { const msg = cause instanceof Error ? cause.message : 'The record could not be archived.'; setError(msg); toast.error('Archive failed', { description: msg }); }
    finally { setChangeBusy(false); }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setMessage('');
    const cleaned = subjects.map((row) => ({ ...row, name: row.name.trim(), monthlyFee: Number(row.monthlyFee) }));
    if (!name.trim() || !cleaned.length || cleaned.some((row) => !row.name || !Number.isFinite(row.monthlyFee) || row.monthlyFee < 0)) { setError('Enter a class name and valid details for every subject.'); return; }
    if (new Set(cleaned.map((row) => row.name.toLowerCase())).size !== cleaned.length) { setError('Subject names must be unique inside this class.'); return; }
    const user = auth.currentUser; if (!user) { setError('Your session has expired.'); return; }
    setSaving(true);
    try {
      await academyManagementRequest(user, { action: 'create-class', name: name.trim(), grade, section, academicYear, effectiveFrom, subjects: cleaned.map((row) => ({ name: row.name, monthlyFee: row.monthlyFee, teacherUid: row.teacherUid || null, billingFrequency: row.billingFrequency })) });
      setMessage('Class, subject offerings and assigned teachers were saved.');
      toast.success('Class created', { description: 'The Academy class and subject configuration has been saved.' });
      setName(''); setGrade(''); setSection(''); setAcademicYear(''); setSubjects([emptySubject()]);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Class could not be created.'); }
    finally { setSaving(false); }
  };

  return <>
    <PageHeading title="Classes & Subjects" description="Set up each class, configure individual subject tuition and assign a verified Academy teacher to every subject offering." action={<button type="button" onClick={() => void load()} className={secondaryButtonClass}><RefreshCw className="h-4 w-4"/> Refresh</button>} />
    {error && <Notice>{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
    <Panel className="mb-6">
      <div className="mb-5 flex items-center gap-3"><div className="rounded-xl bg-orange-500/10 p-3 text-orange-700 dark:text-orange-300"><School className="h-5 w-5"/></div><div><h2 className="font-black text-slate-900 dark:text-white">Create Class & Subject offerings</h2><p className="text-xs text-slate-600 dark:text-slate-400">Class and subject codes are generated by trusted server logic.</p></div></div>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Class name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="Class 11" maxLength={100} required/></Field>
          <Field label="Grade / level"><input className={inputClass} value={grade} onChange={(event) => setGrade(event.target.value)} placeholder="11" maxLength={32}/></Field>
          <Field label="Section"><input className={inputClass} value={section} onChange={(event) => setSection(event.target.value)} placeholder="A" maxLength={32}/></Field>
          <Field label="Academic year / term"><input className={inputClass} value={academicYear} onChange={(event) => setAcademicYear(event.target.value)} placeholder="2026-2027" maxLength={24}/></Field>
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold text-slate-900 dark:text-white">Subject offerings</h3><p className="text-xs text-slate-500">Different subjects in the same class can belong to different teachers.</p></div><button type="button" className={secondaryButtonClass} onClick={() => setSubjects((rows) => [...rows, emptySubject()])}><Plus className="h-4 w-4"/> Add subject</button></div>
          {subjects.map((row, index) => <div key={index} className="grid gap-3 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-950/50 p-3 sm:grid-cols-2 xl:grid-cols-[1.3fr_0.7fr_1fr_0.8fr_auto]">
            <Field label={`Subject ${index + 1}`}><input className={inputClass} value={row.name} onChange={(event) => updateSubject(index, { name: event.target.value })} placeholder="Chemistry" maxLength={100} required/></Field>
            <Field label="Monthly tuition (PKR)"><input className={inputClass} type="number" min="0" step="0.01" value={row.monthlyFee} onChange={(event) => updateSubject(index, { monthlyFee: event.target.value })}/></Field>
            <Field label="Assign teacher"><select className={selectClass} value={row.teacherUid} onChange={(event) => updateSubject(index, { teacherUid: event.target.value })}><option value="">Unassigned draft</option>{data.teachers.map((teacher) => <option key={teacher.uid} value={teacher.uid}>{teacher.name} · {teacher.email}</option>)}</select></Field>
            <Field label="Billing frequency"><select className={selectClass} value={row.billingFrequency} onChange={(event) => updateSubject(index, { billingFrequency: event.target.value })}><option value="monthly">Monthly</option><option value="termly">Termly</option><option value="yearly">Yearly</option></select></Field>
            <div className="flex items-end"><button type="button" className={`${secondaryButtonClass} w-full`} disabled={subjects.length === 1} onClick={() => setSubjects((rows) => rows.filter((_, i) => i !== index))}>Remove</button></div>
          </div>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 dark:border-white/10 pt-4"><div className="text-sm text-slate-600 dark:text-slate-400">Recurring tuition preview <strong className="ml-2 text-lg text-slate-900 dark:text-white">{money(preview)}</strong></div><button type="submit" disabled={saving} className={buttonClass}><Plus className="h-4 w-4"/>{saving ? 'Saving class…' : 'Create class'}</button></div>
      </form>
    </Panel>
    <div className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300"><BookOpen className="h-4 w-4 text-orange-700 dark:text-orange-300"/> Academy class catalogue</div>
    {loading ? <Loading/> : data.classes.length === 0 ? <Empty>No Academy classes yet. Use the form above to configure the first class.</Empty> : <div className="grid gap-4 xl:grid-cols-2">{visibleClasses.map((item) => {
      const subjectPage = subjectPages[item.id] ?? 1;
      const subjectPageCount = Math.max(1, Math.ceil(item.subjects.length / classPageSize));
      const visibleSubjects = item.subjects.slice((subjectPage - 1) * classPageSize, subjectPage * classPageSize);
      return <Panel key={item.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="text-lg font-black text-slate-900 dark:text-white">{item.name} {item.section}</h3><span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase ${item.status === 'active' ? 'bg-emerald-400/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-400/10 text-amber-700 dark:text-amber-300'}`}>{item.status}</span></div><p className="mt-1 font-mono text-xs text-orange-700 dark:text-orange-300">{item.classCode} · {item.academicYear || 'No academic year'}</p></div><div className="flex flex-wrap items-center gap-2"><div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400"><Users className="h-4 w-4"/>{item.subjectCount} subjects</div><button type="button" disabled={changeBusy} onClick={() => openClassEditor(item)} className={secondaryButtonClass}><Pencil className="h-3.5 w-3.5"/> Edit</button><button type="button" disabled={changeBusy} onClick={() => void archiveRecord('class', item.id, item.id, `${item.name} ${item.section ?? ''}`)} className="inline-flex items-center gap-1 rounded-xl border border-rose-300 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-300"><Archive className="h-3.5 w-3.5"/> Archive</button></div></div><div className="mt-4 space-y-2">{visibleSubjects.map((subject) => <div key={subject.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-white/[0.07] bg-slate-50 dark:bg-slate-950/40 px-3 py-2"><div><div className="font-bold text-slate-700 dark:text-slate-200">{subject.name} <span className="ml-1 font-mono text-[10px] text-slate-500">{subject.code}</span></div><div className="mt-0.5 text-xs text-slate-500">{subject.teacherName ? <span className="inline-flex items-center gap-1"><BadgeCheck className="h-3 w-3 text-emerald-700 dark:text-emerald-400"/>{subject.teacherName}</span> : 'Teacher unassigned'}</div></div><div className="flex items-center gap-2"><strong className="text-sm text-slate-900 dark:text-white">{money(subject.monthlyFee)}</strong><button type="button" onClick={() => openSubjectEditor(item.id, subject)} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-white dark:border-white/10 dark:text-slate-300"><Pencil className="h-3.5 w-3.5"/></button><button type="button" onClick={() => void archiveRecord('subject', item.id, subject.id, subject.name)} className="rounded-lg border border-rose-300 p-2 text-rose-700 hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-300"><Archive className="h-3.5 w-3.5"/></button></div></div>)}</div>{item.subjects.length > classPageSize && <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 dark:border-white/10"><span className="text-[11px] text-slate-500">Subjects · Page {subjectPage} of {subjectPageCount}</span><div className="flex gap-2"><button type="button" className={secondaryButtonClass} disabled={subjectPage <= 1} onClick={() => setSubjectPages((pages) => ({ ...pages, [item.id]: Math.max(1, subjectPage - 1) }))}>Previous</button><button type="button" className={secondaryButtonClass} disabled={subjectPage >= subjectPageCount} onClick={() => setSubjectPages((pages) => ({ ...pages, [item.id]: Math.min(subjectPageCount, subjectPage + 1) }))}>Next</button></div></div>}</Panel>;})}</div>}
    {data.classes.length > classPageSize && <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-white/10"><span className="text-xs text-slate-500">Showing {(classPage - 1) * classPageSize + 1}–{Math.min(classPage * classPageSize, data.classes.length)} of {data.classes.length} classes</span><div className="flex gap-2"><button type="button" className={secondaryButtonClass} disabled={classPage <= 1} onClick={() => setClassPage((value) => Math.max(1, value - 1))}>Previous</button><span className="rounded-xl bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">{classPage} / {classPageCount}</span><button type="button" className={secondaryButtonClass} disabled={classPage >= classPageCount} onClick={() => setClassPage((value) => Math.min(classPageCount, value + 1))}>Next</button></div></div>}
    {(editingClass || editingSubject) && <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"><div role="dialog" aria-modal="true" className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-slate-900"><div className="mb-4"><h2 className="text-lg font-black text-slate-900 dark:text-white">{editingClass ? 'Edit class details' : 'Edit subject details'}</h2><p className="mt-1 text-xs text-slate-500">Changes are saved through the secure Academy API and written to the audit log.</p></div><div className="grid gap-4 sm:grid-cols-2">{editingClass ? <><Field label="Class name"><input className={inputClass} value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={100}/></Field><Field label="Grade"><input className={inputClass} value={editGrade} onChange={(event) => setEditGrade(event.target.value)} maxLength={32}/></Field><Field label="Section"><input className={inputClass} value={editSection} onChange={(event) => setEditSection(event.target.value)} maxLength={32}/></Field><Field label="Academic year"><input className={inputClass} value={editYear} onChange={(event) => setEditYear(event.target.value)} maxLength={24}/></Field></> : <><Field label="Subject name"><input className={inputClass} value={editSubjectName} onChange={(event) => setEditSubjectName(event.target.value)} maxLength={100}/></Field><Field label="Monthly fee (PKR)"><input className={inputClass} type="number" min="0" step="0.01" value={editSubjectFee} onChange={(event) => setEditSubjectFee(event.target.value)}/></Field><Field label="Assign teacher"><select className={selectClass} value={editSubjectTeacherUid} onChange={(event) => setEditSubjectTeacherUid(event.target.value)}><option value="">Unassigned draft</option>{data.teachers.map((teacher) => <option key={teacher.uid} value={teacher.uid}>{teacher.name} · {teacher.email}</option>)}</select></Field><Field label="Billing frequency"><select className={selectClass} value={editSubjectBillingFrequency} onChange={(event) => setEditSubjectBillingFrequency(event.target.value)}><option value="monthly">Monthly</option><option value="termly">Termly</option><option value="yearly">Yearly</option></select></Field></>}</div><div className="mt-4"><Field label="Reason for change"><textarea className={`${inputClass} min-h-20`} value={editReason} onChange={(event) => setEditReason(event.target.value)} maxLength={500} placeholder="Describe why this record is changing…"/></Field></div><div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => { setEditingClass(null); setEditingSubject(null); }}>Cancel</button><button type="button" className={buttonClass} disabled={changeBusy || !editReason.trim()} onClick={() => void saveChanges()}>{changeBusy ? 'Saving…' : 'Save changes'}</button></div></div></div>}
    {archiveTarget && <div className="fixed inset-0 z-[95] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"><form role="dialog" aria-modal="true" onSubmit={(event) => void submitArchive(event)} className="w-full max-w-lg rounded-2xl border border-rose-200 bg-white p-5 shadow-2xl dark:border-rose-500/20 dark:bg-slate-900"><h2 className="text-lg font-black text-slate-900 dark:text-white">Archive {archiveTarget.kind}?</h2><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{archiveTarget.label}. Historical invoices, attendance, enrolments and audit information are retained.</p><div className="mt-4"><Field label="Archive reason"><textarea className={`${inputClass} min-h-20`} value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} maxLength={500} required/></Field></div><div className="mt-5 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setArchiveTarget(null)}>Cancel</button><button type="submit" className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-700" disabled={changeBusy || !archiveReason.trim()}>{changeBusy ? 'Archiving…' : 'Confirm archive'}</button></div></form></div>}
  </>;
}
