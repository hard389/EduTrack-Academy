import { FieldValue, Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { assertTeacherActorFeatureEntitlement } from "./subscriptionEntitlements.js";
import { assertAnnouncementQuotaReservationForActor, AnnouncementQuotaError } from "./announcementQuota.js";
import {
  resolveTeacherWhatsAppSender,
  TeacherWhatsAppSenderError,
} from "./teacherWhatsAppSender.js";
import { sendPostabiWebAppMessage } from "./postabiWebApp.js";
import { createWhatsAppNotificationImageLink } from "./whatsappNotificationImage.js";
import {
  calculateAnnouncementContentHash,
  createAnnouncementDispatchId,
  createAnnouncementPhoneHash,
  createAnnouncementRecipientKey,
  getAnnouncementConsentedPhone,
  normalizeAnnouncementWhatsAppPhone,
} from "./announcementsWhatsAppDomain.mjs";

type RecordLike = Record<string, unknown>;
type AnnouncementRequest = TeacherApiRequest & { body?: unknown };
type Actor = Awaited<ReturnType<typeof verifyTeacherRequest>>;
type SnapshotLike = { exists: boolean; data(): unknown };
type CurrentRecipient = {
  recipientKey: string;
  phoneHash: string;
  phone: string;
  classIds: string[];
  studentCount: number;
};

const MAX_CLASSES_PER_BROADCAST = 250;
const MAX_RECIPIENTS_PER_BROADCAST = 500;
const DISPATCH_BATCH_SIZE = 5;

export class AnnouncementWhatsAppError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AnnouncementWhatsAppError";
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getClassName(data: RecordLike, fallback: string): string {
  return clean(data.name) || clean(data.className) || clean(data.title) || fallback;
}

function readRoster(classData: RecordLike): Map<string, RecordLike> {
  const reserved = new Set([
    "id", "name", "code", "monthlyFee", "className", "title", "fee",
    "classFee", "createdAt", "createdDate", "date", "updatedAt", "students",
  ]);
  const raw = classData.students;
  let entries: Array<[string, unknown]> = [];
  const studentsAreArray = Array.isArray(raw);
  if (studentsAreArray) {
    entries = (raw as unknown[]).map((student, index) => [String(index), student]);
  } else if (isRecord(raw)) {
    entries = Object.entries(raw);
  } else if (raw === undefined || raw === null) {
    entries = Object.entries(classData).filter(([key, value]) =>
      !reserved.has(key) && isRecord(value) &&
      (typeof value.name === "string" || value.id !== undefined || value.studentId !== undefined),
    );
  }

  const roster = new Map<string, RecordLike>();
  for (const [key, value] of entries) {
    if (!isRecord(value)) continue;
    const isIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
    const stableKey = !studentsAreArray && !isIndex ? key : undefined;
    const rawId = value.id ?? value.studentId ?? stableKey;
    if (typeof rawId !== "string" && typeof rawId !== "number") continue;
    const id = String(rawId).trim();
    if (id && !id.includes("/") && !roster.has(id)) roster.set(id, value);
  }
  return roster;
}

function buildCurrentRecipients(
  classRows: Array<{ id: string; data: RecordLike }>,
): Map<string, CurrentRecipient> {
  const recipients = new Map<string, CurrentRecipient>();
  for (const classRow of classRows) {
    const roster = readRoster(classRow.data);
    for (const [studentId, student] of roster) {
      const phone = getAnnouncementConsentedPhone(student);
      if (!phone) continue;
      const phoneHash = createAnnouncementPhoneHash(phone);
      const recipientKey = createAnnouncementRecipientKey(phoneHash);
      const current = recipients.get(recipientKey);
      if (current) {
        if (!current.classIds.includes(classRow.id)) current.classIds.push(classRow.id);
        current.studentCount += 1;
      } else {
        recipients.set(recipientKey, {
          recipientKey,
          phoneHash,
          phone,
          classIds: [classRow.id],
          studentCount: 1,
        });
      }
      void studentId;
    }
  }
  return recipients;
}

async function loadClassRows(
  actor: Actor,
  targetClass: string,
): Promise<Array<{ id: string; data: RecordLike }>> {
  const snapshot = await actor.tenantRef.collection("classes").limit(MAX_CLASSES_PER_BROADCAST + 1).get();
  if (snapshot.size > MAX_CLASSES_PER_BROADCAST) {
    throw new AnnouncementWhatsAppError(413, `This workspace has more than ${MAX_CLASSES_PER_BROADCAST} classes. Divide the announcement into smaller class broadcasts.`);
  }
  const allRows = snapshot.docs.map((doc) => ({
    id: doc.id,
    data: (doc.data() ?? {}) as RecordLike,
  }));
  if (targetClass === "All Classes") return allRows;
  const matches = allRows.filter((row) => getClassName(row.data, row.id) === targetClass);
  if (matches.length !== 1) {
    throw new AnnouncementWhatsAppError(409, matches.length === 0
      ? "The announcement target class no longer exists in this workspace."
      : "More than one class has this name. Rename duplicate classes before broadcasting to avoid sending to the wrong class.");
  }
  return matches;
}

async function loadClassRowsByIds(
  actor: Actor,
  classIds: string[],
  targetClass: string,
): Promise<Array<{ id: string; data: RecordLike }>> {
  if (!Array.isArray(classIds) || classIds.length === 0 || classIds.length > MAX_CLASSES_PER_BROADCAST) {
    throw new AnnouncementWhatsAppError(409, "The saved announcement has an invalid frozen class audience.");
  }
  const uniqueIds = [...new Set(classIds)];
  if (uniqueIds.length !== classIds.length || uniqueIds.some((id) => !id || id.includes("/") || id.includes("\\"))) {
    throw new AnnouncementWhatsAppError(409, "The saved announcement has an invalid frozen class audience.");
  }
  const snapshots = await Promise.all(uniqueIds.map((id) => actor.tenantRef.collection("classes").doc(id).get()));
  const rows = snapshots.flatMap((snapshot, index) => snapshot.exists
    ? [{ id: uniqueIds[index], data: (snapshot.data() ?? {}) as RecordLike }]
    : []);
  if (targetClass !== "All Classes") {
    if (rows.length !== 1 || getClassName(rows[0].data, rows[0].id) !== targetClass) {
      throw new AnnouncementWhatsAppError(409, "The saved target class was removed or renamed after the announcement was prepared.");
    }
  }
  // For All Classes, deleted classes remain part of the frozen audience but no longer
  // contribute students. Newly created classes are deliberately not added on a retry.
  return rows;
}

function validateRequestBody(body: unknown): RecordLike {
  if (!isRecord(body)) throw new AnnouncementWhatsAppError(400, "A valid JSON request body is required.");
  const action = clean(body.action);
  if (action !== "prepare" && action !== "dispatch" && action !== "retry") {
    throw new AnnouncementWhatsAppError(400, "Unsupported announcement WhatsApp action.");
  }
  const alertId = clean(body.alertId);
  if (!alertId || alertId.length > 150 || alertId.includes("/") || alertId.includes("\\")) {
    throw new AnnouncementWhatsAppError(400, "A valid alert ID is required.");
  }
  if ((action === "dispatch" || action === "retry") && !/^[a-f0-9]{64}$/i.test(clean(body.dispatchId))) {
    throw new AnnouncementWhatsAppError(400, "A valid announcement dispatch ID is required.");
  }
  if (action === "retry") {
    const recipientId = clean(body.recipientId);
    if (!recipientId || recipientId.length > 150 || recipientId.includes("/") || recipientId.includes("\\")) {
      throw new AnnouncementWhatsAppError(400, "A valid announcement recipient ID is required.");
    }
  }
  return body;
}

async function loadAuthorizedSender(actor: Actor) {
  if (process.env.WHATSAPP_DISPATCH_ENABLED !== "true" || process.env.WHATSAPP_ANNOUNCEMENTS_ENABLED !== "true") {
    throw new AnnouncementWhatsAppError(503, "Announcement WhatsApp dispatch is disabled on the server. The in-app alert remains saved; no WhatsApp message was sent.");
  }
  const settingsSnapshot = await actor.db.collection("platformSettings").doc("whatsapp").get();
  const settings = settingsSnapshot.data() ?? {};
  if (
    settings.enabled !== true ||
    settings.announcementDispatchEnabled !== true ||
    settings.announcementDispatchAuthorizationVersion !== 1 ||
    settings.announcementDispatchAuthorizationScope !== "announcements_to_opted_in_guardians_only" ||
    !clean(settings.announcementDispatchAuthorizedAt) ||
    !clean(settings.announcementDispatchAuthorizedByUid)
  ) {
    throw new AnnouncementWhatsAppError(409, "Announcement WhatsApp requires separate Admin authorization and current parent consent. The in-app alert remains saved; no WhatsApp message was sent.");
  }
  try {
    const sender = await resolveTeacherWhatsAppSender(actor.db, actor.uid, settings);
    return { settings, sender };
  } catch (error) {
    if (error instanceof TeacherWhatsAppSenderError) {
      throw new AnnouncementWhatsAppError(error.status, error.message);
    }
    console.error("[AnnouncementWhatsApp] Sender configuration resolution failed.", error instanceof Error ? error.name : "UnknownError");
    throw new AnnouncementWhatsAppError(503, "The configured WhatsApp sender could not be resolved. No WhatsApp message was sent.");
  }
}

function readAlertSnapshot(snapshot: SnapshotLike): RecordLike {
  if (!snapshot.exists) throw new AnnouncementWhatsAppError(404, "The saved announcement was not found in this workspace.");
  const data = snapshot.data() ?? {};
  if (!isRecord(data) || data.category !== "Announcements" || data.sender !== "Tigerr_Alert System") {
    throw new AnnouncementWhatsAppError(409, "Only an announcement created through Broadcast New Alert can be sent to guardians.");
  }
  const title = clean(data.title);
  const message = clean(data.message);
  const targetClass = clean(data.targetClass) || "All Classes";
  if (!title || title.length > 140 || !message || message.length > 3000) {
    throw new AnnouncementWhatsAppError(409, "The saved announcement title or message is invalid or too long.");
  }
  return { ...data, title, message, targetClass };
}

async function prepareAnnouncement(actor: Actor, alertId: string, senderType: string) {
  const alertRef = actor.tenantRef.collection("notifications").doc(alertId);
  const alertSnapshot = await alertRef.get();
  const alert = readAlertSnapshot(alertSnapshot);
  if (clean(alert.announcementQuotaReservationId) === alertId) {
    try { await assertAnnouncementQuotaReservationForActor(actor, alertId, String(alert.targetClass)); }
    catch (error) {
      if (error instanceof AnnouncementQuotaError) throw new AnnouncementWhatsAppError(error.status, error.message);
      throw error;
    }
  }
  const dispatchId = createAnnouncementDispatchId({ tenantId: actor.email, alertId });
  const dispatchRef = actor.tenantRef.collection("whatsappAnnouncementDispatches").doc(dispatchId);
  let dispatchSnapshot = await dispatchRef.get();

  if (!dispatchSnapshot.exists) {
    const initialClassRows = await loadClassRows(actor, String(alert.targetClass));
    if (initialClassRows.length === 0) {
      throw new AnnouncementWhatsAppError(409, "No classes are available in this workspace for the announcement audience.");
    }
    const initialClassIds = initialClassRows.map((row) => row.id).sort();
    const initialRecipients = buildCurrentRecipients(initialClassRows);
    if (initialRecipients.size > MAX_RECIPIENTS_PER_BROADCAST) {
      throw new AnnouncementWhatsAppError(413, `This announcement has more than ${MAX_RECIPIENTS_PER_BROADCAST} opted-in guardian numbers. Split it into smaller class broadcasts.`);
    }
    const initialContentHash = calculateAnnouncementContentHash({
      tenantId: actor.email,
      alertId,
      title: alert.title,
      message: alert.message,
      category: alert.category,
      targetClass: alert.targetClass,
      classIds: initialClassIds,
    });
    try {
      await dispatchRef.create({
        kind: "announcement_whatsapp",
        tenantId: actor.email,
        teacherUid: actor.uid,
        alertId,
        targetClass: alert.targetClass,
        classIds: initialClassIds,
        contentHash: initialContentHash,
        eligibleCount: initialRecipients.size,
        skippedNoConsent: 0,
        senderType,
        status: initialRecipients.size > 0 ? "pending" : "no_eligible_recipients",
        acceptedCount: 0,
        rejectedCount: 0,
        unknownOutcomeCount: 0,
        skippedConsentChangedCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      // A concurrent prepare may have created this stable tenant+alert dispatch first.
      const raced = await dispatchRef.get();
      if (!raced.exists) throw error;
    }
    dispatchSnapshot = await dispatchRef.get();
  }

  if (!dispatchSnapshot.exists) {
    throw new AnnouncementWhatsAppError(500, "The announcement dispatch could not be initialized.");
  }
  const existing = dispatchSnapshot.data() ?? {};
  if (
    existing.kind !== "announcement_whatsapp" ||
    existing.tenantId !== actor.email ||
    existing.teacherUid !== actor.uid ||
    existing.alertId !== alertId
  ) {
    throw new AnnouncementWhatsAppError(409, "A conflicting announcement dispatch record exists. Do not create another broadcast.");
  }
  const rawClassIds = existing.classIds;
  const classIds = Array.isArray(rawClassIds) && rawClassIds.every((value): value is string => typeof value === "string")
    ? rawClassIds
    : [];
  if (
    !classIds.length ||
    classIds.length > MAX_CLASSES_PER_BROADCAST ||
    new Set(classIds).size !== classIds.length ||
    classIds.some((id) => !id || id.includes("/") || id.includes("\\"))
  ) {
    throw new AnnouncementWhatsAppError(409, "The saved announcement has an invalid frozen class audience.");
  }
  if (clean(alert.whatsappDispatchId) && clean(alert.whatsappDispatchId) !== dispatchId) {
    throw new AnnouncementWhatsAppError(409, "This announcement is already linked to a different WhatsApp dispatch. No second broadcast will be created.");
  }
  const contentHash = calculateAnnouncementContentHash({
    tenantId: actor.email,
    alertId,
    title: alert.title,
    message: alert.message,
    category: alert.category,
    targetClass: alert.targetClass,
    classIds,
  });
  if (existing.contentHash !== contentHash || existing.targetClass !== alert.targetClass) {
    throw new AnnouncementWhatsAppError(409, "The saved announcement changed after its audience was frozen. Create a new announcement instead of reusing this dispatch.");
  }

  const recipientsCollection = dispatchRef.collection("recipients");
  const recipientsAlreadyPrepared = Boolean(existing.recipientsPreparedAt);
  if (!recipientsAlreadyPrepared) {
    const classRows = await loadClassRowsByIds(actor, classIds, String(alert.targetClass));
    const currentRecipients = buildCurrentRecipients(classRows);
    if (currentRecipients.size > MAX_RECIPIENTS_PER_BROADCAST) {
      throw new AnnouncementWhatsAppError(413, `This announcement has more than ${MAX_RECIPIENTS_PER_BROADCAST} opted-in guardian numbers. Split it into smaller class broadcasts.`);
    }
    const existingRecipientsSnapshot = await recipientsCollection.get();
    const existingKeys = new Set(existingRecipientsSnapshot.docs.map((doc) => doc.id));
    const newRecipients = [...currentRecipients.values()].filter((item) => !existingKeys.has(item.recipientKey));
    for (let offset = 0; offset < newRecipients.length; offset += 450) {
      const batch = actor.db.batch();
      for (const recipient of newRecipients.slice(offset, offset + 450)) {
        batch.create(recipientsCollection.doc(recipient.recipientKey), {
          status: "pending",
          recipientPhoneHash: recipient.phoneHash,
          recipientLast4: recipient.phone.slice(-4),
          classIds: recipient.classIds,
          studentCount: recipient.studentCount,
          retrySafe: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      try {
        await batch.commit();
      } catch (error) {
        // A simultaneous prepare may have created the same deterministic jobs. Never overwrite status.
        const fresh = await recipientsCollection.get();
        const freshKeys = new Set(fresh.docs.map((doc) => doc.id));
        if (newRecipients.slice(offset, offset + 450).some((item) => !freshKeys.has(item.recipientKey))) throw error;
      }
    }
    // Freeze the eligible guardian set after the first complete prepare. Re-prepares cannot
    // append new class members or newly consented guardians to an existing dispatch.
    await dispatchRef.set({ recipientsPreparedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  const recipientSnapshot = await recipientsCollection.get();
  const counts = countStatuses(recipientSnapshot.docs.map((doc) => doc.data() ?? {}));
  const status = counts.pending > 0
    ? "pending"
    : counts.dispatching > 0 || counts.unknown_outcome > 0 || counts.provider_rejected > 0
      ? "needs_review"
      : recipientSnapshot.size > 0 ? "completed" : "no_eligible_recipients";
  await dispatchRef.set({
    eligibleCount: recipientSnapshot.size,
    status,
    ...statusPatch(counts),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await alertRef.set({
    whatsappDispatchId: dispatchId,
    whatsappDispatchStatus: status,
    whatsappEligibleCount: recipientSnapshot.size,
    whatsappPendingCount: counts.pending,
    whatsappAcceptedCount: counts.provider_accepted,
    whatsappRejectedCount: counts.provider_rejected,
    whatsappUnknownOutcomeCount: counts.unknown_outcome,
    whatsappSkippedConsentChangedCount: counts.skipped_consent_changed,
  }, { merge: true });

  return {
    action: "prepared",
    dispatchId,
    eligibleCount: recipientSnapshot.size,
    pendingCount: counts.pending,
    acceptedCount: counts.provider_accepted,
    rejectedCount: counts.provider_rejected,
    unknownOutcomeCount: counts.unknown_outcome,
    skippedConsentChangedCount: counts.skipped_consent_changed,
    status,
    deliveryConfirmed: false,
  };
}

function countStatuses(rows: RecordLike[]) {
  const counts = {
    pending: 0,
    dispatching: 0,
    provider_accepted: 0,
    provider_rejected: 0,
    unknown_outcome: 0,
    skipped_consent_changed: 0,
  };
  for (const row of rows) {
    const status = clean(row.status) as keyof typeof counts;
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

function statusPatch(counts: ReturnType<typeof countStatuses>) {
  return {
    acceptedCount: counts.provider_accepted,
    rejectedCount: counts.provider_rejected,
    unknownOutcomeCount: counts.unknown_outcome,
    skippedConsentChangedCount: counts.skipped_consent_changed,
    pendingCount: counts.pending,
    dispatchingCount: counts.dispatching,
  };
}

async function claimRecipient(
  actor: Actor,
  alertRef: DocumentReference,
  dispatchRef: DocumentReference,
  recipientRef: DocumentReference,
  classIds: string[],
  expectedContentHash: string,
  recipientPhoneHash: string,
): Promise<{ claimed: boolean; phone?: string; alert?: RecordLike; reason?: string }> {
  return actor.db.runTransaction(async (transaction: Transaction) => {
    const classRefs = classIds.map((classId) => actor.tenantRef.collection("classes").doc(classId));
    const whatsappSettingsRef = actor.db.collection("platformSettings").doc("whatsapp");
    const reads = await Promise.all([
      transaction.get(alertRef),
      transaction.get(dispatchRef),
      transaction.get(recipientRef),
      transaction.get(whatsappSettingsRef),
      ...classRefs.map((ref) => transaction.get(ref)),
    ]);
    const alertSnap = reads[0];
    const dispatchSnap = reads[1];
    const recipientSnap = reads[2];
    const whatsappSettings = reads[3]?.data() ?? {};
    if (
      process.env.WHATSAPP_DISPATCH_ENABLED !== "true" ||
      process.env.WHATSAPP_ANNOUNCEMENTS_ENABLED !== "true" ||
      whatsappSettings.enabled !== true ||
      whatsappSettings.announcementDispatchEnabled !== true ||
      whatsappSettings.announcementDispatchAuthorizationVersion !== 1 ||
      whatsappSettings.announcementDispatchAuthorizationScope !== "announcements_to_opted_in_guardians_only" ||
      !clean(whatsappSettings.announcementDispatchAuthorizedAt) ||
      !clean(whatsappSettings.announcementDispatchAuthorizedByUid)
    ) {
      throw new AnnouncementWhatsAppError(409, "Announcement WhatsApp authorization was disabled before this batch could send. Pending recipients were not sent.");
    }
    if (!alertSnap.exists || !dispatchSnap.exists || !recipientSnap.exists) {
      return { claimed: false, reason: "missing_dispatch_or_alert" };
    }
    const alert = readAlertSnapshot(alertSnap);
    const dispatch = dispatchSnap.data() ?? {};
    const recipient = recipientSnap.data() ?? {};
    if (dispatch.kind !== "announcement_whatsapp" || dispatch.tenantId !== actor.email || dispatch.contentHash !== expectedContentHash) {
      return { claimed: false, reason: "dispatch_changed" };
    }
    if (recipient.status !== "pending") return { claimed: false, reason: clean(recipient.status) || "already_processed" };

    const latestClassRows = classRefs.map((ref, index) => ({
      id: ref.id,
      data: (reads[index + 4]?.data() ?? {}) as RecordLike,
    })).filter((_row, index) => reads[index + 4]?.exists);
    const currentRecipients = buildCurrentRecipients(latestClassRows);
    const current = [...currentRecipients.values()].find((item) => item.phoneHash === recipientPhoneHash);
    if (!current) {
      transaction.update(recipientRef, {
        status: "skipped_consent_changed",
        retrySafe: false,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(dispatchRef, {
        skippedConsentChangedCount: FieldValue.increment(1),
        pendingCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { claimed: false, reason: "consent_or_phone_changed" };
    }

    const classIdsInJob = Array.isArray(recipient.classIds) ? recipient.classIds.filter((value) => typeof value === "string") : [];
    if (!current.classIds.some((id) => classIdsInJob.includes(id))) {
      transaction.update(recipientRef, {
        status: "skipped_consent_changed",
        retrySafe: false,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(dispatchRef, {
        skippedConsentChangedCount: FieldValue.increment(1),
        pendingCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { claimed: false, reason: "class_roster_changed" };
    }

    const latestContentHash = calculateAnnouncementContentHash({
      tenantId: actor.email,
      alertId: alertRef.id,
      title: alert.title,
      message: alert.message,
      category: alert.category,
      targetClass: alert.targetClass,
      classIds: Array.isArray(dispatch.classIds) ? dispatch.classIds : [],
    });
    if (latestContentHash !== expectedContentHash) {
      transaction.update(recipientRef, {
        status: "skipped_consent_changed",
        outcomeReason: "The saved announcement changed after preparation.",
        retrySafe: false,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(dispatchRef, {
        skippedConsentChangedCount: FieldValue.increment(1),
        pendingCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { claimed: false, reason: "announcement_changed" };
    }

    transaction.update(recipientRef, {
      status: "dispatching",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(dispatchRef, {
      status: "dispatching",
      pendingCount: FieldValue.increment(-1),
      dispatchingCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { claimed: true, phone: current.phone, alert };
  });
}

async function processRecipient(
  actor: Actor,
  sender: Awaited<ReturnType<typeof resolveTeacherWhatsAppSender>>,
  alertRef: DocumentReference,
  dispatchRef: DocumentReference,
  recipientRef: DocumentReference,
  classIds: string[],
  contentHash: string,
): Promise<string> {
  const recipientSnapshot = await recipientRef.get();
  const phoneHash = clean(recipientSnapshot.data()?.recipientPhoneHash);
  if (!phoneHash) return "skipped";
  const claim = await claimRecipient(actor, alertRef, dispatchRef, recipientRef, classIds, contentHash, phoneHash);
  if (!claim.claimed || !claim.phone || !claim.alert) return "skipped";

  let notificationImageUrl = "";
  try {
    const targetClass = clean(claim.alert.targetClass) || "All Classes";
    const firstClassSnapshot = classIds.length
      ? await actor.tenantRef.collection("classes").doc(classIds[0]).get()
      : null;
    const firstClass = firstClassSnapshot?.data() ?? {};
    const className = targetClass === "All Classes"
      ? "All Classes"
      : getClassName(firstClass as RecordLike, targetClass);
    const classCode = clean(firstClass.code) || clean(firstClass.classCode) || (targetClass === "All Classes" ? "ALL" : targetClass);
    const imageLink = await createWhatsAppNotificationImageLink({
      db: actor.db,
      tenantId: actor.email,
      payload: {
        kind: "announcement",
        academyName: clean((actor.tenantData as RecordLike).schoolName)
          || clean((actor.tenantData as RecordLike).name)
          || clean((actor.tenantData as RecordLike).teacherName)
          || "EduTrack School",
        className,
        classCode,
        announcementTitle: clean(claim.alert.title),
        announcementMessage: clean(claim.alert.message),
      },
    });
    notificationImageUrl = imageLink.url;
  } catch (error) {
    // Image rendering failed before any provider invocation. Release the claim to pending;
    // this is a safe pre-provider failure and can be resumed through the existing dispatch API.
    await actor.db.runTransaction(async (transaction) => {
      const [recipientSnapshot, dispatchSnapshot] = await Promise.all([
        transaction.get(recipientRef), transaction.get(dispatchRef),
      ]);
      if (!recipientSnapshot.exists || !dispatchSnapshot.exists || recipientSnapshot.data()?.status !== "dispatching") return;
      transaction.update(recipientRef, {
        status: "pending",
        preProviderError: "announcement_image_generation_failed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(dispatchRef, {
        status: "pending",
        pendingCount: FieldValue.increment(1),
        dispatchingCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    console.error("[AnnouncementWhatsApp] Shared branded image could not be prepared before provider dispatch.", error instanceof Error ? error.name : "UnknownError");
    throw new AnnouncementWhatsAppError(503, "The branded announcement image could not be prepared. No WhatsApp message was sent.");
  }

  await recipientRef.update({
    attemptCount: FieldValue.increment(1),
    providerAttemptStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  let providerResult: Awaited<ReturnType<typeof sendPostabiWebAppMessage>> | null = null;
  let finalStatus: "provider_accepted" | "provider_rejected" | "unknown_outcome" = "unknown_outcome";
  let safeFailure = "";
  try {
    providerResult = await sendPostabiWebAppMessage({
      credentials: sender.credentials,
      to: claim.phone,
      type: "image",
      url: notificationImageUrl,
    });
    const providerFrom = normalizeAnnouncementWhatsAppPhone(providerResult.from);
    const expectedFrom = normalizeAnnouncementWhatsAppPhone(sender.senderNumber);
    const senderIdentityMatched = providerFrom
      ? providerFrom === expectedFrom
      : sender.senderType === "central";
    const accepted = providerResult.accepted && senderIdentityMatched;
    if (accepted) finalStatus = "provider_accepted";
    else if (providerResult.httpStatus >= 400 && providerResult.httpStatus < 500 && providerResult.httpStatus !== 429) finalStatus = "provider_rejected";
    else finalStatus = "unknown_outcome";
    const failedAt = finalStatus === "provider_rejected" ? Timestamp.now() : null;
    await recipientRef.update({
      status: finalStatus,
      providerHttpStatus: providerResult.httpStatus,
      providerStatus: providerResult.providerStatus || null,
      providerStatusCode: providerResult.providerStatusCode,
      providerMessageId: providerResult.messageId,
      providerAccepted: accepted,
      senderIdentityMatched,
      senderType: sender.senderType,
      providerSenderLast4: sender.senderNumber.slice(-4),
      providerFromLast4: providerFrom ? providerFrom.slice(-4) : null,
      retrySafe: false,
      ...(failedAt ? {
        failedAt,
        expiresAt: Timestamp.fromMillis(failedAt.toMillis() + 24 * 60 * 60 * 1000),
      } : {}),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    safeFailure = error instanceof Error ? error.name.slice(0, 80) : "UnknownProviderError";
    finalStatus = "unknown_outcome";
    await recipientRef.update({
      status: finalStatus,
      providerErrorName: safeFailure,
      retrySafe: false,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch((updateError) => {
      console.error("[AnnouncementWhatsApp] Could not persist uncertain provider outcome.", updateError instanceof Error ? updateError.name : "UnknownError");
    });
  }

  await actor.db.runTransaction(async (transaction) => {
    const dispatchSnapshot = await transaction.get(dispatchRef);
    if (!dispatchSnapshot.exists) throw new Error("Announcement dispatch record disappeared after provider invocation.");
    const dispatch = dispatchSnapshot.data() ?? {};
    const counterField = finalStatus === "provider_accepted"
      ? "acceptedCount"
      : finalStatus === "provider_rejected"
        ? "rejectedCount"
        : "unknownOutcomeCount";
    transaction.update(dispatchRef, {
      [counterField]: FieldValue.increment(1),
      dispatchingCount: FieldValue.increment(-1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    void dispatch;
  });
  return finalStatus;
}

async function updateDispatchSummary(actor: Actor, dispatchRef: DocumentReference, alertRef: DocumentReference) {
  const [recipientSnapshot, dispatchSnapshot] = await Promise.all([dispatchRef.collection("recipients").get(), dispatchRef.get()]);
  const counts = countStatuses(recipientSnapshot.docs.map((doc) => doc.data() ?? {}));
  const status = counts.pending > 0
    ? "pending"
    : counts.dispatching > 0 || counts.unknown_outcome > 0 || counts.provider_rejected > 0
      ? "needs_review"
      : recipientSnapshot.size > 0 ? "completed" : "no_eligible_recipients";
  await dispatchRef.set({ status, ...statusPatch(counts), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await alertRef.set({
    whatsappDispatchStatus: status,
    whatsappEligibleCount: recipientSnapshot.size,
    whatsappPendingCount: counts.pending,
    whatsappAcceptedCount: counts.provider_accepted,
    whatsappRejectedCount: counts.provider_rejected,
    whatsappUnknownOutcomeCount: counts.unknown_outcome,
    whatsappSkippedConsentChangedCount: counts.skipped_consent_changed,
  }, { merge: true });
  return {
    status,
    eligibleCount: recipientSnapshot.size,
    pendingCount: counts.pending,
    dispatchingCount: counts.dispatching,
    acceptedCount: counts.provider_accepted,
    rejectedCount: counts.provider_rejected,
    unknownOutcomeCount: counts.unknown_outcome,
    skippedConsentChangedCount: counts.skipped_consent_changed,
    deliveryConfirmed: false,
    alertExists: dispatchSnapshot.exists,
  };
}

async function retryFailedAnnouncementRecipient(
  actor: Actor,
  alertId: string,
  dispatchId: string,
  recipientId: string,
  sender: Awaited<ReturnType<typeof resolveTeacherWhatsAppSender>>,
) {
  const alertRef = actor.tenantRef.collection("notifications").doc(alertId);
  const dispatchRef = actor.tenantRef.collection("whatsappAnnouncementDispatches").doc(dispatchId);
  const recipientRef = dispatchRef.collection("recipients").doc(recipientId);
  const [alertSnapshot, dispatchSnapshot, recipientSnapshot] = await Promise.all([
    alertRef.get(), dispatchRef.get(), recipientRef.get(),
  ]);
  const alert = readAlertSnapshot(alertSnapshot);
  if (!dispatchSnapshot.exists || !recipientSnapshot.exists) {
    throw new AnnouncementWhatsAppError(404, "The failed announcement recipient was not found in this workspace.");
  }
  await assertAnnouncementQuotaReservationForActor(actor, alertId, clean(alert.targetClass));

  const queued = await actor.db.runTransaction(async (transaction) => {
    const [latestAlert, latestDispatch, latestRecipient] = await Promise.all([
      transaction.get(alertRef), transaction.get(dispatchRef), transaction.get(recipientRef),
    ]);
    if (!latestAlert.exists || !latestDispatch.exists || !latestRecipient.exists) return false;
    const currentAlert = readAlertSnapshot(latestAlert);
    const dispatch = latestDispatch.data() ?? {};
    const recipient = latestRecipient.data() ?? {};
    if (
      currentAlert.sourceType !== "teacher_created" ||
      currentAlert.createdByUid !== actor.uid ||
      currentAlert.createdByRole !== "teacher"
    ) throw new AnnouncementWhatsAppError(403, "Only the teacher who created this announcement can retry its rejected recipient.");
    if (
      dispatch.kind !== "announcement_whatsapp" ||
      dispatch.tenantId !== actor.email ||
      dispatch.teacherUid !== actor.uid ||
      dispatch.alertId !== alertId
    ) throw new AnnouncementWhatsAppError(403, "This announcement dispatch does not belong to the active teacher workspace.");

    const rawClassIds = dispatch.classIds;
    const classIds = Array.isArray(rawClassIds) && rawClassIds.every((value): value is string => typeof value === "string")
      ? rawClassIds : [];
    if (!classIds.length || classIds.some((id) => !id || id.includes("/") || id.includes("\\"))) {
      throw new AnnouncementWhatsAppError(409, "The saved announcement audience is invalid. No retry was queued.");
    }
    const currentHash = calculateAnnouncementContentHash({
      tenantId: actor.email, alertId, title: currentAlert.title, message: currentAlert.message,
      category: currentAlert.category, targetClass: currentAlert.targetClass, classIds,
    });
    if (currentHash !== clean(dispatch.contentHash)) {
      throw new AnnouncementWhatsAppError(409, "The saved announcement changed after the original send. Create a new alert instead of retrying it.");
    }

    const status = clean(recipient.status);
    if (status === "pending" && recipient.manualRetryQueuedAt && recipient.manualRetryQueuedBy === actor.uid) {
      return true;
    }
    if (status !== "provider_rejected") {
      throw new AnnouncementWhatsAppError(409, "Only a definitive provider-rejected announcement can be retried. Accepted or uncertain outcomes are never retried.");
    }
    const providerHttpStatus = Number(recipient.providerHttpStatus);
    if (!Number.isInteger(providerHttpStatus) || providerHttpStatus < 400 || providerHttpStatus >= 500 || [408, 409, 425, 429].includes(providerHttpStatus)) {
      throw new AnnouncementWhatsAppError(409, "The provider response is not a confirmed safe rejection. This message cannot be retried.");
    }
    const expiresAt = recipient.expiresAt && typeof recipient.expiresAt.toMillis === "function"
      ? Number(recipient.expiresAt.toMillis()) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new AnnouncementWhatsAppError(410, "The 24-hour retry window has expired.");
    }
    const attempts = Number(recipient.attemptCount) || 0;
    if (attempts >= 3) throw new AnnouncementWhatsAppError(429, "This announcement recipient has reached the three-attempt limit.");
    if ((Number(dispatch.dispatchingCount) || 0) > 0) {
      throw new AnnouncementWhatsAppError(409, "Another announcement batch is still processing. Refresh before retrying.");
    }

    transaction.update(recipientRef, {
      status: "pending",
      retrySafe: false,
      manualRetryQueuedAt: FieldValue.serverTimestamp(),
      manualRetryQueuedBy: actor.uid,
      manualRetryCount: FieldValue.increment(1),
      failedAt: FieldValue.delete(),
      expiresAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(dispatchRef, {
      status: "pending",
      rejectedCount: Math.max(0, (Number(dispatch.rejectedCount) || 0) - 1),
      pendingCount: Math.max(0, Number(dispatch.pendingCount) || 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (!queued) throw new AnnouncementWhatsAppError(404, "The announcement recipient no longer exists.");
  return dispatchPendingAnnouncement(actor, alertId, dispatchId, sender);
}

async function dispatchPendingAnnouncement(actor: Actor, alertId: string, dispatchId: string, sender: Awaited<ReturnType<typeof resolveTeacherWhatsAppSender>>) {
  const alertRef = actor.tenantRef.collection("notifications").doc(alertId);
  const dispatchRef = actor.tenantRef.collection("whatsappAnnouncementDispatches").doc(dispatchId);
  const [dispatchSnapshot, alertSnapshot] = await Promise.all([dispatchRef.get(), alertRef.get()]);
  if (!dispatchSnapshot.exists) throw new AnnouncementWhatsAppError(404, "The announcement dispatch was not found.");
  const dispatch = dispatchSnapshot.data() ?? {};
  const alert = readAlertSnapshot(alertSnapshot);
  if (dispatch.kind !== "announcement_whatsapp" || dispatch.tenantId !== actor.email || dispatch.teacherUid !== actor.uid || dispatch.alertId !== alertId) {
    throw new AnnouncementWhatsAppError(403, "This announcement dispatch does not belong to the active teacher workspace.");
  }
  const canonicalDispatchId = createAnnouncementDispatchId({
    tenantId: actor.email,
    alertId,
    contentHash: clean(dispatch.contentHash),
  });
  if (canonicalDispatchId !== dispatchId) {
    throw new AnnouncementWhatsAppError(409, "The announcement dispatch ID does not match its saved content.");
  }
  const rawClassIds = dispatch.classIds;
  const classIds = Array.isArray(rawClassIds) && rawClassIds.every((value): value is string => typeof value === "string")
    ? rawClassIds
    : [];
  if (
    !classIds.length ||
    classIds.length > MAX_CLASSES_PER_BROADCAST ||
    new Set(classIds).size !== classIds.length ||
    classIds.some((id) => !id || id.includes("/") || id.includes("\\"))
  ) {
    throw new AnnouncementWhatsAppError(409, "The prepared announcement has an invalid frozen class audience.");
  }
  const expectedContentHash = clean(dispatch.contentHash);
  const currentHash = calculateAnnouncementContentHash({
    tenantId: actor.email,
    alertId,
    title: alert.title,
    message: alert.message,
    category: alert.category,
    targetClass: alert.targetClass,
    classIds,
  });
  if (currentHash !== expectedContentHash) {
    throw new AnnouncementWhatsAppError(409, "The saved announcement changed after it was prepared. Create a new announcement before sending again.");
  }
  const pendingSnapshot = await dispatchRef.collection("recipients").where("status", "==", "pending").limit(DISPATCH_BATCH_SIZE).get();
  await Promise.all(pendingSnapshot.docs.map((recipientDoc) =>
    processRecipient(actor, sender, alertRef, dispatchRef, recipientDoc.ref, classIds, expectedContentHash),
  ));
  return updateDispatchSummary(actor, dispatchRef, alertRef);
}

export async function dispatchAnnouncementWhatsApp(request: AnnouncementRequest) {
  let actor: Actor;
  try {
    actor = await verifyTeacherRequest(request);
  } catch (error) {
    if (error instanceof TeacherApiAuthError) throw error;
    throw new AnnouncementWhatsAppError(401, "Teacher authentication could not be verified.");
  }

  try {
    await assertTeacherActorFeatureEntitlement(actor, 'announcements');
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    throw new AnnouncementWhatsAppError(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403,
      error instanceof Error ? error.message : 'Your Academy Admin has not granted permission to send announcements.');
  }

  const body = validateRequestBody(request.body);
  const { sender } = await loadAuthorizedSender(actor);
  const alertId = clean(body.alertId);
  if (body.action === "prepare") {
    return prepareAnnouncement(actor, alertId, sender.senderType);
  }

  const dispatchId = clean(body.dispatchId);
  const dispatchRef = actor.tenantRef.collection("whatsappAnnouncementDispatches").doc(dispatchId);
  const snapshot = await dispatchRef.get();
  if (!snapshot.exists || snapshot.data()?.alertId !== alertId) {
    throw new AnnouncementWhatsAppError(404, "The prepared announcement dispatch could not be found.");
  }
  if (body.action === "retry") {
    return retryFailedAnnouncementRecipient(actor, alertId, dispatchId, clean(body.recipientId), sender);
  }
  return dispatchPendingAnnouncement(actor, alertId, dispatchId, sender);
}

export function sendAnnouncementWhatsAppApiError(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown,
): unknown {
  const status = error instanceof TeacherApiAuthError || error instanceof AnnouncementWhatsAppError
    ? error.status
    : error instanceof TeacherWhatsAppSenderError ? error.status : 500;
  if (status >= 500) {
    console.error("[AnnouncementWhatsApp] Request failed.", error instanceof Error ? error.name : "UnknownError");
  }
  const message = error instanceof TeacherApiAuthError || error instanceof AnnouncementWhatsAppError || error instanceof TeacherWhatsAppSenderError
    ? error.message
    : "Announcement WhatsApp dispatch could not be completed.";
  return res.status(status).json({ success: false, error: message });
}
