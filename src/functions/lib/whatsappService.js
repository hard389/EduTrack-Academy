"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_PARAMETER_ORDER = exports.WHATSAPP_ATTENDANCE_TEMPLATE_PARAMETER_ORDER = exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_LANGUAGE = exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_NAME = exports.WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE = exports.WHATSAPP_ATTENDANCE_TEMPLATE_NAME = exports.WHATSAPP_API_VERSION = exports.WHATSAPP_BUSINESS_ACCOUNT_ID = exports.WHATSAPP_PHONE_NUMBER_ID = exports.WHATSAPP_ACCESS_TOKEN = void 0;
exports.getApprovedTemplateInfo = getApprovedTemplateInfo;
exports.normalizeWhatsAppPhone = normalizeWhatsAppPhone;
exports.sendApprovedTextTemplate = sendApprovedTextTemplate;
exports.uploadPdfToWhatsAppMedia = uploadPdfToWhatsAppMedia;
exports.sendApprovedDocumentTemplate = sendApprovedDocumentTemplate;
const params_1 = require("firebase-functions/params");
exports.WHATSAPP_ACCESS_TOKEN = (0, params_1.defineSecret)("WHATSAPP_ACCESS_TOKEN");
exports.WHATSAPP_PHONE_NUMBER_ID = (0, params_1.defineString)("WHATSAPP_PHONE_NUMBER_ID");
exports.WHATSAPP_BUSINESS_ACCOUNT_ID = (0, params_1.defineString)("WHATSAPP_BUSINESS_ACCOUNT_ID");
exports.WHATSAPP_API_VERSION = (0, params_1.defineString)("WHATSAPP_API_VERSION", { default: "v25.0" });
exports.WHATSAPP_ATTENDANCE_TEMPLATE_NAME = (0, params_1.defineString)("WHATSAPP_ATTENDANCE_TEMPLATE_NAME", { default: "edutrack_absent_attendance_alert" });
exports.WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE = (0, params_1.defineString)("WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE", { default: "en" });
exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_NAME = (0, params_1.defineString)("WHATSAPP_MONTHLY_REPORT_TEMPLATE_NAME", { default: "edutrack_monthly_student_report_pdf" });
exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_LANGUAGE = (0, params_1.defineString)("WHATSAPP_MONTHLY_REPORT_TEMPLATE_LANGUAGE", { default: "en" });
// Set these in the Firebase Functions environment to match the approved template's BODY placeholders
// from {{1}} onward. Example: studentName,fatherName,className,date,academyName,teacherName
exports.WHATSAPP_ATTENDANCE_TEMPLATE_PARAMETER_ORDER = (0, params_1.defineString)("WHATSAPP_ATTENDANCE_TEMPLATE_PARAMETER_ORDER", { default: "" });
// Example: studentName,className,month,category. Must match the approved template exactly.
exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_PARAMETER_ORDER = (0, params_1.defineString)("WHATSAPP_MONTHLY_REPORT_TEMPLATE_PARAMETER_ORDER", { default: "" });
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function requireConfig(value, name) {
    const cleaned = value.trim();
    if (!cleaned)
        throw new Error(`Missing Firebase Functions configuration: ${name}.`);
    return cleaned;
}
function graphBaseUrl() {
    const version = requireConfig(exports.WHATSAPP_API_VERSION.value(), "WHATSAPP_API_VERSION");
    if (!/^v\d+\.\d+$/.test(version)) {
        throw new Error("WHATSAPP_API_VERSION must look like v25.0.");
    }
    return `https://graph.facebook.com/${version}`;
}
function graphHeaders() {
    const token = exports.WHATSAPP_ACCESS_TOKEN.value().trim();
    if (!token)
        throw new Error("Missing Firebase Secret: WHATSAPP_ACCESS_TOKEN.");
    return { Authorization: `Bearer ${token}` };
}
async function parseJsonResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!isRecord(body))
        return {};
    if (!response.ok) {
        const apiError = isRecord(body.error) ? body.error : {};
        const code = typeof apiError.code === "number" || typeof apiError.code === "string"
            ? String(apiError.code)
            : "unknown";
        // Deliberately do not include request headers, tokens, or recipient numbers in errors/logs.
        throw new Error(`WhatsApp Cloud API request failed with HTTP ${response.status} (Meta error code ${code}).`);
    }
    return body;
}
function templateComponents(template) {
    if (!Array.isArray(template.components))
        return [];
    return template.components.filter(isRecord);
}
function countPlaceholders(text) {
    const values = Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g));
    if (values.length === 0)
        return 0;
    const indices = values.map((item) => Number(item[1]));
    if (indices.some((value) => !Number.isInteger(value) || value < 1)) {
        throw new Error("The approved WhatsApp template contains an invalid placeholder index.");
    }
    const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
    const maxIndex = Math.max(...unique);
    if (unique.length !== maxIndex || unique.some((value, index) => value !== index + 1)) {
        throw new Error("The approved WhatsApp template has non-sequential placeholders; fix the template before sending.");
    }
    return maxIndex;
}
function getBodyParameterCount(template) {
    const components = templateComponents(template);
    const body = components.find((component) => readString(component.type).toUpperCase() === "BODY");
    const bodyText = body ? readString(body.text) : "";
    const bodyCount = countPlaceholders(bodyText);
    // This implementation intentionally supports document headers and body placeholders only.
    // Fail closed instead of silently omitting a text-header or dynamic-button parameter.
    for (const component of components) {
        const type = readString(component.type).toUpperCase();
        if (type === "BODY")
            continue;
        if (type === "HEADER" && readString(component.format).toUpperCase() === "DOCUMENT")
            continue;
        const text = readString(component.text);
        if (countPlaceholders(text) > 0) {
            throw new Error(`The approved template has dynamic ${type || "component"} placeholders that this integration does not support.`);
        }
        const buttons = Array.isArray(component.buttons) ? component.buttons : [];
        for (const button of buttons) {
            if (isRecord(button) && countPlaceholders(readString(button.url)) > 0) {
                throw new Error("The approved template has a dynamic URL button that this integration does not support.");
            }
        }
    }
    return bodyCount;
}
async function getApprovedTemplateInfo(kind, requireDocumentHeader = false) {
    const businessAccountId = requireConfig(exports.WHATSAPP_BUSINESS_ACCOUNT_ID.value(), "WHATSAPP_BUSINESS_ACCOUNT_ID");
    const name = kind === "attendance"
        ? requireConfig(exports.WHATSAPP_ATTENDANCE_TEMPLATE_NAME.value(), "WHATSAPP_ATTENDANCE_TEMPLATE_NAME")
        : requireConfig(exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_NAME.value(), "WHATSAPP_MONTHLY_REPORT_TEMPLATE_NAME");
    const language = kind === "attendance"
        ? requireConfig(exports.WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE.value(), "WHATSAPP_ATTENDANCE_TEMPLATE_LANGUAGE")
        : requireConfig(exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_LANGUAGE.value(), "WHATSAPP_MONTHLY_REPORT_TEMPLATE_LANGUAGE");
    const url = new URL(`${graphBaseUrl()}/${encodeURIComponent(businessAccountId)}/message_templates`);
    url.searchParams.set("name", name);
    url.searchParams.set("fields", "name,language,status,components");
    const response = await fetch(url, { headers: graphHeaders() });
    const payload = await parseJsonResponse(response);
    const templates = Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
    const found = templates.find((template) => readString(template.name) === name &&
        readString(template.language ?? template.language_code) === language);
    if (!found) {
        throw new Error(`WhatsApp template '${name}' (${language}) was not found in the configured WhatsApp Business Account.`);
    }
    if (readString(found.status).toUpperCase() !== "APPROVED") {
        throw new Error(`WhatsApp template '${name}' (${language}) is not APPROVED; no message was sent.`);
    }
    const components = templateComponents(found);
    const header = components.find((component) => readString(component.type).toUpperCase() === "HEADER");
    const hasDocumentHeader = Boolean(header && readString(header.format).toUpperCase() === "DOCUMENT");
    if (requireDocumentHeader && !hasDocumentHeader) {
        throw new Error(`WhatsApp template '${name}' must have an approved DOCUMENT header to send the monthly PDF.`);
    }
    return {
        name,
        language,
        bodyParameterCount: getBodyParameterCount(found),
        hasDocumentHeader,
    };
}
function normalizeFieldName(value) {
    return value.trim().replace(/[\s_-]/g, "").toLowerCase();
}
function buildBodyParameters(kind, expectedCount, values) {
    if (expectedCount === 0)
        return [];
    const rawOrder = (kind === "attendance"
        ? exports.WHATSAPP_ATTENDANCE_TEMPLATE_PARAMETER_ORDER.value()
        : exports.WHATSAPP_MONTHLY_REPORT_TEMPLATE_PARAMETER_ORDER.value()).trim();
    const order = rawOrder.split(",").map((item) => item.trim()).filter(Boolean);
    if (order.length !== expectedCount) {
        const setting = kind === "attendance"
            ? "WHATSAPP_ATTENDANCE_TEMPLATE_PARAMETER_ORDER"
            : "WHATSAPP_MONTHLY_REPORT_TEMPLATE_PARAMETER_ORDER";
        throw new Error(`${setting} must list exactly ${expectedCount} field names in the same order as the approved template BODY placeholders.`);
    }
    const valueMap = new Map();
    for (const [key, value] of Object.entries(values)) {
        valueMap.set(normalizeFieldName(key), typeof value === "string" ? value : String(value ?? ""));
    }
    return order.map((fieldName) => {
        const resolved = valueMap.get(normalizeFieldName(fieldName));
        if (resolved === undefined) {
            throw new Error(`Unsupported WhatsApp template parameter field '${fieldName}'.`);
        }
        return { type: "text", text: resolved || "—" };
    });
}
function normalizeWhatsAppPhone(value) {
    let digits = String(value ?? "").replace(/\D/g, "");
    if (digits.startsWith("00"))
        digits = digits.slice(2);
    if (digits.startsWith("0") && digits.length === 11)
        digits = `92${digits.slice(1)}`;
    else if (digits.length === 10)
        digits = `92${digits}`;
    if (digits.length < 8 || digits.length > 15)
        return null;
    return digits;
}
async function postWhatsAppMessage(payload) {
    const phoneNumberId = requireConfig(exports.WHATSAPP_PHONE_NUMBER_ID.value(), "WHATSAPP_PHONE_NUMBER_ID");
    const response = await fetch(`${graphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        headers: { ...graphHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = await parseJsonResponse(response);
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
    const message = messages[0];
    const messageId = message ? readString(message.id) : "";
    if (!messageId)
        throw new Error("WhatsApp Cloud API accepted no message ID in its response.");
    const contacts = Array.isArray(body.contacts) ? body.contacts.filter(isRecord) : [];
    const recipientId = contacts[0] ? readString(contacts[0].wa_id) : "";
    return { messageId, recipientId: recipientId || undefined };
}
async function sendApprovedTextTemplate(kind, recipientPhone, values) {
    const to = normalizeWhatsAppPhone(recipientPhone);
    if (!to)
        throw new Error("The guardian WhatsApp number is invalid; no message was sent.");
    const template = await getApprovedTemplateInfo(kind, false);
    const parameters = buildBodyParameters(kind, template.bodyParameterCount, values);
    const components = parameters.length > 0
        ? [{ type: "body", parameters }]
        : undefined;
    return postWhatsAppMessage({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
            name: template.name,
            language: { code: template.language },
            ...(components ? { components } : {}),
        },
    });
}
async function uploadPdfToWhatsAppMedia(pdfBase64, filename) {
    const cleanedBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "").trim();
    if (!cleanedBase64 || cleanedBase64.length > 1_500_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(cleanedBase64)) {
        throw new Error("The monthly report PDF payload is invalid or too large.");
    }
    const pdfBytes = Buffer.from(cleanedBase64, "base64");
    if (pdfBytes.length < 5 || pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("The report attachment is not a valid PDF file.");
    }
    if (pdfBytes.length > 1_000_000) {
        throw new Error("The monthly report PDF must be under 1 MB for this integration.");
    }
    const phoneNumberId = requireConfig(exports.WHATSAPP_PHONE_NUMBER_ID.value(), "WHATSAPP_PHONE_NUMBER_ID");
    const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "student-report.pdf";
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), safeFilename);
    const response = await fetch(`${graphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/media`, {
        method: "POST",
        headers: graphHeaders(),
        body: form,
    });
    const body = await parseJsonResponse(response);
    const mediaId = readString(body.id);
    if (!mediaId)
        throw new Error("WhatsApp Cloud API did not return a media ID for the PDF.");
    return mediaId;
}
async function sendApprovedDocumentTemplate(recipientPhone, pdfBase64, filename, values) {
    const to = normalizeWhatsAppPhone(recipientPhone);
    if (!to)
        throw new Error("The guardian WhatsApp number is invalid; no message was sent.");
    const template = await getApprovedTemplateInfo("monthlyReport", true);
    const parameters = buildBodyParameters("monthlyReport", template.bodyParameterCount, values);
    const mediaId = await uploadPdfToWhatsAppMedia(pdfBase64, filename);
    const components = [{
            type: "header",
            parameters: [{ type: "document", document: { id: mediaId, filename } }],
        }];
    if (parameters.length > 0)
        components.push({ type: "body", parameters });
    return postWhatsAppMessage({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
            name: template.name,
            language: { code: template.language },
            components,
        },
    });
}
//# sourceMappingURL=whatsappService.js.map