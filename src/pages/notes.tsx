import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import './notes-library-premium.css';
import {
  Folder, BookOpen, FileText, Upload, Share2, Copy, Check, Eye, Download,
  Plus, ArrowLeft, Search, Sun, Moon, Home, GraduationCap, Users, Wallet,
  Sparkles, X, Trash2, Settings, Pencil, AlertTriangle,
  FileImage, FileType, Link2, ArrowRight, RefreshCw,
  HardDrive, Database, ShieldCheck, Gauge, Clock3, Info, CircleAlert, CircleCheck, History
} from 'lucide-react';

// Use the single shared Firebase project configured by the application.
// Do not initialize a second app or embed project credentials in this page.
import { auth, db } from '@/lib/firebase';
import { useApp } from '@/contexts/AppContext';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  collection, getDocs, doc, getDoc, getDocFromServer, setDoc, runTransaction, serverTimestamp
} from 'firebase/firestore';

// Types
type ResourceCategory = 'All' | 'Notes' | 'Textbooks' | 'Past Papers' | 'Assignments';

interface LibraryResource {
  id: string;
  title: string;
  category: Exclude<ResourceCategory, 'All'>;
  fileType: 'pdf' | 'doc' | 'image' | 'link';
  fileSize?: string;
  // Exact file payload size in bytes. Legacy records may not contain this field.
  sizeBytes?: number;
  fileName?: string;
  fileDataUrl?: string;
  uploadDate: string;
  shareUrl: string;
  contentPreview?: string;
  // Legacy field name retained for Firestore compatibility; new values contain an R2 object key.
  storagePath?: string;
  // In-memory only: indicates whether the resource is an embedded legacy record or a documents subcollection record.
  _source?: 'embedded' | 'document';
}

interface ClassLibrary {
  id: string;
  className: string;
  classCode: string;
  totalStudents: number;
  bgGradient: string;
  resources: LibraryResource[];
}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const BYTES_PER_GB = 1_073_741_824;
const DEFAULT_STORAGE_QUOTA_BYTES = 1 * BYTES_PER_GB;
const LEGACY_DEFAULT_STORAGE_QUOTA_BYTES = 2 * BYTES_PER_GB;

type StorageUsageSource = 'verified' | 'recorded' | 'metadata-estimate' | 'r2-authoritative';
interface StorageSummary {
  ownerUid: string;
  defaultQuotaBytes: number;
  allocatedQuotaBytes: number;
  usedBytes: number;
  additionalGrantedBytes: number;
  knownBytes: number;
  unknownFileCount: number;
  usageVerified: boolean;
  usageSource: StorageUsageSource;
  trackedObjectCount?: number;
  updatedAt?: unknown;
  lastReconciledAt?: unknown;
}
interface StorageExtensionRecord {
  id: string;
  requestedGb: number;
  grantedGb?: number;
  status: string;
  previousQuotaBytes?: number;
  newQuotaBytes?: number | null;
  requestDate?: unknown;
  approvalDate?: unknown;
  reason?: string;
}

type UploadStage =
  | 'idle'
  | 'validating'
  | 'uploading-to-r2'
  | 'saving-firestore-document'
  | 'verifying-save-outcome'
  | 'cleaning-up'
  | 'completed';

type UploadStepStatus = 'pending' | 'active' | 'done' | 'error';

interface PendingUploadAttempt {
  ownerUid: string;
  tenantId: string;
  classId: string;
  formSignature: string;
  resourceId: string;
  storedPath: string;
  resource: LibraryResource;
  fileUploaded: boolean;
  firestoreWriteAttempted: boolean;
  metadataUncertain: boolean;
  // True while a setDoc() promise for this attempt has not yet settled. Cleanup must never
  // delete the R2 object while a metadata write may still commit.
  writeInFlight: boolean;
}

const getUploadFormSignature = (
  title: string,
  category: Exclude<ResourceCategory, 'All'>,
  description: string,
  file: File,
): string => JSON.stringify([
  title,
  category,
  sanitizeDisplayText(description || 'Uploaded study material/CV for students.', 5000),
  file.name,
  file.size,
  file.lastModified,
  file.type,
]);

const getUploadErrorCode = (error: unknown): string =>
  String((error as { code?: string } | null)?.code ?? '').replace(/^firestore\//, '');

const R2_API_BASE = String((import.meta as ImportMeta & { env?: { VITE_R2_API_URL?: string } }).env?.VITE_R2_API_URL || '').replace(/\/+$/, '');
const USE_FIREBASE_EMULATORS = Boolean(
  (import.meta as ImportMeta & { env?: { DEV?: boolean; VITE_USE_FIREBASE_EMULATORS?: string } }).env?.DEV &&
  (import.meta as ImportMeta & { env?: { VITE_USE_FIREBASE_EMULATORS?: string } }).env?.VITE_USE_FIREBASE_EMULATORS === 'true',
);
const R2_API_IS_LOCAL = (() => {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(R2_API_BASE).hostname); }
  catch { return false; }
})();
const assertSafeR2Endpoint = (operation: string) => {
  if (USE_FIREBASE_EMULATORS && !R2_API_IS_LOCAL) {
    throw new Error(`R2 ${operation} is blocked in local Firebase Emulator mode because the configured R2 API is not local. No production R2 request was made.`);
  }
};
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// Firestore acknowledgement bounds retained so an uncertain metadata write can be reconciled safely.
const FIRESTORE_SLOW_HINT_MS = 8_000;
const FIRESTORE_ACK_WAIT_MS = 25_000;
const UPLOAD_CONTEXT_CHANGED = 'UPLOAD_CONTEXT_CHANGED';
const UPLOAD_SUCCESS_MESSAGE = 'Study material uploaded and saved successfully!';
const ALLOWED_FILE_TYPES: Record<string, { mimeType: string; fileType: LibraryResource['fileType'] }> = {
  pdf: { mimeType: 'application/pdf', fileType: 'pdf' },
  doc: { mimeType: 'application/msword', fileType: 'doc' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileType: 'doc' },
  png: { mimeType: 'image/png', fileType: 'image' },
  jpg: { mimeType: 'image/jpeg', fileType: 'image' },
  jpeg: { mimeType: 'image/jpeg', fileType: 'image' },
};
const VALID_CATEGORIES = new Set<Exclude<ResourceCategory, 'All'>>(['Notes', 'Textbooks', 'Past Papers', 'Assignments']);

const normalizeEmail = (email?: string | null): string => String(email ?? '').trim().toLowerCase();
const isValidPathSegment = (value: string): boolean => Boolean(value.trim()) && !value.includes('/') && value !== '.' && value !== '..';
const sanitizeDisplayText = (value: unknown, maxLength = 5000): string =>
  // eslint-disable-next-line no-control-regex -- Intentional removal of ASCII control characters.
  String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
const sanitizeFileName = (value: string): string => {
  const baseName = String(value || 'download').split(/[\\/]/).pop() || 'download';
  // eslint-disable-next-line no-control-regex -- Intentional filename sanitization.
  return baseName.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'download';
};
const makeResourceId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `res-${crypto.randomUUID()}`;
  } catch { /* Use the fallback below in older browsers. */ }
  return `res-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};
const makeShareUrl = (id: string): string => `${R2_API_BASE}/share/${encodeURIComponent(id)}`;
const friendlyError = (error: unknown, action: string): string => {
  const code = String((error as { code?: string } | null)?.code ?? '').replace(/^firestore\//, '');
  if (code === 'permission-denied' || code === 'unauthorized') {
    return `Permission denied. Your teacher account cannot ${action}.`;
  }
  if (code === 'unauthenticated') return 'Your session has expired. Please sign in again.';
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'cancelled' || code === 'retry-limit-exceeded' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return `Network problem while trying to ${action}. Check your connection and try again.`;
  }
  if (code === 'not-found' || code === 'object-not-found') return 'This resource no longer exists. Refresh the library and try again.';
  if (error instanceof Error && !('code' in error) && error.message) return sanitizeDisplayText(error.message, 240);
  return `Could not ${action}. Please try again.`;
};

const validateUploadFile = (file: File): { extension: string; mimeType: string; fileType: LibraryResource['fileType'] } => {
  if (!file || file.size <= 0) throw new Error('The selected file is empty. Choose a valid PDF, Word document, or image.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is too large. The maximum supported upload size is 20 MB.');
  const extension = String(file.name.split('.').pop() ?? '').toLowerCase();
  const definition = ALLOWED_FILE_TYPES[extension];
  if (!definition) throw new Error('Unsupported file type. Upload PDF, DOC, DOCX, PNG, JPG, or JPEG files only.');
  const actualMime = String(file.type ?? '').toLowerCase().trim();
  if (actualMime && actualMime !== definition.mimeType && actualMime !== 'application/octet-stream') {
    throw new Error('The file extension and detected file type do not match. Choose a valid file.');
  }
  return { extension, mimeType: definition.mimeType, fileType: definition.fileType };
};

const uploadFileToR2 = (
  resourceId: string,
  user: User,
  classId: string,
  title: string,
  category: Exclude<ResourceCategory, 'All'>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> => new Promise((resolve, reject) => {
  try { assertSafeR2Endpoint('upload'); } catch (error) { reject(error); return; }
  const form = new FormData();
  form.append('file', file, sanitizeFileName(file.name));
  form.append('classId', classId);
  form.append('title', title);
  form.append('category', category);

  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `${R2_API_BASE}/api/files/${encodeURIComponent(resourceId)}`);
  xhr.timeout = 120_000;
  void user.getIdToken().then((token) => {
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      const total = event.total || file.size;
      if (total > 0) onProgress(Math.min(100, Math.max(0, Math.round((event.loaded / total) * 100))));
    };
    xhr.onload = () => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(xhr.responseText || '{}');
        if (isUnknownRecord(parsed)) payload = parsed;
      } catch { /* Non-JSON API error. */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.ok === true) {
        resolve();
      } else {
        reject(new Error(String(payload.error || `Cloudflare R2 upload failed (${xhr.status}).`)));
      }
    };
    xhr.onerror = () => reject(new Error('Network error while uploading to Cloudflare R2. Check your connection and Worker CORS settings.'));
    xhr.ontimeout = () => reject(new Error('Cloudflare R2 upload timed out. Check your connection and retry the same upload.'));
    xhr.onabort = () => reject(new Error('Cloudflare R2 upload was cancelled.'));
    xhr.send(form);
  }).catch(reject);
});

const deleteR2Object = async (resourceId: string, classId: string, expectedUid: string): Promise<void> => {
  assertSafeR2Endpoint('delete');
  const user = auth.currentUser;
  if (!user || user.uid !== expectedUid) throw new Error('The signed-in teacher changed; file cleanup was skipped.');
  const token = await user.getIdToken();
  const response = await fetch(`${R2_API_BASE}/api/files/${encodeURIComponent(resourceId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ classId }),
  });
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isUnknownRecord(parsed)) payload = parsed;
  } catch { /* Handle a non-JSON Worker error below. */ }
  if (!response.ok || payload.ok !== true) {
    throw new Error(String(payload.error || `Cloudflare R2 delete failed (${response.status}).`));
  }
};

const readArrayLike = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value);
  return [];
};

const normalizeResource = (raw: unknown, fallbackId: string, source: 'embedded' | 'document'): LibraryResource | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = sanitizeDisplayText(value.id ?? fallbackId, 180) || fallbackId;
  const title = sanitizeDisplayText(value.title ?? value.fileName ?? 'Untitled resource', 180) || 'Untitled resource';
  const rawCategory = value.category;
  const category = VALID_CATEGORIES.has(rawCategory as Exclude<ResourceCategory, 'All'>)
    ? rawCategory as Exclude<ResourceCategory, 'All'> : 'Notes';
  const rawType = String(value.fileType ?? '').toLowerCase();
  const fileType: LibraryResource['fileType'] = rawType === 'pdf' || rawType === 'doc' || rawType === 'image' || rawType === 'link'
    ? rawType : 'link';
  return {
    id,
    title,
    category,
    fileType,
    fileSize: typeof value.fileSize === 'string' ? value.fileSize.slice(0, 80) : '',
    sizeBytes: typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0
      ? Math.floor(value.sizeBytes) : undefined,
    fileName: typeof value.fileName === 'string' ? sanitizeFileName(value.fileName) : undefined,
    fileDataUrl: typeof value.fileDataUrl === 'string' && value.fileDataUrl.startsWith('data:') ? value.fileDataUrl : undefined,
    storagePath: typeof value.storagePath === 'string' ? value.storagePath : undefined,
    uploadDate: typeof value.uploadDate === 'string' ? value.uploadDate.slice(0, 80) : '',
    shareUrl: makeShareUrl(id),
    contentPreview: sanitizeDisplayText(value.contentPreview ?? '', 5000),
    _source: source,
  };
};

const estimateR2UsageFromLibraries = (libraries: ClassLibrary[]) => {
  // Resources can appear both in a legacy embedded array and the canonical documents
  // subcollection. Deduplicate by the R2 object path (then ID) before adding bytes.
  const unique = new Map<string, LibraryResource>();
  libraries.forEach((cls) => cls.resources.forEach((resource) => {
    if (!resource.storagePath?.startsWith('resources/')) return;
    const key = resource.storagePath || resource.id;
    if (!unique.has(key)) unique.set(key, resource);
  }));
  let knownBytes = 0;
  let unknownFileCount = 0;
  unique.forEach((resource) => {
    if (typeof resource.sizeBytes === 'number' && Number.isSafeInteger(resource.sizeBytes) && resource.sizeBytes >= 0) {
      knownBytes += resource.sizeBytes;
    } else {
      // A missing legacy size is unknown, not zero. The R2 Worker must reconcile these objects.
      unknownFileCount += 1;
    }
  });
  return { knownBytes, unknownFileCount, trackedObjectCount: unique.size };
};

const resolveStorageQuota = (data: Record<string, unknown>): {
  defaultQuotaBytes: number;
  allocatedQuotaBytes: number;
  additionalGrantedBytes: number;
} => {
  const storedDefault = typeof data.defaultQuotaBytes === 'number' && Number.isFinite(data.defaultQuotaBytes) && data.defaultQuotaBytes > 0
    ? data.defaultQuotaBytes : undefined;
  const storedExtra = typeof data.additionalGrantedBytes === 'number' && Number.isFinite(data.additionalGrantedBytes) && data.additionalGrantedBytes >= 0
    ? data.additionalGrantedBytes : 0;
  const storedAllocated = typeof data.allocatedQuotaBytes === 'number' && Number.isFinite(data.allocatedQuotaBytes) && data.allocatedQuotaBytes > 0
    ? data.allocatedQuotaBytes : undefined;

  // Older records used 2 GB as their base allowance. Rebase only records whose allocation
  // matches that old base plus the explicitly recorded grants; preserve all other allocations.
  const isLegacyDefault = storedDefault === LEGACY_DEFAULT_STORAGE_QUOTA_BYTES &&
    (storedAllocated === undefined || storedAllocated === LEGACY_DEFAULT_STORAGE_QUOTA_BYTES + storedExtra);
  const defaultQuotaBytes = isLegacyDefault
    ? DEFAULT_STORAGE_QUOTA_BYTES
    : storedDefault ?? DEFAULT_STORAGE_QUOTA_BYTES;
  const allocatedQuotaBytes = isLegacyDefault
    ? defaultQuotaBytes + storedExtra
    : storedAllocated ?? defaultQuotaBytes + storedExtra;
  const additionalGrantedBytes = storedExtra || Math.max(0, allocatedQuotaBytes - defaultQuotaBytes);

  return { defaultQuotaBytes, allocatedQuotaBytes, additionalGrantedBytes };
};

