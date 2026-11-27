import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type { Department, TimeConfig } from '@/types';
import { auth } from '@/lib/firebase';
import { getAcademyAccess } from '@/lib/academyApi';

export type TeacherFeatureKey =
  | 'student_management' | 'class_management' | 'attendance_management' | 'attendance_alerts'
  | 'monthly_reports' | 'fortnightly_reports' | 'weekly_reports' | 'attendance_analytics'
  | 'advanced_analytics' | 'fee_tracking' | 'fee_alerts' | 'custom_alerts' | 'quiz_management'
  | 'quiz_result_notifications' | 'notes_library' | 'library_link_whatsapp' | 'announcements';
export type FeaturePermissionState = 'enabled' | 'disabled' | 'configurable';
export type EntitlementSnapshot = {
  active: boolean;
  status: string;
  planName: string | null;
  expiresAt: string | null;
  featurePermissions: Partial<Record<TeacherFeatureKey, FeaturePermissionState>>;
  accessMode: string;
  featureVisibilityMode: 'hide' | 'locked';
  featureSources: Partial<Record<TeacherFeatureKey, string>>;
  addOns: Array<{ id: string; name: string; featureKeys: string[]; expiresAt: string | null }>;
};

const FEATURE_PERMISSION: Record<TeacherFeatureKey, string> = {
  student_management: 'students.view_assigned',
  class_management: 'classes.view_assigned',
  attendance_management: 'attendance.take_assigned',
  attendance_alerts: 'alerts.manage',
  monthly_reports: 'reports.view_assigned',
  fortnightly_reports: 'reports.view_assigned',
  weekly_reports: 'reports.view_assigned',
  attendance_analytics: 'analytics.view_assigned',
  advanced_analytics: 'analytics.view_all',
  fee_tracking: 'fees.view_assigned',
  fee_alerts: 'fees.alerts',
  custom_alerts: 'alerts.manage',
  quiz_management: 'quiz.view_assigned',
  quiz_result_notifications: 'quiz.manage_assigned',
  notes_library: 'notes.view',
  library_link_whatsapp: 'notes.manage',
  announcements: 'alerts.manage',
};
const FEATURE_KEYS = Object.keys(FEATURE_PERMISSION) as TeacherFeatureKey[];
const DENIED_PERMISSIONS = Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'disabled'])) as Record<TeacherFeatureKey, FeaturePermissionState>;

interface AppContextType {
  departments: Department[];
  timeConfig: TimeConfig | null;
  selectedDepartment: string | null;
  setSelectedDepartment: (id: string | null) => void;
  selectedYear: number | null;
  setSelectedYear: (year: number | null) => void;
  isLoading: boolean;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  refreshData: () => Promise<void>;
  entitlementLoading: boolean;
  entitlement: EntitlementSnapshot | null;
  featureVisibilityMode: 'hide' | 'locked';
  featureSource: (key: TeacherFeatureKey) => string | null;
  requestFeatureAddOn: (key: TeacherFeatureKey, note?: string) => Promise<{ success: boolean; error?: string }>;
  featureState: (key: TeacherFeatureKey) => FeaturePermissionState;
  canAccessFeature: (key: TeacherFeatureKey) => boolean;
  refreshEntitlement: () => Promise<EntitlementSnapshot | null>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  // Legacy context names remain as compatibility API for current Teacher Portal modules.
  // Their values now come exclusively from the trusted Academy membership permissions.
  const departments: Department[] = [];
  const timeConfig: TimeConfig | null = null;
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const isLoading = false;
  const [entitlementLoading, setEntitlementLoading] = useState(true);
  const [entitlement, setEntitlement] = useState<EntitlementSnapshot | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(() => typeof window !== 'undefined' && localStorage.getItem('darkMode') === 'true');
  const requestSequence = useRef(0);

  const toggleDarkMode = () => setIsDarkMode((previous) => {
    const next = !previous;
    localStorage.setItem('darkMode', String(next));
    return next;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  const refreshEntitlement = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const user = auth.currentUser;
    if (!user) {
      setEntitlement(null);
      setEntitlementLoading(false);
      return null;
    }
    setEntitlementLoading(true);
    try {
      const access = await getAcademyAccess(user);
      if (sequence !== requestSequence.current || auth.currentUser?.uid !== user.uid) return null;
      const permissions = { ...DENIED_PERMISSIONS };
      const featureSources: Partial<Record<TeacherFeatureKey, string>> = {};
      for (const key of FEATURE_KEYS) {
        const permission = FEATURE_PERMISSION[key];
        if (access.role === 'academy_admin' || access.permissions?.[permission] === true) {
          permissions[key] = 'enabled';
          featureSources[key] = access.role === 'academy_admin' ? 'academy_admin' : permission;
        }
      }
      const next: EntitlementSnapshot = {
        active: true,
        status: 'academy_membership_active',
        planName: 'Academy permissions',
        expiresAt: null,
        featurePermissions: permissions,
        accessMode: 'academy_permissions',
        featureVisibilityMode: 'hide',
        featureSources,
        addOns: [],
      };
      setEntitlement(next);
      return next;
    } catch {
      if (sequence === requestSequence.current) setEntitlement(null);
      return null;
    } finally {
      if (sequence === requestSequence.current) setEntitlementLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, () => { void refreshEntitlement(); });
    return () => { requestSequence.current += 1; unsubscribe(); };
  }, [refreshEntitlement]);

  const featureVisibilityMode = 'hide' as const;
  const featureSource = useCallback((key: TeacherFeatureKey) => entitlement?.featureSources[key] ?? null, [entitlement]);
  const requestFeatureAddOn = useCallback(async (_key: TeacherFeatureKey, _note = '') => ({
    success: false,
    error: 'This action requires permission from your Academy Admin.',
  }), []);
  const featureState = useCallback((key: TeacherFeatureKey): FeaturePermissionState => entitlement?.featurePermissions[key] ?? 'disabled', [entitlement]);
  const canAccessFeature = useCallback((key: TeacherFeatureKey) => featureState(key) === 'enabled', [featureState]);
  const refreshData = useCallback(async () => {}, []);

  return (
    <AppContext.Provider value={{
      departments, timeConfig, selectedDepartment, setSelectedDepartment, selectedYear, setSelectedYear,
      isLoading, isDarkMode, toggleDarkMode, refreshData, entitlementLoading, entitlement,
      featureVisibilityMode, featureSource, requestFeatureAddOn, featureState, canAccessFeature, refreshEntitlement,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) throw new Error('useApp must be used within an AppProvider');
  return context;
}
