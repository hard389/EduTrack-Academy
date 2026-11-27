import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle } from 'lucide-react';

export function PageHeading({ eyebrow = 'ACADEMY MANAGEMENT', title, description, action }: { eyebrow?: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex min-w-0 flex-col gap-4 border-b border-slate-200/80 pb-6 dark:border-white/[0.08] sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="text-[10px] font-black tracking-[0.2em] text-blue-600 dark:text-cyan-300">{eyebrow}</div>
        <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950 dark:text-white sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-400">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`min-w-0 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-900/[0.035] dark:border-white/[0.08] dark:bg-slate-900/80 dark:shadow-black/10 sm:p-5 ${className}`}>{children}</section>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block min-w-0 space-y-2"><span className="text-xs font-bold text-slate-700 dark:text-slate-300">{label}</span>{children}{hint && <span className="block text-[11px] leading-5 text-slate-500">{hint}</span>}</label>;
}

export const inputClass = 'w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/10 dark:border-white/10 dark:bg-slate-950/70 dark:text-white dark:placeholder:text-slate-600';
export const selectClass = inputClass;
export const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-4 py-2.5 text-sm font-black text-white shadow-sm shadow-blue-500/15 transition hover:-translate-y-0.5 hover:shadow-md hover:shadow-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50';
export const secondaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-200 dark:hover:border-blue-400/20 dark:hover:bg-blue-500/10 dark:hover:text-cyan-200';

export function Notice({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'success' }) {
  const classes = kind === 'error'
    ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-200'
    : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200';
  return <div role="status" className={`mb-4 flex items-start gap-2 rounded-xl border px-3 py-3 text-sm leading-6 ${classes}`}>{kind === 'error' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}{children}</div>;
}

export function Loading({ label = 'Loading records…' }: { label?: string }) {
  return <div className="flex items-center gap-2 rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-5 text-sm font-semibold text-slate-600 shadow-sm dark:border-white/[0.08] dark:bg-slate-900/70 dark:text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin text-blue-600 dark:text-cyan-300" />{label}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-10 text-center text-sm leading-6 text-slate-500 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-500">{children}</div>;
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200/80 dark:border-white/10">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600 dark:bg-white/[0.04] dark:text-slate-400"><tr>{headers.map((header) => <th key={header} className="px-4 py-3 font-black">{header}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle text-slate-700 dark:text-slate-300 ${className}`}>{children}</td>;
}
