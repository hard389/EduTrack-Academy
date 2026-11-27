import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  verifyTeacherRequest,
  TeacherApiAuthError,
  type TeacherApiRequest,
} from "./teacherAuth.js";
import { assertTeacherActorFeatureEntitlement } from "./subscriptionEntitlements.js";
import {
  resolveTeacherWhatsAppSender,
  TeacherWhatsAppSenderError,
} from "./teacherWhatsAppSender.js";
import { sendPostabiWebAppMessage } from "./postabiWebApp.js";
import { createWhatsAppNotificationImageLink } from "./whatsappNotificationImage.js";
import { formatNotificationDate } from "./whatsappNotificationImageDomain.mjs";
import {
  calculateQuizResultsContentHash,
  createQuizResultsDispatchId,
  createQuizResultsRecipientKey,
  getQuizResultsConsentedPhone,
  normalizeQuizWhatsAppPhone,
  parseQuizResultMark,
} from "./quizResultsWhatsAppDomain.mjs";

type RecordLike = Record<string, unknown>;
type QuizRequest = TeacherApiRequest & { body?: unknown };

export class QuizResultsWhatsAppError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "QuizResultsWhatsAppError";
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSavedQuizDate(value: unknown): string {
  if (typeof value === "string") return formatNotificationDate(value.slice(0, 80));

  let date: Date | null = value instanceof Date ? value : null;
  if (!date && isRecord(value) && typeof value.toDate === "function") {
    try {
      const candidate: unknown = (value.toDate as () => unknown)();
      if (candidate instanceof Date) date = candidate;
    } catch {
      return "";
    }
  }

  if (!date || Number.isNaN(date.getTime())) return "";
  return formatNotificationDate(date.toISOString().slice(0, 10));
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

function buildSnapshot(classId: string, quizId: string, classData: RecordLike, quizData: RecordLike) {
  const totalMarks = Number(quizData.totalMarks);
  const topic = clean(quizData.topic);
  const date = clean(quizData.date);
  if (!Number.isFinite(totalMarks) || totalMarks <= 0 || !topic) {
    throw new QuizResultsWhatsAppError(409, "The saved quiz topic or total marks are invalid.");
  }
  if (!Array.isArray(quizData.studentScores)) {
    throw new QuizResultsWhatsAppError(409, "The saved quiz has no valid student score list.");
  }

  const roster = readRoster(classData);
  const seen = new Set<string>();
  const validRows: Array<{ studentId: string; studentName: string; rollNo: string; marksObtained: number }> = [];
  const eligibleStudentIds: string[] = [];
  let skippedNoScore = 0;
  let skippedNoConsent = 0;
  let skippedMissingStudent = 0;

  for (const rawRow of quizData.studentScores) {
    if (!isRecord(rawRow)) { skippedNoScore++; continue; }
    const studentId = String(rawRow.id ?? rawRow.studentId ?? "").trim();
    if (!studentId || studentId.includes("/")) { skippedNoScore++; continue; }
    if (seen.has(studentId)) {
      throw new QuizResultsWhatsAppError(409, "The saved quiz contains duplicate student IDs. Reopen and reconcile the quiz before publishing.");
    }
    seen.add(studentId);
    const mark = parseQuizResultMark(rawRow.marksObtained, totalMarks);
    if (mark.kind !== "valid") { skippedNoScore++; continue; }
    const student = roster.get(studentId);
    if (!student) { skippedMissingStudent++; continue; }
    const studentName = clean(student.name) || clean(rawRow.name) || "Student";
    const rollNo = clean(student.rollNo) || clean(rawRow.rollNo);
    validRows.push({ studentId, studentName, rollNo, marksObtained: mark.value });
    if (getQuizResultsConsentedPhone(student)) eligibleStudentIds.push(studentId);
    else skippedNoConsent++;
  }

  if (validRows.length === 0) {
    throw new QuizResultsWhatsAppError(409, "No valid student marks are available to publish.");
  }

  const className = clean(classData.name) || clean(classData.className) || clean(classData.title) || "Class";
  const contentHash = calculateQuizResultsContentHash({ classId, quizId, topic, totalMarks, date, rows: validRows });
  return {
    totalMarks,
    topic,
    date,
    className,
    validRows,
    eligibleStudentIds,
    skippedNoScore,
    skippedNoConsent,
    skippedMissingStudent,
    contentHash,
  };
}

async function loadAuthorizedSender(actor: Awaited<ReturnType<typeof verifyTeacherRequest>>) {
  if (process.env.WHATSAPP_DISPATCH_ENABLED !== "true") {
    throw new QuizResultsWhatsAppError(503, "WhatsApp server dispatch is disabled. No message was sent.");
  }
  const settingsSnapshot = await actor.db.collection("platformSettings").doc("whatsapp").get();
  const settings = settingsSnapshot.data() ?? {};
  if (
    settings.enabled !== true ||
    settings.quizResultsDispatchEnabled !== true ||
    settings.quizResultsDispatchAuthorizationVersion !== 1 ||
    settings.quizResultsDispatchAuthorizationScope !== "quiz_results_to_opted_in_guardians_only" ||
    !clean(settings.quizResultsDispatchAuthorizedAt) ||
    !clean(settings.quizResultsDispatchAuthorizedByUid)
  ) {
    throw new QuizResultsWhatsAppError(409, "Quiz-result WhatsApp sending requires separate administrator authorization and current parent consent.");
  }
  try {
    const sender = await resolveTeacherWhatsAppSender(actor.db, actor.uid, settings);
    return { settings, sender };
  } catch (error) {
    if (error instanceof TeacherWhatsAppSenderError) {
      throw new QuizResultsWhatsAppError(error.status, error.message);
    }
    console.error("[QuizResultsWhatsApp] Sender configuration resolution failed.", error instanceof Error ? error.name : "UnknownError");
    throw new QuizResultsWhatsAppError(503, "The configured WhatsApp sender could not be resolved. No message was sent.");
  }
}

function validateRequestBody(body: unknown): RecordLike {
  if (!isRecord(body)) throw new QuizResultsWhatsAppError(400, "A valid JSON request body is required.");
  const action = clean(body.action);
  if (action !== "publish" && action !== "send") throw new QuizResultsWhatsAppError(400, "Unsupported quiz WhatsApp action.");
  const classId = clean(body.classId);
  const quizId = clean(body.quizId);
  if (!classId || classId.length > 150 || classId.includes("/") || !quizId || quizId.length > 150 || quizId.includes("/")) {
    throw new QuizResultsWhatsAppError(400, "A valid class and quiz ID are required.");
  }
  return body;
}

export async function dispatchQuizResultsWhatsApp(request: QuizRequest) {
  let actor: Awaited<ReturnType<typeof verifyTeacherRequest>>;
  try {
    actor = await verifyTeacherRequest(request);
  } catch (error) {
    if (error instanceof TeacherApiAuthError) throw error;
    throw new QuizResultsWhatsAppError(401, "Teacher authentication could not be verified.");
  }

  try {
    await assertTeacherActorFeatureEntitlement(actor, 'quiz_result_notifications');
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    throw new QuizResultsWhatsAppError(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403,
      error instanceof Error ? error.message : 'Your Academy Admin has not granted Quiz Result Notification permission.');
  }

  const body = validateRequestBody(request.body);
  const action = clean(body.action);
  const classId = clean(body.classId);
  const quizId = clean(body.quizId);
  const { sender } = await loadAuthorizedSender(actor);
  const classRef = actor.tenantRef.collection("classes").doc(classId);
  const quizRef = classRef.collection("quizzes").doc(quizId);
  const profileSettingsRef = actor.tenantRef.collection("settings").doc("profile_data");
  const [classSnapshot, quizSnapshot, profileSettingsSnapshot] = await Promise.all([
    classRef.get(), quizRef.get(), profileSettingsRef.get(),
  ]);
  if (!classSnapshot.exists || !quizSnapshot.exists) {
    throw new QuizResultsWhatsAppError(404, "The selected class or saved quiz was not found in your workspace.");
  }
  const classData = classSnapshot.data();
  const quizData = quizSnapshot.data();
  if (!isRecord(classData) || !isRecord(quizData)) {
    throw new QuizResultsWhatsAppError(409, "The selected class or quiz data is invalid.");
  }
  const snapshot = buildSnapshot(classId, quizId, classData, quizData);
  const dispatchId = createQuizResultsDispatchId({ tenantId: actor.email, classId, quizId });
  const dispatchRef = actor.tenantRef.collection("whatsappQuizResultDispatches").doc(dispatchId);

  if (action === "publish") {
    if (snapshot.eligibleStudentIds.length === 0) {
      throw new QuizResultsWhatsAppError(409, "No scored students currently have valid Quiz Results WhatsApp consent for their saved parent number.");
    }

    await actor.db.runTransaction(async (transaction) => {
      const [latestClassSnapshot, latestQuizSnapshot, existingDispatchSnapshot] = await Promise.all([
        transaction.get(classRef),
        transaction.get(quizRef),
        transaction.get(dispatchRef),
      ]);
      if (!latestClassSnapshot.exists || !latestQuizSnapshot.exists) {
        throw new QuizResultsWhatsAppError(404, "The class or quiz changed before publication.");
      }
      const latestClass = latestClassSnapshot.data();
      const latestQuiz = latestQuizSnapshot.data();
      if (!isRecord(latestClass) || !isRecord(latestQuiz)) {
        throw new QuizResultsWhatsAppError(409, "The latest class or quiz data is invalid.");
      }
      const latest = buildSnapshot(classId, quizId, latestClass, latestQuiz);
      if (latest.contentHash !== snapshot.contentHash) {
        throw new QuizResultsWhatsAppError(409, "Quiz marks changed while publication was starting. Refresh the quiz and try again.");
      }
      if (!existingDispatchSnapshot.exists) {
        transaction.create(dispatchRef, {
          kind: "quiz_results_whatsapp",
          tenantId: actor.email,
          teacherUid: actor.uid,
          classId,
          quizId,
          topic: snapshot.topic,
          className: snapshot.className,
          date: snapshot.date,
          totalMarks: snapshot.totalMarks,
          contentHash: snapshot.contentHash,
          recipientCount: snapshot.eligibleStudentIds.length,
          skippedNoConsent: snapshot.skippedNoConsent,
          skippedNoScore: snapshot.skippedNoScore,
          skippedMissingStudent: snapshot.skippedMissingStudent,
          status: "prepared",
          acceptedCount: 0,
          unknownOutcomeCount: 0,
          rejectedCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        const existing = existingDispatchSnapshot.data() ?? {};
        if (existing.kind !== "quiz_results_whatsapp" || existing.tenantId !== actor.email || existing.contentHash !== snapshot.contentHash) {
          throw new QuizResultsWhatsAppError(409, "A conflicting publication record exists. Contact the administrator before resending.");
        }
      }
    });

    return {
      action: "published",
      dispatchId,
      contentHash: snapshot.contentHash,
      eligibleStudentIds: snapshot.eligibleStudentIds,
      eligibleCount: snapshot.eligibleStudentIds.length,
      skippedNoConsent: snapshot.skippedNoConsent,
      skippedNoScore: snapshot.skippedNoScore,
      skippedMissingStudent: snapshot.skippedMissingStudent,
      senderType: sender.senderType,
    };
  }

  const requestedDispatchId = clean(body.dispatchId);
  const studentId = clean(body.studentId);
  if (!/^[a-f0-9]{64}$/i.test(requestedDispatchId) || requestedDispatchId !== dispatchId) {
    throw new QuizResultsWhatsAppError(409, "The quiz publication no longer matches the saved marks. Publish the current results again.");
  }
  if (!studentId || studentId.length > 160 || studentId.includes("/")) {
    throw new QuizResultsWhatsAppError(400, "A valid student ID is required.");
  }

  const score = snapshot.validRows.find((row) => row.studentId === studentId);
  const student = readRoster(classData).get(studentId);
  if (!score || !student) {
    return { action: "send", status: "skipped_no_valid_score", studentId };
  }
  const recipientPhone = getQuizResultsConsentedPhone(student);
  if (!recipientPhone) {
    return { action: "send", status: "skipped_no_current_consent", studentId };
  }

  const profile = profileSettingsSnapshot.data() ?? {};
  const nestedProfile = isRecord(profile.profile) ? profile.profile : profile;
  const tenantProfile = isRecord(actor.tenantData.profile) ? actor.tenantData.profile : {};
  const academyName = clean(nestedProfile.schoolName) || clean(nestedProfile.academyName) ||
    clean(profile.schoolName) || clean(profile.academyName) || clean(actor.tenantData.schoolName) ||
    clean(actor.tenantData.academyName) || clean(tenantProfile.schoolName);
  const className = clean(classData.name) || clean(classData.className) || clean(classData.title);
  const classCode = clean(classData.classCode) || clean(classData.code);
  const quizDate = formatSavedQuizDate(snapshot.date || quizData.createdAt);
  const actualStudentName = clean(student.name) || (score.studentName !== "Student" ? clean(score.studentName) : "");
  if (!academyName || !actualStudentName || !className || !classCode || !snapshot.topic || !quizDate) {
    throw new QuizResultsWhatsAppError(409, "The quiz image requires configured academy name, student name, class, class code, quiz title and saved quiz date. No image was sent.");
  }
  const percentageValue = Math.round((score.marksObtained / snapshot.totalMarks) * 1000) / 10;
  const percentage = `${Number.isInteger(percentageValue) ? String(percentageValue) : percentageValue.toFixed(1)}%`;
  const imageLink = await createWhatsAppNotificationImageLink({
    db: actor.db,
    tenantId: actor.email,
    payload: {
      kind: "quiz_result",
      academyName,
      teacherAvatarUrl: clean(nestedProfile.avatarUrl) || clean(nestedProfile.profileImage) ||
        clean(profile.avatarUrl) || clean(profile.profileImage) || clean(actor.tenantData.profileImage) ||
        clean(actor.tenantData.avatarUrl) || clean(actor.tenantData.photoURL) || clean(tenantProfile.avatarUrl) || clean(tenantProfile.profileImage),
      studentAvatarUrl: clean(student.profileImage) || clean(student.photoURL) || clean(student.photoUrl) || clean(student.avatarUrl) || clean(student.avatar) || clean(student.imageUrl),
      studentName: actualStudentName,
      fatherName: clean(student.fatherName),
      rollNumber: clean(student.rollNo) || clean(student.rollNumber) || clean(score.rollNo),
      className,
      classCode,
      quizName: snapshot.topic,
      quizDate,
      marksObtained: score.marksObtained,
      totalMarks: snapshot.totalMarks,
      percentage,
      resultMessage: "Keep practicing and stay consistent to improve your score.",
      academyContactPhone: clean(nestedProfile.phone) || clean(profile.phone),
      academyContactEmail: clean(nestedProfile.email) || clean(profile.email),
    },
  });


  const recipientKey = createQuizResultsRecipientKey(studentId);
  const recipientRef = dispatchRef.collection("recipients").doc(recipientKey);
  const phoneHash = createHash("sha256").update(`edutrack-quiz-result-recipient-phone:v1:${recipientPhone}`).digest("hex");

  const claim = await actor.db.runTransaction(async (transaction) => {
    const [latestClassSnapshot, latestQuizSnapshot, latestDispatchSnapshot, recipientSnapshot] = await Promise.all([
      transaction.get(classRef),
      transaction.get(quizRef),
      transaction.get(dispatchRef),
      transaction.get(recipientRef),
    ]);
    if (!latestClassSnapshot.exists || !latestQuizSnapshot.exists || !latestDispatchSnapshot.exists) {
      throw new QuizResultsWhatsAppError(404, "The quiz publication could not be found.");
    }
    const latestClass = latestClassSnapshot.data();
    const latestQuiz = latestQuizSnapshot.data();
    const dispatch = latestDispatchSnapshot.data() ?? {};
    if (!isRecord(latestClass) || !isRecord(latestQuiz) || dispatch.kind !== "quiz_results_whatsapp" || dispatch.tenantId !== actor.email || dispatch.contentHash !== snapshot.contentHash) {
      throw new QuizResultsWhatsAppError(409, "The quiz publication is not valid for this teacher workspace.");
    }
    const latest = buildSnapshot(classId, quizId, latestClass, latestQuiz);
    if (latest.contentHash !== snapshot.contentHash) {
      throw new QuizResultsWhatsAppError(409, "Quiz marks changed after publication. Publish the updated results before sending.");
    }
    if (recipientSnapshot.exists) {
      return { claimed: false as const, existingStatus: clean(recipientSnapshot.data()?.status) || "already_processed" };
    }
    const latestStudent = readRoster(latestClass).get(studentId);
    const latestPhone = latestStudent ? getQuizResultsConsentedPhone(latestStudent) : null;
    const latestScore = latest.validRows.find((row) => row.studentId === studentId);
    if (!latestStudent || !latestPhone || !latestScore || latestPhone !== recipientPhone) {
      return { claimed: false as const, existingStatus: "skipped_consent_or_roster_changed" };
    }
    transaction.create(recipientRef, {
      studentId,
      studentName: latestScore.studentName,
      status: "dispatching",
      recipientPhoneHash: phoneHash,
      senderType: sender.senderType,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(dispatchRef, { status: "dispatching", updatedAt: FieldValue.serverTimestamp() });
    return { claimed: true as const };
  });

  if (!claim.claimed) {
    return {
      action: "send",
      status: "already_processed",
      previousStatus: claim.existingStatus,
      studentId,
    };
  }


  let providerResult: Awaited<ReturnType<typeof sendPostabiWebAppMessage>> | null = null;
  let finalStatus: "provider_accepted" | "provider_rejected" | "unknown_outcome" = "unknown_outcome";
  let safeFailure = "";
  try {
    providerResult = await sendPostabiWebAppMessage({
      credentials: sender.credentials,
      to: recipientPhone,
      type: "image",
      url: imageLink.url,
    });
    if (providerResult.accepted) finalStatus = "provider_accepted";
    else if (providerResult.httpStatus >= 400 && providerResult.httpStatus < 500 && providerResult.httpStatus !== 429) finalStatus = "provider_rejected";
    else finalStatus = "unknown_outcome";
  } catch (error) {
    safeFailure = error instanceof Error ? error.name : "UnknownProviderError";
    finalStatus = "unknown_outcome";
  }

  try {
    await actor.db.runTransaction(async (transaction) => {
      const [latestRecipient, latestDispatch] = await Promise.all([
        transaction.get(recipientRef),
        transaction.get(dispatchRef),
      ]);
      if (!latestRecipient.exists || latestRecipient.data()?.status !== "dispatching" || !latestDispatch.exists) {
        throw new Error("Quiz result dispatch claim changed after provider invocation.");
      }
      const failedAt = finalStatus === "provider_rejected" ? Timestamp.now() : null;
      transaction.update(recipientRef, {
        status: finalStatus,
        providerHttpStatus: providerResult?.httpStatus ?? null,
        providerStatus: providerResult?.providerStatus || null,
        providerStatusCode: providerResult?.providerStatusCode ?? null,
        providerMessageId: providerResult?.messageId ?? null,
        providerAccepted: providerResult?.accepted === true,
        providerSenderNumberLast4: sender.senderNumber.slice(-4),
        providerFromLast4: providerResult?.from ? normalizeQuizWhatsAppPhone(providerResult.from)?.slice(-4) ?? null : null,
        providerRecipientLast4: recipientPhone.slice(-4),
        providerErrorClass: safeFailure || null,
        retrySafe: false,
        ...(failedAt ? {
          failedAt,
          expiresAt: Timestamp.fromMillis(failedAt.toMillis() + 24 * 60 * 60 * 1000),
        } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(dispatchRef, {
        ...(finalStatus === "provider_accepted" ? { acceptedCount: FieldValue.increment(1) } : {}),
        ...(finalStatus === "provider_rejected" ? { rejectedCount: FieldValue.increment(1) } : {}),
        ...(finalStatus === "unknown_outcome" ? { unknownOutcomeCount: FieldValue.increment(1) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    console.error("[QuizResultsWhatsApp] Could not persist post-provider outcome; recipient remains claimed to prevent duplicate sending.", error instanceof Error ? error.name : "UnknownError");
    throw new QuizResultsWhatsAppError(503, "The WhatsApp provider was called, but the result could not be saved. Do not resend until the dispatch record is reviewed.");
  }

  return {
    action: "send",
    status: finalStatus,
    studentId,
    providerAccepted: providerResult?.accepted === true,
    deliveryConfirmed: false,
    message: finalStatus === "provider_accepted"
      ? "Accepted by the WhatsApp provider; final delivery is not confirmed."
      : finalStatus === "provider_rejected"
        ? "The WhatsApp provider rejected this message. Automatic retry is disabled."
        : "The message outcome is unknown. Automatic retry is blocked to prevent duplicates.",
  };
}
