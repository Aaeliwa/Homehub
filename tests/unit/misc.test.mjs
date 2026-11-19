import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../../src/core/firebase/paths.js';
import { parseRoute } from '../../src/core/router/router.js';
import { validateDisplayName, validateHomeName, validateEmail, isCurrencyCode, isWeekday } from '../../src/core/utils/validate.js';

test('paths build canonical locations and reject unsafe segments', () => {
  assert.equal(paths.member('h1', 'u1').join('/'), 'homes/h1/members/u1');
  assert.equal(paths.role('h1', 'owner').join('/'), 'homes/h1/roles/owner');
  assert.equal(paths.setting('h1', 'general').join('/'), 'homes/h1/settings/general');
  assert.equal(paths.homeDoc('h1', 'expenses', 'e1').join('/'), 'homes/h1/expenses/e1');
  for (const bad of ['', 'a/b', '..', undefined, null, 42]) assert.throws(() => paths.home(bad));
});

test('router parses known routes and redirects unknown ones', () => {
  assert.equal(parseRoute('').name, 'dashboard');
  assert.equal(parseRoute('#/settings').name, 'settings');
  assert.deepEqual(parseRoute('#/m/expenses').params, { moduleId: 'expenses' });
  assert.equal(parseRoute('#/m/../etc').name, 'dashboard');
  assert.equal(parseRoute('#/nope').redirected, true);
});

test('validators', () => {
  assert.equal(validateDisplayName(' A '), null);
  assert.ok(validateDisplayName('   '));
  assert.ok(validateDisplayName('x'.repeat(61)));
  assert.ok(validateHomeName(''));
  assert.equal(validateEmail('a@b.co'), null);
  assert.ok(validateEmail('nope'));
  assert.ok(isCurrencyCode('EGP') && !isCurrencyCode('egp') && !isCurrencyCode('EGPP'));
  assert.ok(isWeekday(6) && !isWeekday(7) && !isWeekday(1.5));
});
