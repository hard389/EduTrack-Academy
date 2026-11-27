import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  decryptPostabiWebAppCredentials,
  encryptPostabiWebAppCredentials,
  hasPostabiWebAppCredentials,
  sendPostabiWebAppMessage,
} from "./postabiWebApp.js";
import type { Firestore, DocumentReference, CollectionReference, DocumentData } from "firebase-admin/firestore";
import {
  AdminApiAuthError,
  FirebaseAdminConfigurationError,
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
  verifyAdminRequest,
} from "./firebaseAdmin.js";

export type WhatsAppAdminRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};

export type WhatsAppAdminResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): WhatsAppAdminResponse;
  json(data: unknown): WhatsAppAdminResponse;
};

export class WhatsAppAdminError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "WhatsAppAdminError";
  }
}

type AdminWhatsAppContext = {
  db: Firestore;
  uid: string;
  email: string;
  root: DocumentReference<DocumentData>;
  settings: DocumentReference<DocumentData>;
  teachers: CollectionReference<DocumentData>;
  legacyTeachers: CollectionReference<DocumentData>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const POSTABI_CREDENTIAL_ENVELOPE_FIELDS = [
  "postabiAppKeyCiphertext",
  "postabiAppKeyIv",
  "postabiAppKeyTag",
  "postabiAuthKeyCiphertext",
  "postabiAuthKeyIv",
  "postabiAuthKeyTag",
  "postabiCredentialsEncryption",
] as const;

function hasSamePostabiCredentialEnvelope(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return POSTABI_CREDENTIAL_ENVELOPE_FIELDS.every((field) =>
    typeof left[field] === "string" &&
    left[field] === right[field]
  );
}

function normalizeEmail(value: unknown): string {
  return clean(value).toLowerCase();
}

export function normalizeWhatsAppAdminNumber(value: unknown): string {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`;
  if (digits.length < 8 || digits.length > 15) {
    throw new WhatsAppAdminError(400, "Enter a valid WhatsApp number with country code.");
  }
  return digits;
}

function getEncryptionKey(): Buffer {
  const configured = process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new WhatsAppAdminError(
      503,
      "Server credential encryption is not configured. Set WHATSAPP_CREDENTIALS_ENCRYPTION_KEY in the server environment.",
    );
  }
  const key = Buffer.from(configured, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== configured.replace(/=+$/, "")) {
    throw new WhatsAppAdminError(503, "Server credential encryption key must be a valid base64-encoded 32-byte key.");
  }
  return key;
}

function encryptCredential(plainText: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return {
    apiTokenCiphertext: ciphertext.toString("base64"),
    apiTokenIv: iv.toString("base64"),
    apiTokenTag: cipher.getAuthTag().toString("base64"),
    credentialEncryption: "aes-256-gcm-v1",
  };
}

export function decryptWhatsAppCredential(data: Record<string, unknown>): string {
  const ciphertext = clean(data.apiTokenCiphertext);
  const iv = clean(data.apiTokenIv);
  const tag = clean(data.apiTokenTag);
  if (!ciphertext || !iv || !tag) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new WhatsAppAdminError(503, "Stored WhatsApp credentials could not be decrypted. Check the server encryption key.");
  }
}

export async function getAdminWhatsAppContext(
  request: WhatsAppAdminRequest,
): Promise<AdminWhatsAppContext> {
  const actor = await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminFirestore();
  const authUser = await auth.getUser(actor.uid);
  const email = normalizeEmail(authUser.email);
  if (!email || email !== normalizeEmail(actor.email) || authUser.disabled) {
    throw new WhatsAppAdminError(403, "Administrator account verification failed.");
  }

  const users = db.collection("users");
  let profileId = "";
  try {
    const emailProfile = await users.doc(email).get();
    if (emailProfile.exists) {
      const data = emailProfile.data() ?? {};
      if (
        data.uid === actor.uid &&
        normalizeEmail(data.email ?? emailProfile.id) === email
      ) profileId = emailProfile.id;
    }

    if (!profileId) {
      const matches = await users.where("uid", "==", actor.uid).limit(10).get();
      const eligible = matches.docs.filter((doc) => {
        const data = doc.data();
        return data.uid === actor.uid &&
          normalizeEmail(data.email ?? doc.id) === email;
      });
      // The Firebase Admin claim is the authorization source.
      // A matching Firestore profile is optional metadata for management records.
      if (eligible.length === 1) profileId = eligible[0].id;
    }
  } catch (error) {
    console.warn("[whatsapp-admin-api] Optional teacher/admin profile lookup failed.", {
      code: clean((error as { code?: unknown } | null)?.code),
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const root = db.collection("admins").doc(email);
  // The Firebase admin claim and verified token email are the authorization source.
  // This legacy admin-root document is optional metadata, not a prerequisite for the
  // platform-wide WhatsApp configuration stored at platformSettings/whatsapp.
  // Read-only GET requests must not rewrite this document on every settings refresh.
  let rootMetadata: DocumentData | null = null;
  let rootReadSucceeded = false;
  try {
    const rootSnapshot = await root.get();
    rootReadSucceeded = true;
    rootMetadata = rootSnapshot.data() ?? null;
    if (rootSnapshot.exists && clean(rootMetadata?.adminUid) !== actor.uid) {
      throw new WhatsAppAdminError(403, "This administrator record belongs to a different account.");
    }
  } catch (error) {
    if (error instanceof WhatsAppAdminError) throw error;
    console.warn("[whatsapp-admin-api] Admin metadata projection could not be checked.", {
      code: clean((error as { code?: unknown } | null)?.code),
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const desiredAdminMetadata = {
    adminUid: actor.uid,
    email,
    adminProfileDocId: profileId || null,
    managementSchemaVersion: 1,
  };
  const adminMetadataChanged = !rootMetadata ||
    rootMetadata.adminUid !== desiredAdminMetadata.adminUid ||
    rootMetadata.email !== desiredAdminMetadata.email ||
    (rootMetadata.adminProfileDocId ?? null) !== desiredAdminMetadata.adminProfileDocId ||
    rootMetadata.managementSchemaVersion !== desiredAdminMetadata.managementSchemaVersion;

  // Create/repair optional metadata only when the already-read values show a change.
  // If the read failed (for example RESOURCE_EXHAUSTED), do not issue a speculative write.
  if (rootReadSucceeded && adminMetadataChanged) {
    try {
      await root.set({ ...desiredAdminMetadata, updatedAt: new Date().toISOString() }, { merge: true });
    } catch (error) {
      console.warn("[whatsapp-admin-api] Admin metadata projection could not be refreshed.", {
        code: clean((error as { code?: unknown } | null)?.code),
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  // Keep the central business WhatsApp configuration platform-wide.
  // Migrate one existing configured admin document without exposing credentials.
  const settings = db.collection("platformSettings").doc("whatsapp");
  const sharedSnapshot = await settings.get();

  if (!sharedSnapshot.exists) {
    const adminRoots = await db.collection("admins").get();

    const legacyCandidates = (await Promise.all(
      adminRoots.docs.map(async (adminDoc) => {
        const ref = adminDoc.ref.collection("integrations").doc("whatsapp");
        const snapshot = await ref.get();
        if (!snapshot.exists) return null;

        const data = snapshot.data() ?? {};
        const configured = Boolean(
          clean(data.apiTokenCiphertext) ||
          clean(data.businessNumber) ||
          data.enabled === true
        );

        return configured ? { ref, data } : null;
      }),
    )).filter(
      (candidate): candidate is {
        ref: DocumentReference<DocumentData>;
        data: DocumentData;
      } => candidate !== null,
    );

    if (legacyCandidates.length > 1) {
      throw new WhatsAppAdminError(
        409,
        "Multiple administrator WhatsApp configurations exist. Resolve the configuration conflict before migration.",
      );
    }

    if (legacyCandidates.length === 1) {
      const legacy = legacyCandidates[0];

      await db.runTransaction(async (transaction) => {
        const currentShared = await transaction.get(settings);
        if (currentShared.exists) return;

        const currentLegacy = await transaction.get(legacy.ref);
        if (!currentLegacy.exists) return;

        transaction.set(settings, {
          ...(currentLegacy.data() ?? {}),
          migratedFrom: legacy.ref.path,
          migratedAt: new Date().toISOString(),
        });
      });
    }
  }

  return {
    db,
    uid: actor.uid,
    email,
    root,
    settings,
    teachers: settings.collection("teacherSenders"),
    legacyTeachers: root.collection("teacherWhatsApp"),
  };
}

function validBase64Key(value: unknown, allowUnpadded = false): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32) return false;
  const canonical = decoded.toString("base64");
  return allowUnpadded
    ? canonical.replace(/=+$/, "") === encoded.replace(/=+$/, "")
    : canonical === encoded;
}

function isValidPublicAppUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return (url.protocol === "https:" || (local && url.protocol === "http:")) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function hasFirebaseAdminConfiguration(): boolean {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson) as Record<string, unknown>;
      return typeof parsed.project_id === "string" && Boolean(parsed.project_id.trim()) &&
        typeof parsed.client_email === "string" && Boolean(parsed.client_email.trim()) &&
        typeof parsed.private_key === "string" && Boolean(parsed.private_key.trim());
    } catch {
      return false;
    }
  }
  return Boolean(
    process.env.FIREBASE_PROJECT_ID?.trim() &&
    process.env.FIREBASE_CLIENT_EMAIL?.trim() &&
    process.env.FIREBASE_PRIVATE_KEY?.trim()
  );
}

function publicSettings(data: Record<string, unknown>) {
  const credentialsConfigured = hasPostabiWebAppCredentials(data);
  const hasLegacyApiToken = Boolean(clean(data.apiTokenCiphertext));

  return {
    provider: "postabi_web_app",
    businessNumber: clean(data.businessNumber),
    enabled: data.enabled === true,
    credentialsConfigured,
    appKeyConfigured: credentialsConfigured,
    authKeyConfigured: credentialsConfigured,
    // Retained temporarily for legacy UI/dispatch compatibility only.
    apiTokenConfigured: hasLegacyApiToken,
    configurationStatus: clean(data.configurationStatus) ||
      (credentialsConfigured && clean(data.businessNumber)
        ? "saved_not_verified"
        : "incomplete"),
    lastConnectionCheckAt: typeof data.lastConnectionCheckAt === "string"
      ? data.lastConnectionCheckAt
      : null,
    canSendMessages: false,
    testSendEnabled: process.env.WHATSAPP_TEST_SEND_ENABLED === "true",
    lastTestMessageStatus: typeof data.lastTestMessageStatus === "string"
      ? data.lastTestMessageStatus
      : null,
    lastTestMessageHttpStatus: typeof data.lastTestMessageHttpStatus === "number"
      ? data.lastTestMessageHttpStatus
      : null,
    lastTestMessageProviderStatus: typeof data.lastTestMessageProviderStatus === "string"
      ? data.lastTestMessageProviderStatus.slice(0, 60)
      : null,
    lastTestMessageProviderStatusCode: typeof data.lastTestMessageProviderStatusCode === "number"
      ? data.lastTestMessageProviderStatusCode
      : null,
    lastTestMessageRecipientLast4: typeof data.lastTestMessageRecipientLast4 === "string"
      ? data.lastTestMessageRecipientLast4
      : null,
    testMessageReceivedAt: typeof data.testMessageReceivedAt === "string"
      ? data.testMessageReceivedAt
      : null,
    attendanceDispatchEnabled: data.attendanceDispatchEnabled === true,
    attendanceDispatchServerEnabled:
      process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED === "true",
    monthlyReportDispatchEnabled:
      data.monthlyReportDispatchEnabled === true,
    monthlyReportDispatchServerEnabled:
      process.env.WHATSAPP_MONTHLY_REPORTS_ENABLED === "true" &&
      process.env.WHATSAPP_DISPATCH_ENABLED === "true",
    quizResultsDispatchEnabled: data.quizResultsDispatchEnabled === true,
    quizResultsDispatchServerEnabled: process.env.WHATSAPP_DISPATCH_ENABLED === "true",
    announcementDispatchEnabled: data.announcementDispatchEnabled === true,
    announcementDispatchServerEnabled:
      process.env.WHATSAPP_ANNOUNCEMENTS_ENABLED === "true" &&
      process.env.WHATSAPP_DISPATCH_ENABLED === "true",
    libraryLinkDispatchEnabled: data.libraryLinkDispatchEnabled === true,
    libraryLinkDispatchServerEnabled: process.env.WHATSAPP_LIBRARY_LINKS_ENABLED === "true" && process.env.WHATSAPP_DISPATCH_ENABLED === "true",
    sharedWhatsAppDispatchServerEnabled: process.env.WHATSAPP_DISPATCH_ENABLED === "true",
    feeAlertsDispatchServerEnabled:
      process.env.WHATSAPP_DISPATCH_ENABLED === "true" &&
      process.env.FEE_ALERTS_DISPATCH_ENABLED === "true",
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    firebaseAdminConfigured: hasFirebaseAdminConfiguration(),
    credentialsEncryptionKeyValid: validBase64Key(process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY, true),
    mediaSigningSecretValid: validBase64Key(process.env.WHATSAPP_MEDIA_SIGNING_SECRET),
    publicAppUrlValid: isValidPublicAppUrl(process.env.PUBLIC_APP_URL),
    apiBaseUrl: "https://webapi.postabi.com/api/whatsapp-web/send-message",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
  };
}

async function listTeacherConnections(ctx: AdminWhatsAppContext) {
  const migrationStateRef = ctx.settings.collection("metadata").doc("legacyTeacherMigration");
  const [profiles, canonicalSaved, migrationState] = await Promise.all([
    ctx.db.collection("users").where("role", "==", "teacher").get(),
    ctx.teachers.get(),
    migrationStateRef.get(),
  ]);

  // Legacy settings were copied to the shared sender directory once. After the migration
  // marker is complete, avoid downloading the entire legacy collection on every GET.
  const legacySaved = migrationState.data()?.complete === true
    ? null
    : await ctx.legacyTeachers.get();
  const savedByUid = new Map<string, DocumentData>(
    (legacySaved?.docs ?? []).filter((doc) => doc.id !== "__meta__").map((doc) => [doc.id, doc.data()] as const),
  );

  for (const doc of canonicalSaved.docs) {
    savedByUid.set(doc.id, doc.data());
  }

  if (legacySaved && migrationState.data()?.complete !== true) {
    // Copy legacy admin-scoped settings only when no shared sender record exists.
    const canonicalIds = new Set(canonicalSaved.docs.map((doc) => doc.id));
    const legacyToMigrate = legacySaved.docs.filter(
      (doc) => doc.id !== "__meta__" && !canonicalIds.has(doc.id),
    );

    await Promise.all(legacyToMigrate.map((doc) =>
      ctx.teachers.doc(doc.id).set({
        ...doc.data(),
        migratedFromLegacyAdminConfig: true,
        migratedAt: new Date().toISOString(),
      }, { merge: true }),
    ));
    await migrationStateRef.set({ complete: true, completedAt: new Date().toISOString() }, { merge: true });
  }

  const teachersByUid = new Map<string, Record<string, unknown>>();
  const ambiguous = new Set<string>();

  for (const doc of profiles.docs) {
    const profile = doc.data();
    if (clean(profile.role).toLowerCase() !== "teacher") continue;

    const uid = clean(profile.uid);
    const email = normalizeEmail(profile.email ?? doc.id);

    if (!uid || !email || uid === ctx.uid || ambiguous.has(uid)) continue;

    const candidate = {
      uid,
      email,
      name: clean(profile.displayName) || clean(profile.name) ||
        clean(profile.fullName) || email,
      profileWhatsAppNumber: clean(profile.whatsappNumber) ||
        clean(profile.whatsapp) || clean(profile.phoneNumber) ||
        clean(profile.phone),
    };

    const previous = teachersByUid.get(uid);

    if (previous && previous.email !== email) {
      teachersByUid.delete(uid);
      ambiguous.add(uid);
      continue;
    }

    if (!previous || doc.id === email) teachersByUid.set(uid, candidate);
  }

  return [...teachersByUid.values()]
    .map((teacher) => {
      const savedConfig = savedByUid.get(String(teacher.uid));
      const personalCredentialsConfigured = savedConfig
        ? hasPostabiWebAppCredentials(savedConfig)
        : false;
      const isVerified =
        personalCredentialsConfigured &&
        savedConfig?.connectionStatus === "verified";

      return {
        uid: teacher.uid,
        email: teacher.email,
        name: teacher.name,
        phoneNumber: savedConfig
          ? clean(savedConfig.phoneNumber)
          : clean(teacher.profileWhatsAppNumber),
        selectedForPersonalRouting:
          isVerified && savedConfig?.selectedForPersonalRouting === true,
        hasPersonalCredentials: personalCredentialsConfigured,
        connectionStatus: personalCredentialsConfigured
          ? clean(savedConfig?.connectionStatus) || "saved_not_verified"
          : savedConfig
            ? "number_saved_not_connected"
            : "not_configured",
        testStatus: clean(savedConfig?.testStatus) || null,
        testRecipientLast4: clean(savedConfig?.testRecipientLast4) || null,
        providerFromLast4: clean(savedConfig?.providerFromLast4) || null,
        sessionSupported: false,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getWhatsAppAdminSettings(request: WhatsAppAdminRequest) {
  const ctx = await getAdminWhatsAppContext(request);
  const snapshot = await ctx.settings.get();
  const settings = publicSettings(snapshot.data() ?? {});
  let teachers: Awaited<ReturnType<typeof listTeacherConnections>> = [];
  let teacherListWarning: string | null = null;
  try {
    teachers = await listTeacherConnections(ctx);
  } catch (error) {
    // Teacher-specific optional settings must not make central business settings unavailable.
    const code = clean((error as { code?: unknown } | null)?.code).slice(0, 100) || "unknown";
    console.error("[whatsapp-admin-api] Teacher sender list could not be loaded.", {
      adminUid: ctx.uid,
      code,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
    teacherListWarning = "Central WhatsApp settings loaded, but teacher-specific sender details could not be loaded. Check the WhatsApp API server logs and refresh.";
  }
  return { success: true, settings, teachers, teacherListWarning };
}

async function updateQuizResultsDispatchAuthorization(
  ctx: AdminWhatsAppContext,
  body: Record<string, unknown>,
) {
  const action = clean(body.quizResultsDispatchAction);
  const snapshot = await ctx.settings.get();
  const current = snapshot.data() ?? {};
  const now = new Date().toISOString();

  if (action === "disable") {
    await ctx.settings.set({
      quizResultsDispatchEnabled: false,
      quizResultsDispatchAuthorizationRevokedAt: now,
      quizResultsDispatchAuthorizationRevokedByUid: ctx.uid,
      quizResultsDispatchAuthorizationRevokedByEmail: ctx.email,
      updatedByUid: ctx.uid,
      updatedByEmail: ctx.email,
      updatedAt: now,
    }, { merge: true });

    const saved = await ctx.settings.get();
    return {
      success: true,
      settings: publicSettings(saved.data() ?? {}),
      message: "Quiz Results WhatsApp messages are disabled. No new quiz-result messages will be dispatched.",
    };
  }

  if (action !== "enable") {
    throw new WhatsAppAdminError(400, "A valid Quiz Results authorization action is required.");
  }

  if (body.confirmRealQuizResultMessages !== true) {
    throw new WhatsAppAdminError(
      400,
      "Explicit authorization for real Quiz Results WhatsApp messages to opted-in guardians is required.",
    );
  }

  if (process.env.WHATSAPP_DISPATCH_ENABLED !== "true") {
    throw new WhatsAppAdminError(
      503,
      "The server-side WhatsApp dispatch switch is OFF. Quiz Results authorization cannot be activated yet.",
    );
  }

  if (current.enabled !== true) {
    throw new WhatsAppAdminError(
      409,
      "Enable and save the central WhatsApp configuration first.",
    );
  }

  try {
    normalizeWhatsAppAdminNumber(current.businessNumber);
  } catch {
    throw new WhatsAppAdminError(
      409,
      "Save a valid central business WhatsApp number before authorizing Quiz Results messages.",
    );
  }

  if (!hasPostabiWebAppCredentials(current)) {
    throw new WhatsAppAdminError(
      409,
      "Both central Postabi App Key and Auth Key must be saved first.",
    );
  }

  let credentials;
  try {
    credentials = decryptPostabiWebAppCredentials(current);
  } catch {
    throw new WhatsAppAdminError(
      503,
      "Saved Postabi credentials could not be decrypted with the current server encryption key.",
    );
  }
  if (!clean(credentials.appKey) || !clean(credentials.authKey)) {
    throw new WhatsAppAdminError(
      503,
      "Saved Postabi credentials are incomplete after decryption.",
    );
  }

  await ctx.settings.set({
    quizResultsDispatchEnabled: true,
    quizResultsDispatchAuthorizationVersion: 1,
    quizResultsDispatchAuthorizationScope: "quiz_results_to_opted_in_guardians_only",
    quizResultsDispatchAuthorizedAt: now,
    quizResultsDispatchAuthorizedByUid: ctx.uid,
    quizResultsDispatchAuthorizedByEmail: ctx.email,
    quizResultsDispatchAuthorizationRevokedAt: null,
    updatedByUid: ctx.uid,
    updatedByEmail: ctx.email,
    updatedAt: now,
  }, { merge: true });

  const saved = await ctx.settings.get();
  return {
    success: true,
    settings: publicSettings(saved.data() ?? {}),
    message: "Quiz Results WhatsApp messages are administratively authorized only for guardians with current, explicit Quiz Results consent for the saved contact number. This authorization did not send a message and does not confirm provider delivery.",
  };
}

async function updateAnnouncementDispatchAuthorization(
  ctx: AdminWhatsAppContext,
  body: Record<string, unknown>,
) {
  const action = clean(body.announcementDispatchAction);
  const snapshot = await ctx.settings.get();
  const current = snapshot.data() ?? {};
  const now = new Date().toISOString();

  if (action === "disable") {
    await ctx.settings.set({
      announcementDispatchEnabled: false,
      announcementDispatchAuthorizationRevokedAt: now,
      announcementDispatchAuthorizationRevokedByUid: ctx.uid,
      announcementDispatchAuthorizationRevokedByEmail: ctx.email,
      updatedByUid: ctx.uid,
      updatedByEmail: ctx.email,
      updatedAt: now,
    }, { merge: true });
    const saved = await ctx.settings.get();
    return {
      success: true,
      settings: publicSettings(saved.data() ?? {}),
      message: "School Announcements WhatsApp messages are disabled. Pending recipients will not be sent while authorization is off.",
    };
  }

  if (action !== "enable") {
    throw new WhatsAppAdminError(400, "A valid School Announcements authorization action is required.");
  }

  if (body.confirmRealAnnouncementMessages !== true) {
    throw new WhatsAppAdminError(400, "Explicit authorization for real School Announcements WhatsApp messages is required.");
  }

  if (
    process.env.WHATSAPP_DISPATCH_ENABLED !== "true" ||
    process.env.WHATSAPP_ANNOUNCEMENTS_ENABLED !== "true"
  ) {
    throw new WhatsAppAdminError(503, "The server-side announcement dispatch switches are OFF. Authorization cannot be activated yet.");
  }

  if (current.enabled !== true) {
    throw new WhatsAppAdminError(409, "Enable and save the central WhatsApp configuration first.");
  }

  try {
    normalizeWhatsAppAdminNumber(current.businessNumber);
  } catch {
    throw new WhatsAppAdminError(409, "Save a valid central business WhatsApp number before authorizing announcements.");
  }

  if (!hasPostabiWebAppCredentials(current)) {
    throw new WhatsAppAdminError(409, "Both central Postabi App Key and Auth Key must be saved first.");
  }

  let credentials;
  try {
    credentials = decryptPostabiWebAppCredentials(current);
  } catch {
    throw new WhatsAppAdminError(503, "Saved Postabi credentials could not be decrypted with the current server encryption key.");
  }
  if (!clean(credentials.appKey) || !clean(credentials.authKey)) {
    throw new WhatsAppAdminError(503, "Saved Postabi credentials are incomplete after decryption.");
  }

  await ctx.settings.set({
    announcementDispatchEnabled: true,
    announcementDispatchAuthorizationVersion: 1,
    announcementDispatchAuthorizationScope: "announcements_to_opted_in_guardians_only",
    announcementDispatchAuthorizedAt: now,
    announcementDispatchAuthorizedByUid: ctx.uid,
    announcementDispatchAuthorizedByEmail: ctx.email,
    announcementDispatchAuthorizationRevokedAt: null,
    updatedByUid: ctx.uid,
    updatedByEmail: ctx.email,
    updatedAt: now,
  }, { merge: true });

  const saved = await ctx.settings.get();
  return {
    success: true,
    settings: publicSettings(saved.data() ?? {}),
    message: "School Announcements WhatsApp is authorized only for guardians with current, recorded announcement consent for the matching contact number. This authorization did not send a message, and provider acceptance is not delivery confirmation.",
  };
}

async function updateLibraryLinkDispatchAuthorization(
  ctx: AdminWhatsAppContext,
  body: Record<string, unknown>,
) {
  const action = clean(body.libraryLinkDispatchAction);
  const snapshot = await ctx.settings.get();
  const current = snapshot.data() ?? {};
  const now = new Date().toISOString();
  if (action === "disable") {
    await ctx.settings.set({
      libraryLinkDispatchEnabled: false,
      libraryLinkDispatchAuthorizationRevokedAt: now,
      libraryLinkDispatchAuthorizationRevokedByUid: ctx.uid,
      libraryLinkDispatchAuthorizationRevokedByEmail: ctx.email,
      updatedByUid: ctx.uid, updatedByEmail: ctx.email, updatedAt: now,
    }, { merge: true });
    const saved = await ctx.settings.get();
    return { success: true, settings: publicSettings(saved.data() ?? {}), message: "Library resource-link WhatsApp sharing is disabled. No new resource-link messages will be dispatched." };
  }
  if (action !== "enable") throw new WhatsAppAdminError(400, "A valid Library Link WhatsApp authorization action is required.");
  if (body.confirmRealLibraryLinkMessages !== true) throw new WhatsAppAdminError(400, "Explicit authorization for real Library Link WhatsApp messages to opted-in guardians is required.");
  if (process.env.WHATSAPP_DISPATCH_ENABLED !== "true" || process.env.WHATSAPP_LIBRARY_LINKS_ENABLED !== "true") {
    throw new WhatsAppAdminError(503, "The server-side Library Link dispatch switches are OFF. Authorization cannot be activated yet.");
  }
  if (current.enabled !== true) throw new WhatsAppAdminError(409, "Enable and save the central WhatsApp configuration first.");
  try { normalizeWhatsAppAdminNumber(current.businessNumber); }
  catch { throw new WhatsAppAdminError(409, "Save a valid central business WhatsApp number before authorizing Library Link messages."); }
  if (!hasPostabiWebAppCredentials(current)) throw new WhatsAppAdminError(409, "Both central Postabi App Key and Auth Key must be saved first.");
  let credentials;
  try { credentials = decryptPostabiWebAppCredentials(current); }
  catch { throw new WhatsAppAdminError(503, "Saved Postabi credentials could not be decrypted with the current server encryption key."); }
  if (!clean(credentials.appKey) || !clean(credentials.authKey)) throw new WhatsAppAdminError(503, "Saved Postabi credentials are incomplete after decryption.");
  await ctx.settings.set({
    libraryLinkDispatchEnabled: true,
    libraryLinkDispatchAuthorizationVersion: 1,
    libraryLinkDispatchAuthorizationScope: "library_resource_links_to_opted_in_guardians_only",
    libraryLinkDispatchAuthorizedAt: now,
    libraryLinkDispatchAuthorizedByUid: ctx.uid,
    libraryLinkDispatchAuthorizedByEmail: ctx.email,
    libraryLinkDispatchAuthorizationRevokedAt: null,
    updatedByUid: ctx.uid, updatedByEmail: ctx.email, updatedAt: now,
  }, { merge: true });
  const saved = await ctx.settings.get();
  return { success: true, settings: publicSettings(saved.data() ?? {}), message: "Library Link WhatsApp is authorized only for guardians with current, separate resource-link consent for the matching saved phone number. Authorization did not send a message; provider acceptance is not delivery confirmation." };
}

export async function saveWhatsAppAdminSettings(request: WhatsAppAdminRequest) {
  const ctx = await getAdminWhatsAppContext(request);

  if (!isRecord(request.body)) {
    throw new WhatsAppAdminError(400, "A valid JSON request body is required.");
  }

  const body = request.body;
  if (body.quizResultsDispatchAction === "enable" || body.quizResultsDispatchAction === "disable") {
    return updateQuizResultsDispatchAuthorization(ctx, body);
  }
  if (body.announcementDispatchAction === "enable" || body.announcementDispatchAction === "disable") {
    return updateAnnouncementDispatchAuthorization(ctx, body);
  }
  if (body.libraryLinkDispatchAction === "enable" || body.libraryLinkDispatchAction === "disable") {
    return updateLibraryLinkDispatchAuthorization(ctx, body);
  }
  const businessNumber = normalizeWhatsAppAdminNumber(body.businessNumber);
  const currentSnapshot = await ctx.settings.get();
  const current = currentSnapshot.data() ?? {};
  const enabled = typeof body.enabled === "boolean"
    ? body.enabled
    : current.enabled === true;

  const appKey = clean(body.appKey);
  const authKey = clean(body.authKey);
  const removeCredentials = body.removeCredentials === true;

  if (Boolean(appKey) !== Boolean(authKey)) {
    throw new WhatsAppAdminError(
      400,
      "Enter both the Postabi App Key and Auth Key together.",
    );
  }

  if (removeCredentials && (appKey || authKey)) {
    throw new WhatsAppAdminError(
      400,
      "Choose either replace or remove the Postabi Web App credentials.",
    );
  }

  let credentialPatch: Record<string, unknown> = {};
  const hasCurrentCredentials = hasPostabiWebAppCredentials(current);

  if (appKey && authKey) {
    try {
      credentialPatch = encryptPostabiWebAppCredentials(appKey, authKey);
    } catch (error) {
      throw new WhatsAppAdminError(
        400,
        error instanceof Error ? error.message : "Postabi credentials could not be encrypted.",
      );
    }
  } else if (removeCredentials) {
    credentialPatch = {
      postabiAppKeyCiphertext: null,
      postabiAppKeyIv: null,
      postabiAppKeyTag: null,
      postabiAuthKeyCiphertext: null,
      postabiAuthKeyIv: null,
      postabiAuthKeyTag: null,
      postabiCredentialsEncryption: null,
    };
  }

  const willHaveCredentials = appKey
    ? true
    : removeCredentials
      ? false
      : hasCurrentCredentials;

  const credentialsChanged = Boolean(appKey && authKey) || removeCredentials;
  const businessNumberChanged = businessNumber !== clean(current.businessNumber);

  if (body.attendanceDispatchEnabled === true) {
    throw new WhatsAppAdminError(
      409,
      "Authorize real attendance alerts through the dedicated attendance authorization action.",
    );
  }

  const previousStatus = clean(current.configurationStatus);
  const previousAuthorizationActive =
    current.attendanceDispatchEnabled === true &&
    previousStatus === "admin_authorized_unverified" &&
    current.attendanceDispatchAuthorizationVersion === 1 &&
    current.attendanceDispatchAuthorizationScope === "attendance_alerts_only" &&
    typeof current.attendanceDispatchAuthorizedAt === "string" &&
    current.attendanceDispatchAuthorizedAt.trim().length > 0 &&
    typeof current.attendanceDispatchAuthorizedByUid === "string" &&
    current.attendanceDispatchAuthorizedByUid.trim().length > 0;

  const authorizationMustBeRevoked =
    credentialsChanged ||
    businessNumberChanged ||
    !enabled ||
    !willHaveCredentials;

  const previousMonthlyAuthorizationActive =
    current.monthlyReportDispatchEnabled === true &&
    current.monthlyReportDispatchAuthorizationVersion === 1 &&
    current.monthlyReportDispatchAuthorizationScope ===
      "monthly_report_pdfs_only" &&
    typeof current.monthlyReportDispatchAuthorizedAt === "string" &&
    current.monthlyReportDispatchAuthorizedAt.trim().length > 0 &&
    typeof current.monthlyReportDispatchAuthorizedByUid === "string" &&
    current.monthlyReportDispatchAuthorizedByUid.trim().length > 0;

  const monthlyReportDispatchEnabled =
    previousMonthlyAuthorizationActive &&
    !authorizationMustBeRevoked;

  const previousQuizResultsAuthorizationActive =
    current.quizResultsDispatchEnabled === true &&
    current.quizResultsDispatchAuthorizationVersion === 1 &&
    current.quizResultsDispatchAuthorizationScope === "quiz_results_to_opted_in_guardians_only" &&
    typeof current.quizResultsDispatchAuthorizedAt === "string" &&
    current.quizResultsDispatchAuthorizedAt.trim().length > 0 &&
    typeof current.quizResultsDispatchAuthorizedByUid === "string" &&
    current.quizResultsDispatchAuthorizedByUid.trim().length > 0;

  const quizResultsDispatchEnabled =
    previousQuizResultsAuthorizationActive && !authorizationMustBeRevoked;

  const previousAnnouncementAuthorizationActive =
    current.announcementDispatchEnabled === true &&
    current.announcementDispatchAuthorizationVersion === 1 &&
    current.announcementDispatchAuthorizationScope === "announcements_to_opted_in_guardians_only" &&
    typeof current.announcementDispatchAuthorizedAt === "string" &&
    current.announcementDispatchAuthorizedAt.trim().length > 0 &&
    typeof current.announcementDispatchAuthorizedByUid === "string" &&
    current.announcementDispatchAuthorizedByUid.trim().length > 0;

  const announcementDispatchEnabled =
    previousAnnouncementAuthorizationActive && !authorizationMustBeRevoked;

  const previousLibraryLinkAuthorizationActive =
    current.libraryLinkDispatchEnabled === true &&
    current.libraryLinkDispatchAuthorizationVersion === 1 &&
    current.libraryLinkDispatchAuthorizationScope === "library_resource_links_to_opted_in_guardians_only" &&
    typeof current.libraryLinkDispatchAuthorizedAt === "string" && current.libraryLinkDispatchAuthorizedAt.trim().length > 0 &&
    typeof current.libraryLinkDispatchAuthorizedByUid === "string" && current.libraryLinkDispatchAuthorizedByUid.trim().length > 0;
  const libraryLinkDispatchEnabled = previousLibraryLinkAuthorizationActive && !authorizationMustBeRevoked;

  const attendanceDispatchEnabled =
    previousAuthorizationActive &&
    !authorizationMustBeRevoked &&
    body.attendanceDispatchEnabled !== false;

  const configurationStatus = attendanceDispatchEnabled
    ? previousStatus
    : willHaveCredentials && businessNumber
      ? "saved_not_verified"
      : "incomplete";

  if (enabled && !willHaveCredentials) {
    throw new WhatsAppAdminError(
      400,
      "Add both Postabi App Key and Auth Key before enabling the central connection.",
    );
  }

  const updatedAt = new Date().toISOString();

  const settingsUpdate: Record<string, unknown> = {
    provider: "postabi_web_app",
    apiBaseUrl: "https://webapi.postabi.com/api/whatsapp-web/send-message",
    businessNumber,
    enabled,
    ...credentialPatch,
    configurationStatus,
    attendanceDispatchEnabled,
    monthlyReportDispatchEnabled,
    quizResultsDispatchEnabled,
    announcementDispatchEnabled,
    libraryLinkDispatchEnabled,
    // Keep the legacy global dispatcher disabled. Each feature has its own authorization.
    dispatchEnabled: false,
    ...(previousMonthlyAuthorizationActive && !monthlyReportDispatchEnabled ? {
      monthlyReportDispatchAuthorizationRevokedAt: updatedAt,
      monthlyReportDispatchAuthorizationRevokedByUid: ctx.uid,
      monthlyReportDispatchAuthorizationRevokedByEmail: ctx.email,
    } : {}),
    ...(previousQuizResultsAuthorizationActive && !quizResultsDispatchEnabled ? {
      quizResultsDispatchAuthorizationRevokedAt: updatedAt,
      quizResultsDispatchAuthorizationRevokedByUid: ctx.uid,
      quizResultsDispatchAuthorizationRevokedByEmail: ctx.email,
    } : {}),
    ...(previousAnnouncementAuthorizationActive && !announcementDispatchEnabled ? {
      announcementDispatchAuthorizationRevokedAt: updatedAt,
      announcementDispatchAuthorizationRevokedByUid: ctx.uid,
      announcementDispatchAuthorizationRevokedByEmail: ctx.email,
    } : {}),
    ...(previousLibraryLinkAuthorizationActive && !libraryLinkDispatchEnabled ? {
      libraryLinkDispatchAuthorizationRevokedAt: updatedAt,
      libraryLinkDispatchAuthorizationRevokedByUid: ctx.uid,
      libraryLinkDispatchAuthorizationRevokedByEmail: ctx.email,
    } : {}),
    ...(previousAuthorizationActive && !attendanceDispatchEnabled ? {
      attendanceDispatchAuthorizationRevokedAt: updatedAt,
      attendanceDispatchAuthorizationRevokedByUid: ctx.uid,
      attendanceDispatchAuthorizationRevokedByEmail: ctx.email,
    } : {}),
    updatedByUid: ctx.uid,
    updatedByEmail: ctx.email,
    updatedAt,
  };

  await ctx.settings.set(settingsUpdate, { merge: true });

  // Return the merged value we just committed. Avoid a second Firestore read that
  // could fail after the write succeeded and make the UI report a false save failure.
  return {
    success: true,
    settings: publicSettings({ ...current, ...settingsUpdate }),
  };
}


export async function setAttendanceDispatchAuthorization(
  request: WhatsAppAdminRequest,
) {
  const ctx = await getAdminWhatsAppContext(request);

  if (!isRecord(request.body) || typeof request.body.enabled !== "boolean") {
    throw new WhatsAppAdminError(400, "A valid attendance authorization action is required.");
  }

  const snapshot = await ctx.settings.get();
  const current = snapshot.data() ?? {};
  const now = new Date().toISOString();

  if (request.body.enabled === false) {
    const nextStatus =
      hasPostabiWebAppCredentials(current) && clean(current.businessNumber)
        ? "saved_not_verified"
        : "incomplete";

    await ctx.settings.set({
      attendanceDispatchEnabled: false,
      configurationStatus: nextStatus,
      attendanceDispatchAuthorizationRevokedAt: now,
      attendanceDispatchAuthorizationRevokedByUid: ctx.uid,
      attendanceDispatchAuthorizationRevokedByEmail: ctx.email,
      updatedByUid: ctx.uid,
      updatedByEmail: ctx.email,
      updatedAt: now,
    }, { merge: true });

    const saved = await ctx.settings.get();

    return {
      success: true,
      settings: publicSettings(saved.data() ?? {}),
      message: "Attendance WhatsApp alerts are disabled. No new attendance messages will be dispatched.",
    };
  }

  if (request.body.confirmRealGuardianMessages !== true) {
    throw new WhatsAppAdminError(
      400,
      "Explicit authorization for real guardian attendance messages is required.",
    );
  }

  if (process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED !== "true") {
    throw new WhatsAppAdminError(
      503,
      "The server-side attendance dispatch switch is OFF. Authorization cannot be activated yet.",
    );
  }

  if (current.enabled !== true) {
    throw new WhatsAppAdminError(
      409,
      "Enable and save the central WhatsApp configuration first.",
    );
  }

  try {
    normalizeWhatsAppAdminNumber(current.businessNumber);
  } catch {
    throw new WhatsAppAdminError(
      409,
      "Save a valid central business WhatsApp number before authorizing attendance alerts.",
    );
  }

  if (!hasPostabiWebAppCredentials(current)) {
    throw new WhatsAppAdminError(
      409,
      "Both Postabi App Key and Auth Key must be saved first.",
    );
  }

  let credentials;
  try {
    credentials = decryptPostabiWebAppCredentials(current);
  } catch {
    throw new WhatsAppAdminError(
      503,
      "Saved Postabi credentials could not be decrypted with the current server encryption key.",
    );
  }

  if (!credentials.appKey.trim() || !credentials.authKey.trim()) {
    throw new WhatsAppAdminError(
      503,
      "Saved Postabi credentials are incomplete after decryption.",
    );
  }

  await ctx.settings.set({
    attendanceDispatchEnabled: true,
    configurationStatus: "admin_authorized_unverified",
    attendanceDispatchAuthorizedAt: now,
    attendanceDispatchAuthorizedByUid: ctx.uid,
    attendanceDispatchAuthorizedByEmail: ctx.email,
    attendanceDispatchAuthorizationScope: "attendance_alerts_only",
    attendanceDispatchAuthorizationVersion: 1,
    attendanceDispatchAuthorizationRevokedAt: null,
    providerCredentialsVerified: false,
    deliveryVerified: false,
    updatedByUid: ctx.uid,
    updatedByEmail: ctx.email,
    updatedAt: now,
  }, { merge: true });

  const saved = await ctx.settings.get();

  return {
    success: true,
    settings: publicSettings(saved.data() ?? {}),
    message: "Real attendance alerts are administratively authorized for eligible guardians with explicit attendance consent. This action did not contact Postabi or send a message. A future eligible normal attendance save may send a real WhatsApp message; delivery is not verified by this authorization.",
  };
}


export async function setMonthlyReportDispatchAuthorization(
  request: WhatsAppAdminRequest,
) {
  const ctx = await getAdminWhatsAppContext(request);

  if (!isRecord(request.body) || typeof request.body.enabled !== "boolean") {
    throw new WhatsAppAdminError(
      400,
      "A valid monthly report authorization action is required.",
    );
  }

  const snapshot = await ctx.settings.get();
  const current = snapshot.data() ?? {};
  const now = new Date().toISOString();

  if (request.body.enabled === false) {
    await ctx.settings.set({
      monthlyReportDispatchEnabled: false,
      monthlyReportDispatchAuthorizationRevokedAt: now,
      monthlyReportDispatchAuthorizationRevokedByUid: ctx.uid,
      monthlyReportDispatchAuthorizationRevokedByEmail: ctx.email,
      updatedByUid: ctx.uid,
      updatedByEmail: ctx.email,
      updatedAt: now,
    }, { merge: true });

    const saved = await ctx.settings.get();

    return {
      success: true,
      settings: publicSettings(saved.data() ?? {}),
      message: "Monthly PDF WhatsApp dispatch is disabled. No new report messages will be dispatched.",
    };
  }

  if (request.body.confirmRealMonthlyReportMessages !== true) {
    throw new WhatsAppAdminError(
      400,
      "Explicit authorization for real monthly PDF messages to opted-in guardians is required.",
    );
  }

  if (
    process.env.WHATSAPP_MONTHLY_REPORTS_ENABLED !== "true" ||
    process.env.WHATSAPP_DISPATCH_ENABLED !== "true"
  ) {
    throw new WhatsAppAdminError(
      503,
      "Monthly report server feature flags are OFF. Authorization cannot be activated.",
    );
  }

  if (current.enabled !== true) {
    throw new WhatsAppAdminError(
      409,
      "Enable and save the central WhatsApp configuration first.",
    );
  }

  try {
    normalizeWhatsAppAdminNumber(current.businessNumber);
  } catch {
    throw new WhatsAppAdminError(
      409,
      "Save a valid central business WhatsApp number before authorizing monthly reports.",
    );
  }

  if (!hasPostabiWebAppCredentials(current)) {
    throw new WhatsAppAdminError(
      409,
      "Both central Postabi App Key and Auth Key must be saved first.",
    );
  }

  try {
    const credentials = decryptPostabiWebAppCredentials(current);

    if (!credentials.appKey.trim() || !credentials.authKey.trim()) {
      throw new Error("Credentials are incomplete.");
    }
  } catch {
    throw new WhatsAppAdminError(
      503,
      "Central Postabi credentials could not be decrypted or are incomplete.",
    );
  }

  await ctx.settings.set({
    monthlyReportDispatchEnabled: true,
    monthlyReportDispatchAuthorizationVersion: 1,
    monthlyReportDispatchAuthorizationScope: "monthly_report_pdfs_only",
    monthlyReportDispatchAuthorizedAt: now,
    monthlyReportDispatchAuthorizedByUid: ctx.uid,
    monthlyReportDispatchAuthorizedByEmail: ctx.email,
    monthlyReportDispatchAuthorizationRevokedAt: null,
    updatedByUid: ctx.uid,
    updatedByEmail: ctx.email,
    updatedAt: now,
  }, { merge: true });

  const saved = await ctx.settings.get();

  return {
    success: true,
    settings: publicSettings(saved.data() ?? {}),
    message: "Monthly PDF messages are administratively authorized only for guardians with current explicit monthly-report WhatsApp consent. This action did not send a PDF or verify provider delivery. A future eligible teacher action may send a real PDF.",
  };
}


export async function saveTeacherWhatsAppConnection(
  request: WhatsAppAdminRequest,
  uidValue: unknown,
) {
  const ctx = await getAdminWhatsAppContext(request);
  const uid = clean(uidValue);

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new WhatsAppAdminError(400, "A valid teacher UID is required.");
  }

  if (!isRecord(request.body)) {
    throw new WhatsAppAdminError(400, "A valid JSON request body is required.");
  }

  const auth = getFirebaseAdminAuth();
  let authUser;

  try {
    authUser = await auth.getUser(uid);
  } catch {
    throw new WhatsAppAdminError(404, "Teacher account was not found.");
  }

  const profileMatches = await ctx.db.collection("users")
    .where("uid", "==", uid)
    .limit(10)
    .get();

  const email = normalizeEmail(authUser.email);

  const eligible = profileMatches.docs.filter((doc) => {
    const profile = doc.data();

    return clean(profile.role).toLowerCase() === "teacher" &&
      profile.uid === uid &&
      normalizeEmail(profile.email ?? doc.id) === email &&
      profile.deleted !== true &&
      profile.isDeleted !== true;
  });

  if (eligible.length !== 1) {
    throw new WhatsAppAdminError(
      eligible.length > 1 ? 409 : 404,
      eligible.length > 1
        ? "Multiple teacher profiles match this account. Resolve the duplicate profile first."
        : "The selected account is not a verified teacher profile.",
    );
  }

  const body = request.body;
  const phoneInput = clean(body.phoneNumber);
  const selectedForPersonalRouting =
    body.selectedForPersonalRouting === true;
  const appKey = clean(body.appKey);
  const authKey = clean(body.authKey);
  const removeCredentials = body.removeCredentials === true;

  if (Boolean(appKey) !== Boolean(authKey)) {
    throw new WhatsAppAdminError(
      400,
      "Enter both the teacher's Postabi App Key and Auth Key together.",
    );
  }

  if (removeCredentials && (appKey || authKey)) {
    throw new WhatsAppAdminError(
      400,
      "Choose either replace or remove the teacher's Postabi credentials.",
    );
  }

  const ref = ctx.teachers.doc(uid);
  const legacyRef = ctx.legacyTeachers.doc(uid);

  if (!phoneInput) {
    if (selectedForPersonalRouting || appKey || authKey) {
      throw new WhatsAppAdminError(
        400,
        "Save a personal WhatsApp number before configuring personal routing.",
      );
    }

    await Promise.all([ref.delete(), legacyRef.delete()]);

    return {
      success: true,
      uid,
      removed: true,
      hasPersonalCredentials: false,
      connectionStatus: "not_configured",
    };
  }

  const phoneNumber = normalizeWhatsAppAdminNumber(phoneInput);

  const [existingSnapshot, legacySnapshot] = await Promise.all([
    ref.get(),
    legacyRef.get(),
  ]);

  // If this teacher still has only the old admin-scoped record, preserve it.
  const current = existingSnapshot.exists
    ? existingSnapshot.data() ?? {}
    : legacySnapshot.data() ?? {};

  const hasCurrentCredentials = hasPostabiWebAppCredentials(current);
  let credentialPatch: Record<string, unknown> = {};

  if (appKey && authKey) {
    try {
      credentialPatch = encryptPostabiWebAppCredentials(appKey, authKey);
    } catch (error) {
      throw new WhatsAppAdminError(
        400,
        error instanceof Error
          ? error.message
          : "Teacher Postabi credentials could not be encrypted.",
      );
    }
  } else if (removeCredentials) {
    credentialPatch = {
      postabiAppKeyCiphertext: null,
      postabiAppKeyIv: null,
      postabiAppKeyTag: null,
      postabiAuthKeyCiphertext: null,
      postabiAuthKeyIv: null,
      postabiAuthKeyTag: null,
      postabiCredentialsEncryption: null,
    };
  }

  const willHaveCredentials = appKey && authKey
    ? true
    : removeCredentials
      ? false
      : hasCurrentCredentials;

  if (selectedForPersonalRouting && !willHaveCredentials) {
    throw new WhatsAppAdminError(
      400,
      "Save both personal Postabi credentials before selecting this teacher for personal routing.",
    );
  }

  const credentialsChanged = Boolean(appKey && authKey) || removeCredentials;
  const phoneChanged = phoneNumber !== clean(current.phoneNumber);
  const remainsVerified =
    current.connectionStatus === "verified" &&
    !credentialsChanged &&
    !phoneChanged;

  const connectionStatus = remainsVerified
    ? "verified"
    : willHaveCredentials
      ? "saved_not_verified"
      : "number_saved_not_connected";

  if (selectedForPersonalRouting && !remainsVerified) {
    throw new WhatsAppAdminError(
      409,
      "Confirm the teacher sender verification test before enabling personal routing.",
    );
  }

  const profile = eligible[0].data();

  await ref.set({
    ...current,
    uid,
    email,
    name: clean(profile.displayName) || clean(profile.name) ||
      clean(profile.fullName) || email,
    phoneNumber,
    selectedForPersonalRouting,
    ...credentialPatch,
    personalCredentialsConfigured: willHaveCredentials,
    provider: "postabi_web_app",
    connectionStatus,
    testStatus: credentialsChanged || phoneChanged
      ? null
      : current.testStatus ?? null,
    testRecipientLast4: credentialsChanged || phoneChanged
      ? null
      : current.testRecipientLast4 ?? null,
    verificationSenderMatched: credentialsChanged || phoneChanged
      ? false
      : current.verificationSenderMatched === true,
    verifiedAt: remainsVerified ? current.verifiedAt ?? null : null,
    sessionSupported: false,
    updatedByUid: ctx.uid,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // Delete the legacy copy only after the shared record has been saved.
  await legacyRef.delete();

  return {
    success: true,
    uid,
    phoneNumber,
    selectedForPersonalRouting,
    hasPersonalCredentials: willHaveCredentials,
    connectionStatus,
    sessionSupported: false,
  };
}


export async function sendTeacherWhatsAppVerificationTest(
  request: WhatsAppAdminRequest,
) {
  const ctx = await getAdminWhatsAppContext(request);

  if (!isRecord(request.body)) {
    throw new WhatsAppAdminError(400, "A valid JSON request body is required.");
  }

  if (process.env.WHATSAPP_TEST_SEND_ENABLED !== "true") {
    throw new WhatsAppAdminError(
      503,
      "Teacher WhatsApp test sending is disabled on this server.",
    );
  }

  const uid = clean(request.body.teacherUid);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new WhatsAppAdminError(400, "A valid teacher UID is required.");
  }

  if (request.body.confirmTestRecipient !== true) {
    throw new WhatsAppAdminError(
      400,
      "Confirm that the test recipient owns this number or has explicitly approved this test.",
    );
  }

  const testRecipient = normalizeWhatsAppAdminNumber(
    request.body.testRecipient,
  );

  const ref = ctx.teachers.doc(uid);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new WhatsAppAdminError(404, "Teacher WhatsApp settings were not found.");
  }

  const data = snapshot.data() ?? {};

  if (!hasPostabiWebAppCredentials(data)) {
    throw new WhatsAppAdminError(
      409,
      "Save the teacher's Postabi App Key and Auth Key first.",
    );
  }

  const expectedSender = normalizeWhatsAppAdminNumber(data.phoneNumber);

  if (testRecipient === expectedSender) {
    throw new WhatsAppAdminError(
      400,
      "Use a separate test recipient, not the teacher's sender number.",
    );
  }

  if (
    data.testStatus === "dispatching" ||
    data.testStatus === "awaiting_receipt"
  ) {
    throw new WhatsAppAdminError(
      409,
      "A teacher sender verification is already in progress or awaiting receipt confirmation.",
    );
  }

  if (data.testStatus === "unknown_outcome") {
    throw new WhatsAppAdminError(
      409,
      "The previous test outcome is unknown. Check the recipient and provider dashboard before another test.",
    );
  }

  const previousAttempt = clean(data.testStartedAt);
  if (previousAttempt) {
    const previousTime = Date.parse(previousAttempt);
    if (
      Number.isFinite(previousTime) &&
      Date.now() - previousTime < 60_000
    ) {
      throw new WhatsAppAdminError(
        429,
        "Wait at least one minute between teacher verification tests.",
      );
    }
  }

  let credentials;
  try {
    credentials = decryptPostabiWebAppCredentials(data);
  } catch {
    throw new WhatsAppAdminError(
      503,
      "Teacher Postabi credentials could not be decrypted.",
    );
  }

  const claimed = await ctx.db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(ref);
    if (!latestSnapshot.exists) return false;

    const latest = latestSnapshot.data() ?? {};

    if (
      latest.testStatus === "dispatching" ||
      latest.testStatus === "unknown_outcome" ||
      latest.phoneNumber !== data.phoneNumber ||
      !hasPostabiWebAppCredentials(latest) ||
      !hasSamePostabiCredentialEnvelope(latest, data)
    ) {
      return false;
    }

    transaction.update(ref, {
      testStatus: "dispatching",
      testStartedAt: new Date().toISOString(),
      testRecipientLast4: testRecipient.slice(-4),
      verificationSenderMatched: false,
      updatedAt: new Date().toISOString(),
    });

    return true;
  });

  if (!claimed) {
    throw new WhatsAppAdminError(
      409,
      "The teacher sender settings changed or another test is in progress. Refresh and review the connection.",
    );
  }

  let result;
  try {
    result = await sendPostabiWebAppMessage({
      credentials,
      to: testRecipient,
      type: "text",
      message:
        "EduTrack WhatsApp sender verification test. No student or guardian information is included.",
    });
  } catch (error) {
    // Never attach an old request's uncertain result to changed credentials.
    await ctx.db.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(ref);
      if (!latestSnapshot.exists) return;

      const latest = latestSnapshot.data() ?? {};
      if (
        latest.testStatus !== "dispatching" ||
        latest.phoneNumber !== data.phoneNumber ||
        !hasPostabiWebAppCredentials(latest) ||
        !hasSamePostabiCredentialEnvelope(latest, data)
      ) {
        return;
      }

      transaction.update(ref, {
        testStatus: "unknown_outcome",
        connectionStatus: "test_unknown_outcome",
        verificationSenderMatched: false,
        testError: "Provider request outcome is unknown. Do not resend automatically.",
        testCompletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    console.warn(
      "[whatsapp-admin-test] Provider outcome unknown.",
      error instanceof Error ? error.name : "UnknownError",
    );

    throw new WhatsAppAdminError(
      502,
      "The test request outcome is unknown. Check the recipient and Postabi dashboard before retrying.",
    );
  }

  let returnedSender = "";
  let senderMatches = false;

  if (result.from) {
    try {
      returnedSender = normalizeWhatsAppAdminNumber(result.from);
      senderMatches = returnedSender === expectedSender;
    } catch {
      senderMatches = false;
    }
  }

  const awaitingReceipt = result.accepted && senderMatches;
  const uncertain =
    (result.accepted && !senderMatches) ||
    result.httpStatus >= 500 ||
    result.httpStatus === 429;

  const testStatus = awaitingReceipt
    ? "awaiting_receipt"
    : uncertain
      ? "unknown_outcome"
      : "rejected";

  const connectionStatus = awaitingReceipt
    ? "test_pending_receipt"
    : uncertain
      ? "test_unknown_outcome"
      : "verification_failed";

  // Save the provider result only if the same phone, credential envelope,
  // and active verification attempt are still present.
  const resultSaved = await ctx.db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(ref);
    if (!latestSnapshot.exists) return false;

    const latest = latestSnapshot.data() ?? {};
    if (
      latest.testStatus !== "dispatching" ||
      latest.phoneNumber !== data.phoneNumber ||
      !hasPostabiWebAppCredentials(latest) ||
      !hasSamePostabiCredentialEnvelope(latest, data)
    ) {
      return false;
    }

    transaction.update(ref, {
      testStatus,
      connectionStatus,
      verificationSenderMatched: senderMatches,
      providerTestHttpStatus: result.httpStatus,
      providerTestStatus: result.providerStatus || null,
      providerTestStatusCode: result.providerStatusCode,
      providerFromLast4: returnedSender
        ? returnedSender.slice(-4)
        : null,
      testCompletedAt: new Date().toISOString(),
      ...(awaitingReceipt
        ? { testError: null }
        : {
            testError: uncertain
              ? "Provider result is uncertain or the returned sender did not match."
              : "Postabi rejected the verification test.",
          }),
      updatedAt: new Date().toISOString(),
    });

    return true;
  });

  if (!resultSaved) {
    throw new WhatsAppAdminError(
      409,
      "The teacher WhatsApp configuration changed while verification was in progress. The provider may have received the test. Review the recipient and provider dashboard; do not mark this sender verified or resend automatically.",
    );
  }

  return {
    success: awaitingReceipt,
    uid,
    testStatus,
    connectionStatus,
    providerHttpStatus: result.httpStatus,
    providerStatus: result.providerStatus,
    senderMatches,
    message: awaitingReceipt
      ? "Postabi accepted the test from the configured teacher sender. Confirm that the test recipient received it before marking the sender verified."
      : uncertain
        ? "The test outcome is uncertain. Do not send another test until it has been reviewed."
        : "Postabi did not accept the verification test. Review the credentials and provider response.",
  };
}

export async function confirmTeacherWhatsAppTestReceived(
  request: WhatsAppAdminRequest,
) {
  const ctx = await getAdminWhatsAppContext(request);

  if (!isRecord(request.body)) {
    throw new WhatsAppAdminError(400, "A valid JSON request body is required.");
  }

  const uid = clean(request.body.teacherUid);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new WhatsAppAdminError(400, "A valid teacher UID is required.");
  }

  if (request.body.confirmReceived !== true) {
    throw new WhatsAppAdminError(
      400,
      "Explicit confirmation that the test message was received is required.",
    );
  }

  const ref = ctx.teachers.doc(uid);
  const outcome = await ctx.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return "missing" as const;

    const data = snapshot.data() ?? {};

    if (
      data.testStatus !== "awaiting_receipt" ||
      data.verificationSenderMatched !== true ||
      !hasPostabiWebAppCredentials(data) ||
      !clean(data.phoneNumber)
    ) {
      return "not_ready" as const;
    }

    transaction.update(ref, {
      testStatus: "confirmed_received",
      connectionStatus: "verified",
      verifiedAt: new Date().toISOString(),
      verifiedByUid: ctx.uid,
      verifiedByEmail: ctx.email,
      testConfirmedAt: new Date().toISOString(),
      testError: null,
      updatedAt: new Date().toISOString(),
    });

    return "verified" as const;
  });

  if (outcome === "missing") {
    throw new WhatsAppAdminError(404, "Teacher WhatsApp settings were not found.");
  }

  if (outcome !== "verified") {
    throw new WhatsAppAdminError(
      409,
      "The test is not awaiting receipt confirmation. Verify the sender and received test first.",
    );
  }

  return {
    success: true,
    uid,
    connectionStatus: "verified",
    message: "Teacher sender verification is complete. Personal routing can now be enabled by the administrator.",
  };
}


export function sendWhatsAppAdminApiError(res: WhatsAppAdminResponse, error: unknown) {
  if (error instanceof WhatsAppAdminError || error instanceof AdminApiAuthError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  if (error instanceof FirebaseAdminConfigurationError) {
    return res.status(503).json({
      success: false,
      error: "WhatsApp management server configuration is unavailable. Check the Firebase Admin environment variables.",
    });
  }

  const requestId = randomUUID();
  const unknown = error as { code?: unknown; message?: unknown; stack?: unknown } | null;
  const code = typeof unknown?.code === "string" || typeof unknown?.code === "number"
    ? String(unknown.code).slice(0, 100)
    : "unknown";
  const rawMessage = typeof unknown?.message === "string" ? unknown.message : "Unknown server error";
  const safeMessage = rawMessage
    .replace(/(app[_ -]?key|auth[_ -]?key|authorization|bearer|private[_ -]?key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .slice(0, 500);

  console.error("[whatsapp-admin-api] Unhandled request failure.", {
    requestId,
    name: error instanceof Error ? error.name : "UnknownError",
    code,
    message: safeMessage,
    stack: error instanceof Error ? error.stack : undefined,
  });

  return res.status(500).json({
    success: false,
    requestId,
    error: `WhatsApp management request failed. Reference: ${requestId}. Check the server logs for this reference.`,
  });
}
