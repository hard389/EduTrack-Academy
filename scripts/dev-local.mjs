import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const requiredNode = { major: 22, minor: 22, patch: 2 };
const current = process.versions.node.split('.').map(Number);
const isSupportedNode =
  current[0] === requiredNode.major &&
  (current[1] > requiredNode.minor ||
    (current[1] === requiredNode.minor && current[2] >= requiredNode.patch));

if (!isSupportedNode) {
  console.error(
    `EduTrack requires Node.js 22.22.2. Current version: ${process.versions.node}.\n` +
      'Run: nvm install 22.22.2 && nvm use 22.22.2',
  );
  process.exit(1);
}

const root = process.cwd();
const projectLink = resolve(root, '.vercel', 'project.json');
const localEnvFile = resolve(root, '.env.local');

// Load non-empty local overrides without adding a dotenv dependency. Values pulled
// from Vercel remain available to Vercel Dev; local service-account file paths can
// be supplied here and are never written into the repository.
if (existsSync(localEnvFile)) {
  for (const rawLine of readFileSync(localEnvFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (value) process.env[match[1]] = value;
  }
}

process.env.FIREBASE_PROJECT_ID ||= 'edutrack-academy';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function runVercel(args, label) {
  return new Promise((resolveExit) => {
    console.log(`\n[EduTrack] ${label}\n`);
    const child = spawn(npxCommand, ['--yes', 'vercel@latest', ...args], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    });

    child.once('error', (error) => {
      console.error(`[EduTrack] Could not start Vercel CLI: ${error.message}`);
      resolveExit(1);
    });
    child.once('exit', (code, signal) => {
      resolveExit(typeof code === 'number' ? code : signal ? 1 : 0);
    });
  });
}

if (!existsSync(projectLink)) {
  console.log(
    '[EduTrack] First-time local setup: sign in to Vercel and link this folder to the existing EduTrack project.\n' +
      'Choose the existing Academy project (do not create a new production project).',
  );
  const linkExit = await runVercel(['link'], 'Linking the existing Vercel project');
  if (linkExit !== 0 || !existsSync(projectLink)) {
    console.error(
      '\n[EduTrack] Vercel project linking did not complete. Run `npx vercel@latest link` from this folder, then run `npm run dev` again.',
    );
    process.exit(linkExit || 1);
  }
}

const pullExit = await runVercel(
  ['pull', '--yes', '--environment=development'],
  'Synchronizing the linked project development settings and environment variables',
);
if (pullExit !== 0) {
  console.error(
    '\n[EduTrack] Could not sync the Vercel development environment. Check your Vercel login, project link, and Development environment variables, then run `npm run dev` again.',
  );
  process.exit(pullExit);
}

const devExit = await runVercel(
  ['dev', '--listen', '8080'],
  'Starting the complete local app and its /api serverless routes at http://localhost:8080',
);
process.exit(devExit);
