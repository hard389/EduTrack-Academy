import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAcademyAccess } from '@/hooks/useAcademyAccess';

export function AcademyPermissionRoute({ permissions, match = 'any', children }: { permissions: string[]; match?: 'any' | 'all'; children: ReactNode }) {
  const { loading, hasPermission } = useAcademyAccess();
  if (loading) return <div className="flex min-h-[45vh] items-center justify-center gap-3 text-sm font-semibold text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Checking Academy permissions…</div>;
  const allowed = match === 'all' ? permissions.every(hasPermission) : permissions.some(hasPermission);
  if (!allowed) return <section className="mx-auto flex min-h-[45vh] max-w-xl flex-col items-center justify-center rounded-3xl border border-amber-300/60 bg-white/90 p-8 text-center shadow-xl shadow-amber-500/5 dark:border-amber-700/50 dark:bg-slate-950/80"><div className="mb-4 rounded-2xl bg-amber-500/10 p-4 text-amber-600">Access denied</div><h1 className="text-xl font-black text-slate-900 dark:text-white">Permission not granted</h1><p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">Your Academy Admin has not granted access to this page or action.</p><Link to="/dashboard" className="mt-6 rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-600">Return to dashboard</Link></section>;
  return <>{children}</>;
}
