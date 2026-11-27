/**
 * Admin Customer Management page.
 *
 * Directory reads and mutations use authenticated Vercel API routes.
 * The browser sends the signed-in Firebase ID token; the server verifies
 * administrator access and performs protected Firebase Admin SDK operations.
 * Customer archive is reversible and preserves academic workspace data.
 * Passwords are never created, stored or displayed by this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft, BookOpen, Check, CheckCircle2, CircleAlert, Clock3, Edit3, Filter, KeyRound, Loader2, Mail,
  MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck, Eye, Pencil, Users, UserRoundPlus, UserX, X,
  Sun, Moon, Archive, CalendarDays, Copy,
} from "lucide-react";
import { onAuthStateChanged, type Auth, type User } from "firebase/auth";
import * as firebaseModule from "@/lib/firebase";

/* ------------------------------------------------------------------ */
/* Firebase instances (reused from src/lib/firebase.ts)               */
/* ------------------------------------------------------------------ */
const fbx = firebaseModule as unknown as Record<string, unknown>;
const firebaseAuth = fbx.auth as Auth;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
type ApprovalStatus = "pending" | "approved" | "rejected" | "legacy";
type CustomerStatus = "active" | "disabled" | "inactive" | "deleted";

interface CustomerGroup {
  id: string;
  name: string;
  normalizedName?: string;
  description?: string;
  archived?: boolean;
  status?: "active" | "archived";
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface Customer {
  id: string; // = Firebase Auth UID (document id of the managedCustomers record)
  uid?: string;
  email: string;
  name: string;
  phone?: string;
  whatsapp?: string;
  groupId?: string | null;
  groupName?: string | null;
  profileDocId?: string | null;
  role?: string;
  active?: boolean;
  disabled?: boolean;
  emailVerified?: boolean | null;
  approvalStatus?: ApprovalStatus | string;
  registrationSource?: "self_registered" | "admin_created" | "legacy" | string;
  createdAt?: unknown;
  classCount?: number | null;
  studentCount?: number | null;
  deleted?: boolean;
  planName?: string | null;
  subscriptionStatus?: string;
  accessMode?: string;
  featureVisibilityMode?: 'hide' | 'locked';
  activeAddOns?: Array<{ id: string; name: string; featureKeys: string[]; expiresAt: string | null }>;
  pendingAddOnRequests?: Array<{ id: string; featureKey: string; featureName: string; status: string }>;
}

type ViewKey = "all" | "pending" | "active" | "disabled" | "unassigned" | "unverified" | "deleted";
type ConfirmType = "approve" | "disable" | "enable" | "reset" | "reject" | "delete" | "restore";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
type CustomerDirectoryResponse = {
  customers?: Customer[];
  groups?: CustomerGroup[];
  coverage?: { hasMoreTeachers?: boolean; warnings?: string[] };
};

const requestCustomerApi = async <T,>(
  currentUser: User | null,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<T> => {
  if (!currentUser) throw new Error("Your administrator session is unavailable. Sign in again.");
  const token = await currentUser.getIdToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error
      : typeof payload.message === "string" ? payload.message
      : `Customer API request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
};

/** Normalises Firestore Timestamp / ISO string / millis / {seconds} into millis. */
const dateValue = (value: unknown): number => {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "object" && value !== null) {
    const v = value as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v.seconds === "number") return v.seconds * 1000;
    if (typeof v._seconds === "number") return v._seconds * 1000;
  }
  return 0;
};

const formatDate = (value: unknown) => {
  const time = dateValue(value);
  return time ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(time) : "—";
};

/** Pending / approved / rejected stay distinct. Records without a status are legacy accounts. */
const approvalOf = (c: Customer): ApprovalStatus => {
  const s = String(c.approvalStatus ?? "").toLowerCase();
  if (s === "pending" || s === "approved" || s === "rejected") return s;
  return "legacy";
};

/** active = approved (or legacy) AND not disabled AND not flagged inactive. Disabled ≠ rejected ≠ pending. */
const statusOf = (c: Customer): CustomerStatus => {
  if (c.deleted === true) return "deleted";
  if (c.disabled === true) return "disabled";
  const a = approvalOf(c);
  if (a === "pending" || a === "rejected" || c.active === false) return "inactive";
  return "active";
};

const sourceLabel = (c: Customer) =>
  c.registrationSource === "admin_created" ? "Admin-created"
    : c.registrationSource === "self_registered" ? "Self-registered" : "Existing account";

const errorMessage = (error: unknown): string => {
  const code = String((error as { code?: string })?.code ?? "");
  const message = (error as { message?: string })?.message;
  if (code.includes("unauthenticated")) return "Your session has expired. Sign in again.";
  if (code.includes("permission-denied")) return "You do not have permission to perform this action (administrator access is required).";
  if (code.includes("already-exists")) return message || "A customer or group with these details already exists.";
  if (code.includes("not-found")) return message || "This record could not be found. Refresh and try again.";
  if (code.includes("unavailable") || code.includes("deadline-exceeded")) return "Network issue. Check your connection and retry.";
  if (code.includes("failed-precondition") || code.includes("invalid-argument")) return message || "This action is not allowed in the current state.";
  if (code.includes("auth/user-not-found") || code.includes("auth/invalid-email")) return "Firebase could not complete the reset request for this address. Check the address and account state, then retry.";
  if (code.includes("auth/too-many-requests")) return "Too many password-reset attempts. Wait a little before trying again.";
  if (code.includes("auth/network-request-failed")) return "Network issue while requesting the email. Check your connection and retry.";
  if (code.includes("auth/operation-not-allowed")) return "Password-reset email is not enabled in the Firebase Authentication configuration.";
  return message || "Something went wrong. Please try again.";
};

/* ------------------------------------------------------------------ */
/* Shared class names – every one sets an explicit text colour for     */
/* light AND dark mode (fixes the invisible-text dark-mode problem).   */
/* ------------------------------------------------------------------ */
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900";
const TEXT = "text-slate-900 dark:text-slate-100";
const MUTED = "text-slate-500 dark:text-slate-400";
const CARD = "rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-sm dark:border-slate-700 dark:bg-[#0c1222] dark:text-slate-100";
const SUBCARD = "rounded-xl border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100";
const TILE = "rounded-lg bg-slate-50 p-3 text-slate-900 dark:bg-slate-800/70 dark:text-slate-100";
const BTN = `inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 ${FOCUS}`;
const BTN_PRIMARY = `inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-orange-500/20 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const BTN_DANGER = `inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const ICON_BTN = `rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 ${FOCUS}`;
const INPUT = `mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-orange-400 focus:ring-4 focus:ring-orange-500/15 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500`;
const SELECT_SM = `rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 ${FOCUS}`;
const MENU_ITEM = `flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-100 dark:hover:bg-slate-800 ${FOCUS}`;

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                    */
/* ------------------------------------------------------------------ */
function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "green" | "amber" | "rose" | "blue" | "slate" }) {
  const colors = {
    green: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
    amber: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
    rose: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
    blue: "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
    slate: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200",
  };
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${colors[tone]}`}>{children}</span>;
}

function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  // Escape closes the dialog (keyboard accessibility).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm" role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title}
        className="my-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-[#0c1222] dark:text-slate-100 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{title}</h2>
            {description && <p className={`mt-1 break-words text-sm ${MUTED}`}>{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Close dialog" className={ICON_BTN}><X size={18} /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

const PHONE_RE = /^\+?[0-9\s\-()]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */
export default function Customers() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [directoryWarning, setDirectoryWarning] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewKey>("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [sort, setSort] = useState("name-asc");
  const [page, setPage] = useState(1);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const pageSize = 10;

  const [groupModal, setGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<CustomerGroup | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [archiveGroupConfirm, setArchiveGroupConfirm] = useState<CustomerGroup | null>(null);

  const [customerModal, setCustomerModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [viewingCustomer, setViewingCustomer] = useState<Customer | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerWhatsapp, setCustomerWhatsapp] = useState("");
  const [customerGroup, setCustomerGroup] = useState("");

  const [confirmAction, setConfirmAction] = useState<{ type: ConfirmType; customer: Customer } | null>(null);
  const [approvalGroup, setApprovalGroup] = useState("");

  // Synchronous guard against double-submits (state updates are async, a ref is not).
  const inFlight = useRef(false);
  const activeGroups = useMemo(() => groups.filter((g) => !g.archived), [groups]);

  /* ---------------- Theme: follow the application-wide `dark` class ---------------- */
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDarkMode(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync); // stay in sync with the navbar's theme toggle
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const toggleTheme = () => {
    const root = document.documentElement;
    root.classList.toggle("dark", !root.classList.contains("dark"));
  };

  /* ---------------- Auth + Vercel customer API ---------------- */
  useEffect(() => onAuthStateChanged(firebaseAuth, (next) => {
    setUser(next);
    setAuthLoading(false);
    if (!next) {
      setCustomers([]);
      setGroups([]);
      setLoading(false);
      setError("Sign in with your administrator account to manage customers.");
    } else {
      setError("");
    }
  }), []);

  const refreshDirectory = useCallback(async () => {
    const result = await requestCustomerApi<CustomerDirectoryResponse>(
      user,
      "/api/admin/customers",
    );
    setCustomers(Array.isArray(result.customers) ? result.customers : []);
    setGroups(Array.isArray(result.groups) ? result.groups : []);
    setDirectoryWarning(Array.isArray(result.coverage?.warnings) ? result.coverage.warnings.join(" ") : "");
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void refreshDirectory()
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [user, refreshDirectory]);

  /* GET /api/admin/customers refreshes the authenticated directory and its registry. */
  const runSync = useCallback(async (force: boolean) => {
    setSyncing(true);
    setError("");
    try {
      await refreshDirectory();
      if (force) setNotice("Customer directory refreshed from Firebase Authentication and teacher workspaces.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }, [refreshDirectory]);

  /* ---------------- Derived data ---------------- */
  const groupNameOf = useCallback((c: Customer) => groups.find((g) => g.id === c.groupId)?.name ?? c.groupName ?? "", [groups]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = customers.filter((c) => {
      if (needle && ![c.name, c.email, c.phone, c.whatsapp, groupNameOf(c)].some((v) => String(v ?? "").toLowerCase().includes(needle))) return false;
      if (groupFilter !== "all" && c.groupId !== groupFilter) return false;
      if (view === "pending" && approvalOf(c) !== "pending") return false;
      if (view === "active" && statusOf(c) !== "active") return false;
      if (view === "disabled" && statusOf(c) !== "disabled") return false;
      if (view === "deleted" && statusOf(c) !== "deleted") return false;
      if (view !== "deleted" && c.deleted === true && view !== "all") return false;
      if (view === "unassigned" && c.groupId) return false;
      if (view === "unverified" && c.emailVerified === true) return false;
      return true;
    });
    return [...rows].sort((a, b) => {
      if (sort === "name-desc") return (b.name || "").localeCompare(a.name || "");
      if (sort === "date-desc") return dateValue(b.createdAt) - dateValue(a.createdAt);
      if (sort === "group-asc") return groupNameOf(a).localeCompare(groupNameOf(b));
      if (sort === "classes-desc") return (b.classCount ?? 0) - (a.classCount ?? 0);
      if (sort === "students-desc") return (b.studentCount ?? 0) - (a.studentCount ?? 0);
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [customers, search, view, groupFilter, sort, groupNameOf]);

  useEffect(() => setPage(1), [search, view, groupFilter, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Registry documents are keyed by Auth UID, so these count unique identities (not memberships).
  const pendingCount = customers.filter((c) => approvalOf(c) === "pending").length;
  const activeCount = customers.filter((c) => statusOf(c) === "active").length;
  const disabledCount = customers.filter((c) => statusOf(c) === "disabled").length;
  const studentsReliable = customers.every((c) => typeof c.studentCount === "number" && Number.isFinite(c.studentCount));
  const studentTotal = studentsReliable ? customers.reduce((s, c) => s + Math.max(0, Number(c.studentCount)), 0) : null;

  /* ---------------- Mutations (backend first; UI follows via listeners) ---------------- */
  /** Runs one backend operation with duplicate-submit prevention and real success/error reporting. */
  const guarded = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(errorMessage(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const saveGroup = (event: FormEvent) => {
    event.preventDefault();
    const name = groupName.trim();
    if (!name) { setError("Group name is required."); return; }
    if (name.length > 80) { setError("Group name must be 80 characters or fewer."); return; }
    void guarded(async () => {
      await requestCustomerApi(user, "/api/admin/customer-groups", "POST", {
        action: "save", groupId: editingGroup?.id ?? null, name, description: groupDescription.trim(),
      });
      await refreshDirectory();
      setGroupModal(false); setEditingGroup(null); setGroupName(""); setGroupDescription("");
      setNotice(editingGroup ? "Group updated successfully." : "Group created successfully.");
    });
  };

  const saveCustomer = (event: FormEvent) => {
    event.preventDefault();
    const name = customerName.trim();
    const email = customerEmail.trim().toLowerCase();
    const phone = customerPhone.trim();
    const whatsapp = customerWhatsapp.trim();
    if (name.length < 2) { setError("Enter the customer's full name."); return; }
    if (!EMAIL_RE.test(email)) { setError("Enter a valid email address."); return; }
    if (phone && !PHONE_RE.test(phone)) { setError("Enter a valid phone number (digits, +, spaces, dashes)."); return; }
    if (whatsapp && !PHONE_RE.test(whatsapp)) { setError("Enter a valid WhatsApp number (digits, +, spaces, dashes)."); return; }
    if (!editingCustomer && !customerGroup) { setError("Choose a customer group before creating the account."); return; }
    void guarded(async () => {
      if (editingCustomer) {
        await requestCustomerApi(user, "/api/admin/customers", "POST", {
          action: "update",
          customerId: editingCustomer.uid || editingCustomer.id,
          name, phone, whatsapp, groupId: customerGroup || null,
        });
        setNotice("Customer details updated successfully.");
      } else {
        const createdCustomer = await requestCustomerApi<{ uid: string }>(
          user,
          "/api/admin/customers",
          "POST",
          { action: "create", name, email, phone, whatsapp, groupId: customerGroup },
        );
        if (!createdCustomer.uid) {
          throw new Error("Customer was created but the server did not return its UID. Refresh the directory before retrying.");
        }
        try {
          await requestCustomerApi(
            user,
            `/api/admin/customers/${encodeURIComponent(createdCustomer.uid)}/password-reset`,
            "POST",
          );
          setNotice("Customer account created. Firebase accepted the password-setup email request.");
        } catch (mailError) {
          setNotice(`Customer account was created, but the setup email was not sent (${errorMessage(mailError)}). Use "Reset password" on this customer to retry.`);
        }
      }
      await refreshDirectory();
      setCustomerModal(false); setEditingCustomer(null);
      setCustomerName(""); setCustomerEmail(""); setCustomerPhone(""); setCustomerWhatsapp(""); setCustomerGroup("");
    });
  };

  const runCustomerAction = () => {
    if (!confirmAction) return;
    const { type, customer } = confirmAction;
    const customerId = customer.uid || customer.id;
    void guarded(async () => {
      if (type === "reset") {
        await requestCustomerApi(
          user,
          `/api/admin/customers/${encodeURIComponent(customerId)}/password-reset`,
          "POST",
        );
        setNotice("Firebase accepted the password-reset email request for this address.");
      } else if (type === "approve") {
        if (!approvalGroup) throw new Error("Choose a customer group before approving this registration.");
        await requestCustomerApi(user, "/api/admin/customers", "POST", {
          action: "approve", customerId, groupId: approvalGroup,
        });
        setNotice("Registration approved and group assignment saved.");
      } else if (type === "reject") {
        await requestCustomerApi(user, "/api/admin/customers", "POST", {
          action: "reject", customerId,
        });
        setNotice("Registration marked as rejected. No account or workspace data was deleted.");
      } else if (type === "delete") {
        await requestCustomerApi(user, "/api/admin/customers", "POST", {
          action: "delete", customerId,
        });
        setNotice("Customer archived. Their account and academic records are preserved. You can restore this customer later.");
      } else if (type === "restore") {
        await requestCustomerApi(user, "/api/admin/customers", "POST", {
          action: "restore", customerId,
        });
        setNotice("Customer restored. Their previous account access state has been reinstated.");
      } else {
        await requestCustomerApi(
          user,
          `/api/admin/customers/${encodeURIComponent(customerId)}/status`,
          "POST",
          { active: type === "enable" },
        );
        setNotice(type === "disable"
          ? "Customer account disabled. Their workspace data is untouched."
          : "Customer account enabled.");
      }
      await refreshDirectory();
      setConfirmAction(null);
      setApprovalGroup("");
    });
  };

  const archiveGroup = () => {
    if (!archiveGroupConfirm) return;
    const group = archiveGroupConfirm;
    void guarded(async () => {
      await requestCustomerApi(user, "/api/admin/customer-groups", "POST", {
        action: "archive", groupId: group.id,
      });
      await refreshDirectory();
      setNotice(`Group “${group.name}” archived. Customer accounts and workspace data were not deleted.`);
      setArchiveGroupConfirm(null);
      if (groupFilter === group.id) setGroupFilter("all");
    });
  };

  const assignGroup = (customer: Customer, groupId: string) => {
    void guarded(async () => {
      await requestCustomerApi(user, "/api/admin/customers", "POST", {
        action: "assign", customerId: customer.uid || customer.id, groupId: groupId || null,
      });
      await refreshDirectory();
      setNotice(groupId ? "Customer group assignment updated." : "Customer removed from group (account kept).");
    });
  };

  const openCreateGroup = () => { setEditingGroup(null); setGroupName(""); setGroupDescription(""); setGroupModal(true); setError(""); };
  const openEditGroup = (g: CustomerGroup) => { setEditingGroup(g); setGroupName(g.name); setGroupDescription(g.description ?? ""); setGroupModal(true); setError(""); };
  const openCreateCustomer = () => {
    setEditingCustomer(null);
    setCustomerName(""); setCustomerEmail(""); setCustomerPhone(""); setCustomerWhatsapp(""); setCustomerGroup("");
    setCustomerModal(true); setError("");
  };
  const openEditCustomer = (c: Customer) => {
    setEditingCustomer(c);
    setCustomerName(c.name ?? ""); setCustomerEmail(c.email ?? "");
    setCustomerPhone(c.phone ?? ""); setCustomerWhatsapp(c.whatsapp ?? "");
    setCustomerGroup(c.groupId ?? "");
    setCustomerModal(true); setOpenMenu(null); setError("");
  };

  const closeGroupModal = useCallback(() => { if (!inFlight.current) setGroupModal(false); }, []);
  const closeCustomerModal = useCallback(() => { if (!inFlight.current) { setCustomerModal(false); setEditingCustomer(null); } }, []);
  const closeArchive = useCallback(() => { if (!inFlight.current) setArchiveGroupConfirm(null); }, []);
  const closeView = useCallback(() => setViewingCustomer(null), []);
  const closeConfirm = useCallback(() => { if (!inFlight.current) { setConfirmAction(null); setApprovalGroup(""); } }, []);

  /* ---------------- Render ---------------- */
  if (authLoading) {
    return <div className="min-h-screen bg-slate-50 p-6 dark:bg-[#070b13]"><div className="mx-auto max-w-7xl animate-pulse space-y-5"><div className="h-10 w-64 rounded-xl bg-slate-200 dark:bg-slate-800" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((n) => <div key={n} className="h-28 rounded-2xl bg-slate-200 dark:bg-slate-800" />)}</div><div className="h-96 rounded-2xl bg-slate-200 dark:bg-slate-800" /></div></div>;
  }

  const stats = [
    { label: "Customer groups", value: activeGroups.length, icon: Users, tone: "text-orange-700 bg-orange-50 dark:bg-orange-950/50 dark:text-orange-300" },
    { label: "Customer accounts", value: customers.length, icon: UserRoundPlus, tone: "text-indigo-700 bg-indigo-50 dark:bg-indigo-950/50 dark:text-indigo-300" },
    { label: "Active customers", value: activeCount, icon: ShieldCheck, tone: "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 dark:text-emerald-300" },
    { label: "Pending registrations", value: pendingCount, icon: Clock3, tone: "text-amber-800 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-300" },
    { label: "Disabled customers", value: disabledCount, icon: UserX, tone: "text-rose-700 bg-rose-50 dark:bg-rose-950/50 dark:text-rose-300" },
    { label: "Student enrollments", value: studentTotal === null ? "—" : studentTotal, icon: BookOpen, tone: "text-blue-700 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-300" },
  ];
  const accents = ["from-orange-500 to-amber-400", "from-indigo-500 to-violet-500", "from-emerald-500 to-teal-400", "from-blue-500 to-cyan-400", "from-fuchsia-500 to-purple-400"];

  return (
    <main style={{ colorScheme: darkMode ? "dark" : "light" }} className="min-h-screen bg-[#f8fafc] px-4 py-6 text-slate-900 dark:bg-[#070b13] dark:text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        {/* Header */}
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-400 text-white shadow-lg shadow-orange-500/20"><Users size={23} /></div>
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2"><p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-400">EduTrack Admin</p><Badge tone="blue">Customer workspace</Badge></div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-3xl">Customer Management</h1>
              <p className={`mt-1 text-sm ${MUTED}`}>Manage groups, customer accounts and school workspaces.</p>
              <p className={`mt-1 text-xs ${MUTED}`}>Signed in as <span className="font-semibold text-slate-700 dark:text-slate-200">{user?.email || "administrator"}</span></p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/admin" className={BTN}><ArrowLeft size={16} /> Admin dashboard</Link>
            <button onClick={toggleTheme} aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"} className={`${BTN} !px-2.5`}>{darkMode ? <Sun size={17} /> : <Moon size={17} />}</button>
            <button onClick={() => void runSync(true)} disabled={loading || syncing || !user} className={BTN}><RefreshCw size={16} className={syncing ? "animate-spin" : ""} /> {syncing ? "Syncing…" : "Sync & refresh"}</button>
          </div>
        </header>

        {error && <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"><CircleAlert size={18} className="mt-0.5 shrink-0" /><div className="flex-1">{error}</div><button onClick={() => setError("")} aria-label="Dismiss error" className={ICON_BTN}><X size={16} /></button></div>}
        {notice && <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"><CheckCircle2 size={18} className="mt-0.5 shrink-0" /><div className="flex-1">{notice}</div><button onClick={() => setNotice("")} aria-label="Dismiss notification" className={ICON_BTN}><X size={16} /></button></div>}
        {directoryWarning && <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"><CircleAlert size={18} className="mt-0.5 shrink-0" /><div className="flex-1">{directoryWarning}</div></div>}

        {/* Statistics */}
        <section aria-label="Statistics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {stats.map((s) => (
            <article key={s.label} className={`${CARD} p-4 sm:p-5`}>
              <div className="flex items-center justify-between gap-3"><span className={`text-sm font-medium ${MUTED}`}>{s.label}</span><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${s.tone}`}><s.icon size={19} /></span></div>
              <p className="mt-4 text-3xl font-bold tabular-nums text-slate-900 dark:text-white">{loading ? "—" : typeof s.value === "number" ? s.value.toLocaleString() : s.value}</p>
            </article>
          ))}
        </section>

        {/* Groups */}
        <section className={`${CARD} p-5 sm:p-6`}>
          <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div><h2 className="text-lg font-bold text-slate-900 dark:text-white">Customer groups</h2><p className={`mt-1 text-sm ${MUTED}`}>Groups organize customer accounts; each customer keeps their own classes and students.</p></div>
            <button onClick={openCreateGroup} className={BTN_PRIMARY}><Plus size={17} /> Create new group</button>
          </div>
          {loading ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[1, 2, 3].map((n) => <div key={n} className="h-32 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />)}</div>
            : activeGroups.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-5 py-10 text-center dark:border-slate-600"><Users className="mx-auto mb-3 text-slate-400" size={30} /><p className="font-semibold text-slate-900 dark:text-white">No groups yet</p><p className={`mt-1 text-sm ${MUTED}`}>Create your first group to organize customer accounts.</p><button onClick={openCreateGroup} className={`${BTN_PRIMARY} mt-4`}>Create a group</button></div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {activeGroups.map((group, index) => {
                  const members = customers.filter((c) => c.groupId === group.id);
                  const active = members.filter((c) => statusOf(c) === "active").length;
                  const classesOk = members.every((c) => typeof c.classCount === "number");
                  const studentsOk = members.every((c) => typeof c.studentCount === "number");
                  return (
                    <article key={group.id} className={`${SUBCARD} relative overflow-hidden p-4 transition hover:-translate-y-0.5 hover:shadow-md`}>
                      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${accents[index % accents.length]}`} />
                      <div className="flex items-start justify-between gap-3 pt-1">
                        <div className="min-w-0"><h3 className="truncate font-bold text-slate-900 dark:text-white">{group.name}</h3><p className={`mt-1 line-clamp-2 min-h-5 text-xs ${MUTED}`}>{group.description || "Customer group"}</p></div>
                        <div className="flex shrink-0 gap-1">
                          <button onClick={() => openEditGroup(group)} className={ICON_BTN} aria-label={`Edit ${group.name}`}><Edit3 size={16} /></button>
                          <button onClick={() => setArchiveGroupConfirm(group)} className={`${ICON_BTN} hover:!bg-rose-50 hover:!text-rose-600 dark:hover:!bg-rose-950/40`} aria-label={`Archive ${group.name}`} title="Archive empty group"><Archive size={16} /></button>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div className={TILE}><p className={`text-xs ${MUTED}`}>Customers</p><p className="mt-1 text-xl font-bold">{members.length}</p></div>
                        <div className={TILE}><p className={`text-xs ${MUTED}`}>Active</p><p className="mt-1 text-xl font-bold">{active}</p></div>
                        <div className={TILE}><p className={`text-xs ${MUTED}`}>Academic classes</p><p className="mt-1 font-bold">{classesOk ? members.reduce((s, c) => s + Number(c.classCount), 0) : "—"}</p></div>
                        <div className={TILE}><p className={`text-xs ${MUTED}`}>Student enrollments</p><p className="mt-1 font-bold">{studentsOk ? members.reduce((s, c) => s + Number(c.studentCount), 0) : "—"}</p></div>
                      </div>
                      <button onClick={() => { setGroupFilter(group.id); setView("all"); }} className={`${BTN} mt-3 w-full !py-2`}>View group customers <span aria-hidden="true">→</span></button>
                    </article>
                  );
                })}
              </div>
            )}
        </section>

        {/* Customers */}
        <section className={`${CARD} overflow-hidden`}>
          <div className="border-b border-slate-200 p-5 dark:border-slate-700 sm:p-6">
            <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
              <div><h2 className="text-lg font-bold text-slate-900 dark:text-white">All customers</h2><p className={`mt-1 text-sm ${MUTED}`}>Public signups and admin-created accounts. Review registrations, manage access and assign groups.</p></div>
              <button onClick={openCreateCustomer} disabled={activeGroups.length === 0} title={activeGroups.length === 0 ? "Create a group first" : undefined}
                className={`inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 ${FOCUS}`}><Plus size={17} /> Add customer</button>
            </div>
            <div className="mt-5 flex flex-col gap-3 xl:flex-row">
              <div className="relative min-w-0 flex-1"><Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={17} /><input aria-label="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone or group..." className={`${INPUT} !mt-0 pl-10`} /></div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative"><Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={15} /><select aria-label="Filter by status" value={view} onChange={(e) => setView(e.target.value as ViewKey)} className={`${INPUT} !mt-0 min-w-44 pl-9`}><option value="all">All customers</option><option value="pending">Pending registrations</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="deleted">Deleted / archived</option><option value="unassigned">Unassigned group</option><option value="unverified">Email not verified</option></select></div>
                <select aria-label="Filter by group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className={`${INPUT} !mt-0 min-w-40`}><option value="all">All groups</option>{activeGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                <select aria-label="Sort customers" value={sort} onChange={(e) => setSort(e.target.value)} className={`${INPUT} !mt-0 min-w-44`}><option value="name-asc">Name: A to Z</option><option value="name-desc">Name: Z to A</option><option value="date-desc">Newest registration</option><option value="group-asc">Group name</option><option value="classes-desc">Most classes</option><option value="students-desc">Most students</option></select>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {([["all", "All"], ["pending", "Pending"], ["active", "Active"], ["disabled", "Disabled"], ["deleted", "Deleted"], ["unassigned", "Unassigned"]] as [ViewKey, string][]).map(([key, label]) => (
                <button key={key} onClick={() => setView(key)} aria-pressed={view === key} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${FOCUS} ${view === key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"}`}>{label}{key === "pending" ? ` · ${pendingCount}` : ""}</button>
              ))}
            </div>
          </div>

          {loading ? <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((n) => <div key={n} className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />)}</div>
            : pageRows.length === 0 ? (
              <div className="px-5 py-14 text-center"><Search className="mx-auto mb-3 text-slate-400" size={30} /><p className="font-semibold text-slate-900 dark:text-white">No matching customers</p><p className={`mt-1 text-sm ${MUTED}`}>{customers.length === 0 ? "No customers have been registered or created yet." : "Try another search or change the filters."}</p>{customers.length > 0 && <button onClick={() => { setSearch(""); setView("all"); setGroupFilter("all"); }} className="mt-4 text-sm font-semibold text-orange-700 dark:text-orange-400">Clear filters</button>}</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] text-left text-sm text-slate-900 dark:text-slate-100">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900/80 dark:text-slate-300"><tr><th className="px-5 py-3.5 font-semibold">Customer</th><th className="px-4 py-3.5 font-semibold">Group</th><th className="px-4 py-3.5 font-semibold">Workspace</th><th className="px-4 py-3.5 font-semibold">Account / approval</th><th className="px-4 py-3.5 font-semibold">Email / source</th><th className="px-4 py-3.5 text-right font-semibold">Actions</th></tr></thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {pageRows.map((c) => {
                        const inKnownGroup = groups.some((g) => g.id === c.groupId);
                        const status = statusOf(c);
                        const approval = approvalOf(c);
                        const key = c.uid || c.id;
                        return (
                          <tr key={c.id} className="transition hover:bg-slate-50 dark:hover:bg-slate-900/60">
                            <td className="px-5 py-4"><div className="flex items-center gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 font-bold text-orange-800 dark:from-orange-950 dark:to-amber-950 dark:text-orange-300">{(c.name || c.email || "?").trim().charAt(0).toUpperCase()}</div><div className="min-w-0"><p className="max-w-56 truncate font-semibold text-slate-900 dark:text-white">{c.name || "Unnamed customer"}</p><p className={`mt-0.5 max-w-56 truncate text-xs ${MUTED}`}>{c.phone || c.whatsapp || "No phone provided"}</p><p className={`mt-1 text-xs ${MUTED}`}>Added {formatDate(c.createdAt)}</p></div></div></td>
                            <td className="px-4 py-4">
                              <select aria-label={`Group for ${c.name || c.email}`} disabled={busy} value={inKnownGroup ? c.groupId || "" : ""} onChange={(e) => assignGroup(c, e.target.value)} className={`${SELECT_SM} max-w-44`}>
                                <option value="">Unassigned</option>{activeGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                              </select>
                              {c.groupId && !inKnownGroup && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Archived/legacy: {c.groupName || c.groupId}</p>}
                            </td>
                            <td className="px-4 py-4"><div className="flex items-center gap-2 text-slate-700 dark:text-slate-200"><BookOpen size={15} className="text-indigo-500" /><span>{c.classCount ?? "—"} classes</span></div><div className={`mt-1 flex items-center gap-2 text-xs ${MUTED}`}><Users size={14} /><span>{c.studentCount ?? "—"} students</span></div></td>
                            <td className="px-4 py-4">
                              <div className="flex flex-wrap gap-1.5">
                                <Badge tone={status === "active" ? "green" : status === "disabled" ? "rose" : "slate"}>{status === "inactive" ? "Not active" : status}</Badge>
                                <Badge tone={approval === "approved" || approval === "legacy" ? "blue" : approval === "pending" ? "amber" : "rose"}>{approval === "legacy" ? "Legacy account" : approval}</Badge>
                              </div>
                              <div className="mt-2"><Badge tone={c.emailVerified ? "green" : "amber"}>{c.emailVerified ? "Email verified" : "Email unverified"}</Badge></div>
                            </td>
                            <td className="px-4 py-4"><p className="max-w-56 truncate text-slate-800 dark:text-slate-100">{c.email}</p><p className="mt-1"><Badge tone={c.registrationSource === "self_registered" ? "amber" : c.registrationSource === "admin_created" ? "blue" : "slate"}>{sourceLabel(c)}</Badge></p></td>
                            <td className="px-4 py-4 text-right">
                              <div className="relative inline-block text-left">
                                <button onClick={() => setOpenMenu(openMenu === c.id ? null : c.id)} aria-haspopup="menu" aria-expanded={openMenu === c.id} className={ICON_BTN} aria-label={`Actions for ${c.name || c.email}`}><MoreHorizontal size={19} /></button>
                                {openMenu === c.id && (
                                  <>
                                    <button className="fixed inset-0 z-10 cursor-default" aria-label="Close actions menu" tabIndex={-1} onClick={() => setOpenMenu(null)} />
                                    <div role="menu" className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1.5 text-slate-900 shadow-xl dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100">
                                      <button role="menuitem" onClick={() => { setViewingCustomer(c); setOpenMenu(null); }} className={MENU_ITEM}><Eye size={15} /> View details</button>
                                      {!c.deleted && <>
                                        <button role="menuitem" onClick={() => openEditCustomer(c)} className={MENU_ITEM}><Pencil size={15} /> Edit customer</button>
                                        {approval === "pending" && <button role="menuitem" onClick={() => { setConfirmAction({ type: "approve", customer: c }); setApprovalGroup(c.groupId || ""); setOpenMenu(null); }} className={MENU_ITEM}><Check size={15} /> Approve registration</button>}
                                        {approval === "pending" && <button role="menuitem" onClick={() => { setConfirmAction({ type: "reject", customer: c }); setOpenMenu(null); }} className={`${MENU_ITEM} !text-rose-600 dark:!text-rose-400`}><X size={15} /> Reject registration</button>}
                                        <button role="menuitem" onClick={() => { setConfirmAction({ type: "reset", customer: c }); setOpenMenu(null); }} className={MENU_ITEM}><KeyRound size={15} /> Reset password</button>
                                        {status === "disabled"
                                          ? <button role="menuitem" onClick={() => { setConfirmAction({ type: "enable", customer: c }); setOpenMenu(null); }} disabled={approval === "pending" || approval === "rejected"} className={`${MENU_ITEM} !text-emerald-700 dark:!text-emerald-400`}><ShieldCheck size={15} /> Enable account</button>
                                          : <button role="menuitem" onClick={() => { setConfirmAction({ type: "disable", customer: c }); setOpenMenu(null); }} disabled={status !== "active"} className={`${MENU_ITEM} !text-rose-600 dark:!text-rose-400`}><UserX size={15} /> Disable account</button>}
                                        <button role="menuitem" onClick={() => { setConfirmAction({ type: "delete", customer: c }); setOpenMenu(null); }} className={`${MENU_ITEM} !text-rose-600 dark:!text-rose-400`}><Archive size={15} /> Delete / archive customer</button>
                                      </>}
                                      {c.deleted && <button role="menuitem" onClick={() => { setConfirmAction({ type: "restore", customer: c }); setOpenMenu(null); }} className={`${MENU_ITEM} !text-emerald-700 dark:!text-emerald-400`}><ShieldCheck size={15} /> Restore customer</button>}
                                    </div>
                                  </>
                                )}
                              </div>
                              <span className="sr-only">{key}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col justify-between gap-3 border-t border-slate-200 px-5 py-4 text-sm dark:border-slate-700 sm:flex-row sm:items-center">
                  <p className={MUTED}>Showing <span className="font-semibold text-slate-800 dark:text-slate-100">{filtered.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, filtered.length)}</span> of <span className="font-semibold text-slate-800 dark:text-slate-100">{filtered.length}</span> customers</p>
                  <div className="flex items-center gap-2">
                    <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className={BTN}>Previous</button>
                    <span className={`px-2 ${MUTED}`}>Page {page} of {totalPages}</span>
                    <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className={BTN}>Next</button>
                  </div>
                </div>
              </>
            )}
        </section>

        <p className={`flex items-start gap-2 text-xs leading-relaxed ${MUTED}`}><ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-600" /> Privileged account operations are validated by the trusted server. Customer groups never replace the existing teacher workspace or class data.</p>
      </div>

      {/* Group create/edit */}
      {groupModal && (
        <Modal title={editingGroup ? "Edit customer group" : "Create customer group"} description="Group names are unique regardless of capitalization or surrounding spaces." onClose={closeGroupModal}>
          <form onSubmit={saveGroup} className="space-y-4">
            <label className="block text-sm font-semibold">Group name <span className="text-rose-500">*</span><input autoFocus required maxLength={80} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. Toba Tek Singh" className={INPUT} /></label>
            <label className="block text-sm font-semibold">Description <span className={`font-normal ${MUTED}`}>(optional)</span><textarea maxLength={300} rows={3} value={groupDescription} onChange={(e) => setGroupDescription(e.target.value)} placeholder="Add a short note about this group..." className={INPUT} /></label>
            <div className="flex justify-end gap-2 pt-2"><button type="button" disabled={busy} onClick={closeGroupModal} className={BTN}>Cancel</button><button disabled={busy} className={BTN_PRIMARY}>{busy && <Loader2 size={16} className="animate-spin" />}{editingGroup ? "Save changes" : "Create group"}</button></div>
          </form>
        </Modal>
      )}

      {/* Archive group */}
      {archiveGroupConfirm && (
        <Modal title="Archive customer group" description={archiveGroupConfirm.name} onClose={closeArchive}>
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Only an empty group can be archived. Reassign all its customers first. Archiving never deletes Firebase Auth accounts, teacher profiles, classes, students, attendance or fees.</div>
            <p className="text-sm text-slate-700 dark:text-slate-300">The backend rechecks that this group has no assigned customers before archiving it.</p>
            <div className="flex justify-end gap-2"><button disabled={busy} onClick={closeArchive} className={BTN}>Cancel</button><button disabled={busy} onClick={archiveGroup} className={BTN_DANGER}>{busy && <Loader2 size={16} className="animate-spin" />}Archive group</button></div>
          </div>
        </Modal>
      )}

      {/* Customer create/edit */}
      {customerModal && (
        <Modal title={editingCustomer ? "Edit customer" : "Add customer"} description={editingCustomer ? "Update editable profile details and group assignment. Account identity and email are protected." : "A trusted backend creates the real Auth account and matching teacher profile."} onClose={closeCustomerModal}>
          <form onSubmit={saveCustomer} className="space-y-4">
            <label className="block text-sm font-semibold">Full name <span className="text-rose-500">*</span><input autoFocus required maxLength={120} value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer or teacher name" className={INPUT} /></label>
            <label className="block text-sm font-semibold">Email address <span className="text-rose-500">*</span><input required type="email" maxLength={254} autoComplete="off" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} readOnly={Boolean(editingCustomer)} aria-readonly={Boolean(editingCustomer)} placeholder="name@example.com" className={`${INPUT} ${editingCustomer ? "cursor-not-allowed opacity-70" : ""}`} /></label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-semibold">Phone number<input maxLength={20} inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="+92..." className={INPUT} /></label>
              <label className="block text-sm font-semibold">WhatsApp number<input maxLength={20} inputMode="tel" value={customerWhatsapp} onChange={(e) => setCustomerWhatsapp(e.target.value)} placeholder="+92..." className={INPUT} /></label>
            </div>
            <label className="block text-sm font-semibold">Customer group {editingCustomer ? <span className={`font-normal ${MUTED}`}>(optional)</span> : <span className="text-rose-500">*</span>}
              <select required={!editingCustomer} value={customerGroup} onChange={(e) => setCustomerGroup(e.target.value)} className={INPUT}><option value="">{editingCustomer ? "Unassigned" : "Select a group"}</option>{activeGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
            </label>
            {!editingCustomer && <div className="rounded-xl border border-orange-300 bg-orange-50 p-3 text-xs leading-relaxed text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200"><Mail size={15} className="mr-1 inline" /> The backend creates the Authentication account (no password is set, shown or stored). Firebase's password-setup email is then requested; if it fails the account is kept and you can retry via “Reset password”.</div>}
            <div className="flex justify-end gap-2 pt-2"><button type="button" disabled={busy} onClick={closeCustomerModal} className={BTN}>Cancel</button><button disabled={busy} className={BTN_PRIMARY}>{busy && <Loader2 size={16} className="animate-spin" />}{editingCustomer ? "Save changes" : "Create customer"}</button></div>
          </form>
        </Modal>
      )}

      {/* Details */}
      {viewingCustomer && (() => {
        const v = viewingCustomer;
        const field = (label: string, value: ReactNode, extra?: ReactNode) => (
          <div className={`${SUBCARD} p-3`}><p className={`text-xs font-medium ${MUTED}`}>{label}</p><div className="mt-1 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">{value}</div>{extra}</div>
        );
        const st = statusOf(v), ap = approvalOf(v);
        return (
          <Modal title="Customer details" description={`${v.name || "Customer"} · ${v.email || "No email"}`} onClose={closeView}>
            <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-lg font-bold text-orange-800 dark:from-orange-950 dark:to-amber-950 dark:text-orange-300">{(v.name || v.email || "?").trim().charAt(0).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-slate-900 dark:text-white">{v.name || "Unnamed customer"}</p>
                  <p className={`truncate text-sm ${MUTED}`}>{v.email || "No email available"}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5"><Badge tone={st === "active" ? "green" : st === "disabled" ? "rose" : "slate"}>{st === "inactive" ? "Not active" : st}</Badge><Badge tone={ap === "approved" || ap === "legacy" ? "blue" : ap === "pending" ? "amber" : "rose"}>{ap === "legacy" ? "Legacy account" : ap}</Badge></div>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field("Phone", v.phone || "Not provided")}
                {field("WhatsApp", v.whatsapp || "Not provided")}
                {field("Firebase UID", <span className="break-all text-xs">{v.uid || "Not available"}</span>,
                  v.uid ? <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(v.uid || ""); setNotice("Customer UID copied."); } catch { setError("Clipboard access is unavailable in this browser context."); } }} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-orange-700 hover:text-orange-800 dark:text-orange-400"><Copy size={12} /> Copy UID</button> : null)}
                {field("Assigned group", groups.find((g) => g.id === v.groupId)?.name || v.groupName || "Unassigned")}
                {field("Registration date", <><CalendarDays size={14} className="mr-1 inline" />{formatDate(v.createdAt)}</>)}
                {field("Registration source", sourceLabel(v))}
                {field("Email verification", v.emailVerified === true ? "Verified" : v.emailVerified === false ? "Not verified" : "Not available")}
                {field("Approval status", ap === "legacy" ? "Legacy (no approval record)" : ap)}
                {field("Account status", st === "inactive" ? "Not active" : st)}
                {field("Academic workspace", `${v.classCount ?? "—"} classes · ${v.studentCount ?? "—"} students`)}
                {field("Assigned subscription plan", v.planName || (v.accessMode === 'unassigned_full_access' ? 'No Plan — Full Access' : 'No plan / legacy'))}
                {field("Subscription status", v.subscriptionStatus || 'Unknown')}
                {field("Access mode", (v.accessMode || 'legacy_unassigned').replace(/_/g, ' '))}
                {field("Feature visibility", v.featureVisibilityMode === 'locked' ? 'Show unavailable features as locked' : 'Hide unavailable features')}
                {field("Active add-ons", (v.activeAddOns ?? []).length ? (v.activeAddOns ?? []).map((addon) => `${addon.name} (${addon.featureKeys.join(', ')})`).join(' · ') : 'None')}
                {field("Pending add-on requests", (v.pendingAddOnRequests ?? []).length ? (v.pendingAddOnRequests ?? []).map((item) => item.featureName || item.featureKey).join(' · ') : 'None')}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Link to="/admin/subscriptions" className={BTN}>Manage subscription</Link>
                <button onClick={() => { setViewingCustomer(null); openEditCustomer(v); }} className={BTN}><Pencil size={15} /> Edit customer</button>
                <button onClick={closeView} className={BTN_PRIMARY}>Close</button>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Confirmations */}
      {confirmAction && (
        <Modal
          title={confirmAction.type === "approve" ? "Approve registration" : confirmAction.type === "reject" ? "Reject registration" : confirmAction.type === "disable" ? "Disable customer account" : confirmAction.type === "enable" ? "Enable customer account" : confirmAction.type === "delete" ? "Delete / archive customer" : confirmAction.type === "restore" ? "Restore customer" : "Send password reset"}
          description={`${confirmAction.customer.name || "Customer"} · ${confirmAction.customer.email}`} onClose={closeConfirm}>
          <div className="space-y-4">
            {confirmAction.type === "approve" ? (
              <>
                <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">Select the group for this customer. The backend re-verifies the registration state and the account's email verification before approving.</p>
                {confirmAction.customer.emailVerified !== true && <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"><CircleAlert size={17} className="mt-0.5 shrink-0" /> This customer's email is not verified yet. Approval is blocked until it is verified (use “Sync & refresh” after they verify).</div>}
                <label className="block text-sm font-semibold">Assign customer group <span className="text-rose-500">*</span><select required value={approvalGroup} onChange={(e) => setApprovalGroup(e.target.value)} className={INPUT}><option value="">Select a group</option>{activeGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
              </>
            ) : confirmAction.type === "disable" ? <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">This disables the Firebase Authentication account and revokes active sessions. Classes, students, attendance and fees stay intact.</p>
              : confirmAction.type === "enable" ? <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">Re-enable this approved account. The backend refuses this for pending or rejected registrations.</p>
              : confirmAction.type === "reject" ? <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">The registration is marked rejected and access is withheld. The Auth account, profile and academic data are preserved.</p>
              : confirmAction.type === "delete" ? <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">This archives the customer and disables sign-in. It does not permanently delete the account, profile, classes, students, attendance, fees or invoices. The customer can be restored later.</p>
              : confirmAction.type === "restore" ? <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">Restore this archived customer. The backend will reinstate the previous access state where possible. Academic records remain preserved.</p>
              : <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">Send a password-reset email to this address. Your administrator session stays signed in.</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button disabled={busy} onClick={closeConfirm} className={BTN}>Cancel</button>
              <button disabled={busy || (confirmAction.type === "approve" && (!approvalGroup || confirmAction.customer.emailVerified !== true))} onClick={runCustomerAction}
                className={confirmAction.type === "disable" || confirmAction.type === "reject" || confirmAction.type === "delete" ? BTN_DANGER : BTN_PRIMARY}>
                {busy && <Loader2 size={16} className="animate-spin" />}
                {confirmAction.type === "approve" ? (confirmAction.customer.emailVerified === true ? "Confirm approval" : "Email verification required") : confirmAction.type === "reject" ? "Reject registration" : confirmAction.type === "disable" ? "Disable account" : confirmAction.type === "enable" ? "Enable account" : confirmAction.type === "delete" ? "Archive customer" : confirmAction.type === "restore" ? "Restore customer" : "Send reset email"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
