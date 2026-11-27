import { isIP } from "node:net";

const MAX_PROVIDER_BATCH_SIZE = 50;
const PROVIDER_PATH = "/api/whatsapp-web/check-number";

export function normalizeWhatsAppNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (String(value).length > 40) return null;
  let digits = String(value).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10) digits = `92${digits}`;
  if (!/^\d{8,15}$/.test(digits)) return null;
  if (digits.startsWith("92") && digits.length !== 12) return null;
  return digits;
}

export function validateScannerBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { valid: false, error: "Enter the WhatsApp Number Scanner API base URL." };
  }
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return { valid: false, error: "Scanner API base URL must be an HTTPS URL without credentials, query or fragment." };
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      return { valid: false, error: "Enter only the scanner API origin, for example https://scanner.example.com." };
    }
    const ipLiteral = hostname.replace(/^\[|\]$/g, "");
    if (
      !hostname.includes(".") || isIP(ipLiteral) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal")
    ) {
      return { valid: false, error: "Private or local scanner API hosts are not allowed." };
    }
    return { valid: true, value: url.origin };
  } catch {
    return { valid: false, error: "Enter a valid scanner API base URL." };
  }
}

export function buildScannerEndpoint(baseUrl) {
  const checked = validateScannerBaseUrl(baseUrl);
  if (!checked.valid) throw new Error(checked.error);
  return `${checked.value}${PROVIDER_PATH}`;
}

export function chunkUniqueNumbers(values, maxSize = MAX_PROVIDER_BATCH_SIZE) {
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > MAX_PROVIDER_BATCH_SIZE) {
    throw new Error("Provider batch size must be between 1 and 50.");
  }
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const number = normalizeWhatsAppNumber(value);
    if (number && !seen.has(number)) {
      seen.add(number);
      normalized.push(number);
    }
  }
  const chunks = [];
  for (let index = 0; index < normalized.length; index += maxSize) {
    chunks.push(normalized.slice(index, index + maxSize));
  }
  return chunks;
}

export function mapScannerResponse(payload, requestedNumbers) {
  const requested = [...new Set((Array.isArray(requestedNumbers) ? requestedNumbers : [])
    .map(normalizeWhatsAppNumber).filter(Boolean))];
  const mapped = new Map();
  const validEnvelope = payload && typeof payload === "object" && !Array.isArray(payload) && payload.success === true && Array.isArray(payload.results);

  if (validEnvelope) {
    for (const item of payload.results) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const number = normalizeWhatsAppNumber(item.number);
      if (!number || !requested.includes(number) || typeof item.exists !== "boolean") continue;
      mapped.set(number, item.exists ? "registered" : "not_registered");
    }
  }

  return requested.map((number) => ({
    number,
    status: mapped.get(number) || "verification_failed",
  }));
}

export const WHATSAPP_NUMBER_PROVIDER_BATCH_SIZE = MAX_PROVIDER_BATCH_SIZE;
export const WHATSAPP_NUMBER_PROVIDER_PATH = PROVIDER_PATH;
