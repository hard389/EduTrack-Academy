import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  getIdTokenResult,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { Sun, Moon, Eye, EyeOff, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL?.trim() || 'aliupwork243715@gmail.com';
const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/**
 * The Firebase Admin SDK must set this custom claim on authorized users:
 * setCustomUserClaims(uid, { admin: true })
 *
 * getIdTokenResult() obtains the Firebase-issued ID token and exposes its
 * signed custom claims. Do not replace this with a client-editable profile flag.
 */
const hasAdminClaim = (claims: Record<string, unknown>): boolean => {
  return claims.admin === true;
};

type ErrorContext = 'login' | 'verification' | 'reset';

const getFriendlyAuthError = (
  error: unknown,
  context: ErrorContext = 'login'
): string => {
  const authError = error as { code?: string; message?: string };
  const code = String(authError?.code ?? '');

  if (context === 'verification') {
    if (
      code === 'auth/network-request-failed' ||
      code === 'unavailable' ||
      code === 'deadline-exceeded' ||
      code === 'network-request-failed'
    ) {
      return 'Unable to verify admin permissions because of a network problem. Please reconnect and try again.';
    }
    if (
      code === 'auth/user-token-expired' ||
      code === 'auth/id-token-expired' ||
      code === 'unauthenticated'
    ) {
      return 'Your session has expired. Please sign in again.';
    }
    return 'Unable to verify this account’s admin permissions. Access has been denied for your safety.';
  }

  if (context === 'reset') {
    if (code === 'auth/invalid-email') {
      return 'Please enter a valid email address before requesting a password reset.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many reset requests were made. Please wait a while and try again.';
    }
    if (
      code === 'auth/network-request-failed' ||
      code === 'unavailable' ||
      code === 'deadline-exceeded'
    ) {
      return 'Unable to connect to Firebase. Check your internet connection and try again.';
    }
    if (code === 'auth/operation-not-allowed') {
      return 'Password reset by email is not enabled in Firebase Authentication.';
    }
    return 'Unable to send the password reset email right now. Please try again.';
  }

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-login-credentials' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return 'Invalid email or password. Please check your credentials.';
  }
  if (code === 'auth/api-key-not-valid' || code === 'auth/invalid-api-key') {
    return 'Firebase rejected the Web API key. Copy the exact API key from the edutrack-academy Firebase Web App configuration and restart the app.';
  }
  if (code === 'auth/configuration-not-found') {
    return 'Firebase Authentication is not configured for the edutrack-academy project. Check the project and Authentication setup.';
  }
  if (code === 'auth/invalid-email') {
    return 'The email address is not formatted correctly.';
  }
  if (code === 'auth/too-many-requests') {
    return 'There have been too many failed attempts. Please try again later.';
  }
  if (code === 'auth/user-disabled') {
    return 'This account has been disabled. Please contact the administrator.';
  }
  if (
    code === 'auth/network-request-failed' ||
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'network-request-failed'
  ) {
    return 'Unable to connect to Firebase. Check your internet connection and try again.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Email and password sign-in is not enabled in Firebase Authentication.';
  }

  return 'Unable to sign in right now. Please try again.';
};

