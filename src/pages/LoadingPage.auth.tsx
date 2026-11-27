/**
 * Authentication/session gate helper used by the loading route.
 * The trusted backend resolves the Academy ID and role from Firestore membership;
 * the browser never authorizes from a cached profile or localStorage value.
 */

export const AUTH_INITIALIZATION_TIMEOUT_MS = 15_000;
export const ACADEMY_SESSION_TIMEOUT_MS = 15_000;

export type LoadingGateUser = {
  uid: string;
  email: string | null;
};

export type LoadingGateAcademySession = {
  uid: string;
  email: string;
  academyId: string;
  role: "academy_admin" | "teacher";
  status: "active";
};

type LoadingPageAuthGateDependencies = {
  isAvailable: boolean;
  observeAuth: (
    onUser: (user: LoadingGateUser | null) => void,
    onError: (error: unknown) => void
  ) => () => void;
  getCurrentUser: () => LoadingGateUser | null;
  resolveAcademySession: (user: LoadingGateUser) => Promise<LoadingGateAcademySession>;
  navigate: (
    path: '/login' | '/dashboard' | '/academy-admin/dashboard',
    options: { replace: true }
  ) => void;
  authTimeoutMs?: number;
  sessionTimeoutMs?: number;
};

const normalizeEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isValidAcademySession = (
  session: LoadingGateAcademySession,
  user: LoadingGateUser,
  normalizedEmail: string
): boolean => Boolean(
  session &&
  session.uid === user.uid &&
  normalizeEmail(session.email) === normalizedEmail &&
  /^\d{3,15}$/.test(session.academyId) &&
  Number(session.academyId) >= 100 &&
  (session.role === 'academy_admin' || session.role === 'teacher') &&
  session.status === 'active'
);

/**
 * Starts the guard and returns cleanup for observers and timers.
 * Each authenticated event is resolved through the trusted Academy session API.
 */
export function startLoadingPageAuthGuard({
  isAvailable,
  observeAuth,
  getCurrentUser,
  resolveAcademySession,
  navigate,
  authTimeoutMs = AUTH_INITIALIZATION_TIMEOUT_MS,
  sessionTimeoutMs = ACADEMY_SESSION_TIMEOUT_MS,
}: LoadingPageAuthGateDependencies): () => void {
  let disposed = false;
  let authInitialized = false;
  let authInitializationExpired = false;
  let eventSequence = 0;
  let lastNavigationKey = '';
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelActiveSessionCheck: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const isLiveEvent = (sequence: number): boolean => !disposed && sequence === eventSequence;

  const navigateOnce = (
    path: '/login' | '/dashboard' | '/academy-admin/dashboard',
    identity = ''
  ): void => {
    if (disposed) return;
    const key = path === '/login' ? path : `${path}:${identity}`;
    if (key === lastNavigationKey) return;
    lastNavigationKey = key;
    navigate(path, { replace: true });
  };

  const cancelSessionCheck = (): void => {
    if (sessionTimer !== undefined) {
      clearTimeout(sessionTimer);
      sessionTimer = undefined;
    }
    const cancel = cancelActiveSessionCheck;
    cancelActiveSessionCheck = undefined;
    cancel?.();
  };

  if (!isAvailable) {
    navigateOnce('/login');
    return () => { disposed = true; };
  }

  authTimer = setTimeout(() => {
    if (disposed || authInitialized) return;
    authInitializationExpired = true;
    eventSequence += 1;
    navigateOnce('/login');
  }, authTimeoutMs);

  const handleAuthState = (user: LoadingGateUser | null): void => {
    if (disposed || authInitializationExpired) return;
    const sequence = ++eventSequence;
    cancelSessionCheck();
    authInitialized = true;
    if (authTimer !== undefined) {
      clearTimeout(authTimer);
      authTimer = undefined;
    }

    if (!user || !user.uid || !normalizeEmail(user.email)) {
      navigateOnce('/login');
      return;
    }

    let rejectCancellation: ((reason?: unknown) => void) | undefined;
    const cancellationPromise = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    cancelActiveSessionCheck = () => {
      rejectCancellation?.(new Error('Academy session verification cancelled because auth state changed.'));
    };

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      sessionTimer = setTimeout(() => reject(new Error('Academy session verification timed out.')), sessionTimeoutMs);
    });

    void Promise.race([
      Promise.resolve().then(() => resolveAcademySession(user)),
      timeoutPromise,
      cancellationPromise,
    ])
      .then((session) => {
        if (!isLiveEvent(sequence)) return;
        const email = normalizeEmail(user.email);
        const currentUser = getCurrentUser();
        if (!currentUser || currentUser.uid !== user.uid || normalizeEmail(currentUser.email) !== email) return;
        if (!isValidAcademySession(session, user, email)) {
          navigateOnce('/login');
          return;
        }
        const destination = session.role === 'academy_admin' ? '/academy-admin/dashboard' : '/dashboard';
        navigateOnce(destination, `${session.academyId}:${user.uid}`);
      })
      .catch(() => {
        if (isLiveEvent(sequence)) navigateOnce('/login');
      })
      .finally(() => {
        if (!isLiveEvent(sequence)) return;
        if (sessionTimer !== undefined) {
          clearTimeout(sessionTimer);
          sessionTimer = undefined;
        }
        cancelActiveSessionCheck = undefined;
      });
  };

  try {
    unsubscribe = observeAuth(handleAuthState, () => {
      if (disposed) return;
      authInitializationExpired = true;
      eventSequence += 1;
      cancelSessionCheck();
      if (authTimer !== undefined) {
        clearTimeout(authTimer);
        authTimer = undefined;
      }
      navigateOnce('/login');
    });
  } catch {
    authInitializationExpired = true;
    eventSequence += 1;
    if (authTimer !== undefined) {
      clearTimeout(authTimer);
      authTimer = undefined;
    }
    navigateOnce('/login');
  }

  return () => {
    if (disposed) return;
    disposed = true;
    eventSequence += 1;
    if (authTimer !== undefined) clearTimeout(authTimer);
    if (sessionTimer !== undefined) clearTimeout(sessionTimer);
    authTimer = undefined;
    sessionTimer = undefined;
    cancelSessionCheck();
    unsubscribe?.();
  };
}