const formatStorageGb = (bytes: number): string => `${(Math.max(0, bytes) / BYTES_PER_GB).toFixed(2)} GB`;
const formatStorageDate = (value: unknown): string => {
  if (!value) return 'Not available';
  try {
    const candidate = value as { toDate?: () => Date; seconds?: number };
    const date = typeof candidate.toDate === 'function'
      ? candidate.toDate()
      : typeof candidate.seconds === 'number'
        ? new Date(candidate.seconds * 1000)
        : value instanceof Date
          ? value
          : new Date(value as string | number);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
  } catch {
    return 'Not available';
  }
};

const getStorageHealth = (usedBytes: number, quotaBytes: number) => {
  const percent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;
  if (percent >= 100) return { percent, label: 'Storage full', tone: 'red' as const };
  if (percent >= 90) return { percent, label: 'Critical capacity', tone: 'red' as const };
  if (percent >= 75) return { percent, label: 'Storage getting low', tone: 'amber' as const };
  return { percent, label: 'Healthy', tone: 'green' as const };
};

const resolveVerifiedTenant = async (user: User): Promise<string> => {
  const email = normalizeEmail(user.email);
  if (!email || !isValidPathSegment(email)) throw new Error('This teacher account does not have a valid email tenant.');
  const authProjectId = auth.app.options.projectId;
  const firestoreProjectId = db.app.options.projectId;
  if (!authProjectId || !firestoreProjectId || authProjectId !== firestoreProjectId) {
    throw new Error('Firebase Auth and Firestore are configured for different projects. Check lib/firebase before continuing.');
  }

  const profileSnap = await getDoc(doc(db, 'users', email));
  if (!profileSnap.exists()) throw new Error('Teacher profile was not found. Access to Notes Library is blocked.');
  const profile = profileSnap.data();
  if (profile.uid !== user.uid || normalizeEmail(profile.email) !== email) {
    throw new Error('Teacher profile ownership could not be verified. Access is blocked.');
  }
  if (profile.role !== 'teacher' || profile.active !== true || profile.disabled === true || profile.deleted === true) {
    throw new Error('This teacher account is not active or is not authorized to access Notes Library.');
  }
  return email;
};

