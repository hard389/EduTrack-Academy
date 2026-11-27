import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Activity as AnalyticsIcon, ArrowUpRight, BellRing as AlertsIcon, Building2, ChevronRight, GraduationCap as UsersIcon, ReceiptText as FeesIcon, ShieldCheck, Wallet as ExpenseIcon } from 'lucide-react';

type Accent = 'blue' | 'violet' | 'cyan' | 'green' | 'orange' | 'rose' | 'indigo';

const accentStyles: Record<Accent, { icon: string; glow: string; border: string }> = {
  blue: { icon: 'bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-300', glow: 'from-blue-500/10', border: 'hover:border-blue-300/80 dark:hover:border-blue-400/30' },
  violet: { icon: 'bg-violet-500/10 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300', glow: 'from-violet-500/10', border: 'hover:border-violet-300/80 dark:hover:border-violet-400/30' },
  cyan: { icon: 'bg-cyan-500/10 text-cyan-600 dark:bg-cyan-400/10 dark:text-cyan-300', glow: 'from-cyan-500/10', border: 'hover:border-cyan-300/80 dark:hover:border-cyan-400/30' },
  green: { icon: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300', glow: 'from-emerald-500/10', border: 'hover:border-emerald-300/80 dark:hover:border-emerald-400/30' },
  orange: { icon: 'bg-orange-500/10 text-orange-600 dark:bg-orange-400/10 dark:text-orange-300', glow: 'from-orange-500/10', border: 'hover:border-orange-300/80 dark:hover:border-orange-400/30' },
  rose: { icon: 'bg-rose-500/10 text-rose-600 dark:bg-rose-400/10 dark:text-rose-300', glow: 'from-rose-500/10', border: 'hover:border-rose-300/80 dark:hover:border-rose-400/30' },
  indigo: { icon: 'bg-indigo-500/10 text-indigo-600 dark:bg-indigo-400/10 dark:text-indigo-300', glow: 'from-indigo-500/10', border: 'hover:border-indigo-300/80 dark:hover:border-indigo-400/30' },
};

export function AcademyStatCard({
  label,
  value,
  note,
  icon: Icon,
  accent,
}: {
  label: string;
  value: ReactNode;
  note: string;
  icon: LucideIcon;
  accent: Accent;
}) {
  const style = accentStyles[accent];
  return (
    <article className={`group relative min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-900/[0.035] transition duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-slate-900/[0.07] dark:border-white/[0.08] dark:bg-slate-900/80 dark:hover:shadow-black/20 sm:p-5 ${style.border}`}>
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${style.glow} via-transparent to-transparent opacity-70`} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.13em] text-slate-500 dark:text-slate-400">{label}</p>
          <div className="mt-3 break-words text-2xl font-black tracking-tight text-slate-950 dark:text-white sm:text-[1.75rem]">{value}</div>
          <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{note}</p>
        </div>
        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${style.icon}`}><Icon className="h-5 w-5" /></span>
      </div>
      <div className="pointer-events-none absolute -bottom-7 -right-5 h-20 w-20 rounded-full border-[12px] border-slate-100/80 transition-transform duration-500 group-hover:scale-125 dark:border-white/[0.035]" />
    </article>
  );
}

