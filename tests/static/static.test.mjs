/**
 * Static architecture guards. These enforce the Phase 1 decisions that must not regress:
 * one Firebase init, one SDK import point, no legacy/migration code, no hard-coded
 * identities, no HTML injection paths, layering between UI and data access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

function walk(dir, exts = ['.js']) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, exts) : exts.some((e) => p.endsWith(e)) ? [p] : [];
  });
}
const SRC = walk('src');
const read = (p) => readFileSync(p, 'utf8');
/** Source with comments removed (for checks about code, not documentation). */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const grep = (files, re) => files.filter((f) => re.test(read(f)));
const grepCode = (files, re) => files.filter((f) => re.test(code(f)));

test('no legacy / migration / V4 compatibility code in app, rules or config', () => {
  const files = [...SRC, ...walk('assets', ['.css']), 'index.html', 'firestore.rules', 'firebase.json'];
  // Phase 2: bare "archive" is now a legitimate Rooms feature (soft archive). What stays
  // banned is V4-style archive COLLECTIONS/paths, plus every other legacy concept.
  const re = /migration|legacy|hr_homes|hr_users|\bv4\b|canonical|compat(ibility)?\b|ownerId|runtime-lock|archives?\/|archive_|_archive|archiveCollection|\bB[12]\b/i;
  // Phase 5.1: the one sanctioned exception is the narrowly scoped "legacy Home adoption"
  // feature (adopting the creator's own pre-membership Home). Only its exact vocabulary is
  // stripped before matching; V4 paths/collections, ownerId, migration, compat code and every
  // other use of "legacy" remain banned.
  const ADOPTION = /LEGACY_HOME_ADOPTION_(?:REQUIRED|BLOCKED)|NOT_LEGACY|LegacyState|(?:classify|detect|adopt)LegacyHome|isLegacyAdoption|legacyAdoption|legacyMissingFields|legacyScreen|legacy-adoption(?:-service)?\.js|legacy-(?:upgrade|title|body|home|points)|'legacy\.(?:upgrade|upgrading|point\.(?:same|data|once))'|\blegacy\.(?:state|reason|home|existingRoleIds)\b|const legacy =|[Ll]egacy (?:[Hh]ome|HOME|detection|error)|LEGACY HOME/g;
  // The exception must not blunt the guard: real legacy concepts are still caught.
  for (const bad of ["collection('hr_homes')", 'data.ownerId', 'migrateLegacyData()', "path('legacy/homes')", 'v4 compat layer']) {
    assert.ok(re.test(bad.replace(ADOPTION, '')), `guard still flags: ${bad}`);
  }
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (re.test(line.replace(ADOPTION, ''))) hits.push(`${f}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(hits, []);
});

test('no hard-coded user ids, emails or home ids', () => {
  const files = [...SRC, 'firestore.rules', 'index.html'];
  assert.deepEqual(grep(files, /P6B9sjmz5eQcmuE1j9nd4q5Ret82|abdo\.adel1994/i), []);
});

test('the Firebase SDK is imported in exactly one file', () => {
  assert.deepEqual(grep(SRC, /gstatic\.com\/firebasejs/), [join('src', 'core', 'firebase', 'sdk.js')]);
});

test('initializeApp is called in exactly one place', () => {
  assert.deepEqual(grep(SRC, /initializeApp\(/), [join('src', 'core', 'firebase', 'firebase.js')]);
});

test('only core/firebase, core/data and core/auth touch the SDK wrapper', () => {
  const users = grep(SRC, /from '[^']*firebase\/sdk\.js'|import\(\s*'[^']*sdk\.js'/).sort();
  for (const f of users) assert.match(f, /src\/core\/(firebase|data|auth)\//, f);
});

test('UI never talks to Firestore directly', () => {
  const ui = SRC.filter((f) => f.startsWith(join('src', 'ui')));
  assert.deepEqual(grep(ui, /data\/firestore\.js|firebase\/sdk\.js|firebase\/firebase\.js|auth-service\.js/), []);
});

test('no HTML-injection sinks or eval', () => {
  assert.deepEqual(grepCode(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/), []);
});

test('no global mutable window.* state and no stray console.log', () => {
  assert.deepEqual(grep(SRC, /window\.[A-Za-z_$][\w$]*\s*=[^=]/), []);
  assert.deepEqual(grep(SRC.filter((f) => !f.endsWith('logger.js')), /console\.log\(/), []);
});

test('no Admin SDK or service-account material anywhere', () => {
  const files = [...SRC, 'index.html', 'firebase.json', 'package.json'];
  assert.deepEqual(grep(files, /firebase-admin|private_key|service_account|serviceAccount/), []);
});

test('browser storage limited to preference cache and debug flag', () => {
  const users = grepCode(SRC, /localStorage|sessionStorage/).sort();
  assert.deepEqual(users, [join('src', 'boot-prefs.js'), join('src', 'core', 'settings', 'preferences.js'), join('src', 'core', 'utils', 'logger.js')].sort());
});

test('every relative import resolves to a file', () => {
  const missing = [];
  for (const f of SRC) {
    for (const m of code(f).matchAll(/(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+)'/g)) {
      const target = resolve(dirname(f), m[1]);
      if (!existsSync(target)) missing.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('index.html references existing local assets', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="((?:src|assets)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 6);
  for (const r of refs) assert.ok(existsSync(r), r);
});

test('planned module directories contain registration metadata only', () => {
  // Phase 2: rooms; Phase 3: devices; Phase 4: expenses (finance); Phase 5: savings. Others: metadata only.
  const IMPLEMENTED = new Set(['rooms', 'devices', 'expenses', 'savings', 'cleaning', 'maintenance', 'chef', 'calendar', 'contacts']);   // V6.4 B: + contacts   // V6.2: + calendar   // + 5.3 cleaning; 5.5 maintenance; V6.1 chef (Recipes)
  for (const dir of readdirSync('src/modules').filter((d) => statSync(join('src/modules', d)).isDirectory())) {
    if (IMPLEMENTED.has(dir)) continue;
    assert.deepEqual(readdirSync(join('src/modules', dir)), ['module.js'], dir);
  }
});

test('firestore.rules: balanced, every helper defined, default deny, no legacy matches', () => {
  const rules = read('firestore.rules');
  const code = rules.replace(/\/\/.*$/gm, '');
  for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    assert.equal(code.split(o).length, code.split(c).length, `balanced ${o}${c}`);
  }
  const defined = new Set([...code.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]));
  const builtins = new Set(['get', 'exists', 'getAfter', 'existsAfter', 'function', 'if', 'hasAll', 'hasOnly', 'hasAny', 'keys', 'size', 'trim', 'matches', 'diff', 'affectedKeys',
    // Phase 5.3: string() is a genuine rules built-in (int → string for deterministic ids).
    'string',
    // Phase 5.4a: int() is a genuine rules built-in (date parts for server-time bounds).
    'int']);
  const called = [...code.matchAll(/(?<![.\w])([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]);
  const undefinedCalls = [...new Set(called.filter((n) => !defined.has(n) && !builtins.has(n)))];
  assert.deepEqual(undefinedCalls, []);
  assert.ok(!/allow\s+[\w, ]+:\s*if\s+true/.test(code), 'no unconditional allow');
  assert.ok(!/match\s+\/\{document=\*\*\}[^}]*allow[^}]*if\s+(?!false)/.test(code), 'no permissive recursive wildcard');
  // Phase 5.1: only the two adoption identifiers are exempt; any other "legacy", hr_ or migration stays banned.
  assert.ok(!/hr_|legacy|migration/i.test(code.replace(/\bisLegacyAdoption(?:Companion)?\b|\blegacyAdoption\b/g, '')));
});

test('rules and client agree on seeded role ids and permission grammar', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /\['owner', 'admin', 'member', 'viewer', 'child'\]/);
  assert.match(rules, /perms\.hasAny\(\['\*', ns \+ '\.\*', ns \+ '\.' \+ action\]\)/);
});

// Phase 5.1: legacy Home adoption seeds the CURRENT role template; rules and code must agree.
test('legacy adoption: rules template version equals ROLE_TEMPLATE_VERSION; bootstrap unchanged', async () => {
  const { ROLE_TEMPLATE_VERSION } = await import('../../src/core/permissions/roles.js');
  const rules = read('firestore.rules');
  assert.match(rules, new RegExp(`function adoptionTemplateVersion\\(\\) \\{ return ${ROLE_TEMPLATE_VERSION}; \\}`));
  assert.match(rules, /function isBootstrap\(h\) \{\s*return signedIn\(\)\s*&& !exists\(homeDoc\(h\)\)/, 'bootstrap still requires a brand-new home');
  // Adoption proves everything from STORED state and never trusts client createdBy.
  assert.match(rules, /get\(homeDoc\(h\)\)\.data\.get\('createdBy', ''\) == request\.auth\.uid/);
  assert.match(rules, /!exists\(roleDoc\(h, 'owner'\)\)/);
  assert.match(rules, /getAfter\(homeDoc\(h\)\)\.data == get\(homeDoc\(h\)\)\.data/);
  assert.ok(!/allow list: if[^;]*isUnadoptedCreator/.test(rules), 'no broad list for adoption');
});

// Phase 5.1.1 — regression guards found by the emulator run.
test('rules: no list addition with "+" (unsupported by the rules engine; use .concat())', () => {
  const code = read('firestore.rules').split('\n').map((l) => l.split('//')[0]).join('\n');
  // `] + x`, `) + [` and `x + [` are list additions; string concatenation like 'cm_' + id is fine.
  const bad = code.split('\n').filter((l) => /\]\s*\+\s*[A-Za-z_(\[]|\)\s*\+\s*\[|[A-Za-z_)]\s*\+\s*\[/.test(l));
  assert.deepEqual(bad, []);
  assert.match(code, /rd\(A\)\.concat\(rd\(B\)\)\.toSet\(\)/);
});
test('rules: hot paths evaluate each document once (expression-limit headroom)', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /function can\(h, ns, action\) \{[\s\S]*?canWith\(h, myMember\(h\), ns, action\)/);
  assert.match(rules, /savingsEventCreateOk\(h, eventId, incoming\(\), assetAfter\(h, incoming\(\)\.assetId\)\)/);
  assert.match(rules, /expenseWalletOkW\(h, d, walletAfter\(h, d\.walletId\), action\)/);
  assert.match(rules, /joinsByInviteI\(h, u, d, inv\(d\.inviteCode\)\)/);
});

// Phase 5.1.2 — rules-test-file pitfalls found by the emulator run (each caused real failures).
test('rules tests: never use withSecurityRulesDisabled\'s return value; one firestore() per context', () => {
  const src = read('tests/rules/rules.test.mjs');
  assert.ok(!/(=|\()\s*await env\.withSecurityRulesDisabled/.test(src), 'withSecurityRulesDisabled resolves to undefined');
  for (const m of src.matchAll(/withSecurityRulesDisabled\(async \((\w+)\) => \{/g)) {
    let i = m.index + m[0].length; let depth = 1; const start = i;
    while (depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    const body = src.slice(start, i);
    assert.ok(body.split(`${m[1]}.firestore()`).length - 1 <= 1, `callback calls ${m[1]}.firestore() more than once`);
  }
  assert.match(src, /^import assert from 'node:assert\/strict';$/m);
});
test('rules: privacy reads are query-safe (optional audience/visibility read with .get)', () => {
  const rules = read('firestore.rules');
  for (const fn of ['canReadFinance', 'canReadSavings']) assert.match(rules, new RegExp(`function ${fn}\\(h, d\\) \\{[\\s\\S]*?d\\.get\\('audience', ''\\) == 'household'`));
  assert.equal((rules.match(/resource\.data\.get\('visibility', ''\) == 'household'/g) || []).length, 2, 'wallets + savingsAssets');
  // Only READ paths are query-evaluated; write-path label checks (access0/accessW on incoming())
  // always have the fields (exactKeys) and stay as they are.
  for (const fn of ['canReadFinance', 'canReadSavings']) {
    const body = rules.slice(rules.indexOf(`function ${fn}(`), rules.indexOf('\n    }', rules.indexOf(`function ${fn}(`)));
    assert.ok(!/d\.audience ==/.test(body.split('\n').map((l) => l.split('//')[0]).join('\n')), fn);
  }
});

// Phase 5.1.3 regressions (real emulator findings).
test('rules: privacy reads never require `readers is list` (unprovable in a query → "mine" queries denied)', () => {
  const code = read('firestore.rules').split('\n').map((l) => l.split('//')[0]).join('\n');
  for (const fn of ['canReadFinance', 'canReadSavings']) {
    const body = code.slice(code.indexOf(`function ${fn}(`), code.indexOf('}', code.indexOf(`function ${fn}(`)));
    assert.ok(!/readers is list/.test(body), fn);
    assert.match(body, /request\.auth\.uid in d\.readers/);
  }
});
test('rules: adoption roles ride on the membership\'s full proof (atomic batch), not five re-proofs', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /isLegacyAdoptionCompanion\(h\) && incoming\(\)\.templateVersion == adoptionTemplateVersion\(\)/);
  assert.match(rules, /incoming\(\)\.legacyAdoption == true\s*&& isSelf\(u\) && isLegacyAdoption\(h\)/, 'membership still runs the FULL proof');
  const comp = rules.slice(rules.indexOf('function isLegacyAdoptionCompanion'), rules.indexOf('function isLegacyAdoption(h)'));
  for (const must of ['isUnadoptedCreator(h)', "!exists(roleDoc(h, 'owner'))", 'existsAfter(myMemberDoc(h))', "get('legacyAdoption', false) == true", "roleId == 'owner'"]) assert.ok(comp.includes(must), must);
});

// Phase 5.2 — Zakat sharing/revocation and payment linkage: pin the security shape.
test('rules: zakatRecords update changes ONLY readers, by owner or guardian; delete denied; payment links same-owner snapshot', () => {
  const r = read('firestore.rules');
  const b = r.slice(r.indexOf('match /zakatRecords/{recordId}'), r.indexOf('allow delete: if false;', r.indexOf('match /zakatRecords/{recordId}')) + 25);
  const code = b.split('\n').map((l) => l.split('//')[0]).join('\n');
  assert.match(code, /allow update: if changed\(\)\.hasOnly\(\['readers'\]\)/);
  assert.match(code, /\(resource\.data\.ownerUid == request\.auth\.uid \|\| isGuardianOf\(h, resource\.data\.ownerUid\)\)/);
  assert.match(code, /resource\.data\.ownerUid in incoming\(\)\.readers/);
  assert.match(code, /incoming\(\)\.readers\.hasAll\(get\(memberDoc\(h, resource\.data\.ownerUid\)\)\.data\.get\('guardianUids', \[\]\)\)/);
  assert.match(code, /membersOf\(h, incoming\(\)\.readers\.removeAll\(\[resource\.data\.ownerUid\]\)\)/);
  assert.ok(!/isOwner\(h\)|can\(h, 'members'/.test(code.slice(code.indexOf('allow update'))), 'no Home-owner/admin override');
  assert.match(code, /allow delete: if false;/);
  assert.match(r, /zakatSnapshotOfOwner\(getAfter\(zakatPath\(h, d\.snapshotId\)\)\.data, d\.ownerUid\)/);
  assert.match(r, /function zakatSnapshotOfOwner\(S, ownerUid\) \{ return S\.kind == 'snapshot' && S\.ownerUid == ownerUid; \}/);
});

// Phase 5.2.1 — expression-cost tripwires (exhaustive worst-case ESTIMATE; see tools/rules-cost.mjs).
// Real emulator denials evaluate every alternative; these keep rules from drifting back up.
test('rules: worst-case expression cost stays under the tripwires', async () => {
  const { execFileSync } = await import('node:child_process');
  const rows = JSON.parse(execFileSync(process.execPath, ['tools/rules-cost.mjs', 'firestore.rules', '--json'], { encoding: 'utf8' }));
  const over = rows.filter((r) => r.cost > 1100);
  assert.deepEqual(over, [], 'no allow statement above 1100');
  const cost = (path, op) => rows.find((r) => r.path === path && r.ops.split(',').includes(op)).cost;
  assert.ok(cost('/homes/{h}/zakatRecords/{recordId}', 'create') <= 600, 'zakatRecords create (failed Z6/Z7 at ~1270 incl. update)');
  assert.ok(cost('/homes/{h}/walletMovements/{movementId}', 'create') <= 750, 'walletMovements create (was 1618)');
  assert.ok(cost('/homes/{h}/members/{u}', 'create') <= 800, 'members create (hit the limit in real runs)');
});

test('Phase 5.6: only the reminders repository deletes (owner-only presentation state); no module deletes', () => {
  const users = SRC.filter((f) => /w\.delete\(|\.delete\(paths\.|mode: 'delete'|mode === 'delete'/.test(code(f)));
  // V6.1: + owner-only, ephemeral cooking timers (chef). Every other module still never deletes.
  assert.deepEqual(users.sort(), [join('src', 'core', 'reminders', 'reminders-repository.js'), join('src', 'core', 'reminders', 'reminders-store.js'),
    join('src', 'modules', 'chef', 'chef-repository.js'), join('src', 'modules', 'chef', 'chef-store.js'),
    // V6.4 B: contact CATEGORIES are removable labels (rules: contacts.manageCategories); contacts themselves are soft-deleted only.
    join('src', 'modules', 'contacts', 'contacts-repository.js'), join('src', 'modules', 'contacts', 'contacts-store.js')].sort());
});

test('Phase 5.6: the reminders bell count (and its listeners) runs only on Dashboard / Reminders / Cleaning / Maintenance', () => {
  const m = read(join('src', 'main.js'));
  assert.match(m, /const countHere = route\.name === 'dashboard' \|\| route\.name === 'reminders'\s*\|\| \(route\.name === 'module' && \(route\.params\.moduleId === 'cleaning' \|\| route\.params\.moduleId === 'maintenance'\)\);/);
  assert.match(m, /if \(instance\.bellEl && countHere\)/);
});


test('V6 batch 3: the clean-start dry run is READ-ONLY and Home-confirmed', () => {
  const src = read(join('tools', 'clean-start-dryrun.mjs')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual(src.match(/\.(set|update|delete|create|add|recursiveDelete|batch|bulkWriter|runTransaction)\s*\(/g) || [], [], 'no write / delete API');
  assert.match(src, /--confirm-name/); assert.match(src, /h\.data\(\)\.name !== confirm/);
  assert.match(src, /db\.doc\(`homes\/\$\{home\}`\)/, 'reads only under homes/{home}');
  assert.match(src, /export function buildCleanStartPlan/, 'the plan (exact paths) is a pure, unit-tested function');
});

test('V6.1: CSP restricts iframes to the YouTube player only and nothing else', () => {
  const m = read('index.html').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'CSP present');
  assert.equal(m[1], 'frame-src https://www.youtube-nocookie.com https://www.youtube.com', 'only frame-src, only YouTube origins');
});

