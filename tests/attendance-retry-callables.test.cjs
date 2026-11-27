const test = require("node:test");
const assert = require("node:assert/strict");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Safety check failed: tests require the Firestore Emulator.");
}

const projectId =
  process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";

if (!projectId.startsWith("demo-")) {
  throw new Error("Safety check failed: use a demo-* Firebase project.");
}

const handlers = require("../src/functions/lib/attendanceNotifications.js");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const functionsRequire = createRequire(
  resolve(__dirname, "../src/functions/package.json"),
);
const { getFirestore } = functionsRequire("firebase-admin/firestore");
const db = getFirestore();

const listCallable = handlers.listRetryableAbsentAttendanceNotifications;
const retryCallable = handlers.retryFailedAbsentAttendanceNotification;

assert.equal(typeof listCallable?.run, "function",
  "Listing callable must expose its handler for tests.");
assert.equal(typeof retryCallable?.run, "function",
  "Retry callable must expose its handler for tests.");

let sequence = 0;
const tenantsToClean = [];

async function makeTeacher(label, overrides = {}) {
  sequence += 1;
  const email = `retry-integration-${Date.now()}-${sequence}@example.com`;
  const uid = `retry-teacher-${sequence}`;

  const ref = db.collection("users").doc(email);
  const profile = {
    uid,
    email,
    role: "teacher",
    active: true,
    ...overrides,
  };

  await ref.set(profile);

  await ref.collection("subscriptionEntitlements").doc("current").set({
    uid,
    email,
    active: true,
    status: "active",
    startedAt: new Date(Date.now() - 86_400_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    featurePermissions: {
      attendance_alerts: "configurable",
    },
    projectionVersion: 1,
  });

  tenantsToClean.push(ref);

  return { ref, email, uid, profile, label };
}

function requestFor(teacher, data = {}, uid = teacher.uid) {
  return {
    auth: {
      uid,
      token: { email: teacher.email },
    },
    data,
  };
}

async function seedJob(teacher, jobId, data) {
  const ref = teacher.ref.collection("whatsappNotificationJobs").doc(jobId);
  await ref.set({
    status: "failed",
    retrySafe: true,
    attemptCount: 1,
    createdAt: new Date(),
    ...data,
  });
  return ref;
}

function expectCallableError(expectedCode) {
  return (error) => error && error.code === expectedCode;
}

test("listing returns only safe failed jobs and excludes guardian phone data", async () => {
  const teacher = await makeTeacher("listing");
  const privatePhone = "+923001234567";

  await seedJob(teacher, "safe-job", {
    recipientPhone: privatePhone,
    guardianPhone: privatePhone,
    phone: privatePhone,
    lastError: "Temporary API failure",
  });

  await seedJob(teacher, "uncertain-job", {
    status: "unknown_outcome",
    retrySafe: true,
  });

  await seedJob(teacher, "unsafe-failed-job", {
    retrySafe: false,
  });

  await seedJob(teacher, "exhausted-job", {
    attemptCount: 3,
  });

  await seedJob(teacher, "sending-job", {
    status: "sending",
  });

  const result = await listCallable.run(requestFor(teacher));

  assert.equal(result.success, true);
  assert.deepEqual(result.jobs.map((job) => job.jobId), ["safe-job"]);
  assert.deepEqual(
    Object.keys(result.jobs[0]).sort(),
    ["jobId", "status", "attemptCount", "createdAt", "lastError"].sort(),
  );
  assert.equal(JSON.stringify(result).includes(privatePhone), false);
});

test("inactive teacher cannot list or retry jobs", async () => {
  const teacher = await makeTeacher("inactive", { active: false });
  await seedJob(teacher, "inactive-job", {});

  await assert.rejects(
    () => listCallable.run(requestFor(teacher)),
    expectCallableError("permission-denied"),
  );

  await assert.rejects(
    () => retryCallable.run(requestFor(teacher, { jobId: "inactive-job" })),
    expectCallableError("permission-denied"),
  );
});

test("a different UID cannot access another teacher's workspace", async () => {
  const teacher = await makeTeacher("wrong-owner");
  await seedJob(teacher, "owner-job", {});

  await assert.rejects(
    () => listCallable.run(requestFor(teacher, {}, "different-user-uid")),
    expectCallableError("permission-denied"),
  );

  await assert.rejects(
    () => retryCallable.run(
      requestFor(teacher, { jobId: "owner-job" }, "different-user-uid"),
    ),
    expectCallableError("permission-denied"),
  );
});

test("missing authentication is rejected", async () => {
  await assert.rejects(
    () => listCallable.run({ auth: null, data: {} }),
    expectCallableError("unauthenticated"),
  );
});

test("three attempts exhaust the retry limit", async () => {
  const teacher = await makeTeacher("max-attempts");
  const jobRef = await seedJob(teacher, "maxed-job", { attemptCount: 3 });

  await assert.rejects(
    () => retryCallable.run(requestFor(teacher, { jobId: "maxed-job" })),
    expectCallableError("resource-exhausted"),
  );

  const saved = await jobRef.get();
  assert.equal(saved.data().status, "failed");
});

test("unknown_outcome is never requeued, even if retrySafe is incorrectly true", async () => {
  const teacher = await makeTeacher("uncertain");
  const jobRef = await seedJob(teacher, "uncertain-job", {
    status: "unknown_outcome",
    retrySafe: true,
  });

  await assert.rejects(
    () => retryCallable.run(requestFor(teacher, { jobId: "uncertain-job" })),
    expectCallableError("failed-precondition"),
  );

  const saved = await jobRef.get();
  assert.equal(saved.data().status, "unknown_outcome");
});

test("a valid retry atomically queues the job and clears retry eligibility", async () => {
  const teacher = await makeTeacher("successful-requeue");
  const jobRef = await seedJob(teacher, "valid-job", {
    attemptCount: 1,
    retrySafe: true,
  });

  const result = await retryCallable.run(
    requestFor(teacher, { jobId: "valid-job" }),
  );

  assert.equal(result.success, true);
  assert.equal(result.status, "queued");
  assert.equal(result.jobId, "valid-job");

  const saved = await jobRef.get();
  assert.equal(saved.data().status, "queued");
  assert.equal(saved.data().retrySafe, false);
});

test("a missing job is not requeued", async () => {
  const teacher = await makeTeacher("missing-job");

  await assert.rejects(
    () => retryCallable.run(requestFor(teacher, { jobId: "does-not-exist" })),
    expectCallableError("not-found"),
  );
});

test.after(async () => {
  for (const tenantRef of tenantsToClean) {
    try {
      const [jobs, entitlements] = await Promise.all([
        tenantRef.collection("whatsappNotificationJobs").get(),
        tenantRef.collection("subscriptionEntitlements").get(),
      ]);

      await Promise.all([
        ...jobs.docs,
        ...entitlements.docs,
      ].map((item) => item.ref.delete()));

      await tenantRef.delete();
    } catch (error) {
      console.error("Test cleanup warning:", error.message);
    }
  }
});
