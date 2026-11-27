# Teacher Portal Visual Regression — Evidence and Limits

## Design constraint

The V2 requirement is zero visible Teacher Portal redesign. Existing Teacher Portal page components and the shared teacher shell are intended to remain in place. The code changes filter existing navigation/Quick Access records based on permission grants and change routing/data access behind the existing pages.

## Changed integration points

- `src/components/Layout.tsx`: existing navigation list is filtered by permission; existing layout/styling is retained.
- `src/pages/Dashboard.tsx`: existing Quick Access items are permission-filtered; existing cards/design are reused.
- `src/components/FeatureRoute.tsx` and `src/components/AcademyPermissionRoute.tsx`: page access checks are membership/permission-aware.
- `src/pages/DepartmentsPage.tsx`: existing add-student UI is connected to the canonical Academy student API; teacher edit/delete legacy paths remain a migration gap.
- `src/pages/fees.tsx`: existing visual page remains; canonical student collections use the central invoice/payment API, while legacy records may still use the old fee path.
- `src/pages/alerts.tsx` and `src/pages/quiz.tsx`: permission/data access integration changes only; comprehensive ownership lock/migration is not complete.

## Verification result

**A before/after browser screenshot comparison has not been run.** The runtime did not contain installed frontend dependencies or a browser automation setup. Therefore this document does not certify pixel-identical rendering.

The code changes aim to preserve existing page markup/styles, but permission filtering intentionally changes which existing menu/Quick Access entries are visible for each teacher. A teacher with a grant should see the same existing page; a teacher without a grant should not see or directly access it.

## Required staging check

Capture each page before and after using the same:
- viewport dimensions and browser zoom,
- theme and device scale,
- seed data and authenticated teacher,
- permission grants,
- page scroll position and interaction state.

Compare Dashboard, Classes/Departments, Attendance, Fees, Reports, Analytics, Quiz, Notes/Library, Alerts and Settings. For the navigation tests, compare a fully permitted teacher and a least-privilege teacher. Any unexplained layout, CSS, form or interaction difference must be fixed before release.
