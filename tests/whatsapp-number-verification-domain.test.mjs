import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWhatsAppNumber,
  validateScannerBaseUrl,
  buildScannerEndpoint,
  chunkUniqueNumbers,
  mapScannerResponse,
} from "../server/whatsappNumberVerificationDomain.mjs";

test("normalizes Pakistani guardian numbers without changing international E.164 digits", () => {
  assert.equal(normalizeWhatsAppNumber("0300 1234567"), "923001234567");
  assert.equal(normalizeWhatsAppNumber("+92 300 1234567"), "923001234567");
  assert.equal(normalizeWhatsAppNumber("0092-300-1234567"), "923001234567");
  assert.equal(normalizeWhatsAppNumber("447700900123"), "447700900123");
});

test("rejects malformed and out-of-range phone numbers", () => {
  assert.equal(normalizeWhatsAppNumber("+92 300 123"), null);
  assert.equal(normalizeWhatsAppNumber(""), null);
  assert.equal(normalizeWhatsAppNumber(null), null);
  assert.equal(normalizeWhatsAppNumber("123456789012345678"), null);
});

test("requires an HTTPS scanner origin and appends the documented provider path", () => {
  assert.equal(validateScannerBaseUrl("https://scanner.example.com/").valid, true);
  assert.equal(buildScannerEndpoint("https://scanner.example.com/"), "https://scanner.example.com/api/whatsapp-web/check-number");
  assert.equal(validateScannerBaseUrl("http://scanner.example.com").valid, false);
  assert.equal(validateScannerBaseUrl("https://localhost").valid, false);
  assert.equal(validateScannerBaseUrl("https://10.0.0.8").valid, false);
  assert.equal(validateScannerBaseUrl("https://scanner.example.com/path").valid, false);
});

test("deduplicates input and emits batches no larger than 50", () => {
  const numbers = Array.from({ length: 103 }, (_, index) => `92300123${String(index).padStart(4, "0")}`);
  const chunks = chunkUniqueNumbers([...numbers, numbers[0], numbers[1]], 50);
  assert.deepEqual(chunks.map((batch) => batch.length), [50, 50, 3]);
  assert.equal(new Set(chunks.flat()).size, 103);
});

test("maps provider exists true/false accurately and leaves unmatched responses failed", () => {
  const result = mapScannerResponse({
    success: true,
    total_checked: 3,
    on_whatsapp: 1,
    not_on_whatsapp: 1,
    results: [
      { number: "923001234567", exists: true, jid: "923001234567@s.whatsapp.net" },
      { number: "923001111111", exists: false, jid: null },
    ],
  }, ["923001234567", "923001111111", "923002222222"]);
  assert.deepEqual(result, [
    { number: "923001234567", status: "registered" },
    { number: "923001111111", status: "not_registered" },
    { number: "923002222222", status: "verification_failed" },
  ]);
});

test("does not mark unsuccessful provider envelopes as not registered", () => {
  const result = mapScannerResponse({ success: false, results: [] }, ["923001234567"]);
  assert.deepEqual(result, [{ number: "923001234567", status: "verification_failed" }]);
});

test("ignores provider results for numbers that were not requested", () => {
  const result = mapScannerResponse({
    success: true,
    results: [
      { number: "923009999999", exists: true },
      { number: "923001234567", exists: true },
    ],
  }, ["923001234567"]);
  assert.deepEqual(result, [{ number: "923001234567", status: "registered" }]);
});
