'use strict';

const { applicationDefault, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const EXPECTED_ADMIN_EMAIL = 'aliupwork243715@gmail.com';
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

async function main() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new Error(
      'Set FIREBASE_PROJECT_ID to the exact Firebase project ID before running this script.'
    );
  }

  initializeApp({
    credential: applicationDefault(),
    projectId,
  });

  const auth = getAuth();

  // Resolve the existing user from Firebase Auth. This script never creates users.
  const user = await auth.getUserByEmail(EXPECTED_ADMIN_EMAIL);

  if (normalizeEmail(user.email) !== EXPECTED_ADMIN_EMAIL) {
    throw new Error('Resolved Firebase account email does not match the expected administrator email.');
  }

  if (user.disabled) {
    throw new Error('The existing Firebase account is disabled. Enable/review it in Firebase Console first.');
  }

  // Preserve all existing custom claims; only set admin=true for this verified UID.
  const existingClaims = user.customClaims ?? {};
  await auth.setCustomUserClaims(user.uid, {
    ...existingClaims,
    admin: true,
  });

  const updatedUser = await auth.getUser(user.uid);
  if (
    normalizeEmail(updatedUser.email) !== EXPECTED_ADMIN_EMAIL ||
    updatedUser.customClaims?.admin !== true
  ) {
    throw new Error('Post-update verification failed. The admin claim was not confirmed.');
  }

  console.log('Success: admin custom claim assigned and verified.');
  console.log(`Project ID: ${projectId}`);
  console.log(`Existing account email: ${updatedUser.email}`);
  console.log(`Resolved Firebase UID: ${updatedUser.uid}`);
  console.log('Claim: admin=true');
  console.log('No Firebase user was created.');
}

main().catch((error) => {
  console.error(`Admin-claim setup failed: ${error?.message ?? 'Unknown error'}`);
  process.exitCode = 1;
});
