// V6.4.0-a: hosting exclusions. Firebase Hosting publishes the project root ("public": "."), so EVERY file
// that is not a runtime asset must match an `ignore` glob. Allowlist test: the runtime set (index.html,
// manifest, service worker, src/**/*.js, assets/**) must be served; every other file in the project — and a
// list of typical artifacts (ZIPs, logs, lockfiles, credentials, emulator output) — must be excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const hosting = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8')).hosting;

/** Minimal glob → RegExp matching Firebase's (minimatch, dot:true) semantics for the forms we use. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '@' && glob[i + 1] === '(') { const end = glob.indexOf(')', i); re += `(?:${glob.slice(i + 2, end).split('|').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`; i = end; }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const IGNORE = hosting.ignore.map(globRe);
const ignored = (p) => IGNORE.some((re) => re.test(p));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}
const RUNTIME = (p) => p === 'index.html' || p === 'manifest.webmanifest' || p === 'sw.js'
  || (/^src\/.+\.js$/.test(p)) || (/^assets\/.+\.(css|png|svg|webp|ico|woff2?)$/.test(p));

test('hosting: public root unchanged; glob helper sanity', () => {
  assert.equal(hosting.public, '.');
  assert.ok(globRe('**/*.md').test('docs/a/b.md') && globRe('**/*.md').test('README.md'));
  assert.ok(!globRe('*.md').test('docs/a.md'), 'root-only glob');
  assert.ok(globRe('**/.*').test('.firebaserc') && globRe('**/.*').test('src/.env'));
  assert.ok(globRe('**/.*/**').test('.github/workflows/verify.yml'), 'files inside dot-folders');
});

test('hosting: every runtime asset is served (app, PWA, icons, styles)', () => {
  const files = walk(ROOT).filter(RUNTIME);
  for (const must of ['index.html', 'manifest.webmanifest', 'sw.js', 'src/main.js', 'src/pwa.js', 'assets/icons/icon-192.png', 'assets/css/tokens.css']) assert.ok(files.includes(must), `${must} exists`);
  const blocked = files.filter(ignored);
  assert.deepEqual(blocked, [], 'no runtime file is excluded');
});

test('hosting: every NON-runtime project file is excluded (docs, tools, tests, reports, configs)', () => {
  const exposed = walk(ROOT).filter((p) => !RUNTIME(p) && !ignored(p));
  assert.deepEqual(exposed, [], `would be publicly served: ${exposed.join(', ')}`);
});

test('hosting: typical artifacts can never be served', () => {
  const artifacts = [
    'HomeHub-V6.4.0-A-full.zip', 'patch/V640A-changed.zip', 'V640A.patch', 'changes.diff', 'build.tar', 'out.tgz',
    'emulator-normal.txt', 'emulator-strict.txt', 'firebase-debug.log', 'firestore-debug.log', 'npm-debug.log', 'ui-debug.log',
    'package-lock.json', 'tests/rules/package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'package.json',
    '.env', '.env.local', 'config/.env', 'service-account.json', 'serviceAccountKey.json', 'service_account.json', 'keys/homehub-firebase-adminsdk-abc12.json', 'credentials.json', 'certs/server.pem', 'server.key', 'cert.p12',
    'screens/01.png', 'coverage/index.html', 'playwright-report/index.html', 'test-results/x/trace.zip',
    'docs/reference/homeCleaning.html', 'docs/ai-import/sample-plan.json', 'tools/rules-cost.mjs', 'tests/e2e/run-e2e.mjs', 'tests/fixtures/google-calendar-2026.csv',
    'V640A-REPORT.md', 'PHASE-5.3-CHANGED-FILES.txt', 'firestore.rules', 'firestore.indexes.json', 'firebase.json', '.firebaserc', '.gitignore', '.github/workflows/verify.yml',
  ];
  const served = artifacts.filter((p) => !ignored(p));
  assert.deepEqual(served, [], `served: ${served.join(', ')}`);
});

test('hosting: security / cache headers preserved', () => {
  const src = (s) => (hosting.headers.find((x) => x.source === s) || { headers: [] }).headers;
  const all = src('**'); const keys = all.map((h) => h.key);
  for (const k of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) assert.ok(keys.includes(k), `${k} kept`);
  assert.ok(src('/sw.js').some((h) => h.key === 'Cache-Control' && h.value === 'no-cache'));
  assert.ok(src('/manifest.webmanifest').some((h) => h.key === 'Content-Type' && h.value === 'application/manifest+json'));
  assert.ok(src('**/*.@(js|css)').some((h) => h.value === 'no-cache'));
});
