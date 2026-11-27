# EduTrack Academy — Problem 2 / V2 Patch

This is the incremental patch that applies over the already-applied Problem 1 Academy Identity patch.

## Downloads

- `EDUTRACK_ACADEMY_PROBLEM2_PATCH.zip`: incremental code patch with SHA-guarded apply/rollback scripts.
- `EDUTRACK_ACADEMY_V2_PATCHED_PROJECT.zip`: full patched source tree, excluding installed dependencies and secrets.

## Apply

```bash
cd ~/Downloads
mkdir -p EDUTRACK_PROBLEM2_PATCH
unzip -o EDUTRACK_ACADEMY_PROBLEM2_PATCH.zip -d EDUTRACK_PROBLEM2_PATCH
cd ~/Downloads/EDUTRACK_ACADEMY_CONFIGURED_SOURCE
bash ~/Downloads/EDUTRACK_PROBLEM2_PATCH/EDUTRACK_ACADEMY_PROBLEM2_PATCH/APPLY_PATCH.sh "$PWD"
```

If your actual project folder has another path, `cd` into that project folder and pass `"$PWD"`.

## Roll back

```bash
bash ~/Downloads/EDUTRACK_PROBLEM2_PATCH/EDUTRACK_ACADEMY_PROBLEM2_PATCH/ROLLBACK_PATCH.sh "$PWD"
```

The script restores the latest Problem 2 file backup. It does not roll back remote Firebase/Cloudflare/Vercel deployment or any database migration.

## Install and verify

```bash
nvm install 22.22.2
nvm use 22.22.2
npm ci
npm run typecheck
npm run lint
npm run build
node --test tests/*.test.mjs
npm run test:rules
```

See `PATCH_TEST_RESULTS.md` for what was actually run in the authoring environment, and `ACADEMY_REQUIREMENTS_MAPPING.md` for implemented/partial/not-implemented scope.

## Important

- Do not run production migration from this patch. A production data migration utility is not included.
- Existing teacher workspaces and historical fee/attendance records must be backed up and reconciled separately.
- Teacher Portal visual redesign is not intended; screenshot regression is still required in staging.
- This patch is not certified production-ready or 100% end-to-end complete.