export function AcademyHeroCard({ academyName, academyId }: { academyName: string; academyId: string }) {
  return (
    <section className="relative isolate overflow-hidden rounded-[1.75rem] border border-blue-200/70 bg-gradient-to-br from-blue-700 via-blue-600 to-cyan-500 px-5 py-6 text-white shadow-xl shadow-blue-900/10 dark:border-blue-400/20 sm:px-7 sm:py-7">
      <div className="pointer-events-none absolute -right-14 -top-24 h-64 w-64 rounded-full border-[34px] border-white/[0.08]" />
      <div className="pointer-events-none absolute -bottom-28 right-24 h-64 w-64 rounded-full bg-cyan-300/20 blur-3xl" />
      <div className="relative flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.17em] text-blue-50 backdrop-blur-md">
            <Building2 className="h-3.5 w-3.5" /> Current academy
          </div>
          <h2 className="mt-4 break-words text-2xl font-black tracking-tight sm:text-3xl">{academyName}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-blue-50/90">Your academy workspace at a glance. Manage people, learning activity and finances from one place.</p>
        </div>
        <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/20 bg-white/10 p-4 backdrop-blur-xl sm:min-w-[205px]">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/15"><ShieldCheck className="h-5 w-5" /></div>
          <div className="min-w-0">
            <p className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-blue-100">Academy ID</p>
            <p className="mt-1 truncate font-mono text-sm font-bold text-white">{academyId}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

const quickAccessItems: Array<{ title: string; description: string; to: string; icon: LucideIcon; accent: Accent }> = [
  { title: 'Teachers & Permissions', description: 'Manage teacher accounts and access', to: '/academy-admin/teachers', icon: ShieldCheck, accent: 'violet' },
  { title: 'Classes & Subjects', description: 'Organise classes and subject links', to: '/academy-admin/classes', icon: Building2, accent: 'blue' },
  { title: 'Students', description: 'Admissions and student records', to: '/academy-admin/students', icon: UsersIcon, accent: 'cyan' },
  { title: 'Analytics', description: 'Explore trends and distributions', to: '/academy-admin/analytics', icon: AnalyticsIcon, accent: 'blue' },
  { title: 'Fees & Collections', description: 'Invoices, collections and payments', to: '/academy-admin/fees', icon: FeesIcon, accent: 'orange' },
  { title: 'Expenses', description: 'Track posted academy expenses', to: '/academy-admin/expenses', icon: ExpenseIcon, accent: 'rose' },
  { title: 'Alerts & Notifications', description: 'Create and manage announcements', to: '/academy-admin/alerts', icon: AlertsIcon, accent: 'cyan' },
];


export function AcademyQuickAccess() {
  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-600 dark:text-cyan-300">Move around faster</p>
          <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950 dark:text-white">Quick Access</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Shortcuts to your academy management modules.</p>
        </div>
        <span className="hidden items-center gap-1 text-xs font-bold text-slate-400 sm:inline-flex">{quickAccessItems.length} modules <ChevronRight className="h-4 w-4" /></span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {quickAccessItems.map(({ title, description, to, icon: Icon, accent }) => {
          const style = accentStyles[accent];
          return (
            <Link key={to} to={to} className={`group flex min-w-0 items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-900/[0.025] transition duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-slate-900/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/[0.08] dark:bg-slate-900/80 dark:hover:shadow-black/20 ${style.border}`}>
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl transition-transform duration-300 group-hover:scale-110 ${style.icon}`}><Icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-extrabold leading-5 text-slate-900 dark:text-white">{title}</span>
                <span className="mt-1 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{description}</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 transition duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-blue-600 dark:text-slate-600 dark:group-hover:text-cyan-300" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function AnalyticsChartCard({ title, description, children, className = '' }: { title: string; description: string; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-900/[0.035] dark:border-white/[0.08] dark:bg-slate-900/80 sm:p-5 ${className}`}>
      <div className="mb-4">
        <h3 className="text-sm font-extrabold text-slate-900 dark:text-white">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function FeePositionCard({ billed, collected, remaining }: { billed: string; collected: string; remaining: string }) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm shadow-slate-900/[0.035] dark:border-white/[0.08] dark:bg-slate-900/80 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600 dark:text-orange-300">Finance snapshot</p><h2 className="mt-1 text-lg font-black text-slate-950 dark:text-white">Fee position</h2></div>
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-300"><ArrowUpRight className="h-5 w-5" /></span>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div><p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total billed</p><p className="mt-1 break-words text-lg font-black tabular-nums text-slate-900 dark:text-white">{billed}</p></div>
        <div><p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Collected</p><p className="mt-1 break-words text-lg font-black tabular-nums text-emerald-600 dark:text-emerald-300">{collected}</p></div>
        <div><p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Remaining</p><p className="mt-1 break-words text-lg font-black tabular-nums text-orange-600 dark:text-orange-300">{remaining}</p></div>
      </div>
    </section>
  );
}

export function ImportantInformationCard() {
  return (
    <section className="rounded-2xl border border-blue-200/70 bg-gradient-to-br from-blue-50 via-white to-cyan-50 p-5 dark:border-blue-400/15 dark:from-blue-950/35 dark:via-slate-900 dark:to-cyan-950/25 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-600/20"><ShieldCheck className="h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className="text-base font-black text-slate-950 dark:text-white">Workspace boundaries</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Teacher Portal pages continue using their own existing interface. Academy permissions determine which existing teacher modules are available. The Platform Super Admin portal remains separate from this academy workspace.</p>
        </div>
      </div>
    </section>
  );
}
