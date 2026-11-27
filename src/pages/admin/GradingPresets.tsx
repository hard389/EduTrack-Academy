import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { User } from 'firebase/auth';
import {
  Award,
  BookOpenText,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Users,
  AlertCircle,
} from 'lucide-react';

type RatingLevel = 'Excellent' | 'Good' | 'Average' | 'Poor';
type RemarkCategory = 'Homework' | 'Behavior' | 'Participation' | 'Performance' | 'Remarks';
type GradingPresetMap = Record<RatingLevel, Record<RemarkCategory, string>>;
type AdminOutletContext = { adminUser: User | null; localDark: boolean };
type ApiPayload = { success?: boolean; presets?: unknown; updatedAt?: string | null; seeded?: boolean; error?: string };

const LEVELS: RatingLevel[] = ['Excellent', 'Good', 'Average', 'Poor'];
const CATEGORIES: RemarkCategory[] = ['Homework', 'Behavior', 'Participation', 'Performance', 'Remarks'];
const EMPTY_PRESETS: GradingPresetMap = {
  Excellent: { Homework: '', Behavior: '', Participation: '', Performance: '', Remarks: '' },
  Good: { Homework: '', Behavior: '', Participation: '', Performance: '', Remarks: '' },
  Average: { Homework: '', Behavior: '', Participation: '', Performance: '', Remarks: '' },
  Poor: { Homework: '', Behavior: '', Participation: '', Performance: '', Remarks: '' },
};

const copyPresets = (value: GradingPresetMap): GradingPresetMap => ({
  Excellent: { ...value.Excellent },
  Good: { ...value.Good },
  Average: { ...value.Average },
  Poor: { ...value.Poor },
});

