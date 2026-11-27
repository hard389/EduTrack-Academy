# GitHub push guide – EduTrack source delivery

This source ZIP does not contain `.git`, private environment files, Vercel project credentials, Firebase service-account keys, or `node_modules`. The GitHub push must be run from your own authenticated clone because this chat does not have your local GitHub credentials.

## 1. Extract the delivery

```bash
cd ~/Downloads
unzip -q Academy_EduTrack_GITHUB_READY_20261127.zip -d ~/Downloads
```

The extracted source directory is:

```text
~/Downloads/Academy_EduTrack_GITHUB_READY/
```

## 2. Check the existing clone and create a branch

```bash
cd ~/Downloads/New_updated-_School_ERP_Latest_DevOps

git remote -v
git status --short
```

Confirm that `origin` is the intended repository (`hard389/New_updated-_School_ERP_Latest_DevOps`). If `git status --short` shows existing work, commit or stash it before continuing. Do not overwrite uncommitted work.

```bash
git switch -c fix/academy-teacher-portal-permissions
```

## 3. Back up the clone, then sync the reviewed source

The backup stays outside the repository. This command deliberately excludes credentials and generated dependencies:

```bash
cd ~/Downloads/New_updated-_School_ERP_Latest_DevOps

 tar -czf ../New_updated_School_ERP_before_teacher_permission_patch_$(date +%Y%m%d_%H%M%S).tar.gz \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=.vercel \
  --exclude=.env \
  --exclude='.env.*' \
  --exclude=.secret.local \
  --exclude='*.log' \
  .
```

Then copy the complete reviewed source over the branch. This sync removes stale tracked source files, but preserves `.git`, dependencies, Vercel linking, and local secrets:

```bash
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.vercel/' \
  --exclude='.env' \
  --include='.env.example' \
  --exclude='.env.*' \
  --exclude='.secret.local' \
  --exclude='.patch-backups/' \
  --exclude='*.log' \
  --exclude='dist/' \
  --exclude='coverage/' \
  ~/Downloads/Academy_EduTrack_GITHUB_READY/ ./
```

If the old clone has an intentional `.env.local`, it remains in place because the sync excludes it. Never add private env files to Git.

## 4. Restore local Vercel development setup and run checks

The `.vercel` directory is intentionally excluded from the ZIP. Re-link this folder to the existing EduTrack Vercel project when prompted, or run `npx vercel@latest link` and select the existing project. Do not create a new production project. Restore any local-only `GOOGLE_APPLICATION_CREDENTIALS` path in an untracked `.env.local` file if your backend relies on it.

```bash
source ~/.nvm/nvm.sh
nvm use 22.22.2

npm ci
npm --prefix src/functions ci
npm run test:academy-access
npm run typecheck
npm run build
```

Stop the Vercel dev server (`Ctrl+C`) before Firestore Emulator validation because the emulator uses port `8080`:

```bash
npx firebase-tools emulators:exec \
  --project demo-edutrack \
  --only firestore \
  "node --test tests/firestore.rules.test.mjs"
```

Do not commit or push until the local checks have passed and the remaining emulator timeout is resolved.

## 5. Review the staged change and scan for secrets

```bash
git status --short
git diff --check
git diff --stat

git add -A

git diff --cached --check
git diff --cached --stat
```

Check staged paths for sensitive files before committing:

```bash
git diff --cached --name-only | grep -Ei '(^|/)\.env($|\.)|service-account|firebase-adminsdk|\.pem$|\.key$|\.p12$|\.pfx$' || true
```

If that command prints a secret/credential path, unstage and remove it from the commit before proceeding. Review the staged diff, especially `firestore.rules`, `storage.rules`, `firebase.json`, and Functions changes.

## 6. Commit and push your feature branch

```bash
git commit -m "Fix subscription-free Academy teacher portal access"
git push -u origin fix/academy-teacher-portal-permissions
```

This pushes a feature branch; it does not deploy Firebase or Vercel. Create a GitHub Pull Request and merge only after the review and production deployment gates in `FINAL_RELEASE_VERIFICATION.md` pass.
