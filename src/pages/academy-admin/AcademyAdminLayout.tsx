import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import {
  Activity,
  BellRing,
  BookOpen,
  Building2,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  ShieldCheck,
  Users,
  Wallet,
  X,
  MoreHorizontal,
} from 'lucide-react';
import { auth } from '@/lib/firebase';
import { getAcademyAccess, type AcademyAccess } from '@/lib/academyApi';
import { ThemeToggle } from '@/components/ThemeToggle';

const links = [
  { to: '/academy-admin/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/academy-admin/teachers', label: 'Teachers & Permissions', icon: Users },
  { to: '/academy-admin/classes', label: 'Classes & Subjects', icon: BookOpen },
  { to: '/academy-admin/students', label: 'Students', icon: GraduationCap },
  { to: '/academy-admin/analytics', label: 'Analytics', icon: Activity },
  { to: '/academy-admin/alerts', label: 'Alerts & Notifications', icon: BellRing },
  { to: '/academy-admin/fees', label: 'Fees & Collections', icon: ReceiptText },
  { to: '/academy-admin/expenses', label: 'Expenses', icon: Wallet },
];

const mobileLinks = [
  links[0],
  links[3],
  links[6],
  links[5],
];

export default function AcademyAdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [access, setAccess] = useState<AcademyAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const user = auth.currentUser;
        if (!user) throw new Error('Your session has expired.');
        const result = await getAcademyAccess(user);
        if (result.role !== 'academy_admin') throw new Error('Academy Admin access is required.');
        if (!cancelled) setAccess(result);
      } catch {
        if (!cancelled) navigate('/login', { replace: true });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [navigate]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut(auth);
      navigate('/login', { replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  const activePage = useMemo(() => links.find((item) => item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)), [location.pathname]);

  if (loading || !access) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-sm font-semibold text-slate-500 dark:bg-slate-950 dark:text-slate-400">
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-lg shadow-blue-900/5 dark:border-white/10 dark:bg-slate-900">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-500" /> Loading Academy workspace…
        </div>
      </div>
    );
  }

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#f5f8fc] text-slate-900 dark:bg-[#080f1d] dark:text-slate-100 lg:flex">
      <div className="pointer-events-none fixed inset-0 -z-0 overflow-hidden">
        <div className="absolute -right-40 -top-48 h-[30rem] w-[30rem] rounded-full bg-blue-400/[0.08] blur-3xl dark:bg-blue-500/[0.09]" />
        <div className="absolute -bottom-48 left-1/4 h-[28rem] w-[28rem] rounded-full bg-cyan-400/[0.07] blur-3xl dark:bg-cyan-500/[0.06]" />
      </div>

      {sidebarOpen && (
        <button type="button" aria-label="Close navigation" onClick={closeSidebar} className="fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-sm lg:hidden" />
      )}

      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[18rem] flex-col border-r border-white/70 bg-white/90 shadow-2xl shadow-blue-950/10 backdrop-blur-2xl transition-transform duration-300 dark:border-white/[0.07] dark:bg-slate-950/90 dark:shadow-black/30 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="relative flex h-[4.5rem] shrink-0 items-center justify-between border-b border-slate-200/80 px-5 dark:border-white/[0.07]">
          <button type="button" onClick={() => navigate('/academy-admin/dashboard')} className="group flex min-w-0 items-center gap-3 text-left">
            <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-blue-200/70 bg-gradient-to-br from-blue-500/10 to-cyan-500/10 shadow-sm transition duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-blue-500/15 dark:border-blue-400/20">
              <img src="/logo.png" alt="EduTrack" className="h-7 w-7 object-contain" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-black tracking-tight text-slate-950 dark:text-white">EduTrack</span>
              <span className="block text-[9px] font-black uppercase tracking-[0.2em] text-blue-600 dark:text-cyan-300">Academy workspace</span>
            </span>
          </button>
          <button type="button" aria-label="Close navigation" onClick={closeSidebar} className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10 lg:hidden"><X className="h-5 w-5" /></button>
        </div>

        <div className="mx-4 mt-5 rounded-2xl border border-blue-100/90 bg-gradient-to-br from-blue-50 via-white to-cyan-50 p-4 shadow-sm dark:border-blue-400/15 dark:from-blue-950/35 dark:via-slate-900 dark:to-cyan-950/20">
          <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.17em] text-blue-700 dark:text-cyan-300"><ShieldCheck className="h-4 w-4" /> Academy Admin</div>
          <div className="mt-2 truncate text-sm font-black text-slate-950 dark:text-white">{access.academyName}</div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
            <span>Academy ID</span><span className="truncate font-mono font-bold text-blue-700 dark:text-cyan-300">{access.academyId}</span>
          </div>
        </div>

        <nav aria-label="Academy administration" className="mt-6 flex-1 space-y-1 overflow-y-auto px-3 pb-5">
          <div className="px-3 pb-2 text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">Management</div>
          {links.slice(0, 4).map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={closeSidebar} className={({ isActive }) => `group relative flex items-center gap-3 overflow-hidden rounded-2xl px-4 py-3 text-[13px] font-bold transition-all duration-300 ${isActive ? 'scale-[1.015] bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-500 text-white shadow-lg shadow-blue-500/25' : 'text-slate-600 hover:bg-gradient-to-r hover:from-blue-50 hover:to-cyan-50 hover:text-slate-950 dark:text-slate-300 dark:hover:from-white/[0.07] dark:hover:to-cyan-500/[0.04] dark:hover:text-white'}`}>
              <Icon className="relative z-10 h-[18px] w-[18px] shrink-0 transition-transform duration-300 group-hover:scale-110" />
              <span className="relative z-10">{label}</span>
            </NavLink>
          ))}

          <div className="px-3 pb-2 pt-5 text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">Insights & Finance</div>
          {links.slice(4).map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={closeSidebar} className={({ isActive }) => `group relative flex items-center gap-3 overflow-hidden rounded-2xl px-4 py-3 text-[13px] font-bold transition-all duration-300 ${isActive ? 'scale-[1.015] bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-500 text-white shadow-lg shadow-blue-500/25' : 'text-slate-600 hover:bg-gradient-to-r hover:from-blue-50 hover:to-cyan-50 hover:text-slate-950 dark:text-slate-300 dark:hover:from-white/[0.07] dark:hover:to-cyan-500/[0.04] dark:hover:text-white'}`}>
              <Icon className="h-[18px] w-[18px] shrink-0 transition-transform duration-300 group-hover:scale-110" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-200/80 p-4 dark:border-white/[0.07]">
          <div className="mb-3 hidden items-start gap-2 rounded-xl bg-slate-100/80 p-3 text-[10px] leading-5 text-slate-600 dark:bg-white/[0.04] dark:text-slate-400 lg:flex">
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            <span>This workspace is separate from the Platform Super Admin portal.</span>
          </div>
          <button type="button" disabled={signingOut} onClick={() => void handleSignOut()} className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-extrabold text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:border-rose-400/30 dark:hover:bg-rose-500/10 dark:hover:text-rose-200">
            <LogOut className="h-4 w-4" />{signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>

      <div className="relative z-10 min-w-0 flex-1 lg:ml-72">
        <header className="sticky top-0 z-30 flex h-[4.5rem] items-center justify-between border-b border-white/70 bg-white/75 px-4 shadow-sm shadow-slate-900/[0.025] backdrop-blur-2xl dark:border-white/[0.06] dark:bg-slate-950/70 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)} className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 shadow-sm transition hover:border-blue-200 hover:text-blue-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:text-cyan-300 lg:hidden"><Menu className="h-5 w-5" /></button>
            <div className="min-w-0">
              <div className="truncate text-sm font-black text-slate-950 dark:text-white sm:text-base">{activePage?.label ?? 'Academy Administration'}</div>
              <div className="truncate text-[10px] font-medium text-slate-500 dark:text-slate-400">{access.academyName} <span className="px-1 text-slate-300 dark:text-slate-600">/</span> Academy workspace</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3"><ThemeToggle /></div>
        </header>

        <main className="min-w-0 px-4 pb-28 pt-6 sm:px-6 sm:pt-7 lg:px-8 lg:pb-10 lg:pt-8">
          <div className="mx-auto max-w-[1480px]"><Outlet /></div>
        </main>
      </div>

      <nav aria-label="Quick mobile navigation" className="fixed inset-x-3 bottom-3 z-30 grid grid-cols-5 rounded-2xl border border-white/70 bg-white/90 p-2 shadow-2xl shadow-slate-900/15 backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/90 dark:shadow-black/40 lg:hidden">
        {mobileLinks.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[9px] font-extrabold transition ${isActive ? 'bg-gradient-to-br from-blue-600 to-cyan-500 text-white shadow-md shadow-blue-500/20' : 'text-slate-500 dark:text-slate-400'}`}>
            <Icon className="h-[18px] w-[18px]" /><span className="max-w-full truncate">{label === 'Fees & Collections' ? 'Fees' : label}</span>
          </NavLink>
        ))}
        <button type="button" onClick={() => setSidebarOpen(true)} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[9px] font-extrabold text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/[0.06]">
          <MoreHorizontal className="h-[18px] w-[18px]" /><span>More</span>
        </button>
      </nav>
    </div>
  );
}
