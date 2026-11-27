import { FieldValue, type DocumentData, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import type { UserRecord } from "firebase-admin/auth";
import {
  AdminApiAuthError,
  FirebaseAdminConfigurationError,
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
  verifyAdminRequest,
} from "./firebaseAdmin.js";

export type CustomerApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};

export type CustomerApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): CustomerApiResponse;
  json(data: unknown): CustomerApiResponse;
};

export class CustomerApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CustomerApiError";
  }
}

type AdminContext = {
  db: Firestore;
  uid: string;
  email: string;
  root: DocumentReference<DocumentData>;
};

type CustomerContext = {
  user: UserRecord;
  profile: DocumentReference<DocumentData>;
  profileData: DocumentData;
  registry: DocumentReference<DocumentData>;
  registryData: DocumentData;
};

const normalizeEmail = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const cleanText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCustomerUid(request: CustomerApiRequest): string {
  const value = request.query?.uid;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new CustomerApiError(400, "A valid customer UID is required.");
  }
  return value;
}

async function getAdminContext(
  request: CustomerApiRequest,
): Promise<AdminContext> {
  const actor = await verifyAdminRequest(
    request as Parameters<typeof verifyAdminRequest>[0],
  );
  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminFirestore();
  const adminUser = await auth.getUser(actor.uid);
  const email = normalizeEmail(adminUser.email);
  const tokenEmail = normalizeEmail(actor.email);

  if (!email || email !== tokenEmail || adminUser.disabled) {
    throw new CustomerApiError(403, "Administrator account verification failed.");
  }

  // A verified Firebase admin claim plus admins/{email} is the admin identity.
  // Read-only requests must not rewrite the admin root and consume a Firestore write.
  const root = db.collection("admins").doc(email);
  const rootSnapshot = await root.get();

  if (rootSnapshot.exists) {
    if (cleanText(rootSnapshot.data()?.adminUid) !== actor.uid) {
      throw new CustomerApiError(
        403,
        "This administrator record is mapped to a different account.",
      );
    }
  } else {
    await root.create({
      adminUid: actor.uid,
      email,
      adminProfileDocId: null,
      managementSchemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return { db, uid: actor.uid, email, root };
}

async function resolveCustomer(
  context: AdminContext,
  customerUid: string,
  includeDeleted = false,
): Promise<CustomerContext> {
  if (customerUid === context.uid) {
    throw new CustomerApiError(
      409,
      "An administrator cannot change their own customer account.",
    );
  }

  const auth = getFirebaseAdminAuth();
  let user: UserRecord;

  try {
    user = await auth.getUser(customerUid);
  } catch {
    throw new CustomerApiError(404, "The selected customer account was not found.");
  }

  const claims = (user.customClaims ?? {}) as Record<string, unknown>;
  const roles: unknown[] = Array.isArray(claims.roles) ? claims.roles : [];
  if (
    claims.admin === true ||
    cleanText(claims.role).toLowerCase() === "admin" ||
    roles.some((role) => cleanText(role).toLowerCase() === "admin")
  ) {
    throw new CustomerApiError(
      409,
      "An administrator account cannot be managed as a teacher customer.",
    );
  }

  const email = normalizeEmail(user.email);
  if (!email) {
    throw new CustomerApiError(409, "The selected customer has no usable email address.");
  }

  const profiles = await context.db
    .collection("users")
    .where("uid", "==", customerUid)
    .limit(10)
    .get();

  const matches = profiles.docs.filter((document) => {
    const profile = document.data();
    return (
      profile.uid === customerUid &&
      cleanText(profile.role).toLowerCase() === "teacher" &&
      normalizeEmail(profile.email ?? document.id) === email
    );
  });

  if (matches.length !== 1) {
    throw new CustomerApiError(
      matches.length > 1 ? 409 : 404,
      matches.length > 1
        ? "Multiple teacher profiles match this customer. Resolve the duplicate profile first."
        : "The selected account is not a verified existing teacher profile.",
    );
  }

  const profileSnapshot = matches[0];
  const profileData = profileSnapshot.data();
  const registry = context.root.collection("customers").doc(customerUid);
  const registrySnapshot = await registry.get();
  const registryData = registrySnapshot.data() ?? {};
  const isDeleted = registryData.deleted === true ||
    profileData.deleted === true ||
    profileData.isDeleted === true;

  if (isDeleted && !includeDeleted) {
    throw new CustomerApiError(409, "This customer is archived. Restore the account before changing it.");
  }

  // Safe, repeatable backfill for an existing teacher only. The teacher's
  // existing workspace profile is never created or replaced by this endpoint.
  if (!registrySnapshot.exists) {
    await registry.set(
      {
        uid: customerUid,
        email,
        name:
          cleanText(profileData.displayName) ||
          cleanText(profileData.name) ||
          cleanText(profileData.fullName) ||
          cleanText(user.displayName) ||
          email.split("@")[0],
        phone: cleanText(profileData.phone) || cleanText(profileData.phoneNumber),
        whatsapp:
          cleanText(profileData.whatsappNumber) || cleanText(profileData.whatsapp),
        registrationSource: cleanText(profileData.registrationSource) || "legacy",
        approvalStatus: cleanText(profileData.approvalStatus) || "legacy",
        groupId: cleanText(profileData.groupId) || null,
        groupName: cleanText(profileData.groupName) || null,
        active: !user.disabled && profileData.active !== false,
        disabled: user.disabled,
        emailVerified: user.emailVerified,
        profileDocId: profileSnapshot.id,
        createdAt:
          profileData.createdAt ??
          (user.metadata.creationTime ? new Date(user.metadata.creationTime) : null),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return {
    user,
    profile: profileSnapshot.ref,
    profileData,
    registry,
    registryData: registrySnapshot.exists
      ? registryData
      : {
          ...profileData,
          approvalStatus: cleanText(profileData.approvalStatus) || "legacy",
          groupId: cleanText(profileData.groupId) || null,
        },
  };
}

export async function updateCustomerActiveStatus(
  request: CustomerApiRequest,
  active: boolean,
): Promise<{ uid: string; active: boolean; disabled: boolean }> {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(context, getCustomerUid(request));

  const approvalStatus = (
    cleanText(customer.registryData.approvalStatus) ||
    cleanText(customer.profileData.approvalStatus)
  ).toLowerCase();

  if (active && (approvalStatus === "pending" || approvalStatus === "rejected")) {
    throw new CustomerApiError(
      409,
      "A pending or rejected registration cannot be enabled. Approve the registration first.",
    );
  }

  const disabled = !active;
  const groupId =
    cleanText(customer.registryData.groupId) ||
    cleanText(customer.profileData.groupId);

  // Resolve any existing group membership before changing Authentication so
  // validation/read failures do not leave a half-updated account.
  let membershipRef: DocumentReference<DocumentData> | null = null;
  if (groupId) {
    const candidate = context.root
      .collection("customerGroups")
      .doc(groupId)
      .collection("customers")
      .doc(customer.user.uid);
    const membership = await candidate.get();
    if (membership.exists) membershipRef = candidate;
  }

  const auth = getFirebaseAdminAuth();
  await auth.updateUser(customer.user.uid, { disabled });
  if (disabled) {
    await auth.revokeRefreshTokens(customer.user.uid);
  }

  const batch = context.db.batch();
  const statusPatch = {
    disabled,
    active,
    updatedAt: FieldValue.serverTimestamp(),
  };

  batch.set(customer.registry, statusPatch, { merge: true });
  batch.set(customer.profile, statusPatch, { merge: true });

  if (membershipRef) {
    batch.set(
      membershipRef,
      {
        membershipStatus: disabled ? "disabled" : "active",
        status: disabled ? "disabled" : "active",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  try {
    await batch.commit();
  } catch {
    throw new CustomerApiError(
      500,
      "Firebase Authentication status changed, but the customer registry could not be synchronized. Check the account before retrying.",
    );
  }

  return { uid: customer.user.uid, active, disabled };
}

export async function sendCustomerPasswordReset(
  request: CustomerApiRequest,
): Promise<{ uid: string; email: string }> {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(context, getCustomerUid(request));
  const apiKey =
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.VITE_FIREBASE_API_KEY ||
    "";

  if (!apiKey) {
    throw new CustomerApiError(
      503,
      "Firebase password-reset email is not configured on the server.",
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestType: "PASSWORD_RESET",
          email: customer.user.email,
        }),
      },
    );
  } catch {
    throw new CustomerApiError(
      502,
      "Firebase password-reset email service could not be reached.",
    );
  }

  if (!response.ok) {
    let providerCode = "";
    try {
      const payload: unknown = await response.json();
      if (isRecord(payload) && isRecord(payload.error)) {
        providerCode = cleanText(payload.error.message);
      }
    } catch {
      // The provider body is intentionally not returned or logged.
    }

    if (providerCode.includes("TOO_MANY_ATTEMPTS") || response.status === 429) {
      throw new CustomerApiError(
        429,
        "Too many password-reset attempts. Please try again later.",
      );
    }
    if (
      providerCode.includes("API_KEY_INVALID") ||
      providerCode.includes("PROJECT_NOT_FOUND")
    ) {
      throw new CustomerApiError(
        503,
        "Firebase password-reset email is not configured correctly.",
      );
    }
    throw new CustomerApiError(
      502,
      "Firebase did not accept the password-reset email request.",
    );
  }

  return {
    uid: customer.user.uid,
    email: normalizeEmail(customer.user.email),
  };
}

export function sendCustomerApiError(
  response: CustomerApiResponse,
  error: unknown,
): CustomerApiResponse {
  if (error instanceof CustomerApiError) {
    return response.status(error.status).json({
      success: false,
      error: error.message,
    });
  }
  if (error instanceof AdminApiAuthError) {
    return response.status(error.status).json({
      success: false,
      error: error.message,
    });
  }
  if (error instanceof FirebaseAdminConfigurationError) {
    return response.status(503).json({
      success: false,
      error: "Firebase Admin is not configured on the server.",
    });
  }
  return response.status(500).json({
    success: false,
    error: "An unexpected customer-management error occurred.",
  });
}


/* -------------------------------------------------------------------------- */
/* Spark-compatible Customer Management API (Vercel + Firebase Admin SDK)    */
/* -------------------------------------------------------------------------- */

function requiredText(value: unknown, label: string, max: number): string {
  const result = cleanText(value);
  if (!result) throw new CustomerApiError(400, `${label} is required.`);
  if (result.length > max) throw new CustomerApiError(400, `${label} is too long.`);
  return result;
}

function normalizeGroupName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function getActiveCustomerGroup(context: AdminContext, value: unknown) {
  const groupId = requiredText(value, "Customer group", 128);
  const ref = context.root.collection("customerGroups").doc(groupId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new CustomerApiError(404, "The selected customer group was not found.");
  }

  const data = snapshot.data() ?? {};
  if (data.archived === true || data.active === false) {
    throw new CustomerApiError(409, "The selected customer group is archived or inactive.");
  }

  return { ref, id: groupId, data };
}

const CUSTOMER_DIRECTORY_LIMIT = 100;
const CUSTOMER_REGISTRY_BACKFILL_PER_REQUEST = 10;

function readCachedCount(data: DocumentData, keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function getAcademicCounts(profileData: DocumentData) {
  // Do not enumerate every class/student subcollection on an Admin page read.
  // Use persisted aggregates when present; otherwise show unknown rather than
  // generating thousands of billable reads or presenting partial counts as exact.
  return {
    classCount: readCachedCount(profileData, ["classCount", "totalClasses", "classesCount"]),
    studentCount: readCachedCount(profileData, ["studentCount", "totalStudents", "enrollmentCount", "totalEnrollments"]),
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await callback(items[index]);
    }
  }));
  return results;
}

/** Lists a bounded teacher directory; registry backfill is capped and only writes missing rows. */
export async function getCustomerDirectory(request: CustomerApiRequest) {
  const context = await getAdminContext(request);
  const [profileSnapshot, groupSnapshot] = await Promise.all([
    context.db.collection("users")
      .where("role", "==", "teacher")
      .limit(CUSTOMER_DIRECTORY_LIMIT + 1)
      .get(),
    context.root.collection("customerGroups").limit(100).get(),
  ]);

  const groups: Array<{ id: string; name: unknown }> =
    groupSnapshot.docs.map((doc) => ({ id: doc.id, name: doc.get("name") }));

  const docsByUid = new Map<string, typeof profileSnapshot.docs[number]>();
  const ambiguousUids = new Set<string>();
  for (const doc of profileSnapshot.docs.slice(0, CUSTOMER_DIRECTORY_LIMIT)) {
    const data = doc.data();
    const uid = cleanText(data.uid);
    const email = normalizeEmail(data.email ?? doc.id);
    if (!uid || !email || !email.includes("@") || ambiguousUids.has(uid)) continue;
    const previous = docsByUid.get(uid);
    if (!previous) {
      docsByUid.set(uid, doc);
      continue;
    }
    const previousEmail = normalizeEmail(previous.data().email ?? previous.id);
    if (previousEmail !== email) {
      docsByUid.delete(uid);
      ambiguousUids.add(uid);
      continue;
    }
    if (doc.id.toLowerCase() === email && previous.id.toLowerCase() !== email) {
      docsByUid.set(uid, doc);
    }
  }

  const auth = getFirebaseAdminAuth();
  let registryBackfillsUsed = 0;
  let registryBackfillsPending = 0;
  const customerRows = await mapLimit(Array.from(docsByUid.values()), 5, async (profileDoc) => {
    const profileData = profileDoc.data();
    const uid = cleanText(profileData.uid);
    const email = normalizeEmail(profileData.email ?? profileDoc.id);
    if (!uid || uid === context.uid || !email) return null;

    let user: UserRecord;
    try {
      user = await auth.getUser(uid);
    } catch {
      return null;
    }
    if (normalizeEmail(user.email) !== email) return null;
    const claims = (user.customClaims ?? {}) as Record<string, unknown>;
    const roles: unknown[] = Array.isArray(claims.roles) ? claims.roles : [];
    if (claims.admin === true || cleanText(claims.role).toLowerCase() === "admin" ||
        roles.some((role) => cleanText(role).toLowerCase() === "admin")) return null;

    const registry = context.root.collection("customers").doc(uid);
    const accountRef = context.root.collection("subscriptionAccounts").doc(uid);
    const [registrySnapshot, accountSnapshot, periodsSnapshot, addOnsSnapshot, addOnRequestsSnapshot] = await Promise.all([
      registry.get(),
      accountRef.get(),
      accountRef.collection("periods").orderBy("startedAt", "desc").limit(12).get(),
      accountRef.collection("addOns").where("status", "==", "active").limit(20).get(),
      accountRef.collection("addOnRequests").where("status", "==", "pending").limit(20).get(),
    ]);
    const old = registrySnapshot.data() ?? {};
    const account = accountSnapshot.data() ?? {};
    const now = Date.now();
    const currentPeriod = periodsSnapshot.docs.map((periodDoc) => ({ id: periodDoc.id, data: periodDoc.data() }))
      .filter(({ data }) => {
        const start = data.startedAt && typeof data.startedAt.toDate === "function" ? data.startedAt.toDate().getTime() : new Date(data.startedAt as string).getTime();
        const end = data.expiresAt && typeof data.expiresAt.toDate === "function" ? data.expiresAt.toDate().getTime() : new Date(data.expiresAt as string).getTime();
        return data.approved !== false && data.paymentApproved !== false && (data.status === "active" || data.status === "scheduled") && Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
      })
      .sort((a, b) => {
        const value = (v: unknown) => v && typeof (v as { toDate?: unknown }).toDate === "function" ? (v as { toDate: () => Date }).toDate().getTime() : new Date(v as string).getTime();
        return value(b.data.startedAt) - value(a.data.startedAt);
      })[0];
    const activeAddOns = addOnsSnapshot.docs.filter((addonDoc) => {
      const data = addonDoc.data();
      const startValue = data.startsAt ?? data.startedAt;
      const start = startValue && typeof startValue.toDate === "function" ? startValue.toDate().getTime() : new Date(startValue as string).getTime();
      const end = data.expiresAt && typeof data.expiresAt.toDate === "function" ? data.expiresAt.toDate().getTime() : new Date(data.expiresAt as string).getTime();
      return data.approved === true && Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
    }).map((addonDoc) => ({ id: addonDoc.id, name: cleanText(addonDoc.data().name), featureKeys: Array.isArray(addonDoc.data().featureKeys) ? addonDoc.data().featureKeys : [], expiresAt: addonDoc.data().expiresAt?.toDate?.()?.toISOString?.() ?? null }));
    const pendingAddOnRequests = addOnRequestsSnapshot.docs.map((requestDoc) => ({ id: requestDoc.id, featureKey: cleanText(requestDoc.data().featureKey), featureName: cleanText(requestDoc.data().featureName), status: "pending" }));
    const approvalStatus = cleanText(old.approvalStatus) || cleanText(profileData.approvalStatus) ||
      (cleanText(profileData.registrationSource) === "self_registered" ? "pending" : "legacy");
    const deleted = old.deleted === true || profileData.deleted === true || profileData.isDeleted === true;
    const disabled = Boolean(user.disabled) || deleted;
    const active = !disabled && profileData.active !== false && approvalStatus !== "pending" && approvalStatus !== "rejected";
    const counts = getAcademicCounts(profileData);
    const groupId = cleanText(old.groupId) || cleanText(profileData.groupId) || null;
    const matchedGroup = groups.find((group) => group.id === groupId);
    const groupName = cleanText(old.groupName) || cleanText(profileData.groupName) || cleanText(matchedGroup?.name) || null;

    const customer = {
      uid, email,
      name: cleanText(old.name) || cleanText(profileData.teacherName) || cleanText(profileData.name) || cleanText(user.displayName) || email,
      phone: cleanText(old.phone) || cleanText(profileData.phone) || cleanText(profileData.phoneNumber),
      whatsapp: cleanText(old.whatsapp) || cleanText(profileData.whatsappNumber) || cleanText(profileData.whatsapp),
      profileDocId: profileDoc.id, role: "teacher",
      registrationSource: cleanText(old.registrationSource) || cleanText(profileData.registrationSource) || "legacy",
      approvalStatus, emailVerified: user.emailVerified, disabled, active, deleted, groupId, groupName,
      classCount: counts.classCount, studentCount: counts.studentCount,
      planName: currentPeriod ? cleanText(currentPeriod.data.planName) || null : cleanText(account.planName || account.requestedPlanName) || null,
      subscriptionStatus: account.active === false ? cleanText(account.status) || "inactive" : currentPeriod ? "active" : cleanText(account.status) || "no_plan",
      accessMode: cleanText(account.accessMode) || "legacy_unassigned",
      featureVisibilityMode: cleanText(account.featureVisibilityModeOverride || account.featureVisibilityMode) === "locked" || (currentPeriod && currentPeriod.data.featureVisibilityMode === "locked") ? "locked" : "hide",
      activeAddOns, pendingAddOnRequests,
      createdAt: old.createdAt ?? profileData.createdAt ?? (user.metadata.creationTime ? new Date(user.metadata.creationTime) : null),
    };

    // Only backfill absent registry rows, and cap writes to 10 per request.
    // Existing registry documents are not rewritten when an admin opens/refreshes the page.
    if (!registrySnapshot.exists) {
      if (registryBackfillsUsed < CUSTOMER_REGISTRY_BACKFILL_PER_REQUEST) {
        registryBackfillsUsed += 1;
        await registry.set({ ...customer, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      } else {
        registryBackfillsPending += 1;
      }
    }

    return { id: uid, ...customer };
  });

  const customers = customerRows.filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  const hasMoreTeachers = profileSnapshot.size > CUSTOMER_DIRECTORY_LIMIT;

  return {
    success: true,
    adminEmail: context.email,
    groups,
    customers,
    coverage: {
      complete: !hasMoreTeachers && registryBackfillsPending === 0,
      hasMoreTeachers,
      teacherLimit: CUSTOMER_DIRECTORY_LIMIT,
      registryBackfillsApplied: registryBackfillsUsed,
      registryBackfillsPending,
      warnings: [
        ...(hasMoreTeachers ? ["The directory currently shows the first 100 teacher profiles to protect Firestore quota."] : []),
        ...(registryBackfillsPending > 0 ? [`${registryBackfillsPending} legacy customer records still need a bounded registry backfill. Use Sync & refresh again to continue.`] : []),
      ],
    },
  };
}

/** Creates or updates a group without changing any tenant workspace data. */
export async function saveCustomerGroup(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const name = requiredText(input.name, "Group name", 80).replace(/\s+/g, " ");
  const description = cleanText(input.description);

  if (description.length > 300) {
    throw new CustomerApiError(400, "Description must be 300 characters or fewer.");
  }

  const groupId = cleanText(input.groupId);
  const groupsRef = context.root.collection("customerGroups");
  const targetRef = groupId ? groupsRef.doc(groupId) : groupsRef.doc();
  const normalizedName = normalizeGroupName(name);

  await context.db.runTransaction(async (transaction) => {
    const allGroups = await transaction.get(groupsRef);
    const current = groupId ? await transaction.get(targetRef) : null;

    const duplicate = allGroups.docs.find((doc) =>
      doc.id !== targetRef.id &&
      doc.data().archived !== true &&
      normalizeGroupName(cleanText(doc.data().name)) === normalizedName
    );

    if (duplicate) throw new CustomerApiError(409, "A group with this name already exists.");
    if (groupId && !current?.exists) {
      throw new CustomerApiError(404, "The customer group was not found.");
    }
    if (current?.data()?.archived === true) {
      throw new CustomerApiError(409, "An archived group cannot be edited.");
    }

    const previous = current?.data() ?? {};
    transaction.set(targetRef, {
      name,
      normalizedName,
      description,
      active: true,
      archived: false,
      createdByUid: cleanText(previous.createdByUid) || context.uid,
      createdAt: previous.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return { success: true, groupId: targetRef.id };
}

/** Synchronizes registry, profile and group membership in one Firestore transaction. */
async function writeCustomerMembership(
  context: AdminContext,
  customer: CustomerContext,
  groupId: string | null,
  registryPatch: DocumentData = {},
  profilePatch: DocumentData = {},
) {
  const groupsRef = context.root.collection("customerGroups");
  const target = groupId ? await getActiveCustomerGroup(context, groupId) : null;

  await context.db.runTransaction(async (transaction) => {
    const [allGroups, registrySnapshot, profileSnapshot] = await Promise.all([
      transaction.get(groupsRef),
      transaction.get(customer.registry),
      transaction.get(customer.profile),
    ]);

    if (allGroups.size > 450) {
      throw new CustomerApiError(409, "Too many groups to safely update memberships.");
    }

    if (target && !allGroups.docs.some((doc) => doc.id === target.id && doc.data().archived !== true)) {
      throw new CustomerApiError(409, "The selected group is no longer active.");
    }

    const name =
      cleanText(registrySnapshot.data()?.name) ||
      cleanText(customer.profileData.teacherName) ||
      cleanText(customer.profileData.name) ||
      cleanText(customer.user.displayName);

    const disabled =
      typeof registryPatch.disabled === "boolean"
        ? registryPatch.disabled
        : customer.user.disabled;

    const approval =
      cleanText(registryPatch.approvalStatus) ||
      cleanText(registrySnapshot.data()?.approvalStatus) ||
      cleanText(customer.profileData.approvalStatus);

    const status = approval === "pending" ? "pending"
      : approval === "rejected" ? "rejected"
      : disabled ? "disabled" : "active";

    for (const groupDoc of allGroups.docs) {
      if (!target || groupDoc.id !== target.id) {
        transaction.delete(groupDoc.ref.collection("customers").doc(customer.user.uid));
      }
    }

    if (target) {
      transaction.set(target.ref.collection("customers").doc(customer.user.uid), {
        uid: customer.user.uid,
        customerUid: customer.user.uid,
        email: normalizeEmail(customer.user.email),
        name,
        groupId: target.id,
        membershipStatus: status,
        status,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    transaction.set(customer.registry, {
      uid: customer.user.uid,
      email: normalizeEmail(customer.user.email),
      name,
      profileDocId: customer.profile.id,
      groupId: target?.id ?? null,
      groupName: target ? cleanText(target.data.name) : null,
      ...registryPatch,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (profileSnapshot.exists) {
      transaction.set(customer.profile, {
        ...profilePatch,
        groupId: target?.id ?? null,
        groupName: target ? cleanText(target.data.name) : null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });
}

export async function createManagedCustomer(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const auth = getFirebaseAdminAuth();
  const name = requiredText(input.name, "Full name", 120);
  const email = normalizeEmail(requiredText(input.email, "Email", 254));
  const phone = cleanText(input.phone);
  const whatsapp = cleanText(input.whatsapp);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CustomerApiError(400, "Enter a valid email address.");
  }
  if (phone.length > 30 || whatsapp.length > 30) {
    throw new CustomerApiError(400, "Phone and WhatsApp numbers must be 30 characters or fewer.");
  }

  const group = await getActiveCustomerGroup(context, input.groupId);

  try {
    await auth.getUserByEmail(email);
    throw new CustomerApiError(409, "A Firebase Authentication account already uses this email.");
  } catch (error) {
    if (error instanceof CustomerApiError) throw error;
    if (!String((error as { code?: string }).code ?? "").includes("user-not-found")) throw error;
  }

  const existingProfile = await context.db.collection("users").doc(email).get();
  const existingByEmail = await context.db.collection("users")
    .where("email", "==", email).limit(10).get();

  if (existingProfile.exists || !existingByEmail.empty) {
    throw new CustomerApiError(409, "A Firestore profile already uses this email.");
  }

  const user = await auth.createUser({
    email,
    displayName: name,
    emailVerified: false,
    disabled: false,
  });

  const profile = context.db.collection("users").doc(email);
  const registry = context.root.collection("customers").doc(user.uid);
  const membership = group.ref.collection("customers").doc(user.uid);

  try {
    await context.db.runTransaction(async (transaction) => {
      const [profileSnapshot, groupSnapshot, registrySnapshot] = await Promise.all([
        transaction.get(profile),
        transaction.get(group.ref),
        transaction.get(registry),
      ]);

      if (profileSnapshot.exists || (registrySnapshot.exists &&
          cleanText(registrySnapshot.data()?.registrationSource) !== "self_registered")) {
        throw new CustomerApiError(409, "A matching profile or registry already exists.");
      }
      if (!groupSnapshot.exists || groupSnapshot.data()?.archived === true) {
        throw new CustomerApiError(409, "The selected group is no longer active.");
      }

      const now = FieldValue.serverTimestamp();
      transaction.create(profile, {
        uid: user.uid, email, teacherName: name, name, phone,
        whatsappNumber: whatsapp, role: "teacher", active: true,
        disabled: false, emailVerified: false,
        registrationSource: "admin_created", approvalStatus: "approved",
        groupId: group.id, groupName: cleanText(groupSnapshot.data()?.name),
        createdByAdminUid: context.uid, createdAt: now, updatedAt: now,
      });
      transaction.set(registry, {
        uid: user.uid, email, name, phone, whatsapp, profileDocId: profile.id,
        role: "teacher", registrationSource: "admin_created",
        approvalStatus: "approved", emailVerified: false,
        active: true, disabled: false, deleted: false,
        groupId: group.id, groupName: cleanText(groupSnapshot.data()?.name),
        classCount: 0, studentCount: 0, createdByAdminUid: context.uid,
        createdAt: now, updatedAt: now,
      });
      transaction.set(membership, {
        uid: user.uid, customerUid: user.uid, email, name,
        groupId: group.id, membershipStatus: "active", status: "active",
        createdAt: now, updatedAt: now,
      });
    });
  } catch (error) {
    try {
      await auth.deleteUser(user.uid);
    } catch {
      throw new CustomerApiError(500, "Customer setup failed. Check this newly created UID before retrying.");
    }
    throw error;
  }

  return { success: true, uid: user.uid, email };
}

export async function updateManagedCustomer(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const uid = requiredText(input.customerId, "Customer UID", 128);
  const name = requiredText(input.name, "Full name", 120);
  const phone = cleanText(input.phone);
  const whatsapp = cleanText(input.whatsapp);

  if (phone.length > 30 || whatsapp.length > 30) {
    throw new CustomerApiError(400, "Phone and WhatsApp numbers must be 30 characters or fewer.");
  }

  const customer = await resolveCustomer(context, uid);
  const groupId = cleanText(input.groupId) || null;

  await getFirebaseAdminAuth().updateUser(uid, { displayName: name });
  await writeCustomerMembership(
    context,
    customer,
    groupId,
    { name, phone, whatsapp, active: !customer.user.disabled },
    { name, teacherName: name, phone, whatsappNumber: whatsapp },
  );

  return { success: true, uid };
}

export async function approveManagedCustomer(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(context, requiredText(input.customerId, "Customer UID", 128));
  const approval = cleanText(customer.registryData.approvalStatus || customer.profileData.approvalStatus).toLowerCase();

  if (approval !== "pending") throw new CustomerApiError(409, "Only pending registrations can be approved.");
  if (!customer.user.emailVerified) throw new CustomerApiError(409, "The customer's email must be verified first.");

  const group = await getActiveCustomerGroup(context, input.groupId);
  await getFirebaseAdminAuth().updateUser(customer.user.uid, { disabled: false });

  await writeCustomerMembership(context, customer, group.id, {
    approvalStatus: "approved", active: true, disabled: false,
    emailVerified: true, reviewedBy: context.uid,
    reviewedAt: FieldValue.serverTimestamp(),
  }, {
    approvalStatus: "approved", active: true, disabled: false, emailVerified: true,
  });

  return { success: true, uid: customer.user.uid, groupId: group.id };
}

export async function rejectManagedCustomer(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(context, requiredText(input.customerId, "Customer UID", 128));
  const approval = cleanText(customer.registryData.approvalStatus || customer.profileData.approvalStatus).toLowerCase();

  if (approval !== "pending") throw new CustomerApiError(409, "Only pending registrations can be rejected.");

  await writeCustomerMembership(context, customer, null, {
    approvalStatus: "rejected", active: false, groupId: null, groupName: null,
    rejectedBy: context.uid, rejectedAt: FieldValue.serverTimestamp(),
  }, {
    approvalStatus: "rejected", active: false, groupId: null, groupName: null,
  });

  return { success: true, uid: customer.user.uid };
}

export async function assignManagedCustomerGroup(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(context, requiredText(input.customerId, "Customer UID", 128));
  const groupId = cleanText(input.groupId) || null;
  await writeCustomerMembership(context, customer, groupId);
  return { success: true, uid: customer.user.uid, groupId };
}

export async function archiveCustomerGroup(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const groupId = requiredText(input.groupId, "Group ID", 128);
  const groupRef = context.root.collection("customerGroups").doc(groupId);
  const registryQuery = context.root.collection("customers").where("groupId", "==", groupId);

  await context.db.runTransaction(async (transaction) => {
    const [groupSnapshot, memberships, assigned] = await Promise.all([
      transaction.get(groupRef),
      transaction.get(groupRef.collection("customers")),
      transaction.get(registryQuery),
    ]);

    if (!groupSnapshot.exists) throw new CustomerApiError(404, "Customer group was not found.");
    if (!memberships.empty || !assigned.empty) {
      throw new CustomerApiError(409, "Reassign or unassign this group's customers before archiving it.");
    }

    transaction.set(groupRef, {
      archived: true, active: false, archivedByUid: context.uid,
      archivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return { success: true, groupId, archived: true };
}

/** Soft-delete: disable access and retain profile, group history and all academic data. */
export async function archiveManagedCustomer(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(context, requiredText(input.customerId, "Customer UID", 128));
  const auth = getFirebaseAdminAuth();

  await auth.updateUser(customer.user.uid, { disabled: true });
  await auth.revokeRefreshTokens(customer.user.uid);

  const groups = await context.root.collection("customerGroups").get();
  const batch = context.db.batch();
  const deletedAt = FieldValue.serverTimestamp();

  batch.set(customer.registry, {
    deleted: true, active: false, disabled: true,
    deletedPreviousActive: customer.registryData.active ?? customer.profileData.active ?? true,
    deletedPreviousDisabled: customer.user.disabled,
    deletedAt, deletedByUid: context.uid, updatedAt: deletedAt,
  }, { merge: true });

  batch.set(customer.profile, {
    deleted: true, active: false, disabled: true,
    deletedAt, deletedByUid: context.uid, updatedAt: deletedAt,
  }, { merge: true });

  for (const group of groups.docs) {
    const membership = group.ref.collection("customers").doc(customer.user.uid);
    batch.set(membership, {
      membershipStatus: "deleted", status: "deleted",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await batch.commit();
  return { success: true, uid: customer.user.uid, deleted: true };
}

/** Restore an archived account without touching its classes, students, fees or attendance. */
export async function restoreManagedCustomer(
  request: CustomerApiRequest,
  input: Record<string, unknown>,
) {
  const context = await getAdminContext(request);
  const customer = await resolveCustomer(
    context,
    requiredText(input.customerId, "Customer UID", 128),
    true,
  );

  if (customer.registryData.deleted !== true &&
      customer.profileData.deleted !== true &&
      customer.profileData.isDeleted !== true) {
    throw new CustomerApiError(409, "This customer is not archived.");
  }

  const approval = cleanText(customer.registryData.approvalStatus || customer.profileData.approvalStatus).toLowerCase();
  const previousDisabled = customer.registryData.deletedPreviousDisabled === true;
  const disabled = previousDisabled;
  const active = customer.registryData.deletedPreviousActive !== false &&
    approval !== "pending" && approval !== "rejected" && !disabled;

  await getFirebaseAdminAuth().updateUser(customer.user.uid, { disabled });

  const groups = await context.root.collection("customerGroups").get();
  const batch = context.db.batch();
  const patch = {
    deleted: false, active, disabled,
    restoredAt: FieldValue.serverTimestamp(),
    restoredByUid: context.uid,
    updatedAt: FieldValue.serverTimestamp(),
  };

  batch.set(customer.registry, patch, { merge: true });
  batch.set(customer.profile, patch, { merge: true });

  const groupId = cleanText(customer.registryData.groupId || customer.profileData.groupId);
  const group = groupId ? groups.docs.find((doc) => doc.id === groupId && doc.data().archived !== true) : null;

  if (group) {
    batch.set(group.ref.collection("customers").doc(customer.user.uid), {
      uid: customer.user.uid,
      customerUid: customer.user.uid,
      email: normalizeEmail(customer.user.email),
      name: cleanText(customer.registryData.name || customer.profileData.name || customer.user.displayName),
      groupId: group.id,
      membershipStatus: approval === "pending" ? "pending" : approval === "rejected" ? "rejected" : disabled ? "disabled" : "active",
      status: approval === "pending" ? "pending" : approval === "rejected" ? "rejected" : disabled ? "disabled" : "active",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await batch.commit();
  return { success: true, uid: customer.user.uid, deleted: false, disabled, active };
}