export default function AdminLogin() {
  const navigate = useNavigate();

  const [isDark, setIsDark] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState(ADMIN_EMAIL);
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  const mountedRef = useRef(true);
  const authInitializedRef = useRef(false);
  const authEventSequenceRef = useRef(0);
  const loginRequestInFlightRef = useRef(false);
  const redirectedUidRef = useRef<string | null>(null);

  // Verify pre-existing sessions and every newly signed-in user. Never redirect
  // until Firebase's ID token has been refreshed and its admin claim checked.
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;

    const unsubscribe = onAuthStateChanged(
      auth,
      async (user: User | null) => {
        const eventSequence = ++authEventSequenceRef.current;
        authInitializedRef.current = true;

        if (!user) {
          redirectedUidRef.current = null;
          if (!loginRequestInFlightRef.current && !disposed) {
            setLoading(false);
          }
          return;
        }

        if (disposed) return;
        setLoading(true);
        setError('');
        setSuccessMessage('');

        try {
          // Force-refresh so recently changed custom claims are not stale.
          const tokenResult = await getIdTokenResult(user, true);

          if (disposed || eventSequence !== authEventSequenceRef.current) return;
          if (auth.currentUser?.uid !== user.uid) return;

          if (!hasAdminClaim(tokenResult.claims)) {
            setError('This account is not authorized to access the admin portal.');
            try {
              await signOut(auth);
            } catch {
              // Access remains denied locally; protected routes/rules must enforce it too.
            }
            if (
              !disposed &&
              (!auth.currentUser || auth.currentUser.uid === user.uid)
            ) {
              setLoading(false);
            }
            return;
          }

          if (redirectedUidRef.current !== user.uid) {
            redirectedUidRef.current = user.uid;
            navigate('/admin/dashboard', { replace: true });
          }
          if (!disposed) setLoading(false);
        } catch (verificationError: unknown) {
          if (disposed || eventSequence !== authEventSequenceRef.current) return;
          if (auth.currentUser?.uid !== user.uid) return;

          setError(getFriendlyAuthError(verificationError, 'verification'));
          try {
            await signOut(auth);
          } catch {
            // Fail closed: do not navigate when token verification fails.
          }
          if (
            !disposed &&
            (!auth.currentUser || auth.currentUser.uid === user.uid)
          ) {
            setLoading(false);
          }
        }
      },
      (observerError: Error) => {
        if (disposed) return;
        ++authEventSequenceRef.current;
        authInitializedRef.current = true;
        setLoading(false);
        setError(getFriendlyAuthError(observerError, 'verification'));
      }
    );

    return () => {
      disposed = true;
      mountedRef.current = false;
      ++authEventSequenceRef.current;
      unsubscribe();
    };
  }, [navigate]);

  // Keep the app-wide Tailwind dark-mode class synchronized with the switch.
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginRequestInFlightRef.current) return;

    if (!authInitializedRef.current) {
      setError('Please wait while your existing session is checked, then try again.');
      return;
    }

    // The auth-state observer owns validation for an already-existing session.
    if (auth.currentUser) return;

    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setEmail(cleanEmail);
    setError('');
    setSuccessMessage('');
    setLoading(true);
    loginRequestInFlightRef.current = true;

    try {
      // Remember Me maps to Firebase's persistent or browser-session persistence.
      await setPersistence(
        auth,
        rememberMe ? browserLocalPersistence : browserSessionPersistence
      );
      await signInWithEmailAndPassword(auth, cleanEmail, password);

      // The observer will verify the signed custom claim before navigating.
      // Clear the password field after Firebase accepts the credentials.
      if (mountedRef.current) setPassword('');
    } catch (loginError: unknown) {
      const diagnostic = loginError as { code?: string; message?: string };
      console.error('[EduTrack Academy] Admin sign-in failed', {
        code: diagnostic?.code ?? 'unknown',
        message: diagnostic?.message ?? 'No Firebase error message was provided.',
        projectId: auth.app.options.projectId,
      });
      if (mountedRef.current && !auth.currentUser) {
        setError(getFriendlyAuthError(loginError, 'login'));
        setLoading(false);
      }
    } finally {
      loginRequestInFlightRef.current = false;
      // Keep the spinner while a signed-in user's admin claim is being checked.
      if (mountedRef.current && !auth.currentUser) setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
      setError('Enter your email address first, then select Forgot Password.');
      setSuccessMessage('');
      return;
    }

    setError('');
    setSuccessMessage('');
    setResetLoading(true);

    try {
      await sendPasswordResetEmail(auth, cleanEmail);
      if (mountedRef.current) {
        setSuccessMessage(
          'If an account exists for this email, a password reset email has been sent.'
        );
      }
    } catch (resetError: unknown) {
      if (mountedRef.current) {
        setError(getFriendlyAuthError(resetError, 'reset'));
      }
    } finally {
      if (mountedRef.current) setResetLoading(false);
    }
  };

  const pageBackground = isDark
    ? 'bg-gradient-to-b from-[#0B1224] via-[#0F172A] to-[#0B1224]'
    : 'bg-gradient-to-b from-[#F8FAFC] via-[#F1F5F9] to-[#E2E8F0]';

  const cardBackground = isDark
    ? 'bg-[#131E35]/90 border-slate-700/50 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md'
    : 'bg-white border-slate-200 shadow-[0_25px_50px_-12px_rgba(15,23,42,0.08)]';

  const inputStyle = isDark
    ? 'bg-[#0B1224] border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-orange-500 focus-visible:border-orange-500'
    : 'bg-slate-50 border-slate-200 text-slate-900 placeholder:text-slate-400 focus-visible:ring-orange-500 focus-visible:border-orange-500';

  return (
    <main
      className={`relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12 transition-colors duration-700 ease-in-out ${pageBackground}`}
    >
      {/* Dark/light theme control */}
      <div className="absolute right-5 top-5 z-50 sm:right-6 sm:top-6">
        <button
          type="button"
          onClick={() => setIsDark((current) => !current)}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-pressed={isDark}
          className={`relative h-9 w-16 rounded-full border p-1 shadow-lg transition-all duration-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 ${
            isDark
              ? 'border-orange-500/30 bg-[#131E35] focus-visible:ring-offset-[#0B1224]'
              : 'border-slate-300 bg-slate-200 focus-visible:ring-offset-white'
          }`}
        >
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full transition-all duration-500 ease-out ${
              isDark
                ? 'translate-x-7 bg-gradient-to-r from-orange-500 to-amber-500 text-white'
                : 'translate-x-0 bg-white text-slate-600'
            }`}
          >
            {isDark ? (
              <Moon className="h-3.5 w-3.5 fill-white stroke-white" />
            ) : (
              <Sun className="h-3.5 w-3.5 text-amber-500" />
            )}
          </span>
        </button>
      </div>

      {/* Soft background accents */}
      <div className="pointer-events-none absolute right-0 top-0 h-[450px] w-[450px] rounded-full bg-orange-500/10 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 left-0 h-[450px] w-[450px] rounded-full bg-blue-500/5 blur-[120px]" />

      {/* Admin login card */}
      <section
        aria-labelledby="admin-login-title"
        className={`relative z-10 w-full max-w-md rounded-[2rem] border p-6 transition-all duration-700 sm:rounded-[2.5rem] sm:p-8 ${cardBackground}`}
      >
        <div className="flex flex-col items-center text-center">
          <div className="mb-1 h-32 w-32 drop-shadow-md sm:h-36 sm:w-36">
            <img
              src="/ChatGPT Image Jul 20, 2026, 05_05_41 PM.png"
              alt="EduTrack Enterprise Logo"
              className="h-full w-full object-contain"
            />
          </div>
          <h1
            id="admin-login-title"
            className={`text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}
          >
            Admin Portal
          </h1>
          <p className={`mt-1 text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Sign in to continue to your workspace
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs font-medium text-red-400"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMessage && (
          <div
            role="status"
            className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs font-medium text-emerald-600 dark:text-emerald-400"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="mt-6 space-y-4" autoComplete="on">
          <div className="space-y-1.5">
            <Label
              htmlFor="admin-email"
              className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
            >
              Email Address
            </Label>
            <Input
              id="admin-email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={`h-11 rounded-xl transition-all ${inputStyle}`}
              placeholder="alitahir243715@gmail.com"
              autoComplete="username"
              inputMode="email"
              required
            />
          </div>

          <div className="relative space-y-1.5">
            <Label
              htmlFor="admin-password"
              className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
            >
              Password
            </Label>
            <div className="relative">
              <Input
                id="admin-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={`h-11 rounded-xl pr-10 transition-all ${inputStyle}`}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-orange-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1 text-xs">
            <div className="flex items-center gap-2">
              <Checkbox
                id="remember-me"
                name="rememberMe"
                checked={rememberMe}
                onCheckedChange={(checked) => setRememberMe(checked === true)}
                className={`rounded-md transition-all ${
                  isDark
                    ? 'border-slate-600 data-[state=checked]:border-orange-500 data-[state=checked]:bg-orange-500'
                    : 'border-slate-300 data-[state=checked]:border-orange-500 data-[state=checked]:bg-orange-500'
                }`}
              />
              <Label
                htmlFor="remember-me"
                className={`cursor-pointer select-none font-semibold ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
              >
                Remember Me
              </Label>
            </div>

            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={resetLoading || loading}
              className="shrink-0 font-bold text-orange-400 transition-colors hover:text-orange-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resetLoading ? 'Sending email…' : 'Forgot Password?'}
            </button>
          </div>

          <Button
            type="submit"
            disabled={loading || resetLoading}
            className="mt-2 h-11 w-full rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 font-bold tracking-wide text-white shadow-lg shadow-orange-500/20 transition-all duration-300 hover:opacity-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Verifying Admin…
              </span>
            ) : (
              'Login as Admin'
            )}
          </Button>

          <p className={`pt-2 text-center text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            Authorized administrators only
          </p>
        </form>
      </section>
    </main>
  );
}
