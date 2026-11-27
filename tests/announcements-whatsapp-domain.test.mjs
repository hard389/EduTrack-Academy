import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAnnouncementWhatsAppPhone,
  getAnnouncementConsentedPhone,
  createAnnouncementPhoneHash,
  createAnnouncementRecipientKey,
  calculateAnnouncementContentHash,
  createAnnouncementDispatchId,
  buildAnnouncementMessage,
} from "../server/announcementsWhatsAppDomain.mjs";

const LOCAL_PHONE = "03001234567";
const INTERNATIONAL_PHONE = "+92 300 1234567";

const validConsent = {
  phone: LOCAL_PHONE,
  announcementWhatsAppOptIn: true,
  announcementWhatsAppOptInAt: "2026-11-13T12:00:00.000Z",
  announcementWhatsAppOptInPhone: INTERNATIONAL_PHONE,
};

test("Pakistani guardian numbers normalize to country-code digits", () => {
  assert.equal(normalizeAnnouncementWhatsAppPhone(LOCAL_PHONE), "923001234567");
  assert.equal(normalizeAnnouncementWhatsAppPhone(INTERNATIONAL_PHONE), "923001234567");
  assert.equal(normalizeAnnouncementWhatsAppPhone("00923001234567"), "923001234567");
  assert.equal(normalizeAnnouncementWhatsAppPhone("3001234567"), "923001234567");
});

test("announcement consent requires explicit opt-in, timestamp, and matching current phone", () => {
  assert.equal(getAnnouncementConsentedPhone(validConsent), "923001234567");
  assert.equal(getAnnouncementConsentedPhone({ ...validConsent, announcementWhatsAppOptIn: false }), null);
  assert.equal(getAnnouncementConsentedPhone({ ...validConsent, announcementWhatsAppOptInAt: "" }), null);
  assert.equal(getAnnouncementConsentedPhone({ ...validConsent, announcementWhatsAppOptInPhone: "03009999999" }), null);
});

test("changing the guardian number or withdrawing consent makes the old consent invalid", () => {
  assert.equal(getAnnouncementConsentedPhone({ ...validConsent, phone: "03009999999" }), null);
  assert.equal(getAnnouncementConsentedPhone({ ...validConsent, announcementWhatsAppOptIn: false }), null);
});

test("invalid or incomplete Pakistani numbers are rejected", () => {
  assert.equal(normalizeAnnouncementWhatsAppPhone(""), null);
  assert.equal(normalizeAnnouncementWhatsAppPhone("03ABC"), null);
  assert.equal(normalizeAnnouncementWhatsAppPhone("0212345678"), null);
  assert.throws(() => createAnnouncementPhoneHash("not-a-phone"));
});

test("guardian phone fingerprint is deterministic and does not store the raw phone", () => {
  const first = createAnnouncementPhoneHash(LOCAL_PHONE);
  const second = createAnnouncementPhoneHash(INTERNATIONAL_PHONE);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes("923001234567"), false);
});

test("recipient key is stable for the same phone fingerprint", () => {
  const hash = createAnnouncementPhoneHash(LOCAL_PHONE);
  assert.equal(createAnnouncementRecipientKey(hash), createAnnouncementRecipientKey(hash));
  assert.match(createAnnouncementRecipientKey(hash), /^[a-f0-9]{64}$/);
  assert.throws(() => createAnnouncementRecipientKey("plain-phone-number"));
});

test("announcement content hash is stable and class ID order does not affect it", () => {
  const input = {
    tenantId: "School@example.com",
    alertId: "alert-1",
    title: "Parent Meeting",
    message: "Meeting on Monday.",
    category: "Announcements",
    targetClass: "All Classes",
    classIds: ["class-b", "class-a"],
  };
  const first = calculateAnnouncementContentHash(input);
  const second = calculateAnnouncementContentHash({ ...input, tenantId: "school@example.com", classIds: ["class-a", "class-b"] });
  assert.equal(first, second);
  assert.notEqual(first, calculateAnnouncementContentHash({ ...input, title: "Changed title" }));
  assert.notEqual(first, calculateAnnouncementContentHash({ ...input, alertId: "alert-2" }));
});

test("dispatch ID is stable per tenant and alert even if content or class membership changes", () => {
  const contentHash = calculateAnnouncementContentHash({
    tenantId: "school@example.com", alertId: "alert-1", title: "Notice", message: "Text",
    category: "Announcements", targetClass: "All Classes", classIds: ["c1"],
  });
  const input = { tenantId: "school@example.com", alertId: "alert-1", contentHash };
  assert.equal(createAnnouncementDispatchId(input), createAnnouncementDispatchId(input));
  assert.equal(createAnnouncementDispatchId(input), createAnnouncementDispatchId({ ...input, contentHash: "f".repeat(64) }));
  assert.notEqual(createAnnouncementDispatchId(input), createAnnouncementDispatchId({ ...input, tenantId: "other@example.com" }));
  assert.notEqual(createAnnouncementDispatchId(input), createAnnouncementDispatchId({ ...input, alertId: "alert-2" }));
});

