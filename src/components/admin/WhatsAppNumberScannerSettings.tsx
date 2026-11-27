import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Save, ShieldCheck } from "lucide-react";

type Props = { adminUser: User | null; localDark: boolean };
type ScannerSettings = {
  scannerBaseUrl: string;
  enabled: boolean;
  appKeyConfigured: boolean;
  authKeyConfigured: boolean;
  credentialsConfigured: boolean;
  updatedAt: string | null;
};
type ApiPayload = { success?: boolean; settings?: ScannerSettings; error?: string };

async function scannerFetch(user: User, init: RequestInit = {}): Promise<ApiPayload> {
  const token = await user.getIdToken();
  const response = await fetch("/api/admin/whatsapp-number-verification/settings", {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as ApiPayload;
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

export default function WhatsAppNumberScannerSettings({ adminUser, localDark }: Props) {
  const [settings, setSettings] = useState<ScannerSettings | null>(null);
  const [scannerBaseUrl, setScannerBaseUrl] = useState("");
  const [appKey, setAppKey] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!adminUser) return;
    setLoading(true);
    setError("");
    try {
      const response = await scannerFetch(adminUser);
      const next = response.settings;
      if (!next) throw new Error("Scanner settings were not returned.");
      setSettings(next);
      setScannerBaseUrl(next.scannerBaseUrl || "");
      setEnabled(next.enabled === true);
      setAppKey("");
      setAuthKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Scanner settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [adminUser]);

  useEffect(() => { void load(); }, [load]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminUser || saving) return;
    if (Boolean(appKey.trim()) !== Boolean(authKey.trim())) {
      setError("Enter both Scanner App Key and Auth Key together.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await scannerFetch(adminUser, {
        method: "PUT",
        body: JSON.stringify({ scannerBaseUrl, enabled, ...(appKey.trim() && authKey.trim() ? { appKey: appKey.trim(), authKey: authKey.trim() } : {}) }),
      });
      if (!response.settings) throw new Error("Saved scanner settings were not returned.");
      setSettings(response.settings);
      setScannerBaseUrl(response.settings.scannerBaseUrl || "");
      setEnabled(response.settings.enabled === true);
      setAppKey("");
      setAuthKey("");
      setNotice("Number Scanner settings saved separately. Existing WhatsApp message automation was not changed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Scanner settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const surface = localDark ? "border-slate-800 bg-[#0c1222] text-slate-100" : "border-slate-200 bg-white text-slate-900";
  const field = `mt-1.5 w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-orange-500 ${localDark ? "border-slate-700 bg-slate-950 text-slate-100" : "border-slate-200 bg-white text-slate-900"}`;
  const muted = localDark ? "text-slate-400" : "text-slate-500";

  if (!adminUser) return null;

  return (
    <section className={`rounded-2xl border p-5 space-y-4 ${surface}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-violet-500/10 p-3 text-violet-500"><ShieldCheck size={21} /></div>
          <div>
            <h2 className="text-base font-bold">WhatsApp Number Scanner API</h2>
            <p className={`mt-1 max-w-3xl text-xs leading-5 ${muted}`}>Separate number-registration lookup configuration for Register, Add Student and Excel/CSV import. These credentials are isolated from the existing Postabi message-sending credentials.</p>
          </div>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${settings?.enabled && settings.credentialsConfigured ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-600" : "border-amber-500/25 bg-amber-500/5 text-amber-600"}`}>
          {settings?.enabled && settings.credentialsConfigured ? "Scanner enabled" : "Scanner not enabled"}
        </span>
      </div>

      {loading ? <div className={`flex items-center gap-2 text-sm ${muted}`}><Loader2 size={15} className="animate-spin" /> Loading scanner settings…</div> : (
        <form onSubmit={save} className="space-y-4">
          <label className="block text-xs font-semibold">Scanner API Base URL
            <input required type="url" value={scannerBaseUrl} onChange={(event) => setScannerBaseUrl(event.target.value)} className={field} placeholder="https://your-scanner-api.example.com" autoComplete="url" />
            <span className={`mt-1 block text-[11px] font-normal ${muted}`}>The server appends <code>/api/whatsapp-web/check-number</code>. Enter the scanner provider host, not automatically the EduTrack website URL.</span>
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-xs font-semibold">Scanner App Key
              <input type="password" value={appKey} onChange={(event) => setAppKey(event.target.value)} className={field} placeholder={settings?.appKeyConfigured ? "Saved securely — enter to replace" : "Enter Scanner App Key"} autoComplete="new-password" />
              <span className={`mt-1 block text-[11px] font-normal ${muted}`}>{settings?.appKeyConfigured ? "Configured; the saved key is never returned to the browser." : "Encrypted with AES-256-GCM before Firestore storage."}</span>
            </label>
            <label className="block text-xs font-semibold">Scanner Auth Key
              <input type="password" value={authKey} onChange={(event) => setAuthKey(event.target.value)} className={field} placeholder={settings?.authKeyConfigured ? "Saved securely — enter to replace" : "Enter Scanner Auth Key"} autoComplete="new-password" />
              <span className={`mt-1 block text-[11px] font-normal ${muted}`}>{settings?.authKeyConfigured ? "Configured; the saved key is never returned to the browser." : "Never stored in localStorage or exposed to client requests."}</span>
            </label>
          </div>
          <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="mt-0.5 accent-orange-500" />
            <span><strong>Enable number verification for Register and Teacher Portal</strong><span className={`mt-1 block font-normal ${muted}`}>This only performs a WhatsApp registration lookup. It does not send a message and does not grant guardian consent.</span></span>
          </label>
          {settings?.credentialsConfigured && <p className={`flex items-center gap-2 text-[11px] ${muted}`}><KeyRound size={13} /> App Key and Auth Key are stored in a separate scanner settings document.</p>}
          {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-600"><AlertCircle size={15} />{error}</p>}
          {notice && <p role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-emerald-600"><CheckCircle2 size={15} />{notice}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-500/15 pt-4">
            <span className={`text-[11px] ${muted}`}>Provider contract: POST /api/whatsapp-web/check-number · max 50 numbers/request.</span>
            <button type="submit" disabled={saving || loading || !scannerBaseUrl.trim()} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{saving ? "Saving…" : "Save Scanner Settings"}
            </button>
          </div>
        </form>
      )}
      <p className={`text-[10px] leading-4 ${muted}`}>Provider responses are shown as Registered, Not Registered or Verification Failed. A successful lookup is not proof of ownership, permission or WhatsApp notification consent.</p>
    </section>
  );
}
