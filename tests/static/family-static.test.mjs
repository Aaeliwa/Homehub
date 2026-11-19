/** Phase 4A static guards: invites, membership rules, single auth lifecycle, no fake data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const read = (p) => readFileSync(p, 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rules = read('firestore.rules');
const rc = rules.replace(/\/\/.*$/gm, '');
const block = (start) => { const at = rc.indexOf(start); return rc.slice(at, rc.indexOf('allow delete: if false;', at) + 25); };
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []));

test('one auth observer; sign-up goes through the existing auth service', () => {
  const src = walk('src').map((f) => [f, code(f)]);
  assert.deepEqual(src.filter(([, c]) => /onAuthStateChanged\(/.test(c)).map(([f]) => f), [join('src', 'core', 'auth', 'auth-service.js')]);
  assert.deepEqual(src.filter(([, c]) => /createUserWithEmailAndPassword\(/.test(c)).map(([f]) => f), [join('src', 'core', 'auth', 'auth-service.js')]);
  assert.ok(!src.some(([, c]) => /password\s*:/.test(c) && /setDoc|\.set\(/.test(c)), 'never store passwords');
});

test('invites: top-level, code-format guarded, no listing for outsiders, no delete', () => {
  const b = block('match /invites/{code}');
  assert.match(b, /allow get: if signedIn\(\) && code\.matches\('\^\[A-Z2-9\]\{24\}\$'\)/);
  assert.match(b, /allow list: if signedIn\(\) && can\(resource\.data\.homeId, 'members', 'invite'\)/);
  assert.match(b, /incoming\(\)\.createdBy == request\.auth\.uid/);
  assert.match(b, /canAssignRole\(incoming\(\)\.homeId, incoming\(\)\.roleId\)/);
  assert.match(b, /incoming\(\)\.acceptedBy == request\.auth\.uid/);
  assert.match(b, /request\.time\.toMillis\(\) < resource\.data\.expiresAtMillis/);
  assert.match(b, /resource\.data\.status == 'pending'/, 'single use');
  assert.match(b, /incoming\(\)\.expiresAtMillis <= request\.time\.toMillis\(\) \+ 1209600000/, 'max 14 days');
  assert.match(b, /allow delete: if false;/);
});

test('membership: invite join copies role/relationship/guardians; owner never demoted/removed; delete denied', () => {
  // Phase 5.1.1: the invitation is bound once (I) — role still copied from the stored invite.
  assert.match(rules, /joinsByInviteI\(h, u, d, inv\(d\.inviteCode\)\)/);
  assert.match(rules, /d\.roleId == I\.roleId/);
  assert.match(rules, /d\.relationship == I\.relationship/);
  assert.match(rules, /d\.guardianUids == I\.guardianUids/);
  assert.match(rules, /I\.homeId == h/);
  const m = block('match /members/{u}');
  assert.match(m, /incoming\(\)\.status == 'removed'[^|]*resource\.data\.roleId != 'owner'/);
  assert.match(m, /incoming\(\)\.status == 'left' && changed\(\)\.hasOnly\(\['status', 'updatedAt'\]\)[^|]*resource\.data\.roleId != 'owner'/);
  assert.match(m, /allow delete: if false;/);
  assert.ok(!/(?<!!)isSelf\(u\) && can\(h, 'members', 'edit'\)/.test(m), 'no self role edit path');
});

test('canAssignRole forbids owner and requires lower rank for non-owners', () => {
  assert.match(rules, /function canAssignRole\(h, r\) \{\s*return r != 'owner' && exists\(roleDoc\(h, r\)\) && \(isOwner\(h\) \|\| rankOf\(h, r\) < myRank\(h\)\);/);
});

test('finance privacy unchanged: owner has no implicit private-wallet access', () => {
  assert.match(rules, /function canReadFinance\(h, d\) \{(?:\s*\/\/[^\n]*)*\s*return isActiveMember\(h\)/);
  assert.ok(!/isOwner\(h\)/.test(block('match /wallets/{walletId}').replace(/ownerUid/g, '')));
});

test('no fake family data; codes from crypto, never Math.random', () => {
  const fam = walk('src/core/family').map(code).join('\n');
  assert.ok(!/Math\.random/.test(fam));
  assert.match(code('src/core/family/invite-model.js'), /crypto\.getRandomValues/);
  for (const f of walk('src')) assert.ok(!/(Sara|Omar|Tamim)['"]/.test(code(f)), `no seeded family names in ${f}`);
});

test('RTL-safe family CSS, theme variables only', () => {
  const css = read('assets/css/modules/family.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(margin|padding|border)-(left|right)\b/.test(css) && !/(^|[;{\s])(left|right)\s*:/.test(css) && !/#[0-9a-f]{3,6}\b/i.test(css));
});

test('phase discipline: Zakat / Nisab logic lives only in the savings module (Phase 5)', () => {
  // Phase 4A pinned "no Life Savings at all"; Phase 5 adds it as its own module. Its logic must
  // not leak into core, Family or other modules (Finance may only NAME the 'zakat' category).
  const outside = walk('src').filter((f) => !f.includes(join('src', 'modules', 'savings')) && !f.includes(join('src', 'core', 'i18n')));
  for (const f of outside) assert.ok(!/nisab|hawl|goldPrice|zakatRecords/i.test(code(f)), f);
});

test('regression: no `null` passed to DOM replaceChildren (it renders the text "null")', () => {
  // Split each replaceChildren(...) call into TOP-LEVEL arguments (respecting (), [], {}, quotes)
  // and flag any argument whose top-level ternary ends in `: null`. Nulls nested inside h(...)
  // are fine: h() skips them.
  for (const f of walk('src')) {
    const c = code(f);
    let at = c.indexOf('replaceChildren(');
    while (at >= 0) {
      let k = at + 'replaceChildren('.length; let depth = 0; let quote = null; let cur = ''; const args = [];
      for (; k < c.length; k++) {
        const ch = c[k];
        if (quote) { cur += ch; if (ch === quote && c[k - 1] !== '\\') quote = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
        if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
        cur += ch;
      }
      args.push(cur);
      for (const a of args) assert.ok(!/:\s*null\s*$/.test(a.trim()), `${f}: replaceChildren argument may be null → ${a.trim().slice(-60)}`);
      at = c.indexOf('replaceChildren(', k);
    }
  }
});

// Phase 4A regression: main.js must not statically reach the Firebase SDK (Phase 1 guarantee:
// an unreachable SDK shows "HomeHub can't connect" instead of a dead page).
test('main.js static import graph never reaches the Firebase SDK', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return; seen.add(file);
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/gstatic\.com\/firebasejs/.test(src), `static path from main.js reaches the SDK via ${file}`);
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) visit(join(dirname(file), m[1]));
  };
  visit('src/main.js');
  assert.ok(seen.size > 10);
});
