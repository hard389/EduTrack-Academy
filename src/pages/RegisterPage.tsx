import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { auth } from '@/lib/firebase';
import { createUserWithEmailAndPassword, sendEmailVerification, signOut } from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import { registerAcademy, resolveAcademySession } from '@/lib/academyApi';
import {
  Sun, Moon, Eye, EyeOff, Camera, ArrowLeft,
  AlertCircle, Check, CheckCircle2, XCircle, Mail, Lock, User, Trash2,
  ShieldCheck, UploadCloud, Database, UserPlus, Loader2, Copy, X as XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const DEFAULT_AVATAR = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=256&auto=format&fit=crop';
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

// Avatars never need to be larger than this for display; resizing/compressing down to this
// before upload is the single biggest lever on perceived registration speed when a custom
// picture is selected (see root-cause notes above handleRegister).
const MAX_AVATAR_DIMENSION = 512;
const AVATAR_JPEG_QUALITY = 0.85;
// A step is considered "taking longer than expected" past this point, which surfaces a
// reassuring status line instead of leaving the user staring at a silent spinner.
const SLOW_STEP_NOTICE_MS = 6000;


const R2_API_BASE = String(
  (import.meta as ImportMeta & { env?: { VITE_R2_API_URL?: string } }).env?.VITE_R2_API_URL ||
  '',
).replace(/\/+$/, '');

const USE_FIREBASE_EMULATORS = Boolean(
  (import.meta as ImportMeta & { env?: { DEV?: boolean; VITE_USE_FIREBASE_EMULATORS?: string } }).env?.DEV &&
  (import.meta as ImportMeta & { env?: { VITE_USE_FIREBASE_EMULATORS?: string } }).env?.VITE_USE_FIREBASE_EMULATORS === 'true',
);

const R2_API_IS_LOCAL = (() => {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(R2_API_BASE).hostname); }
  catch { return false; }
})();


const getProfileImageSignature = (file: File): string =>
  JSON.stringify([file.name, file.size, file.lastModified, file.type]);

// ---------------------------------------------------------------------------
// Client-side avatar optimization
//
// Resizes the selected image to at most MAX_AVATAR_DIMENSION on its longest side and
// re-encodes it, so the browser never uploads the full (up to 5 MB) original when a much
// smaller, visually equivalent image will do. PNG sources are kept as PNG (to preserve
// transparency correctly); everything else is encoded as JPEG, which compresses photographic
// avatars far better than typical camera-original JPEG/WebP/PNG files.
//
// This never throws: if the browser lacks canvas/decoding support, if decoding fails, or if the
// "optimized" result is not actually smaller, the original File is returned unchanged so the
// upload still proceeds with the same validated-safe file the user picked.
// ---------------------------------------------------------------------------
async function prepareProfileImageForUpload(file: File): Promise<File> {
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined') return file;

  let drawable: CanvasImageSource & { width?: number; height?: number; close?: () => void };
  let revokeObjectUrl: (() => void) | null = null;

  try {
    if (typeof createImageBitmap === 'function') {
      drawable = await createImageBitmap(file);
    } else {
      const objectUrl = URL.createObjectURL(file);
      revokeObjectUrl = () => URL.revokeObjectURL(objectUrl);
      drawable = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not decode the selected image.'));
        img.src = objectUrl;
      });
    }
  } catch {
    // Decoding failed (corrupt file, unsupported sub-format, etc.) — fall back to the original;
    // the Worker performs its own authoritative MIME/size validation regardless.
    if (revokeObjectUrl) revokeObjectUrl();
    return file;
  }

  const sourceWidth = drawable.width || 0;
  const sourceHeight = drawable.height || 0;
  if (!sourceWidth || !sourceHeight) {
    if (revokeObjectUrl) revokeObjectUrl();
    if (drawable.close) drawable.close();
    return file;
  }

  const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    if (revokeObjectUrl) revokeObjectUrl();
    if (drawable.close) drawable.close();
    return file;
  }

  // PNG is preserved as PNG so transparency is never corrupted. Anything else (including WebP
  // and non-transparent PNG-adjacent sources) is re-encoded as quality-tuned JPEG, which is
  // dramatically smaller than typical camera/phone originals at avatar dimensions.
  const outputIsPng = file.type.toLowerCase() === 'image/png';
  if (!outputIsPng) {
    // JPEG has no alpha channel; paint a white backdrop first so a transparent source doesn't
    // turn black.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  }
  ctx.drawImage(drawable, 0, 0, targetWidth, targetHeight);
  if (revokeObjectUrl) revokeObjectUrl();
  if (drawable.close) drawable.close();

  const outputMimeType = outputIsPng ? 'image/png' : 'image/jpeg';
  const blob: Blob | null = await new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result), outputMimeType, outputIsPng ? undefined : AVATAR_JPEG_QUALITY);
  });

  // Only ever use the optimized version when it is actually smaller. A tiny source image
  // (already under 512px, already well-compressed) can legitimately re-encode larger; in that
  // case the original is the better upload.
  if (!blob || blob.size <= 0 || blob.size >= file.size) return file;

  const extension = outputMimeType === 'image/png' ? 'png' : 'jpg';
  const baseName = file.name.replace(/\.[^./\\]+$/, '') || 'avatar';
  return new File([blob], `${baseName}-${targetWidth}x${targetHeight}.${extension}`, {
    type: outputMimeType,
    lastModified: Date.now(),
  });
}

