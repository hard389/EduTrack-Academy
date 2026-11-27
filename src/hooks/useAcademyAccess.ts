import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { getAcademyAccess, type AcademyAccess } from '@/lib/academyApi';

export function useAcademyAccess() {
  const [access, setAccess] = useState<AcademyAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const current = ++generation;
      setAccess(null);
      if (!user) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const next = await getAcademyAccess(user);
        if (!disposed && current === generation && auth.currentUser?.uid === user.uid) setAccess(next);
      } catch {
        if (!disposed && current === generation) setAccess(null);
      } finally {
        if (!disposed && current === generation) setLoading(false);
      }
    });
    return () => { disposed = true; generation += 1; unsubscribe(); };
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const hasPermission = useCallback((permission: string) => access?.role === 'teacher' && access.permissions?.[permission] === true, [access]);
  return { access, loading, hasPermission, refresh };
}
