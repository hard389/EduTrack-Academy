# EduTrack Academy Identity Patch — Problem 1

## Scope

This patch introduces a separate Academy identity layer while preserving existing teacher workspace paths at `users/{normalizedEmail}` and all current teacher-owned subcollections. Public Academy registration creates one Academy Owner (`academy_admin`) and does not create a teacher workspace or teacher subscription. The existing platform Super Admin `admin === true` claim and `/admin/*` routes are intentionally unchanged.

## New Firestore model

- `academies/{academyId}` — Academy profile, owner UID/email, status and logo/contact metadata.
- `academies/{academyId}/members/{uid}` — one Academy-specific membership and role.
- `academyMemberships/{uid}` — unique UID-to-Academy mapping used for trusted session lookup.
- `systemCounters/academyIds` — server-only `nextId` counter. When absent, the first committed Academy ID is `100`; subsequent IDs increment through Firestore transactions.
- `users/{normalizedTeacherEmail}` — existing teacher workspace remains in place. New Academy-created teachers receive an immutable `academyId` field.

All Academy membership, counter and teacher root-profile writes are performed by Firebase Admin SDK in Vercel API code. Firestore rules deny browser writes to these documents.

## User flows

1. `/register`: Firebase Auth account is created, the logo is uploaded to the existing R2 endpoint if selected, then `/api/academy/register` allocates the ID transactionally and creates a pending Academy Owner membership. Firebase email verification is sent from the client. The portal stays blocked until Firebase Auth reports `emailVerified=true`; `/api/academy/session` independently validates the verified ID token and activates the pending owner membership.
2. `/login`: requires Academy ID, email and password. After Firebase sign-in, `/api/academy/session` confirms the UID/email/Academy mapping and routes Academy Admins to `/academy-admin/dashboard` and teachers to `/dashboard`.
3. Academy Admin can view their own Academy ID/name and list up to 250 teachers or create teachers via `/api/academy/teachers`. Teacher Auth users are created with Firebase Admin SDK; their password is never written to Firestore or returned by the API. Teachers must verify their email on first login.
4. Teacher pages and teacher APIs require a matching active verified Academy membership. The existing teacher workspace and its subcollections are not moved.

## Subscription compatibility

The previous public registration page called a teacher-only subscription endpoint. This patch no longer submits an Academy Owner to that endpoint and does not create a fake teacher profile or grant teacher entitlements. Existing teacher plans remain viewable as information only. Academy-level billing is intentionally not invented here and needs a separate billing ownership design.

## Legacy teacher mapping

Existing teacher accounts will not be assigned automatically because the source data does not reliably identify which Academy owns each teacher. Create a reviewed mapping JSON with explicit email-to-Academy ID rows, then run:

```bash
node scripts/migrate-academy-memberships.mjs --mapping-file ./docs/your-reviewed-academy-map.json
```

This is dry-run by default. Inspect every `APPLY`, `NO-OP` and `BLOCKED` row. Only after review, run:

```bash
node scripts/migrate-academy-memberships.mjs --mapping-file ./docs/your-reviewed-academy-map.json --apply
```

The tool accepts only existing active teacher profiles and existing active Academies; it does not move subcollections, auto-group teachers, promote anyone to Academy Admin or overwrite conflicting mappings. Unverified teachers are mapped as pending until Firebase confirms verification. It uses the existing `FIREBASE_PROJECT_ID` and Firebase Admin credential environment variables already used by this repository.

## Important operational prerequisites

- Use Node `22.22.2` or a version within the package's `>=22.22.2 <23` engine range (`.nvmrc` is already present).
- Firebase Authentication Email/Password provider and email verification must be configured for the deployed domain.
- Vercel must have the same existing Firebase Admin credentials as the other APIs, plus the existing frontend Firebase configuration.
- The existing Cloudflare R2 profile-image route must be deployed/configured when the Academy logo upload is used. Registration can continue without a custom image.
- Deploy updated Firestore rules before relying on teacher Firestore access. Run legacy mapping before existing teachers attempt to use the new Academy-ID login.
- No Firebase production project, Cloudflare credentials, Vercel secrets, or deployment settings are changed by this patch.

## Security notes and limitations

- Public registration is protected by Firebase Authentication and Firebase's configured abuse protections; this patch does not add a durable IP-based rate limiter. Add edge-level rate limiting before exposing the public registration endpoint to high-volume traffic.
- Firebase Admin SDK bypasses Firestore rules, so all trusted API handlers re-check identity, role, email verification, active membership and Academy status.
- Existing internal WhatsApp worker requests authenticated by the repository's shared worker secret retain their internal service path; normal browser/API teacher requests now require active verified Academy membership.
- The legacy platform Super Admin is not allowed to use the Academy registration flow and remains governed by its existing custom claim.
