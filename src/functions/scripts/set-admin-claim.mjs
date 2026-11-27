import { applicationDefault, initializeApp } from "firebase-admin/app";
import {
  getAuth,
} from "firebase-admin/auth";

const projectId = process.env.FIREBASE_PROJECT_ID;
const adminEmail = String(process.env.ADMIN_EMAIL ?? "")
  .trim()
  .toLowerCase();

if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID must identify your Firebase project.");
}

if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
  throw new Error("Set ADMIN_EMAIL to the real administrator email.");
}

initializeApp({
  credential: applicationDefault(),
  projectId,
});

const auth = getAuth();

async function main() {
  const user = await auth.getUserByEmail(adminEmail);

  // Preserve unrelated existing custom claims.
  await auth.setCustomUserClaims(user.uid, {
    ...(user.customClaims ?? {}),
    admin: true,
    role: "admin",
  });

  console.log("Administrator claim set successfully.");
  console.log("UID:", user.uid);
  console.log("Email:", adminEmail);
  console.log("Sign out and sign in again to refresh the ID token.");
}

main().catch((error) => {
  console.error("Could not set the administrator claim:", error);
  process.exitCode = 1;
});
