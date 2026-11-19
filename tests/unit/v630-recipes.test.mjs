// V6.3 Recipes AI JSON import: envelope / template / example round-trip, strict validation of untrusted
// input, duplicates (file + cookbook), chunk-free per-item writes, retry without duplicates, imported
// recipes identical to manual ones (steps, timers, video).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewImport, checkItem, EXAMPLE, TEMPLATE, buildPrompt, IMPORT_LIMITS, PROTECTED_KEYS } from '../../src/modules/chef/recipe-import.js';
import { validateRecipe, createDoc } from '../../src/modules/chef/recipe-model.js';
import { createChefStore } from '../../src/modules/chef/chef-store.js';

const env = (items, extra = {}) => JSON.stringify({ schema: 'homehub.recipes', version: 1, items, ...extra });
const ok = (over = {}) => ({ titleEn: 'Pancakes', ingredients: [{ name: 'Flour', amount: '1 1/2', unit: 'cup' }], steps: [{ text: 'Mix', minutes: null }, { text: 'Fry', minutes: 3 }], ...over });

test('V630 import: example and template are valid and round-trip; prompt documents the exact schema', () => {
  for (const doc of [EXAMPLE, TEMPLATE]) {
    const p = previewImport(JSON.stringify(doc));
    assert.equal(p.ok, true); assert.deepEqual(p.items.map((i) => i.status), ['ready']);
    assert.deepEqual(validateRecipe(p.items[0].input).errors, {});
  }
  const ex = previewImport(JSON.stringify(EXAMPLE)).items[0];
  assert.ok(ex.input.notes.includes('salt'), 'review flags kept in notes'); assert.ok(ex.warnings.some((w) => w.startsWith('flag:')));
  const v = validateRecipe(ex.input).value;
  assert.equal(v.steps.length, 3); assert.equal(v.steps[2].minutes, 25, 'step timer kept'); assert.equal(EXAMPLE.items[0].videoUrl, null, 'V6.3.0.1: no unrelated sample video'); assert.equal(v.videoId, null);
  const withVideo = previewImport(env([ok({ videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' })])).items[0];
  assert.equal(validateRecipe(withVideo.input).value.videoId, 'abcdefghijk', 'a real YouTube link is still embedded');
  const prompt = buildPrompt();
  for (const s of ['"homehub.recipes"', 'needInput', '"review"', '"minutes"', 'JSON ONLY']) assert.ok(prompt.includes(s), s);
});

test('V630 import: one or many recipes; mixed validity; deterministic ids per preview', () => {
  const text = env([ok(), ok({ titleEn: 'Soup' }), ok({ titleEn: '', titleAr: null }), ok({ titleEn: 'Bad', steps: [{ text: 'x', minutes: 0 }] })]);
  const p = previewImport(text, { nonce: 'n1' });
  assert.deepEqual(p.items.map((i) => i.status), ['ready', 'ready', 'invalid', 'invalid']);
  assert.deepEqual(p.items[3].errors, ['minutes:steps[0]']);
  assert.deepEqual(previewImport(text, { nonce: 'n1' }).items.map((i) => i.id), p.items.map((i) => i.id), 'same input → same ids (retry-safe)');
  assert.ok(p.items[0].id.match(/^ai_[0-9a-f]{16}$/) && p.items[0].id.length >= 6 && p.items[0].id.length <= 40, 'fits the rules id pattern');
  // V6.3.0.1: ids no longer depend on the preview session / device
  assert.deepEqual(previewImport(text, { nonce: 'other-device' }).items.map((i) => i.id), p.items.map((i) => i.id), 'same recipe → same id everywhere');
});

test('V630 import: untrusted input refused — envelope, protected / unknown fields, unsafe URLs, bounds, size', () => {
  const err = (t) => previewImport(t).error;
  assert.equal(err(''), 'empty'); assert.equal(err('{oops'), 'json'); assert.equal(err('[1]'), 'envelope');
  assert.equal(err(env([ok()], { admin: true })), 'envelopeKeys');
  assert.equal(err(JSON.stringify({ schema: 'x', version: 1, items: [ok()] })), 'schema');
  assert.equal(err(JSON.stringify({ schema: 'homehub.recipes', version: 2, items: [ok()] })), 'version');
  assert.equal(err(env([])), 'noItems');
  assert.equal(err(env(Array.from({ length: IMPORT_LIMITS.items + 1 }, (_, i) => ok({ titleEn: `R${i}` })))), 'tooMany');
  assert.equal(err(env([ok({ notes: 'x'.repeat(IMPORT_LIMITS.bytes) })])), 'tooLarge');
  assert.equal(err(JSON.stringify({ needInput: 'transcript of https://youtu.be/x' })), 'needInput');
  for (const k of ['id', 'createdBy', 'rev', 'favoritedBy', 'ownerUid', 'permissions', 'videoId']) {
    assert.ok(PROTECTED_KEYS.includes(k)); assert.ok(checkItem(ok({ [k]: 'x' })).errors.includes(`protected:${k}`), k);
  }
  assert.ok(checkItem(ok({ html: '<b>' })).errors.includes('unknownField:html'));
  assert.ok(checkItem(ok({ ingredients: [{ name: 'a', unit: 'cup', __proto__x: 1 }] })).errors.some((e) => e.startsWith('unknownField:ingredients[0]')));
  for (const u of ['javascript:alert(1)', 'http://example.com/v', 'data:text/html,x', 'https://user:pw@evil.com/', 'ftp://x']) assert.ok(checkItem(ok({ videoUrl: u })).errors.includes('videoUrl'), u);
  assert.deepEqual(checkItem(ok({ videoUrl: 'https://vimeo.com/123' })).errors, [], 'safe https link allowed');
  for (const [k, v] of [['servings', 0], ['servings', 101], ['prepMinutes', -1], ['cookMinutes', 1441], ['category', 'poison'], ['servings', '4']]) assert.ok(checkItem(ok({ [k]: v })).errors.length, `${k}=${v}`);
  assert.ok(checkItem(ok({ ingredients: [{ name: 'a', amount: 'lots', unit: 'cup' }] })).errors.includes('amount:ingredients[0]'));
  assert.ok(checkItem(ok({ ingredients: [{ name: 'a', amount: 1, unit: 'oz' }] })).errors.includes('unit:ingredients[0]'));
  const xss = checkItem(ok({ titleEn: '<img src=x onerror=alert(1)>' }));
  assert.deepEqual(xss.errors, [], 'stored as plain text (rendered with textContent, never HTML)');
});

test('V630 import: duplicates in file and cookbook are found, not selected, and never overwrite', () => {
  const existing = [{ id: 'rec001', titleEn: 'Pancakes', titleAr: '' }, { id: 'rec002', titleEn: 'Other', videoId: 'dQw4w9WgXcQ' }];
  const p = previewImport(env([ok(), ok({ titleEn: 'Soup' }), ok({ titleEn: '  SOUP!! ' }), ok({ titleEn: 'New', videoUrl: 'https://youtu.be/dQw4w9WgXcQ' })]), { existing, nonce: 'n' });
  assert.deepEqual(p.items.map((i) => [i.status, i.selected, i.dupOf && (i.dupOf.id || i.dupOf.index)]),
    [['duplicate', false, 'rec001'], ['ready', true, undefined], ['duplicate', false, 1], ['duplicate', false, 'rec002']]);
});

function repo() {
  const db = new Map(); const ws = new Set(); const commits = []; let deny = () => false;
  const docs = (p) => [...db.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  return { db, commits, setDeny(f) { deny = f; }, now: () => 'N', newId: () => 'rec999',
    watchRecipes: (h, on) => { const f = () => on(docs('recipes/')); ws.add(f); queueMicrotask(f); return () => ws.delete(f); },
    watchTimers: (h, uid, on) => { const f = () => on([]); ws.add(f); queueMicrotask(f); return () => ws.delete(f); },
    exists: async (h, name, id) => db.has(`${name}/${id}`),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));
      for (const o of ops) {
        if (deny(o)) throw Object.assign(new Error('net'), { code: 'unavailable' });
        if (o.mode === 'set' && db.has(`${o.name}/${o.id}`)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });   // create-only, like the rules
      }
      for (const o of ops) { commits.push(`${o.mode}:${o.name}/${o.id}`); db.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...db.get(`${o.name}/${o.id}`), ...o.data }); }
      for (const f of ws) f();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('V630 import store: confirmed per-item creates; partial failure + retry = no duplicates; double run refused; same doc as a manual recipe', async () => {
  const r = repo(); const s = createChefStore({ homeId: 'H', uid: 'u1', repo: r, canViewRecipes: true, nowMs: () => 1 }); s.subscribe(() => {}); await tick();
  const p = previewImport(env([ok(), ok({ titleEn: 'Soup' }), ok({ titleEn: 'Stew' })]), { nonce: 'n' });
  const sel = p.items.filter((i) => i.selected);
  r.setDeny((o) => o.id === sel[1].id);
  const run = s.importRecipes(sel);
  await assert.rejects(s.importRecipes(sel), (e) => e.detail === 'recipes.import.busy');
  const r1 = await run;
  assert.deepEqual([r1.saved, r1.already, r1.failed.map((f) => f.id)], [2, 0, [sel[1].id]]);
  assert.equal(r1.failed[0].detail, 'recipes.import.network');
  r.setDeny(() => false); await tick();
  const r2 = await s.importRecipes(sel);   // retry everything: the two saved ones are recognised, never duplicated
  assert.deepEqual([r2.saved, r2.already, r2.failed.length], [1, 2, 0]);
  assert.equal([...r.db.keys()].filter((k) => k.startsWith('recipes/')).length, 3);
  const doc = r.db.get(`recipes/${sel[0].id}`);
  const manual = createDoc(validateRecipe(sel[0].input).value, { uid: 'u1', now: 'N' });
  const noIds = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'id' ? undefined : v)));
  assert.deepEqual(noIds(doc), noIds(manual), 'identical shape to a manually created recipe (owner/time set by HomeHub)');
  assert.equal(doc.steps[1].minutes, 3, 'per-step timer → Start Cooking timer');
  const bad = await s.importRecipes([{ id: 'ai_bad0000000000000', input: { titleEn: '' } }]);
  assert.deepEqual([bad.saved, bad.failed[0].detail], [0, 'recipes.import.invalid'], 'invalid never written');
});