async function uploadProfileImageToR2(file: File, user: FirebaseUser): Promise<string> {
  if (USE_FIREBASE_EMULATORS && !R2_API_IS_LOCAL) {
    throw new Error('Profile image upload is blocked in Firebase Emulator mode until a local R2 Worker is configured. No production R2 request was made.');
  }

  if (file.size <= 0 || file.size > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error('Choose a profile image smaller than or equal to 5 MB.');
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
    throw new Error('Use a JPEG, PNG, or WebP profile image.');
  }

  const form = new FormData();
  form.append('file', file, file.name);
  const token = await user.getIdToken();
  const response = await fetch(`${R2_API_BASE}/api/register/profile-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch { /* Report a useful error for a non-JSON Worker response below. */ }

  if (response.status === 404) {
    throw Object.assign(
      new Error(
        typeof payload.error === 'string' && /route not found|not found/i.test(payload.error)
          ? 'The deployed Cloudflare Worker does not have POST /api/register/profile-image yet. Deploy the profile-image route before registering with a custom picture.'
          : 'Cloudflare returned 404 for the profile-image endpoint. Verify that POST /api/register/profile-image is deployed.'
      ),
      { code: 'PROFILE_IMAGE_ROUTE_MISSING', status: 404 },
    );
  }

  if (!response.ok || payload.ok !== true || typeof payload.profileImageUrl !== 'string') {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Cloudflare profile image upload failed (${response.status}).`);
  }

  const returnedUrl = new URL(payload.profileImageUrl);
  const workerUrl = new URL(R2_API_BASE);
  if (returnedUrl.origin !== workerUrl.origin || !/^\/profile-images\/[A-Za-z0-9_-]{5,128}$/.test(returnedUrl.pathname)) {
    throw new Error('The Worker returned an invalid profile image URL.');
  }
  return returnedUrl.toString();
}


const normalizeEmail = (value: string) => value.trim().toLowerCase();
const isAllowedGmail = (value: string) => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(normalizeEmail(value));
/*
 * Academy registration is orchestrated by the trusted /api/academy/register endpoint.
 * Academy registration creates an Academy Owner. It does not create a teacher account.
 */

type StepKey = 'account' | 'security' | 'picture' | 'database';
type StepStatus = 'pending' | 'active' | 'complete' | 'skipped' | 'error';

const STEP_ORDER: StepKey[] = ['account', 'security', 'picture', 'database'];

const STEP_CONFIG: Record<StepKey, { label: string; description: string; icon: typeof UserPlus }> = {
  account: { label: 'Setting Up Account', description: 'Creating your sign-in credentials', icon: UserPlus },
  security: { label: 'Verifying Security', description: 'Confirming your session is authorized', icon: ShieldCheck },
  picture: { label: 'Uploading Academy Logo', description: 'Optimizing and saving the Academy logo', icon: UploadCloud },
  database: { label: 'Setting Up Database', description: 'Saving your Academy and owner membership', icon: Database },
};

const createInitialStepState = (): Record<StepKey, StepStatus> => ({
  account: 'pending',
  security: 'pending',
  picture: 'pending',
  database: 'pending',
});

