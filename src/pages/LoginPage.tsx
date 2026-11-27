import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { auth } from '@/lib/firebase';
import {
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { Sun, Moon, Eye, EyeOff, AlertCircle, Mail, Building2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { AcademyClientError, resolveAcademySession } from '@/lib/academyApi';

const normalizeEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { message?: string; email?: string } | null;
  const [isDark, setIsDark] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [academyId, setAcademyId] = useState('');
  const [email, setEmail] = useState(routeState?.email || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(routeState?.message || '');
  const [loading, setLoading] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  const finishLogin = async (user: User, enteredAcademyId: string) => {
    const session = await resolveAcademySession(user, enteredAcademyId.trim());
    setPassword('');
    navigate(session.role === 'academy_admin' ? '/academy-admin/dashboard' : '/dashboard', { replace: true });
  };

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setError('');
    setVerificationMessage('');
    setVerificationPending(false);

    const cleanEmail = normalizeEmail(email);
    const cleanAcademyId = academyId.trim();
    if (!/^\d{3,15}$/.test(cleanAcademyId) || Number(cleanAcademyId) < 100) {
      setError('Enter your valid numeric Academy ID.');
      return;
    }
    if (!cleanEmail || !/^[^\s@]+@gmail\.com$/.test(cleanEmail)) {
      setError('Enter the Gmail address registered with this Academy.');
      return;
    }

    setLoading(true);
    try {
      if (auth.currentUser) {
        await signOut(auth);
      }
      const user = (await signInWithEmailAndPassword(auth, cleanEmail, password)).user;
      await user.reload();
      const refreshedUser = auth.currentUser || user;
      setCurrentUser(refreshedUser);
      if (refreshedUser.emailVerified !== true) {
        await sendEmailVerification(refreshedUser);
        setVerificationPending(true);
        setVerificationMessage(`A Firebase verification email was sent to ${cleanEmail}. Open that email, verify the address, then return here and select “I've verified my email”.`);
        return;
      }
      await finishLogin(refreshedUser, cleanAcademyId);
    } catch (cause) {
      const message = cause instanceof AcademyClientError
        ? cause.message
        : 'Academy ID, email, or password is incorrect. Check the details and try again.';
      setError(message);
      if (!(cause instanceof AcademyClientError && cause.code === 'EMAIL_NOT_VERIFIED')) {
        // Do not leave an unverified/unauthorized browser session on a portal route.
        if (auth.currentUser) {
          try { await signOut(auth); } catch { /* Access remains blocked by server-verified guards. */ }
        }
        setCurrentUser(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    const user = auth.currentUser || currentUser;
    if (!user) {
      setError('Sign in with your email and password first to resend verification.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await user.reload();
      const refreshedUser = auth.currentUser || user;
      if (refreshedUser.emailVerified) {
        setVerificationMessage('Your email is verified. Select “I\'ve verified my email” to continue.');
        return;
      }
      await sendEmailVerification(refreshedUser);
      setVerificationMessage(`A new verification email was sent to ${refreshedUser.email || email}.`);
      setVerificationPending(true);
    } catch {
      setError('Firebase could not send the verification email. Check the Auth email/password provider and authorized domain settings.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmVerification = async () => {
    const user = auth.currentUser || currentUser;
    if (!user) {
      setError('Your sign-in session has ended. Sign in again after verifying your email.');
      setVerificationPending(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      await user.reload();
      const refreshedUser = auth.currentUser || user;
      if (!refreshedUser.emailVerified) {
        setError('Firebase still reports this email as unverified. Open the verification email first, then try again.');
        return;
      }
      await refreshedUser.getIdToken(true);
      await finishLogin(refreshedUser, academyId.trim());
    } catch (cause) {
      setError(cause instanceof AcademyClientError ? cause.message : 'The verified Academy membership could not be resolved. Check your Academy ID and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
      setError('Enter your Gmail address first, then select Forgot Password.');
      return;
    }
    setError('');
    try {
      await sendPasswordResetEmail(auth, cleanEmail);
      setVerificationMessage('If the account is registered, Firebase has sent a password reset email.');
    } catch {
      setError('Firebase could not send the password reset email. Check the email address and Auth configuration.');
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setCurrentUser(null);
    setVerificationPending(false);
    setVerificationMessage('');
    setPassword('');
  };

  return (
    <div className={`min-h-screen flex items-center justify-center relative overflow-hidden px-4 py-12 transition-colors duration-700 ease-in-out ${
      isDark ? 'bg-gradient-to-b from-[#0B1224] via-[#0F172A] to-[#0B1224]' : 'bg-gradient-to-b from-[#F8FAFC] via-[#F1F5F9] to-[#E2E8F0]'
    }`}>
      <div className="absolute top-6 right-6 z-50 flex items-center gap-3">
        <button onClick={() => setIsDark(!isDark)} type="button" aria-label="Toggle color theme" className={`relative w-16 h-9 rounded-full p-1 transition-all duration-500 shadow-lg border focus:outline-none ${isDark ? 'bg-[#131E35] border-orange-500/30' : 'bg-slate-200 border-slate-300'}`}>
          <div className={`w-7 h-7 rounded-full flex items-center justify-center transform transition-all duration-500 ease-out ${isDark ? 'translate-x-7 bg-gradient-to-r from-orange-500 to-amber-500 text-white' : 'translate-x-0 bg-white text-slate-600'}`}>
            {isDark ? <Moon className="w-3.5 h-3.5 fill-white stroke-white" /> : <Sun className="w-3.5 h-3.5 text-amber-500" />}
          </div>
        </button>
      </div>
      <div className="absolute top-0 right-0 w-[450px] h-[450px] bg-orange-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[450px] h-[450px] bg-blue-500/5 rounded-full blur-[120px] pointer-events-none" />

      <div className={`w-full max-w-md relative z-10 p-6 md:p-8 rounded-[2.5rem] border transition-all duration-700 ${isDark ? 'bg-[#131E35]/90 border-slate-700/50 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md' : 'bg-white border-slate-200 shadow-[0_25px_50px_-12px_rgba(15,23,42,0.08)]'}`}>
        <div className="flex flex-col items-center text-center">
          <div className="w-36 h-36 mb-1 drop-shadow-md"><img src="/ChatGPT Image Jul 20, 2026, 05_05_41 PM.png" alt="EduTrack Academy Logo" className="w-full h-full object-contain" /></div>
          <h2 className={`text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Academy Portal</h2>
          <p className={`text-xs mt-1 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Sign in with your Academy ID and account</p>
        </div>

        {error && <div role="alert" className="p-3 mt-4 rounded-xl text-xs font-medium flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-500"><AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span></div>}
        {verificationMessage && <div role="status" className="p-3 mt-4 rounded-xl text-xs leading-relaxed font-medium flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-200"><Mail className="mt-0.5 w-4 h-4 shrink-0" /><span>{verificationMessage}</span></div>}

        <form onSubmit={handleLogin} className="mt-6 space-y-4" autoComplete="off">
          <div className="space-y-1">
            <Label htmlFor="academyId" className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Academy ID</Label>
            <div className="relative"><Input id="academyId" inputMode="numeric" pattern="[0-9]{3,15}" value={academyId} onChange={(event) => setAcademyId(event.target.value.replace(/\D/g, '').slice(0, 15))} className={`rounded-xl h-11 pl-10 transition-all ${isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'}`} placeholder="e.g. 100" required /><Building2 className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" /></div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="email" className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Email Address</Label>
            <div className="relative"><Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={`rounded-xl h-11 pl-10 transition-all ${isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'}`} placeholder="admin@gmail.com" autoComplete="username" required /><Mail className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" /></div>
          </div>
          <div className="space-y-1 relative">
            <Label htmlFor="password" className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Password</Label>
            <div className="relative"><Input id="password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} className={`rounded-xl h-11 pr-10 transition-all ${isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'}`} autoComplete="current-password" required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-orange-500 transition-colors">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
          </div>
          <div className="flex items-center justify-between text-xs pt-1">
            <div className="flex items-center space-x-2"><Checkbox id="remember" className={`rounded-md transition-all ${isDark ? 'border-slate-600 data-[state=checked]:bg-orange-500 data-[state=checked]:border-orange-500' : 'border-slate-300 data-[state=checked]:bg-orange-500 data-[state=checked]:border-orange-500'}`} /><label htmlFor="remember" className={`font-semibold cursor-pointer select-none ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Remember Me</label></div>
            <button type="button" onClick={() => void handleForgotPassword()} className="font-bold text-orange-500 hover:text-orange-600">Forgot Password?</button>
          </div>
          <Button type="submit" disabled={loading} className="w-full h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold tracking-wide shadow-lg shadow-orange-500/20 hover:opacity-95 transform active:scale-[0.99] transition-all duration-300 mt-2">{loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : "Login"}</Button>
        </form>

        {verificationPending && <div className="mt-4 space-y-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <div className="flex items-center gap-2 text-sm font-bold text-amber-800 dark:text-amber-200"><ShieldCheck className="h-4 w-4" /> Email verification required</div>
          <p className="text-xs text-amber-800 dark:text-amber-200">The Academy Portal remains locked until Firebase confirms that your email address is verified.</p>
          <Button type="button" onClick={() => void handleConfirmVerification()} disabled={loading} className="w-full rounded-xl bg-orange-500 text-white hover:bg-orange-600">I've verified my email</Button>
          <Button type="button" variant="outline" onClick={() => void handleResendVerification()} disabled={loading} className="w-full rounded-xl">Resend verification email</Button>
          <Button type="button" variant="ghost" onClick={() => void handleSignOut()} disabled={loading} className="w-full rounded-xl">Sign out</Button>
        </div>}

        <div className="text-center text-xs pt-4"><span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Need a new Academy? </span><Link to="/register" className="font-bold text-orange-500 hover:text-orange-600 underline-offset-4 hover:underline ml-1">Academy Registration</Link></div>
      </div>
    </div>
  );
}