function parsePresets(value: unknown): GradingPresetMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The server returned an invalid grading presets document.');
  }
  const source = value as Record<string, unknown>;
  const result = copyPresets(EMPTY_PRESETS);
  for (const level of LEVELS) {
    const sourceLevel = source[level];
    if (!sourceLevel || typeof sourceLevel !== 'object' || Array.isArray(sourceLevel)) {
      throw new Error(`The ${level} preset group is missing.`);
    }
    const categorySource = sourceLevel as Record<string, unknown>;
    for (const category of CATEGORIES) {
      const text = categorySource[category];
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${level} / ${category} remark is empty or invalid.`);
      }
      result[level][category] = text;
    }
  }
  return result;
}

const levelStyles: Record<RatingLevel, { chip: string; text: string; description: string }> = {
  Excellent: { chip: 'bg-emerald-500/10 border-emerald-500/25', text: 'text-emerald-600 dark:text-emerald-400', description: 'Outstanding progress and achievement' },
  Good: { chip: 'bg-blue-500/10 border-blue-500/25', text: 'text-blue-600 dark:text-blue-400', description: 'Positive progress and steady effort' },
  Average: { chip: 'bg-amber-500/10 border-amber-500/25', text: 'text-amber-600 dark:text-amber-400', description: 'Encouragement and focused improvement' },
  Poor: { chip: 'bg-rose-500/10 border-rose-500/25', text: 'text-rose-600 dark:text-rose-400', description: 'Additional guidance and support' },
};

export default function AdminGradingPresets() {
  const { adminUser, localDark } = useOutletContext<AdminOutletContext>();
  const [draft, setDraft] = useState<GradingPresetMap>(() => copyPresets(EMPTY_PRESETS));
  const [saved, setSaved] = useState<GradingPresetMap>(() => copyPresets(EMPTY_PRESETS));
  const [activeLevel, setActiveLevel] = useState<RatingLevel>('Excellent');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const panel = localDark
    ? 'border-slate-800 bg-[#0b1220]'
    : 'border-border/60 bg-card/90';
  const mutedPanel = localDark ? 'border-slate-800 bg-slate-900/65' : 'border-border/60 bg-muted/35';

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        if (!adminUser) throw new Error('Your administrator session is not available. Please sign in again.');
        const token = await adminUser.getIdToken();
        const response = await fetch('/api/admin/grading-presets', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          cache: 'no-store',
        });
        const payload = await response.json() as ApiPayload;
        if (!response.ok || payload.success !== true) {
          throw new Error(payload.error || 'Could not load central grading presets.');
        }
        const normalized = parsePresets(payload.presets);
        if (!active) return;
        setDraft(normalized);
        setSaved(copyPresets(normalized));
        setUpdatedAt(payload.updatedAt || null);
        setSeeded(payload.seeded === true);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load central grading presets.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [adminUser]);

  const updateRemark = (category: RemarkCategory, value: string) => {
    setDraft((previous) => ({
      ...previous,
      [activeLevel]: { ...previous[activeLevel], [category]: value },
    }));
    setNotice(null);
    setError(null);
  };

  const savePresets = async () => {
    if (!adminUser || !isDirty || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const token = await adminUser.getIdToken();
      const response = await fetch('/api/admin/grading-presets', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ presets: draft }),
      });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || payload.success !== true) {
        throw new Error(payload.error || 'Could not save grading presets.');
      }
      const normalized = parsePresets(payload.presets ?? draft);
      setDraft(normalized);
      setSaved(copyPresets(normalized));
      setUpdatedAt(payload.updatedAt || new Date().toISOString());
      setSeeded(false);
      setNotice('Shared grading presets saved. Teachers will receive these latest remarks the next time they use Auto Fill.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save grading presets.');
    } finally {
      setSaving(false);
    }
  };

  const discardChanges = () => {
    setDraft(copyPresets(saved));
    setNotice('Unsaved changes were discarded.');
    setError(null);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <section className={`relative overflow-hidden rounded-2xl border p-5 sm:p-6 ${localDark ? 'border-slate-800 bg-gradient-to-br from-orange-500/10 via-slate-900 to-amber-500/5' : 'border-border/50 bg-gradient-to-br from-primary/5 via-transparent to-accent/5'}`}>
        <div className="absolute -right-8 -top-10 h-44 w-44 rounded-full bg-orange-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-orange-500/10 ring-1 ring-orange-500/20 sm:flex">
              <Award className="h-6 w-6 text-orange-500" />
            </div>
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600 dark:text-orange-400">
                <ShieldCheck className="h-3.5 w-3.5" /> Platform-wide configuration
              </div>
              <h2 className="text-2xl font-bold tracking-tight">Central Grading Presets</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Manage the English remarks that populate teacher Grading Rules when Auto Fill is used. Existing teacher-customized remarks are never overwritten.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 font-semibold ${isDirty ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}`}>
              {isDirty ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
              {isDirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
          </div>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Rating levels', value: '4', icon: Award },
          { label: 'Remark categories', value: '5', icon: BookOpenText },
          { label: 'Central templates', value: '20', icon: FileText },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className={`rounded-2xl border p-4 shadow-sm ${panel}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500"><Icon size={17} /></span>
              </div>
              <p className="mt-3 text-2xl font-bold tabular-nums">{item.value}</p>
            </div>
          );
        })}
      </div>

      {seeded && !loading ? (
        <div className={`flex items-start gap-3 rounded-xl border p-4 text-xs leading-5 ${mutedPanel}`}>
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
          <p>The first central configuration has been initialized using the existing English Auto Fill remarks. You can now edit and save the wording here.</p>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-600 dark:text-rose-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{notice}</p>
        </div>
      ) : null}

      <section className={`overflow-hidden rounded-2xl border shadow-sm ${panel}`}>
        <div className={`border-b p-4 sm:p-5 ${localDark ? 'border-slate-800' : 'border-border/60'}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-base font-bold"><Users className="h-4 w-4 text-orange-500" /> Default English remarks</h3>
              <p className="mt-1 text-xs text-muted-foreground">Choose a rating level and update its five category templates.</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Clock3 size={13} />
              {updatedAt ? `Last saved ${new Date(updatedAt).toLocaleString()}` : 'Awaiting initial load'}
            </div>
          </div>
        </div>

        <div className="border-b border-border/50 p-3 sm:p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {LEVELS.map((level) => {
              const style = levelStyles[level];
              const active = activeLevel === level;
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => setActiveLevel(level)}
                  disabled={loading}
                  aria-pressed={active}
                  className={`rounded-xl border px-3 py-3 text-left transition-all disabled:opacity-50 ${active ? `${style.chip} ring-2 ring-orange-500/30 shadow-sm` : `${mutedPanel} hover:border-orange-500/40`}`}
                >
                  <span className={`block text-sm font-bold ${style.text}`}>{level}</span>
                  <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{style.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-14 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
              <p className="text-xs font-semibold">Loading central grading presets…</p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-2">
                {CATEGORIES.map((category, index) => (
                  <label key={category} className={`block rounded-xl border p-4 transition-colors ${mutedPanel}`}>
                    <span className="mb-2 flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-sm font-bold"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-orange-500/10 text-[10px] font-bold text-orange-600 dark:text-orange-400">{index + 1}</span>{category}</span>
                      <span className="text-[10px] font-medium text-muted-foreground">{draft[activeLevel][category].length}/1200</span>
                    </span>
                    <textarea
                      value={draft[activeLevel][category]}
                      onChange={(event) => updateRemark(category, event.target.value)}
                      maxLength={1200}
                      rows={4}
                      aria-label={`${activeLevel} ${category} English remark`}
                      className="w-full resize-y rounded-xl border border-input bg-background px-3 py-3 text-sm leading-6 shadow-sm outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/15"
                      placeholder={`Enter the ${activeLevel} ${category.toLowerCase()} remark…`}
                    />
                  </label>
                ))}
              </div>

              <div className={`rounded-xl border p-3 text-xs leading-5 ${localDark ? 'border-blue-500/20 bg-blue-500/5 text-slate-300' : 'border-blue-500/20 bg-blue-500/5 text-slate-600'}`}>
                <p className="font-bold">Personalization tokens</p>
                <p className="mt-1">You can use <code className="rounded bg-background px-1 py-0.5">{'{{name}}'}</code>, <code className="rounded bg-background px-1 py-0.5">{'{{first_name}}'}</code> and <code className="rounded bg-background px-1 py-0.5">{'{{father_name}}'}</code>. Reports resolve these tokens using each selected student’s own record.</p>
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={discardChanges} disabled={!isDirty || saving} className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 text-xs font-bold transition hover:border-orange-500/40 disabled:cursor-not-allowed disabled:opacity-40">
                  <RotateCcw size={14} /> Discard changes
                </button>
                <button type="button" onClick={() => void savePresets()} disabled={loading || saving || !isDirty || Boolean(error)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-accent px-5 py-3 text-xs font-bold text-primary-foreground shadow-md transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : isDirty ? <Save size={15} /> : <Check size={15} />}
                  {saving ? 'Saving shared presets…' : isDirty ? 'Save shared presets' : 'Saved'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
