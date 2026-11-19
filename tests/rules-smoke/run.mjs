/**
 * OFFLINE JavaScript check of tests/rules/rules.test.mjs (Phase 5.1.1).
 *
 * Runs the rules test file against an in-memory STAND-IN for the Firebase SDK and
 * @firebase/rules-unit-testing. It does NOT evaluate security rules — a passing result here
 * proves nothing about rules. It catches JavaScript-level failures in the test file: missing
 * imports (e.g. `assert`), undefined field values, invalid document/collection references,
 * references from a different Firestore instance inside a batch, reused batches.
 *
 * The authoritative check is still the real emulator:  npm run test:rules
 * Expected here: every test passes except those whose assertions need real rule enforcement
 * (currently: L14, which verifies the rules REFUSED an overwrite).
 */
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'rules-smoke-'));
cpSync(join(here, 'stub_modules'), join(work, 'node_modules'), { recursive: true }); // stand-ins (shipped as stub_modules)
const src = readFileSync(join(root, 'tests', 'rules', 'rules.test.mjs'), 'utf8')
  .replaceAll("'../../src/", `'${join(root, 'src').replaceAll('\\', '/')}/`)
  .replace("new URL('../../firestore.rules', import.meta.url)", JSON.stringify(join(root, 'firestore.rules')));
writeFileSync(join(work, 'rules.test.mjs'), src);
const r = spawnSync(process.execPath, ['--test', 'rules.test.mjs'], { cwd: work, encoding: 'utf8' });
const out = r.stdout + r.stderr;
const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const NEEDS_REAL_RULES = [/^L14 /];
const unexpected = failed.filter((n) => !NEEDS_REAL_RULES.some((re) => re.test(n)));
console.log(out.match(/^# (tests|pass|fail) .*$/gm).join('\n'));
if (unexpected.length) { console.error('JavaScript-level failures:\n' + unexpected.join('\n')); process.exit(1); }
console.log('OK: no JavaScript-level failures (rules NOT evaluated — run `npm run test:rules` for that).');
