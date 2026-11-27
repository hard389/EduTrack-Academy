"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { generateKeyPairSync, randomUUID } = require("node:crypto");

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  "";

const build = process.env.EDUTRACK_TEST_BUILD;

if (!projectId.startsWith("demo-")) {
  throw new Error("Safety failure: demo-* project required.");
}
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080") {
  throw new Error("Safety failure: Firestore Emulator required.");
}
if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099") {
  throw new Error("Safety failure: Auth Emulator required.");
}
if (!build) {
  throw new Error("Safety failure: temporary backend build path missing.");
}

// Ephemeral test-only credentials; never use outside demo emulators.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.FIREBASE_PROJECT_ID = projectId;
process.env.FIREBASE_CLIENT_EMAIL =
  "test-admin@demo-edutrack.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY =
  pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED = "false";

const firebaseAdmin = require(
  path.join(build, "server/firebaseAdmin.js")
);
const queueModule = require(
  path.join(build, "server/attendanceNotifications.js")
);

const auth = firebaseAdmin.getFirebaseAdminAuth();
const db = firebaseAdmin.getFirebaseAdminFirestore();

async function createEmulatorTeacher() {
  const email =
    `vercel-consent-${Date.now()}-${randomUUID()}@example.test`;
  const password = `LocalTest-${randomUUID()}-Aa1!`;

  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true
      })
    }
  );

  const payload = await response.json();

  if (!response.ok || !payload.localId || !payload.idToken) {
    throw new Error(
      `Auth Emulator signup failed: ${payload.error?.message || response.status}`
    );
  }

  return {
    email,
    uid: payload.localId,
    idToken: payload.idToken
  };
}

const phoneA = "+923001111111";
const phoneB = "+923002222222";
const phoneC = "+923003333333";

const students = {
  validConsent: {
    id: "validConsent",
    name: "Valid Consent",
    phone: phoneA,
    attendanceWhatsAppOptIn: true,
    attendanceWhatsAppOptInAt: "2026-11-07T10:00:00.000Z",
    attendanceWhatsAppOptInPhone: phoneA
  },
  fatherPhoneConsent: {
    id: "fatherPhoneConsent",
    name: "Father Phone Consent",
    phone: phoneB,
    fatherPhone: phoneC,
    attendanceWhatsAppOptIn: true,
    attendanceWhatsAppOptInAt: "2026-11-07T10:00:00.000Z",
    attendanceWhatsAppOptInPhone: phoneC
  },
  legacyOnly: {
    id: "legacyOnly",
    name: "Legacy Consent Only",
    phone: phoneA,
    parentWhatsAppOptIn: true,
    parentWhatsAppOptInAt: "2026-11-07T10:00:00.000Z",
    parentWhatsAppOptInPhone: phoneA
  },
  missingTimestamp: {
    id: "missingTimestamp",
    name: "Missing Timestamp",
    phone: phoneA,
    attendanceWhatsAppOptIn: true,
    attendanceWhatsAppOptInPhone: phoneA
  },
  mismatchedPhone: {
    id: "mismatchedPhone",
    name: "Mismatched Phone",
    phone: phoneA,
    attendanceWhatsAppOptIn: true,
    attendanceWhatsAppOptInAt: "2026-11-07T10:00:00.000Z",
    attendanceWhatsAppOptInPhone: phoneB
  },
  revokedConsent: {
    id: "revokedConsent",
    name: "Revoked Consent",
    phone: phoneA,
    attendanceWhatsAppOptIn: false,
    attendanceWhatsAppOptInAt: "2026-11-07T10:00:00.000Z",
    attendanceWhatsAppOptInPhone: phoneA
  },
  consentPhoneNotCurrent: {
    id: "consentPhoneNotCurrent",
    name: "Phone Not Current",
    attendanceWhatsAppOptIn: true,
    attendanceWhatsAppOptInAt: "2026-11-07T10:00:00.000Z",
    attendanceWhatsAppOptInPhone: phoneA
  },
  phoneWithoutConsent: {
    id: "phoneWithoutConsent",
    name: "Phone Without Consent",
    phone: phoneB
  }
};

const expected = {
  validConsent: "prepared_for_vercel",
  fatherPhoneConsent: "prepared_for_vercel",
  legacyOnly: "blocked_missing_opt_in",
  missingTimestamp: "blocked_missing_opt_in",
  mismatchedPhone: "blocked_missing_opt_in",
  revokedConsent: "blocked_missing_opt_in",
  consentPhoneNotCurrent: "blocked_missing_phone",
  phoneWithoutConsent: "blocked_missing_opt_in"
};

test(
  "Vercel queue enforces attendance consent using local Auth and Firestore",
  async () => {
    let teacher;
    let tenantRef;
    let classRef;
    let attendanceRef;

    try {
      teacher = await createEmulatorTeacher();

      tenantRef = db.collection("users").doc(teacher.email);
      classRef = tenantRef.collection("classes").doc(`consent-${Date.now()}`);

      const classId = classRef.id;
      const date = new Date().toISOString().slice(0, 10);
      attendanceRef = tenantRef.collection("attendance")
        .doc(`${classId}_${date}`);

      await tenantRef.set({
        uid: teacher.uid,
        email: teacher.email,
        role: "teacher",
        active: true,
        disabled: false,
        deleted: false
      });

      await classRef.set({
        name: "Local Vercel Consent Test",
        students
      });

      await attendanceRef.set({
        classId,
        date,
        attendanceMap: Object.fromEntries(
          Object.keys(students).map(id => [id, false])
        )
      });

      const result = await queueModule.createAttendanceNotificationJobs({
        headers: {
          authorization: `Bearer ${teacher.idToken}`
        },
        body: { classId, date }
      });

      assert.equal(result.success, true);
      assert.equal(result.preparedCount, 2);
      assert.equal(result.blockedCount, 6);
      assert.equal(result.alreadyExistedCount, 0);
      assert.equal(result.skippedMissingStudentCount, 0);
      assert.equal(result.dispatchAvailable, false);
      assert.equal(result.messageSent, false);
      assert.equal(result.preparedJobIds.length, 2);

      const snapshot = await tenantRef
        .collection("whatsappNotificationJobs")
        .get();

      assert.equal(snapshot.size, 8);

      const actual = {};

      for (const document of snapshot.docs) {
        const job = document.data();
        actual[job.studentId] = job.status;

        assert.equal(job.provider, "postabi");
        assert.equal(job.dispatchEnabled, false);
        assert.equal("recipientPhone" in job, false);
      }

      assert.deepEqual(actual, expected);
    } finally {
      if (tenantRef) {
        const jobs = await tenantRef
          .collection("whatsappNotificationJobs")
          .get();

        await Promise.all(jobs.docs.map(doc => doc.ref.delete()));

        if (attendanceRef) await attendanceRef.delete();
        if (classRef) await classRef.delete();
        await tenantRef.delete();
      }

      if (teacher) await auth.deleteUser(teacher.uid);
    }
  }
);
