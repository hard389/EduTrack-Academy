# Teacher Subscription Access Removal Audit

## Target

Teacher Portal feature visibility and authorization must be controlled by Academy membership permissions, not teacher SaaS plans, add-ons, paid status or entitlement projections. Platform/SaaS Super Admin subscription management must remain isolated.

## Changes in this patch

- Removed `src/pages/subscription.tsx`.
- Removed the `/subscription` teacher route and redirect old `/subscription` URLs to `/dashboard`.
- Removed teacher subscription entrypoints/handlers:
  - `api-handlers/teacher/subscription.ts`
  - `api-handlers/teacher/subscription/addons.ts`
  - `api-handlers/teacher/subscription/proof-submit.ts`
  - `api-handlers/teacher/subscription/proof-upload.ts`
  - `api-handlers/teacher/registration.ts`
  - `server/teacherRegistration.ts`
- Updated active teacher API router to remove teacher registration and subscription purchase/proof/add-on routes.
- Updated `src/contexts/AppContext.tsx`, `src/components/FeatureRoute.tsx`, the Academy access hook and entitlement adapter so the teacher feature access decision is resolved from current Academy membership permission grants.
- Updated Firestore rules and server compatibility checks so feature access is checked against active verified Academy membership and the permission key, rather than a paid subscription entitlement.
- Updated Cloud Function subscription projection permission helper and teacher notification status text where teacher-facing access messages referenced subscription state.
- Added/updated contract tests that assert the teacher subscription UI/API surface is retired and permission grants are the access source.

## Intentionally retained

- Existing Platform/SaaS Super Admin `/admin/*` routes and custom claim guard remain separate.
- Platform customer/subscription billing handlers and platform-level scheduled projection code may remain where they are exclusively used by the Super Admin product-owner console.
- Legacy subscription documents can remain as historical metadata. They must not authorize or deny teacher portal features.

## Verification limits

A repository-wide production integration scan could not be completed with dependency-aware compilation or emulator tests because `node_modules` and Firebase Emulator tooling are not installed in the provided build environment. The focused teacher registration/subscription-access contract tests passed (see `PATCH_TEST_RESULTS.md`). Review all `subscription`, `entitlement`, `plan`, `add-on`, `quota`, `featureVisibilityMode`, `accessMode` and `featurePermissions` references again before deployment, particularly any scheduled Cloud Function/Cloudflare worker not exercised by unit tests.
