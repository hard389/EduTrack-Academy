import { useEffect, useState } from 'react';
import { getBlob, ref } from 'firebase/storage';
import { storage } from '@/lib/firebase';

export type TeacherPermission = { key: string; label: string; group: string; description: string };
export type AcademyTeacherRow = {
  uid: string;
  name: string;
  email: string;
  contactEmail?: string;
  active: boolean;
  emailVerified: boolean;
  status: string;
  designation?: string;
  profileImageStoragePath?: string;
  profileImage?: string;
  permissions: Record<string, boolean>;
  assignedClassIds: string[];
  assignedSubjectIds: string[];
  assignedClassCount?: number;
  assignedStudentCount?: number;
  assignedSubjectCount?: number;
  whatsappNumber: string;
  createdAt: string | null;
};

export const CORE_PERMISSION_KEYS = new Set(['dashboard.view']);

export const moneyPKR = (value: number) => `PKR ${Number(value || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
export const displayDate = (value?: string | null) => value ? new Date(value).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const displayDateTime = (value?: string | null) => value ? new Date(value).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function TeacherAvatar({ teacher, size = 'md' }: { teacher: Pick<AcademyTeacherRow, 'name' | 'profileImageStoragePath' | 'profileImage'>; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setFailed(false);
    setSource('');
    if (teacher.profileImageStoragePath) {
      getBlob(ref(storage, teacher.profileImageStoragePath))
        .then((blob) => {
          objectUrl = URL.createObjectURL(blob);
          if (active) setSource(objectUrl);
          else URL.revokeObjectURL(objectUrl);
        })
        .catch(() => { if (active) setSource(teacher.profileImage || ''); });
    } else setSource(teacher.profileImage || '');
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [teacher.profileImageStoragePath, teacher.profileImage]);
  const sizes = { sm: 'h-10 w-10 text-sm', md: 'h-14 w-14 text-lg', lg: 'h-20 w-20 text-2xl', xl: 'h-24 w-24 text-3xl' };
  return source && !failed
    ? <img src={source} alt={`${teacher.name} profile`} onError={() => setFailed(true)} className={`${sizes[size]} shrink-0 rounded-2xl border border-white object-cover shadow-md`} />
    : <div className={`${sizes[size]} grid shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-blue-600 via-cyan-500 to-sky-400 font-black text-white shadow-md`} aria-label={`${teacher.name} avatar`}>{(teacher.name || 'T').trim().slice(0, 1).toUpperCase()}</div>;
}

export function TeacherPermissionGroups({
  definitions,
  value,
  onChange,
  disabled = false,
}: {
  definitions: TeacherPermission[];
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  disabled?: boolean;
}) {
  const groups = definitions.reduce<Record<string, TeacherPermission[]>>((result, item) => {
    (result[item.group] ??= []).push(item);
    return result;
  }, {});
  const configurable = definitions.filter((item) => !CORE_PERMISSION_KEYS.has(item.key));
  const selected = definitions.filter((item) => value[item.key] === true).length;
  const apply = (keys: string[], enabled: boolean) => {
    const next = { ...value };
    keys.forEach((key) => { if (!CORE_PERMISSION_KEYS.has(key)) next[key] = enabled; });
    onChange(next);
  };
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50 p-3 dark:border-blue-400/15 dark:from-blue-500/10 dark:to-cyan-500/10">
      <div><p className="text-sm font-black text-slate-900 dark:text-white">Permission configuration</p><p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{selected} of {definitions.length} permissions currently enabled</p></div>
      <div className="flex gap-2"><button type="button" disabled={disabled} onClick={() => apply(configurable.map((item) => item.key), true)} className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-700 disabled:opacity-50">Select all</button><button type="button" disabled={disabled} onClick={() => apply(configurable.map((item) => item.key), false)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 disabled:opacity-50">Clear all</button></div>
    </div>
    {Object.entries(groups).map(([group, items]) => {
      const editable = items.filter((item) => !CORE_PERMISSION_KEYS.has(item.key));
      const count = items.filter((item) => value[item.key] === true).length;
      return <section key={group} className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-slate-950/40">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.035]"><div><h3 className="text-sm font-black text-slate-900 dark:text-white">{group}</h3><p className="text-[11px] text-slate-500">{count} enabled</p></div><div className="flex gap-2"><button type="button" disabled={disabled || !editable.length} onClick={() => apply(editable.map((item) => item.key), true)} className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-blue-700 hover:bg-blue-50 dark:text-cyan-300 dark:hover:bg-white/5">Select group</button><button type="button" disabled={disabled || !editable.length} onClick={() => apply(editable.map((item) => item.key), false)} className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-white/5">Clear</button></div></div>
        <div className="grid gap-2 p-3 md:grid-cols-2">{items.map((item) => {
          const core = CORE_PERMISSION_KEYS.has(item.key);
          return <label key={item.key} className={`flex min-h-[76px] items-start gap-3 rounded-xl border p-3 transition ${value[item.key] ? 'border-blue-200 bg-blue-50/70 dark:border-blue-400/20 dark:bg-blue-500/[0.07]' : 'border-slate-100 bg-white hover:border-slate-200 dark:border-white/[0.06] dark:bg-slate-900/40'} ${core ? 'opacity-80' : 'cursor-pointer'}`}>
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-blue-600" checked={value[item.key] === true} disabled={disabled || core} onChange={(event) => apply([item.key], event.target.checked)} />
            <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-xs font-black text-slate-800 dark:text-slate-100">{item.label}{core && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-slate-500 dark:bg-white/10">System controlled</span>}</span><span className="mt-1 block text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{item.description}</span></span>
          </label>;
        })}</div>
      </section>;
    })}
    <p className="text-[11px] leading-relaxed text-slate-500">Dashboard access is always available to an active teacher. All other modules are controlled by the permissions selected here and are enforced by backend authorization checks.</p>
  </div>;
}