test('V6301 import ids: two devices importing the same new recipe at once create ONE recipe; intentional copies stay separate; deleted ids never reused', async () => {
  const text = env([ok({ titleEn: 'Shakshuka' })]);
  const a = previewImport(text, { nonce: 'deviceA' }).items[0]; const b = previewImport(text, { nonce: 'deviceB' }).items[0];
  assert.equal(a.id, b.id, 'session-independent identity');
  const r = repo();
  const sA = createChefStore({ homeId: 'H', uid: 'u1', repo: r, canViewRecipes: true, nowMs: () => 1 });
  const sB = createChefStore({ homeId: 'H', uid: 'u2', repo: r, canViewRecipes: true, nowMs: () => 1 });
  sA.subscribe(() => {}); sB.subscribe(() => {}); await tick();
  const [ra, rb] = await Promise.all([sA.importRecipes([a]), sB.importRecipes([b])]);   // concurrent, different devices
  assert.equal(ra.saved + rb.saved, 1, 'exactly one created'); assert.equal(ra.already + rb.already, 1, 'the other is recognised, not duplicated');
  assert.equal([...r.db.keys()].filter((k) => k.startsWith('recipes/')).length, 1);
  // an intentional separate copy (ticked duplicate) gets its own, also deterministic, id
  const existing = [{ id: a.id, titleEn: 'Shakshuka' }];
  const dup = previewImport(text, { existing }).items[0];
  assert.equal(dup.status, 'duplicate'); assert.notEqual(dup.id, a.id); assert.equal(dup.id, previewImport(text, { existing, nonce: 'x' }).items[0].id);
  const twoInFile = previewImport(env([ok({ titleEn: 'Shakshuka' }), ok({ titleEn: 'Shakshuka' })])).items;
  assert.notEqual(twoInFile[0].id, twoInFile[1].id, 'two ticked copies in one file are two recipes');
  // a deleted recipe keeps its id (create-only): a re-import gets the next id instead of colliding
  const re = previewImport(text, { existing: [], takenIds: [a.id] }).items[0];
  assert.equal(re.status, 'ready'); assert.notEqual(re.id, a.id);
  assert.match(re.id, /^ai_[0-9a-f]{16}$/);
});
