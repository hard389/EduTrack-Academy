import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import type { User } from "firebase/auth";
import { AlertCircle, BellRing, CheckCircle2, Clock3, Loader2, Megaphone, Send, ShieldCheck, XCircle } from "lucide-react";

type AdminOutletContext = { adminUser: User | null; localDark: boolean };
type Announcement = {
  id: string;
  title: string;
  message: string;
  status: "published" | "unpublished";
  publishedAt: string | null;
  updatedAt: string | null;
};
type ApiResponse = { success: boolean; announcement: Announcement | null; message?: string; error?: string };

async function adminFetch(user: User, init: RequestInit = {}): Promise<ApiResponse> {
  const token = await user.getIdToken();
  const response = await fetch("/api/admin/teacher-announcement", {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => null) as ApiResponse | null;
  if (!response.ok || !data || data.success !== true) {
    throw new Error(data?.error || `Teacher notice request failed (${response.status}).`);
  }
  return data;
}

export default function TeacherAnnouncements() {
  const { adminUser, localDark } = useOutletContext<AdminOutletContext>();
  const [title, setTitle] = useState("Important EduTrack Update");
  const [message, setMessage] = useState("");
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const surface = localDark ? "border-slate-800 bg-[#0c1222] text-slate-100" : "border-slate-200 bg-white text-slate-900";
  const muted = localDark ? "text-slate-400" : "text-slate-500";
  const field = `w-full rounded-xl border px-4 py-3 text-sm outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/15 ${localDark ? "border-slate-700 bg-slate-950 text-white placeholder:text-slate-600" : "border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400"}`;

  const load = useCallback(async () => {
    if (!adminUser) return;
    setLoading(true);
    setError(null);
    try {
      const result = await adminFetch(adminUser);
      setAnnouncement(result.announcement);
      if (result.announcement) {
        setTitle(result.announcement.title);
        setMessage(result.announcement.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Teacher notices could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [adminUser]);

  useEffect(() => { void load(); }, [load]);

  const publish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminUser || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminFetch(adminUser, {
        method: "PUT",
        body: JSON.stringify({ action: "publish", title, message }),
      });
      setAnnouncement(result.announcement);
      setNotice(result.message || "Teacher notice published.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Teacher notice could not be published.");
    } finally {
      setSaving(false);
    }
  };

  const unpublish = async () => {
    if (!adminUser || saving || !announcement || announcement.status !== "published") return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminFetch(adminUser, {
        method: "PUT",
        body: JSON.stringify({ action: "unpublish" }),
      });
      setAnnouncement(result.announcement);
      setNotice(result.message || "Teacher notice unpublished.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Teacher notice could not be unpublished.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className={`relative overflow-hidden rounded-3xl border p-6 shadow-xl shadow-blue-950/5 sm:p-8 ${localDark ? "border-blue-900/60 bg-gradient-to-br from-[#101b36] via-[#10182b] to-[#151125]" : "border-blue-200 bg-gradient-to-br from-[#eaf5ff] via-white to-[#fff2e8]"}`}>
        <div className="pointer-events-none absolute -right-12 -top-20 h-64 w-64 rounded-full bg-orange-500/15 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white shadow-[0_12px_35px_rgba(37,99,235,.35)] ring-1 ring-white/30">
            <Megaphone size={30} />
          </div>
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/25 bg-orange-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[.18em] text-orange-500"><BellRing size={12} /> Teacher Portal Broadcast</span>
            <h2 className={`mt-2 text-2xl font-black tracking-tight sm:text-3xl ${localDark ? "text-white" : "text-slate-950"}`}>Publish a Teacher Notice</h2>
            <p className={`mt-2 max-w-2xl text-sm leading-6 ${muted}`}>Create an in-app announcement that appears in the centre of each teacher's dashboard with a glowing EduTrack notice card.</p>
          </div>
        </div>
      </section>

      {error ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 text-sm text-rose-600"><AlertCircle size={17} className="mt-0.5 shrink-0" />{error}</div> : null}
      {notice ? <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm text-emerald-600"><CheckCircle2 size={17} className="mt-0.5 shrink-0" />{notice}</div> : null}

      <section className={`rounded-3xl border p-5 shadow-lg shadow-slate-950/5 sm:p-7 ${surface}`}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="text-base font-extrabold">Notice Content</h3><p className={`mt-1 text-xs ${muted}`}>Only one active notice is displayed at a time.</p></div>
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold ${announcement?.status === "published" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600" : "border-slate-500/20 bg-slate-500/5 text-slate-500"}`}>
            <span className={`h-2 w-2 rounded-full ${announcement?.status === "published" ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
            {announcement?.status === "published" ? "Currently Published" : "Not Published"}
          </span>
        </div>

        {loading ? <div className={`flex items-center gap-2 py-12 text-sm ${muted}`}><Loader2 size={18} className="animate-spin" /> Loading notice settings…</div> : (
          <form onSubmit={(event) => void publish(event)} className="space-y-5">
            <label className="block space-y-2 text-xs font-bold">Notice Heading
              <input required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} className={field} placeholder="e.g. Important EduTrack Update" />
              <span className={`block text-right text-[10px] font-normal ${muted}`}>{title.length}/100</span>
            </label>
            <label className="block space-y-2 text-xs font-bold">Message for Teachers
              <textarea required maxLength={1800} rows={7} value={message} onChange={(event) => setMessage(event.target.value)} className={`${field} resize-y leading-6`} placeholder="Write the message that should appear in the Teacher Portal dashboard…" />
              <span className={`block text-right text-[10px] font-normal ${muted}`}>{message.length}/1800</span>
            </label>

            <div className={`rounded-2xl border p-4 ${localDark ? "border-blue-900/70 bg-blue-950/20" : "border-blue-200 bg-blue-50/70"}`}>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-blue-500" size={19} />
                <div><p className="text-xs font-extrabold">Display & dismissal policy</p><p className={`mt-1 text-xs leading-5 ${muted}`}>The notice appears when an authenticated teacher opens the dashboard. After the teacher closes it, that teacher will not see another notice that day. The daily dismissal is saved server-side using Pakistan time (Asia/Karachi), so it also applies across devices.</p></div>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-slate-500/15 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div className={`text-[11px] ${muted}`}>
                {announcement?.publishedAt ? <span className="inline-flex items-center gap-1.5"><Clock3 size={13} /> Last published: {new Date(announcement.publishedAt).toLocaleString()}</span> : "No notice has been published yet."}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {announcement?.status === "published" ? <button type="button" onClick={() => void unpublish()} disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 px-4 py-3 text-xs font-bold text-rose-600 transition hover:bg-rose-500/10 disabled:opacity-50"><XCircle size={15} /> Unpublish</button> : null}
                <button type="submit" disabled={saving || !title.trim() || !message.trim()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 px-5 py-3 text-xs font-extrabold text-white shadow-lg shadow-blue-600/25 transition hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  {saving ? "Saving…" : announcement?.status === "published" ? "Update & Publish" : "Publish to Teacher Portal"}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      {announcement?.status === "published" ? <section className="relative overflow-hidden rounded-3xl border border-blue-300/60 bg-gradient-to-br from-[#071e42] via-[#0b4380] to-[#542b83] p-6 text-white shadow-[0_18px_60px_rgba(37,99,235,.22)]">
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="relative flex items-center gap-2 text-[10px] font-black uppercase tracking-[.2em] text-cyan-100"><BellRing size={14} /> Live Teacher Preview</div>
        <h3 className="relative mt-3 text-xl font-black">{announcement.title}</h3>
        <p className="relative mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-blue-50">{announcement.message}</p>
      </section> : null}
    </div>
  );
}
