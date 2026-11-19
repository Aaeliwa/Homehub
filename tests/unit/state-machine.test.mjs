import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppState as S, canTransition } from '../../src/core/state/app-machine.js';
import { createStore } from '../../src/core/state/store.js';

test('READY is only reachable from RESOLVING_CONTEXT', () => {
  for (const from of Object.values(S)) {
    assert.equal(canTransition(from, S.READY), from === S.RESOLVING_CONTEXT, `${from} -> READY`);
  }
});

test('sign-out (AUTH_REQUIRED) is reachable from every state', () => {
  for (const from of Object.values(S)) assert.equal(canTransition(from, S.AUTH_REQUIRED), true);
});

test('invalid transitions are rejected and do not change state', () => {
  const store = createStore();
  assert.equal(store.get().status, S.BOOTING);
  assert.equal(store.transition(S.READY), false);
  assert.equal(store.get().status, S.BOOTING);
  assert.equal(store.transition(S.SETTING_UP), false);
});

test('store notifies subscribers with previous state', () => {
  const store = createStore();
  const seen = [];
  store.subscribe((s, prev) => seen.push(`${prev.status}->${s.status}`));
  store.transition(S.AUTH_REQUIRED);
  store.transition(S.AUTHENTICATING);
  assert.deepEqual(seen, ['BOOTING->AUTH_REQUIRED', 'AUTH_REQUIRED->AUTHENTICATING']);
});
