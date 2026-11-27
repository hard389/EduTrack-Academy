"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const read = (relativePath) => readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");

test("only the standalone WhatsApp test-send handler is explicitly retired", () => {
  const testSend = read("api-handlers/admin/whatsapp/test-send.ts");
  assert.match(testSend, /status\(410\)/);
  assert.match(testSend, /LEGACY_ENDPOINT_RETIRED/);
  assert.match(testSend, /no-store/);
  for (const activeRoute of ["confirm-test-received.ts", "test-connection.ts"]) {
    const source = read(`api-handlers/admin/whatsapp/${activeRoute}`);
    assert.doesNotMatch(source, /status\(410\)|LEGACY_ENDPOINT_RETIRED/);
    assert.match(source, /req\.method !== "POST"/);
  }
});

test("Admin teacher connection verification endpoints remain registered and are still used by the UI", () => {
  const router = read("server/adminApiRouter.ts");
  const ui = read("src/pages/admin/WhatsAppManagement.tsx");
  const testConnection = read("api-handlers/admin/whatsapp/test-connection.ts");
  const confirmReceived = read("api-handlers/admin/whatsapp/confirm-test-received.ts");
  assert.match(router, /defineApiRoute\(\["whatsapp", "test-connection"\], testConnectionHandler\)/);
  assert.match(router, /defineApiRoute\(\["whatsapp", "confirm-test-received"\], confirmTestHandler\)/);
  assert.match(ui, /\/api\/admin\/whatsapp\/test-connection/);
  assert.match(ui, /\/api\/admin\/whatsapp\/confirm-test-received/);
  assert.match(testConnection, /sendTeacherWhatsAppVerificationTest\(req\)/);
  assert.match(confirmReceived, /confirmTeacherWhatsAppTestReceived\(req\)/);
});
