"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { generateKeyPairSync, randomBytes, randomUUID } = require("node:crypto");

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  "";

const build = process.env.EDUTRACK_TEST_BUILD;

if (!projectId.startsWith("demo-")) {
  throw new Error("Safety failure: demo-* Firebase project required.");
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

// All credentials below are synthetic and local to this test process.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.FIREBASE_PROJECT_ID = projectId;
process.env.FIREBASE_CLIENT_EMAIL =
  "test-admin@demo-edutrack.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY =
  pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY =
  randomBytes(32).toString("base64");
process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED = "false";

const firebaseAdmin = require(
  path.join(build, "server/firebaseAdmin.js")
);
const postabi = require(
  path.join(build, "server/postabiWebApp.js")
);
const route = require(
  path.join(build, "api-handlers/admin/whatsapp/attendance-dispatch.js")
).default;

const auth = firebaseAdmin.getFirebaseAdminAuth();
const db = firebaseAdmin.getFirebaseAdminFirestore();
const settingsRef = db.collection("platformSettings").doc("whatsapp");

const originalFetch = global.fetch;
let blockedProviderRequests = 0;

global.fetch = async (input, ...args) => {
  const url = typeof input === "string"
    ? input
    : input && typeof input.url === "string"
      ? input.url
      : String(input);

  if (url.includes("postab.site") ||
      url.includes("webapi.postabi.com") ||
      url.includes("api.webapi.postabi.com")) {
    blockedProviderRequests += 1;
    throw new Error("Safety guard: provider network calls are forbidden in this test.");
  }

  return originalFetch(input, ...args);
};

async function createAccount() {
  const email = `admin-api-${randomUUID()}@example.test`;
  const password = `LocalOnly-${randomUUID()}-Aa1!`;

  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    },
  );

  const payload = await response.json();

  if (!response.ok || !payload.localId || !payload.idToken) {
    throw new Error(
      `Local Auth signup failed: ${payload.error?.message || response.status}`,
    );
  }

  return {
    uid: payload.localId,
    email,
    password,
    idToken: payload.idToken,
  };
}

async function refreshIdToken(account) {
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: account.email,
        password: account.password,
        returnSecureToken: true,
      }),
    },
  );

  const payload = await response.json();

  if (!response.ok || !payload.idToken) {
    throw new Error(
      `Local Auth signin failed: ${payload.error?.message || response.status}`,
    );
  }

  return payload.idToken;
}

async function callRoute(method, token, body) {
  const response = {
    statusCode: 200,
    headers: {},
    data: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
  };

  await route(
    {
      method,
      headers: token
        ? { authorization: `Bearer ${token}` }
        : {},
      body,
    },
    response,
  );

  return response;
}

test(
  "attendance authorization API enforces admin identity, confirmation, server switch and disable action",
  { timeout: 45000 },
  async () => {
    const createdAccounts = [];
    let adminRootRef = null;
    let settingsTouched = false;
    let originalSettingsExists = false;
    let originalSettingsData = null;

    try {
      const originalSnapshot = await settingsRef.get();
      originalSettingsExists = originalSnapshot.exists;
      originalSettingsData = originalSnapshot.exists
        ? originalSnapshot.data()
        : null;

      // Seed only the demo emulator with encrypted synthetic credentials.
      const encrypted = postabi.encryptPostabiWebAppCredentials(
        "synthetic-local-app-key",
        "synthetic-local-auth-key",
      );

      await settingsRef.set({
        provider: "postabi_web_app",
        businessNumber: "+923001234567",
        enabled: true,
        attendanceDispatchEnabled: false,
        configurationStatus: "saved_not_verified",
        ...encrypted,
      });
      settingsTouched = true;

      const normalAccount = await createAccount();
      createdAccounts.push(normalAccount);

      const adminAccount = await createAccount();
      createdAccounts.push(adminAccount);

      await auth.setCustomUserClaims(adminAccount.uid, { admin: true });
      const adminToken = await refreshIdToken(adminAccount);

      adminRootRef = db.collection("admins").doc(adminAccount.email.toLowerCase());

      // 405: only POST is accepted.
      const methodResult = await callRoute("GET", null, {});
      assert.equal(methodResult.statusCode, 405);

      // 401: no Firebase ID token.
      const missingAuth = await callRoute("POST", null, { enabled: true });
      assert.equal(missingAuth.statusCode, 401);

      // 403: valid Firebase account, but no admin claim.
      const nonAdmin = await callRoute(
        "POST",
        normalAccount.idToken,
        { enabled: true, confirmRealGuardianMessages: true },
      );
      assert.equal(nonAdmin.statusCode, 403);

      // 400: admin must explicitly confirm real guardian messages.
      const missingConfirmation = await callRoute(
        "POST",
        adminToken,
        { enabled: true },
      );
      assert.equal(missingConfirmation.statusCode, 400);

      // 503: the server-side kill switch must remain authoritative.
      process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED = "false";

      const switchOff = await callRoute(
        "POST",
        adminToken,
        { enabled: true, confirmRealGuardianMessages: true },
      );
      assert.equal(switchOff.statusCode, 503);

      let snapshot = await settingsRef.get();
      assert.equal(snapshot.data().attendanceDispatchEnabled, false);

      // 200: isolated test process simulates the configured server switch.
      // This invokes only the admin authorization route; no dispatch function is called.
      process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED = "true";

      const authorized = await callRoute(
        "POST",
        adminToken,
        { enabled: true, confirmRealGuardianMessages: true },
      );

      assert.equal(authorized.statusCode, 200);
      assert.equal(authorized.data.success, true);
      assert.equal(authorized.data.settings.attendanceDispatchEnabled, true);
      assert.equal(
        authorized.data.settings.configurationStatus,
        "admin_authorized_unverified",
      );

      snapshot = await settingsRef.get();
      const saved = snapshot.data();

      assert.equal(saved.attendanceDispatchEnabled, true);
      assert.equal(saved.configurationStatus, "admin_authorized_unverified");
      assert.equal(saved.attendanceDispatchAuthorizationVersion, 1);
      assert.equal(
        saved.attendanceDispatchAuthorizationScope,
        "attendance_alerts_only",
      );
      assert.equal(saved.attendanceDispatchAuthorizedByUid, adminAccount.uid);
      assert.equal(saved.providerCredentialsVerified, false);
      assert.equal(saved.deliveryVerified, false);

      // Disable must work even after the server switch is turned OFF.
      process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED = "false";

      const disabled = await callRoute(
        "POST",
        adminToken,
        { enabled: false },
      );

      assert.equal(disabled.statusCode, 200);
      assert.equal(disabled.data.success, true);
      assert.equal(disabled.data.settings.attendanceDispatchEnabled, false);

      snapshot = await settingsRef.get();
      assert.equal(snapshot.data().attendanceDispatchEnabled, false);
      assert.equal(snapshot.data().configurationStatus, "saved_not_verified");

      assert.equal(
        blockedProviderRequests,
        0,
        "The test must not contact Postabi.",
      );
    } finally {
      process.env.WHATSAPP_ATTENDANCE_DISPATCH_ENABLED = "false";

      if (settingsTouched) {
        if (originalSettingsExists) {
          await settingsRef.set(originalSettingsData);
        } else {
          await settingsRef.delete();
        }
      }

      if (adminRootRef) {
        await adminRootRef.delete().catch(() => {});
      }

      for (const account of createdAccounts) {
        await auth.deleteUser(account.uid).catch(() => {});
      }

      global.fetch = originalFetch;
    }
  },
);
