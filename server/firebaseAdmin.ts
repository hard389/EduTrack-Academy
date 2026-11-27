import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const APP_NAME = "edutrack-vercel-api";

export class FirebaseAdminConfigurationError extends Error {
  constructor() {
    super("Firebase Admin configuration is missing or invalid.");
    this.name = "FirebaseAdminConfigurationError";
  }
}

export class AdminApiAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiAuthError";
  }
}

function getFirebaseAdminApp() {
  const existing = getApps().find((app) => app.name === APP_NAME);
  if (existing) return existing;

  let account: Record<string, unknown> = {};

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();

  if (json) {
    try {
      account = JSON.parse(json) as Record<string, unknown>;
    } catch (error) {
      console.error("[firebase-admin] service-account JSON parsing failed.", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new FirebaseAdminConfigurationError();
    }
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    (typeof account.project_id === "string" ? account.project_id : "");

  const clientEmail =
    process.env.FIREBASE_CLIENT_EMAIL ||
    (typeof account.client_email === "string" ? account.client_email : "");

  const rawPrivateKey =
    process.env.FIREBASE_PRIVATE_KEY ||
    (typeof account.private_key === "string" ? account.private_key : "");

  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");
  const useLocalApplicationDefaultCredentials =
    !json && !clientEmail && !privateKey && Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim());

  if (!projectId) {
    console.error("[firebase-admin] project ID is missing from the API runtime.", {
      serviceAccountJsonPresent: Boolean(json),
      clientEmailPresent: Boolean(clientEmail),
      privateKeyPresent: Boolean(rawPrivateKey),
      applicationDefaultPathPresent: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()),
    });
    throw new FirebaseAdminConfigurationError();
  }

  try {
    const credential = useLocalApplicationDefaultCredentials
      ? applicationDefault()
      : clientEmail && privateKey
        ? cert({ projectId, clientEmail, privateKey })
        : null;

    if (!credential) throw new FirebaseAdminConfigurationError();

    return initializeApp(
      {
        credential,
        projectId,
      },
      APP_NAME,
    );
  } catch (error) {
    console.error("[firebase-admin] initialization failed.", {
      projectIdConfigured: Boolean(projectId),
      serviceAccountJsonPresent: Boolean(json),
      clientEmailPresent: Boolean(clientEmail),
      privateKeyPresent: Boolean(rawPrivateKey),
      applicationDefaultCredentialsSelected: useLocalApplicationDefaultCredentials,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof (error as { code?: unknown } | null)?.code === "string"
        ? (error as { code: string }).code
        : undefined,
      errorMessage: error instanceof Error ? error.message : "Unknown initialization error",
    });
    throw new FirebaseAdminConfigurationError();
  }
}

export function getFirebaseAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}

export function getFirebaseAdminFirestore() {
  return getFirestore(getFirebaseAdminApp());
}

export async function verifyAdminRequest(request: {
  headers: { authorization?: string | string[] };
}): Promise<{ uid: string; email: string; token: DecodedIdToken }> {
  const header = request.headers.authorization;

  if (typeof header !== "string") {
    throw new AdminApiAuthError(401, "Authorization required.");
  }

  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new AdminApiAuthError(401, "Invalid authorization header.");
  }

  const auth = getFirebaseAdminAuth();

  let token: DecodedIdToken;

  try {
    token = await auth.verifyIdToken(match[1], true);
  } catch {
    throw new AdminApiAuthError(401, "Invalid or expired session.");
  }

  if (token.admin !== true) {
    throw new AdminApiAuthError(403, "Administrator access required.");
  }

  if (typeof token.email !== "string" || !token.email.trim()) {
    throw new AdminApiAuthError(403, "Administrator email is missing.");
  }

  const user = await auth.getUser(token.uid);

  if (user.disabled) {
    throw new AdminApiAuthError(403, "Administrator account is disabled.");
  }

  return {
    uid: token.uid,
    email: token.email.toLowerCase(),
    token,
  };
}
