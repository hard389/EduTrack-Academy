"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Safety failure: Firestore Emulator is required.");
}

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  "";

if (!projectId.startsWith("demo-")) {
  throw new Error("Safety failure: only demo-* projects are allowed.");
}

const handlers = require("../src/functions/lib/attendanceNotifications.js");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

const functionsRequire = createRequire(
  resolve(__dirname, "../src/functions/package.json")
);

const { getFirestore } = functionsRequire("firebase-admin/firestore");
const db = getFirestore();

const queueHandler = handlers.queueAbsentAttendanceNotifications;

assert.equal(
  typeof queueHandler?.run,
  "function",
  "Attendance queue handler must expose its run method."
);

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
    name: "Mismatched Consent Phone",
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
    name: "Consent Phone Not Current",
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

const expectedStatuses = {
  validConsent: "queued",
  fatherPhoneConsent: "queued",
  legacyOnly: "blocked_missing_opt_in",
  missingTimestamp: "blocked_missing_opt_in",
  mismatchedPhone: "blocked_missing_opt_in",
  revokedConsent: "blocked_missing_opt_in",
  consentPhoneNotCurrent: "blocked_missing_phone",
  phoneWithoutConsent: "blocked_missing_opt_in"
};

test(
  "attendance queue accepts only explicit current attendance consent",
  async () => {
    const tenantId =
      `consent-integration-${Date.now()}-${process.pid}@example.com`;

    const classId = `consent-class-${Date.now()}`;
    const date = new Date().toISOString().slice(0, 10);
    const attendanceId = `${classId}_${date}`;

    const tenantRef = db.collection("users").doc(tenantId);
    const tenantUid = `consent-teacher-${process.pid}`;
    const entitlementRef = tenantRef.collection("subscriptionEntitlements").doc("current");
    const classRef = tenantRef.collection("classes").doc(classId);
    const attendanceRef = tenantRef
      .collection("attendance")
      .doc(attendanceId);

    const jobsRef = tenantRef.collection("whatsappNotificationJobs");

    try {
      // Attendance queue creation requires an active subscription projection.
      await tenantRef.set({
        uid: tenantUid,
        email: tenantId,
        role: "teacher",
        active: true,
        disabled: false,
        deleted: false,
      });

      await entitlementRef.set({
        uid: tenantUid,
        email: tenantId,
        active: true,
        status: "active",
        startedAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 86400000),
        featurePermissions: {
          attendance_alerts: "enabled"
        }
      });

      await classRef.set({
        name: "Consent Integration Test Class",
        students
      });

      const attendanceData = {
        classId,
        date,
        attendanceMap: Object.fromEntries(
          Object.keys(students).map(id => [id, false])
        )
      };

      await attendanceRef.set(attendanceData);

      const attendanceSnapshot = await attendanceRef.get();

      // Invoke ONLY the queue handler.
      // The Firebase sender trigger is never invoked.
      // Functions Emulator is not running; only Firestore Emulator is used.
      await queueHandler.run({
        params: { tenantId, attendanceId },
        data: attendanceSnapshot
      });

      const jobsSnapshot = await jobsRef.get();

      assert.equal(
        jobsSnapshot.size,
        Object.keys(students).length,
        "Exactly one job must be created for each absent student."
      );

      const actualStatuses = {};

      for (const document of jobsSnapshot.docs) {
        const job = document.data();
        actualStatuses[job.studentId] = job.status;
      }

      assert.deepEqual(actualStatuses, expectedStatuses);

      for (const [studentId, expectedStatus] of Object.entries(expectedStatuses)) {
        assert.equal(
          actualStatuses[studentId],
          expectedStatus,
          `Unexpected consent status for ${studentId}`
        );
      }
    } finally {
      const jobs = await jobsRef.get();

      await Promise.all(
        jobs.docs.map(document => document.ref.delete())
      );

      await Promise.all([
        attendanceRef.delete(),
        classRef.delete(),
        entitlementRef.delete(),
        tenantRef.delete()
      ]);
    }
  }
);
