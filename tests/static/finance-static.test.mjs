/** Phase 4 static guards: paths, layering, rules ↔ model, privacy query shapes, discipline. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_IDS, ALL_PAYMENT_METHODS, WALLET_TYPES } from '../../src/modules/expenses/finance-model.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';

const read = (p) => readFileSync(p, 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const DIR = 'src/modules/expenses';
const files = readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => join(DIR, f));
const rules = read('firestore.rules');
const rulesCode = rules.replace(/\/\/.*$/gm, '');
const block = (name) => { const at = rulesCode.indexOf(`match /${name}/{`); return rulesCode.slice(at, rulesCode.indexOf('allow delete: if false;', at) + 25); };
const PURE = ['money.js', 'calendar.js', 'recurrence.js', 'finance-model.js', 'ledger.js', 'import-model.js', 'finance-store.js', 'collections.js'];

test('finance collections live under homes/{h} only; every one denies delete', () => {
  const homesAt = rulesCode.indexOf('match /homes/{h}');
  for (const n of ['wallets', 'expenses', 'walletMovements', 'spendingCycles', 'commitments']) {
    const at = rulesCode.indexOf(`match /${n}/{`);
    assert.ok(at > homesAt, `${n} nested in homes`);
    assert.equal(rulesCode.match(new RegExp(`match /${n}/`, 'g')).length, 1, `${n} matched once`);
    assert.match(block(n), /allow delete: if false;/, `${n} no hard delete`);
  }
  assert.match(code(join(DIR, 'finance-repository.js')), /paths\.homeCollection\(homeId, name\)/);
});

test('privacy: reads require membership AND (household+view OR reader); listeners use provable constraints', () => {
  assert.match(rules, /function canReadFinance\(h, d\) \{(?:\s*\/\/[^\n]*)*\s*return isActiveMember\(h\)\s*&& \(\(d\.get\('audience', ''\) == 'household' && can\(h, 'expenses', 'view'\)\)\s*\|\| request\.auth\.uid in d\.readers\);/);
  for (const n of ['expenses', 'walletMovements', 'spendingCycles', 'commitments', 'budgetPeriods', 'budgetHead', 'financeMonthly']) assert.match(block(n), /allow get, list: if canReadFinance\(h, resource\.data\);/);   // V6: + budgetPeriods, budgetHead
  assert.match(block('wallets'), /resource\.data\.get\('visibility', ''\) == 'household' && can\(h, 'expenses', 'view'\)\)\s*\|\| request\.auth\.uid in resource\.data\.readers/);
  const repo = code(join(DIR, 'finance-repository.js'));
  assert.match(repo, /'audience', '==', 'household'/);
  assert.match(repo, /\['readers', 'array-contains', uid\]/);
  assert.ok(!/readCollection|watchCollection\(/.test(repo), 'no unconstrained finance reads');
  assert.ok(!/owner|isOwner\(h\)/.test(block('wallets').replace(/ownerUid/g, '')), 'no implicit owner access to private wallets');
});

test('identity fields are never trusted from the client', () => {
  for (const n of ['wallets', 'expenses', 'walletMovements', 'spendingCycles', 'commitments']) {
    const b = block(n);
    assert.match(b, /incoming\(\)\.createdBy == request\.auth\.uid/, `${n} createdBy`);
    assert.match(b, /stampedNow\('createdAt'\)/, `${n} server createdAt`);
  }
  assert.match(block('wallets'), /incoming\(\)\.ownerUid == request\.auth\.uid && can\(h, 'expenses', 'personal'\)\)\s*\|\| can\(h, 'expenses', 'manageWallets'\)/);
  // Phase 5.1.1: list concatenation must use .concat() — `[a] + b` is NOT supported by the rules
  // engine (evaluation error ⇒ every legitimate personal-wallet write was denied).
  assert.match(block('wallets'), /readers\.toSet\(\) == \[incoming\(\)\.ownerUid\]\.concat\(incoming\(\)\.sharedWith\)\.toSet\(\)/);
  assert.match(block('expenses'), /!\('createdBy' in changed\(\)\) && !\('createdAt' in changed\(\)\)/);
});

test('no silent currency conversion; payment link deterministic', () => {
  const mv = block('walletMovements');
  // Phase 5.2.1: transfers dispatch to mvTransferOk, which binds both wallets once and requires
  // BOTH currencies to equal the movement's currency (no silent conversion).
  assert.match(mv, /incoming\(\)\.type == 'transfer' \? mvTransferOk\(h, incoming\(\)\)/);
  assert.match(rules, /mvTransferW\(h, d, walletAfter\(h, d\.fromWalletId\), walletAfter\(h, d\.toWalletId\)\)/);
  assert.match(rules, /A\.currency == d\.currency && B\.currency == d\.currency/);
  assert.match(block('expenses'), /expenseId == payExpenseId\(incoming\(\)\.commitmentId, incoming\(\)\.commitmentDueDate\)/);
  assert.match(block('commitments'), /existsAfter\(expensePath\(h, payExpenseId\(commitmentId, resource\.data\.nextDueDate\)\)\)/);
});

test('rules ↔ model lists identical', () => {
  const list = (fn) => [...rules.match(new RegExp(`function ${fn}\\(\\) \\{ return \\[([^\\]]+)\\]`))[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(list('financeCategories'), [...CATEGORY_IDS]);
  assert.deepEqual(list('paymentMethods'), [...ALL_PAYMENT_METHODS]);
  assert.deepEqual(list('walletTypes'), [...WALLET_TYPES]);
});

test('layering: pure core has no Firebase; UI never touches the repository', () => {
  for (const f of PURE) assert.ok(!/core\/data\/|firebase\/sdk|finance-repository/.test(code(join(DIR, f))), f);
  for (const f of files.filter((x) => !PURE.includes(x.split('/').pop()) && !/finance-(repository|service)/.test(x))) {
    assert.ok(!/finance-repository|core\/data\//.test(code(f)), f);
  }
  assert.ok(!/finance-store|finance-repository|expenses\//.test(code('src/ui/pages/dashboard-page.js')), 'dashboard consumes widget only');
});

test('money is integer minor units (no parseFloat / toFixed accumulation in finance code)', () => {
  for (const f of files) assert.ok(!/parseFloat\(|Number\.parseFloat/.test(code(f)), f);
  assert.match(rules, /function expenseContentOk\(d\) \{\s*return isMoney\(d\.amountMinor\)/);
  assert.match(block('expenses'), /expenseContentOk\(incoming\(\)\)/);
  assert.match(rules, /function isMoney\(v\) \{ return v is int && v >= 0/);
});

test('every category, payment method, wallet type has ar + en labels', () => {
  const keys = [...CATEGORY_IDS.map((c) => `finance.category.${c}`), ...ALL_PAYMENT_METHODS.map((p) => `finance.payment.${p}`), ...WALLET_TYPES.map((w) => `finance.walletType.${w}`)];
  for (const k of keys) { assert.ok(en[k], `en ${k}`); assert.ok(ar[k], `ar ${k}`); }
});

test('RTL-safe finance CSS; theme variables only', () => {
  const css = read('assets/css/modules/finance.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(margin|padding|border)-(left|right)\b/.test(css));
  assert.ok(!/(^|[;{\s])(left|right)\s*:/.test(css));
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css), 'no hard-coded colours');
});

test('phase discipline: no Life Savings / Zakat / gold implementation; no Storage; no other modules started', () => {
  const all = files.map(code).join('\n');
  // Phase 5: Finance may name the 'zakat' expense category (deliberate payment link) but holds
  // no Nisab / karat / gold-price logic — that belongs to the savings module.
  assert.ok(!/nisab|savingsGoal|goldPrice|karat|hawl/i.test(all));
  assert.ok(!/match \/(savings|zakat|assets|inventory|shopping)\//.test(rulesCode));   // Phase 5.3: cleaning; 5.5: maintenance have their own rules
  // Phase 5.5: Maintenance implemented; the other planned modules must still not have started.
  for (const m of ['inventory', 'shopping', 'mealPlanner']) assert.deepEqual(readdirSync(`src/modules/${m}`), ['module.js']);   // V6.1: chef (Recipes) implemented; Meal Planner still NOT started
  // Phase 5.5: maintenance costs are metadata only — no Finance store / repository import, no finance writes.
  for (const f of readdirSync('src/modules/maintenance')) {
    const c = readFileSync(`src/modules/maintenance/${f}`, 'utf8');
    assert.ok(!/finance-(store|repository|service|model)|ledger\.js|tab-wallets|['"](expenses|wallets|walletMovements|commitments|spendingCycles|budgetAdjustments|savingsAssets|zakatRecords)['"]/.test(c), `maintenance/${f} touches Finance`);
  }
  for (const blk of rulesCode.split('match /').filter((b) => /^maintenance/.test(b))) assert.ok(!/expenses|wallet|savings|zakat|commitment/.test(blk.slice(0, 2500)), 'maintenance rules reference no finance paths');
});
