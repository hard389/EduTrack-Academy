import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import type { User } from "firebase/auth";
import WhatsAppNumberScannerSettings from "@/components/admin/WhatsAppNumberScannerSettings";
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageCircle,
  RefreshCw,
  Save,
  ShieldCheck,
  Users,
  WifiOff,
} from "lucide-react";

type WhatsAppOutletContext = { adminUser: User | null; localDark: boolean };
type WhatsAppAdminSettings = {
  provider: "postabi_web_app";
  businessNumber: string;
  enabled: boolean;
  credentialsConfigured: boolean;
  appKeyConfigured: boolean;
  authKeyConfigured: boolean;
  configurationStatus: string;
  canSendMessages: boolean;
  testSendEnabled: boolean;
  apiBaseUrl: string;
  updatedAt: string | null;
  lastConnectionCheckAt: string | null;
  lastTestMessageStatus: string | null;
  lastTestMessageHttpStatus: number | null;
  lastTestMessageProviderStatus: string | null;
  lastTestMessageProviderStatusCode: number | null;
  lastTestMessageRecipientLast4: string | null;
  testMessageReceivedAt: string | null;
  attendanceDispatchEnabled: boolean;
  attendanceDispatchServerEnabled: boolean;
  monthlyReportDispatchEnabled: boolean;
  monthlyReportDispatchServerEnabled: boolean;
  quizResultsDispatchEnabled: boolean;
  quizResultsDispatchServerEnabled: boolean;
  announcementDispatchEnabled: boolean;
  announcementDispatchServerEnabled: boolean;
  libraryLinkDispatchEnabled: boolean;
  libraryLinkDispatchServerEnabled: boolean;
  sharedWhatsAppDispatchServerEnabled: boolean;
  feeAlertsDispatchServerEnabled: boolean;
  cronSecretConfigured: boolean;
  firebaseAdminConfigured: boolean;
  credentialsEncryptionKeyValid: boolean;
  mediaSigningSecretValid: boolean;
  publicAppUrlValid: boolean;
};
type TeacherConnection = {
  uid: string;
  email: string;
  name: string;
  phoneNumber: string;
  selectedForPersonalRouting: boolean;
  connectionStatus: string;
  hasPersonalCredentials: boolean;
  testStatus: string | null;
  testRecipientLast4: string | null;
  providerFromLast4: string | null;
  sessionSupported: boolean;
};
type SettingsResponse = { success: boolean; settings: WhatsAppAdminSettings; teachers: TeacherConnection[]; teacherListWarning?: string | null };

type ApiResult = Record<string, unknown>;
async function adminFetch<T extends ApiResult>(url: string, user: User, init: RequestInit = {}): Promise<T> {
  const token = await user.getIdToken();
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
      ? data.error
      : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Invalid server response.");
  return data as T;
}

const card = "rounded-2xl border p-5";

