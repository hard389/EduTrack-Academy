import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type PostabiWebAppCredentials = {
  appKey: string;
  authKey: string;
};

type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
};

/**
 * Postabi Web App (App Key + Auth Key) endpoint.
 * Do not replace this with the separate Bearer-token REST API endpoint.
 * Source: Postabi's published Web API integration guide.
 */
export const POSTABI_WEB_APP_SEND_URL =
  "https://webapi.postabi.com/api/whatsapp-web/send-message";

function getEncryptionKey(): Buffer {
  const configured =
    process.env.WHATSAPP_CREDENTIALS_ENCRYPTION_KEY?.trim();

  if (!configured) {
    throw new Error("WhatsApp server credential encryption is not configured.");
  }

  const key = Buffer.from(configured, "base64");

  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/, "") !==
      configured.replace(/=+$/, "")
  ) {
    throw new Error("WhatsApp server credential encryption key is invalid.");
  }

  return key;
}

function encryptSecret(value: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(
  ciphertextValue: unknown,
  ivValue: unknown,
  tagValue: unknown,
): string {
  const ciphertext =
    typeof ciphertextValue === "string" ? ciphertextValue.trim() : "";
  const iv = typeof ivValue === "string" ? ivValue.trim() : "";
  const tag = typeof tagValue === "string" ? tagValue.trim() : "";

  if (!ciphertext || !iv || !tag) return "";

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(iv, "base64"),
    );

    decipher.setAuthTag(Buffer.from(tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored Postabi Web App credentials could not be decrypted.");
  }
}

export function encryptPostabiWebAppCredentials(
  appKey: string,
  authKey: string,
): Record<string, string> {
  const cleanAppKey = appKey.trim();
  const cleanAuthKey = authKey.trim();

  if (!cleanAppKey || !cleanAuthKey) {
    throw new Error("Both Postabi App Key and Auth Key are required.");
  }

  if (cleanAppKey.length > 2048 || cleanAuthKey.length > 2048) {
    throw new Error("Postabi credentials exceed the allowed length.");
  }

  const encryptedAppKey = encryptSecret(cleanAppKey);
  const encryptedAuthKey = encryptSecret(cleanAuthKey);

  return {
    postabiAppKeyCiphertext: encryptedAppKey.ciphertext,
    postabiAppKeyIv: encryptedAppKey.iv,
    postabiAppKeyTag: encryptedAppKey.tag,
    postabiAuthKeyCiphertext: encryptedAuthKey.ciphertext,
    postabiAuthKeyIv: encryptedAuthKey.iv,
    postabiAuthKeyTag: encryptedAuthKey.tag,
    postabiCredentialsEncryption: "aes-256-gcm-v1",
  };
}

export function hasPostabiWebAppCredentials(
  data: Record<string, unknown>,
): boolean {
  return Boolean(
    data.postabiAppKeyCiphertext &&
    data.postabiAppKeyIv &&
    data.postabiAppKeyTag &&
    data.postabiAuthKeyCiphertext &&
    data.postabiAuthKeyIv &&
    data.postabiAuthKeyTag,
  );
}

export function decryptPostabiWebAppCredentials(
  data: Record<string, unknown>,
): PostabiWebAppCredentials {
  if (!hasPostabiWebAppCredentials(data)) {
    return { appKey: "", authKey: "" };
  }

  const appKey = decryptSecret(
    data.postabiAppKeyCiphertext,
    data.postabiAppKeyIv,
    data.postabiAppKeyTag,
  );

  const authKey = decryptSecret(
    data.postabiAuthKeyCiphertext,
    data.postabiAuthKeyIv,
    data.postabiAuthKeyTag,
  );

  if (!appKey || !authKey) {
    throw new Error("Both Postabi Web App credentials must be configured.");
  }

  return { appKey, authKey };
}

export type PostabiWebAppMessageInput = {
  credentials: PostabiWebAppCredentials;
  to: string;
  type: "text" | "image" | "audio" | "video" | "document";
  message?: string;
  url?: string;
};

export type PostabiWebAppMessageResult = {
  httpStatus: number;
  providerStatus: string;
  providerStatusCode: number | null;
  from: string | null;
  to: string | null;
  accepted: boolean;
  messageId: string | null;
};

function normalizeNumber(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function safeDiagnosticToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(normalized)
    ? normalized
    : null;
}

function logPostabiTransportFailure(error: unknown, requestType: string): void {
  const top = error instanceof Error ? error : null;
  const cause = top && typeof top.cause === "object" && top.cause !== null
    ? top.cause as Record<string, unknown>
    : null;

  // Deliberately omit credentials, recipient number, message body and media URL.
  console.error("[PostabiWebApp] Outbound request failed before an HTTP response.", {
    errorName: top?.name ?? "UnknownError",
    errorMessage: top?.message?.slice(0, 160) ?? "Non-Error thrown",
    causeName: safeDiagnosticToken(cause?.name),
    causeCode: safeDiagnosticToken(cause?.code),
    causeSyscall: safeDiagnosticToken(cause?.syscall),
    causeHostname: safeDiagnosticToken(cause?.hostname),
    causePort: typeof cause?.port === "number" && Number.isInteger(cause.port)
      ? cause.port
      : null,
    endpointHost: new URL(POSTABI_WEB_APP_SEND_URL).host,
    requestType,
    timeoutMs: 20000,
  });
}

export async function sendPostabiWebAppMessage(
  input: PostabiWebAppMessageInput,
): Promise<PostabiWebAppMessageResult> {
  const { appKey, authKey } = input.credentials;
  const recipient = normalizeNumber(input.to);
  const message = input.message?.trim() ?? "";
  const mediaUrl = input.url?.trim() ?? "";

  if (!appKey || !authKey) {
    throw new Error("Postabi App Key and Auth Key are not configured.");
  }

  if (recipient.length < 8 || recipient.length > 15) {
    throw new Error("A valid recipient number with country code is required.");
  }

  if (input.type === "text" && !message) {
    throw new Error("A text message is required.");
  }

  if (input.type !== "text") {
    if (!mediaUrl) {
      throw new Error("A direct media URL is required.");
    }

    let parsedMediaUrl: URL;

    try {
      parsedMediaUrl = new URL(mediaUrl);
    } catch {
      throw new Error("The media URL is invalid.");
    }

    if (parsedMediaUrl.protocol !== "https:") {
      throw new Error("The media URL must use HTTPS.");
    }
  }

  const form = new FormData();
  form.append("app_key", appKey);
  form.append("auth_key", authKey);
  form.append("to", recipient);
  form.append("type", input.type);

  if (input.type === "text") {
    form.append("message", message);
  } else {
    form.append("url", mediaUrl);
  }

  let response: Response;
  try {
    response = await fetch(POSTABI_WEB_APP_SEND_URL, {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    logPostabiTransportFailure(error, input.type);
    throw error;
  }

  const responseText = await response.text().catch(() => "");
  let payload: unknown = null;

  try {
    payload = JSON.parse(responseText.slice(0, 8192));
  } catch {
    payload = null;
  }

  const root =
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const data =
    typeof root.data === "object" &&
    root.data !== null &&
    !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : {};

  const providerStatus =
    typeof root.status === "string" ? root.status.trim().slice(0, 60) : "";

  const rawMessageId =
    typeof root.message_id === "string" ? root.message_id :
    typeof root.messageId === "string" ? root.messageId :
    typeof data.message_id === "string" ? data.message_id :
    typeof data.messageId === "string" ? data.messageId :
    typeof data.id === "string" ? data.id : "";
  const messageId = rawMessageId.trim().slice(0, 200) || null;

  const providerStatusCode =
    typeof data.status_code === "number" ? data.status_code : null;

  const from =
    typeof data.from === "string" ? data.from.trim().slice(0, 30) : null;

  const to =
    typeof data.to === "string" ? data.to.trim().slice(0, 30) : null;

  const normalizedProviderStatus = providerStatus.toLowerCase();
  const hasProviderRecipient = Boolean(to && normalizeNumber(to));
  const providerRecipientMatches =
    !hasProviderRecipient || normalizeNumber(to) === recipient;

  // Support both documented Success/200 and the account-observed sent response.
  // "sent" means provider acceptance only, not confirmed WhatsApp delivery.
  const accepted =
    response.ok &&
    providerRecipientMatches &&
    (
      (
        normalizedProviderStatus === "success" &&
        providerStatusCode === 200 &&
        hasProviderRecipient
      ) ||
      (
        normalizedProviderStatus === "sent" &&
        (providerStatusCode === null || providerStatusCode === 200)
      )
    );

  return {
    httpStatus: response.status,
    providerStatus,
    providerStatusCode,
    from,
    to,
    accepted,
    messageId,
  };
}
