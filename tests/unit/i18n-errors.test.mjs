import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';
import { ErrorCode, toAppError } from '../../src/core/errors/app-error.js';
import { t, setLanguage } from '../../src/core/i18n/i18n.js';
import { SYSTEM_ROLE_IDS } from '../../src/core/permissions/roles.js';

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('Arabic and English have identical key sets', () => {
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
});

test('no empty translations', () => {
  for (const [k, v] of [...Object.entries(en), ...Object.entries(ar)]) assert.ok(String(v).trim(), k);
});

test('every literal t("…") key used in src exists', () => {
  const missing = [];
  for (const file of walk('src')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([^'$`]+)'/g)) if (!(m[1] in en)) missing.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('every error code has a title and body in both languages', () => {
  for (const code of Object.values(ErrorCode)) {
    for (const dict of [en, ar]) {
      assert.ok(dict[`error.${code}.title`], `error.${code}.title`);
      assert.ok(dict[`error.${code}.body`], `error.${code}.body`);
    }
  }
});

test('every system role has a label and description', () => {
  for (const id of SYSTEM_ROLE_IDS) assert.ok(en[`role.${id}`] && en[`roleDesc.${id}`] && ar[`role.${id}`] && ar[`roleDesc.${id}`]);
});

test('t() interpolates and falls back to English', () => {
  setLanguage('en');
  assert.equal(t('settings.permissionCount', { n: 5 }), '5 permissions');
  setLanguage('ar');
  assert.equal(t('nav.settings'), 'الإعدادات');
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('Firebase error codes map to friendly app errors', () => {
  assert.equal(toAppError({ code: 'auth/invalid-credential' }).code, ErrorCode.INVALID_CREDENTIALS);
  assert.equal(toAppError({ code: 'auth/wrong-password' }).code, ErrorCode.INVALID_CREDENTIALS);
  assert.equal(toAppError({ code: 'auth/too-many-requests' }).code, ErrorCode.TOO_MANY_ATTEMPTS);
  assert.equal(toAppError({ code: 'auth/network-request-failed' }).code, ErrorCode.NETWORK);
  assert.equal(toAppError({ code: 'permission-denied' }).code, ErrorCode.PERMISSION_DENIED);
  assert.equal(toAppError({ code: 'unavailable' }).code, ErrorCode.NETWORK);
  assert.equal(toAppError({ code: 'auth/something-new' }).code, ErrorCode.AUTH_FAILED);
  assert.equal(toAppError(new Error('x')).code, ErrorCode.UNKNOWN);
});
