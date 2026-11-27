import { getApps, initializeApp } from "firebase/app";
import type { FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import type { Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import type { Functions } from "firebase/functions";
import { getStorage } from "firebase/storage";
import type { FirebaseStorage } from "firebase/storage";

const FIREBASE_PROJECT_ID = "edutrack-academy";
const configuredProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
if (configuredProjectId && configuredProjectId !== FIREBASE_PROJECT_ID) {
  throw new Error(
    `[EduTrack Academy] VITE_FIREBASE_PROJECT_ID must be ${FIREBASE_PROJECT_ID}, not ${configuredProjectId}.`,
  );
}

function requiredEnv(name: string, value: string | undefined): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.startsWith("PASTE_")) {
    throw new Error(
      `[EduTrack Academy] Missing ${name}. Copy the exact value from Firebase Console > Project settings > Your apps > SDK setup and configuration, then restart the dev server.`,
    );
  }
  return normalized;
}

const useFirebaseEmulators =
  import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";

// One Firebase project is used by the entire Academy frontend.
// Never keep a second/legacy Firebase project config in individual pages.
const firebaseConfig = {
  apiKey: requiredEnv("VITE_FIREBASE_API_KEY", import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() ||
    "edutrack-academy.firebaseapp.com",
  projectId: FIREBASE_PROJECT_ID,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() ||
    "edutrack-academy.firebasestorage.app",
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || "943695020079",
  appId: requiredEnv("VITE_FIREBASE_APP_ID", import.meta.env.VITE_FIREBASE_APP_ID),
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID?.trim() || "G-B11J64KV0F",
};

const existingDefaultApp = getApps().find((candidate) => candidate.name === "[DEFAULT]");
if (existingDefaultApp && existingDefaultApp.options.projectId !== FIREBASE_PROJECT_ID) {
  throw new Error(
    `[EduTrack Academy] A Firebase app for ${existingDefaultApp.options.projectId ?? "an unknown project"} is already initialized. Fully stop and restart the dev server after changing Firebase configuration.`,
  );
}

const app: FirebaseApp = existingDefaultApp ?? initializeApp(firebaseConfig);
const auth: Auth = getAuth(app);
const db: Firestore = getFirestore(app);
const functions: Functions = getFunctions(app, "us-central1");
const storage: FirebaseStorage = getStorage(app);

// Emulator mode is explicit opt-in and is never enabled in production builds.
if (useFirebaseEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export { app, auth, db, functions, storage };
export default app;
