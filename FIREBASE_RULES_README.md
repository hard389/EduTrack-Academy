# Firebase rules shipped with this repair

The project uses two separate rules files and references them from `firebase.json`:

- `firestore.rules` — Firestore document access.
- `storage.rules` — Firebase Storage object access (student/teacher avatars).

Both files are aligned to the Academy membership model in the current source code. Authorization is derived from the active, verified records at:

- `academyMemberships/{firebaseAuthUid}`
- `academies/{academyId}`
- `academies/{academyId}/members/{firebaseAuthUid}`

Teacher feature access is read from the member document's boolean `permissions` map. Subscription entitlement projections are server-owned compatibility records and are not the source of Academy teacher permissions.

Deploy from the repository root after validating with the Firebase Emulator:

```bash
npx firebase-tools emulators:exec --only firestore "node --test tests/firestore.rules.test.mjs"
npx firebase-tools deploy --only firestore:rules,storage
```

The older rules text that checks `users/{tenantId}/subscriptionEntitlements/current` is from a previous authorization model and is not interchangeable with these files. Do not combine the two models or widen access with a blanket authenticated-user rule.
