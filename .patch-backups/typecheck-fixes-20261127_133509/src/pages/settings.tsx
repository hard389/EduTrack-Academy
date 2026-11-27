import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Search,
  Settings,
  User,
  Sliders,
  Bell,
  Sun,
  Moon,
  Home,
  GraduationCap,
  Users,
  Wallet,
  Check,
  FileText,
  Award,
  Camera,
  Pencil,
  Trash2,
  Save,
  ShieldCheck,
  Phone,
  Mail,
  Building,
  UserCheck,
  AlertTriangle,
  X,
  AlertCircle
} from 'lucide-react';
import { doc, setDoc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import { onAuthStateChanged, updateProfile } from 'firebase/auth';

// ✅ FIREBASE IMPORTS
import { db, auth, storage } from '../lib/firebase';
import { academyManagementRequest, getAcademyAccess } from '@/lib/academyApi';

import GradingTab, { RatingPriority } from '../components/settings/GradingTab';
import ReportConfigTab, { ReportMetrics } from '../components/settings/ReportConfigTab';
import TriggerAlertsTab, { Thresholds } from '../components/settings/TriggerAlertsTab';

type SettingsTab = 'profile' | 'grading' | 'report_config' | 'notifications';

export interface ProfileData {
  name: string;
  role: string;
  schoolName: string;
  email: string;
  phone: string;
  avatarUrl: string;
}

// 🌐 BOTTOM NAVIGATION TABS CONFIGURATION
const navigationTabs = [
  { id: 'home', label: 'Home', icon: Home, href: '/' },
  { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/classes' },
  { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
  { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
];

const R2_API_BASE = String(
  (import.meta as ImportMeta & { env?: { VITE_R2_API_URL?: string } }).env?.VITE_R2_API_URL ||
  ''
).replace(/\/+$/, '');

export default function SettingsPage() {
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Layout & Navigation States
  const [isDark, setIsDark] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  const [loading, setLoading] = useState(true);

  // Profile Saved State & Edit Mode State
  const [isEditing, setIsEditing] = useState(false);
  const [hasProfile, setHasProfile] = useState(false);

  // Custom Delete Modal State
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // 🌟 ANIMATED POPUP MODAL STATE
  const [popup, setPopup] = useState<{
    show: boolean;
    title: string;
    message: string;
    type: 'success' | 'delete' | 'warning' | 'info';
  }>({ show: false, title: '', message: '', type: 'success' });
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Profile Form State
  const [profile, setProfile] = useState<ProfileData>({
    name: '',
    role: '',
    schoolName: '',
    email: '',
    phone: '+92 ',
    avatarUrl: ''
  });

  // Rating Priorities State
  const [ratingPriorities, setRatingPriorities] = useState<RatingPriority[]>([
    { level: 'Excellent', score: 100, color: 'text-emerald-500', bgColor: 'bg-emerald-500/10 border-emerald-500/30', badgeText: '🌟 Top Performer' },
    { level: 'Good', score: 75, color: 'text-blue-500', bgColor: 'bg-blue-500/10 border-blue-500/30', badgeText: '👍 Satisfactory' },
    { level: 'Average', score: 50, color: 'text-amber-500', bgColor: 'bg-amber-500/10 border-amber-500/30', badgeText: '⚠️ Needs Focus' },
    { level: 'Poor', score: 25, color: 'text-rose-500', bgColor: 'bg-rose-500/10 border-rose-500/30', badgeText: '🚨 Action Required' }
  ]);

  // Thresholds State
  const [thresholds, setThresholds] = useState<Thresholds>({
    lowAttendanceLimit: 75,
    feeDueReminderDays: 5,
    autoSendSms: true
  });

  // Report Metrics State
  const [reportMetrics, setReportMetrics] = useState<ReportMetrics>({
    homeworkEnabled: true,
    behaviorEnabled: true,
    participationEnabled: true,
    performanceEnabled: true,
    teacherRemarksRequired: true
  });

  // Tenant-safe Firestore references use the same users/{email} path as the
  // dashboard, report page and existing Firestore records.
  const getTenantEmail = () => {
    const email = auth.currentUser?.email?.trim().toLowerCase();
    if (!email) throw new Error('Your signed-in account has no email. Please sign in again.');
    return email;
  };

  const getSettingsDocRef = (email?: string) => {
    const tenantEmail = (email || getTenantEmail()).trim().toLowerCase();
    if (!tenantEmail || tenantEmail.includes('/')) throw new Error('Invalid teacher account email.');
    return doc(db, 'users', tenantEmail, 'settings', 'profile_data');
  };

  // A single replaceable timer prevents an older popup timer from hiding a newer one.
  const triggerPopup = (
    title: string,
    message: string,
    type: 'success' | 'delete' | 'warning' | 'info' = 'success',
    durationMs = 3200,
  ) => {
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    setPopup({ show: true, title, message, type });
    if (durationMs > 0) {
      popupTimerRef.current = setTimeout(() => {
        setPopup((prev) => ({ ...prev, show: false }));
        popupTimerRef.current = null;
      }, durationMs);
    } else {
      popupTimerRef.current = null;
    }
  };

  useEffect(() => () => {
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
  }, []);

  // Live profile synchronization: saved Settings values take priority,
  // while the root account document and Firebase Auth fill missing fields.
  useEffect(() => {
    let unsubscribeSettings: (() => void) | null = null;
    let unsubscribeRoot: (() => void) | null = null;
    let unsubscribeAuth: (() => void) | null = null;
    let activeGeneration = 0;

    unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      const generation = ++activeGeneration;

      unsubscribeSettings?.();
      unsubscribeSettings = null;
      unsubscribeRoot?.();
      unsubscribeRoot = null;

      setLoading(true);

      const userEmail = user?.email?.trim().toLowerCase();

      if (!user || !userEmail) {
        setHasProfile(false);
        setIsEditing(true);
        setProfile({
          name: '',
          role: '',
          schoolName: '',
          email: '',
          phone: '+92 ',
          avatarUrl: '',
        });
        setLoading(false);
        return;
      }

      let rootData: Record<string, unknown> = {};
      let savedProfile: Partial<ProfileData> = {};
      let rootReceived = false;
      let settingsReceived = false;

      const asText = (value: unknown): string =>
        typeof value === 'string' ? value.trim() : '';

      const applyCombinedProfile = () => {
        if (generation !== activeGeneration) return;

        const name =
          asText(rootData.teacherName) ||
          asText(rootData.name) ||
          asText(user.displayName) ||
          asText(savedProfile.name);

        const combinedProfile: ProfileData = {
          name,
          role:
            asText(rootData.designation) ||
            asText(rootData.teacherDesignation) ||
            asText(savedProfile.role),
          schoolName:
            asText(rootData.academyName) ||
            asText(rootData.schoolName) ||
            asText(savedProfile.schoolName),
          email:
            asText(rootData.contactEmail) ||
            asText(savedProfile.contactEmail) ||
            asText(savedProfile.email) ||
            asText(rootData.email) ||
            userEmail,
          phone:
            asText(rootData.whatsappNumber) ||
            asText(rootData.phone) ||
            asText(savedProfile.phone) ||
            '+92 ',
          avatarUrl:
            asText(rootData.profileImage) ||
            asText(rootData.avatarUrl) ||
            asText(user.photoURL) ||
            asText(savedProfile.avatarUrl),
        };

        setProfile(combinedProfile);
        setHasProfile(Boolean(combinedProfile.name));
        setIsEditing(!combinedProfile.name);

        if (rootReceived && settingsReceived) {
          setLoading(false);
        }
      };

      const settingsRef = doc(db, 'users', userEmail, 'settings', 'profile_data');
      const rootUserRef = doc(db, 'users', userEmail);

      unsubscribeSettings = onSnapshot(
        settingsRef,
        (snapshot) => {
          if (generation !== activeGeneration) return;

          const data = snapshot.exists() ? snapshot.data() : {};
          const rawProfile = data.profile;

          savedProfile =
            rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
              ? rawProfile as Partial<ProfileData>
              : {};

          if (data.ratingPriorities) setRatingPriorities(data.ratingPriorities);
          if (data.thresholds) setThresholds(data.thresholds);
          if (data.reportMetrics) setReportMetrics(data.reportMetrics);

          settingsReceived = true;
          applyCombinedProfile();
        },
        (error) => {
          if (generation !== activeGeneration) return;

          console.error('Firestore Settings profile listener error:', error);
          settingsReceived = true;
          applyCombinedProfile();
          triggerPopup(
            'Settings Profile Warning',
            'Saved Settings could not be fully loaded. Account information will be used where available.',
            'warning'
          );
        }
      );

      unsubscribeRoot = onSnapshot(
        rootUserRef,
        (snapshot) => {
          if (generation !== activeGeneration) return;

          rootData = snapshot.exists() ? snapshot.data() : {};
          rootReceived = true;
          applyCombinedProfile();
        },
        (error) => {
          if (generation !== activeGeneration) return;

          console.error('Root account profile listener error:', error);
          rootReceived = true;
          applyCombinedProfile();
          triggerPopup(
            'Account Profile Warning',
            'Account information could not be fully loaded. Saved Settings and sign-in information will be used where available.',
            'warning'
          );
        }
      );
    });

    return () => {
      activeGeneration += 1;
      unsubscribeAuth?.();
      unsubscribeSettings?.();
      unsubscribeRoot?.();
    };
  }, []);

  // 📞 PHONE NUMBER FORMATTING
  const getRawPhoneDigits = (phoneStr: string) => phoneStr.replace(/^\+92/, '').replace(/\D/g, '');

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let digits = e.target.value.replace(/^\+92/, '').replace(/\D/g, '');
    if (digits.length > 10) digits = digits.slice(0, 10);

    let formattedPhone = '+92 ';
    if (digits.length > 0) {
      if (digits.length <= 3) {
        formattedPhone += digits;
      } else {
        formattedPhone += `${digits.slice(0, 3)} ${digits.slice(3)}`;
      }
    }
    setProfile((prev) => ({ ...prev, phone: formattedPhone }));
  };

  const rawPhoneDigits = getRawPhoneDigits(profile.phone);
  const isPhoneValid = rawPhoneDigits.length === 10;
  const isPhoneIncomplete = rawPhoneDigits.length > 0 && rawPhoneDigits.length < 10;
  const isGmailValid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i.test(profile.email.trim());

  // A selected image stays local for preview until Save is pressed. Upload data URLs
  // to the existing private R2 profile-image endpoint, then store only its hosted URL.
  const uploadProfileImageIfNeeded = async (avatarUrl: string): Promise<string> => {
    if (!avatarUrl.startsWith('data:')) return avatarUrl;
    const user = auth.currentUser;
    if (!user?.email) throw new Error('Your sign-in session expired. Please sign in again.');

    const imageResponse = await fetch(avatarUrl);
    if (!imageResponse.ok) throw new Error('The selected profile image could not be read.');
    const blob = await imageResponse.blob();
    const mimeType = (blob.type || 'image/png').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      throw new Error('Use a JPG, PNG, or WebP profile image.');
    }
    if (blob.size <= 0 || blob.size > 2 * 1024 * 1024) {
      throw new Error('Profile image must be greater than 0 bytes and under 2MB.');
    }

    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
    const file = new File([blob], `teacher-avatar-${Date.now()}.${extension}`, { type: mimeType });
    const form = new FormData();
    form.append('file', file, file.name);

    const token = await user.getIdToken();
    const response = await fetch(`${R2_API_BASE}/api/register/profile-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    let payload: unknown = {};
    try { payload = await response.json(); } catch { /* Report a readable error below. */ }

    const payloadRecord: Record<string, unknown> =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
    const profileImageUrl = payloadRecord.profileImageUrl;

    if (
      !response.ok ||
      payloadRecord.ok !== true ||
      typeof profileImageUrl !== 'string' ||
      !profileImageUrl
    ) {
      const errorMessage =
        typeof payloadRecord.error === 'string' && payloadRecord.error.trim()
          ? payloadRecord.error
          : `Profile image upload failed (${response.status}).`;
      throw new Error(errorMessage);
    }

    return profileImageUrl;
  };

  // 💾 SAVE PROFILE — update editable settings and signup/root fields together.
  const handleSaveProfile = async () => {
    if (!profile.name.trim()) return triggerPopup('Name Required', 'Please enter Full Name.', 'warning');
    if (!profile.role.trim()) return triggerPopup('Designation Required', 'Please fill Role field.', 'warning');
    if (!profile.schoolName.trim()) return triggerPopup('School Required', 'Please enter Academy or School Name.', 'warning');
    if (!isGmailValid) return triggerPopup('Invalid Email', 'Enter a valid Gmail address ending in @gmail.com', 'warning');
    if (!isPhoneValid) return triggerPopup('Phone Incomplete', 'Enter complete 10-digit number.', 'warning');

    const user = auth.currentUser;
    const tenantEmail = user?.email?.trim().toLowerCase();
    if (!user || !tenantEmail) {
      return triggerPopup('Sign-In Required', 'Your session expired. Please sign in again before saving.', 'warning');
    }

    // Immediate feedback while the image upload / Firestore writes are in progress.
    triggerPopup('Saving Profile…', 'Updating your profile and signup information.', 'info', 0);

    try {
      let academyAccess: Awaited<ReturnType<typeof getAcademyAccess>> | null = null;
      try {
        academyAccess = await getAcademyAccess(user);
      } catch (accessError) {
        // Non-Academy legacy users continue using the existing profile save path.
        // Do not swallow unexpected network/server failures.
        const status = typeof accessError === 'object' && accessError !== null && 'status' in accessError ? Number((accessError as { status?: unknown }).status) : 0;
        if (![401, 403, 404].includes(status)) throw accessError;
      }

      let uploadedAvatarUrl = profile.avatarUrl.trim();
      if (academyAccess?.role === 'teacher') {
        let profileImageStoragePath: string | undefined;
        if (uploadedAvatarUrl.startsWith('data:')) {
          const imageResponse = await fetch(uploadedAvatarUrl);
          if (!imageResponse.ok) throw new Error('The selected profile image could not be read.');
          const blob = await imageResponse.blob();
          const mimeType = (blob.type || 'image/png').toLowerCase();
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || blob.size <= 0 || blob.size > 3 * 1024 * 1024) {
            throw new Error('Use a JPG, PNG or WebP profile image under 3 MB.');
          }
          const path = `academies/${academyAccess.academyId}/teachers/${user.uid}/profile/avatar`;
          const uploaded = await uploadBytes(storageRef(storage, path), blob, { contentType: mimeType, customMetadata: { academyId: academyAccess.academyId, teacherUid: user.uid } });
          profileImageStoragePath = uploaded.ref.fullPath;
          uploadedAvatarUrl = await getDownloadURL(uploaded.ref);
        }
        await academyManagementRequest(user, {
          action: 'update-own-teacher-profile',
          displayName: profile.name.trim(), designation: profile.role.trim(),
          contactEmail: profile.email.trim(), contactPhone: profile.phone.trim(), profileImage: uploadedAvatarUrl,
          ...(profileImageStoragePath ? { profileImageStoragePath } : {}),
        });
      } else {
        uploadedAvatarUrl = await uploadProfileImageIfNeeded(uploadedAvatarUrl);
      }

      const savedProfile: ProfileData = {
        ...profile,
        name: profile.name.trim(),
        role: profile.role.trim(),
        schoolName: academyAccess?.role === 'teacher' ? academyAccess.academyName : profile.schoolName.trim(),
        email: academyAccess?.role === 'teacher' ? profile.email.trim() : profile.email.trim() || tenantEmail,
        phone: profile.phone.trim(),
        avatarUrl: uploadedAvatarUrl,
      };
      const updatedAt = new Date().toISOString();
      const settingsRef = doc(db, 'users', tenantEmail, 'settings', 'profile_data');
      const rootUserRef = doc(db, 'users', tenantEmail);

      if (academyAccess?.role !== 'teacher') {
        // Legacy accounts retain their existing direct profile writes.
        await Promise.all([
          setDoc(settingsRef, { profile: savedProfile, updatedAt }, { merge: true }),
          setDoc(rootUserRef, {
            teacherName: savedProfile.name, name: savedProfile.name,
            designation: savedProfile.role, teacherDesignation: savedProfile.role,
            schoolName: savedProfile.schoolName, academyName: savedProfile.schoolName,
            whatsappNumber: savedProfile.phone, phone: savedProfile.phone,
            profileImage: savedProfile.avatarUrl, avatarUrl: savedProfile.avatarUrl,
            updatedAt,
          }, { merge: true }),
        ]);
      }

      void updateProfile(user, { displayName: savedProfile.name, photoURL: savedProfile.avatarUrl || null }).catch((authProfileError) => {
        console.warn('Profile data was saved, but Firebase Auth display profile could not be updated:', authProfileError);
      });

      setProfile(savedProfile);
      setIsEditing(false);
      setHasProfile(true);
      triggerPopup('Profile Saved!', 'Name, contact Gmail and profile picture were updated across the Academy teacher profile.', 'success');
    } catch (error) {
      console.error('Error saving profile:', error);
      const message = error instanceof Error ? error.message : 'Could not update profile.';
      triggerPopup('Save Failed', message, 'delete');
    }
  };

  // 🗑️ DELETE PROFILE
  const handleConfirmDelete = async () => {
    setShowDeleteModal(false);
    try {
      await deleteDoc(getSettingsDocRef());
      setProfile({ name: '', role: '', schoolName: '', email: '', phone: '+92 ', avatarUrl: '' });
      setHasProfile(false);
      setIsEditing(true);
      triggerPopup('Profile Deleted!', 'Profile removed from database.', 'delete');
    } catch (error) {
      console.error('Error deleting profile:', error);
      triggerPopup('Delete Failed', 'Could not delete profile.', 'delete');
    }
  };

  // 📷 IMAGE UPLOAD
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) return triggerPopup('File Too Large', 'Image must be under 2MB.', 'warning');
      const reader = new FileReader();
      reader.onloadend = () => setProfile((prev) => ({ ...prev, avatarUrl: reader.result as string }));
      reader.readAsDataURL(file);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-[#070b13] transition-colors">
        <div className="relative flex items-center justify-center">
          <div className="w-16 h-16 rounded-full border-4 border-orange-500/20 border-t-orange-500 animate-spin" />
          <Settings className="h-6 w-6 text-orange-500 absolute animate-pulse" />
        </div>
        <p className="mt-4 font-bold text-xs text-slate-500 dark:text-slate-400 tracking-wider uppercase">
          Loading Settings...
        </p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-32 ${isDark ? 'dark' : ''}`}>

      {/* 🌟 1. MINIMAL PREMIUM UTILITY HEADER */}
      <div className="w-full bg-white/40 dark:bg-[#070b13]/40 backdrop-blur-sm border-b border-slate-200/40 dark:border-slate-900/40 sticky top-0 z-40 transition-colors">
        <div className="mx-auto max-w-7xl flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">

          {/* Quick Search */}
          <div className="relative w-48 sm:w-64">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Quick search..."
              className="w-full rounded-xl border border-slate-200/60 bg-white/60 py-1.5 pl-9 pr-4 text-xs outline-none transition-all focus:border-orange-500 focus:bg-white dark:border-slate-800 dark:bg-[#0c1222] dark:focus:bg-[#0c1222] dark:text-white"
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Dark Mode Toggle */}
            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/60 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/30"
              title="Toggle Theme"
            >
              <div className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-sm transition-all ${isDark ? 'translate-x-5 bg-slate-950 text-yellow-400' : ''}`}>
                {isDark ? <Moon className="h-3 w-3 fill-current" /> : <Sun className="h-3 w-3 fill-current" />}
              </div>
            </button>

            {/* Notification Bell */}
            <Link
              to="/alerts"
              className="relative rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#0c1222] transition-all hover:scale-105 active:scale-95"
            >
              <Bell className="h-4 w-4" />
              <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-orange-500 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#070b13] animate-pulse">
                3
              </span>
            </Link>

            {/* Profile Link */}
            <Link
              to="/settings"
              title="View Profile / Settings"
              className="h-8 w-8 overflow-hidden rounded-full ring-2 ring-orange-500/70 shadow-[0_0_12px_rgba(249,115,22,0.4)] transition-all hover:scale-110 active:scale-95 cursor-pointer block"
            >
              <img
                src={
                  profile.avatarUrl ||
                  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250'
                }
                alt={profile.name || 'User Avatar'}
                className="h-full w-full object-cover"
              />
            </Link>
          </div>
        </div>
      </div>

      {/* 🗑️ DELETE CONFIRMATION MODAL */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 backdrop-blur-md transition-all px-4 animate-fadeIn">
          <div className="bg-white dark:bg-[#0c1222] border border-rose-500/30 rounded-3xl p-6 max-w-sm w-full shadow-[0_0_50px_rgba(244,63,94,0.25)] flex flex-col items-center text-center relative overflow-hidden">
            <button
              onClick={() => setShowDeleteModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded-full transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="w-16 h-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mb-4 shadow-lg shadow-rose-500/10 border border-rose-500/20">
              <AlertTriangle className="h-8 w-8 animate-bounce" />
            </div>

            <h3 className="text-lg font-black text-slate-900 dark:text-white">Delete Teacher Profile?</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1.5 leading-relaxed">
              Are you sure you want to remove this profile? This action will delete the profile data permanently.
            </p>

            <div className="grid grid-cols-2 gap-3 w-full mt-6">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="py-3 px-4 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs transition-all active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="py-3 px-4 rounded-xl bg-rose-500 hover:bg-rose-600 text-white font-bold text-xs shadow-lg shadow-rose-500/30 transition-all active:scale-95 flex items-center justify-center gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🌟 ANIMATED POPUP NOTIFICATION */}
      {popup.show && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 backdrop-blur-md transition-all px-4 animate-fadeIn">
          <div className="bg-white dark:bg-[#0c1222] border border-orange-500/30 rounded-3xl p-6 max-w-xs w-full shadow-[0_0_50px_rgba(249,115,22,0.3)] flex flex-col items-center text-center">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center mb-3 shadow-lg ${
              popup.type === 'delete' 
                ? 'bg-rose-500/10 text-rose-500 shadow-rose-500/20' 
                : popup.type === 'warning'
                ? 'bg-amber-500/10 text-amber-500 shadow-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-500 shadow-emerald-500/20'
            }`}>
              {popup.type === 'delete' ? (
                <Trash2 className="h-7 w-7 animate-bounce" />
              ) : popup.type === 'warning' ? (
                <AlertCircle className="h-7 w-7 animate-bounce" />
              ) : (
                <Check className="h-7 w-7 stroke-[3] animate-bounce" />
              )}
            </div>
            <h3 className="text-base font-black text-slate-900 dark:text-white">{popup.title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1 leading-relaxed">{popup.message}</p>
          </div>
        </div>
      )}

      {/* MAIN CONTENT AREA */}
      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6 sm:px-6">

        {/* PAGE HEADER — follows the Classes page visual language */}
        <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 p-5 sm:p-6">
          <div className="absolute -top-10 -right-10 h-44 w-44 rounded-full bg-gradient-to-bl from-chart-1/15 to-transparent blur-3xl" />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-chart-1/10 ring-1 ring-chart-1/20 sm:flex">
                <Settings className="h-6 w-6 text-chart-1" />
              </div>
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-chart-1/20 bg-chart-1/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-chart-1">
                  <ShieldCheck className="h-3 w-3" /> Teacher workspace settings
                </span>
                <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Settings & Teacher Profile</h2>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Manage your profile, grading remarks, monthly report fields and alert preferences in one place.</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-xl border border-border/60 bg-card/70 px-3 py-2 font-semibold">Secure settings</span>
              <span className="rounded-xl border border-border/60 bg-card/70 px-3 py-2 font-semibold">Saved to Firestore</span>
            </div>
          </div>
        </section>

        {/* SUB-TAB NAVIGATION */}
        <div className="glass-card rounded-2xl border border-border/50 bg-card/80 p-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSettingsTab('profile')}
            className={`px-4 py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'profile'
                ? 'bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md'
                : 'bg-card/70 text-muted-foreground border border-border/60 hover:border-primary/40 hover:text-foreground'
            }`}
          >
            <User className="h-4 w-4" /> Admin Profile
          </button>

          <button
            onClick={() => setSettingsTab('grading')}
            className={`px-4 py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'grading'
                ? 'bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md'
                : 'bg-card/70 text-muted-foreground border border-border/60 hover:border-primary/40 hover:text-foreground'
            }`}
          >
            <Award className="h-4 w-4" /> Grading Rules
          </button>

          <button
            onClick={() => setSettingsTab('report_config')}
            className={`px-4 py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'report_config'
                ? 'bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md'
                : 'bg-card/70 text-muted-foreground border border-border/60 hover:border-primary/40 hover:text-foreground'
            }`}
          >
            <FileText className="h-4 w-4" /> Report Fields
          </button>

          <button
            onClick={() => setSettingsTab('notifications')}
            className={`px-4 py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'notifications'
                ? 'bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md'
                : 'bg-card/70 text-muted-foreground border border-border/60 hover:border-primary/40 hover:text-foreground'
            }`}
          >
            <Bell className="h-4 w-4" /> Trigger Alerts
          </button>
          </div>
        </div>

        {/* PROFILE TAB */}
        {settingsTab === 'profile' && (
          <div className="glass-card overflow-hidden rounded-2xl border border-border/50 bg-card/90 p-4 shadow-sm sm:p-6">
            <div className="relative rounded-xl bg-transparent p-1 sm:p-2 space-y-6">

              {/* SAVED PROFILE CARD */}
              {hasProfile && !isEditing ? (
                <div className="space-y-6 animate-fadeIn">
                  <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-2">
                      <UserCheck className="h-5 w-5 text-emerald-500" />
                      <h3 className="font-black text-slate-900 dark:text-white text-base uppercase tracking-wider">
                        PROFILE
                      </h3>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setIsEditing(true)}
                        className="px-3.5 py-2 rounded-xl bg-orange-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-md hover:bg-orange-600 active:scale-95 transition-all"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit Profile
                      </button>

                      <button
                        onClick={() => setShowDeleteModal(true)}
                        className="p-2 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 active:scale-95 transition-all"
                        title="Delete Profile"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5 bg-slate-50 dark:bg-slate-900/60 p-5 rounded-2xl border border-slate-100 dark:border-slate-800">
                    <img
                      src={
                        profile.avatarUrl ||
                        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250'
                      }
                      alt="Avatar"
                      className="w-20 h-20 rounded-2xl object-cover ring-2 ring-orange-500/30 shadow-md"
                    />

                    <div className="space-y-2 text-center sm:text-left flex-1">
                      <div>
                        <h2 className="text-lg font-black text-slate-900 dark:text-white">{profile.name}</h2>
                        <p className="text-xs font-bold text-orange-500">{profile.role}</p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                        <div className="flex items-center gap-1.5 justify-center sm:justify-start">
                          <Building className="h-3.5 w-3.5 text-orange-500" />
                          <span>{profile.schoolName || 'Not Set'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 justify-center sm:justify-start">
                          <Mail className="h-3.5 w-3.5 text-orange-500" />
                          <span>{profile.email || 'Not Set'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 justify-center sm:justify-start">
                          <Phone className="h-3.5 w-3.5 text-orange-500" />
                          <span>{profile.phone || 'Not Set'}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                
                /* EDIT / CREATE FORM */
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <img
                          src={
                            profile.avatarUrl ||
                            'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250'
                          }
                          alt="Avatar"
                          className="w-14 h-14 rounded-2xl object-cover ring-2 ring-orange-500/30 shadow-md"
                        />
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="absolute -bottom-1 -right-1 p-1.5 rounded-xl bg-orange-500 text-white shadow-md hover:bg-orange-600 active:scale-95 transition-all"
                        >
                          <Camera className="h-3.5 w-3.5" />
                        </button>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handleImageUpload}
                          className="hidden"
                        />
                      </div>

                      <div>
                        <h3 className="font-black text-slate-900 dark:text-white text-base">
                          {hasProfile ? 'Edit Profile Details' : 'Create Teacher Profile'}
                        </h3>
                        <p className="text-xs font-medium text-slate-400">
                          {hasProfile ? 'Update existing teacher information' : 'Fill all fields to save in settings collection'}
                        </p>
                      </div>
                    </div>

                    {hasProfile && (
                      <button
                        onClick={() => setIsEditing(false)}
                        className="text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {/* FULL NAME INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 text-orange-500" /> Full Name
                    </label>
                    <input
                      type="text"
                      value={profile.name}
                      onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                      placeholder="Enter administrator / teacher full name"
                      className={`w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                        profile.name.trim()
                          ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                          : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                      }`}
                    />
                  </div>

                  {/* ROLE / DESIGNATION INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <Award className="h-3.5 w-3.5 text-orange-500" /> Role / Designation
                    </label>
                    <input
                      type="text"
                      value={profile.role}
                      onChange={(e) => setProfile({ ...profile, role: e.target.value })}
                      placeholder="e.g. Head Teacher / Senior Instructor"
                      className={`w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                        profile.role.trim()
                          ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                          : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                      }`}
                    />
                  </div>

                  {/* ACADEMY / SCHOOL NAME INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <Building className="h-3.5 w-3.5 text-orange-500" /> Academy / School Name
                    </label>
                    <input
                      type="text"
                      value={profile.schoolName}
                      onChange={(e) => setProfile({ ...profile, schoolName: e.target.value })}
                      placeholder="Enter school or academy name"
                      className={`w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                        profile.schoolName.trim()
                          ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                          : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                      }`}
                    />
                  </div>

                  {/* GMAIL ADDRESS INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-orange-500" /> Contact Gmail (@gmail.com)
                    </label>
                    <div className="relative flex items-center">
                      <input
                        type="email"
                        value={profile.email}
                        onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                        placeholder="teacher@gmail.com"
                        className={`w-full pl-4 pr-11 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                          isGmailValid
                            ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                            : profile.email.length > 0
                            ? 'border-rose-500/80 focus:ring-2 focus:ring-rose-500'
                            : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                        }`}
                      />

                      <div className="absolute right-3.5 flex items-center justify-center">
                        {isGmailValid && (
                          <div className="p-1 rounded-full bg-emerald-500/15 text-emerald-500 animate-fadeIn">
                            <Check className="h-4 w-4 stroke-[3]" />
                          </div>
                        )}

                        <p className="mt-1 pl-1 text-[10px] text-slate-500">For Academy teachers, this is a contact email; the Firebase sign-in email is unchanged.</p>
                    {!isGmailValid && profile.email.length > 0 && (
                          <div className="p-1 rounded-full bg-rose-500/15 text-rose-500 animate-pulse">
                            <AlertCircle className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    </div>
                    {!isGmailValid && profile.email.length > 0 && (
                      <p className="text-[10px] font-semibold text-rose-500 mt-1 pl-1">
                        Email must end strictly with @gmail.com
                      </p>
                    )}
                  </div>

                  {/* WHATSAPP PHONE INPUT */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-orange-500" /> Contact WhatsApp
                      </label>

                      <span className="text-[10px] font-bold text-slate-400">
                        {rawPhoneDigits.length} / 10 Digits
                      </span>
                    </div>

                    <div className="relative flex items-center">
                      <input
                        type="text"
                        value={profile.phone}
                        onChange={handlePhoneChange}
                        placeholder="+92 300 0000000"
                        className={`w-full pl-4 pr-11 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                          isPhoneValid
                            ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                            : isPhoneIncomplete
                            ? 'border-rose-500/80 focus:ring-2 focus:ring-rose-500'
                            : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                        }`}
                      />

                      <div className="absolute right-3.5 flex items-center justify-center">
                        {isPhoneValid && (
                          <div className="p-1 rounded-full bg-emerald-500/15 text-emerald-500 animate-fadeIn">
                            <Check className="h-4 w-4 stroke-[3]" />
                          </div>
                        )}

                        {isPhoneIncomplete && (
                          <div className="p-1 rounded-full bg-rose-500/15 text-rose-500 animate-pulse">
                            <AlertCircle className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    </div>

                    {isPhoneIncomplete && (
                      <p className="text-[10px] font-semibold text-rose-500 mt-1 pl-1">
                        Please enter remaining {10 - rawPhoneDigits.length} digits after +92.
                      </p>
                    )}
                  </div>

                  <button
                    onClick={handleSaveProfile}
                    className="w-full py-3.5 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-orange-500/20 active:scale-95 transition-all mt-3"
                  >
                    <Save className="h-4 w-4" /> Save Profile Details
                  </button>
                </div>
              )}

            </div>
          </div>
        )}

        {/* OTHER SETTINGS TABS */}
        {settingsTab === 'grading' && (
          <GradingTab
            ratingPriorities={ratingPriorities}
            setRatingPriorities={setRatingPriorities}
          />
        )}

        {settingsTab === 'report_config' && (
          <ReportConfigTab
            reportMetrics={reportMetrics}
            setReportMetrics={setReportMetrics}
          />
        )}

        {settingsTab === 'notifications' && (
          <TriggerAlertsTab
            thresholds={thresholds}
            setThresholds={setThresholds}
          />
        )}

      </main>

      {/* 🌟 2. FLOATING BOTTOM NAVIGATION BAR */}
      <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-4 pt-2 bg-gradient-to-t from-[#f8fafc] via-[#f8fafc]/90 to-transparent dark:from-[#070b13] dark:via-[#070b13]/90 pointer-events-none">
        <nav className="mx-auto max-w-md bg-white/80 dark:bg-[#0c1222]/90 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/40 rounded-3xl shadow-[0_15px_35px_-5px_rgba(0,0,0,0.08)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] px-3 py-2 flex items-center justify-between pointer-events-auto">
          {navigationTabs.map((tab) => {
            const IconComponent = tab.icon;
            const isActive = location.pathname === tab.href || (tab.href === '/settings' && location.pathname.includes('/settings'));

            return (
              <Link
                key={tab.id}
                to={tab.href}
                className="flex flex-col items-center justify-center flex-1 py-1 relative group"
              >
                <div
                  className={`p-2 rounded-2xl transition-all duration-300 relative ${
                    isActive
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30 scale-105'
                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  <IconComponent className="h-4 w-4" />
                </div>

                <span
                  className={`text-[9px] font-bold tracking-tight mt-1 transition-colors ${
                    isActive
                      ? 'text-orange-600 dark:text-orange-400 font-extrabold'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {tab.label}
                </span>

                {isActive && (
                  <div className="absolute top-0 h-1 w-1 bg-orange-500 rounded-full shadow-[0_0_8px_#f97316]" />
                )}
              </Link>
            );
          })}
        </nav>
      </div>

    </div>
  );
}
