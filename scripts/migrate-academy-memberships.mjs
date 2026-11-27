#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const mapIndex = args.indexOf('--mapping-file');
const mappingPath = mapIndex >= 0 ? args[mapIndex + 1] : '';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!mappingPath || mappingPath.startsWith('--')) {
  fail('Usage: node scripts/migrate-academy-memberships.mjs --mapping-file ./academy-legacy-map.json [--apply]');
}

const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || '';
const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || '';
let serviceAccount = {};
if (rawServiceAccount) {
  try { serviceAccount = JSON.parse(rawServiceAccount); }
  catch { fail('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
}
const resolvedProjectId = projectId || serviceAccount.project_id || '';
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || serviceAccount.client_email || '';
const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || serviceAccount.private_key || '').replace(/\\n/g, '\n');
let credential;
if (clientEmail && privateKey) credential = cert({ projectId: resolvedProjectId, clientEmail, privateKey });
else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) credential = applicationDefault();
else fail('Configure the existing Firebase Admin credentials (service-account JSON or GOOGLE_APPLICATION_CREDENTIALS).');
if (!resolvedProjectId) fail('FIREBASE_PROJECT_ID or service-account project_id is required.');

const app = getApps().find((item) => item.name === 'edutrack-academy-membership-migration') || initializeApp({ credential, projectId: resolvedProjectId }, 'edutrack-academy-membership-migration');
const auth = getAuth(app);
const db = getFirestore(app);

let entries;
try {
  entries = JSON.parse(await readFile(resolve(mappingPath), 'utf8'));
} catch {
  fail(`Could not read mapping JSON: ${mappingPath}`);
}
if (!Array.isArray(entries) || entries.length === 0) fail('Mapping file must contain a non-empty JSON array.');

const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const normalizeAcademyId = (value) => {
  const candidate = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{3,15}$/.test(candidate) && Number(candidate) >= 100 && Number.isSafeInteger(Number(candidate)) ? String(Number(candidate)) : '';
};
const seenEmails = new Set();
const plans = [];

for (let index = 0; index < entries.length; index += 1) {
  const entry = entries[index];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`Mapping row ${index + 1} must be an object.`);
  const email = normalizeEmail(entry.email);
  const academyId = normalizeAcademyId(entry.academyId);
  if (!email || !email.includes('@') || email.includes('/') || email.includes('\\') || /\s/.test(email)) fail(`Mapping row ${index + 1} has an invalid email.`);
  if (!academyId) fail(`Mapping row ${index + 1} has an invalid Academy ID (minimum 100, numeric only).`);
  if (seenEmails.has(email)) fail(`Duplicate email in mapping file: ${email}`);
  seenEmails.add(email);

  let authUser;
  try { authUser = await auth.getUserByEmail(email); }
  catch { plans.push({ email, academyId, action: 'BLOCKED', reason: 'Firebase Auth user not found.' }); continue; }

  const profileRef = db.collection('users').doc(email);
  const academyRef = db.collection('academies').doc(academyId);
  const memberRef = academyRef.collection('members').doc(authUser.uid);
  const mappingRef = db.collection('academyMemberships').doc(authUser.uid);
  const [profileSnap, academySnap, memberSnap, mappingSnap] = await Promise.all([
    profileRef.get(), academyRef.get(), memberRef.get(), mappingRef.get(),
  ]);
  const profile = profileSnap.data();
  const academy = academySnap.data();
  const member = memberSnap.data();
  const mapping = mappingSnap.data();

  if (authUser.disabled || normalizeEmail(authUser.email) !== email) {
    plans.push({ email, academyId, action: 'BLOCKED', reason: 'Auth account is disabled or email does not match.' });
  } else if (!profileSnap.exists || profile?.role !== 'teacher' || profile?.active !== true || profile.uid !== authUser.uid || normalizeEmail(profile.email) !== email) {
    plans.push({ email, academyId, action: 'BLOCKED', reason: 'No matching active legacy teacher workspace exists.' });
  } else if (!academySnap.exists || academy?.academyId !== academyId || academy.status !== 'active') {
    plans.push({ email, academyId, action: 'BLOCKED', reason: 'Target Academy is missing or not active.' });
  } else if (mappingSnap.exists || memberSnap.exists) {
    const alreadyMapped = mapping?.academyId === academyId && mapping?.role === 'teacher' && normalizeEmail(mapping?.email) === email && mapping?.active === (authUser.emailVerified === true) && member?.academyId === academyId && member?.role === 'teacher' && member?.uid === authUser.uid && normalizeEmail(member?.email) === email && member?.active === (authUser.emailVerified === true);
    plans.push({ email, academyId, action: alreadyMapped ? 'NO-OP' : 'BLOCKED', reason: alreadyMapped ? 'The same mapping already exists.' : 'A conflicting membership already exists.' });
  } else if (profile.academyId && profile.academyId !== academyId) {
    plans.push({ email, academyId, action: 'BLOCKED', reason: 'Teacher workspace already names a different Academy.' });
  } else {
    plans.push({ email, academyId, uid: authUser.uid, emailVerified: authUser.emailVerified === true, action: 'APPLY', reason: authUser.emailVerified ? 'Will create an active teacher membership.' : 'Will create a pending membership until Firebase email verification.' });
  }
}

