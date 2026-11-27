import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { getIdTokenResult, onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';

type GuardState =
  | { status: 'checking' }
  | { status: 'allowed' }
  | { status: 'unauthenticated' }
  | { status: 'denied'; message: string };

/**
 * Client-side route guard for UI/navigation only.
 * Protect Firestore, Storage, and server endpoints with their own authorization checks too.
 */
export default function AdminRouteGuard() {
  const location = useLocation();
  const navigate = useNavigate();
  const [guardState, setGuardState] = useState<GuardState>({ status: 'checking' });
  const [signOutBusy, setSignOutBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let requestSequence = 0;

    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        const thisRequest = ++requestSequence;

        if (!user) {
          if (active) setGuardState({ status: 'unauthenticated' });
          return;
        }

        if (active) setGuardState({ status: 'checking' });

        try {
          // Force-refresh so recently changed custom claims are checked.
          const tokenResult = await getIdTokenResult(user, true);
          if (!active || thisRequest !== requestSequence) return;
          if (auth.currentUser?.uid !== user.uid) return;

          if (tokenResult.claims.admin === true) {
            setGuardState({ status: 'allowed' });
          } else {
            setGuardState({
              status: 'denied',
              message: 'This signed-in account does not have administrator access.',
            });
          }
        } catch {
          if (!active || thisRequest !== requestSequence) return;
          setGuardState({
            status: 'denied',
            message:
              'Administrator permissions could not be verified. Check your connection and sign in again.',
          });
        }
      },
      () => {
        if (!active) return;
        ++requestSequence;
        setGuardState({
          status: 'denied',
          message: 'Firebase authentication could not be verified. Access is blocked.',
        });
      }
    );

    return () => {
      active = false;
      ++requestSequence;
      unsubscribe();
    };
  }, []);

  const handleSignOut = async () => {
    setSignOutBusy(true);
    try {
      await signOut(auth);
      navigate('/admin/login', { replace: true });
    } catch {
      setGuardState({
        status: 'denied',
        message:
          'Access remains blocked, but sign-out did not finish. Check your connection and retry.',
      });
    } finally {
      setSignOutBusy(false);
    }
  };

  if (guardState.status === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
        <div className="text-center" role="status" aria-live="polite">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-orange-500" />
          <p className="text-sm text-slate-300">Verifying administrator access…</p>
        </div>
      </main>
    );
  }

  if (guardState.status === 'unauthenticated') {
    return (
      <Navigate
        to="/admin/login"
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      />
    );
  }

  if (guardState.status === 'denied') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
        <section className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-6 text-center shadow-xl">
          <h1 className="text-xl font-bold">Admin Access Denied</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300" role="alert">
            {guardState.message}
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signOutBusy}
            className="mt-6 rounded-xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signOutBusy ? 'Signing out…' : 'Sign out and return to login'}
          </button>
        </section>
      </main>
    );
  }

  return <Outlet />;
}