// --- FIXED BOTTOM NAVBAR — MATCH CLASSES PAGE ---
function BottomNavbar() {
  const location = useLocation();

  const navigationTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/' },
    { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/departments' },
    { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
    { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
    { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
  ];

  return (
    <div className="nl-mobile-bottom-nav fixed bottom-0 left-0 right-0 z-40 px-4 pb-4 pt-2 bg-gradient-to-t from-[#f8fafc] via-[#f8fafc]/90 to-transparent dark:from-[#070b13] dark:via-[#070b13]/90">
      <nav className="nl-mobile-bottom-nav__surface mx-auto max-w-md bg-white/80 dark:bg-[#0c1222]/90 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/40 rounded-3xl shadow-[0_15px_35px_-5px_rgba(0,0,0,0.08)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] px-3 py-2 flex items-center justify-between">
        {navigationTabs.map((tab) => {
          const IconComponent = tab.icon;
          const isActive =
            location.pathname === tab.href ||
            (tab.id === 'fees' && location.pathname.includes('/fees'));

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
  );
}

// --- MAIN PAGE COMPONENT ---
export default function NotesLibraryPage() {
  const navigate = useNavigate();
  const { canAccessFeature } = useApp();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [libraries, setLibraries] = useState<ClassLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<ResourceCategory>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [classSearchQuery, setClassSearchQuery] = useState('');
  const [classLoadError, setClassLoadError] = useState<string | null>(null);
  const classSearchInputRef = useRef<HTMLInputElement | null>(null);

  // Modals & States
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isStorageModalOpen, setIsStorageModalOpen] = useState(false);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [storageExtensions, setStorageExtensions] = useState<StorageExtensionRecord[]>([]);
  const [isStorageRequestFormOpen, setIsStorageRequestFormOpen] = useState(false);
  const [selectedExtensionGb, setSelectedExtensionGb] = useState<number | 'custom'>(1);
  const [customExtensionGb, setCustomExtensionGb] = useState('3');
  const [extensionReason, setExtensionReason] = useState('');
  const [extensionSubmitting, setExtensionSubmitting] = useState(false);
  const [extensionRequestMessage, setExtensionRequestMessage] = useState<string | null>(null);
  const [storageReconciling, setStorageReconciling] = useState(false);
  const [previewResource, setPreviewResource] = useState<LibraryResource | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadButtonLabel, setUploadButtonLabel] = useState('');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadValidationStatus, setUploadValidationStatus] = useState<UploadStepStatus>('pending');
  const [uploadFileStatus, setUploadFileStatus] = useState<UploadStepStatus>('pending');
  const [uploadSaveStatus, setUploadSaveStatus] = useState<UploadStepStatus>('pending');
  // A failed/ambiguous attempt retains its ID and R2 object key so a retry can reconcile
  // the same operation instead of creating duplicate resources.
  const pendingUploadAttemptRef = useRef<PendingUploadAttempt | null>(null);

  // Delete, Edit & Toast States
  const [deletingResId, setDeletingResId] = useState<string | null>(null);
  const [editingResource, setEditingResource] = useState<LibraryResource | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState<Exclude<ResourceCategory, 'All'>>('Notes');
  const [editDescription, setEditDescription] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Upload Form Inputs
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<Exclude<ResourceCategory, 'All'>>('Notes');
  const [newDescription, setNewDescription] = useState('');
  const [fileObject, setFileObject] = useState<File | null>(null);
  const currentUploadSignatureRef = useRef('');
  currentUploadSignatureRef.current = fileObject
    ? getUploadFormSignature(
        sanitizeDisplayText(newTitle, 180),
        newCategory,
        newDescription,
        fileObject,
      )
    : '';

  const authGenerationRef = useRef(0);
  const uploadInFlightRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, durationMs = 3000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), durationMs);
  };

  const resetUploadProgress = () => {
    setUploadPercent(0);
    setUploadValidationStatus('pending');
    setUploadFileStatus('pending');
    setUploadSaveStatus('pending');
    setUploadButtonLabel('');
  };

  const openUploadModal = () => {
    if (uploadInFlightRef.current) return;
    resetUploadProgress();
    setIsUploadModalOpen(true);
  };

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  // Auth state is not enough by itself: verify the profile before any class/resource reads.
  useEffect(() => {
    let mounted = true;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const generation = ++authGenerationRef.current;
      setCurrentUser(user);
      // Never carry an unresolved attempt across authenticated teacher identities.
      // Ambiguous objects are intentionally left private rather than reconciled under another tenant.
      pendingUploadAttemptRef.current = null;
      setTenantId(null);
      setLibraries([]);
      setClassLoadError(null);
      setSelectedClassId(null);
      setPreviewResource(null);
      setEditingResource(null);
      setDeletingResId(null);
      setCopiedId(null);
      setStorageSummary(null);
      setStorageExtensions([]);
      setIsStorageModalOpen(false);
      setIsStorageRequestFormOpen(false);
      setStorageError(null);
      setLoading(Boolean(user));

      if (!user) {
        setLoading(false);
        navigate('/login', { replace: true });
        return;
      }

      resolveVerifiedTenant(user).then((verifiedTenant) => {
        if (!mounted || generation !== authGenerationRef.current || auth.currentUser?.uid !== user.uid) return;
        setTenantId(verifiedTenant);
      }).catch(async (error) => {
        if (!mounted || generation !== authGenerationRef.current || auth.currentUser?.uid !== user.uid) return;
        setTenantId(null);
        setLibraries([]);
        setSelectedClassId(null);
        setLoading(false);
        showToast(friendlyError(error, 'verify your teacher profile'));
        // Fail closed. Do not leave an authenticated but unverified identity on this page.
        try { await signOut(auth); } catch { /* The route still has no tenant data or access. */ }
        if (mounted && generation === authGenerationRef.current) navigate('/login', { replace: true });
      });
    });

    return () => {
      mounted = false;
      authGenerationRef.current += 1;
      unsubscribe();
    };
  }, [navigate]);

  // Read only from users/{verified email}/classes and each class's documents subcollection.
  // Query classes in bounded batches to avoid an unbounded burst for teachers with many classes.
  useEffect(() => {
    if (!currentUser) {
      setLibraries([]);
      setLoading(false);
      return;
    }
    if (!tenantId) return; // profile verification is still pending; do not read anything yet.

    let cancelled = false;
    const uid = currentUser.uid;
    setLoading(true);
    setLibraries([]);
    setClassLoadError(null);

    const isStillCurrent = () => !cancelled && auth.currentUser?.uid === uid && tenantId === normalizeEmail(currentUser.email);

    const fetchClasses = async () => {
      try {
        if (auth.app.options.projectId !== db.app.options.projectId) {
          throw new Error('Firebase Auth and Firestore projects do not match.');
        }
        const classesRef = collection(db, 'users', tenantId, 'classes');
        const querySnapshot = await getDocs(classesRef);
        const classDocs = querySnapshot.docs;
        const fetchedClasses: ClassLibrary[] = [];

        for (let offset = 0; offset < classDocs.length; offset += 8) {
          if (!isStillCurrent()) return;
          const batch = classDocs.slice(offset, offset + 8);
          const results = await Promise.all(batch.map(async (classDoc) => {
            const data = classDoc.data();
            const documentsRef = collection(db, 'users', tenantId, 'classes', classDoc.id, 'documents');
            const documentsSnapshot = await getDocs(documentsRef);

            const embeddedResources = readArrayLike(data.resources)
              .map((item, index) => normalizeResource(item, `legacy-${classDoc.id}-${index}`, 'embedded'))
              .filter((item): item is LibraryResource => item !== null);
            const documentResources = documentsSnapshot.docs
              .map((resourceDoc) => normalizeResource({ ...resourceDoc.data(), id: resourceDoc.id }, resourceDoc.id, 'document'))
              .filter((item): item is LibraryResource => item !== null);

            // Deduplicate the legacy embedded array + canonical subcollection by id; the subcollection wins.
            const resourceMap = new Map<string, LibraryResource>();
            embeddedResources.forEach((resource) => resourceMap.set(resource.id, resource));
            documentResources.forEach((resource) => resourceMap.set(resource.id, resource));
            const resources = [...resourceMap.values()];
            const studentsValue = data.students;
            const totalStudents = Array.isArray(studentsValue)
              ? studentsValue.length
              : studentsValue && typeof studentsValue === 'object'
                ? Object.keys(studentsValue).length
                : Number.isFinite(Number(data.totalStudents)) ? Math.max(0, Number(data.totalStudents)) : 0;

            return {
              id: classDoc.id,
              className: sanitizeDisplayText(data.name || data.className || 'Unnamed Class', 180),
              classCode: sanitizeDisplayText(data.code || data.classCode || 'N/A', 80),
              totalStudents,
              bgGradient: typeof data.bgGradient === 'string' ? data.bgGradient : 'from-blue-500/10 to-indigo-500/10 text-blue-600 border-blue-200',
              resources,
            } as ClassLibrary;
          }));
          if (!isStillCurrent()) return;
          fetchedClasses.push(...results);
        }

        fetchedClasses.sort((a, b) => a.className.localeCompare(b.className));
        if (!isStillCurrent()) return;
        setLibraries(fetchedClasses);
        setClassLoadError(null);
        setSelectedClassId((previous) => previous && fetchedClasses.some((cls) => cls.id === previous) ? previous : null);
      } catch (error) {
        if (!isStillCurrent()) return;
        setLibraries([]);
        setSelectedClassId(null);
        setClassLoadError(friendlyError(error, 'load your notes library'));
        showToast(friendlyError(error, 'load your notes library'));
      } finally {
        if (isStillCurrent()) setLoading(false);
      }
    };

    void fetchClasses();
    return () => { cancelled = true; };
  }, [currentUser, tenantId]);

  const currentClass = useMemo(() => {
    return libraries.find((cls) => cls.id === selectedClassId) || null;
  }, [libraries, selectedClassId]);

  const filteredLibraries = useMemo(() => {
    const query = classSearchQuery.trim().toLowerCase();
    if (!query) return libraries;
    return libraries.filter((cls) =>
      cls.className.toLowerCase().includes(query) || cls.classCode.toLowerCase().includes(query),
    );
  }, [libraries, classSearchQuery]);

  const libraryStats = useMemo(() => {
    const resources = libraries.flatMap((cls) => cls.resources);
    return {
      classCount: libraries.length,
      resourceCount: resources.length,
      pdfCount: resources.filter((resource) => resource.fileType === 'pdf').length,
      categoryCount: new Set(resources.map((resource) => resource.category)).size,
    };
  }, [libraries]);

  const storageMetadataUsage = useMemo(() => estimateR2UsageFromLibraries(libraries), [libraries]);

  const filteredResources = useMemo(() => {
    if (!currentClass) return [];
    const query = searchQuery.trim().toLowerCase();
    return currentClass.resources.filter((res) => {
      const matchesCategory = selectedCategory === 'All' || res.category === selectedCategory;
      const matchesSearch = res.title.toLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [currentClass, selectedCategory, searchQuery]);

  const selectedClassIdRef = useRef(selectedClassId);
  selectedClassIdRef.current = selectedClassId;

  const ensureActiveTenant = (expectedUid: string, expectedTenant: string): boolean => {
    return Boolean(auth.currentUser && auth.currentUser.uid === expectedUid && tenantId === expectedTenant && normalizeEmail(currentUser?.email) === expectedTenant);
  };

  const logUploadDiagnostic = (
    stage: UploadStage,
    error: unknown,
    startedAt: number,
    context: { classId?: string; resourceId?: string; extension?: string; sizeBytes?: number; operationStep?: string } = {},
  ) => {
    const firebaseErrorCode = getUploadErrorCode(error) || null;
    const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const errorName = error instanceof Error ? error.name : typeof error;
    const errorStack = error instanceof Error ? error.stack : undefined;
    const step = context.operationStep ?? '';
    const subsystem = stage === 'cleaning-up'
      ? 'cloudflare-r2-cleanup'
      : step.includes('Firestore read') || step.includes('teacher-profile read') || step.includes('class-document read') || step.includes('outcome reconciliation read')
        ? 'firestore-read'
        : stage === 'uploading-to-r2'
          ? 'cloudflare-r2-upload'
          : stage === 'saving-firestore-document'
            ? 'firestore-document-write'
            : stage === 'verifying-save-outcome'
              ? 'firestore-outcome-read'
              : step.includes('configuration') ? 'firebase-configuration-validation' : 'file-validation-or-context';
    console.error('[NotesLibrary upload] Operation failed', {
      stage,
      operationStep: step || null,
      subsystem,
      firebaseErrorCode,
      originalErrorMessage: sanitizeDisplayText(errorMessage, 500),
      errorName,
      errorStack,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      classId: context.classId ?? null,
      resourceId: context.resourceId ?? null,
      fileExtension: context.extension ?? null,
      fileSizeBytes: context.sizeBytes ?? null,
      authProjectId: auth.app.options.projectId ?? null,
      firestoreProjectId: db.app.options.projectId ?? null,
      r2ApiConfigured: Boolean(R2_API_BASE),
    });
  };

  // Cleanup is always background/best-effort. Never let R2 deletion hold the
  // foreground upload button in a Saving state. Ambiguous Firestore outcomes are not
  // cleaned here; those are reconciled by a same-ID retry first.
  const scheduleUnusedR2Cleanup = (attempt: PendingUploadAttempt, startedAt: number) => {
    if (!attempt.fileUploaded) return;
    if (attempt.storedPath !== `resources/${attempt.resourceId}`) {
      const error = new Error('Refusing cleanup because the R2 key does not match the resource ID.');
      logUploadDiagnostic('cleaning-up', error, startedAt, {
        classId: attempt.classId, resourceId: attempt.resourceId,
        extension: attempt.resource.fileName?.split('.').pop(),
        operationStep: 'validate R2 resource key before cleanup',
      });
      showToast('Upload failed. Cleanup was blocked because the R2 key could not be verified.');
      return;
    }

    void (async () => {
      const cleanupStartedAt = Date.now();
      try {
        await deleteR2Object(attempt.resourceId, attempt.classId, attempt.ownerUid);
        console.info('[NotesLibrary upload] Unreferenced R2 object cleaned up', {
          stage: 'cleaning-up', classId: attempt.classId, resourceId: attempt.resourceId,
          elapsedMs: Date.now() - cleanupStartedAt,
        });
      } catch (cleanupError) {
        logUploadDiagnostic('cleaning-up', cleanupError, cleanupStartedAt, {
          classId: attempt.classId, resourceId: attempt.resourceId,
          extension: attempt.resource.fileName?.split('.').pop(),
          operationStep: 'background Cloudflare R2 delete cleanup',
        });
        showToast('The database save failed and the R2 file could not be cleaned up. The file remains inaccessible except through its share ID; retry after checking the connection.');
      }
    })().catch((unexpectedError) => {
      logUploadDiagnostic('cleaning-up', unexpectedError, startedAt, {
        classId: attempt.classId, resourceId: attempt.resourceId,
        operationStep: 'background R2 cleanup rejection guard',
      });
    });
  };

  const handleCopyLink = async (shareUrl: string, id: string) => {
    try {
      const url = new URL(shareUrl);
      if (url.origin !== new URL(R2_API_BASE).origin || !/^\/share\/res-[A-Za-z0-9-]+$/.test(url.pathname)) {
        throw new Error('Invalid resource share link.');
      }
      await navigator.clipboard.writeText(url.toString());
      setCopiedId(id);
      showToast('Share link copied to clipboard!');
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {
      showToast('Could not copy the link. Check browser clipboard permissions.');
    }
  };

  const triggerFileDownload = (url: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = sanitizeFileName(fileName);
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Legacy embedded data remains readable. Newly uploaded files are served by the private R2 bucket through the Worker.
  const handleDownloadResource = async (resource: LibraryResource) => {
    if (!currentUser || !tenantId || !ensureActiveTenant(currentUser.uid, tenantId)) {
      showToast('Please sign in again to access this resource.');
      return;
    }
    try {
      if (resource.fileDataUrl && /^data:[a-zA-Z0-9.+/-]+(?:;[a-zA-Z0-9=+._-]+)*,/i.test(resource.fileDataUrl)) {
        triggerFileDownload(resource.fileDataUrl, resource.fileName || `${resource.title}.pdf`);
        showToast('Download started!');
        return;
      }
      if (resource.storagePath) {
        assertSafeR2Endpoint('download');
        if (!resource.storagePath.startsWith('resources/')) {
          throw new Error('This is an older Firebase Storage file. Re-upload it to Cloudflare R2 before removing the old file service.');
        }
        // The Worker returns the file with a safe Content-Disposition header.
        window.open(`${R2_API_BASE}/share/${encodeURIComponent(resource.id)}`, '_blank', 'noopener,noreferrer');
        showToast('Opening shared file...');
        return;
      }

      const fileContent = `Document Title: ${resource.title}\nCategory: ${resource.category}\n\nNotes:\n${resource.contentPreview || 'No notes provided.'}`;
      const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      triggerFileDownload(url, `${resource.title.replace(/\s+/g, '_')}.txt`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Text file downloaded!');
    } catch (error) {
      showToast(friendlyError(error, 'download this resource'));
    }
  };

  const refreshAuthoritativeStorageSnapshot = async (user: User, expectedTenant: string) => {
    assertSafeR2Endpoint('storage reconciliation');
    if (!ensureActiveTenant(user.uid, expectedTenant) || auth.currentUser?.uid !== user.uid) {
      throw new Error('Your verified teacher session changed. Storage reconciliation was cancelled.');
    }

    const token = await user.getIdToken();
    let response: Response;
    try {
      response = await fetch(`${R2_API_BASE}/api/storage/reconcile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ classIds: libraries.map((item) => item.id) }),
      });
    } catch {
      const frontendOrigin = typeof window !== 'undefined' ? window.location.origin : 'the current frontend origin';
      throw new Error(
        `Could not reach the storage Worker from this website. In Cloudflare Worker Variables, add this exact origin to APP_ORIGINS: ${frontendOrigin}. Also confirm the Worker URL is deployed and reachable. Browser “Failed to fetch” usually indicates a CORS/origin or network problem.`,
      );
    }
    let rawPayload: unknown = {};
    try { rawPayload = await response.json(); } catch { /* Handle non-JSON response below. */ }
    const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : {};

    if (!response.ok || payload.ok !== true) {
      if (response.status === 404) {
        throw new Error('The R2 Worker does not expose POST /api/storage/reconcile yet. No authoritative R2 usage was returned.');
      }
      throw new Error(typeof payload.error === 'string' ? payload.error : `Storage reconciliation failed (${response.status}).`);
    }

    const usedBytes = Number(payload.usedBytes);
    const objectCount = Number(payload.objectCount);
    const defaultQuotaBytes = Number(payload.defaultQuotaBytes);
    const additionalGrantedBytes = Number(payload.additionalGrantedBytes);
    const allocatedQuotaBytes = Number(payload.allocatedQuotaBytes);
    const checkedAt = typeof payload.checkedAt === 'string' ? payload.checkedAt : new Date().toISOString();
    if (!Number.isFinite(usedBytes) || usedBytes < 0 || !Number.isFinite(objectCount) || objectCount < 0 ||
        !Number.isFinite(defaultQuotaBytes) || defaultQuotaBytes <= 0 ||
        !Number.isFinite(allocatedQuotaBytes) || allocatedQuotaBytes <= 0 || payload.usageVerified !== true ||
        payload.usageSource !== 'r2-authoritative') {
      throw new Error('The R2 Worker returned an incomplete or unverified storage snapshot.');
    }
    if (auth.currentUser?.uid !== user.uid || !ensureActiveTenant(user.uid, expectedTenant)) {
      throw new Error('The signed-in teacher changed while storage reconciliation was running.');
    }

    const verifiedSummary: StorageSummary = {
      ownerUid: user.uid,
      defaultQuotaBytes,
      allocatedQuotaBytes,
      usedBytes,
      additionalGrantedBytes: Number.isFinite(additionalGrantedBytes) && additionalGrantedBytes >= 0 ? additionalGrantedBytes : 0,
      knownBytes: usedBytes,
      unknownFileCount: 0,
      usageVerified: true,
      usageSource: 'r2-authoritative',
      trackedObjectCount: Math.floor(objectCount),
      updatedAt: checkedAt,
      lastReconciledAt: checkedAt,
    };
    setStorageSummary(verifiedSummary);
    return verifiedSummary;
  };

  const loadStorageDashboard = async (openModal = true) => {
    if (openModal) setIsStorageModalOpen(true);
    setStorageLoading(true);
    setStorageError(null);
    setExtensionRequestMessage(null);
    const user = auth.currentUser;
    const expectedTenant = tenantId;
    if (!user || !expectedTenant || !ensureActiveTenant(user.uid, expectedTenant)) {
      setStorageLoading(false);
      setStorageError('Your verified teacher session is not available. Please sign in again.');
      return;
    }

    const usageRef = doc(db, 'users', expectedTenant, 'storage', 'usage');
    try {
      // Safe first-time initialization: create only when absent; never overwrite a quota,
      // usage value or grant that already exists. The initial usedBytes value is an unverified
      // placeholder only; the dashboard separately displays metadata-derived known bytes and
      // the trusted Worker must reconcile real R2 objects. Firestore Rules must constrain
      // browser-side creation to this exact 1 GB initial state and forbid client quota/grant updates.
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(usageRef);
        if (existing.exists()) return;
        transaction.set(usageRef, {
          ownerUid: user.uid,
          defaultQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
          allocatedQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
          usedBytes: 0,
          additionalGrantedBytes: 0,
          usageVerified: false,
          usageStatus: 'reconciliation_required',
          usageSource: 'client-init-unverified',
          unknownFileCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          lastReconciledAt: null,
        });
      });

      let usageSnapshot;
      try {
        usageSnapshot = await getDocFromServer(usageRef);
      } catch {
        usageSnapshot = await getDoc(usageRef);
      }
      if (auth.currentUser?.uid !== user.uid || tenantId !== expectedTenant) {
        throw new Error('The signed-in teacher changed while storage details were loading.');
      }
      if (!usageSnapshot.exists()) throw new Error('Storage metadata is not available yet. Refresh and try again.');
      const data = usageSnapshot.data() as Record<string, unknown>;
      if (typeof data.ownerUid === 'string' && data.ownerUid !== user.uid) {
        throw new Error('Storage metadata owner does not match your signed-in account. Access was blocked.');
      }
      const resolvedQuota = resolveStorageQuota(data);
      const defaultQuota = resolvedQuota.defaultQuotaBytes;
      const extraGranted = resolvedQuota.additionalGrantedBytes;
      const persistedQuota = resolvedQuota.allocatedQuotaBytes;
      const recordedUsed = typeof data.usedBytes === 'number' && Number.isFinite(data.usedBytes) && data.usedBytes >= 0
        ? data.usedBytes : 0;
      const usageVerifiedFlag = data.usageVerified === true || data.usageStatus === 'verified' || data.usageSource === 'r2-authoritative';
      // An apparent authoritative value below the sizeBytes sum is contradictory; fail back to
      // a visibly unverified number instead of hiding file metadata behind a lower server value.
      const usageVerified = usageVerifiedFlag && recordedUsed >= storageMetadataUsage.knownBytes;
      const effectiveUsed = Math.max(recordedUsed, storageMetadataUsage.knownBytes);
      const source: StorageUsageSource = usageVerified ? 'verified'
        : typeof data.usedBytes === 'number' ? 'recorded' : 'metadata-estimate';
      setStorageSummary({
        ownerUid: user.uid,
        defaultQuotaBytes: defaultQuota,
        allocatedQuotaBytes: persistedQuota,
        usedBytes: effectiveUsed,
        additionalGrantedBytes: extraGranted,
        knownBytes: storageMetadataUsage.knownBytes,
        unknownFileCount: usageVerified
          ? (typeof data.unknownFileCount === 'number' && data.unknownFileCount >= 0 ? data.unknownFileCount : 0)
          : Math.max(
              storageMetadataUsage.unknownFileCount,
              typeof data.unknownFileCount === 'number' && data.unknownFileCount >= 0 ? data.unknownFileCount : 0,
            ),
        usageVerified,
        usageSource: source,
        updatedAt: data.updatedAt,
        lastReconciledAt: data.lastReconciledAt,
      });

      try {
        const extensionSnapshot = await getDocs(collection(db, 'users', expectedTenant, 'storage', 'usage', 'extensions'));
        const records: StorageExtensionRecord[] = extensionSnapshot.docs.map((snapshot) => {
          const extension = snapshot.data() as Record<string, unknown>;
          return {
            id: snapshot.id,
            requestedGb: typeof extension.requestedGb === 'number' ? extension.requestedGb : 0,
            grantedGb: typeof extension.grantedGb === 'number' ? extension.grantedGb : 0,
            status: typeof extension.status === 'string' ? extension.status : 'unknown',
            previousQuotaBytes: typeof extension.previousQuotaBytes === 'number' ? extension.previousQuotaBytes : undefined,
            newQuotaBytes: typeof extension.newQuotaBytes === 'number' ? extension.newQuotaBytes : null,
            requestDate: extension.requestDate,
            approvalDate: extension.approvalDate,
            reason: typeof extension.reason === 'string' ? extension.reason : '',
          };
        });
        records.sort((a, b) => {
          const dateValue = (value: unknown) => {
            if (!value) return 0;
            const item = value as { toMillis?: () => number; seconds?: number };
            if (typeof item.toMillis === 'function') return item.toMillis();
            if (typeof item.seconds === 'number') return item.seconds * 1000;
            return 0;
          };
          return dateValue(b.requestDate) - dateValue(a.requestDate);
        });
        setStorageExtensions(records.slice(0, 6));
      } catch (historyError) {
        // The storage overview remains useful if security rules temporarily block history reads.
        setStorageExtensions([]);
        console.warn('[Storage dashboard] Could not read extension history', historyError);
      }

      // Display actual R2 inventory for this authenticated teacher; do not trust browser-side byte sums.
      try {
        await refreshAuthoritativeStorageSnapshot(user, expectedTenant);
      } catch (reconcileError) {
        setStorageError(reconcileError instanceof Error
          ? `Live R2 usage could not be verified; the last saved value/metadata estimate is shown. ${reconcileError.message}`
          : 'Live R2 usage could not be verified; the last saved value/metadata estimate is shown.');
      }
    } catch (error) {
      // Keep the modal useful even before the storage document has been provisioned. The
      // metadata-based number is explicitly marked as an estimate, never as verified R2 usage.
      setStorageSummary({
        ownerUid: user.uid,
        defaultQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        allocatedQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        usedBytes: storageMetadataUsage.knownBytes,
        additionalGrantedBytes: 0,
        knownBytes: storageMetadataUsage.knownBytes,
        unknownFileCount: storageMetadataUsage.unknownFileCount,
        usageVerified: false,
        usageSource: 'metadata-estimate',
      });
      setStorageError(error instanceof Error
        ? `${error.message} Storage numbers below are metadata-based estimates until storage access and R2 reconciliation are configured.`
        : 'Storage metadata could not be loaded. Displaying a metadata-based estimate only.');
    } finally {
      setStorageLoading(false);
    }
  };

  const handleOpenStorageDashboard = async () => {
    setIsStorageRequestFormOpen(false);
    await loadStorageDashboard(true);
  };

  const getRequestedExtensionGb = (): number | null => {
    if (selectedExtensionGb !== 'custom') return selectedExtensionGb;
    const value = Number(customExtensionGb);
    // Custom requests are subject to server/admin policy. Reject invalid or unreasonable inputs
    // here for UX, but the trusted backend must validate the policy independently.
    if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
    return value;
  };

  const submitStorageExtensionRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const user = auth.currentUser;
    const expectedTenant = tenantId;
    if (!user || !expectedTenant || !ensureActiveTenant(user.uid, expectedTenant) || !storageSummary) {
      setExtensionRequestMessage('Your verified teacher session is not available. Reload storage details and try again.');
      return;
    }
    const requestedGb = getRequestedExtensionGb();
    if (requestedGb === null) {
      setExtensionRequestMessage('Enter a custom amount greater than 0 GB and no more than 100 GB. Final approval is subject to policy.');
      return;
    }
    setExtensionSubmitting(true);
    setExtensionRequestMessage(null);
    try {
      const extensionCollection = collection(db, 'users', expectedTenant, 'storage', 'usage', 'extensions');
      const extensionRef = doc(extensionCollection);
      await setDoc(extensionRef, {
        ownerUid: user.uid,
        requestedGb,
        requestedBytes: Math.round(requestedGb * BYTES_PER_GB),
        grantedGb: 0,
        status: 'pending',
        previousQuotaBytes: storageSummary.allocatedQuotaBytes,
        // Requests do not grant capacity. newQuotaBytes remains null until an authorized grant.
        newQuotaBytes: null,
        requestDate: serverTimestamp(),
        approvalDate: null,
        reason: sanitizeDisplayText(extensionReason, 1000),
        createdBy: 'teacher-request',
      });
      const submittedMessage = `Your request for +${requestedGb} GB was submitted for approval. Your allocated capacity has not changed.`;
      setExtensionRequestMessage(submittedMessage);
      setExtensionReason('');
      setIsStorageRequestFormOpen(false);
      await loadStorageDashboard(false);
      setExtensionRequestMessage(submittedMessage);
    } catch (error) {
      setExtensionRequestMessage(error instanceof Error
        ? `${error.message} Check that Firestore Rules allow teachers to create pending requests but forbid them from approving requests or changing quota fields.`
        : 'Could not submit the extension request. Please try again.');
    } finally {
      setExtensionSubmitting(false);
    }
  };

  const handleReconcileStorageUsage = async () => {
    const user = auth.currentUser;
    const expectedTenant = tenantId;
    if (!user || !expectedTenant || !ensureActiveTenant(user.uid, expectedTenant)) {
      setStorageError('Please sign in again before reconciling storage.');
      return;
    }
    setStorageReconciling(true);
    setStorageError(null);
    try {
      const snapshot = await refreshAuthoritativeStorageSnapshot(user, expectedTenant);
      showToast(
        `Storage Usage Verified: ${snapshot.trackedObjectCount ?? 0} file(s) owned by this teacher account; ${formatStorageGb(snapshot.usedBytes)} used.`,
      );
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Could not verify R2 storage usage.');
    } finally {
      setStorageReconciling(false);
    }
  };

  const checkStorageCapacityBeforeUpload = async (newFileBytes: number, expectedTenant: string, expectedUid: string) => {
    if (auth.currentUser?.uid !== expectedUid || tenantId !== expectedTenant) {
      throw new Error('Your teacher session changed. Please sign in again.');
    }
    let allocation = storageSummary?.allocatedQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
    let recorded = storageSummary?.usedBytes ?? 0;
    try {
      const usageRef = doc(db, 'users', expectedTenant, 'storage', 'usage');
      const snapshot = await getDocFromServer(usageRef);
      if (snapshot.exists()) {
        const data = snapshot.data() as Record<string, unknown>;
        if (typeof data.ownerUid === 'string' && data.ownerUid !== expectedUid) {
          throw new Error('Storage metadata owner mismatch. Upload is blocked.');
        }
        const resolvedQuota = resolveStorageQuota(data);
        allocation = resolvedQuota.allocatedQuotaBytes;
        recorded = typeof data.usedBytes === 'number' && Number.isFinite(data.usedBytes) && data.usedBytes >= 0 ? data.usedBytes : 0;
      }
    } catch (error) {
      if (error instanceof Error && /owner mismatch|session changed/i.test(error.message)) throw error;
      // Existing upload behavior is preserved while the dashboard/backend is being provisioned.
      // This fallback is a UX preflight only; the R2 Worker must enforce the limit authoritatively.
      console.warn('[Storage preflight] Could not read usage metadata; Worker-side enforcement is required.', error);
    }
    const usageFloor = Math.max(recorded, storageMetadataUsage.knownBytes);
    if (usageFloor + newFileBytes > allocation) {
      throw new Error(`Not enough available storage for this file. Used or known usage: ${formatStorageGb(usageFloor)} of ${formatStorageGb(allocation)}. Open Storage Details to request an extension.`);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (uploadInFlightRef.current) return;

    const title = sanitizeDisplayText(newTitle, 180);
    if (!title || !selectedClassId || !currentClass || !currentUser || !tenantId) {
      showToast('Select a class and enter a valid title before uploading.');
      return;
    }
    if (!fileObject) {
      showToast('Choose a file before uploading.');
      return;
    }

    const operationStartedAt = Date.now();
    const operationUser = currentUser;
    const operationUid = currentUser.uid;
    const operationTenant = tenantId;
    const operationClassId = selectedClassId;
    const operationFile = fileObject;
    const formSignature = getUploadFormSignature(title, newCategory, newDescription, operationFile);
    // Track stage through a mutable cell so TypeScript correctly observes updates
    // performed by setStage() when the catch handler classifies a failure.
    const stageTracker: { current: UploadStage } = { current: 'validating' };
    let operationStep = 'Validate selected file extension, MIME type and size';
    let fileInfo: ReturnType<typeof validateUploadFile> | null = null;
    let attempt: PendingUploadAttempt | null = null;
    let documentSaved = false;

    const setStage = (nextStage: UploadStage, buttonLabel: string) => {
      stageTracker.current = nextStage;
      setUploadButtonLabel(buttonLabel);
      if (nextStage === 'uploading-to-r2') setUploadFileStatus('active');
      if (nextStage === 'saving-firestore-document' || nextStage === 'verifying-save-outcome') {
        setUploadSaveStatus('active');
      }
      if (nextStage === 'completed') {
        setUploadPercent(100);
        setUploadValidationStatus('done');
        setUploadFileStatus('done');
        setUploadSaveStatus('done');
      }
    };

    const contextIsStillActive = (classId = operationClassId) => Boolean(
      auth.currentUser?.uid === operationUid &&
      auth.currentUser?.email === operationUser.email &&
      ensureActiveTenant(operationUid, operationTenant) &&
      selectedClassIdRef.current === classId
    );

    const resourceMatchesAttempt = (raw: Record<string, unknown>, pending: PendingUploadAttempt) =>
      raw.id === pending.resourceId && raw.storagePath === pending.storedPath;

    const publishSavedResource = (savedAttempt: PendingUploadAttempt, clearFormWhenMatching: boolean) => {
      if (contextIsStillActive(savedAttempt.classId)) {
        setLibraries((previous) => previous.map((cls) => cls.id === savedAttempt.classId
          ? { ...cls, resources: [savedAttempt.resource, ...cls.resources.filter((resource) => resource.id !== savedAttempt.resourceId)] }
          : cls));
      }
      if (pendingUploadAttemptRef.current?.resourceId === savedAttempt.resourceId) {
        pendingUploadAttemptRef.current = null;
      }
      if (clearFormWhenMatching && currentUploadSignatureRef.current === savedAttempt.formSignature) {
        setNewTitle('');
        setNewDescription('');
        setFileObject(null);
        setIsUploadModalOpen(false);
      }
      // The endpoint is idempotent by class + resource ID. Late Firestore acknowledgements
      // and same-ID recovery may call this publication helper more than once, but they can
      // never create a second WhatsApp dispatch for the same saved resource.
      if (canAccessFeature('library_link_whatsapp')) {
        void (async () => {
          try {
            const signedInUser = auth.currentUser;
            if (!signedInUser || signedInUser.uid !== savedAttempt.ownerUid) return;
            const token = await signedInUser.getIdToken();
            const response = await fetch('/api/teacher/library-links/dispatch', {
              method: 'POST', cache: 'no-store',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ classId: savedAttempt.classId, resourceId: savedAttempt.resourceId }),
            });
            const payload = await response.json().catch(() => null) as { error?: string; acceptedCount?: number; message?: string } | null;
            if (!response.ok) {
              // A blocked/unconfigured dispatcher does not undo a successfully saved resource,
              // but the teacher must be told that the WhatsApp share did not happen.
              const reason = payload?.error || `HTTP ${response.status}`;
              showToast(`Resource saved. Library Link WhatsApp was not sent: ${reason}`, 9000);
              console.warn('[NotesLibrary] Resource saved, but Library Link WhatsApp dispatch was not completed.', response.status);
              return;
            }
            if (payload?.acceptedCount && payload.acceptedCount > 0) {
              showToast(`${payload.acceptedCount} resource-link messages accepted by provider; delivery is not confirmed.`, 7000);
            } else if (payload?.message) {
              showToast(payload.message, 7000);
            }
          } catch (dispatchError) {
            const reason = dispatchError instanceof Error ? dispatchError.message : 'Network error';
            showToast(`Resource saved. WhatsApp link sharing could not be confirmed: ${reason}`, 9000);
            console.warn('[NotesLibrary] Resource saved, but Library Link WhatsApp dispatch could not be reached.', dispatchError instanceof Error ? dispatchError.name : 'UnknownError');
          }
        })();
      }
    };

    if (!contextIsStillActive()) {
      showToast('Your teacher session or selected class changed. Please verify the class and try again.');
      return;
    }

    uploadInFlightRef.current = true;
    setIsUploading(true);
    setUploadPercent(0);
    setUploadValidationStatus('active');
    setUploadFileStatus('pending');
    setUploadSaveStatus('pending');

    try {
      setStage('validating', 'Validating file...');
      operationStep = 'Validate selected file extension, MIME type and size';
      fileInfo = validateUploadFile(operationFile);
      setUploadValidationStatus('done');

      // Firebase remains responsible for Auth and Firestore metadata; file bytes go to the R2 Worker.
      operationStep = 'Validate shared Firebase project and Cloudflare R2 API configuration';
      const authProjectId = auth.app.options.projectId;
      const firestoreProjectId = db.app.options.projectId;
      if (!authProjectId || authProjectId !== firestoreProjectId) {
        throw new Error('Firebase Auth and Firestore are not configured for the same project. Check lib/firebase.');
      }
      if (!R2_API_BASE || !R2_API_BASE.startsWith('https://')) {
        throw new Error('Cloudflare R2 API URL is missing or invalid. Set VITE_R2_API_URL to your Worker URL.');
      }
      if (!contextIsStillActive()) throw new Error('UPLOAD_CONTEXT_CHANGED');

      // Revalidate profile ownership and class existence on the tenant-owned paths.
      operationStep = 'teacher-profile read and ownership verification';
      const verifiedTenant = await resolveVerifiedTenant(operationUser);
      if (verifiedTenant !== operationTenant || !contextIsStillActive()) throw new Error('UPLOAD_CONTEXT_CHANGED');
      operationStep = 'class-document read and existence verification';
      const classSnapshot = await getDoc(doc(db, 'users', operationTenant, 'classes', operationClassId));
      if (!classSnapshot.exists()) throw new Error('The selected class no longer exists. Refresh the class list and retry.');
      if (!contextIsStillActive()) throw new Error('UPLOAD_CONTEXT_CHANGED');

      let pending = pendingUploadAttemptRef.current;
      if (pending) {
        const belongsToCurrentOperation = pending.ownerUid === operationUid &&
          pending.tenantId === operationTenant && pending.classId === operationClassId;
        const sameForm = belongsToCurrentOperation && pending.formSignature === formSignature;

        if (!sameForm) {
          // Before permitting a new resource ID, verify whether the earlier uncertain write
          // actually committed. A server-confirmed absence makes its unique R2 object key safe
          // for background cleanup; a failed read never triggers deletion.
          setStage('verifying-save-outcome', 'Verifying previous upload...');
          operationStep = 'outcome reconciliation read for prior uncertain upload';
          const previousRef = doc(db, 'users', pending.tenantId, 'classes', pending.classId, 'documents', pending.resourceId);
          const priorSnapshot = await getDocFromServer(previousRef);
          if (priorSnapshot.exists()) {
            const priorRaw = priorSnapshot.data() as Record<string, unknown>;
            if (!resourceMatchesAttempt(priorRaw, pending)) {
              throw new Error('A previous resource ID exists with different metadata. No upload was overwritten; refresh the library before retrying.');
            }
            const recoveredAttempt = pending;
            publishSavedResource(recoveredAttempt, false);
            setStage('completed', 'Previous upload confirmed');
            showToast('The previous upload is confirmed in Firestore. Your current form has been kept; submit again to upload its changed details.');
            return;
          }

          const unreferencedAttempt = pending;
          pendingUploadAttemptRef.current = null;
          attempt = null;
          // A server read showing "absent" does not prove a still-pending setDoc() will never
          // commit. Only delete the object when no write for it can still land; otherwise leave
          // it private rather than risk orphaning a committed document.
          if (unreferencedAttempt.fileUploaded && !unreferencedAttempt.writeInFlight) {
            scheduleUnusedR2Cleanup(unreferencedAttempt, operationStartedAt);
          }
          pending = null;
        } else {
          attempt = pending;
          if (pending.metadataUncertain) {
            setStage('verifying-save-outcome', 'Verifying previous save...');
            operationStep = 'outcome reconciliation read for same-ID retry';
            // Read the authoritative tenant-scoped document before retrying the same ID.
            const tenantScopedRef = doc(db, 'users', operationTenant, 'classes', operationClassId, 'documents', pending.resourceId);
            const previousSnapshot = await getDocFromServer(tenantScopedRef);
            if (previousSnapshot.exists()) {
              const previousRaw = previousSnapshot.data() as Record<string, unknown>;
              if (!resourceMatchesAttempt(previousRaw, pending)) {
                throw new Error('The previous resource ID exists but its R2 object key does not match. No existing record was overwritten.');
              }
              publishSavedResource(pending, true);
              setStage('completed', 'Upload confirmed');
              showToast(UPLOAD_SUCCESS_MESSAGE);
              return;
            }
            // Confirmed absent: reuse the same ID/path for an idempotent retry.
            pending.metadataUncertain = false;
          }
        }
      }

      if (!attempt) {
        const resourceId = makeResourceId();
        const cleanFileName = sanitizeFileName(operationFile.name);
        const storedPath = `resources/${resourceId}`;
        const resource: LibraryResource = {
          id: resourceId,
          title,
          category: newCategory,
          fileType: fileInfo.fileType,
          fileName: cleanFileName,
          fileSize: `${(operationFile.size / (1024 * 1024)).toFixed(2)} MB`,
          sizeBytes: operationFile.size,
          storagePath: storedPath,
          uploadDate: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
          shareUrl: makeShareUrl(resourceId),
          contentPreview: sanitizeDisplayText(newDescription || 'Uploaded study material/CV for students.', 5000),
          _source: 'document',
        };
        attempt = {
          ownerUid: operationUid,
          tenantId: operationTenant,
          classId: operationClassId,
          formSignature,
          resourceId,
          storedPath,
          resource,
          fileUploaded: false,
          firestoreWriteAttempted: false,
          metadataUncertain: false,
          writeInFlight: false,
        };
        pendingUploadAttemptRef.current = attempt;
      }

      if (!contextIsStillActive(attempt.classId)) throw new Error('UPLOAD_CONTEXT_CHANGED');

      if (!attempt.fileUploaded) {
        operationStep = 'preflight teacher storage capacity';
        await checkStorageCapacityBeforeUpload(operationFile.size, operationTenant, operationUid);
        operationStep = 'multipart upload to Cloudflare R2 Worker';
        setUploadPercent(0);
        setStage('uploading-to-r2', 'Uploading 0%...');
        await uploadFileToR2(
          attempt.resourceId,
          operationUser,
          operationClassId,
          title,
          newCategory,
          operationFile,
          (percent) => {
            setUploadPercent(percent);
            setUploadButtonLabel(`Uploading ${percent}%...`);
          },
        );
        attempt.fileUploaded = true;
        setUploadPercent(100);
        setUploadFileStatus('done');
      } else {
        // The same resource ID is reused when reconciling an uncertain Firestore write.
        setUploadPercent(100);
        setUploadFileStatus('done');
      }

      operationStep = 'revalidate teacher session and selected class before Firestore write';
      setStage('validating', 'Verifying teacher session...');
      if (!contextIsStillActive(attempt.classId)) throw new Error('UPLOAD_CONTEXT_CHANGED');

      const destinationDocRef = doc(db, 'users', operationTenant, 'classes', operationClassId, 'documents', attempt.resourceId);
      const storedResource: Record<string, unknown> = { ...attempt.resource };
      delete storedResource._source;

      operationStep = 'setDoc resource metadata document';
      setStage('saving-firestore-document', 'Saving to Database...');
      attempt.firestoreWriteAttempted = true;
      attempt.metadataUncertain = true;
      attempt.writeInFlight = true;

      // setDoc() settles only on SERVER acknowledgement. Start it once, observe it with
      // handlers that outlive this function, and bound only how long the foreground UI waits.
      const writingAttempt = attempt;
      const writePromise = setDoc(destinationDocRef, storedResource);
      writePromise.then(() => { writingAttempt.writeInFlight = false; }, () => { writingAttempt.writeInFlight = false; });

      const slowHintTimer = setTimeout(() => setUploadButtonLabel('Waiting for database...'), FIRESTORE_SLOW_HINT_MS);
      let ackTimer: ReturnType<typeof setTimeout> | undefined;
      let ackOutcome: 'acked' | 'timeout';
      try {
        ackOutcome = await new Promise<'acked' | 'timeout'>((resolve, reject) => {
          ackTimer = setTimeout(() => resolve('timeout'), FIRESTORE_ACK_WAIT_MS);
          writePromise.then(() => resolve('acked'), reject);
        });
      } finally {
        clearTimeout(slowHintTimer);
        if (ackTimer) clearTimeout(ackTimer);
      }

      if (ackOutcome === 'timeout') {
        // Outcome unknown: do NOT report failure or success and do NOT delete the R2 object.
        // Keep the same ID/path; a late acknowledgement or a later same-ID retry reconciles it.
        logUploadDiagnostic('saving-firestore-document',
          new Error(`Firestore did not acknowledge setDoc within ${FIRESTORE_ACK_WAIT_MS} ms`),
          operationStartedAt, {
            classId: operationClassId, resourceId: writingAttempt.resourceId, extension: fileInfo?.extension,
            sizeBytes: operationFile.size, operationStep: 'setDoc acknowledgement wait elapsed (write still pending)',
          });
        writingAttempt.metadataUncertain = true;
        pendingUploadAttemptRef.current = writingAttempt;

        writePromise.then(() => {
          // Late server confirmation: the document is committed, so finish the job once.
          writingAttempt.metadataUncertain = false;
          setUploadPercent(100);
          setUploadValidationStatus('done');
          setUploadFileStatus('done');
          setUploadSaveStatus('done');
          const stillPending = pendingUploadAttemptRef.current?.resourceId === writingAttempt.resourceId;
          if (contextIsStillActive(writingAttempt.classId)) {
            setLibraries((previous) => previous.map((cls) => cls.id === writingAttempt.classId
              ? { ...cls, resources: [writingAttempt.resource, ...cls.resources.filter((resource) => resource.id !== writingAttempt.resourceId)] }
              : cls));
          }
          if (stillPending) {
            publishSavedResource(writingAttempt, true);
            showToast(UPLOAD_SUCCESS_MESSAGE);
          }
        }, (lateError) => {
          logUploadDiagnostic('saving-firestore-document', lateError, operationStartedAt, {
            classId: operationClassId, resourceId: writingAttempt.resourceId, extension: fileInfo?.extension,
            sizeBytes: operationFile.size, operationStep: 'setDoc late rejection after acknowledgement wait',
          });
          const lateCode = getUploadErrorCode(lateError);
          if (['permission-denied', 'unauthenticated', 'invalid-argument'].includes(lateCode)) {
            // Definite server rejection: no document references the file, so cleanup is safe.
            if (pendingUploadAttemptRef.current?.resourceId === writingAttempt.resourceId) {
              pendingUploadAttemptRef.current = null;
              scheduleUnusedR2Cleanup(writingAttempt, operationStartedAt);
              showToast(friendlyError(lateError, 'save this resource in Firestore'), 6000);
            }
          }
          // Any other late error stays uncertain; the attempt is kept for same-ID reconciliation.
        });

        setStage('verifying-save-outcome', 'Save pending');
        showToast('The database has not confirmed the save yet. Your upload is kept and will finish automatically if the connection recovers, or press Save again to reconcile it without creating a duplicate.', 9000);
        return;
      }

      documentSaved = true;
      attempt.metadataUncertain = false;
      setUploadSaveStatus('done');
      setUploadPercent(100);

      // Confirmed by the server: upsert into the right class, clear the form only if it still
      // matches this upload, close the modal, and notify exactly once.
      publishSavedResource(attempt, true);
      setStage('completed', 'Upload complete');
      showToast(UPLOAD_SUCCESS_MESSAGE);
    } catch (error) {
      const failureStage = stageTracker.current;
      if (failureStage === 'validating' && !fileInfo) {
        setUploadValidationStatus('error');
      } else if (failureStage === 'uploading-to-r2' || (failureStage === 'validating' && !attempt?.fileUploaded)) {
        setUploadFileStatus('error');
      } else if (failureStage === 'saving-firestore-document' || failureStage === 'verifying-save-outcome' || (failureStage === 'validating' && attempt?.fileUploaded)) {
        setUploadSaveStatus('error');
      }
      logUploadDiagnostic(failureStage, error, operationStartedAt, {
        classId: operationClassId,
        resourceId: attempt?.resourceId,
        extension: fileInfo?.extension ?? operationFile.name.split('.').pop()?.toLowerCase(),
        sizeBytes: operationFile.size,
        operationStep,
      });

      if (attempt) {
        const code = getUploadErrorCode(error);
        const definiteFirestoreRejection = failureStage === 'saving-firestore-document' &&
          ['permission-denied', 'unauthenticated', 'invalid-argument'].includes(code);
        const writeNeverStarted = !attempt.firestoreWriteAttempted;
        const sameAuthenticatedOwner = auth.currentUser?.uid === operationUid && auth.currentUser?.email === operationUser.email;

        if (!sameAuthenticatedOwner) {
          // Never attach an earlier teacher's pending operation to a new signed-in identity.
          if (pendingUploadAttemptRef.current?.resourceId === attempt.resourceId) pendingUploadAttemptRef.current = null;
          if (attempt.fileUploaded && writeNeverStarted) scheduleUnusedR2Cleanup(attempt, operationStartedAt);
          // If Firestore may have committed, preserve the object rather than risk deleting a referenced file.
        } else if (attempt.fileUploaded && (writeNeverStarted || definiteFirestoreRejection)) {
          // No metadata write was attempted, or Firestore explicitly rejected it. It is safe
          // to clean this unique path asynchronously; cleanup never blocks the visible button.
          pendingUploadAttemptRef.current = null;
          scheduleUnusedR2Cleanup(attempt, operationStartedAt);
        } else {
          // For unavailable/deadline/unknown acknowledgement failures, never delete the R2 object.
          // Keep the same ID/path so the next submit can verify the document or safely retry it.
          attempt.metadataUncertain = attempt.firestoreWriteAttempted;
          pendingUploadAttemptRef.current = attempt;
        }
      }

      if ((failureStage === 'saving-firestore-document' || failureStage === 'verifying-save-outcome') && attempt?.firestoreWriteAttempted && !documentSaved && !['permission-denied', 'unauthenticated', 'invalid-argument'].includes(getUploadErrorCode(error))) {
        showToast('Could not confirm the database acknowledgement. Your upload details are kept safely; retry the same upload to reconcile it without creating a duplicate.');
      } else if (error instanceof Error && error.message === UPLOAD_CONTEXT_CHANGED) {
        showToast('Your teacher session or selected class changed during the upload. Your form is kept; verify the class and try again.', 6000);
      } else {
        showToast(error instanceof Error && !('code' in error) ? error.message : friendlyError(error, failureStage === 'uploading-to-r2' ? 'upload this file to Cloudflare R2' : failureStage === 'saving-firestore-document' ? 'save this resource in Firestore' : 'prepare this upload'), 6000);
      }
    } finally {
      uploadInFlightRef.current = false;
      setIsUploading(false);
      setUploadButtonLabel('');
    }
  };

  const handleOpenEdit = (res: LibraryResource) => {
    setEditingResource(res);
    setEditTitle(res.title);
    setEditCategory(res.category);
    setEditDescription(res.contentPreview || '');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingResource || !selectedClassId || !currentClass || !currentUser || !tenantId) return;
    const title = sanitizeDisplayText(editTitle, 180);
    if (!title) { showToast('Enter a valid resource title.'); return; }
    if (!VALID_CATEGORIES.has(editCategory)) { showToast('Choose a valid category.'); return; }
    const operationUid = currentUser.uid;
    const operationTenant = tenantId;
    const classId = selectedClassId;
    const resourceId = editingResource.id;
    if (!ensureActiveTenant(operationUid, operationTenant)) { showToast('Your teacher session changed. Please sign in again.'); return; }
    setIsSavingEdit(true);

    const updatedData = {
      title,
      category: editCategory,
      contentPreview: sanitizeDisplayText(editDescription, 5000),
    };

    try {
      if (editingResource._source === 'embedded') {
        const classRef = doc(db, 'users', operationTenant, 'classes', classId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(classRef);
          if (!snap.exists()) throw new Error('This class no longer exists.');
          const currentResources = snap.data().resources;
          if (!Array.isArray(currentResources)) throw new Error('The legacy resources field is malformed; no changes were saved.');
          const index = currentResources.findIndex((item: unknown) => isUnknownRecord(item) && String(item.id ?? '') === resourceId);
          if (index < 0) throw new Error('This legacy resource no longer exists. Refresh the library.');
          const nextResources = currentResources.map((item: unknown, idx: number) => idx === index && isUnknownRecord(item) ? { ...item, ...updatedData } : item);
          transaction.update(classRef, { resources: nextResources });
        });
      } else {
        const resourceRef = doc(db, 'users', operationTenant, 'classes', classId, 'documents', resourceId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(resourceRef);
          if (!snap.exists()) throw new Error('This resource no longer exists. Refresh the library.');
          transaction.update(resourceRef, updatedData);
        });
      }

      if (ensureActiveTenant(operationUid, operationTenant)) {
        setLibraries((prev) => prev.map((cls) => cls.id === classId
          ? { ...cls, resources: cls.resources.map((r) => r.id === resourceId ? { ...r, ...updatedData } : r) }
          : cls));
        setEditingResource(null);
        showToast('Document updated successfully!');
      }
    } catch (error) {
      showToast(error instanceof Error && !('code' in error) ? error.message : friendlyError(error, 'update this resource'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const confirmDeleteResource = async () => {
    if (!deletingResId || !selectedClassId || !currentClass || !currentUser || !tenantId) return;
    const operationUid = currentUser.uid;
    const operationTenant = tenantId;
    const classId = selectedClassId;
    const resourceId = deletingResId;
    const resource = currentClass.resources.find((item) => item.id === resourceId);
    if (!resource) { setDeletingResId(null); showToast('Resource was not found. Refresh the library.'); return; }
    if (!ensureActiveTenant(operationUid, operationTenant)) { showToast('Your teacher session changed. Please sign in again.'); return; }

    try {
      if (resource._source === 'embedded') {
        const classRef = doc(db, 'users', operationTenant, 'classes', classId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(classRef);
          if (!snap.exists()) throw new Error('This class no longer exists.');
          const currentResources = snap.data().resources;
          if (!Array.isArray(currentResources)) throw new Error('The legacy resources field is malformed; no changes were made.');
          const hasResource = currentResources.some((item: unknown) => isUnknownRecord(item) && String(item.id ?? '') === resourceId);
          if (!hasResource) throw new Error('This legacy resource no longer exists. Refresh the library.');
          transaction.update(classRef, { resources: currentResources.filter((item: unknown) => !isUnknownRecord(item) || String(item.id ?? '') !== resourceId) });
        });
      } else {
        const resourceRef = doc(db, 'users', operationTenant, 'classes', classId, 'documents', resourceId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(resourceRef);
          if (!snap.exists()) throw new Error('This resource no longer exists. Refresh the library.');
          transaction.delete(resourceRef);
        });
      }

      let cleanupWarning = false;
      if (resource.storagePath?.startsWith('resources/')) {
        try { await deleteR2Object(resourceId, classId, operationUid); }
        catch { cleanupWarning = true; } // Firestore deletion succeeded; file cleanup can be retried.
      } else if (resource.storagePath) {
        // Do not call Firebase Storage after migration; legacy objects need a separate migration/re-upload.
        cleanupWarning = true;
      }

      if (ensureActiveTenant(operationUid, operationTenant)) {
        setLibraries((prev) => prev.map((cls) => cls.id === classId
          ? { ...cls, resources: cls.resources.filter((item) => item.id !== resourceId) }
          : cls));
        showToast(cleanupWarning ? 'Resource deleted, but its stored file needs cleanup.' : 'Document deleted successfully!');
      }
    } catch (error) {
      showToast(error instanceof Error && !('code' in error) ? error.message : friendlyError(error, 'delete this resource'));
    } finally {
      setDeletingResId(null);
    }
  };

  return (
    <div className={`notes-library-page min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-32 ${isDark ? 'dark' : ''}`}>

      {/* TOAST NOTIFICATION POPUP */}
      {toastMessage && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[100] max-w-[min(92vw,42rem)] bg-slate-900/95 dark:bg-orange-500/95 text-white border border-orange-500/50 px-4 py-3 rounded-2xl shadow-[0_0_24px_rgba(249,115,22,0.45)] backdrop-blur-xl flex items-center gap-2 text-xs font-black animate-in fade-in slide-in-from-top-4 duration-300">
          <Sparkles className="h-4 w-4 text-yellow-300 animate-pulse" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* TOP HEADER */}
      <div className="nl-page-header w-full bg-white/80 dark:bg-[#070b13]/80 backdrop-blur-md sticky top-0 z-40 border-b border-slate-200/50 dark:border-slate-800/50 shadow-sm">
        <div className="nl-page-header__inner mx-auto w-full max-w-[1440px] px-4 sm:px-6 xl:px-10 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {selectedClassId ? (
              <button
                onClick={() => setSelectedClassId(null)}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition-all shadow-sm"
                title="Back to All Classes"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : (
              <button
                onClick={() => navigate('/')}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition-all shadow-sm"
                title="Back to Dashboard"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
                {selectedClassId ? currentClass?.className : 'Notes & Library'}
              </h1>
              <p className="text-[10px] font-bold text-slate-400">
                {selectedClassId ? `Code: ${currentClass?.classCode}` : 'Select a class to view or upload materials'}
              </p>
            </div>
          </div>

          <div className="nl-page-header__actions flex items-center gap-2">
            {selectedClassId && (
              <button
                onClick={openUploadModal}
                className="bg-orange-500 text-white hover:bg-orange-600 px-3 py-1.5 rounded-2xl text-xs font-black flex items-center gap-1.5 shadow-[0_0_15px_rgba(249,115,22,0.4)] transition-all active:scale-95"
              >
                <Plus className="h-4 w-4" /> Upload
              </button>
            )}

            <button
              type="button"
              onClick={handleOpenStorageDashboard}
              aria-label="Storage Details"
              title="Storage Details"
              disabled={!tenantId || storageLoading}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-200 bg-gradient-to-r from-violet-600 to-indigo-600 px-2 sm:px-3 py-2 text-[9px] sm:text-[10px] font-black text-white shadow-md shadow-violet-500/20 transition-all hover:from-violet-500 hover:to-indigo-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <HardDrive className="h-3.5 w-3.5 shrink-0" />
              <span className="nl-storage-label">Storage Details</span>
            </button>

            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/60 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/30"
            >
              <div className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-sm transition-all ${isDark ? 'translate-x-5 bg-slate-950 text-yellow-400' : ''}`}>
                {isDark ? <Moon className="h-3 w-3 fill-current" /> : <Sun className="h-3 w-3 fill-current" />}
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTAINER */}
      <main className="nl-page-main mx-auto w-full max-w-[1440px] px-4 sm:px-6 xl:px-10 py-5 lg:py-7 space-y-6 relative">
        
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mb-4"></div>
            <p className="text-sm font-bold">Fetching classes from Database...</p>
          </div>
        ) : (
          <>
            {/* SCREEN 1: ALL CLASSES GRID */}
            {!selectedClassId && (
              <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 motion-reduce:animate-none motion-reduce:transition-none">
                {/* Premium, compact library hero */}
                <section className="nl-library-hero relative overflow-hidden rounded-3xl border border-orange-200/80 dark:border-orange-500/25 bg-gradient-to-br from-white via-orange-50/80 to-amber-100/70 dark:from-[#0c1222] dark:via-[#11172a] dark:to-amber-950/30 p-4 sm:p-5 shadow-[0_12px_34px_-22px_rgba(249,115,22,0.55)] transition-shadow duration-300 hover:shadow-[0_16px_38px_-20px_rgba(249,115,22,0.55)] motion-reduce:transition-none">
                  <div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-orange-400/15 blur-3xl pointer-events-none" />
                  <div className="absolute -bottom-12 right-24 h-28 w-28 rounded-full bg-blue-400/10 blur-3xl pointer-events-none" />
                  <div className="nl-library-hero__content relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div className="flex items-center justify-between gap-3 sm:justify-start">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="h-11 w-11 shrink-0 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-400 text-white flex items-center justify-center shadow-lg shadow-orange-500/20 ring-1 ring-white/70 dark:ring-white/10">
                            <BookOpen className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-600 dark:text-orange-400">EduTrack • Learning Resources</p>
                            <h2 className="text-lg sm:text-xl font-black tracking-tight text-slate-900 dark:text-white">Digital Library</h2>
                          </div>
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200/80 dark:border-emerald-500/20 bg-emerald-50/90 dark:bg-emerald-500/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" /> Live Engine
                        </span>
                      </div>
                      <p className="max-w-xl text-xs sm:text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        Keep class notes, textbooks, PDFs, assignments, CVs and past papers organized in one place, ready to preview and share with students.
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            const targetClass = filteredLibraries[0];
                            if (targetClass) {
                              setSelectedClassId(targetClass.id);
                              setSelectedCategory('All');
                              setSearchQuery('');
                            } else {
                              classSearchInputRef.current?.focus();
                            }
                          }}
                          className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-3.5 py-2 text-[11px] font-black text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 motion-reduce:transition-none"
                        >
                          {filteredLibraries.length ? 'Open a Class Library' : 'Find a Class'}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{libraryStats.resourceCount} saved {libraryStats.resourceCount === 1 ? 'resource' : 'resources'} across your classes</span>
                      </div>
                    </div>
                    <div className="hidden sm:flex shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border border-white/80 dark:border-white/10 bg-white/65 dark:bg-slate-950/20 px-5 py-4 text-center shadow-sm backdrop-blur-sm">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/10">
                        <Folder className="h-6 w-6" />
                      </div>
                      <span className="text-[9px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400">Class libraries</span>
                      <span className="text-xl font-black leading-none text-slate-900 dark:text-white">{libraryStats.classCount}</span>
                    </div>
                  </div>
                </section>

                {/* Live metrics are derived only from the already-loaded data. */}
                <div className="nl-library-metrics grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="rounded-2xl border border-blue-100 dark:border-blue-500/15 bg-white dark:bg-[#0c1222] p-3.5 shadow-sm transition-all hover:border-blue-200 dark:hover:border-blue-500/30">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400"><Folder className="h-4 w-4" /><span className="text-[10px] font-bold">Available Classes</span></div>
                    <p className="mt-2 text-xl font-black tabular-nums text-slate-900 dark:text-white">{libraryStats.classCount}</p>
                  </div>
                  <div className="rounded-2xl border border-orange-100 dark:border-orange-500/15 bg-white dark:bg-[#0c1222] p-3.5 shadow-sm transition-all hover:border-orange-200 dark:hover:border-orange-500/30">
                    <div className="flex items-center gap-2 text-orange-600 dark:text-orange-400"><BookOpen className="h-4 w-4" /><span className="text-[10px] font-bold">Total Resources</span></div>
                    <p className="mt-2 text-xl font-black tabular-nums text-slate-900 dark:text-white">{libraryStats.resourceCount}</p>
                  </div>
                  <div className="rounded-2xl border border-rose-100 dark:border-rose-500/15 bg-white dark:bg-[#0c1222] p-3.5 shadow-sm transition-all hover:border-rose-200 dark:hover:border-rose-500/30">
                    <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400"><FileText className="h-4 w-4" /><span className="text-[10px] font-bold">PDF Documents</span></div>
                    <p className="mt-2 text-xl font-black tabular-nums text-slate-900 dark:text-white">{libraryStats.pdfCount}</p>
                  </div>
                  <div className="rounded-2xl border border-indigo-100 dark:border-indigo-500/15 bg-white dark:bg-[#0c1222] p-3.5 shadow-sm transition-all hover:border-indigo-200 dark:hover:border-indigo-500/30">
                    <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400"><Sparkles className="h-4 w-4" /><span className="text-[10px] font-bold">Categories Used</span></div>
                    <p className="mt-2 text-xl font-black tabular-nums text-slate-900 dark:text-white">{libraryStats.categoryCount}<span className="ml-1 text-[10px] font-bold text-slate-400">/ 4</span></p>
                  </div>
                </div>

                <section className="nl-classes-section space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h3 className="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">Your Classes</h3>
                      <p className="mt-1 text-[10px] font-medium text-slate-400">Choose a class to browse and share its study material.</p>
                    </div>
                    <span className="inline-flex w-fit items-center rounded-full border border-orange-200/70 dark:border-orange-500/20 bg-orange-50 dark:bg-orange-500/10 px-2.5 py-1 text-[10px] font-black text-orange-600 dark:text-orange-400">
                      {filteredLibraries.length} of {libraries.length} {libraries.length === 1 ? 'Class' : 'Classes'}
                    </span>
                  </div>

                  <div className="relative">
                    <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-500 dark:text-blue-400" />
                    <input
                      ref={classSearchInputRef}
                      id="library-class-search"
                      type="search"
                      value={classSearchQuery}
                      onChange={(event) => setClassSearchQuery(event.target.value)}
                      placeholder="Search classes by name or code..."
                      aria-label="Search classes by name or code"
                      className="w-full rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#0c1222] py-3 pl-10 pr-11 text-xs font-bold text-slate-900 dark:text-white shadow-sm outline-none transition-all placeholder:text-slate-400 focus:border-orange-500 focus:shadow-[0_0_16px_rgba(249,115,22,0.13)] motion-reduce:transition-none"
                    />
                    {classSearchQuery && (
                      <button
                        type="button"
                        onClick={() => { setClassSearchQuery(''); classSearchInputRef.current?.focus(); }}
                        aria-label="Clear class search"
                        title="Clear search"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-xl p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {classLoadError ? (
                    <div className="rounded-3xl border border-rose-200 dark:border-rose-500/20 bg-white dark:bg-[#0c1222] p-6 text-center shadow-sm">
                      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500"><AlertTriangle className="h-5 w-5" /></div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">We couldn't load your libraries</h4>
                      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500 dark:text-slate-400">{classLoadError}</p>
                      <button type="button" onClick={() => window.location.reload()} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-black text-white transition-colors hover:bg-orange-600"><RefreshCw className="h-3.5 w-3.5" /> Retry loading</button>
                    </div>
                  ) : libraries.length === 0 ? (
                    <div className="rounded-3xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#0c1222] px-5 py-9 text-center shadow-sm">
                      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400"><Folder className="h-6 w-6" /></div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">No classes available yet</h4>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Classes assigned to your verified teacher account will appear here.</p>
                    </div>
                  ) : filteredLibraries.length === 0 ? (
                    <div className="rounded-3xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#0c1222] px-5 py-8 text-center shadow-sm">
                      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400"><Search className="h-5 w-5" /></div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">No matching classes</h4>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Try a different class name or class code.</p>
                      <button type="button" onClick={() => setClassSearchQuery('')} className="mt-3 text-xs font-black text-orange-600 hover:text-orange-500 dark:text-orange-400">Clear search</button>
                    </div>
                  ) : (
                    <div className="nl-classes-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {filteredLibraries.map((cls, index) => (
                        <div
                          key={cls.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open library for ${cls.className}`}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedClassId(cls.id);
                              setSelectedCategory('All');
                              setSearchQuery('');
                            }
                          }}
                          onClick={() => {
                            setSelectedClassId(cls.id);
                            setSelectedCategory('All');
                            setSearchQuery('');
                          }}
                          style={{ animationDelay: `${index * 45}ms` }}
                          className="nl-class-card min-h-[190px] rounded-3xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#0c1222] p-4 shadow-sm cursor-pointer transition-all duration-300 group relative overflow-hidden hover:-translate-y-1 hover:border-blue-300 dark:hover:border-blue-500/40 hover:shadow-[0_14px_28px_-18px_rgba(59,130,246,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#070b13] motion-reduce:transition-none animate-in fade-in slide-in-from-bottom-2"
                        >
                          <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-blue-400/0 blur-2xl transition-colors duration-300 group-hover:bg-blue-400/10 pointer-events-none" />
                          <div className="flex items-start justify-between relative z-10 gap-2">
                            <div className={`p-3 rounded-2xl border transition-all duration-300 group-hover:bg-orange-500 group-hover:text-white group-hover:border-orange-500 ${cls.bgGradient || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                              <Folder className="h-6 w-6" />
                            </div>
                            <span className="inline-flex items-center gap-1 rounded-full border border-blue-100 dark:border-blue-500/20 bg-blue-50/80 dark:bg-blue-500/10 px-2.5 py-1 text-[10px] font-black text-blue-700 dark:text-blue-300 group-hover:border-orange-200 dark:group-hover:border-orange-500/20 group-hover:bg-orange-50 dark:group-hover:bg-orange-500/10 group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">
                              <BookOpen className="h-3 w-3" /> {cls.resources?.length || 0} Items
                            </span>
                          </div>

                          <div className="mt-4 space-y-1 relative z-10">
                            <h4 className="text-sm font-black text-slate-900 dark:text-white group-hover:text-orange-500 transition-colors truncate" title={cls.className}>
                              {cls.className}
                            </h4>
                            <p className="text-[11px] font-bold text-slate-400 truncate" title={`Code: ${cls.classCode}`}>
                              Code: {cls.classCode} <span className="mx-1 text-slate-300 dark:text-slate-600">•</span> {cls.totalStudents} Students
                            </p>
                          </div>

                          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs font-black text-slate-500 dark:text-slate-400 group-hover:text-orange-500 transition-colors relative z-10">
                            <span>Open Library</span>
                            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* SCREEN 2: INSIDE SELECTED CLASS LIBRARY */}
            {selectedClassId && currentClass && (
              <div className="nl-selected-library space-y-4 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="nl-resource-toolbar space-y-3">
                  <div className="nl-selected-class-banner flex items-center justify-between gap-3 rounded-2xl border border-blue-100 dark:border-blue-500/15 bg-gradient-to-r from-white via-blue-50/50 to-orange-50/50 dark:from-[#0c1222] dark:via-blue-950/20 dark:to-orange-950/10 px-3.5 py-3 shadow-sm">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400"><Folder className="h-4 w-4" /></div>
                      <div className="min-w-0"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Selected class library</p><p className="truncate text-xs font-black text-slate-900 dark:text-white">{currentClass.className}</p></div>
                    </div>
                    <span className="shrink-0 rounded-full border border-orange-200/70 dark:border-orange-500/20 bg-orange-50 dark:bg-orange-500/10 px-2.5 py-1 text-[10px] font-black text-orange-600 dark:text-orange-400">{currentClass.resources.length} {currentClass.resources.length === 1 ? 'resource' : 'resources'}</span>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search notes, books, or papers..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-white dark:bg-[#0c1222] text-slate-900 dark:text-white border border-slate-200/80 dark:border-slate-800 rounded-2xl pl-10 pr-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:shadow-[0_0_15px_rgba(249,115,22,0.2)] transition-all shadow-sm"
                    />
                  </div>

                  <div className="nl-resource-filters flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                    {(['All', 'Notes', 'Textbooks', 'Past Papers', 'Assignments'] as ResourceCategory[]).map((cat) => {
                      const isActive = selectedCategory === cat;
                      const count = cat === 'All' ? currentClass.resources.length : currentClass.resources.filter((resource) => resource.category === cat).length;
                      return (
                        <button
                          key={cat}
                          onClick={() => setSelectedCategory(cat)}
                          aria-pressed={isActive}
                          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-2xl text-xs font-black whitespace-nowrap transition-all motion-reduce:transition-none ${
                            isActive
                              ? 'bg-orange-500 text-white shadow-[0_0_12px_rgba(249,115,22,0.25)]'
                              : 'bg-white dark:bg-[#0c1222] text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800 hover:border-orange-500/50 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {cat}<span className={`rounded-full px-1.5 py-0.5 text-[9px] leading-none ${isActive ? 'bg-white/20 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {filteredResources.length === 0 ? (
                  <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-8 text-center space-y-3 shadow-sm animate-in fade-in zoom-in-95">
                    <div className="h-12 w-12 rounded-2xl bg-orange-500/10 text-orange-500 mx-auto flex items-center justify-center border border-orange-500/10">
                      {currentClass.resources.length === 0 ? <BookOpen className="h-6 w-6" /> : <Search className="h-6 w-6" />}
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">{currentClass.resources.length === 0 ? 'Your Class Library Is Ready' : 'No Materials Match These Filters'}</h4>
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1">
                        {currentClass.resources.length === 0
                          ? 'Upload notes, textbooks or past papers to start building this class library.'
                          : 'Try another search term or category, or clear the filters to see all saved resources.'}
                      </p>
                    </div>
                    {currentClass.resources.length > 0 && (searchQuery || selectedCategory !== 'All') && (
                      <button type="button" onClick={() => { setSearchQuery(''); setSelectedCategory('All'); }} className="mt-1 inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-black text-slate-600 dark:text-slate-300 transition-colors hover:border-orange-500 hover:text-orange-500">
                        <X className="h-3.5 w-3.5" /> Clear filters
                      </button>
                    )}
                    <button
                      onClick={openUploadModal}
                      className="bg-orange-500 text-white px-5 py-2.5 mt-2 rounded-2xl text-xs font-black shadow-[0_0_15px_rgba(249,115,22,0.2)] inline-flex items-center gap-1.5 hover:bg-orange-600 transition-all active:scale-[0.98] motion-reduce:transition-none"
                    >
                      <Plus className="h-4 w-4" /> Upload Material
                    </button>
                  </div>
                ) : (
                  <div className="nl-resource-grid space-y-3">
                    {filteredResources.map((res, index) => {
                      const ResourceIcon = res.fileType === 'image' ? FileImage : res.fileType === 'doc' ? FileType : res.fileType === 'link' ? Link2 : FileText;
                      const typeLabel = res.fileType === 'pdf' ? 'PDF' : res.fileType === 'doc' ? 'Word document' : res.fileType === 'image' ? 'Image' : 'Link';
                      return (
                      <div
                        key={res.id}
                        style={{ animationDelay: `${index * 50}ms` }}
                        className="nl-resource-card relative bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-4 shadow-sm hover:shadow-[0_14px_28px_-18px_rgba(249,115,22,0.35)] hover:border-orange-300 dark:hover:border-orange-500/40 transition-all duration-300 space-y-3 group animate-in fade-in slide-in-from-bottom-2 motion-reduce:transition-none"
                      >
                        <div className="flex items-start justify-between gap-2 relative z-10">
                            <div className="flex min-w-0 items-start gap-3">
                            <div className={`h-10 w-10 rounded-2xl flex items-center justify-center flex-shrink-0 mt-0.5 border transition-all duration-300 group-hover:scale-105 ${res.fileType === 'pdf' ? 'bg-rose-500/10 text-rose-600 border-rose-500/10 dark:text-rose-400' : res.fileType === 'doc' ? 'bg-blue-500/10 text-blue-600 border-blue-500/10 dark:text-blue-400' : res.fileType === 'image' ? 'bg-violet-500/10 text-violet-600 border-violet-500/10 dark:text-violet-400' : 'bg-orange-500/10 text-orange-600 border-orange-500/10 dark:text-orange-400'}`}>
                              <ResourceIcon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-[9px] font-black uppercase tracking-wider bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                                  {res.category}
                                </span>
                                <span className="text-[9px] font-bold text-slate-400">{typeLabel}</span>
                              </div>
                              <h4 className="text-xs font-black mt-1 text-slate-900 dark:text-white group-hover:text-orange-500 transition-colors break-words" title={res.title}>
                                {res.title}
                              </h4>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5 break-words">
                                {[res.fileSize, res.uploadDate ? `Uploaded ${res.uploadDate}` : ''].filter(Boolean).join(' • ') || 'Study resource'}
                              </p>
                              {res.fileName && <p className="mt-0.5 max-w-full truncate text-[9px] text-slate-400/90" title={res.fileName}>{res.fileName}</p>}
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleOpenEdit(res)}
                              className="text-slate-400 hover:text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10 p-1.5 rounded-xl transition-colors"
                              title="Edit Document"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => setDeletingResId(res.id)}
                              className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 p-1.5 rounded-xl transition-colors"
                              title="Delete Material"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <div className="nl-resource-sharebar bg-slate-50 dark:bg-[#070b13] p-2.5 rounded-2xl border border-slate-100 dark:border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 relative z-10">
                          <div className="nl-resource-shareurl flex items-center gap-2 truncate text-[10px] font-mono font-bold text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 px-2.5 py-1.5 rounded-xl border border-slate-200/60 dark:border-slate-800">
                            <Share2 className="h-3 w-3 text-orange-500 flex-shrink-0" />
                            <span className="truncate">{res.shareUrl}</span>
                          </div>

                          <div className="nl-resource-actions flex items-center gap-2 self-end sm:self-auto">
                            <button
                              onClick={() => handleCopyLink(res.shareUrl, res.id)}
                              className={`px-3 py-1.5 rounded-xl text-[11px] font-black flex items-center gap-1 transition-all ${
                                copiedId === res.id
                                  ? 'bg-emerald-500 text-white shadow-[0_0_10px_rgba(16,185,129,0.4)]'
                                  : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-orange-500 hover:border-orange-500'
                              }`}
                            >
                              {copiedId === res.id ? (
                                <>
                                  <Check className="h-3 w-3" /> Copied!
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" /> Share Link
                                </>
                              )}
                            </button>

                            <button
                              onClick={() => setPreviewResource(res)}
                              className="bg-orange-500 text-white hover:bg-orange-600 px-3 py-1.5 rounded-xl text-[11px] font-black flex items-center gap-1 shadow-md hover:shadow-[0_0_12px_rgba(249,115,22,0.4)] transition-all"
                            >
                              <Eye className="h-3 w-3" /> Preview
                            </button>
                          </div>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* DELETE CONFIRMATION DIALOG */}
      {deletingResId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-rose-500/50 rounded-3xl max-h-[90vh] overflow-y-auto max-w-xs w-full p-6 shadow-[0_0_40px_rgba(244,63,94,0.3)] space-y-4 text-center animate-in zoom-in-95">
            <div className="h-14 w-14 rounded-2xl bg-rose-500/10 text-rose-500 mx-auto flex items-center justify-center border border-rose-500/20 shadow-inner">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-white">Delete Document?</h3>
              <p className="text-xs text-slate-400 font-bold mt-1">
                Are you sure you want to delete this document?
              </p>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setDeletingResId(null)}
                className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-2xl text-xs font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteResource}
                className="flex-1 bg-rose-500 text-white py-3 rounded-2xl text-xs font-black hover:bg-rose-600 transition-all shadow-[0_0_15px_rgba(244,63,94,0.4)]"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MATERIAL MODAL */}
      {editingResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl max-h-[90vh] overflow-y-auto max-w-md w-full p-6 shadow-[0_0_40px_rgba(249,115,22,0.3)] space-y-4 animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Pencil className="h-4 w-4 text-orange-500" /> Edit Document
              </h3>
              <button
                onClick={() => setEditingResource(null)}
                className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Title / Subject Name *
                </label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                />
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Category *
                </label>
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value as Exclude<ResourceCategory, 'All'>)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                >
                  <option value="Notes">Notes</option>
                  <option value="Textbooks">Textbooks</option>
                  <option value="Past Papers">Past Papers</option>
                  <option value="Assignments">Assignments</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Description / Preview Notes
                </label>
                <textarea
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all resize-none"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingResource(null)}
                  className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-2xl text-xs font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingEdit || !editTitle}
                  className="flex-1 bg-orange-500 text-white py-3 rounded-2xl text-xs font-black hover:bg-orange-600 disabled:opacity-50 transition-all shadow-[0_0_15px_rgba(249,115,22,0.4)]"
                >
                  {isSavingEdit ? 'Updating...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* STORAGE DETAILS — premium modal; existing Notes & Library layout remains unchanged */}
      {isStorageModalOpen && (() => {
        const summary = storageSummary ?? {
          ownerUid: currentUser?.uid ?? '',
          defaultQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
          allocatedQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
          usedBytes: 0,
          additionalGrantedBytes: 0,
          knownBytes: storageMetadataUsage.knownBytes,
          unknownFileCount: storageMetadataUsage.unknownFileCount,
          usageVerified: false,
          usageSource: 'metadata-estimate' as const,
        };
        const health = getStorageHealth(summary.usedBytes, summary.allocatedQuotaBytes);
        const clampedProgress = Math.min(100, Math.max(0, health.percent));
        const availableBytes = Math.max(0, summary.allocatedQuotaBytes - summary.usedBytes);
        const requestedGb = getRequestedExtensionGb();
        const requestBytes = requestedGb && requestedGb > 0 ? Math.round(requestedGb * BYTES_PER_GB) : 0;
        const proposedQuotaBytes = summary.allocatedQuotaBytes + requestBytes;
        const proposedAvailableBytes = Math.max(0, proposedQuotaBytes - summary.usedBytes);
        const statusStyles = health.tone === 'green'
          ? { pill: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20', dot: 'bg-emerald-500', stroke: '#10b981' }
          : health.tone === 'amber'
            ? { pill: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20', dot: 'bg-amber-500', stroke: '#f59e0b' }
            : { pill: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20', dot: 'bg-rose-500', stroke: '#f43f5e' };
        const circumference = 2 * Math.PI * 52;
        return (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/65 p-2 sm:p-5 backdrop-blur-md animate-in fade-in duration-200" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsStorageModalOpen(false); }}>
            <section role="dialog" aria-modal="true" aria-labelledby="storage-dashboard-title" className="relative flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-white/70 bg-white shadow-[0_28px_100px_-28px_rgba(15,23,42,0.55)] dark:border-slate-700/70 dark:bg-[#0b1220] animate-in zoom-in-95 duration-200">
              <div className="relative shrink-0 overflow-hidden border-b border-slate-200/70 bg-gradient-to-br from-violet-700 via-indigo-700 to-blue-700 px-5 py-5 text-white sm:px-7">
                <div className="pointer-events-none absolute -right-8 -top-14 h-48 w-48 rounded-full bg-white/10 blur-3xl" />
                <div className="pointer-events-none absolute bottom-[-5rem] left-1/3 h-40 w-40 rounded-full bg-cyan-300/20 blur-3xl" />
                <div className="relative flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-indigo-50">
                      <Database className="h-3.5 w-3.5" /> Personal storage
                    </div>
                    <h2 id="storage-dashboard-title" className="text-xl font-black tracking-tight sm:text-2xl">Storage Details</h2>
                    <p className="mt-1 max-w-xl text-xs leading-relaxed text-indigo-100 sm:text-sm">Your Notes & Library capacity, live file metadata and extension requests in one place.</p>
                  </div>
                  <button type="button" aria-label="Close storage details" onClick={() => setIsStorageModalOpen(false)} className="rounded-xl border border-white/20 bg-white/10 p-2 text-white transition hover:bg-white/20">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="relative mt-4 flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-extrabold ${statusStyles.pill}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${statusStyles.dot}`} /> {health.label}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white/90">
                    <ShieldCheck className="h-3.5 w-3.5" /> {summary.usageVerified ? 'R2 usage verified' : 'Usage not yet verified'}
                  </span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                {storageError && (
                  <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="leading-relaxed">{storageError}</p>
                  </div>
                )}
                {storageLoading && (
                  <div className="mb-4 flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Refreshing storage metadata…
                  </div>
                )}

                {health.percent >= 100 && (
                  <div className="mb-4 flex items-start gap-3 rounded-2xl border border-rose-300 bg-rose-50 p-4 shadow-sm dark:border-rose-500/35 dark:bg-rose-500/10">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"><CircleAlert className="h-5 w-5" /></div>
                    <div className="min-w-0">
                      <p className="text-sm font-black text-rose-800 dark:text-rose-200">Storage limit reached</p>
                      <p className="mt-1 text-xs leading-relaxed text-rose-700 dark:text-rose-200/90">Your storage limit has been reached. Extend your storage to upload more documents.</p>
                      <button type="button" onClick={() => setIsStorageRequestFormOpen(true)} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3 py-2 text-[11px] font-black text-white shadow-sm transition hover:bg-rose-700"><HardDrive className="h-3.5 w-3.5" /> Extend Storage</button>
                    </div>
                  </div>
                )}
                {health.percent >= 90 && health.percent < 100 && (
                  <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200">
                    <CircleAlert className="h-4 w-4 shrink-0" /><p><strong>Storage is almost full.</strong> You have {formatStorageGb(availableBytes)} available. Consider requesting more capacity.</p>
                  </div>
                )}
                {health.percent >= 75 && health.percent < 90 && (
                  <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
                    <Info className="h-4 w-4 shrink-0" /><p><strong>Storage is getting low.</strong> You have used at least 75% of your allocated capacity.</p>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
                  <div className="relative overflow-hidden rounded-[24px] border border-slate-200 bg-gradient-to-br from-white via-indigo-50/60 to-violet-50/60 p-5 shadow-sm dark:border-slate-700/70 dark:from-slate-900 dark:via-indigo-950/30 dark:to-violet-950/20 sm:p-6">
                    <div className="flex items-center justify-between gap-3">
                      <div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Capacity usage</p><p className="mt-1 text-sm font-extrabold text-slate-900 dark:text-white">Allocated storage</p></div>
                      <span className="rounded-lg border border-slate-200 bg-white/80 px-2 py-1 text-[9px] font-black text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">BINARY GB</span>
                    </div>
                    <div className="flex flex-col items-center justify-center py-3">
                      <div className="relative h-44 w-44 sm:h-48 sm:w-48">
                        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90 overflow-visible" role="img" aria-label={`${Math.round(health.percent)} percent of allocated storage used`}>
                          <defs><linearGradient id="storageProgressGradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor={statusStyles.stroke} /><stop offset="100%" stopColor="#818cf8" /></linearGradient></defs>
                          <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" strokeOpacity="0.09" strokeWidth="10" />
                          <circle cx="60" cy="60" r="52" fill="none" stroke="url(#storageProgressGradient)" strokeWidth="10" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - clampedProgress / 100)} className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none" />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                          <Gauge className="mb-1 h-5 w-5" style={{ color: statusStyles.stroke }} />
                          <p className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">{health.percent > 999 ? '999+' : Math.round(health.percent)}<span className="text-base">%</span></p>
                          <p className="mt-1 text-[10px] font-bold text-slate-500 dark:text-slate-400">used</p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusStyles.stroke }} /> Used: {formatStorageGb(summary.usedBytes)}</span>
                        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" /> Available: {formatStorageGb(availableBytes)}</span>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/80 bg-white/70 p-3.5 dark:border-slate-700/60 dark:bg-slate-950/30">
                      <div className="flex items-center justify-between gap-3"><span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">Used capacity</span><span className="text-xs font-black tabular-nums text-slate-900 dark:text-white">{health.percent.toFixed(1)}%</span></div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${clampedProgress}%`, background: `linear-gradient(90deg, ${statusStyles.stroke}, #818cf8)` }} /></div>
                      <div className="mt-2 flex justify-between gap-3 text-[10px] font-bold text-slate-500 dark:text-slate-400"><span>{formatStorageGb(summary.usedBytes)} used</span><span>{formatStorageGb(summary.allocatedQuotaBytes)} total</span></div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/70">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"><Database className="h-4 w-4" /></div>
                      <p className="mt-3 text-[10px] font-bold text-slate-500 dark:text-slate-400">Total allocated</p>
                      <p className="mt-1 break-words text-lg font-black tracking-tight text-slate-900 dark:text-white">{formatStorageGb(summary.allocatedQuotaBytes)}</p>
                      <p className="mt-1 text-[9px] font-semibold text-slate-400">Includes approved grants only</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/70">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"><CircleCheck className="h-4 w-4" /></div>
                      <p className="mt-3 text-[10px] font-bold text-slate-500 dark:text-slate-400">Available</p>
                      <p className="mt-1 break-words text-lg font-black tracking-tight text-slate-900 dark:text-white">{formatStorageGb(availableBytes)}</p>
                      <p className="mt-1 text-[9px] font-semibold text-slate-400">Cannot be less than zero</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/70">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"><HardDrive className="h-4 w-4" /></div>
                      <p className="mt-3 text-[10px] font-bold text-slate-500 dark:text-slate-400">Extra granted</p>
                      <p className="mt-1 break-words text-lg font-black tracking-tight text-slate-900 dark:text-white">+{formatStorageGb(summary.additionalGrantedBytes)}</p>
                      <p className="mt-1 text-[9px] font-semibold text-slate-400">Approved capacity only</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/70">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"><ShieldCheck className="h-4 w-4" /></div>
                      <p className="mt-3 text-[10px] font-bold text-slate-500 dark:text-slate-400">Default limit</p>
                      <p className="mt-1 break-words text-lg font-black tracking-tight text-slate-900 dark:text-white">{formatStorageGb(summary.defaultQuotaBytes)}</p>
                      <p className="mt-1 text-[9px] font-semibold text-slate-400">Per teacher account</p>
                    </div>
                  </div>
                </div>

                {summary.usageVerified && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-[10px] font-bold text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">
                    <span><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />Verified from this teacher's R2 inventory</span>
                    <span>Files tracked: {summary.trackedObjectCount ?? 0}</span>
                    <span>Last verified: {formatStorageDate(summary.lastReconciledAt ?? summary.updatedAt)}</span>
                  </div>
                )}

                {!summary.usageVerified && (
                  <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 p-4 dark:border-amber-500/25 dark:bg-amber-500/10">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-black text-amber-900 dark:text-amber-200">Usage estimate — not yet authoritative</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200/90">{summary.unknownFileCount > 0 ? `${summary.unknownFileCount} stored ${summary.unknownFileCount === 1 ? 'object has' : 'objects have'} no reliable sizeBytes metadata. They are treated as unknown, not zero bytes.` : 'This view uses available file metadata and the last saved usage value.'} Run an R2 reconciliation to verify real object sizes and update accounting.</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold text-amber-800 dark:text-amber-200"><span>Known bytes: {formatStorageGb(summary.knownBytes)}</span><span>R2 objects tracked in local metadata: {storageMetadataUsage.trackedObjectCount}</span><span>Last update: {formatStorageDate(summary.updatedAt)}</span></div>
                    </div>
                  </div>
                )}

                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={handleReconcileStorageUsage} disabled={storageReconciling || storageLoading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] font-black text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-indigo-500/10"><RefreshCw className={`h-3.5 w-3.5 ${storageReconciling ? 'animate-spin' : ''}`} />{storageReconciling ? 'Reconciling…' : 'Reconcile usage'}</button>
                    <button type="button" onClick={() => void loadStorageDashboard(false)} disabled={storageLoading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] font-black text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"><RefreshCw className="h-3.5 w-3.5" />Refresh</button>
                  </div>
                  <button type="button" onClick={() => setIsStorageRequestFormOpen((value) => !value)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-[11px] font-black text-white shadow-lg shadow-indigo-500/20 transition hover:from-violet-500 hover:to-indigo-500 active:scale-[0.98]"><HardDrive className="h-4 w-4" />Extend Storage</button>
                </div>

                {isStorageRequestFormOpen && (
                  <form onSubmit={submitStorageExtensionRequest} className="mt-4 rounded-[22px] border border-indigo-200 bg-gradient-to-br from-indigo-50/80 to-violet-50/80 p-4 dark:border-indigo-500/25 dark:from-indigo-950/30 dark:to-violet-950/20 sm:p-5">
                    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-black text-slate-900 dark:text-white">Request more storage</h3><p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">Select a capacity increase. A request does not change your quota until authorized approval is recorded.</p></div><button type="button" onClick={() => setIsStorageRequestFormOpen(false)} aria-label="Close extension form" className="rounded-lg p-1 text-slate-400 hover:bg-white/70 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button></div>
                    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[1, 2, 5].map((gb) => (
                        <button key={gb} type="button" onClick={() => setSelectedExtensionGb(gb)} className={`rounded-xl border px-3 py-3 text-left transition-all ${selectedExtensionGb === gb ? 'border-indigo-500 bg-indigo-600 text-white shadow-md shadow-indigo-500/20' : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}><span className="block text-lg font-black">+{gb} GB</span><span className={`mt-0.5 block text-[9px] font-bold ${selectedExtensionGb === gb ? 'text-indigo-100' : 'text-slate-400'}`}>Add capacity</span></button>
                      ))}
                      <button type="button" onClick={() => setSelectedExtensionGb('custom')} className={`rounded-xl border px-3 py-3 text-left transition-all ${selectedExtensionGb === 'custom' ? 'border-indigo-500 bg-indigo-600 text-white shadow-md shadow-indigo-500/20' : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}><span className="block text-lg font-black">Custom</span><span className={`mt-0.5 block text-[9px] font-bold ${selectedExtensionGb === 'custom' ? 'text-indigo-100' : 'text-slate-400'}`}>Subject to approval</span></button>
                    </div>
                    {selectedExtensionGb === 'custom' && <div className="mt-3"><label htmlFor="custom-storage-gb" className="mb-1 block text-[10px] font-extrabold text-slate-600 dark:text-slate-300">Custom amount in GB (binary)</label><input id="custom-storage-gb" type="number" min="0.25" max="100" step="0.25" value={customExtensionGb} onChange={(event) => setCustomExtensionGb(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white" /></div>}
                    <div className="mt-3"><label htmlFor="storage-request-reason" className="mb-1 block text-[10px] font-extrabold text-slate-600 dark:text-slate-300">Reason (optional)</label><textarea id="storage-request-reason" rows={2} maxLength={1000} value={extensionReason} onChange={(event) => setExtensionReason(event.target.value)} placeholder="For example: additional course materials and assignments" className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-medium text-slate-900 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white" /></div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="rounded-xl border border-indigo-100 bg-white/80 p-3 dark:border-indigo-500/20 dark:bg-slate-950/30"><p className="text-[9px] font-bold text-slate-500 dark:text-slate-400">Current total</p><p className="mt-1 text-xs font-black text-slate-900 dark:text-white">{formatStorageGb(summary.allocatedQuotaBytes)}</p></div>
                      <div className="rounded-xl border border-indigo-100 bg-white/80 p-3 dark:border-indigo-500/20 dark:bg-slate-950/30"><p className="text-[9px] font-bold text-slate-500 dark:text-slate-400">Current used</p><p className="mt-1 text-xs font-black text-slate-900 dark:text-white">{formatStorageGb(summary.usedBytes)}</p></div>
                      <div className="rounded-xl border border-indigo-100 bg-white/80 p-3 dark:border-indigo-500/20 dark:bg-slate-950/30"><p className="text-[9px] font-bold text-slate-500 dark:text-slate-400">New total if approved</p><p className="mt-1 text-xs font-black text-indigo-700 dark:text-indigo-300">{formatStorageGb(proposedQuotaBytes)}</p></div>
                      <div className="rounded-xl border border-indigo-100 bg-white/80 p-3 dark:border-indigo-500/20 dark:bg-slate-950/30"><p className="text-[9px] font-bold text-slate-500 dark:text-slate-400">Available if approved</p><p className="mt-1 text-xs font-black text-emerald-700 dark:text-emerald-300">{formatStorageGb(proposedAvailableBytes)}</p></div>
                    </div>
                    <p className="mt-3 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">Requested increase: <strong>{requestedGb ? `+${requestedGb} GB (${formatStorageGb(requestBytes)})` : 'Enter a valid amount'}</strong>. The displayed projected capacity is not granted storage until approval updates the trusted usage document.</p>
                    {extensionRequestMessage && <div className="mt-3 rounded-xl border border-indigo-200 bg-white/80 p-3 text-[11px] leading-relaxed text-indigo-800 dark:border-indigo-500/20 dark:bg-slate-950/40 dark:text-indigo-200">{extensionRequestMessage}</div>}
                    <div className="mt-4 flex gap-2"><button type="button" onClick={() => setIsStorageRequestFormOpen(false)} className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] font-black text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">Cancel</button><button type="submit" disabled={extensionSubmitting || !requestedGb} className="flex-1 rounded-xl bg-indigo-600 px-3 py-2.5 text-[10px] font-black text-white shadow-md transition hover:bg-indigo-700 disabled:opacity-50">{extensionSubmitting ? 'Submitting request…' : 'Submit Extension Request'}</button></div>
                  </form>
                )}
                {extensionRequestMessage && !isStorageRequestFormOpen && <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-[11px] leading-relaxed text-indigo-800 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">{extensionRequestMessage}</div>}

                <div className="mt-5 rounded-[22px] border border-slate-200 bg-white p-4 dark:border-slate-700/70 dark:bg-slate-900/50 sm:p-5">
                  <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-black text-slate-900 dark:text-white">Extension history</h3><p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Requests and grants recorded for this teacher account.</p></div><History className="h-5 w-5 text-slate-400" /></div>
                  {storageExtensions.length ? <div className="mt-4 space-y-2">{storageExtensions.map((item) => {
                    const approved = ['approved', 'granted', 'completed'].includes(item.status.toLowerCase());
                    const denied = ['denied', 'rejected', 'declined'].includes(item.status.toLowerCase());
                    return <div key={item.id} className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-950/30 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="text-xs font-black text-slate-800 dark:text-slate-100">+{item.requestedGb} GB requested{approved && item.grantedGb ? ` · ${item.grantedGb} GB granted` : ''}</p><p className="mt-1 text-[9px] text-slate-500 dark:text-slate-400">Requested {formatStorageDate(item.requestDate)}{item.approvalDate ? ` · Processed ${formatStorageDate(item.approvalDate)}` : ''}</p>{item.reason && <p className="mt-1 break-words text-[10px] text-slate-500 dark:text-slate-400">{item.reason}</p>}</div><span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wide ${approved ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300' : denied ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'}`}><span className={`h-1.5 w-1.5 rounded-full ${approved ? 'bg-emerald-500' : denied ? 'bg-rose-500' : 'bg-amber-500'}`} />{item.status}</span></div>;
                  })}</div> : <div className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-7 text-center dark:border-slate-700"><Clock3 className="mx-auto h-5 w-5 text-slate-400" /><p className="mt-2 text-xs font-bold text-slate-600 dark:text-slate-300">No extension requests yet</p><p className="mt-1 text-[10px] text-slate-400">Approved capacity will appear here after an authorized decision.</p></div>}
                </div>

                <p className="mt-4 flex items-start gap-2 px-1 text-[9px] leading-relaxed text-slate-400"><Info className="mt-0.5 h-3 w-3 shrink-0" /> Storage values use binary units: 1 GB = 1,073,741,824 bytes. This page's metadata preflight is not a security boundary; the Cloudflare Worker and Firestore Rules must enforce quota changes and upload reservations server-side.</p>
              </div>
            </section>
          </div>
        );
      })()}

      {/* UPLOAD MATERIAL MODAL */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl max-h-[90vh] overflow-y-auto max-w-md w-full p-6 shadow-[0_0_40px_rgba(249,115,22,0.3)] space-y-4 animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Upload className="h-4 w-4 text-orange-500" /> Upload Study Material / CV
              </h3>
              <button
                onClick={() => setIsUploadModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUploadSubmit} className="space-y-4">
              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Title / Subject Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. My Resume / CV"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                />
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Category *
                </label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as Exclude<ResourceCategory, 'All'>)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                >
                  <option value="Notes">Notes</option>
                  <option value="Textbooks">Textbooks</option>
                  <option value="Past Papers">Past Papers</option>
                  <option value="Assignments">Assignments</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Attach File (PDF / Doc) *
                </label>
                <div 
                  className="border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl p-5 text-center hover:border-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/5 transition-all bg-slate-50/50 dark:bg-[#070b13]/50 group cursor-pointer relative overflow-hidden"
                >
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={(e) => {
                      const selectedFile = e.target.files?.[0];
                      if (!selectedFile) return;
                      try {
                        validateUploadFile(selectedFile);
                        setFileObject(selectedFile);
                      } catch (error) {
                        setFileObject(null);
                        e.currentTarget.value = '';
                        showToast(error instanceof Error ? error.message : 'This file is not supported.');
                      }
                    }}
                  />
                  <Upload className="h-6 w-6 text-orange-500 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-black text-slate-700 dark:text-slate-300 break-all">
                    {fileObject ? fileObject.name : 'Select PDF / Document File'}
                  </p>
                  <p className="text-[10px] text-slate-400 font-bold mt-1">
                    {fileObject ? `${(fileObject.size / (1024 * 1024)).toFixed(2)} MB selected • 20 MB maximum` : 'Supports PDF, DOC, DOCX, PNG, JPG and JPEG • Up to 20 MB'}
                  </p>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Description / Quick Notes
                </label>
                <textarea
                  placeholder="Additional notes..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all resize-none"
                />
              </div>

              {(isUploading || uploadValidationStatus !== 'pending' || uploadFileStatus !== 'pending' || uploadSaveStatus !== 'pending') && (
                <div className="overflow-hidden rounded-2xl border border-orange-100 bg-gradient-to-br from-orange-50 via-white to-amber-50 p-4 shadow-sm dark:border-orange-500/20 dark:from-orange-500/10 dark:via-slate-950 dark:to-amber-500/5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-600 dark:text-orange-300">Upload progress</p>
                      <p className="mt-1 text-[11px] font-bold text-slate-600 dark:text-slate-300">{
                        uploadSaveStatus === 'done' ? 'File saved successfully'
                          : uploadSaveStatus === 'error' ? 'Could not confirm the database save'
                            : uploadSaveStatus === 'active' ? 'Saving and verifying your file...'
                              : uploadFileStatus === 'error' ? 'File upload could not continue'
                                : uploadFileStatus === 'active' ? 'Uploading your file securely...'
                                  : uploadValidationStatus === 'error' ? 'Please check the selected file'
                                    : uploadValidationStatus === 'active' ? 'Validating file details...'
                                      : 'Ready to upload'
                      }</p>
                    </div>
                    <span className="shrink-0 rounded-xl border border-orange-200 bg-white/90 px-3 py-1.5 text-sm font-black tabular-nums text-orange-600 shadow-sm dark:border-orange-500/20 dark:bg-slate-900 dark:text-orange-300">{uploadPercent}%</span>
                  </div>

                  <div className="mb-3 space-y-2">
                    {[
                      { label: 'Validating file', status: uploadValidationStatus },
                      { label: 'Uploading file', status: uploadFileStatus },
                      { label: 'Saving to database', status: uploadSaveStatus },
                    ].map((step) => (
                      <div key={step.label} className="flex items-center gap-2.5">
                        <span
                          role="checkbox"
                          aria-checked={step.status === 'done'}
                          aria-label={`${step.label}: ${step.status}`}
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all duration-200 ${
                            step.status === 'done'
                              ? 'border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/20'
                              : step.status === 'active'
                                ? 'border-orange-500 bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300'
                                : step.status === 'error'
                                  ? 'border-rose-500 bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300'
                                  : 'border-slate-300 bg-white text-transparent dark:border-slate-700 dark:bg-slate-900'
                          }`}
                        >
                          {step.status === 'done' ? <Check className="h-3.5 w-3.5" /> : step.status === 'active' ? <RefreshCw className="h-3 w-3 animate-spin" /> : step.status === 'error' ? <AlertTriangle className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                        </span>
                        <span className={`text-[11px] font-extrabold ${step.status === 'done' ? 'text-emerald-700 dark:text-emerald-300' : step.status === 'active' ? 'text-orange-700 dark:text-orange-300' : step.status === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}`}>{step.label}</span>
                        <span className="ml-auto text-[9px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">{step.status === 'done' ? 'Complete' : step.status === 'active' ? 'In progress' : step.status === 'error' ? 'Needs attention' : 'Waiting'}</span>
                      </div>
                    ))}
                  </div>

                  <div
                    role="progressbar"
                    aria-label="File upload progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={uploadPercent}
                    className="h-2.5 w-full overflow-hidden rounded-full bg-orange-100 shadow-inner dark:bg-slate-800"
                  >
                    <div className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-500 to-emerald-500 transition-[width] duration-300 ease-out" style={{ width: `${uploadPercent}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[9px] font-bold text-slate-400 dark:text-slate-500">
                    <span>0%</span>
                    <span>{uploadPercent === 100 ? 'Upload transfer complete' : 'Please keep this window open'}</span>
                    <span>100%</span>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsUploadModalOpen(false)}
                  className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-2xl text-xs font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUploading || !newTitle}
                  className="flex-1 bg-orange-500 text-white py-3 rounded-2xl text-xs font-black hover:bg-orange-600 disabled:opacity-50 transition-all shadow-[0_0_15px_rgba(249,115,22,0.4)]"
                >
                  {isUploading ? (uploadButtonLabel || 'Saving...') : 'Save to Database'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PREVIEW & DOWNLOAD MODAL */}
      {previewResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] rounded-3xl max-w-sm w-full shadow-[0_0_40px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col animate-in zoom-in-95 border border-slate-200 dark:border-slate-800">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-orange-500/10 text-orange-500 rounded-2xl flex items-center justify-center">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[9px] font-black uppercase tracking-widest text-orange-500 bg-orange-500/10 px-2 py-0.5 rounded-full mb-0.5 inline-block">
                    STUDENT VIEW • {previewResource.category}
                  </span>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white truncate max-w-[200px]">
                    {previewResource.title}
                  </h3>
                </div>
              </div>
              <button
                onClick={() => setPreviewResource(null)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="p-6 flex-1 flex flex-col items-center justify-center space-y-4 bg-slate-50 dark:bg-[#070b13]">
              <div className="w-full flex items-center justify-between text-[10px] font-mono text-slate-400 border-b border-slate-200 dark:border-slate-800 pb-2 mb-2">
                <span>{previewResource.fileType === 'pdf' ? 'PDF Document' : previewResource.fileType === 'doc' ? 'Word Document' : previewResource.fileType === 'image' ? 'Image Resource' : 'Shared Resource'}</span>
                <span>{previewResource.fileSize}</span>
              </div>
              
              <div className="text-sm text-slate-600 dark:text-slate-300 text-center font-medium my-4">
                {previewResource.contentPreview}
              </div>

              <div className="w-full pt-4">
                <button 
                  onClick={() => handleDownloadResource(previewResource)}
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3.5 rounded-2xl text-xs flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(249,115,22,0.3)] transition-all active:scale-95"
                >
                  <Download className="h-4 w-4" />
                  Download Complete File
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <BottomNavbar />
    </div>
  );
}