test("announcement message identifies the school and selected audience", () => {
  const message = buildAnnouncementMessage({
    schoolName: "EduTrack School",
    targetClass: "Grade 7",
    title: "Parent Meeting",
    message: "Please attend on Monday at 10 AM.",
  });
  assert.match(message, /EduTrack School/);
  assert.match(message, /For: Grade 7/);
  assert.match(message, /Parent Meeting/);
  assert.match(message, /Please attend on Monday at 10 AM\./);
});

test("oversized announcement content is blocked instead of truncated", () => {
  assert.throws(() => buildAnnouncementMessage({ title: "T".repeat(141), message: "Valid body" }));
  assert.throws(() => buildAnnouncementMessage({ title: "Valid title", message: "M".repeat(3001) }));
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relativePath) => readFile(resolve(testRoot, relativePath), "utf8");

test("announcement dispatch is routed through the existing WhatsApp API dispatcher", async () => {
  const router = await readSource("server/whatsappApiRouter.ts");
  const entrypoint = await readSource("api/whatsapp.ts");
  assert.match(router, /defineApiRoute\(\["announcement-broadcast"\]/);
  assert.match(entrypoint, /dispatchWhatsAppApi/);
  assert.doesNotMatch(router, /from ["']\.\.\/api\/whatsapp\/announcement/);
});

test("announcement jobs are server-owned and blocked from browser Firestore access", async () => {
  const rules = await readSource("firestore.rules");
  assert.match(rules, /match \/whatsappAnnouncementDispatches\/\{dispatchId\}[\s\S]*?allow read, write: if false;/);
});

test("server dispatch requires admin authorization and both server feature switches", async () => {
  const server = await readSource("server/announcementsWhatsApp.ts");
  const admin = await readSource("server/adminWhatsApp.ts");
  assert.match(server, /WHATSAPP_DISPATCH_ENABLED !== "true"/);
  assert.match(server, /WHATSAPP_ANNOUNCEMENTS_ENABLED !== "true"/);
  assert.match(server, /announcementDispatchAuthorizationScope/);
  assert.match(admin, /announcementDispatchAction/);
  assert.match(admin, /announcements_to_opted_in_guardians_only/);
});

test("only Announcements alerts created by the existing broadcast screen are eligible", async () => {
  const server = await readSource("server/announcementsWhatsApp.ts");
  const alerts = await readSource("src/pages/alerts.tsx");
  assert.match(server, /data\.category !== "Announcements"/);
  assert.match(server, /data\.sender !== "Tigerr_Alert System"/);
  assert.match(alerts, /newCategory === 'Announcements'/);
  assert.match(alerts, /announcement-broadcast/);
});

test("guardian phone changes reset the separate announcement consent", async () => {
  const studentPage = await readSource("src/pages/DepartmentsPage.tsx");
  assert.match(studentPage, /setAnnouncementWhatsAppOptIn\(false\)/);
  assert.match(studentPage, /announcementWhatsAppOptInPhone/);
});

test("teacher must explicitly request WhatsApp; an in-app announcement can be saved alone", async () => {
  const alerts = await readSource("src/pages/alerts.tsx");
  assert.match(alerts, /const \[sendAnnouncementWhatsApp, setSendAnnouncementWhatsApp\] = useState\(false\)/);
  assert.match(alerts, /whatsappDispatchStatus: sendAnnouncementWhatsApp \? 'queued' : 'not_requested'/);
  assert.match(alerts, /newCategory === 'Announcements' && sendAnnouncementWhatsApp/);
  assert.match(alerts, /Also send this announcement to eligible parent\/guardian WhatsApp numbers now/);
});

test("each alert uses a stable dispatch ID and freezes its first class audience", async () => {
  const server = await readSource("server/announcementsWhatsApp.ts");
  const domain = await readSource("server/announcementsWhatsAppDomain.mjs");
  assert.match(domain, /edutrack-announcements:v2/);
  assert.match(server, /createAnnouncementDispatchId\(\{ tenantId: actor\.email, alertId \}\)/);
  assert.match(server, /const rawClassIds = existing\.classIds/);
  assert.match(server, /loadClassRowsByIds\(actor, classIds/);
  assert.match(server, /recipientsPreparedAt/);
});

test("uncertain and provider-rejected recipient outcomes require review, not automatic retry", async () => {
  const server = await readSource("server/announcementsWhatsApp.ts");
  assert.match(server, /counts\.dispatching > 0/);
  assert.match(server, /counts\.unknown_outcome > 0 \|\| counts\.provider_rejected > 0/);
  assert.match(server, /providerResult\.httpStatus >= 400 && providerResult\.httpStatus < 500 && providerResult\.httpStatus !== 429/);
  assert.match(server, /else finalStatus = "unknown_outcome"/);
  assert.match(server, /retrySafe: false/);
  assert.match(server, /\[408, 409, 425, 429\]\.includes\(providerHttpStatus\)/);
  assert.match(server, /Only a definitive provider-rejected announcement can be retried/);
  assert.doesNotMatch(server, /finalStatus = "retry_wait"/);
});
