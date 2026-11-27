import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { resolveAcademySession } from "@/lib/academyApi";

export default function AcademyAdminRouteGuard() {
  const [state, setState] = useState<"checking" | "allowed" | "denied">("checking");
  const [destination, setDestination] = useState("/login");

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const currentSequence = ++sequence;
      if (!user) {
        if (!disposed) {
          setDestination("/login");
          setState("denied");
        }
        return;
      }
      try {
        const session = await resolveAcademySession(user);
        if (disposed || currentSequence !== sequence || auth.currentUser?.uid !== user.uid) return;
        if (session.role === "academy_admin") {
          setState("allowed");
        } else {
          setDestination("/dashboard");
          setState("denied");
        }
      } catch {
        if (disposed || currentSequence !== sequence) return;
        setDestination("/login");
        setState("denied");
      }
    });
    return () => {
      disposed = true;
      sequence += 1;
      unsubscribe();
    };
  }, []);

  if (state === "checking") {
    return <div className="min-h-screen grid place-items-center text-sm text-slate-500">Verifying Academy access…</div>;
  }
  if (state === "denied") return <Navigate to={destination} replace />;
  return <Outlet />;
}
