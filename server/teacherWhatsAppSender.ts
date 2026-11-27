import type { Firestore } from "firebase-admin/firestore";
import {
  decryptPostabiWebAppCredentials,
  hasPostabiWebAppCredentials,
  type PostabiWebAppCredentials,
} from "./postabiWebApp.js";

type SenderSettings = Record<string, unknown>;

export class TeacherWhatsAppSenderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TeacherWhatsAppSenderError";
  }
}

export type ResolvedTeacherWhatsAppSender = {
  senderType: "central" | "teacher_personal";
  senderNumber: string;
  credentials: PostabiWebAppCredentials;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): string {
  let digits = String(value ?? "").replace(/\D/g, "");

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) {
    digits = `92${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `92${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) return "";
  return digits;
}

function decryptCredentials(data: SenderSettings): PostabiWebAppCredentials {
  try {
    const credentials = decryptPostabiWebAppCredentials(data);

    if (!credentials.appKey || !credentials.authKey) {
      throw new Error("Incomplete credentials");
    }

    return credentials;
  } catch {
    throw new TeacherWhatsAppSenderError(
      503,
      "Saved WhatsApp credentials could not be decrypted. No message was sent.",
    );
  }
}

export async function resolveTeacherWhatsAppSender(
  db: Firestore,
  teacherUid: string,
  centralSettings: SenderSettings,
): Promise<ResolvedTeacherWhatsAppSender> {
  const senderRef = db
    .collection("platformSettings")
    .doc("whatsapp")
    .collection("teacherSenders")
    .doc(teacherUid);

  const personalSnapshot = await senderRef.get();
  const personal = personalSnapshot.data() ?? {};

  // An explicitly selected personal sender is strict: never fall back to central.
  if (personalSnapshot.exists && personal.selectedForPersonalRouting === true) {
    const senderNumber = normalizeNumber(personal.phoneNumber);

    if (!senderNumber) {
      throw new TeacherWhatsAppSenderError(
        409,
        "The selected teacher WhatsApp number is invalid. No message was sent.",
      );
    }

    if (
      personal.connectionStatus !== "verified" ||
      personal.testStatus !== "confirmed_received" ||
      personal.verificationSenderMatched !== true ||
      !clean(personal.verifiedAt)
    ) {
      throw new TeacherWhatsAppSenderError(
        409,
        "The selected teacher WhatsApp sender is not verified. No message was sent and central fallback is blocked.",
      );
    }

    if (!hasPostabiWebAppCredentials(personal)) {
      throw new TeacherWhatsAppSenderError(
        409,
        "The selected teacher WhatsApp credentials are missing. No message was sent and central fallback is blocked.",
      );
    }

    return {
      senderType: "teacher_personal",
      senderNumber,
      credentials: decryptCredentials(personal),
    };
  }

  // Central sender remains the default when personal routing is not selected.
  if (centralSettings.enabled !== true) {
    throw new TeacherWhatsAppSenderError(
      409,
      "The central WhatsApp sender is disabled and no verified personal sender is selected.",
    );
  }

  const centralNumber = normalizeNumber(centralSettings.businessNumber);

  if (!centralNumber || !hasPostabiWebAppCredentials(centralSettings)) {
    throw new TeacherWhatsAppSenderError(
      409,
      "The central WhatsApp number and Postabi credentials must be configured.",
    );
  }

  return {
    senderType: "central",
    senderNumber: centralNumber,
    credentials: decryptCredentials(centralSettings),
  };
}
