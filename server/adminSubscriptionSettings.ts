import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { normalizePaymentMethods, validatePaymentMethods } from './subscriptionPaymentMethods.mjs';
import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
  verifyAdminRequest,
} from './firebaseAdmin.js';

export type SubscriptionSettingsRequest = {
  method?: string;
  headers: { authorization?: string | string[]; [key: string]: string | string[] | undefined };
  body?: unknown;
};
export type SubscriptionSettingsResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): SubscriptionSettingsResponse;
  json(data: unknown): SubscriptionSettingsResponse;
};

export class SubscriptionSettingsError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'SubscriptionSettingsError'; }
}
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalizeEmail = (value: unknown) => clean(value).toLowerCase();

async function getContext(request: SubscriptionSettingsRequest) {
  const actor = await verifyAdminRequest(request as Parameters<typeof verifyAdminRequest>[0]);
  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminFirestore();
  const user = await auth.getUser(actor.uid);
  const email = normalizeEmail(user.email);
  if (!email || email !== normalizeEmail(actor.email) || user.disabled) {
    throw new SubscriptionSettingsError(403, 'Administrator account verification failed.');
  }
  const root = db.collection('admins').doc(email);
  const snapshot = await root.get();
  const data = snapshot.data() ?? {};
  if (clean(data.adminUid) && clean(data.adminUid) !== actor.uid) {
    throw new SubscriptionSettingsError(403, 'This administrator workspace belongs to another account.');
  }
  if (!snapshot.exists || !clean(data.adminUid)) {
    await root.set({
      adminUid: actor.uid,
      email,
      managementSchemaVersion: 1,
      createdAt: data.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return { uid: actor.uid, email, root, db };
}

export async function getAdminSubscriptionSettings(request: SubscriptionSettingsRequest) {
  const context = await getContext(request);
  const snapshot = await context.root.collection('subscriptionSettings').doc('general').get();
  const data = snapshot.data() ?? {};
  return { success: true, paymentInstructions: clean(data.paymentInstructions), paymentMethods: normalizePaymentMethods(data.paymentMethods), allowUnassignedFullAccess: data.allowUnassignedFullAccess !== false, defaultFeatureVisibilityMode: clean(data.defaultFeatureVisibilityMode) === 'locked' ? 'locked' : 'hide' };
}

export async function saveAdminSubscriptionSettings(request: SubscriptionSettingsRequest) {
  const context = await getContext(request);
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new SubscriptionSettingsError(400, 'A valid JSON request body is required.');
  }
  const body = request.body as Record<string, unknown>;
  const value = body.paymentInstructions;
  if (typeof value !== 'string' || value.trim().length > 5000) {
    throw new SubscriptionSettingsError(400, 'Payment instructions must be text up to 5,000 characters.');
  }
  if (body.allowUnassignedFullAccess !== undefined && typeof body.allowUnassignedFullAccess !== 'boolean') {
    throw new SubscriptionSettingsError(400, 'Unassigned full-access policy must be true or false.');
  }
  if (body.defaultFeatureVisibilityMode !== undefined && !['hide', 'locked'].includes(String(body.defaultFeatureVisibilityMode))) {
    throw new SubscriptionSettingsError(400, 'Feature visibility mode must be hide or locked.');
  }
  const settingsRef = context.root.collection('subscriptionSettings').doc('general');
  const previousSettingsSnapshot = await settingsRef.get();
  const previousAllowFullAccess = (previousSettingsSnapshot.data() ?? {}).allowUnassignedFullAccess !== false;
  const paymentInstructions = value.trim();
  const patch: Record<string, unknown> = {
    paymentInstructions,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: context.uid,
  };
  let savedPaymentMethods: ReturnType<typeof normalizePaymentMethods> | undefined;
  if (body.paymentMethods !== undefined) {
    const validation = validatePaymentMethods(body.paymentMethods);
    if (validation.valid === false) throw new SubscriptionSettingsError(400, validation.error);
    savedPaymentMethods = validation.paymentMethods;
    patch.paymentMethods = savedPaymentMethods;
  }
  if (body.allowUnassignedFullAccess !== undefined) patch.allowUnassignedFullAccess = body.allowUnassignedFullAccess;
  if (body.defaultFeatureVisibilityMode !== undefined) patch.defaultFeatureVisibilityMode = body.defaultFeatureVisibilityMode;
  await settingsRef.set(patch, { merge: true });

  // The previous scheduler re-evaluated unassigned-full-access teachers every minute.
  // Preserve that policy-change behaviour without recurring scans: only when this policy
  // actually changes, mark the affected existing customer registries for one due refresh.
  if (body.allowUnassignedFullAccess !== undefined && body.allowUnassignedFullAccess !== previousAllowFullAccess) {
    const accountSnapshot = await context.root.collection('subscriptionAccounts')
      .where('accessMode', '==', 'unassigned_full_access').get();
    const registryRefs = accountSnapshot.docs
      .filter((doc) => doc.data().fullAccessGranted === true)
      .map((doc) => context.root.collection('customers').doc(doc.id));
    const registrySnapshots = await Promise.all(registryRefs.map((ref) => ref.get()));
    const existingRefs = registrySnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => snapshot.ref);
    for (let offset = 0; offset < existingRefs.length; offset += 450) {
      const batch = context.db.batch();
      for (const ref of existingRefs.slice(offset, offset + 450)) {
        batch.set(ref, { projectionNextRefreshAt: Timestamp.now() }, { merge: true });
      }
      await batch.commit();
    }
  }
  return { success: true, paymentInstructions, ...(savedPaymentMethods ? { paymentMethods: savedPaymentMethods } : {}), allowUnassignedFullAccess: body.allowUnassignedFullAccess !== false, defaultFeatureVisibilityMode: body.defaultFeatureVisibilityMode === 'locked' ? 'locked' : 'hide' };
}

export function sendSubscriptionSettingsError(response: SubscriptionSettingsResponse, error: unknown) {
  const statusValue = Number((error as { status?: unknown })?.status);
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : 500;
  const message = status >= 500 ? 'The subscription settings service could not complete the request.' : error instanceof Error ? error.message : 'The request is invalid.';
  response.setHeader('Cache-Control', 'no-store');
  return response.status(status).json({ success: false, error: message });
}