console.log(`Firebase project: ${resolvedProjectId}`);
console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
for (const plan of plans) console.log(`${plan.action.padEnd(7)} Academy ${plan.academyId} | ${plan.email} | ${plan.reason}`);
const blocked = plans.filter((plan) => plan.action === 'BLOCKED');
if (blocked.length) {
  console.error(`\n${blocked.length} row(s) are blocked. No changes were applied for blocked rows.`);
  if (!apply) process.exitCode = 2;
}

if (!apply) {
  console.log('\nDry run only. Review the mapping and rerun with --apply to write eligible rows.');
  process.exit();
}

for (const plan of plans.filter((item) => item.action === 'APPLY')) {
  const profileRef = db.collection('users').doc(plan.email);
  const academyRef = db.collection('academies').doc(plan.academyId);
  const memberRef = academyRef.collection('members').doc(plan.uid);
  const mappingRef = db.collection('academyMemberships').doc(plan.uid);
  await db.runTransaction(async (transaction) => {
    const [profileSnap, academySnap, memberSnap, mappingSnap] = await Promise.all([
      transaction.get(profileRef), transaction.get(academyRef), transaction.get(memberRef), transaction.get(mappingRef),
    ]);
    const profile = profileSnap.data() || {};
    const academy = academySnap.data() || {};
    if (!profileSnap.exists || profile.uid !== plan.uid || normalizeEmail(profile.email) !== plan.email || profile.role !== 'teacher' || profile.active !== true) {
      throw new Error(`Revalidation failed for ${plan.email}: teacher profile changed after dry-run.`);
    }
    if (!academySnap.exists || academy.academyId !== plan.academyId || academy.status !== 'active') {
      throw new Error(`Revalidation failed for ${plan.email}: target Academy is no longer active.`);
    }
    if (memberSnap.exists || mappingSnap.exists) {
      const member = memberSnap.data() || {};
      const mapping = mappingSnap.data() || {};
      if (member.academyId === plan.academyId && member.role === 'teacher' && mapping.academyId === plan.academyId && mapping.role === 'teacher') return;
      throw new Error(`Conflict detected while applying ${plan.email}; existing membership was not overwritten.`);
    }
    if (profile.academyId && profile.academyId !== plan.academyId) throw new Error(`Profile Academy ID conflict for ${plan.email}.`);
    const active = plan.emailVerified === true;
    const status = active ? 'active' : 'pending_email_verification';
    const timestamp = FieldValue.serverTimestamp();
    transaction.create(memberRef, {
      uid: plan.uid, email: plan.email, academyId: plan.academyId, role: 'teacher',
      active, emailVerified: active, status, createdAt: timestamp, createdByUid: 'manual-legacy-migration',
      displayName: String(profile.teacherName || profile.name || 'Teacher'),
      contactPhone: String(profile.whatsappNumber || ''),
    });
    transaction.create(mappingRef, {
      uid: plan.uid, academyId: plan.academyId, email: plan.email, role: 'teacher', active,
      emailVerified: active, status, createdAt: timestamp, updatedAt: timestamp,
    });
    transaction.update(profileRef, { academyId: plan.academyId, emailVerified: active, updatedAt: new Date().toISOString() });
  });
  console.log(`APPLIED Academy ${plan.academyId} | ${plan.email}`);
}

console.log('\nMigration finished. Review pending email verification rows separately. No teacher workspace subcollections were moved.');
