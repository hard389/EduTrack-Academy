# EduTrack Architecture Review Package

Please perform a complete architecture review before modifying code.

## Review scope

1. Project structure and module responsibilities.
2. Frontend architecture and routing.
3. Backend architecture and API handlers.
4. Firebase configuration, Firestore rules and indexes.
5. Database access and data models.
6. Authentication, authorization and roles.
7. Subscription plans and entitlement management.
8. Billing, invoices and payment receipts.
9. WhatsApp notifications and related integrations.
10. Admin tools and customer management.
11. Environment variable requirements.
12. Test structure, test coverage and existing failures.
13. Deployment configuration and build process.
14. Dependencies and potential security issues.

## Important instructions

- First understand the existing implementation.
- Do not replace the existing architecture unnecessarily.
- Do not modify unrelated modules.
- Do not assume missing environment values.
- Identify dependencies between affected modules.
- Preserve existing functionality.
- Wait for the user to describe the specific problem before
  preparing a modification patch.

## Patch delivery requirements

When a problem is reported, provide:

1. Root cause analysis.
2. Exact files that need modification.
3. Complete patch/diff.
4. Any new files required.
5. Database or Firebase migration instructions, if applicable.
6. Commands to apply the patch.
7. Commands to run tests and verify the fix.
8. Rollback instructions.
9. Known limitations.

## Security note

Environment files and common credential files were excluded.
Inspect source code for hardcoded credentials before sharing.
