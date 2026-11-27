import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import {
  AcademyClientError,
  createAcademyTeacher,
  listAcademyTeachers,
  resolveAcademySession,
  type AcademySession,
  type AcademyTeacher,
} from "@/lib/academyApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Building2, Copy, GraduationCap, LogOut, Mail, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";

const cleanEmail = (value: string) => value.trim().toLowerCase();

export default function AcademyAdminDashboard() {
  const navigate = useNavigate();
  const [session, setSession] = useState<AcademySession | null>(null);
  const [teachers, setTeachers] = useState<AcademyTeacher[]>([]);
  const [teacherPage, setTeacherPage] = useState(1);
  const teacherPageSize = 5;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [teacherName, setTeacherName] = useState("");
  const [email, setEmail] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadDashboard = useCallback(async (quiet = false) => {
    const user = auth.currentUser;
    if (!user) {
      navigate("/login", { replace: true });
      return;
    }
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const currentSession = await resolveAcademySession(user);
      if (currentSession.role !== "academy_admin") {
        navigate("/dashboard", { replace: true });
        return;
      }
      const response = await listAcademyTeachers(user);
      setSession(currentSession);
      setTeachers(response.teachers);
      setTeacherPage(1);
    } catch (cause) {
      setError(cause instanceof AcademyClientError ? cause.message : "The Academy dashboard could not be loaded.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigate]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const handleCreateTeacher = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const normalizedEmail = cleanEmail(email);
    if (!teacherName.trim()) {
      setError("Teacher Name is required.");
      return;
    }
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/.test(normalizedEmail)) {
      setError("Enter a valid Gmail address ending with @gmail.com.");
      return;
    }
    if (password.length < 6 || !/[A-Z]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setError("Password must contain at least 6 characters, one uppercase letter and one special character.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Password and Confirm Password do not match.");
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      setError("Your session has expired. Please sign in again.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await createAcademyTeacher(user, {
        teacherName: teacherName.trim(),
        email: normalizedEmail,
        password,
        ...(whatsappNumber.trim() ? { whatsappNumber: whatsappNumber.trim() } : {}),
      });
      setTeachers((current) => [result.teacher, ...current.filter((teacher) => teacher.uid !== result.teacher.uid)]);
      setTeacherPage(1);
      setTeacherName("");
      setEmail("");
      setWhatsappNumber("");
      setPassword("");
      setConfirmPassword("");
      setFormOpen(false);
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof AcademyClientError ? cause.message : "The teacher account could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  const teacherPageCount = Math.max(1, Math.ceil(teachers.length / teacherPageSize));
  const visibleTeachers = teachers.slice((teacherPage - 1) * teacherPageSize, teacherPage * teacherPageSize);
  useEffect(() => { if (teacherPage > teacherPageCount) setTeacherPage(teacherPageCount); }, [teacherPage, teacherPageCount]);

  const handleCopyAcademyId = async () => {
    if (!session?.academyId) return;
    try {
      await navigator.clipboard.writeText(session.academyId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Clipboard access is unavailable in this browser.");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login", { replace: true });
  };

  if (loading) {
    return <div className="min-h-screen grid place-items-center text-sm text-slate-500">Loading Academy dashboard…</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white/90 dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-orange-500/10 p-2 text-orange-600"><Building2 className="h-6 w-6" /></div>
            <div><p className="text-lg font-black">EduTrack</p><p className="text-xs text-slate-500">Academy Admin Portal</p></div>
          </div>
          <Button variant="outline" onClick={handleLogout} className="rounded-xl"><LogOut className="mr-2 h-4 w-4" /> Sign out</Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
        {message && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">{message}</div>}

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-semibold text-orange-600">Academy overview</p>
              <h1 className="mt-1 text-2xl font-black">{session?.academyName || "Your Academy"}</h1>
              <p className="mt-1 text-sm text-slate-500">Signed in as {session?.email || auth.currentUser?.email}</p>
            </div>
            <div className="min-w-48 rounded-2xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/30">
              <p className="text-xs font-bold uppercase tracking-wider text-orange-700 dark:text-orange-300">Immutable Academy ID</p>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-3xl font-black tabular-nums text-orange-700 dark:text-orange-300">{session?.academyId || "—"}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyAcademyId()} disabled={!session?.academyId} aria-label="Copy Academy ID"><Copy className="h-4 w-4" /></Button>
              </div>
              <p className="mt-1 text-[11px] text-orange-800 dark:text-orange-200">{copied ? "Copied" : "Assigned by EduTrack system"}</p>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-blue-500/10 p-2 text-blue-600"><Users className="h-5 w-5" /></div>
              <div><h2 className="text-lg font-black">Teachers</h2><p className="text-xs text-slate-500">Only teachers assigned to this Academy are listed.</p></div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void loadDashboard(true)} disabled={refreshing} className="rounded-xl"><RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh</Button>
              <Button onClick={() => { setFormOpen((value) => !value); setError(""); setMessage(""); }} className="rounded-xl bg-orange-500 text-white hover:bg-orange-600"><Plus className="mr-2 h-4 w-4" /> Add Teacher</Button>
            </div>
          </div>

          {formOpen && (
            <form onSubmit={handleCreateTeacher} className="mt-6 grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="teacherName">Teacher Name</Label><Input id="teacherName" value={teacherName} onChange={(event) => setTeacherName(event.target.value)} maxLength={100} required /></div>
              <div className="space-y-1"><Label htmlFor="teacherEmail">Teacher Gmail</Label><Input id="teacherEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teacher@gmail.com" required /></div>
              <div className="space-y-1"><Label htmlFor="teacherWhatsapp">WhatsApp / Contact (optional)</Label><Input id="teacherWhatsapp" value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value)} placeholder="+923001234567" /></div>
              <div className="space-y-1"><Label htmlFor="teacherPassword">Initial Password</Label><Input id="teacherPassword" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></div>
              <div className="space-y-1"><Label htmlFor="teacherConfirmPassword">Confirm Password</Label><Input id="teacherConfirmPassword" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></div>
              <div className="flex items-end gap-2"><Button type="submit" disabled={submitting} className="rounded-xl bg-orange-500 text-white hover:bg-orange-600">{submitting ? "Creating…" : "Create Teacher"}</Button><Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={submitting} className="rounded-xl">Cancel</Button></div>
              <p className="sm:col-span-2 text-xs text-slate-500">The system creates a teacher account in this Academy only. No email is sent by the server in this flow. Share the initial password securely; the teacher must sign in and complete Firebase email verification before access is granted.</p>
            </form>
          )}

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[650px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-700"><tr><th className="px-3 py-3">Teacher</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Email verification</th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleTeachers.map((teacher) => <tr key={teacher.uid}><td className="px-3 py-3 font-semibold">{teacher.name}</td><td className="px-3 py-3">{teacher.email}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${teacher.active ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{teacher.active ? "Active" : "Pending verification"}</span></td><td className="px-3 py-3">{teacher.emailVerified ? <span className="inline-flex items-center gap-1 text-emerald-600"><ShieldCheck className="h-4 w-4" /> Verified</span> : <span className="inline-flex items-center gap-1 text-amber-600"><Mail className="h-4 w-4" /> Pending</span>}</td></tr>)}
                {!teachers.length && <tr><td colSpan={4} className="px-3 py-10 text-center text-slate-500"><GraduationCap className="mx-auto mb-2 h-7 w-7 opacity-50" />No teachers have been added to this Academy yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {teachers.length > teacherPageSize && <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-700"><span className="text-xs text-slate-500">Showing {(teacherPage - 1) * teacherPageSize + 1}–{Math.min(teacherPage * teacherPageSize, teachers.length)} of {teachers.length} teachers</span><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setTeacherPage((page) => Math.max(1, page - 1))} disabled={teacherPage <= 1}>Previous</Button><span className="text-xs font-bold tabular-nums">{teacherPage}/{teacherPageCount}</span><Button type="button" variant="outline" size="sm" onClick={() => setTeacherPage((page) => Math.min(teacherPageCount, page + 1))} disabled={teacherPage >= teacherPageCount}>Next</Button></div></div>}
        </section>

        <p className="text-xs leading-relaxed text-slate-500">Academy Admin is separate from the platform Super Admin. Your Academy ID and membership permissions are managed by trusted server-side records; this portal cannot change them.</p>
      </main>
    </div>
  );
}