// ---------------------------------------------------------------------------
// Premium registration progress card
//
// Pure presentational component: every status it renders is driven by the real step state
// passed in from handleRegister below. No step here ever advances on a timer — see the
// setStep(...) calls threaded through the actual async operations.
// ---------------------------------------------------------------------------
function RegistrationProgressCard({
  isDark,
  steps,
  errorMessage,
  slowNotice,
}: {
  isDark: boolean;
  steps: Record<StepKey, StepStatus>;
  errorMessage: string;
  slowNotice: string;
}) {
  const hasError = STEP_ORDER.some((key) => steps[key] === 'error');
  // Progress is based only on genuinely completed or intentionally skipped steps.
  // An active or failed operation never increases the percentage.
  const completedSteps = STEP_ORDER.filter(
    (key) => steps[key] === 'complete' || steps[key] === 'skipped',
  ).length;
  const progressPercent = Math.round((completedSteps / STEP_ORDER.length) * 100);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="registration-progress-title"
      aria-describedby="registration-progress-description"
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto p-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
    >
      {/* Backdrop */}
      <div className={`absolute inset-0 ${isDark ? 'bg-[#0B1224]/80' : 'bg-slate-900/40'} backdrop-blur-sm`} />

      {/* Card */}
      <div
        className={`relative my-auto w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[2rem] border p-6 sm:p-8 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.35)] motion-safe:transition-all motion-safe:duration-300 ${
          isDark
            ? 'bg-[#131E35] border-slate-700/60 text-slate-100'
            : 'bg-white border-slate-200 text-slate-900'
        }`}
      >
        <div className="flex flex-col items-center text-center mb-6">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-4 bg-gradient-to-br ${
            hasError ? 'from-red-500 to-rose-600' : 'from-orange-500 to-amber-500'
          }`}>
            {hasError ? (
              <AlertCircle className="w-6 h-6 text-white" />
            ) : (
              <Loader2 className="w-6 h-6 text-white motion-safe:animate-spin" />
            )}
          </div>
          <h2 id="registration-progress-title" className="text-lg font-bold tracking-tight">
            {hasError ? 'We hit a snag' : 'Creating your account'}
          </h2>
          <p id="registration-progress-description" className={`text-xs mt-1.5 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {hasError
              ? 'Review the details below. Your progress so far is safe.'
              : 'We’re setting everything up for you. Please keep this page open while each step completes.'}
          </p>
        </div>

        <ol className="space-y-4">
          {STEP_ORDER.map((key, index) => {
            const status = steps[key];
            const config = STEP_CONFIG[key];
            const Icon = config.icon;
            const isLast = index === STEP_ORDER.length - 1;

            return (
              <li key={key} className="relative flex gap-3.5">
                {!isLast && (
                  <span
                    aria-hidden="true"
                    className={`absolute left-[15px] top-8 bottom-[-16px] w-px motion-safe:transition-colors motion-safe:duration-500 ${
                      status === 'complete' || status === 'skipped'
                        ? 'bg-emerald-500/60'
                        : isDark ? 'bg-slate-700' : 'bg-slate-200'
                    }`}
                  />
                )}

                <span
                  className={`relative z-10 shrink-0 w-8 h-8 rounded-full flex items-center justify-center border-2 motion-safe:transition-all motion-safe:duration-300 ${
                    status === 'complete' || status === 'skipped'
                      ? 'bg-emerald-500 border-emerald-500'
                      : status === 'error'
                        ? 'bg-red-500 border-red-500'
                        : status === 'active'
                          ? 'bg-gradient-to-br from-orange-500 to-amber-500 border-orange-500 motion-safe:shadow-[0_0_0_4px_rgba(249,115,22,0.15)]'
                          : isDark
                            ? 'bg-[#0B1224] border-slate-700'
                            : 'bg-slate-100 border-slate-200'
                  }`}
                >
                  {status === 'complete' || status === 'skipped' ? (
                    <Check className="w-4 h-4 text-white" strokeWidth={3} />
                  ) : status === 'error' ? (
                    <XIcon className="w-4 h-4 text-white" strokeWidth={3} />
                  ) : status === 'active' ? (
                    <Loader2 className="w-4 h-4 text-white motion-safe:animate-spin" />
                  ) : (
                    <Icon className={`w-4 h-4 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                  )}
                </span>

                <div className="pt-0.5">
                  <p className={`text-sm font-bold motion-safe:transition-colors motion-safe:duration-300 ${
                    status === 'pending'
                      ? (isDark ? 'text-slate-600' : 'text-slate-400')
                      : status === 'error'
                        ? 'text-red-500'
                        : (isDark ? 'text-slate-100' : 'text-slate-800')
                  }`}>
                    {config.label}
                    {status === 'skipped' && (
                      <span className={`ml-2 text-[10px] font-semibold uppercase tracking-wide align-middle ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        Skipped
                      </span>
                    )}
                  </p>
                  {status === 'active' && (
                    <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {config.description}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Overall progress moves only when a real step completes or is intentionally skipped. */}
        <div className={`mt-6 pt-5 border-t ${isDark ? 'border-slate-700/70' : 'border-slate-200'}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              Registration progress
            </span>
            <span
              className={`text-sm font-extrabold tabular-nums ${hasError ? 'text-red-500' : isDark ? 'text-orange-300' : 'text-orange-600'}`}
              aria-live="polite"
              aria-atomic="true"
            >
              {progressPercent}%
            </span>
          </div>
          <div
            className={`h-2.5 w-full overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}
            role="progressbar"
            aria-label="Registration progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            aria-valuetext={`${completedSteps} of ${STEP_ORDER.length} registration steps completed`}
          >
            <div
              className={`h-full rounded-full bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out motion-reduce:transition-none ${hasError ? 'opacity-70' : ''}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className={`mt-2 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`} aria-live="polite">
            {completedSteps} of {STEP_ORDER.length} steps completed
          </p>
        </div>

        {slowNotice && !hasError && (
          <div className={`mt-5 p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${
            isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700'
          }`}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{slowNotice}</span>
          </div>
        )}

        {hasError && errorMessage && (
          <div className="mt-5 p-3.5 rounded-xl text-xs font-semibold bg-red-500/10 border border-red-500/30 text-red-400 leading-relaxed">
            {errorMessage}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submissionInProgressRef = useRef(false);
  const [isDark, setIsDark] = useState(false);

  // Form Field States
  const [name, setName] = useState('');
  const [whatsappDigits, setWhatsappDigits] = useState('');
  const whatsappDigitsRef = useRef('');
  const [whatsappCheckStatus, setWhatsappCheckStatus] = useState<'idle' | 'checking' | 'registered' | 'not_registered' | 'failed'>('idle');
  const [whatsappCheckNumber, setWhatsappCheckNumber] = useState('');
  const [whatsappCheckMessage, setWhatsappCheckMessage] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingAcademy, setPendingAcademy] = useState<{ academyId: string; academyName: string; email: string } | null>(null);
  const [verificationNotice, setVerificationNotice] = useState('');
  const [academyIdCopied, setAcademyIdCopied] = useState(false);
  const [profileImage, setProfileImage] = useState<string>(DEFAULT_AVATAR);
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null);

  // The optimized (resized/compressed) version of the currently-selected file is prepared
  // eagerly in the background as soon as the file is chosen (see handleImageUpload), rather
  // than waiting until the user clicks "Create Account". By submit time this promise has
  // usually already resolved, so the perceived upload step is shorter. Keyed by the same
  // signature used elsewhere so a stale prepared file is never reused for a different pick.
  const preparedImageRef = useRef<{ signature: string; promise: Promise<File> } | null>(null);

  // UI Helper States
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stepStatus, setStepStatus] = useState<Record<StepKey, StepStatus>>(createInitialStepState);
  const [slowNotice, setSlowNotice] = useState('');
  const slowNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);


  // Clears any pending "this is taking a while" timer. Called whenever a step finishes
  // (success or error) or a new step starts, so the notice only ever reflects the step
  // actually in flight right now.
  const clearSlowNoticeTimer = useCallback(() => {
    if (slowNoticeTimerRef.current) {
      clearTimeout(slowNoticeTimerRef.current);
      slowNoticeTimerRef.current = null;
    }
    setSlowNotice('');
  }, []);

  // Marks a step's status and, for an 'active' step, arms a real-time watchdog that only
  // surfaces a message if that specific operation is genuinely still running after
  // SLOW_STEP_NOTICE_MS — never a fabricated delay, just a late notice about real waiting.
  const setStep = useCallback((key: StepKey, status: StepStatus) => {
    setStepStatus((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }));
    clearSlowNoticeTimer();
    if (status === 'active') {
      slowNoticeTimerRef.current = setTimeout(() => {
        setSlowNotice(`${STEP_CONFIG[key].label} is taking longer than usual. Hang tight — this can happen on a slow connection.`);
      }, SLOW_STEP_NOTICE_MS);
    }
  }, [clearSlowNoticeTimer]);

  useEffect(() => () => clearSlowNoticeTimer(), [clearSlowNoticeTimer]);

  // The selected image is only previewed locally here. It is uploaded to R2 after Firebase
  // Authentication creates/verifies the account, then only its URL is written to Firestore.
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
      setError('Please select a JPEG, PNG, or WebP image.');
      e.target.value = '';
      return;
    }
    if (file.size <= 0 || file.size > MAX_PROFILE_IMAGE_BYTES) {
      setError('Profile image should be larger than 0 bytes and no more than 5 MB.');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError('The selected image could not be read. Please try another image.');
        e.target.value = '';
        return;
      }
      setProfileImageFile(file);
      setProfileImage(reader.result); // Preview only; this data URL is never saved into Firestore.
      setError('');

      // Kick off avatar optimization now, in the background, instead of at submit time. The
      // preview above is unaffected (it still shows the original, read instantly via
      // FileReader) — this only prepares the smaller file that will actually be uploaded.
      const signature = getProfileImageSignature(file);
      preparedImageRef.current = {
        signature,
        promise: prepareProfileImageForUpload(file).catch(() => file),
      };
    };
    reader.onerror = () => {
      setError('The selected image could not be read. Please try another image.');
      e.target.value = '';
    };
    reader.onabort = () => {
      setError('Image reading was cancelled. Please select the image again.');
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  };

  // Handle Picture Delete
  const handleDeleteImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setProfileImage(DEFAULT_AVATAR);
    setProfileImageFile(null);
    preparedImageRef.current = null;
    setError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // WhatsApp Input Formatter (+92 handled automatically)
  const handleWhatsappChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;
    if (raw.startsWith('+92')) raw = raw.replace('+92', '');
    else if (raw.startsWith('92')) raw = raw.replace('92', '');
    else if (raw.startsWith('0')) raw = raw.replace(/^0+/, '');

    const digitsOnly = raw.replace(/\D/g, '').slice(0, 10);
    whatsappDigitsRef.current = digitsOnly;
    if (digitsOnly !== whatsappDigits) {
      setWhatsappCheckStatus('idle');
      setWhatsappCheckNumber('');
      setWhatsappCheckMessage('');
    }
    setWhatsappDigits(digitsOnly);
  };

  const handleCheckRegistrationWhatsApp = async () => {
    if (!/^\d{10}$/.test(whatsappDigits) || whatsappCheckStatus === 'checking') return;
    const submittedNumber = `92${whatsappDigits}`;
    setWhatsappCheckStatus('checking');
    setWhatsappCheckNumber('');
    setWhatsappCheckMessage('Checking WhatsApp registration…');
    try {
      const response = await fetch('/api/teacher/registration/whatsapp-number-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ number: submittedNumber }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; results?: Array<{ number?: string; status?: string }>; error?: string };
      if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Number verification could not be completed.');
      const result = payload.results?.find((item) => String(item.number || '') === submittedNumber);
      const status = result?.status === 'registered' ? 'registered' : result?.status === 'not_registered' ? 'not_registered' : 'failed';
      if (`92${whatsappDigitsRef.current}` !== submittedNumber) return;
      setWhatsappCheckStatus(status);
      setWhatsappCheckNumber(submittedNumber);
      setWhatsappCheckMessage(status === 'registered' ? 'This number is registered on WhatsApp.' : status === 'not_registered' ? 'This number was not found on WhatsApp.' : 'Verification failed. Please try again.');
    } catch (cause) {
      if (`92${whatsappDigitsRef.current}` !== submittedNumber) return;
      setWhatsappCheckStatus('failed');
      setWhatsappCheckNumber(submittedNumber);
      setWhatsappCheckMessage(cause instanceof Error ? cause.message : 'Verification failed. Please try again.');
    }
  };

  // Validation rules are intentionally kept compatible with the existing form policy.
  const isWhatsappValid = /^\d{10}$/.test(whatsappDigits);
  const isGmailValid = isAllowedGmail(email);
  const hasCapitalLetter = /[A-Z]/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const isPasswordValid = password.length >= 6 && hasCapitalLetter && hasSpecialChar;
  const isPasswordMatched = password === confirmPassword && confirmPassword.length > 0;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submissionInProgressRef.current) return;
    setError('');
    setVerificationNotice('');

    const cleanEmail = normalizeEmail(email);
    const academyName = name.trim();
    if (academyName.length < 2 || academyName.length > 120) {
      setError('Academy Name must contain between 2 and 120 characters.');
      return;
    }
    if (!isAllowedGmail(cleanEmail)) {
      setError('Please enter a valid Gmail address ending with @gmail.com.');
      return;
    }
    if (!isWhatsappValid) {
      setError(`Please enter complete 10 digits after +92. (${10 - whatsappDigits.length} remaining)`);
      return;
    }
    if (!isPasswordValid) {
      setError(password.length < 6
        ? 'Password must be at least 6 characters long.'
        : !hasCapitalLetter
          ? 'Password must contain at least one uppercase letter.'
          : 'Password must contain at least one special character.');
      return;
    }
    if (!isPasswordMatched) {
      setError('Password and Confirm Password do not match.');
      return;
    }

    submissionInProgressRef.current = true;
    setLoading(true);
    setStepStatus(createInitialStepState());
    let user: FirebaseUser | null = null;
    try {
      setStep('account', 'active');
      const currentUser = auth.currentUser;
      if (currentUser && normalizeEmail(currentUser.email ?? '') !== cleanEmail) {
        await signOut(auth);
      }
      user = auth.currentUser;
      if (!user) {
        user = (await createUserWithEmailAndPassword(auth, cleanEmail, password)).user;
      }
      await user.reload();
      user = auth.currentUser || user;
      if (normalizeEmail(user.email ?? '') !== cleanEmail) {
        throw new Error('The signed-in account does not match the registration email. Please sign out and try again.');
      }
      setStep('account', 'complete');

      setStep('security', 'active');
      await user.getIdToken(true);
      setStep('security', 'complete');

      let academyLogoUrl = '';
      if (profileImageFile) {
        setStep('picture', 'active');
        const signature = getProfileImageSignature(profileImageFile);
        const prepared = preparedImageRef.current?.signature === signature
          ? await preparedImageRef.current.promise
          : await prepareProfileImageForUpload(profileImageFile);
        academyLogoUrl = await uploadProfileImageToR2(prepared, user);
        setStep('picture', 'complete');
      } else {
        setStep('picture', 'skipped');
      }

      setStep('database', 'active');
      const result = await registerAcademy(user, {
        academyName,
        whatsappNumber: `+92${whatsappDigits}`,
        profileImage: academyLogoUrl,
      });
      setStep('database', 'complete');
        const exactAcademy = {
        academyId: result.academyId,
        academyName: result.academyName,
        email: cleanEmail,
      };
      setPendingAcademy(exactAcademy);
      setPassword('');
      setConfirmPassword('');

      await user.reload();
      const refreshedUser = auth.currentUser || user;
      if (refreshedUser.emailVerified) {
        await refreshedUser.getIdToken(true);
        await resolveAcademySession(refreshedUser, result.academyId);
        navigate('/academy-admin/dashboard', { replace: true });
        return;
      }

      try {
        await sendEmailVerification(refreshedUser);
        setVerificationNotice(`A Firebase verification email was sent to ${cleanEmail}. Verify it, then return here and select “I've verified my email”.`);
      } catch {
        setVerificationNotice('Academy created, but Firebase could not send the verification email. Check Firebase Authentication email/password provider and authorized domains, then use Resend Verification.');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Academy registration could not be completed.';
      setError(message);
      setStepStatus((current) => {
        const activeStep = STEP_ORDER.find((key) => current[key] === 'active');
        return activeStep ? { ...current, [activeStep]: 'error' } : current;
      });
      // Keep a successfully-created Auth account signed in so the same UID can safely
      // retry an idempotent Academy registration after a transient network failure.
      if (user && auth.currentUser?.uid !== user.uid) {
        try { await signOut(auth); } catch { /* server-side guards still deny access */ }
      }
    } finally {
      submissionInProgressRef.current = false;
      setLoading(false);
      clearSlowNoticeTimer();
    }
  };

  const handleResendAcademyVerification = async () => {
    const user = auth.currentUser;
    if (!user) {
      setError('Your sign-in session ended. Sign in with this email and password, then resend verification.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await user.reload();
      const refreshed = auth.currentUser || user;
      if (refreshed.emailVerified) {
        setVerificationNotice('Firebase confirms that your email is verified. Select “I\'ve verified my email” to continue.');
      } else {
        await sendEmailVerification(refreshed);
        setVerificationNotice(`A new Firebase verification email was sent to ${pendingAcademy?.email || refreshed.email || email}.`);
      }
    } catch {
      setError('Firebase could not send the verification email. Check the Firebase Auth email/password provider and authorized domains.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmAcademyVerification = async () => {
    const user = auth.currentUser;
    if (!user || !pendingAcademy) {
      setError('Your registration session is unavailable. Sign in again with the registered email and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await user.reload();
      const refreshed = auth.currentUser || user;
      if (!refreshed.emailVerified) {
        setError('Firebase still reports this email as unverified. Open the verification email first, then try again.');
        return;
      }
      await refreshed.getIdToken(true);
      await resolveAcademySession(refreshed, pendingAcademy.academyId);
      navigate('/academy-admin/dashboard', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your Academy membership could not be activated.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyAcademyId = async () => {
    if (!pendingAcademy?.academyId) return;
    try {
      await navigator.clipboard.writeText(pendingAcademy.academyId);
      setAcademyIdCopied(true);
    } catch {
      setError('Clipboard access is unavailable in this browser.');
    }
  };

  const handlePendingSignOut = async () => {
    await signOut(auth);
    setPendingAcademy(null);
    setVerificationNotice('');
    setPassword('');
    setConfirmPassword('');
    navigate('/login', { replace: true, state: { email: email.trim().toLowerCase() } });
  };

  return (
    <div className={`min-h-screen flex items-center justify-center relative overflow-hidden px-4 py-8 transition-colors duration-700 ease-in-out ${
      isDark
        ? 'bg-gradient-to-b from-[#0B1224] via-[#0F172A] to-[#0B1224]'
        : 'bg-gradient-to-b from-[#F8FAFC] via-[#F1F5F9] to-[#E2E8F0]'
    }`}>

      {pendingAcademy && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 px-4 py-8 backdrop-blur-sm">
          <section role="dialog" aria-modal="true" aria-labelledby="academy-created-title" className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl ${isDark ? 'border-slate-700 bg-[#131E35] text-white' : 'border-slate-200 bg-white text-slate-900'}`}>
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600"><ShieldCheck className="h-7 w-7" /></div>
            <h2 id="academy-created-title" className="text-center text-xl font-black">Academy Registered</h2>
            <p className="mt-2 text-center text-sm text-slate-500">Your Academy record has been created. Verify the owner email before portal access is enabled.</p>
            <div className={`mt-5 space-y-3 rounded-2xl p-4 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
              <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Academy Name</p><p className="mt-1 font-bold">{pendingAcademy.academyName}</p></div>
              <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Registered Admin Gmail</p><p className="mt-1 break-all font-semibold">{pendingAcademy.email}</p></div>
              <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Permanent Academy ID</p><div className="mt-1 flex items-center justify-between gap-3"><span className="text-3xl font-black tabular-nums text-orange-600">{pendingAcademy.academyId}</span><Button type="button" variant="outline" size="sm" onClick={() => void handleCopyAcademyId()}><Copy className="mr-2 h-4 w-4" />{academyIdCopied ? 'Copied' : 'Copy ID'}</Button></div></div>
            </div>
            <div role="status" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">{verificationNotice || 'Check your inbox for the Firebase verification email. Your Academy Portal remains locked until verification is confirmed.'}</div>
            {error && <p role="alert" className="mt-3 rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p>}
            <div className="mt-5 grid grid-cols-1 gap-2">
              <Button type="button" disabled={loading} onClick={() => void handleConfirmAcademyVerification()} className="h-11 rounded-xl bg-orange-500 text-white hover:bg-orange-600">I've verified my email</Button>
              <Button type="button" variant="outline" disabled={loading} onClick={() => void handleResendAcademyVerification()} className="h-11 rounded-xl">Resend Verification</Button>
              <Button type="button" variant="ghost" disabled={loading} onClick={() => void handlePendingSignOut()} className="h-10">Sign out / verify later</Button>
            </div>
          </section>
        </div>
      )}

      {/* Hidden File Input for Picture Upload */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImageUpload}
        accept="image/*"
        className="hidden"
        disabled={loading}
      />

      {/* Day / Night Toggle Button */}
      <div className="absolute top-6 right-6 z-50 flex items-center gap-3">
        <button
          onClick={() => setIsDark(!isDark)}
          disabled={loading}
          className={`relative w-16 h-9 rounded-full p-1 transition-all duration-500 shadow-lg border focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed ${
            isDark ? 'bg-[#131E35] border-orange-500/30' : 'bg-slate-200 border-slate-300'
          }`}
        >
          <div className={`w-7 h-7 rounded-full flex items-center justify-center transform transition-all duration-500 ease-out ${
            isDark ? 'translate-x-7 bg-gradient-to-r from-orange-500 to-amber-500 text-white' : 'translate-x-0 bg-white text-slate-600'
          }`}>
            {isDark ? <Moon className="w-3.5 h-3.5 fill-white stroke-white" /> : <Sun className="w-3.5 h-3.5 text-amber-500" />}
          </div>
        </button>
      </div>

      {/* Ambient Glows */}
      <div className="absolute top-0 right-0 w-[450px] h-[450px] bg-orange-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[450px] h-[450px] bg-blue-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Card Container */}
      <div className={`w-full max-w-md relative z-10 p-6 md:p-8 rounded-[2.5rem] border transition-all duration-700 ${
        isDark
          ? 'bg-[#131E35]/90 border-slate-700/50 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md'
          : 'bg-white border-slate-200 shadow-[0_25px_50px_-12px_rgba(15,23,42,0.08)]'
      }`}>

        {/* Premium progress overlay — only mounted while a submission is in flight, and driven
            entirely by real step state (see setStep calls in handleRegister). */}
        {loading && (
          <RegistrationProgressCard
            isDark={isDark}
            steps={stepStatus}
            errorMessage={error}
            slowNotice={slowNotice}
          />
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <Link
            to="/login"
            aria-disabled={loading}
            onClick={(e) => { if (loading) e.preventDefault(); }}
            className={`p-2 rounded-xl transition-colors ${loading ? 'pointer-events-none opacity-50' : ''} ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2">
            <span className={`text-base font-bold tracking-wide ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Academy Registration</span>
          </div>
          <div className="w-9" />
        </div>

        {/* Profile Picture Box with Edit & Delete options */}
        <div className="flex flex-col items-center justify-center mb-6">
          <div className="relative group">
            <div className="w-32 h-32 rounded-full border-2 border-orange-500/60 p-1 overflow-hidden transition-transform duration-300 shadow-md">
              <img
                src={profileImage}
                alt="Academy Logo"
                className="w-full h-full object-cover rounded-full"
              />
            </div>

            {/* Edit Button (Camera Icon) */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className="absolute bottom-0 right-0 w-8 h-8 bg-[#1E293B] border-2 border-orange-500 rounded-full flex items-center justify-center text-white shadow-lg hover:bg-orange-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              title="Upload / Change Picture"
            >
              <Camera className="w-4 h-4" />
            </button>

            {/* Delete Button (Trash Icon - visible if picture modified) */}
            {profileImage !== DEFAULT_AVATAR && (
              <button
                type="button"
                onClick={handleDeleteImage}
                disabled={loading}
                className="absolute bottom-0 -left-1 w-8 h-8 bg-red-600 border-2 border-white rounded-full flex items-center justify-center text-white shadow-lg hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                title="Remove Picture"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <span className="text-[11px] text-slate-400 mt-2 font-medium">Click camera to upload or change your Academy logo</span>
        </div>

        {/* Glowing Animated Red Notification Alert (only shown once the progress card has closed) */}
        {error && !loading && (
          <div className="p-3.5 mb-5 rounded-2xl text-xs font-bold flex items-center gap-2.5 bg-red-500/15 border-2 border-red-500/60 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.4)] motion-safe:animate-pulse transition-all">
            <AlertCircle className="w-5 h-5 shrink-0 text-red-500 motion-safe:animate-bounce" />
            <span className="leading-tight">{error}</span>
          </div>
        )}

        {/* Form Fields */}
        <fieldset disabled={loading} className="space-y-4 disabled:opacity-90">
        <form onSubmit={handleRegister} className="space-y-4" autoComplete="off" aria-busy={loading}>

          {/* Academy Name */}
          <div className="space-y-1">
            <Label htmlFor="name" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Academy Name
            </Label>
            <div className="relative">
              <Input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="EduTrack Academy"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`rounded-xl h-11 pl-9 transition-all ${
                  isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'
                }`}
              />
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            </div>
          </div>

          {/* System-assigned Academy ID (read-only preview until the server commits creation) */}
          <div className="space-y-1">
            <Label htmlFor="academyIdPreview" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Academy ID</Label>
            <Input id="academyIdPreview" value={pendingAcademy?.academyId || 'Assigned automatically on registration'} readOnly disabled className={`rounded-xl h-11 font-semibold ${isDark ? 'bg-[#0B1224] border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600'}`} />
            <p className="text-[10px] text-slate-400">The ID is generated securely by EduTrack and cannot be edited.</p>
          </div>

          {/* Email Address */}
          <div className="space-y-1">
            <Label htmlFor="email" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Gmail Address (@gmail.com)
            </Label>
            <div className="relative">
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="off"
                placeholder="admin@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`rounded-xl h-11 pl-9 pr-10 transition-all ${
                  email.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isGmailValid
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400 focus:border-emerald-500'
                      : 'bg-red-500/10 border-red-500/80 text-red-400 focus:border-red-500'
                }`}
              />
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              {email.length > 0 && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isGmailValid ? <CheckCircle2 className="w-5 h-5 text-emerald-500 fill-emerald-500/20" /> : <AlertCircle className="w-5 h-5 text-red-500" />}
                </div>
              )}
            </div>
            {email.length > 0 && !isGmailValid && (
              <p className="text-[11px] text-red-400 font-semibold mt-1">Email must end strictly with @gmail.com</p>
            )}
          </div>

          {/* Contact WhatsApp */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="whatsapp" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Contact WhatsApp
              </Label>
              <span className={`text-[11px] font-bold ${isWhatsappValid ? 'text-emerald-500' : 'text-slate-400'}`}>
                {whatsappDigits.length} / 10 Digits
              </span>
            </div>

            <div className="relative flex items-center">
              <div className={`absolute left-0 top-0 bottom-0 px-3 flex items-center font-bold text-sm rounded-l-xl border-r z-10 ${
                isDark ? 'bg-slate-800 border-slate-700 text-orange-400' : 'bg-slate-200 border-slate-300 text-orange-600'
              }`}>
                +92
              </div>

              <Input
                id="whatsapp"
                name="whatsapp"
                type="tel"
                autoComplete="tel"
                placeholder="303 2093780"
                value={whatsappDigits}
                onChange={handleWhatsappChange}
                className={`rounded-xl h-11 pl-16 pr-10 font-bold transition-all ${
                  whatsappDigits.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isWhatsappValid
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400 focus:border-emerald-500'
                      : 'bg-red-500/10 border-red-500/80 text-red-400 focus:border-red-500'
                }`}
              />

              {whatsappDigits.length > 0 && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isWhatsappValid ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 fill-emerald-500/20" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-500/70" />
                  )}
                </div>
              )}
            </div>

            {whatsappDigits.length > 0 && !isWhatsappValid && (
              <p className="text-[11px] text-red-400 font-semibold mt-1">
                Please enter remaining {10 - whatsappDigits.length} digits after +92.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!isWhatsappValid || whatsappCheckStatus === 'checking'} onClick={() => void handleCheckRegistrationWhatsApp()} className="rounded-xl text-xs font-bold">
                {whatsappCheckStatus === 'checking' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}
                {whatsappCheckStatus === 'checking' ? 'Checking…' : 'Check WhatsApp Number'}
              </Button>
              {whatsappCheckNumber === `92${whatsappDigits}` && whatsappCheckMessage && (
                <span role="status" className={`text-[11px] font-semibold ${whatsappCheckStatus === 'registered' ? 'text-emerald-500' : whatsappCheckStatus === 'not_registered' ? 'text-amber-500' : 'text-rose-500'}`}>{whatsappCheckMessage}</span>
              )}
            </div>
            <p className="text-[10px] text-slate-400">Number lookup does not send a WhatsApp message and does not grant notification consent.</p>
          </div>

          {/* Password Field */}
          <div className="space-y-1">
            <Label htmlFor="password" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Password
            </Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                autoComplete="new-password"
                type={showPassword ? "text" : "password"}
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`rounded-xl h-11 pl-9 pr-10 transition-all ${
                  password.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isPasswordValid
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/80 text-red-400'
                }`}
              />
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-orange-500 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {password.length > 0 && (
              <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] font-medium">
                <span className={`flex items-center gap-1 ${hasCapitalLetter ? 'text-emerald-400' : 'text-red-400'}`}>
                  {hasCapitalLetter ? <Check className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} 1 Capital Letter
                </span>
                <span className={`flex items-center gap-1 ${hasSpecialChar ? 'text-emerald-400' : 'text-red-400'}`}>
                  {hasSpecialChar ? <Check className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} 1 Special Char
                </span>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div className="space-y-1">
            <Label htmlFor="confirmPassword" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Confirm Password
            </Label>
            <div className="relative">
              <Input
                id="confirmPassword"
                name="confirmPassword"
                autoComplete="new-password"
                type={showConfirmPassword ? "text" : "password"}
                placeholder="••••••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`rounded-xl h-11 pl-9 pr-10 transition-all ${
                  confirmPassword.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isPasswordMatched
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/80 text-red-400'
                }`}
              />
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-orange-500 transition-colors"
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className={`rounded-xl border px-4 py-3 text-xs ${isDark ? 'border-slate-700 bg-slate-900/50 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
            Teacher access is managed by your Academy Admin through Academy permissions.
          </div>

          {/* Submit Button */}
          <Button type="submit" disabled={loading} className="w-full h-12 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold tracking-wide shadow-lg shadow-orange-500/20 hover:opacity-95 transform active:scale-[0.99] transition-all duration-300 mt-4 disabled:cursor-not-allowed">
            {loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full motion-safe:animate-spin" /> : 'Create Academy'}
          </Button>

          {/* Login Link */}
          <div className="text-center text-xs pt-2">
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Already have an account? </span>
            <Link
              to="/login"
              aria-disabled={loading}
              onClick={(e) => { if (loading) e.preventDefault(); }}
              className={`font-bold text-orange-400 hover:text-orange-500 transition-colors underline-offset-4 hover:underline ml-1 ${loading ? 'pointer-events-none opacity-50' : ''}`}
            >
              Login
            </Link>
          </div>

        </form>
        </fieldset>
      </div>
    </div>
  );
}