export default function WhatsAppManagement() {
  const { adminUser, localDark } = useOutletContext<WhatsAppOutletContext>();
  const [settings, setSettings] = useState<WhatsAppAdminSettings | null>(null);
  const [teachers, setTeachers] = useState<TeacherConnection[]>([]);
  const [teacherListWarning, setTeacherListWarning] = useState<string | null>(null);
  const [businessNumber, setBusinessNumber] = useState("");
  const [appKey, setAppKey] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [attendanceDispatchEnabled, setAttendanceDispatchEnabled] = useState(false);
  const [confirmRealGuardianMessages, setConfirmRealGuardianMessages] = useState(false);
  const [authorizingAttendance, setAuthorizingAttendance] = useState(false);
  const [monthlyReportDispatchEnabled, setMonthlyReportDispatchEnabled] =
    useState(false);
  const [confirmRealMonthlyReports, setConfirmRealMonthlyReports] =
    useState(false);
  const [authorizingMonthlyReports, setAuthorizingMonthlyReports] =
    useState(false);
  const [quizResultsDispatchEnabled, setQuizResultsDispatchEnabled] = useState(false);
  const [confirmRealQuizResultMessages, setConfirmRealQuizResultMessages] = useState(false);
  const [authorizingQuizResults, setAuthorizingQuizResults] = useState(false);
  const [announcementDispatchEnabled, setAnnouncementDispatchEnabled] = useState(false);
  const [confirmRealAnnouncementMessages, setConfirmRealAnnouncementMessages] = useState(false);
  const [authorizingAnnouncements, setAuthorizingAnnouncements] = useState(false);
  const [libraryLinkDispatchEnabled, setLibraryLinkDispatchEnabled] = useState(false);
  const [confirmRealLibraryLinkMessages, setConfirmRealLibraryLinkMessages] = useState(false);
  const [authorizingLibraryLinks, setAuthorizingLibraryLinks] = useState(false);
  const [search, setSearch] = useState("");
  const [teacherDrafts, setTeacherDrafts] = useState<Record<string, {
    phoneNumber: string;
    selected: boolean;
    appKey: string;
    authKey: string;
  }>>({});
  const [teacherTestRecipients, setTeacherTestRecipients] =
    useState<Record<string, string>>({});
  const [teacherTestConsents, setTeacherTestConsents] =
    useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingTeacher, setSavingTeacher] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adminUser) return;
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch<SettingsResponse>("/api/admin/whatsapp/settings", adminUser);
      setSettings(response.settings);
      setBusinessNumber(response.settings.businessNumber || "");
      setEnabled(response.settings.enabled);
      setAttendanceDispatchEnabled(response.settings.attendanceDispatchEnabled === true);
      setMonthlyReportDispatchEnabled(
        response.settings.monthlyReportDispatchEnabled === true,
      );
      setQuizResultsDispatchEnabled(response.settings.quizResultsDispatchEnabled === true);
      setAnnouncementDispatchEnabled(response.settings.announcementDispatchEnabled === true);
      setLibraryLinkDispatchEnabled(response.settings.libraryLinkDispatchEnabled === true);
      setTeachers(response.teachers || []);
      setTeacherListWarning(response.teacherListWarning || null);
      setTeacherDrafts(Object.fromEntries((response.teachers || []).map((teacher) => [teacher.uid, {
        phoneNumber: teacher.phoneNumber || "",
        selected:
          teacher.selectedForPersonalRouting &&
          teacher.connectionStatus === "verified",
        appKey: "",
        authKey: "",
      }])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WhatsApp settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [adminUser]);

  useEffect(() => { void load(); }, [load]);

  const saveCentral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminUser) return;

    if (Boolean(appKey.trim()) !== Boolean(authKey.trim())) {
      setError("Enter both the Postabi App Key and Auth Key together.");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const payload: Record<string, unknown> = {
        businessNumber,
        enabled,
      };

      if (appKey.trim() && authKey.trim()) {
        payload.appKey = appKey.trim();
        payload.authKey = authKey.trim();
      }

      const response = await adminFetch<{ success: boolean; settings: WhatsAppAdminSettings }>(
        "/api/admin/whatsapp/settings",
        adminUser,
        { method: "PUT", body: JSON.stringify(payload) },
      );

      setSettings(response.settings);
      setEnabled(response.settings.enabled);
      setAttendanceDispatchEnabled(
        response.settings.attendanceDispatchEnabled === true,
      );
      setMonthlyReportDispatchEnabled(
        response.settings.monthlyReportDispatchEnabled === true,
      );
      setQuizResultsDispatchEnabled(response.settings.quizResultsDispatchEnabled === true);
      setAnnouncementDispatchEnabled(response.settings.announcementDispatchEnabled === true);
      setLibraryLinkDispatchEnabled(response.settings.libraryLinkDispatchEnabled === true);
      setAppKey("");
      setAuthKey("");
      setNotice("Postabi Web App credentials saved securely. Saving settings did not send a WhatsApp message.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const updateAttendanceAuthorization = async (enable: boolean) => {
    if (!adminUser || authorizingAttendance) return;

    if (enable && !confirmRealGuardianMessages) {
      setError("Explicit authorization for real guardian attendance messages is required.");
      return;
    }

    setAuthorizingAttendance(true);
    setError(null);
    setNotice(null);

    try {
      const response = await adminFetch<{
        success: boolean;
        settings: WhatsAppAdminSettings;
        message: string;
      }>(
        "/api/admin/whatsapp/attendance-dispatch",
        adminUser,
        {
          method: "POST",
          body: JSON.stringify(
            enable
              ? { enabled: true, confirmRealGuardianMessages: true }
              : { enabled: false },
          ),
        },
      );

      setSettings(response.settings);
      setAttendanceDispatchEnabled(
        response.settings.attendanceDispatchEnabled === true,
      );
      setConfirmRealGuardianMessages(false);
      setNotice(response.message);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Attendance authorization could not be updated.",
      );
    } finally {
      setAuthorizingAttendance(false);
    }
  };

  const updateMonthlyReportAuthorization = async (enable: boolean) => {
    if (!adminUser || authorizingMonthlyReports) return;

    if (enable && !confirmRealMonthlyReports) {
      setError("Explicit authorization for real monthly PDF messages is required.");
      return;
    }

    setAuthorizingMonthlyReports(true);
    setError(null);
    setNotice(null);

    try {
      const response = await adminFetch<{
        success: boolean;
        settings: WhatsAppAdminSettings;
        message: string;
      }>(
        "/api/admin/whatsapp/monthly-report-dispatch",
        adminUser,
        {
          method: "POST",
          body: JSON.stringify(
            enable
              ? {
                  enabled: true,
                  confirmRealMonthlyReportMessages: true,
                }
              : { enabled: false },
          ),
        },
      );

      setSettings(response.settings);
      setMonthlyReportDispatchEnabled(
        response.settings.monthlyReportDispatchEnabled === true,
      );
      setConfirmRealMonthlyReports(false);
      setNotice(response.message);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Monthly report authorization could not be updated.",
      );
    } finally {
      setAuthorizingMonthlyReports(false);
    }
  };

  const updateQuizResultsAuthorization = async (enable: boolean) => {
    if (!adminUser || authorizingQuizResults) return;
    if (enable && !confirmRealQuizResultMessages) {
      setError("Explicit authorization for real Quiz Results WhatsApp messages is required.");
      return;
    }
    setAuthorizingQuizResults(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch<{
        success: boolean;
        settings: WhatsAppAdminSettings;
        message: string;
      }>("/api/admin/whatsapp/settings", adminUser, {
        method: "PUT",
        body: JSON.stringify({
          quizResultsDispatchAction: enable ? "enable" : "disable",
          ...(enable ? { confirmRealQuizResultMessages: true } : {}),
        }),
      });
      setSettings(response.settings);
      setQuizResultsDispatchEnabled(response.settings.quizResultsDispatchEnabled === true);
      setConfirmRealQuizResultMessages(false);
      setNotice(response.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Quiz Results authorization could not be updated.");
    } finally {
      setAuthorizingQuizResults(false);
    }
  };

  const updateAnnouncementAuthorization = async (enable: boolean) => {
    if (!adminUser || authorizingAnnouncements) return;
    if (enable && !confirmRealAnnouncementMessages) {
      setError("Explicit authorization for real School Announcements WhatsApp messages is required.");
      return;
    }
    setAuthorizingAnnouncements(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch<{
        success: boolean;
        settings: WhatsAppAdminSettings;
        message: string;
      }>("/api/admin/whatsapp/settings", adminUser, {
        method: "PUT",
        body: JSON.stringify({
          announcementDispatchAction: enable ? "enable" : "disable",
          ...(enable ? { confirmRealAnnouncementMessages: true } : {}),
        }),
      });
      setSettings(response.settings);
      setAnnouncementDispatchEnabled(response.settings.announcementDispatchEnabled === true);
      setConfirmRealAnnouncementMessages(false);
      setNotice(response.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "School Announcements authorization could not be updated.");
    } finally {
      setAuthorizingAnnouncements(false);
    }
  };

  const updateLibraryLinkAuthorization = async (enable: boolean) => {
    if (!adminUser || authorizingLibraryLinks) return;
    if (enable && !confirmRealLibraryLinkMessages) {
      setError("Explicit authorization for real Library Link WhatsApp messages is required.");
      return;
    }
    setAuthorizingLibraryLinks(true); setError(null); setNotice(null);
    try {
      const response = await adminFetch<{ success: boolean; settings: WhatsAppAdminSettings; message: string }>(
        "/api/admin/whatsapp/settings", adminUser, { method: "PUT", body: JSON.stringify({
          libraryLinkDispatchAction: enable ? "enable" : "disable",
          ...(enable ? { confirmRealLibraryLinkMessages: true } : {}),
        }) },
      );
      setSettings(response.settings);
      setLibraryLinkDispatchEnabled(response.settings.libraryLinkDispatchEnabled === true);
      setConfirmRealLibraryLinkMessages(false); setNotice(response.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Library Link WhatsApp authorization could not be updated.");
    } finally { setAuthorizingLibraryLinks(false); }
  };

  const saveTeacher = async (teacher: TeacherConnection) => {
    if (!adminUser) return;
    const draft = teacherDrafts[teacher.uid] || {
      phoneNumber: "",
      selected: false,
      appKey: "",
      authKey: "",
    };
    setSavingTeacher(teacher.uid);
    setError(null);
    setNotice(null);
    try {
      await adminFetch<ApiResult>(`/api/admin/whatsapp/teachers/${encodeURIComponent(teacher.uid)}`, adminUser, {
        method: "PUT",
        body: JSON.stringify({
          phoneNumber: draft.phoneNumber,
          selectedForPersonalRouting:
            draft.selected &&
            teacher.connectionStatus === "verified" &&
            !draft.appKey.trim() &&
            !draft.authKey.trim(),
          ...(draft.appKey.trim() && draft.authKey.trim()
            ? { appKey: draft.appKey.trim(), authKey: draft.authKey.trim() }
            : {}),
        }),
      });
      setNotice(`${teacher.name}'s personal WhatsApp settings were saved securely. Provider verification is still required.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Teacher WhatsApp settings could not be saved.");
    } finally {
      setSavingTeacher(null);
    }
  };

  const sendTeacherVerification = async (teacher: TeacherConnection) => {
    if (!adminUser || savingTeacher) return;

    const testRecipient = (teacherTestRecipients[teacher.uid] || "").trim();

    if (!testRecipient) {
      setError("Enter an approved test recipient number first.");
      return;
    }

    if (teacherTestConsents[teacher.uid] !== true) {
      setError("Confirm that the test recipient agreed to receive this test message.");
      return;
    }

    setSavingTeacher(teacher.uid);
    setError(null);
    setNotice(null);

    try {
      const response = await adminFetch<{
        success: boolean;
        message?: string;
      }>("/api/admin/whatsapp/test-connection", adminUser, {
        method: "POST",
        body: JSON.stringify({
          teacherUid: teacher.uid,
          testRecipient,
          confirmTestRecipient: true,
        }),
      });

      setTeacherTestConsents((current) => ({
        ...current,
        [teacher.uid]: false,
      }));

      await load();
      setNotice(
        typeof response.message === "string"
          ? response.message
          : "Verification test request completed.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Teacher sender verification test failed.",
      );
      await load();
    } finally {
      setSavingTeacher(null);
    }
  };

  const confirmTeacherTestReceived = async (teacher: TeacherConnection) => {
    if (!adminUser || savingTeacher) return;

    setSavingTeacher(teacher.uid);
    setError(null);
    setNotice(null);

    try {
      const response = await adminFetch<{
        success: boolean;
        message?: string;
      }>("/api/admin/whatsapp/confirm-test-received", adminUser, {
        method: "POST",
        body: JSON.stringify({
          teacherUid: teacher.uid,
          confirmReceived: true,
        }),
      });

      await load();
      setNotice(
        typeof response.message === "string"
          ? response.message
          : "Teacher sender verification confirmed.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Teacher verification confirmation failed.",
      );
    } finally {
      setSavingTeacher(null);
    }
  };

  const filteredTeachers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return teachers;
    return teachers.filter((teacher) => `${teacher.name} ${teacher.email} ${teacher.phoneNumber}`.toLowerCase().includes(query));
  }, [teachers, search]);

  const surface = localDark ? "border-slate-800 bg-[#0c1222] text-slate-100" : "border-slate-200 bg-white text-slate-900";
  const field = `mt-1.5 w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-orange-500 ${localDark ? "border-slate-700 bg-slate-950 text-slate-100" : "border-slate-200 bg-white text-slate-900"}`;
  const muted = localDark ? "text-slate-400" : "text-slate-500";
  const attendanceAuthorized =
    attendanceDispatchEnabled &&
    settings?.configurationStatus === "admin_authorized_unverified";

  const canAuthorizeAttendance = Boolean(
    settings?.credentialsConfigured &&
    settings.enabled &&
    enabled &&
    businessNumber.trim() === settings.businessNumber &&
    !appKey.trim() &&
    !authKey.trim() &&
    settings.attendanceDispatchServerEnabled &&
    !settings.attendanceDispatchEnabled &&
    !saving &&
    !loading &&
    !authorizingAttendance
  );

  const canAuthorizeMonthlyReports = Boolean(
    settings?.credentialsConfigured &&
    settings.enabled &&
    enabled &&
    businessNumber.trim() === settings.businessNumber &&
    !appKey.trim() &&
    !authKey.trim() &&
    settings.monthlyReportDispatchServerEnabled &&
    !monthlyReportDispatchEnabled &&
    !saving &&
    !loading &&
    !authorizingMonthlyReports
  );

  const credentialLabel = attendanceAuthorized
    ? "Attendance authorized · delivery unverified"
    : settings?.credentialsConfigured
      ? settings.enabled
        ? "Credentials saved · not delivery verified"
        : "Credentials saved · central connection off"
      : "Not configured";

  const credentialBadge = "border-amber-500/25 bg-amber-500/5 text-amber-600";

  if (!adminUser) {
    return <div className={`${card} ${surface}`}><p className="text-sm">Administrator sign-in is required to manage WhatsApp settings.</p></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-orange-500"><ShieldCheck size={14} /> Administration / WhatsApp Management</div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">WhatsApp Management</h1>
          <p className={`mt-2 text-sm ${muted}`}>Manage the central business number and teacher-specific number settings from one place.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold ${surface}`}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>
      </div>

      {error ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 text-sm text-rose-500"><AlertCircle size={17} className="mt-0.5 shrink-0" />{error}</div> : null}
      {notice ? <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm text-emerald-600"><CheckCircle2 size={17} className="mt-0.5 shrink-0" />{notice}</div> : null}

      <WhatsAppNumberScannerSettings adminUser={adminUser} localDark={localDark} />

      <section className={`${card} ${surface} space-y-5`}>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-emerald-500/10 p-3 text-emerald-500"><MessageCircle size={22} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold">Central Business WhatsApp</h2>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>Primary EduTrack business connection through the Postabi WhatsApp Web App API.</p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${credentialBadge}`}>{credentialLabel}</span>
        </div>

        {loading && !settings ? <div className={`flex items-center gap-2 text-sm ${muted}`}><Loader2 size={16} className="animate-spin" /> Loading settings…</div> : (
          <form onSubmit={saveCentral} className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-3">
              <label className="block text-xs font-semibold">Business WhatsApp number
                <input required value={businessNumber} onChange={(event) => setBusinessNumber(event.target.value)} className={field} placeholder="+92 3XX XXXXXXX" autoComplete="tel" />
              </label>
              <label className="block text-xs font-semibold">Postabi App Key
                <input type="password" value={appKey} onChange={(event) => setAppKey(event.target.value)} className={field} placeholder={settings?.appKeyConfigured ? "Saved securely — enter to replace" : "Enter App Key"} autoComplete="new-password" />
                <span className={`mt-1 block text-[11px] font-normal ${muted}`}>{settings?.appKeyConfigured ? "App Key is saved and never returned to this page." : "Encrypted before server-side storage."}</span>
              </label>
              <label className="block text-xs font-semibold">Postabi Auth Key
                <input type="password" value={authKey} onChange={(event) => setAuthKey(event.target.value)} className={field} placeholder={settings?.authKeyConfigured ? "Saved securely — enter to replace" : "Enter Auth Key"} autoComplete="new-password" />
                <span className={`mt-1 block text-[11px] font-normal ${muted}`}>{settings?.authKeyConfigured ? "Auth Key is saved and never returned to this page." : "Encrypted before server-side storage."}</span>
              </label>
            </div>
            <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="mt-0.5 accent-orange-500" />
              <span><strong>Enable central connection configuration</strong><span className={`mt-1 block font-normal ${muted}`}>This saves the intended provider setting only. It does not send messages or confirm that Postabi accepted the credentials.</span></span>
            </label>
            <div className="rounded-xl border border-slate-500/15 p-3 text-xs">
              <strong>Attendance alerts are managed separately</strong>
              <span className={`mt-1 block font-normal ${muted}`}>
                Saving central settings never authorizes or sends attendance messages. Use the separate attendance authorization control below.
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-500/15 pt-4">
              <div className={`flex items-center gap-2 text-xs ${muted}`}><KeyRound size={14} /> App Key and Auth Key are never returned after saving.</div>
              <button type="submit" disabled={saving || loading || authorizingAttendance || authorizingMonthlyReports} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {saving ? "Saving…" : "Save central settings"}
              </button>
            </div>
          </form>
        )}
        <div className={`rounded-xl border border-slate-500/15 p-4 space-y-3 ${localDark ? "bg-slate-950/50" : "bg-slate-50"}`}>
          <div>
            <h3 className="text-sm font-bold">Automatic Fee Alerts server readiness</h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              Fee Alerts run from the scheduled Vercel Cron at 08:00 Pakistan time. These checks show server configuration only; each teacher still needs an active Fee Alerts entitlement, enabled reminder dates, current guardian opt-in and a valid sender.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[
              { label: "Shared WhatsApp dispatch", ready: settings?.sharedWhatsAppDispatchServerEnabled === true },
              { label: "Fee Alerts dispatch", ready: settings?.feeAlertsDispatchServerEnabled === true },
              { label: "Vercel Cron secret", ready: settings?.cronSecretConfigured === true },
              { label: "Firebase Admin credentials", ready: settings?.firebaseAdminConfigured === true },
              { label: "Credential encryption key", ready: settings?.credentialsEncryptionKeyValid === true },
              { label: "Media signing secret", ready: settings?.mediaSigningSecretValid === true },
              { label: "Public app URL", ready: settings?.publicAppUrlValid === true },
              { label: "Central connection enabled", ready: settings?.enabled === true },
              { label: "Central Postabi credentials", ready: settings?.credentialsConfigured === true },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-3 rounded-lg border border-slate-500/15 px-3 py-2 text-xs">
                <span>{item.label}</span>
                <span className={`shrink-0 font-bold ${item.ready ? "text-emerald-500" : "text-rose-500"}`}>
                  {item.ready ? "READY" : "MISSING"}
                </span>
              </div>
            ))}
          </div>
          <p className={`text-[11px] leading-5 ${muted}`}>
            Missing server values must be added in Vercel Project Settings → Environment Variables, then redeployed. Do not paste secrets into this page. Provider acceptance is not delivery confirmation.
          </p>
        </div>

        <div className={`rounded-xl border border-slate-500/15 p-4 space-y-4 ${localDark ? "bg-slate-950/50" : "bg-slate-50"}`}>
          <div>
            <h3 className="text-sm font-bold">Attendance WhatsApp authorization</h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              This permission applies only to normal attendance alerts for guardians with active, explicit attendance-specific consent and a matching current contact number. Monthly PDF messages remain disabled.
            </p>
          </div>

          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5">
            <strong>Important: real messages may be sent.</strong>
            <p className="mt-1">
              After authorization, saving an eligible absent attendance record through the normal teacher workflow may send a real WhatsApp message to its opted-in guardian. This authorization does not test Postabi credentials or guarantee WhatsApp delivery.
            </p>
          </div>

          <div className="space-y-1 text-xs">
            <p className="font-semibold">
              Authorization status: {attendanceAuthorized
                ? "Admin authorized · provider and delivery unverified"
                : settings?.attendanceDispatchEnabled
                  ? "Legacy setting present · not accepted as valid authorization"
                  : "Not authorized"}
            </p>
            <p className={muted}>
              {settings?.attendanceDispatchServerEnabled
                ? "Server-side attendance dispatch switch is ON."
                : "Server-side attendance dispatch switch is OFF. Authorization and dispatch are blocked."}
            </p>
            {settings?.attendanceDispatchEnabled && !attendanceAuthorized ? (
              <p className="text-amber-600">
                Disable the legacy setting below before creating a fresh authorization.
              </p>
            ) : null}
          </div>

          {!settings?.attendanceDispatchEnabled ? (
            <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs">
              <input
                type="checkbox"
                checked={confirmRealGuardianMessages}
                onChange={(event) => setConfirmRealGuardianMessages(event.target.checked)}
                disabled={authorizingAttendance || loading || saving}
                className="mt-0.5 accent-orange-500"
              />
              <span>
                I explicitly authorize real WhatsApp attendance alerts to guardians whose current contact number has active, recorded attendance-specific consent. I understand that a normal attendance save may send a real message.
              </span>
            </label>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs ${muted}`}>
              Scope: attendance alerts only · Provider: Postabi Web App
            </span>

            {settings?.attendanceDispatchEnabled ? (
              <button
                type="button"
                onClick={() => void updateAttendanceAuthorization(false)}
                disabled={authorizingAttendance || loading || saving}
                className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-2.5 text-xs font-bold text-rose-600 disabled:opacity-50"
              >
                {authorizingAttendance
                  ? <Loader2 size={14} className="animate-spin" />
                  : <WifiOff size={14} />}
                Disable attendance alerts
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void updateAttendanceAuthorization(true)}
                disabled={!canAuthorizeAttendance || !confirmRealGuardianMessages}
                className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40"
              >
                {authorizingAttendance
                  ? <Loader2 size={14} className="animate-spin" />
                  : <ShieldCheck size={14} />}
                {authorizingAttendance ? "Authorizing…" : "Authorize real attendance alerts"}
              </button>
            )}
          </div>
        </div>
        <div className={`rounded-xl border border-slate-500/15 p-4 space-y-4 ${localDark ? "bg-slate-950/50" : "bg-slate-50"}`}>
          <div>
            <h3 className="text-sm font-bold">Monthly PDF WhatsApp authorization</h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              This permission is separate from attendance alerts. It applies only to monthly PDF reports for guardians with current, explicit monthly-report WhatsApp consent.
            </p>
          </div>

          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5">
            <strong>Important: real PDF reports may be sent.</strong>
            <p className="mt-1">
              After authorization, a future eligible teacher action may send a student's monthly PDF report to its opted-in guardian. This authorization does not send a test, does not itself dispatch a PDF, and does not confirm WhatsApp delivery.
            </p>
          </div>

          <div className="space-y-1 text-xs">
            <p className="font-semibold">
              Authorization status: {monthlyReportDispatchEnabled
                ? "Admin authorized · provider and delivery unverified"
                : "Not authorized"}
            </p>
            <p className={muted}>
              {settings?.monthlyReportDispatchServerEnabled
                ? "Monthly report server feature flags are ON."
                : "Monthly report server feature flags are OFF. Authorization and dispatch are blocked."}
            </p>
          </div>

          {!monthlyReportDispatchEnabled ? (
            <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs">
              <input
                type="checkbox"
                checked={confirmRealMonthlyReports}
                onChange={(event) => setConfirmRealMonthlyReports(event.target.checked)}
                disabled={authorizingMonthlyReports || loading || saving}
                className="mt-0.5 accent-orange-500"
              />
              <span>
                I explicitly authorize real monthly PDF WhatsApp messages only for guardians with current, recorded monthly-report WhatsApp consent. I understand that a future teacher action may send a real student report PDF.
              </span>
            </label>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs ${muted}`}>
              Scope: monthly PDF reports only · Provider: Postabi Web App
            </span>

            {monthlyReportDispatchEnabled ? (
              <button
                type="button"
                onClick={() => void updateMonthlyReportAuthorization(false)}
                disabled={authorizingMonthlyReports || loading || saving}
                className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-2.5 text-xs font-bold text-rose-600 disabled:opacity-50"
              >
                {authorizingMonthlyReports
                  ? <Loader2 size={14} className="animate-spin" />
                  : <WifiOff size={14} />}
                Disable monthly PDF messages
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void updateMonthlyReportAuthorization(true)}
                disabled={
                  !canAuthorizeMonthlyReports ||
                  !confirmRealMonthlyReports
                }
                className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40"
              >
                {authorizingMonthlyReports
                  ? <Loader2 size={14} className="animate-spin" />
                  : <ShieldCheck size={14} />}
                {authorizingMonthlyReports
                  ? "Authorizing…"
                  : "Authorize monthly PDF messages"}
              </button>
            )}
          </div>
        </div>
        <div className={`rounded-xl border border-slate-500/15 p-4 space-y-4 ${localDark ? "bg-slate-950/50" : "bg-slate-50"}`}>
          <div>
            <h3 className="text-sm font-bold">Quiz Results WhatsApp authorization</h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              This permission is separate from attendance alerts and monthly PDF reports. It applies only to quiz marks sent to guardians with current, explicit Quiz Results consent for the exact saved WhatsApp number.
            </p>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5">
            <strong>Important: real student results may be sent.</strong>
            <p className="mt-1">After authorization, a teacher's explicit Publish Results &amp; Notify Parents action may send each opted-in guardian their own student's saved quiz marks. This authorization does not itself send a message and provider acceptance is not delivery confirmation.</p>
          </div>
          <div className="space-y-1 text-xs">
            <p className="font-semibold">Authorization status: {quizResultsDispatchEnabled ? "Admin authorized · provider and delivery unverified" : "Not authorized"}</p>
            <p className={muted}>{settings?.quizResultsDispatchServerEnabled ? "Server-side WhatsApp dispatch switch is ON." : "Server-side WHATSAPP_DISPATCH_ENABLED flag is OFF. Authorization and dispatch are blocked."}</p>
          </div>
          {!quizResultsDispatchEnabled ? (
            <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs">
              <input type="checkbox" checked={confirmRealQuizResultMessages} onChange={(event) => setConfirmRealQuizResultMessages(event.target.checked)} disabled={authorizingQuizResults || loading || saving} className="mt-0.5 accent-orange-500" />
              <span>I explicitly authorize real Quiz Results WhatsApp messages only to guardians with current, recorded Quiz Results consent for the matching saved contact number. I understand that teachers must explicitly publish results before messages are sent.</span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs ${muted}`}>Scope: quiz results only · Provider: Postabi Web App</span>
            {quizResultsDispatchEnabled ? (
              <button type="button" onClick={() => void updateQuizResultsAuthorization(false)} disabled={authorizingQuizResults || loading || saving} className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-2.5 text-xs font-bold text-rose-600 disabled:opacity-50">
                {authorizingQuizResults ? <Loader2 size={14} className="animate-spin" /> : <WifiOff size={14} />} Disable quiz-result messages
              </button>
            ) : (
              <button type="button" onClick={() => void updateQuizResultsAuthorization(true)} disabled={!settings?.enabled || !settings?.credentialsConfigured || !settings?.quizResultsDispatchServerEnabled || !confirmRealQuizResultMessages || authorizingQuizResults || loading || saving} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40">
                {authorizingQuizResults ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} {authorizingQuizResults ? "Authorizing…" : "Authorize Quiz Results messages"}
              </button>
            )}
          </div>
        </div>
        <div className={`rounded-xl border border-slate-500/15 p-4 space-y-4 ${localDark ? "bg-slate-950/50" : "bg-slate-50"}`}>
          <div>
            <h3 className="text-sm font-bold">School Announcements WhatsApp authorization</h3>
            <p className={`mt-1 text-xs leading-5 ${muted}`}>
              This is a separate permission for the existing Broadcast New Alert screen on the teacher workspace. It applies only to the Announcements category and current guardian consent for the exact saved phone number. The Admin page authorizes dispatch; it does not compose or send the announcement.
            </p>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5">
            <strong>Important: real school announcements may be sent to parents or guardians.</strong>
            <p className="mt-1">A teacher explicitly saves an Announcement and starts the WhatsApp broadcast from Broadcast New Alert. Only guardians who have separately opted in for School Announcements are eligible. Fee, Attendance, and Exam categories are excluded. Provider acceptance is not proof of delivery.</p>
          </div>
          <div className="space-y-1 text-xs">
            <p className="font-semibold">Authorization status: {announcementDispatchEnabled ? "Admin authorized · provider and delivery unverified" : "Not authorized"}</p>
            <p className={muted}>{settings?.announcementDispatchServerEnabled ? "Server-side WHATSAPP_DISPATCH_ENABLED and WHATSAPP_ANNOUNCEMENTS_ENABLED switches are ON." : "Server-side announcement feature switches are OFF. Authorization and dispatch are blocked."}</p>
          </div>
          {!announcementDispatchEnabled ? (
            <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs">
              <input type="checkbox" checked={confirmRealAnnouncementMessages} onChange={(event) => setConfirmRealAnnouncementMessages(event.target.checked)} disabled={authorizingAnnouncements || loading || saving} className="mt-0.5 accent-orange-500" />
              <span>I explicitly authorize real school Announcement WhatsApp messages only to guardians with current, recorded School Announcements consent for the matching saved contact number. Teachers must initiate each broadcast from Broadcast New Alert.</span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs ${muted}`}>Scope: Announcements only · Consent-based · Provider: Postabi Web App</span>
            {announcementDispatchEnabled ? (
              <button type="button" onClick={() => void updateAnnouncementAuthorization(false)} disabled={authorizingAnnouncements || loading || saving} className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-2.5 text-xs font-bold text-rose-600 disabled:opacity-50">
                {authorizingAnnouncements ? <Loader2 size={14} className="animate-spin" /> : <WifiOff size={14} />} Disable announcement messages
              </button>
            ) : (
              <button type="button" onClick={() => void updateAnnouncementAuthorization(true)} disabled={!settings?.enabled || !settings?.credentialsConfigured || !settings?.announcementDispatchServerEnabled || !confirmRealAnnouncementMessages || authorizingAnnouncements || loading || saving} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40">
                {authorizingAnnouncements ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} {authorizingAnnouncements ? "Authorizing…" : "Authorize school announcement messages"}
              </button>
            )}
          </div>
        </div>
        <div className={`rounded-xl border border-slate-500/15 p-4 space-y-4 ${localDark ? "bg-slate-950/50" : "bg-slate-50"}`}>
          <div><h3 className="text-sm font-bold">Notes &amp; Library resource-link WhatsApp authorization</h3><p className={`mt-1 text-xs leading-5 ${muted}`}>After a resource is saved, its share link is automatically sent only to guardians whose separate Library Link consent is current and matches the exact saved phone number. Duplicate upload reconciliation is idempotent.</p></div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5"><strong>Real messages may be sent to guardians.</strong><p className="mt-1">Authorization does not send a message. Provider acceptance is not proof of delivery. Teachers must also have the Library Link WhatsApp feature in their plan.</p></div>
          <div className="space-y-1 text-xs"><p className="font-semibold">Authorization status: {libraryLinkDispatchEnabled ? "Admin authorized · delivery unverified" : "Not authorized"}</p><p className={muted}>{settings?.libraryLinkDispatchServerEnabled ? "Server-side Library Link dispatch switches are ON." : "Server-side WHATSAPP_DISPATCH_ENABLED and WHATSAPP_LIBRARY_LINKS_ENABLED switches are OFF."}</p></div>
          {!libraryLinkDispatchEnabled ? <label className="flex items-start gap-3 rounded-xl border border-slate-500/15 p-3 text-xs"><input type="checkbox" checked={confirmRealLibraryLinkMessages} onChange={(event) => setConfirmRealLibraryLinkMessages(event.target.checked)} disabled={authorizingLibraryLinks || loading || saving} className="mt-0.5 accent-orange-500"/><span>I explicitly authorize real Library resource-link WhatsApp messages only to guardians with current, separate consent for the matching saved phone number.</span></label> : null}
          <div className="flex flex-wrap items-center justify-between gap-3"><span className={`text-xs ${muted}`}>Scope: Library links only · Explicit guardian consent · Postabi Web App</span>{libraryLinkDispatchEnabled ? <button type="button" onClick={() => void updateLibraryLinkAuthorization(false)} disabled={authorizingLibraryLinks || loading || saving} className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-2.5 text-xs font-bold text-rose-600 disabled:opacity-50">{authorizingLibraryLinks ? <Loader2 size={14} className="animate-spin"/> : <WifiOff size={14}/>} Disable Library Link messages</button> : <button type="button" onClick={() => void updateLibraryLinkAuthorization(true)} disabled={!settings?.enabled || !settings?.credentialsConfigured || !settings?.libraryLinkDispatchServerEnabled || !confirmRealLibraryLinkMessages || authorizingLibraryLinks || loading || saving} className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40">{authorizingLibraryLinks ? <Loader2 size={14} className="animate-spin"/> : <ShieldCheck size={14}/>} Authorize Library Link messages</button>}</div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className={`rounded-xl p-3 ${localDark ? "bg-slate-950" : "bg-slate-50"}`}><p className={`text-[10px] uppercase ${muted}`}>Provider</p><p className="mt-1 text-sm font-bold">Postabi Web App</p></div>
          <div className={`rounded-xl p-3 ${localDark ? "bg-slate-950" : "bg-slate-50"}`}><p className={`text-[10px] uppercase ${muted}`}>Credentials</p><p className="mt-1 text-sm font-bold">{settings?.credentialsConfigured ? "App Key + Auth Key saved" : "Not configured"}</p></div>
          <div className={`rounded-xl p-3 ${localDark ? "bg-slate-950" : "bg-slate-50"}`}><p className={`text-[10px] uppercase ${muted}`}>General message sending</p><p className="mt-1 text-sm font-bold">Not activated</p></div>
        </div>
      </section>

      <section className={`${card} ${surface} space-y-4`}>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3"><div className="rounded-xl bg-blue-500/10 p-3 text-blue-500"><Users size={22} /></div><div><h2 className="text-base font-bold">Teacher Personal WhatsApp Numbers</h2><p className={`mt-1 text-xs ${muted}`}>Save a separate number for each teacher. Sessions are not connected by this screen.</p></div></div>
          <span className={`text-xs ${muted}`}>{teachers.length} teacher accounts</span>
        </div>
        <label className="block text-xs font-semibold">Search teachers<input value={search} onChange={(event) => setSearch(event.target.value)} className={field} placeholder="Search name, email or WhatsApp number" /></label>
        {teacherListWarning ? <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">{teacherListWarning}</div> : null}
        {loading ? <div className={`flex items-center gap-2 py-5 text-sm ${muted}`}><Loader2 size={16} className="animate-spin" /> Loading teacher list…</div> : filteredTeachers.length === 0 ? <div className={`rounded-xl border border-dashed border-slate-500/25 p-6 text-center text-sm ${muted}`}><WifiOff size={20} className="mx-auto mb-2" />No teacher accounts found for this search.</div> : (
          <div className="space-y-3">
            {filteredTeachers.map((teacher) => {
              const draft = teacherDrafts[teacher.uid] || {
                phoneNumber: teacher.phoneNumber,
                selected: teacher.selectedForPersonalRouting,
                appKey: "",
                authKey: "",
              };
              return <div key={teacher.uid} className={`grid gap-3 rounded-xl border p-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)_minmax(260px,1fr)_auto] lg:items-center ${localDark ? "border-slate-800 bg-slate-950/60" : "border-slate-200 bg-slate-50"}`}>
                <div className="min-w-0"><p className="truncate text-sm font-bold">{teacher.name}</p><p className={`truncate text-xs ${muted}`}>{teacher.email}</p><p className={`mt-1 text-[10px] ${muted}`}>
                  {teacher.connectionStatus === "verified"
                    ? "Provider sender verified"
                    : teacher.hasPersonalCredentials
                      ? "Credentials saved · not verified"
                      : teacher.phoneNumber
                        ? "Number saved · credentials missing"
                        : "No personal sender configured"}
                </p></div>
                <div>
                  <label className="block text-[10px] font-semibold">
                    Personal WhatsApp number
                    <input
                      value={draft.phoneNumber}
                      onChange={(event) => setTeacherDrafts((current) => ({
                        ...current,
                        [teacher.uid]: { ...draft, phoneNumber: event.target.value },
                      }))}
                      className={field}
                      placeholder="+92 3XX XXXXXXX"
                      autoComplete="tel"
                    />
                  </label>
                  <label className={`mt-2 flex items-center gap-2 text-[11px] ${muted}`}>
                    <input
                      type="checkbox"
                      checked={draft.selected}
                      disabled={!draft.phoneNumber.trim() || !(
                        teacher.hasPersonalCredentials ||
                        (draft.appKey.trim() && draft.authKey.trim())
                      )}
                      onChange={(event) => setTeacherDrafts((current) => ({
                        ...current,
                        [teacher.uid]: { ...draft, selected: event.target.checked },
                      }))}
                      className="accent-orange-500"
                    />
                    Select for personal routing after verification
                  </label>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-[10px] font-semibold">
                    Personal Postabi App Key
                    <input
                      type="password"
                      value={draft.appKey}
                      onChange={(event) => setTeacherDrafts((current) => ({
                        ...current,
                        [teacher.uid]: { ...draft, appKey: event.target.value },
                      }))}
                      className={field}
                      placeholder={teacher.hasPersonalCredentials ? "Saved — enter to replace" : "Enter App Key"}
                      autoComplete="new-password"
                    />
                  </label>
                  <label className="block text-[10px] font-semibold">
                    Personal Postabi Auth Key
                    <input
                      type="password"
                      value={draft.authKey}
                      onChange={(event) => setTeacherDrafts((current) => ({
                        ...current,
                        [teacher.uid]: { ...draft, authKey: event.target.value },
                      }))}
                      className={field}
                      placeholder={teacher.hasPersonalCredentials ? "Saved — enter to replace" : "Enter Auth Key"}
                      autoComplete="new-password"
                    />
                  </label>
                  <p className={`sm:col-span-2 text-[10px] ${muted}`}>
                    Leave both fields blank to keep saved credentials. Enter both to replace them.
                  </p>
                </div>
                <button type="button" disabled={savingTeacher === teacher.uid} onClick={() => void saveTeacher(teacher)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-500/20 px-3 py-2.5 text-xs font-bold hover:border-orange-500/50 disabled:opacity-50">{savingTeacher === teacher.uid ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save settings</button>
                <div className="col-span-full space-y-3 rounded-xl border border-slate-500/15 p-3">
                  <div>
                    <p className="text-xs font-bold">Verify personal sender</p>
                    <p className={`mt-1 text-[10px] ${muted}`}>
                      A fixed test message will be sent only to the approved test recipient below.
                      No student or guardian data is included.
                    </p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                    <label className="block text-[10px] font-semibold">
                      Approved test recipient number
                      <input
                        value={teacherTestRecipients[teacher.uid] || ""}
                        onChange={(event) => setTeacherTestRecipients((current) => ({
                          ...current,
                          [teacher.uid]: event.target.value,
                        }))}
                        className={field}
                        placeholder="+92 3XX XXXXXXX"
                        autoComplete="tel"
                      />
                    </label>

                    <button
                      type="button"
                      disabled={
                        savingTeacher === teacher.uid ||
                        !teacher.hasPersonalCredentials ||
                        !teacherTestRecipients[teacher.uid]?.trim() ||
                        teacherTestConsents[teacher.uid] !== true ||
                        teacher.testStatus === "dispatching" ||
                        teacher.testStatus === "awaiting_receipt" ||
                        teacher.testStatus === "unknown_outcome"
                      }
                      onClick={() => void sendTeacherVerification(teacher)}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-bold text-white disabled:opacity-40"
                    >
                      {savingTeacher === teacher.uid
                        ? <Loader2 size={13} className="animate-spin" />
                        : <MessageCircle size={13} />}
                      Send verification test
                    </button>
                  </div>

                  <label className={`flex items-start gap-2 text-[11px] ${muted}`}>
                    <input
                      type="checkbox"
                      checked={teacherTestConsents[teacher.uid] === true}
                      onChange={(event) => setTeacherTestConsents((current) => ({
                        ...current,
                        [teacher.uid]: event.target.checked,
                      }))}
                      className="mt-0.5 accent-orange-500"
                    />
                    I confirm the test recipient owns this number or has explicitly agreed to receive this one test message.
                  </label>

                  {teacher.testStatus === "awaiting_receipt" ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        Postabi accepted the test and the sender number matched. Confirm only after the recipient actually receives it.
                        {teacher.testRecipientLast4
                          ? ` Test recipient ending ${teacher.testRecipientLast4}.`
                          : ""}
                      </p>
                      <button
                        type="button"
                        disabled={savingTeacher === teacher.uid}
                        onClick={() => void confirmTeacherTestReceived(teacher)}
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 px-3 py-2 text-xs font-bold text-emerald-600 disabled:opacity-50"
                      >
                        {savingTeacher === teacher.uid
                          ? <Loader2 size={13} className="animate-spin" />
                          : <CheckCircle2 size={13} />}
                        I received the test
                      </button>
                    </div>
                  ) : null}

                  {teacher.testStatus === "unknown_outcome" ? (
                    <p className="text-[11px] text-rose-600">
                      Test outcome is unknown. Do not send another test until the provider dashboard and recipient are checked.
                    </p>
                  ) : null}

                  {teacher.connectionStatus === "verified" ? (
                    <p className="text-[11px] text-emerald-600">
                      Sender verified. Personal routing can now be enabled and saved by the administrator.
                      {teacher.providerFromLast4
                        ? ` Verified sender ends ${teacher.providerFromLast4}.`
                        : ""}
                    </p>
                  ) : null}
                </div>
              </div>;
            })}
          </div>
        )}
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-xs leading-5 text-blue-700 dark:text-blue-300">
          <strong>Sender choice:</strong> Leave personal routing unchecked to send eligible messages through the central EduTrack business number. To use a teacher's own number, configure that teacher's separate Postabi App Key and Auth Key, send the consented test to an approved recipient, confirm actual receipt, and then enable personal routing. Saving a phone number alone does not connect a WhatsApp session. QR session creation is not provided by this screen.
        </div>
      </section>

      <p className={`text-[11px] leading-5 ${muted}`}>Security: settings and authorization endpoints require a verified administrator Firebase ID token. App Key and Auth Key are encrypted with a server-only key and are never returned to the browser. Attendance alerts and monthly PDF reports have separate administrator authorization and independent server-side feature flags. Authorization does not verify provider delivery.</p>
    </div>
  );
}
