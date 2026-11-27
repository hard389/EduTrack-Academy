/**
 * EduTrack Cloudflare Worker API for a private Cloudflare R2 bucket.
 * Required R2 binding: EDUTRACK_BUCKET -> edutrack-academy-library
 * Required Worker variables:
 *   FIREBASE_PROJECT_ID = Firebase project ID (same project as Auth + Firestore)
 *   FIREBASE_API_KEY    = Web API key from the shared Firebase project config
 *   APP_ORIGINS         = comma-separated frontend origins, e.g. https://your-app.example,https://your-preview.example,http://localhost:5173
 *
 * Public sharing is intentionally “anyone with the unguessable link can access”.
 * R2 itself remains private; all object access goes through this Worker.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_STUDENT_IMAGE_BYTES = 5 * 1024 * 1024;
const PROFILE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const STUDENT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_STORAGE_QUOTA_BYTES = 1 * 1024 * 1024 * 1024;
const LEGACY_DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_R2_USAGE_LIST_PAGES = 100;
const ALLOWED_FILES = {
  pdf:  { mimeType: 'application/pdf', fileType: 'pdf' },
  doc:  { mimeType: 'application/msword', fileType: 'doc' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileType: 'doc' },
  png:  { mimeType: 'image/png', fileType: 'image' },
  jpg:  { mimeType: 'image/jpeg', fileType: 'image' },
  jpeg: { mimeType: 'image/jpeg', fileType: 'image' },
};
const ALLOWED_CATEGORIES = new Set(['Notes', 'Textbooks', 'Past Papers', 'Assignments']);
// ---------------------------------------------------------------------------
// Performance instrumentation
//
// Every timed block below uses this tiny helper. It never logs tokens, image
// bytes, passwords or other personal data — only route name, step name,
// duration in milliseconds, and (for the request-level summary) the outcome
// status code. Timings are collected per-request in an array and flushed as
// ONE structured console.log line at the end of each profile-image request,
// so Worker logs stay grep-able instead of scattered across many lines.
// ---------------------------------------------------------------------------
function createTimer() {
  const steps = [];
  return {
    async time(step, fn) {
      const start = Date.now();
      try {
        const result = await fn();
        steps.push({ step, ms: Date.now() - start, ok: true });
        return result;
      } catch (error) {
        steps.push({ step, ms: Date.now() - start, ok: false });
        throw error;
      }
    },
    mark(step, startedAtMs) {
      steps.push({ step, ms: Date.now() - startedAtMs, ok: true });
    },
    steps,
  };
}
function logRequestTimings(route, timer, requestStartedAtMs, status) {
// Structured, single-line, privacy-conscious: no Authorization header, no
// ID token, no file bytes, no email/uid beyond what the route already logs
// elsewhere on error. This line is for latency triage only.
  console.log(JSON.stringify({
    kind: 'perf',
    route,
    status,
    totalMs: Date.now() - requestStartedAtMs,
    steps: timer.steps,
  }));
}
function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}
function allowedOrigins(env) {
  return [...new Set(String(env.APP_ORIGINS || '')
    .split(',')
    .map((value) => normalizeOrigin(value))
    .filter(Boolean))];
}
function corsHeaders(request, env, publicRead = false) {
  const headers = new Headers();
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  if (publicRead) {
// This route deliberately serves link-shared files without cookies or credentials.
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(normalizeOrigin(origin))) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}
function json(request, env, data, status = 200, publicRead = false) {
  const headers = corsHeaders(request, env, publicRead);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers });
}
function errorResponse(request, env, message, status = 400, publicRead = false) {
  return json(request, env, { ok: false, error: message }, status, publicRead);
}
function safeFileName(input) {
  const basename = String(input || 'download').split(/[\\/]/).pop() || 'download';
  return basename
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'download';
}
function validResourceId(value) {
  return /^res-[A-Za-z0-9-]{8,150}$/.test(value);
}
function validClassId(value) {
  return Boolean(value) && value.length <= 150 && !value.includes('/') && value !== '.' && value !== '..';
}
function contentDisposition(fileName, mimeType) {
  const inline = mimeType === 'application/pdf' || mimeType === 'image/png' || mimeType === 'image/jpeg';
  const fallback = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'download';
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
function firestoreDocumentUrl(projectId, documentPath) {
  const path = documentPath.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`;
}
async function getFirestoreDocument(env, idToken, documentPath) {
  const response = await fetch(firestoreDocumentUrl(env.FIREBASE_PROJECT_ID, documentPath), {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
// A Firestore 401/403 here means the ID token or Firestore rules did not permit the read.
    throw new Error(response.status === 401 || response.status === 403
      ? 'Firebase denied access to the teacher profile or selected class.'
      : `Firestore validation request failed (${response.status}).`);
  }
  return response.json();
}
function firestoreField(document, name) {
  const field = document?.fields?.[name];
  if (!field) return undefined;
  if (Object.prototype.hasOwnProperty.call(field, 'stringValue')) return field.stringValue;
  if (Object.prototype.hasOwnProperty.call(field, 'booleanValue')) return field.booleanValue;
  if (Object.prototype.hasOwnProperty.call(field, 'integerValue')) return Number(field.integerValue);
  if (Object.prototype.hasOwnProperty.call(field, 'doubleValue')) return Number(field.doubleValue);
  return undefined;
}
async function authenticateTeacher(request, env) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    throw new Error('Worker configuration is incomplete. Set FIREBASE_PROJECT_ID and FIREBASE_API_KEY.');
  }
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Missing Firebase ID token. Please sign in again.');
  const idToken = match[1].trim();
// Firebase Identity Toolkit validates the ID token and returns its canonical UID/email.
  const identityResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!identityResponse.ok) throw new Error('Firebase session is invalid or expired. Please sign in again.');
  const identityData = await identityResponse.json();
  const identity = identityData.users?.[0];
  const uid = String(identity?.localId || '');
  const email = String(identity?.email || '').trim().toLowerCase();
  if (!uid || !email || email.includes('/')) throw new Error('The signed-in account has no usable email address.');
// These REST reads use the Firebase ID token, so Firestore Security Rules still apply.
  const profile = await getFirestoreDocument(env, idToken, `users/${email}`);
  if (!profile) throw new Error('Teacher profile was not found.');
  const profileUid = firestoreField(profile, 'uid');
  const profileEmail = String(firestoreField(profile, 'email') || '').trim().toLowerCase();
  const role = firestoreField(profile, 'role');
  const active = firestoreField(profile, 'active');
  const disabled = firestoreField(profile, 'disabled');
  const deleted = firestoreField(profile, 'deleted');
  if (profileUid !== uid || profileEmail !== email) throw new Error('Teacher profile ownership could not be verified.');
  if (role !== 'teacher' || active !== true || disabled === true || deleted === true) {
    throw new Error('This account is not an active, authorized teacher.');
  }
  return { uid, email, idToken };
}
// Timed variant used only by the registration profile-image routes, which are on the critical
// path a new user is actively waiting on. `timer` is optional so this function stays usable by
// any future caller that does not care about per-step timings.
async function authenticateFirebaseIdentity(request, env, timer) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    throw new Error('Worker configuration is incomplete. Set FIREBASE_PROJECT_ID and FIREBASE_API_KEY.');
  }
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Missing Firebase ID token. Please sign in again.');
  const idToken = match[1].trim();
  const lookup = async () => fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  );
  const identityResponse = timer ? await timer.time('identity_toolkit_lookup', lookup) : await lookup();
  if (!identityResponse.ok) throw new Error('Firebase session is invalid or expired. Please sign in again.');
  const identityData = await identityResponse.json();
  const identity = identityData.users?.[0];
  const uid = String(identity?.localId || '');
  const email = String(identity?.email || '').trim().toLowerCase();
  if (!uid || !email || email.includes('/')) throw new Error('The signed-in account has no usable email address.');
  return { uid, email, idToken };
}
async function uploadRegistrationProfileImage(request, env) {
  const requestStartedAtMs = Date.now();
  const timer = createTimer();
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
    const response = errorResponse(request, env, 'This website origin is not allowed to upload profile images.', 403);
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 403);
    return response;
  }
  let identity;
  try {
    identity = await authenticateFirebaseIdentity(request, env, timer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify Firebase account.';
    const status = errorStatus(message);
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, status);
    return errorResponse(request, env, message, status);
  }
  let form;
  try { form = await timer.time('parse_form_data', () => request.formData()); }
  catch {
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 400);
    return errorResponse(request, env, 'Expected multipart form data with an image file.', 400);
  }
  const file = form.get('file');
  if (!file || typeof file.stream !== 'function' || typeof file.size !== 'number') {
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 400);
    return errorResponse(request, env, 'No valid profile image was provided.', 400);
  }
  if (file.size <= 0) {
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 400);
    return errorResponse(request, env, 'The selected profile image is empty.', 400);
  }
  if (file.size > MAX_PROFILE_IMAGE_BYTES) {
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 413);
    return errorResponse(request, env, 'Profile images must be 5 MB or smaller.', 413);
  }
  const mimeType = String(file.type || '').toLowerCase().trim();
  if (!PROFILE_IMAGE_MIME_TYPES.has(mimeType)) {
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 415);
    return errorResponse(request, env, 'Unsupported profile image. Use JPEG, PNG, or WebP.', 415);
  }
// Fixed per-UID key makes retries idempotent and prevents unbounded orphan objects.
// A caller can only write to the key derived from the UID in their validated Firebase token.
//
// PERFORMANCE NOTE (pre-put ownership head() removed):
// The original code did a `head()` on this key before every upload to check for an
// ownerUid mismatch. That check can only ever trip for data that predates this
// ownerUid-tagging scheme, because the key itself already embeds the token-verified UID
// (`profile-images/${identity.uid}/avatar`) — nobody can write to another UID's key, since
// the UID comes from Firebase's own token verification above, not from client input. So for
// every normal registration this call was a full round trip that could never find a conflict.
// It is removed here. `put()` below still unconditionally re-tags the object with the
// correct ownerUid/kind, so even a hypothetical legacy object at this exact path is safely
// relabeled rather than silently trusted.
  let saved;
  try {
    saved = await timer.time('r2_put', () => env.EDUTRACK_BUCKET.put(`profile-images/${identity.uid}/avatar`, file.stream(), {
      httpMetadata: {
        contentType: mimeType,
        contentDisposition: 'inline',
        cacheControl: 'public, max-age=300',
      },
      customMetadata: {
        ownerUid: identity.uid,
        tenantEmail: identity.email,
        kind: 'teacher-profile-image',
        fileName: safeFileName(file.name || 'profile-image'),
      },
    }));
  } catch (error) {
    console.error('R2 put failed for registration profile image:', error);
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 503);
    return errorResponse(request, env, 'Cloudflare could not save the profile image. Retry registration.', 503);
  }
// PERFORMANCE NOTE (post-put confirmation head() removed):
// The original code called `head()` again after `put()` purely to re-read back the metadata
// it had just written, to confirm the save. R2 writes are strongly consistent, and `put()`
// already returns the stored R2Object (including size, etag and the customMetadata that was
// just set) on success — a thrown error means the write did not happen. Re-reading the same
// metadata via a second network round trip adds latency without adding any extra guarantee,
// so the confirmation below now uses the object `put()` already handed back instead of
// re-fetching it.
  if (!saved || String(saved.customMetadata?.ownerUid || '') !== identity.uid ||
      String(saved.customMetadata?.kind || '') !== 'teacher-profile-image') {
    logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 503);
    return errorResponse(request, env, 'Cloudflare did not confirm the saved profile image. Retry registration.', 503);
  }
  const imageUrl = new URL(`/profile-images/${encodeURIComponent(identity.uid)}?v=${Date.now()}`, request.url).toString();
  const response = json(request, env, { ok: true, uid: identity.uid, profileImageUrl: imageUrl });
  logRequestTimings('POST /api/register/profile-image', timer, requestStartedAtMs, 200);
  return response;
}
async function deleteRegistrationProfileImage(request, env) {
  const requestStartedAtMs = Date.now();
  const timer = createTimer();
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
    logRequestTimings('DELETE /api/register/profile-image', timer, requestStartedAtMs, 403);
    return errorResponse(
      request,
      env,
      'This website origin is not allowed to delete profile images.',
      403
    );
  }
  let identity;
  try {
    identity = await authenticateFirebaseIdentity(request, env, timer);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'Could not verify Firebase account.';
    const status = errorStatus(message);
    logRequestTimings('DELETE /api/register/profile-image', timer, requestStartedAtMs, status);
    return errorResponse(request, env, message, status);
  }
  const key = `profile-images/${identity.uid}/avatar`;
  const object = await timer.time('r2_head_before_delete', () => env.EDUTRACK_BUCKET.head(key));
  if (!object) {
    const response = json(request, env, {
      ok: true,
      deleted: false,
      alreadyMissing: true,
    });
    logRequestTimings('DELETE /api/register/profile-image', timer, requestStartedAtMs, 200);
    return response;
  }
  const metadata = object.customMetadata || {};
  const ownerUid = String(metadata.ownerUid || '').trim();
  const tenantEmail = String(metadata.tenantEmail || '').trim().toLowerCase();
  if (
    ownerUid !== identity.uid ||
    (tenantEmail && tenantEmail !== identity.email) ||
    metadata.kind !== 'teacher-profile-image'
  ) {
    logRequestTimings('DELETE /api/register/profile-image', timer, requestStartedAtMs, 403);
    return errorResponse(
      request,
      env,
      'Profile image ownership could not be verified; cleanup was blocked.',
      403
    );
  }
// This delete path only runs during failure-recovery cleanup, never on the happy path a
// registering user waits on, so it keeps its post-delete confirmation head() for maximum
// certainty that the orphaned object is actually gone (unlike put(), delete() does not hand
// back the object state to confirm from, so a verifying read is the only way to confirm).
  await timer.time('r2_delete', () => env.EDUTRACK_BUCKET.delete(key));
  const remaining = await timer.time('r2_head_after_delete', () => env.EDUTRACK_BUCKET.head(key));
  if (remaining) {
    logRequestTimings('DELETE /api/register/profile-image', timer, requestStartedAtMs, 503);
    return errorResponse(
      request,
      env,
      'Cloudflare did not confirm profile image deletion. Retry cleanup.',
      503
    );
  }
  const response = json(request, env, { ok: true, deleted: true, alreadyMissing: false });
  logRequestTimings('DELETE /api/register/profile-image', timer, requestStartedAtMs, 200);
  return response;
}
async function serveProfileImage(request, env, uid) {
  if (!/^[A-Za-z0-9_-]{5,128}$/.test(uid)) {
    return errorResponse(request, env, 'Invalid profile image URL.', 404, true);
  }
  const object = await env.EDUTRACK_BUCKET.get(`profile-images/${uid}/avatar`);
  if (!object) return errorResponse(request, env, 'Profile image was not found.', 404, true);
  const metadata = object.customMetadata || {};
  const mimeType = String(object.httpMetadata?.contentType || '').toLowerCase();
  if (metadata.ownerUid !== uid || metadata.kind !== 'teacher-profile-image' || !PROFILE_IMAGE_MIME_TYPES.has(mimeType)) {
    return errorResponse(request, env, 'Profile image metadata is invalid.', 404, true);
  }
  const headers = corsHeaders(request, env, true);
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', mimeType);
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Length', String(object.size));
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
async function uploadStudentImage(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
    return errorResponse(request, env, 'This website origin is not allowed to upload student images.', 403);
  }
  let form;
  try { form = await request.formData(); }
  catch { return errorResponse(request, env, 'Expected multipart form data containing classId and file.', 400); }
  const classId = String(form.get('classId') || '').trim();
  const file = form.get('file');
  if (!file || typeof file.stream !== 'function' || typeof file.size !== 'number') {
    return errorResponse(request, env, 'No valid student image was provided.', 400);
  }
  if (file.size <= 0) return errorResponse(request, env, 'The selected student image is empty.', 400);
  if (file.size > MAX_STUDENT_IMAGE_BYTES) {
    return errorResponse(request, env, 'Student images must be 5 MB or smaller.', 413);
  }
  const mimeType = String(file.type || '').toLowerCase().trim();
  if (!STUDENT_IMAGE_MIME_TYPES.has(mimeType)) {
    return errorResponse(request, env, 'Unsupported student image. Use JPEG, PNG, or WebP.', 415);
  }
  let teacher;
  try { teacher = await authorizeTeacher(request, env, classId); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify teacher/class access.';
    return errorResponse(request, env, message, errorStatus(message));
  }
// Enforce the same teacher storage quota on student photos as on Notes/Library objects.
  let usage;
  try { usage = await getVerifiedStorageSnapshot(env, teacher); }
  catch (error) {
    console.error('Could not verify teacher storage before student image upload.', {
      tenantEmail: teacher.email,
      reason: error instanceof Error ? error.message : 'Unknown storage verification error',
    });
    return errorResponse(request, env, 'Storage quota could not be verified. Student photo upload was blocked for safety.', 503);
  }
  if (usage.usedBytes + file.size > usage.allocatedQuotaBytes) {
    return json(request, env, {
      ok: false,
      error: 'Storage quota exceeded. Request additional storage before uploading this student photo.',
      usedBytes: usage.usedBytes,
      projectedUsedBytes: usage.usedBytes + file.size,
      allocatedQuotaBytes: usage.allocatedQuotaBytes,
      availableBytes: usage.availableBytes,
    }, 413);
  }
// A random ID makes the image URL hard to guess. The URL is link-accessible, like the app's
// existing note share links; do not put confidential images here if link-only access is unsuitable.
  const imageId = `stuimg-${crypto.randomUUID()}`;
  const key = `student-images/${teacher.uid}/${classId}/${imageId}`;
  const putResult = await env.EDUTRACK_BUCKET.put(key, imageBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: 'inline',
      cacheControl: 'public, max-age=300',
    },
    customMetadata: {
      ownerUid: teacher.uid,
      tenantEmail: teacher.email,
      classId,
      imageId,
      kind: 'student-image',
      fileName: safeFileName(file.name || 'student-image'),
    },
  });
  if (!putResult) {
    const error = new Error('A screenshot already exists for this invoice upload. Submit it for review or contact the administrator.');
    error.status = 409;
    throw error;
  }
  const saved = await env.EDUTRACK_BUCKET.head(key);
  const metadata = saved?.customMetadata || {};
  if (!saved || metadata.ownerUid !== teacher.uid || metadata.classId !== classId ||
      metadata.imageId !== imageId || metadata.kind !== 'student-image') {
    return errorResponse(request, env, 'Cloudflare did not confirm the student image. Please retry.', 503);
  }
  const studentImageUrl = new URL(
    `/student-images/${encodeURIComponent(teacher.uid)}/${encodeURIComponent(classId)}/${encodeURIComponent(imageId)}`,
    request.url,
  ).toString();
  return json(request, env, { ok: true, uid: teacher.uid, classId, imageId, studentImageUrl });
}
async function serveStudentImage(request, env, uid, classId, imageId) {
  if (!/^[A-Za-z0-9_-]{5,128}$/.test(uid) || !validClassId(classId) ||
      !/^stuimg-[A-Za-z0-9-]{20,100}$/.test(imageId)) {
    return errorResponse(request, env, 'Invalid student image URL.', 404, true);
  }
  const key = `student-images/${uid}/${classId}/${imageId}`;
  const object = await env.EDUTRACK_BUCKET.get(key);
  if (!object) return errorResponse(request, env, 'Student image was not found.', 404, true);
  const metadata = object.customMetadata || {};
  const mimeType = String(object.httpMetadata?.contentType || '').toLowerCase();
  if (metadata.ownerUid !== uid || metadata.classId !== classId || metadata.imageId !== imageId ||
      metadata.kind !== 'student-image' || !STUDENT_IMAGE_MIME_TYPES.has(mimeType)) {
    return errorResponse(request, env, 'Student image metadata is invalid.', 404, true);
  }
  const headers = corsHeaders(request, env, true);
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', mimeType);
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Length', String(object.size));
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
async function deleteStudentImage(request, env, imageId) {
  if (!/^stuimg-[A-Za-z0-9-]{20,100}$/.test(imageId)) {
    return errorResponse(request, env, 'Invalid student image ID.', 400);
  }
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
    return errorResponse(request, env, 'This website origin is not allowed to delete student images.', 403);
  }
  let body;
  try { body = await request.json(); }
  catch { return errorResponse(request, env, 'Expected JSON containing classId.', 400); }
  const classId = String(body?.classId || '').trim();
  let teacher;
  try { teacher = await authorizeTeacher(request, env, classId); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify teacher/class access.';
    return errorResponse(request, env, message, errorStatus(message));
  }
  const key = `student-images/${teacher.uid}/${classId}/${imageId}`;
  const object = await env.EDUTRACK_BUCKET.head(key);
  if (!object) return json(request, env, { ok: true, deleted: false, alreadyMissing: true });
  const metadata = object.customMetadata || {};
  if (metadata.ownerUid !== teacher.uid || metadata.classId !== classId || metadata.imageId !== imageId || metadata.kind !== 'student-image') {
    return errorResponse(request, env, 'You are not authorized to delete this student image.', 403);
  }
  await env.EDUTRACK_BUCKET.delete(key);
  const remaining = await env.EDUTRACK_BUCKET.head(key);
  if (remaining) return errorResponse(request, env, 'Cloudflare did not confirm student image deletion. Please retry.', 503);
  return json(request, env, { ok: true, deleted: true });
}
async function authorizeTeacher(request, env, classId) {
  if (!validClassId(classId)) throw new Error('Invalid class ID.');
  const teacher = await authenticateTeacher(request, env);
  const classDocument = await getFirestoreDocument(env, teacher.idToken, `users/${teacher.email}/classes/${classId}`);
  if (!classDocument) throw new Error('The selected class does not exist or is not accessible.');
  return { ...teacher, classId };
}
function errorStatus(message) {
  if (/missing firebase id token|invalid or expired/i.test(message)) return 401;
  if (/denied|not an active|ownership|not found|not accessible/i.test(message)) return 403;
  if (/configuration is incomplete/i.test(message)) return 500;
  return 400;
}
function firestoreNumber(document, name) {
  const value = firestoreField(document, name);
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}
async function getTeacherQuota(env, teacher) {
// The same signed-in teacher token reads only this teacher's own quota document.
  const usageDocument = await getFirestoreDocument(
    env,
    teacher.idToken,
    `users/${teacher.email}/storage/usage`,
  );
  if (!usageDocument) {
    return {
      defaultQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      additionalGrantedBytes: 0,
      allocatedQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
    };
  }
  const ownerUid = firestoreField(usageDocument, 'ownerUid');
  if (typeof ownerUid === 'string' && ownerUid && ownerUid !== teacher.uid) {
    throw new Error('Storage quota owner does not match the signed-in teacher.');
  }
  const storedDefault = firestoreNumber(usageDocument, 'defaultQuotaBytes');
  const extraValue = firestoreNumber(usageDocument, 'additionalGrantedBytes');
  const storedExtra = extraValue ?? 0;
  const storedAllocated = firestoreNumber(usageDocument, 'allocatedQuotaBytes');
// Migrate logically (without browser-side writes) records from the old 2 GB base to 1 GB.
// An explicitly recorded grant is retained, and unusual/custom allocations are not overwritten.
  const isLegacyDefault = storedDefault === LEGACY_DEFAULT_STORAGE_QUOTA_BYTES &&
    (storedAllocated === undefined || storedAllocated === LEGACY_DEFAULT_STORAGE_QUOTA_BYTES + storedExtra);
  const defaultQuotaBytes = isLegacyDefault
    ? DEFAULT_STORAGE_QUOTA_BYTES
    : (storedDefault && storedDefault > 0 ? storedDefault : DEFAULT_STORAGE_QUOTA_BYTES);
  const allocatedQuotaBytes = isLegacyDefault
    ? defaultQuotaBytes + storedExtra
    : (storedAllocated && storedAllocated > 0 ? storedAllocated : defaultQuotaBytes + storedExtra);
  const additionalGrantedBytes = storedExtra || Math.max(0, allocatedQuotaBytes - defaultQuotaBytes);
  return { defaultQuotaBytes, additionalGrantedBytes, allocatedQuotaBytes };
}
async function getOwnedR2Usage(bucket, teacher) {
  let usedBytes = 0;
  let objectCount = 0;
  let legacyMetadataCount = 0;
// Keep per-tenant listings scoped to the application's known object prefixes. In addition to
// Notes/Library resources, a teacher's uploaded student photos and own profile avatar count
// toward that teacher's personal storage quota. Other tenants' prefixes are never enumerated.
  const prefixes = [
    { value: 'resources/', allowLegacyEmailFallback: true },
    { value: `student-images/${teacher.uid}/`, allowLegacyEmailFallback: false },
    { value: `profile-images/${teacher.uid}/`, allowLegacyEmailFallback: false },
  ];
  for (const prefixConfig of prefixes) {
    let cursor;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_R2_USAGE_LIST_PAGES) {
        throw new Error('Storage usage could not be completely verified because the bucket has too many pages.');
      }
      const options = {
        prefix: prefixConfig.value,
        limit: 1000,
        include: ['customMetadata'],
      };
      if (cursor) options.cursor = cursor;
      const page = await bucket.list(options);
      for (const object of page.objects || []) {
        const metadata = object.customMetadata || {};
        const ownerUid = String(metadata.ownerUid || '').trim();
        const objectEmail = String(metadata.tenantEmail || '').trim().toLowerCase();
// Preferred ownership proof is the immutable Firebase UID. For older Notes resources
// that predate ownerUid metadata, allow fallback only when ownerUid is absent and the
// stored tenant email exactly matches the verified email. Never fallback on UID conflict.
        const ownedByUid = ownerUid === teacher.uid;
        const legacyEmailMatch = prefixConfig.allowLegacyEmailFallback && !ownerUid && objectEmail === teacher.email;
        if (!ownedByUid && !legacyEmailMatch) continue;
        if (objectEmail && objectEmail !== teacher.email) continue;
        const size = Number(object.size || 0);
        if (!Number.isFinite(size) || size < 0) {
          throw new Error('R2 returned an invalid object size; storage usage cannot be verified safely.');
        }
        usedBytes += size;
        objectCount += 1;
        if (legacyEmailMatch) legacyMetadataCount += 1;
      }
      if (!page.truncated) break;
      if (!page.cursor) throw new Error('R2 returned a truncated listing without a continuation cursor.');
      cursor = page.cursor;
    } while (true);
  }
  return { usedBytes, objectCount, legacyMetadataCount };
}
async function getVerifiedStorageSnapshot(env, teacher) {
  const [usage, quota] = await Promise.all([
    getOwnedR2Usage(env.EDUTRACK_BUCKET, teacher),
    getTeacherQuota(env, teacher),
  ]);
  const checkedAt = new Date().toISOString();
  return {
    ...usage,
    ...quota,
    availableBytes: Math.max(0, quota.allocatedQuotaBytes - usage.usedBytes),
    usageVerified: true,
    usageSource: 'r2-authoritative',
    checkedAt,
  };
}
async function reconcileStorage(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
    console.warn('Storage reconciliation rejected by APP_ORIGINS allowlist.', {
      requestOrigin: normalizeOrigin(origin),
      configuredOriginCount: allowedOrigins(env).length,
    });
    return errorResponse(request, env, 'This website origin is not allowed to use the storage API. Add the exact frontend origin to the Worker APP_ORIGINS variable.', 403);
  }
  let teacher;
  try {
    teacher = await authenticateTeacher(request, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify teacher access.';
    return errorResponse(request, env, message, errorStatus(message));
  }
  try {
    const usage = await getVerifiedStorageSnapshot(env, teacher);
    return json(request, env, { ok: true, ...usage });
  } catch (error) {
    console.error('R2 storage reconciliation failed.', {
      tenantEmail: teacher.email,
      reason: error instanceof Error ? error.message : 'Unknown storage reconciliation error',
    });
    return errorResponse(
      request,
      env,
      error instanceof Error ? error.message : 'Could not verify current R2 storage usage.',
      503,
    );
  }
}
async function uploadFile(request, env, resourceId) {
  if (!validResourceId(resourceId)) return errorResponse(request, env, 'Invalid resource ID.', 400);
  if (request.headers.get('Origin') && !allowedOrigins(env).includes(normalizeOrigin(request.headers.get('Origin')))) {
    return errorResponse(request, env, 'This website origin is not allowed to use the upload API.', 403);
  }
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return errorResponse(request, env, 'File is too large. Maximum file size is 20 MB.', 413);
  }
  let form;
  try { form = await request.formData(); }
  catch { return errorResponse(request, env, 'Expected a multipart form containing a file.', 400); }
  const file = form.get('file');
  const classId = String(form.get('classId') || '');
  const title = String(form.get('title') || '').trim().slice(0, 180);
  const category = String(form.get('category') || 'Notes');
  if (!file || typeof file.stream !== 'function' || typeof file.size !== 'number') {
    return errorResponse(request, env, 'No valid file was provided.', 400);
  }
  if (!title) return errorResponse(request, env, 'A resource title is required.', 400);
  if (!ALLOWED_CATEGORIES.has(category)) return errorResponse(request, env, 'Invalid resource category.', 400);
  if (file.size <= 0) return errorResponse(request, env, 'The selected file is empty.', 400);
  if (file.size > MAX_UPLOAD_BYTES) return errorResponse(request, env, 'File is too large. Maximum file size is 20 MB.', 413);
  const fileName = safeFileName(file.name || 'download');
  const extension = fileName.split('.').pop().toLowerCase();
  const definition = ALLOWED_FILES[extension];
  if (!definition) return errorResponse(request, env, 'Unsupported file type. Upload PDF, DOC, DOCX, PNG, JPG, or JPEG.', 415);
  const actualMime = String(file.type || '').toLowerCase().trim();
  if (actualMime && actualMime !== definition.mimeType && actualMime !== 'application/octet-stream') {
    return errorResponse(request, env, 'File extension and content type do not match.', 415);
  }
  let teacher;
  try { teacher = await authorizeTeacher(request, env, classId); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify teacher access.';
    return errorResponse(request, env, message, errorStatus(message));
  }
  const key = `resources/${resourceId}`;
  const existing = await env.EDUTRACK_BUCKET.head(key);
  if (existing) {
    const meta = existing.customMetadata || {};
    if (meta.ownerUid !== teacher.uid || meta.classId !== classId || meta.resourceId !== resourceId ||
        (meta.tenantEmail && String(meta.tenantEmail).trim().toLowerCase() !== teacher.email)) {
      return errorResponse(request, env, 'This resource ID is already in use.', 409);
    }
// Same teacher/class/resource ID: permit a retry after an uncertain frontend acknowledgement.
  }
// Enforce the per-teacher quota from actual R2 objects on the server, not from browser state.
// Replacing the same owned object only charges the size difference, not the full size twice.
  let storageSnapshot;
  try {
    storageSnapshot = await getVerifiedStorageSnapshot(env, teacher);
  } catch (error) {
    console.error('Could not verify teacher storage before upload.', {
      tenantEmail: teacher.email,
      resourceId,
      reason: error instanceof Error ? error.message : 'Unknown quota verification error',
    });
    return errorResponse(request, env, 'Storage quota could not be verified. Upload was blocked for safety.', 503);
  }
  const existingOwnedSize = existing ? Number(existing.size || 0) : 0;
  const projectedUsedBytes = Math.max(0, storageSnapshot.usedBytes - existingOwnedSize) + file.size;
  if (projectedUsedBytes > storageSnapshot.allocatedQuotaBytes) {
    return json(request, env, {
      ok: false,
      error: 'Storage quota exceeded. Request additional storage before uploading this file.',
      usedBytes: storageSnapshot.usedBytes,
      projectedUsedBytes,
      allocatedQuotaBytes: storageSnapshot.allocatedQuotaBytes,
      availableBytes: storageSnapshot.availableBytes,
    }, 413);
  }
  const putResult = await env.EDUTRACK_BUCKET.put(key, imageBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType: definition.mimeType,
      contentDisposition: contentDisposition(fileName, definition.mimeType),
      cacheControl: 'private, no-store',
    },
    customMetadata: {
      ownerUid: teacher.uid,
      tenantEmail: teacher.email,
      classId,
      resourceId,
      title,
      category,
      fileName,
      fileType: definition.fileType,
    },
  });
  return json(request, env, {
    ok: true,
    id: resourceId,
    r2Key: key,
    shareUrl: `${new URL(request.url).origin}/share/${encodeURIComponent(resourceId)}`,
  });
}
async function deleteFile(request, env, resourceId) {
  if (!validResourceId(resourceId)) return errorResponse(request, env, 'Invalid resource ID.', 400);
  if (request.headers.get('Origin') && !allowedOrigins(env).includes(normalizeOrigin(request.headers.get('Origin')))) {
    return errorResponse(request, env, 'This website origin is not allowed to use the file API.', 403);
  }
  let body;
  try { body = await request.json(); }
  catch { return errorResponse(request, env, 'Expected JSON with classId.', 400); }
  const classId = String(body?.classId || '');
  let teacher;
  try { teacher = await authorizeTeacher(request, env, classId); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify teacher access.';
    return errorResponse(request, env, message, errorStatus(message));
  }
  const key = `resources/${resourceId}`;
  const object = await env.EDUTRACK_BUCKET.head(key);
  if (!object) return json(request, env, { ok: true, deleted: false, alreadyMissing: true });
  const meta = object.customMetadata || {};
  const storedOwnerUid = String(meta.ownerUid || '').trim();
  const storedTenantEmail = String(meta.tenantEmail || '').trim().toLowerCase();
  const ownerMatches = storedOwnerUid
    ? storedOwnerUid === teacher.uid && (!storedTenantEmail || storedTenantEmail === teacher.email)
    : storedTenantEmail === teacher.email;
  const classMatches = String(meta.classId || '') === classId;
  const resourceMetadataMatches = !meta.resourceId || String(meta.resourceId) === resourceId;
// For legacy objects, allow missing resourceId metadata only after the signed-in teacher,
// their tenant email, and class have all been verified. The R2 key is still the exact ID.
  if (!ownerMatches || !classMatches || !resourceMetadataMatches) {
    return errorResponse(request, env, 'You are not authorized to delete this file. The stored owner/class metadata did not match.', 403);
  }
  await env.EDUTRACK_BUCKET.delete(key);
// Confirm that the backing object is actually gone before telling the UI to remove its
// Firestore metadata. R2 is strongly consistent for object reads/writes/deletes.
  const deletionCheck = await env.EDUTRACK_BUCKET.head(key);
  if (deletionCheck) {
    return errorResponse(request, env, 'Cloudflare accepted the delete request, but the object is still present. The database record was kept; retry deletion.', 503);
  }
  return json(request, env, { ok: true, deleted: true, alreadyMissing: false });
}
async function shareFile(request, env, resourceId) {
  if (!validResourceId(resourceId)) return errorResponse(request, env, 'Invalid share link.', 404, true);
  const object = await env.EDUTRACK_BUCKET.get(`resources/${resourceId}`);
  if (!object) return errorResponse(request, env, 'This shared file does not exist or has been removed.', 404, true);
  const meta = object.customMetadata || {};
  const mimeType = object.httpMetadata?.contentType || 'application/octet-stream';
  const fileName = safeFileName(meta.fileName || 'download');
  const headers = corsHeaders(request, env, true);
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', mimeType);
  headers.set('Content-Disposition', contentDisposition(fileName, mimeType));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Length', String(object.size));
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Private subscription payment receipt objects
// ---------------------------------------------------------------------------
const SUBSCRIPTION_RECEIPT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SUBSCRIPTION_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

function base64UrlBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function authorizeSubscriptionReceiptGrant(request, env, action, receiptId) {
  const secret = String(env.SUBSCRIPTION_RECEIPT_SECRET || '');
  if (new TextEncoder().encode(secret).length < 32) {
    const error = new Error('Subscription receipt signing secret is not configured.');
    error.status = 503;
    throw error;
  }
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('A signed subscription receipt grant is required.');
    error.status = 401;
    throw error;
  }
  const parts = match[1].split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const error = new Error('The subscription receipt grant is invalid.');
    error.status = 401;
    throw error;
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    valid = await crypto.subtle.verify(
      'HMAC', key, base64UrlBytes(parts[1]), new TextEncoder().encode(parts[0]),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error('The subscription receipt grant signature is invalid.');
    error.status = 401;
    throw error;
  }
  let grant;
  try { grant = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0]))); }
  catch {
    const error = new Error('The subscription receipt grant payload is invalid.');
    error.status = 401;
    throw error;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!grant || grant.aud !== 'edutrack-subscription-receipt' || grant.v !== 1 ||
      grant.action !== action || grant.receiptId !== receiptId ||
      !Number.isSafeInteger(grant.exp) || grant.exp <= now ||
      !Number.isSafeInteger(grant.iat) || grant.iat > now + 30 ||
      now - grant.iat > 15 * 60 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(grant.adminUid || '')) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(grant.teacherUid || '')) ||
      !/^[A-Za-z0-9_-]{1,180}$/.test(String(grant.invoiceId || '')) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(grant.receiptId || '')) ||
      !String(grant.adminEmail || '').includes('@') || !String(grant.teacherEmail || '').includes('@')) {
    const error = new Error('The subscription receipt grant is expired or does not match this receipt.');
    error.status = 401;
    throw error;
  }
  return grant;
}

function subscriptionReceiptKey(grant) {
  return `subscription-receipts/${grant.adminUid}/${grant.teacherUid}/${grant.invoiceId}/${grant.receiptId}`;
}

function subscriptionReceiptMetadataMatches(metadata, grant) {
  return Boolean(metadata) &&
    metadata.kind === 'subscription-payment-proof' &&
    metadata.adminUid === grant.adminUid &&
    metadata.adminEmail === grant.adminEmail &&
    metadata.teacherUid === grant.teacherUid &&
    metadata.teacherEmail === grant.teacherEmail &&
    metadata.invoiceId === grant.invoiceId &&
    metadata.receiptId === grant.receiptId;
}

async function uploadSubscriptionReceipt(request, env, receiptId) {
  const grant = await authorizeSubscriptionReceiptGrant(request, env, 'upload', receiptId);
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > SUBSCRIPTION_RECEIPT_MAX_BYTES + 64 * 1024) {
    const error = new Error('Payment screenshot upload cannot exceed 5 MB.');
    error.status = 413;
    throw error;
  }
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
    const error = new Error('This website origin is not allowed to upload subscription receipts.');
    error.status = 403;
    throw error;
  }
  let form;
  try { form = await request.formData(); }
  catch {
    const error = new Error('Upload a screenshot using multipart form data.');
    error.status = 400;
    throw error;
  }
  const file = form.get('file');
  if (!file || typeof file !== 'object' || typeof file.stream !== 'function') {
    const error = new Error('Choose a payment screenshot image.');
    error.status = 400;
    throw error;
  }
  const mimeType = String(file.type || '').toLowerCase();
  if (!SUBSCRIPTION_RECEIPT_MIME_TYPES.has(mimeType)) {
    const error = new Error('Payment screenshot must be a JPG, PNG, or WebP image.');
    error.status = 415;
    throw error;
  }
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > SUBSCRIPTION_RECEIPT_MAX_BYTES) {
    const error = new Error('Payment screenshot must be between 1 byte and 5 MB.');
    error.status = 413;
    throw error;
  }
  const imageBytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = mimeType === 'image/jpeg' && imageBytes.length >= 3 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff;
  const isPng = mimeType === 'image/png' && imageBytes.length >= 8 && imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4e && imageBytes[3] === 0x47 && imageBytes[4] === 0x0d && imageBytes[5] === 0x0a && imageBytes[6] === 0x1a && imageBytes[7] === 0x0a;
  const isWebp = mimeType === 'image/webp' && imageBytes.length >= 12 && new TextDecoder().decode(imageBytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(imageBytes.slice(8, 12)) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) {
    const error = new Error('The selected file content does not match a supported screenshot image.');
    error.status = 415;
    throw error;
  }
  const key = subscriptionReceiptKey(grant);
  const existing = await env.EDUTRACK_BUCKET.head(key);
  if (existing) {
    const error = new Error('A screenshot already exists for this invoice upload. Submit it for review or contact the administrator.');
    error.status = 409;
    throw error;
  }
  const putResult = await env.EDUTRACK_BUCKET.put(key, imageBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `inline; filename="payment-proof-${receiptId}"`,
      cacheControl: 'private, no-store',
    },
    customMetadata: {
      kind: 'subscription-payment-proof',
      adminUid: grant.adminUid,
      adminEmail: grant.adminEmail,
      teacherUid: grant.teacherUid,
      teacherEmail: grant.teacherEmail,
      invoiceId: grant.invoiceId,
      receiptId: grant.receiptId,
    },
  });
  if (!putResult) {
    const error = new Error('A screenshot already exists for this invoice upload. Submit it for review or contact the administrator.');
    error.status = 409;
    throw error;
  }
  const saved = await env.EDUTRACK_BUCKET.head(key);
  if (!saved || !subscriptionReceiptMetadataMatches(saved.customMetadata || {}, grant) || saved.size !== file.size) {
    // Do not report an upload as complete unless the private R2 object can be verified.
    const error = new Error('The receipt was written but could not be verified in private storage. Retry using the same invoice upload session.');
    error.status = 503;
    throw error;
  }
  return json(request, env, { ok: true, receiptId: grant.receiptId, uploaded: true });
}

async function serveInternalSubscriptionReceipt(request, env, receiptId, action) {
  const grant = await authorizeSubscriptionReceiptGrant(request, env, action, receiptId);
  const key = subscriptionReceiptKey(grant);
  const object = action === 'verify'
    ? await env.EDUTRACK_BUCKET.head(key)
    : await env.EDUTRACK_BUCKET.get(key);
  if (!object || !subscriptionReceiptMetadataMatches(object.customMetadata || {}, grant)) {
    const error = new Error('The private payment receipt was not found for this verified invoice.');
    error.status = 404;
    throw error;
  }
  if (action === 'verify') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  const headers = corsHeaders(request, env);
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `inline; filename="payment-proof-${receiptId}"`);
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Length', String(object.size));
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const publicShareMatch = pathname.match(/^\/share\/([^/]+)$/);
    const publicProfileImageMatch = pathname.match(/^\/profile-images\/([^/]+)$/);
    const publicStudentImageMatch = pathname.match(/^\/student-images\/([^/]+)\/([^/]+)\/([^/]+)$/);
    const apiStudentImageMatch = pathname.match(/^\/api\/student-images\/([^/]+)$/);
    const apiFileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
    const subscriptionReceiptMatch = pathname.match(/^\/api\/subscription-receipts\/([^/]+)$/);
    const internalSubscriptionReceiptMatch = pathname.match(/^\/internal\/subscription-receipts\/([^/]+)$/);
    if (request.method === 'OPTIONS') {
      const isPublicRead = pathname.startsWith('/share/') || pathname.startsWith('/profile-images/') || pathname.startsWith('/student-images/');
      const origin = request.headers.get('Origin');
      if (!isPublicRead && origin && !allowedOrigins(env).includes(normalizeOrigin(origin))) {
        console.warn('CORS preflight origin is not present in APP_ORIGINS.', {
          requestOrigin: normalizeOrigin(origin),
          configuredOriginCount: allowedOrigins(env).length,
          pathname,
        });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env, isPublicRead) });
    }
    if (pathname === '/' && request.method === 'GET') {
      return json(request, env, {
        ok: true,
        service: 'EduTrack R2 API',
        bucketBound: Boolean(env.EDUTRACK_BUCKET),
        fileOperations: env.EDUTRACK_BUCKET && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY ? 'enabled' : 'configuration-required',
        publicAccess: 'link-only via /share/:resourceId; teacher avatars via /profile-images/:uid; student images via unguessable /student-images/:uid/:classId/:imageId URLs',
        profileImageUpload: 'POST /api/register/profile-image',
        profileImageDelete: 'DELETE /api/register/profile-image (authenticated cleanup for rolled-back registrations)',
        studentImageUpload: 'POST /api/student-images',
        studentImageDelete: 'DELETE /api/student-images/:imageId',
        storageReconciliation: 'POST /api/storage/reconcile',
        subscriptionReceiptProofs: env.SUBSCRIPTION_RECEIPT_SECRET ? 'configured' : 'configuration-required',
        subscriptionReceiptPrivacy: 'private R2 objects; no public receipt URL',
        deleteSemantics: 'R2 object is verified absent before success is returned',
      });
    }
    if (!env.EDUTRACK_BUCKET) return errorResponse(request, env, 'R2 bucket binding EDUTRACK_BUCKET is missing.', 500);
    if (subscriptionReceiptMatch && request.method === 'PUT') {
      let receiptId;
      try { receiptId = decodeURIComponent(subscriptionReceiptMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid receipt ID.', 400); }
      try { return await uploadSubscriptionReceipt(request, env, receiptId); }
      catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        if (status >= 500) console.error('Private subscription receipt upload failed:', error);
        return errorResponse(request, env, error instanceof Error ? error.message : 'The private payment receipt could not be uploaded.', status);
      }
    }
    if (internalSubscriptionReceiptMatch && (request.method === 'HEAD' || request.method === 'GET')) {
      let receiptId;
      try { receiptId = decodeURIComponent(internalSubscriptionReceiptMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid receipt ID.', 400); }
      const action = request.method === 'HEAD' ? 'verify' : 'read';
      try { return await serveInternalSubscriptionReceipt(request, env, receiptId, action); }
      catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        if (status >= 500) console.error('Private subscription receipt access failed:', error);
        return errorResponse(request, env, error instanceof Error ? error.message : 'The private payment receipt could not be accessed.', status);
      }
    }
    if (pathname === '/api/register/profile-image' && request.method === 'POST') {
      try { return await uploadRegistrationProfileImage(request, env); }
      catch (error) {
        console.error('Registration profile image upload failed:', error);
        const message = error instanceof Error ? error.message : 'The profile image could not be saved to Cloudflare R2.';
        return errorResponse(request, env, message, errorStatus(message) === 400 ? 500 : errorStatus(message));
      }
    }
    if (pathname === '/api/register/profile-image' && request.method === 'DELETE') {
      try { return await deleteRegistrationProfileImage(request, env); }
      catch (error) {
        console.error('Registration profile image cleanup failed:', error);
        const message = error instanceof Error ? error.message : 'The profile image could not be cleaned up from Cloudflare R2.';
        return errorResponse(request, env, message, errorStatus(message) === 400 ? 500 : errorStatus(message));
      }
    }
    if (publicProfileImageMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      let uid;
      try { uid = decodeURIComponent(publicProfileImageMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid profile image URL.', 404, true); }
      try { return await serveProfileImage(request, env, uid); }
      catch (error) {
        console.error('Profile image request failed:', error);
        return errorResponse(request, env, 'The profile image could not be served.', 500, true);
      }
    }
    if (pathname === '/api/student-images' && request.method === 'POST') {
      try { return await uploadStudentImage(request, env); }
      catch (error) {
        console.error('Student image upload failed:', error);
        return errorResponse(request, env, 'The student image could not be saved to Cloudflare R2.', 500);
      }
    }
    if (apiStudentImageMatch && request.method === 'DELETE') {
      let imageId;
      try { imageId = decodeURIComponent(apiStudentImageMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid student image ID.', 400); }
      try { return await deleteStudentImage(request, env, imageId); }
      catch (error) {
        console.error('Student image deletion failed:', error);
        return errorResponse(request, env, 'The student image could not be deleted from Cloudflare R2.', 500);
      }
    }
    if (publicStudentImageMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      let uid;
      let classId;
      let imageId;
      try {
        uid = decodeURIComponent(publicStudentImageMatch[1]);
        classId = decodeURIComponent(publicStudentImageMatch[2]);
        imageId = decodeURIComponent(publicStudentImageMatch[3]);
      } catch { return errorResponse(request, env, 'Invalid student image URL.', 404, true); }
      try { return await serveStudentImage(request, env, uid, classId, imageId); }
      catch (error) {
        console.error('Student image request failed:', error);
        return errorResponse(request, env, 'The student image could not be served.', 500, true);
      }
    }
    if (pathname === '/api/storage/reconcile' && request.method === 'POST') {
      try { return await reconcileStorage(request, env); }
      catch (error) {
        console.error('R2 storage reconciliation route failed:', error);
        return errorResponse(request, env, 'Storage usage could not be verified.', 503);
      }
    }
    if (publicShareMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      let resourceId;
      try { resourceId = decodeURIComponent(publicShareMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid share link.', 404, true); }
      try { return await shareFile(request, env, resourceId); }
      catch (error) {
        console.error('R2 share request failed:', error);
        return errorResponse(request, env, 'The shared file could not be served.', 500, true);
      }
    }
    if (apiFileMatch && request.method === 'PUT') {
      let resourceId;
      try { resourceId = decodeURIComponent(apiFileMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid resource ID.', 400); }
      try { return await uploadFile(request, env, resourceId); }
      catch (error) {
        console.error('R2 upload failed:', error);
        return errorResponse(request, env, 'The file could not be saved to Cloudflare R2.', 500);
      }
    }
    if (apiFileMatch && request.method === 'DELETE') {
      let resourceId;
      try { resourceId = decodeURIComponent(apiFileMatch[1]); }
      catch { return errorResponse(request, env, 'Invalid resource ID.', 400); }
      try { return await deleteFile(request, env, resourceId); }
      catch (error) {
        console.error('R2 delete failed:', error);
        return errorResponse(request, env, 'The file could not be deleted from Cloudflare R2.', 500);
      }
    }
    return errorResponse(request, env, 'Route not found.', 404);
  },
};
