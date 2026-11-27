import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import { useApp, type TeacherFeatureKey } from '@/contexts/AppContext';

const FEATURE_NAMES: Record<string, string> = {
  student_management: 'Student Management', class_management: 'Class Management', attendance_management: 'Attendance',
  attendance_alerts: 'Attendance Alerts', monthly_reports: 'Reports', fortnightly_reports: '15-Day Reports',
  weekly_reports: 'Weekly Reports', attendance_analytics: 'Analytics', advanced_analytics: 'Advanced Analytics',
  fee_tracking: 'Fees', fee_alerts: 'Fee Alerts', custom_alerts: 'Custom Alerts', quiz_management: 'Quiz Management',
  quiz_result_notifications: 'Quiz Notifications', notes_library: 'Notes & Library', announcements: 'Announcements',
};

export function FeatureRoute({ feature, features, children }: { feature?: TeacherFeatureKey; features?: TeacherFeatureKey[]; children: ReactNode }) {
  const { entitlementLoading, entitlement, canAccessFeature } = useApp();
  const requiredFeatures = features ?? (feature ? [feature] : []);
  const missingFeature = requiredFeatures.find((key) => !canAccessFeature(key));
  if (entitlementLoading) return <div className="flex min-h-[45vh] items-center justify-center gap-3 text-sm font-semibold text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Verifying Academy permissions…</div>;
  if (requiredFeatures.length === 0 || missingFeature || !entitlement?.active) {
    const featureName = missingFeature ? FEATURE_NAMES[missingFeature] || 'This feature' : 'This feature';
    return <section className="mx-auto flex min-h-[55vh] max-w-xl flex-col items-center justify-center rounded-3xl border border-amber-300/60 bg-white/90 p-8 text-center shadow-xl shadow-amber-500/5 dark:border-amber-700/50 dark:bg-slate-950/80"><span className="mb-4 rounded-2xl bg-amber-500/10 p-4 text-amber-600"><LockKeyhole className="h-8 w-8" /></span><h1 className="text-xl font-black text-slate-900 dark:text-white">Access not granted</h1><p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300"><strong>{featureName}</strong> is not currently included in your Academy permissions. Ask your Academy Admin to grant the required access.</p><Link to="/dashboard" className="mt-6 rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-orange-600">Back to dashboard</Link></section>;
  }
  return <>{children}</>;
}
