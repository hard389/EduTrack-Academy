import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  new URL("../server/attendanceDispatchAuthorization.ts", import.meta.url),
  "utf8",
);

const javascript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const loadedModule = { exports: {} };

vm.runInNewContext(javascript, {
  module: loadedModule,
  exports: loadedModule.exports,
});

const { hasAttendanceDispatchAuthorization } = loadedModule.exports;

const validSettings = {
  enabled: true,
  attendanceDispatchEnabled: true,
  configurationStatus: "admin_authorized_unverified",
  attendanceDispatchAuthorizationVersion: 1,
  attendanceDispatchAuthorizationScope: "attendance_alerts_only",
  attendanceDispatchAuthorizedAt: "2026-11-07T12:00:00.000Z",
  attendanceDispatchAuthorizedByUid: "emulator-admin-uid",
};

test("accepts a complete version-1 attendance-only authorization", () => {
  assert.equal(hasAttendanceDispatchAuthorization(validSettings), true);
});

test("rejects legacy test-message receipt status", () => {
  assert.equal(
    hasAttendanceDispatchAuthorization({
      ...validSettings,
      configurationStatus: "webapp_test_message_received",
    }),
    false,
  );
});

test("rejects missing authorization version", () => {
  const settings = { ...validSettings };
  delete settings.attendanceDispatchAuthorizationVersion;
  assert.equal(hasAttendanceDispatchAuthorization(settings), false);
});

test("rejects wrong authorization scope", () => {
  assert.equal(
    hasAttendanceDispatchAuthorization({
      ...validSettings,
      attendanceDispatchAuthorizationScope: "all_messages",
    }),
    false,
  );
});

test("rejects missing authorizing administrator UID", () => {
  const settings = { ...validSettings };
  delete settings.attendanceDispatchAuthorizedByUid;
  assert.equal(hasAttendanceDispatchAuthorization(settings), false);
});

test("rejects missing authorization timestamp", () => {
  const settings = { ...validSettings };
  delete settings.attendanceDispatchAuthorizedAt;
  assert.equal(hasAttendanceDispatchAuthorization(settings), false);
});

test("rejects disabled attendance dispatch", () => {
  assert.equal(
    hasAttendanceDispatchAuthorization({
      ...validSettings,
      attendanceDispatchEnabled: false,
    }),
    false,
  );
});

test("rejects disabled central WhatsApp configuration", () => {
  assert.equal(
    hasAttendanceDispatchAuthorization({
      ...validSettings,
      enabled: false,
    }),
    false,
  );
});
