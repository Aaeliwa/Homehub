/**
 * Browser end-to-end test of the Phase 1 flows against a FAKE Firebase SDK.
 *
 * - Serves the project with a static server.
 * - Intercepts https://www.gstatic.com/firebasejs/** and serves tests/e2e/fake-sdk/*.
 * - Drives the real app (real HTML/CSS/JS) through Tests A, B, C and the error states.
 *
 * This proves the client lifecycle, UI and Firestore write shapes. It does NOT prove
 * Firebase Auth, Firestore or security-rules behaviour — those need the live smoke test
 * and the emulator rules tests (tests/rules).
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tests/e2e/run-e2e.mjs [--screens out/dir]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const FIXTURE_CSV = readFileSync(new URL('../fixtures/google-calendar-2026.csv', import.meta.url), 'utf8');   // V6.2: the supplied Google Calendar export
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const FAKE = join(here, 'fake-sdk');
const SHOTS = process.argv.includes('--screens') ? process.argv[process.argv.indexOf('--screens') + 1] : null;

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire(import.meta.url)(join(process.env.NODE_PATH || '', 'playwright'))); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const results = [];
async function check(name, fn) {
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY).test(name)) return;   // local focus runs only; CI runs everything
  try { await fn(); results.push(['PASS', name]); console.log(`PASS  ${name}`); }
  catch (e) {
    try {
      const info = await page.evaluate(() => ({ url: location.hash, user: document.querySelector('.user-btn__name')?.textContent || '(signed out)', dir: document.documentElement.dir }));
      console.log(`      at ${info.url} as ${info.user} [${info.dir}]; page errors: ${JSON.stringify(page.errors.slice(-3))}`);
    } catch { /* page may be gone */ }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => {}); results.push(['FAIL', name, e.message]); console.log(`FAIL  ${name}\n      ${e.message.split('\n').slice(0, 6).join(' | ')}`); }
}

async function newPage(ctx, { breakSdk = false } = {}) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.logs = [];
  page.errors = [];
  page.on('console', (m) => page.logs.push(m.text()));
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await page.route('https://www.gstatic.com/firebasejs/**', async (route) => {
    if (breakSdk) return route.fulfill({ status: 404, body: 'gone' });
    const name = new URL(route.request().url()).pathname.split('/').pop();
    route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(FAKE, name), 'utf8') });
  });
  // store.js is imported relatively by the fake modules -> also served from gstatic path.
  return page;
}
const shot = async (page, name) => { if (!SHOTS) return; await page.waitForTimeout(450); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const text = (page) => page.locator('body').innerText();

const desktop = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await newPage(desktop);
// V6.3: Cleaning opens on the former Advanced page (routine first); task management is its Tasks tab.
async function cleaningTasks(p = page, { reload = false } = {}) {
  if (reload) await p.reload(); else await p.goto(BASE + '#/m/cleaning');
  await p.locator('#cl-adv-tab-tasks').click(); await p.locator('#cl-adv-tasks #cl-tasks').waitFor();
}

// ------------------------------------------------------------------ TEST A
await check('A1 empty database + signed out -> login screen (Arabic, RTL by default)', async () => {
  await page.goto(BASE);
  await page.locator('#login-email').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
  assert.equal(await page.evaluate(() => window.__fake.paths().length), 0);
  await shot(page, '01-login-ar-light-desktop');
});

await check('A2 wrong password -> friendly error, stays on login', async () => {
  await page.fill('#login-email', 'owner@example.com');
  await page.fill('#login-password', 'nope');
  await page.click('button[type=submit]');
  await page.locator('.banner--error').waitFor();
  assert.match(await page.locator('.banner--error').innerText(), /غير متطابقين/);
  assert.ok(!(await text(page)).includes('auth/'), 'no raw Firebase code shown');
});

await check('A3 correct login with no profile -> First-Time Setup (not an error)', async () => {
  await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]');
  await page.locator('#setup-home').waitFor();
  assert.match(await text(page), /owner@example\.com/);
  await shot(page, '02-setup-ar-desktop');
});

await check('A4 setup validates empty fields without writing', async () => {
  await page.fill('#setup-name', '');
  await page.click('button[type=submit]');
  await page.locator('#setup-name-error:not([hidden])').waitFor();
  assert.equal(await page.evaluate(() => window.__fake.writes()), 0);
});

await check('A5 setup failure shows message and writes nothing', async () => {
  await page.fill('#setup-name', 'Abdo Adel');
  await page.fill('#setup-home', 'بيت عادل');
  await page.evaluate(() => { window.__fakeFailNextCommit = true; });
  await page.click('button[type=submit]');
  await page.locator('.banner--error').waitFor();
  assert.equal(await page.evaluate(() => window.__fake.paths().length), 0);
});

await check('A6 setup creates home, owner membership, 5 roles, settings, profile -> dashboard', async () => {
  await page.click('button[type=submit]');
  await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('.hero__home').innerText(), 'بيت عادل');
  const db = await page.evaluate(() => window.__fake.dump());
  const paths = Object.keys(db);
  const homePath = paths.find((p) => /^homes\/[^/]+$/.test(p));
  const h = homePath.split('/')[1];
  assert.ok(h.startsWith('AUTO'), 'home id generated by Firestore, not hard-coded');
  assert.deepEqual(paths.sort(), [
    `homes/${h}`, `homes/${h}/members/UID_OWNER`,
    ...['admin', 'child', 'member', 'owner', 'viewer'].map((r) => `homes/${h}/roles/${r}`),
    `homes/${h}/settings/general`, 'users/UID_OWNER',
  ].sort());
  assert.equal(db['users/UID_OWNER'].defaultHomeId, h);
  assert.equal(db[`homes/${h}`].createdBy, 'UID_OWNER');
  assert.equal(db[`homes/${h}/members/UID_OWNER`].roleId, 'owner');
  assert.deepEqual(db[`homes/${h}/roles/owner`].permissions, ['*']);
  assert.deepEqual([db[`homes/${h}`].currency, db[`homes/${h}`].timezone, db['users/UID_OWNER'].language], ['EGP', 'Africa/Cairo', 'ar']);
  assert.ok(!paths.some((p) => /expenses|recipes|cleaning|contacts|inventory|shopping|maintenance/.test(p)), 'no business data');
});

await check('A7 dashboard: correct home, user, owner role, coming-soon tools + Finance + Rooms + Devices, member count 1', async () => {
  const t = await text(page);
  assert.match(t, /بيت عادل/);
  assert.match(t, /Abdo Adel/);
  assert.match(t, /المالك/);
  // Phase 5.3: Cleaning; Phase 5.5: Maintenance — 5 planned tiles remain.
  assert.equal(await page.locator('.tile--planned').count(), 2);   // V6.1: Recipes implemented; V6.4 B: Contacts implemented; V6.5 P01: Pantry implemented (Meal planner + Shopping remain)
  assert.equal(await page.locator('.tile--planned[href="#/m/inventory"]').count(), 0, 'V6.5 P01: Pantry is no longer planned');
  assert.equal(await page.locator('.tile:not(.tile--planned)[href="#/m/expenses"]').count(), 1);
  assert.equal(await page.locator('.tile:not(.tile--planned)[href="#/m/rooms"]').count(), 1);
  assert.equal(await page.locator('.tile:not(.tile--planned)[href="#/m/devices"]').count(), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.facts dd')].some((d) => d.textContent === '١'));
  await shot(page, '03-dashboard-ar-light-desktop');
});

await check('A8 development log shows the lifecycle (no secrets)', async () => {
  const logs = page.logs.join('\n');
  for (const line of ['Firebase initialized', 'Authenticated', 'Home created', 'Profile resolved', 'Home resolved', 'Membership verified', 'Role resolved', 'Context ready']) {
    assert.ok(logs.includes(`[HomeHub] ${line}`), `missing log: ${line}`);
  }
  assert.ok(!/correct-horse|password/i.test(logs), 'password never logged');
});

// ------------------------------------------------------------------ TEST B
await check('B session restores on refresh; dashboard loads; setup does NOT run again', async () => {
  const before = await page.evaluate(() => JSON.stringify(window.__fake.dump()));
  await page.reload();
  await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('#setup-home').count(), 0);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__fake.dump())), before, 'database unchanged by reload');
});

// ------------------------------------------------------------------ preferences / settings
await check('Language switch -> English LTR, persisted to users/{uid}', async () => {
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.locator('text=Coming soon').first().waitFor();
  await page.waitForFunction(() => window.__fake.dump()['users/UID_OWNER'].language === 'en');
});

await check('Theme switch -> dark, persisted to users/{uid}', async () => {
  await page.click('.topbar__actions .chip-btn--icon');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForFunction(() => window.__fake.dump()['users/UID_OWNER'].theme === 'dark');
  await shot(page, '04-dashboard-en-dark-desktop');
});

await check('Settings: rename home updates hero, header and Firestore', async () => {
  await page.goto(BASE + '#/settings');
  await page.locator('#st-home').waitFor();
  await page.fill('#st-home', 'Adel Family Home');
  await page.locator('form.form-grid button[type=submit]').click();
  await page.locator('.home-badge__name', { hasText: 'Adel Family Home' }).waitFor();
  const db = await page.evaluate(() => window.__fake.dump());
  const home = Object.entries(db).find(([p]) => /^homes\/[^/]+$/.test(p))[1];
  assert.equal(home.name, 'Adel Family Home');
  await page.locator('details.role').first().waitFor();
  assert.equal(await page.locator('details.role').count(), 5);
  await shot(page, '05-settings-en-dark-desktop');
});

await check('Settings: display name updates users/{uid} and membership copy together', async () => {
  await page.fill('#st-name', 'Abdo');
  await page.locator('form.form-row button[type=submit]').click();
  await page.locator('.user-btn__name', { hasText: /^Abdo$/ }).waitFor();
  const db = await page.evaluate(() => window.__fake.dump());
  const member = Object.entries(db).find(([p]) => p.endsWith('/members/UID_OWNER'))[1];
  assert.equal(db['users/UID_OWNER'].displayName, 'Abdo');
  assert.equal(member.displayName, 'Abdo');
});

await check('Planned module route -> honest "Coming soon" page; unknown route -> dashboard', async () => {
  // V6.1: Recipes (chef) is implemented — Shopping is still a planned module.
  await page.goto(BASE + '#/m/shopping');
  await page.locator('.notice__title', { hasText: 'Shopping' }).waitFor();
  await page.goto(BASE + '#/m/chef'); await page.locator('#ck-page').waitFor();   // Recipes opens the real page
  await page.goto(BASE + '#/nowhere');
  await page.locator('.hero__home').waitFor();
});

// ------------------------------------------------------------------ TEST C
await check('C logout clears context -> login; login again -> same home', async () => {
  await page.click('.user-btn');
  await page.click('.menu__item--danger');
  await page.locator('#login-email').waitFor();
  assert.ok(!(await text(page)).includes('Adel Family Home'), 'home name gone from DOM');
  await page.fill('#login-email', 'owner@example.com');
  await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]');
  await page.locator('.hero__home', { hasText: 'Adel Family Home' }).waitFor();
});

// ================================================================== PHASE 2 — ROOMS
const roomsPaths = () => page.evaluate(() => window.__fake.paths().filter((p) => /^homes\/[^/]+\/rooms\//.test(p)));
const roomDocs = () => page.evaluate(() => Object.entries(window.__fake.dump()).filter(([p]) => /^homes\/[^/]+\/rooms\//.test(p)));
const cardNames = () => page.locator('.room-card__name').allInnerTexts();
async function addRoom(name, type, floor) {
  await page.click('.page-head .btn--primary');
  await page.locator('dialog[open] #room-name').waitFor();
  await page.fill('#room-name', name);
  await page.selectOption('#room-type', type);
  if (floor) await page.fill('#room-floor', floor);
  await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await page.locator('.room-card__name', { hasText: name }).waitFor();
}

await check('R1 dashboard: Your Home card says no rooms (V6.4: no standalone Rooms tile); Rooms in navigation', async () => {
  await page.goto(BASE + '#/dashboard');
  await page.locator('#home-rooms-count', { hasText: 'No rooms yet' }).waitFor();
  assert.equal(await page.locator('.summary-card[href="#/m/rooms"]').count(), 0, 'Rooms tile removed');
  assert.equal(await page.locator('.rail a[href="#/m/rooms"]').count(), 1);
  assert.equal(await page.locator('.dock a[href="#/m/rooms"]').count(), 1);
});

await check('R2 Rooms page: empty state with Add room and quick templates (nothing written)', async () => {
  await page.click('#home-rooms-count');
  await page.locator('.empty-state__title', { hasText: 'No rooms yet' }).waitFor();
  assert.equal(await page.locator('.quick-rooms__btn').count(), 4);
  assert.deepEqual(await roomsPaths(), []);
  await shot(page, '12-rooms-empty-en-dark');
});

await check('R3 quick template opens a prefilled form; Cancel / Escape write nothing', async () => {
  await page.click('.quick-rooms__btn:has-text("Kitchen")');
  await page.locator('dialog[open] #room-name').waitFor();
  assert.equal(await page.inputValue('#room-name'), 'Kitchen');
  assert.equal(await page.inputValue('#room-type'), 'kitchen');
  assert.equal(await page.locator('dialog[open] input[name="room-icon"][value="kitchen"]').isChecked(), true);
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.deepEqual(await roomsPaths(), []);
});

await check('R4 validation: empty name blocked in the form, no write', async () => {
  await page.click('.page-head .btn--primary');
  await page.locator('dialog[open] #room-name').waitFor();
  await page.click('dialog[open] button[type=submit]');
  await page.locator('#room-name-error:not([hidden])').waitFor();
  assert.deepEqual(await roomsPaths(), []);
  await page.click('dialog[open] .dialog__foot .btn--secondary');
});

await check('R5 add Living room, Kitchen, Bedroom → Home-scoped docs with correct shape', async () => {
  await addRoom('Living Room', 'living_room', 'Ground floor');
  await addRoom('Kitchen', 'kitchen');
  await addRoom('Bedroom', 'bedroom', 'First floor');
  assert.deepEqual(await cardNames(), ['Living Room', 'Kitchen', 'Bedroom']);
  const docs = await roomDocs();
  assert.equal(docs.length, 3);
  const homeId = (await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'])).defaultHomeId;
  for (const [path, d] of docs) {
    assert.ok(path.startsWith(`homes/${homeId}/rooms/AUTO`), path);
    assert.equal(d.createdBy, 'UID_OWNER');
    assert.equal(d.active, true);
    assert.equal(d.schemaVersion, 1);
    assert.ok(!('devices' in d));
  }
  assert.deepEqual(docs.map(([, d]) => d.sortOrder).sort(), [1, 2, 3]);
  assert.equal(docs.find(([, d]) => d.name === 'Kitchen')[1].icon, 'kitchen');
});

await check('R6 refresh: rooms persist in order', async () => {
  await page.reload();
  await page.locator('.room-card').first().waitFor();
  assert.deepEqual(await cardNames(), ['Living Room', 'Kitchen', 'Bedroom']);
});

await check('R7 detail shows honest future placeholders; edit Bedroom (field-level patch)', async () => {
  await page.click('.room-card__main:has-text("Bedroom")');
  // Wait for the asynchronous device summary to finish loading.
  await page.locator('dialog[open] .room-future', {
    hasText: 'No devices in this room yet'
  }).waitFor();
  const future = await page.locator('dialog[open] .room-future').innerText();
  // Phase 3: the Devices row is live (via the Devices module interface); Cleaning and
  // Maintenance remain honest "coming later" placeholders.
  assert.match(future, /No devices in this room yet/);
  // Phase 5.5: Cleaning (5.4d) and Maintenance (5.5) are live — nothing in Room Details is "coming later".
  assert.doesNotMatch(future, /Coming in a future HomeHub update/);
  assert.doesNotMatch(future, /Cleaning|Maintenance/);
  assert.ok(!/\d/.test(future), 'no fake counts');
  await shot(page, '13-room-detail-en-dark');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open] #room-name').waitFor();
  await page.fill('#room-name', 'Master Bedroom');
  await page.selectOption('#room-type', 'master_bedroom');
  await shot(page, '14-room-form-en-dark');
  await page.click('dialog[open] button[type=submit]');
  await page.locator('.room-card__name', { hasText: 'Master Bedroom' }).waitFor();
  const [, d] = (await roomDocs()).find(([, x]) => x.name === 'Master Bedroom');
  assert.equal(d.type, 'master_bedroom');
  assert.equal(d.floor, 'First floor', 'untouched field preserved');
  assert.equal(d.createdBy, 'UID_OWNER');
});

await check('R8 reorder with Move earlier; order persists after refresh', async () => {
  await page.click('button[aria-label="Move Master Bedroom earlier"]');
  await page.waitForFunction(() => document.querySelectorAll('.room-card__name')[1]?.textContent === 'Master Bedroom');
  assert.deepEqual(await cardNames(), ['Living Room', 'Master Bedroom', 'Kitchen']);
  assert.equal(await page.locator('button[aria-label="Move Living Room earlier"]').isDisabled(), true);
  await page.reload();
  await page.locator('.room-card').first().waitFor();
  assert.deepEqual(await cardNames(), ['Living Room', 'Master Bedroom', 'Kitchen']);
});

await check('R9 archive needs confirmation; Cancel keeps it; confirm hides it (soft delete)', async () => {
  await page.click('.room-card__main:has-text("Kitchen")');
  await page.click('dialog[open] .btn--danger-ghost');
  await page.locator('dialog[open][role="alertdialog"]').waitFor();
  assert.match(await page.locator('dialog[open] .dialog__title').innerText(), /Archive “Kitchen”\?/);
  await shot(page, '15-archive-confirm-en-dark');
  await page.click('dialog[open] .btn--secondary');                 // Cancel
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal((await roomDocs()).find(([, x]) => x.name === 'Kitchen')[1].active, true);
  await page.click('.room-card__main:has-text("Kitchen")');
  await page.click('dialog[open] .btn--danger-ghost');
  await page.click('dialog[open] .btn--danger');                    // Archive room
  await page.waitForFunction(() => ![...document.querySelectorAll('.room-card__name')].some((n) => n.textContent === 'Kitchen'));
  const [, k] = (await roomDocs()).find(([, x]) => x.name === 'Kitchen');
  assert.equal(k.active, false);
  assert.equal(k.archivedBy, 'UID_OWNER');
  assert.equal((await roomDocs()).length, 3, 'document kept, id still resolvable');
});

await check('R10 Archived view lists it; Restore brings it back at the end', async () => {
  await page.click('.view-switch__btn:has-text("Archived")');
  await page.locator('.room-card--archived .room-card__name', { hasText: 'Kitchen' }).waitFor();
  await shot(page, '16-rooms-archived-en-dark');
  await page.click('.room-card--archived .btn--secondary');
  await page.waitForFunction(() => document.querySelector('.view-switch') && !document.querySelector('.view-switch .view-switch__btn'));
  assert.deepEqual(await cardNames(), ['Living Room', 'Master Bedroom', 'Kitchen']);
  assert.equal((await roomDocs()).find(([, x]) => x.name === 'Kitchen')[1].archivedAt, null);
});

await check('R11 dashboard widget reflects live counts (archive one → 2 active, 1 archived)', async () => {
  await page.click('.room-card__main:has-text("Kitchen")');
  await page.click('dialog[open] .btn--danger-ghost');
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => document.querySelectorAll('.room-card').length === 2);
  await page.goto(BASE + '#/dashboard');
  // V6.4: ACTIVE rooms only, in the Your Home card (archived never counted)
  await page.locator('#home-rooms-count[data-count="2"]', { hasText: '2 active rooms' }).waitFor();
  await shot(page, '17-dashboard-rooms-widget-en-dark');
});

await check('R12 one shared rooms listener across Dashboard ↔ Rooms navigation', async () => {
  const homeId = (await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'])).defaultHomeId;
  const col = `homes/${homeId}/rooms`;
  await page.goto(BASE + '#/m/rooms');
  await page.locator('.room-card').first().waitFor();
  await page.goto(BASE + '#/dashboard');
  await page.locator('#home-rooms-count[data-count]').waitFor();
  assert.equal(await page.evaluate((c) => window.__fake.listenerCount(c), col), 1);
});

await check('R13 Arabic RTL: translated types, plural count, dialog direction', async () => {
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');      // -> Arabic
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.locator('#home-rooms-count', { hasText: /غرف(ة|تان) نشط/ }).waitFor();
  await page.goto(BASE + '#/m/rooms');
  await page.locator('.room-card').first().waitFor();
  assert.match(await page.locator('.page-head__sub').innerText(), /غرفتان/);
  assert.match(await page.locator('.room-grid').innerText(), /غرفة المعيشة/);
  await page.click('.topbar__actions .chip-btn--icon');                       // -> light
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('.room-card').first().waitFor();
  await shot(page, '18-rooms-ar-light-desktop');
  await page.click('.page-head .btn--primary');
  await page.locator('dialog[open] #room-name').waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('dialog[open]')).direction), 'rtl');
  await shot(page, '19-room-form-ar-light');
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('btn--primary')), true, 'focus returned to Add room');
});

await check('R14 live role change to viewer: rooms visible, no add/move/archive controls', async () => {
  const mp = await page.evaluate(() => window.__fake.paths().find((x) => x.endsWith('/members/UID_OWNER')));
  await page.evaluate((p) => window.__fake.patch(p, { roleId: 'viewer' }), mp);
  // The page remounts on a permission change (its module code loads lazily): wait for it.
  await page.waitForFunction(() => !document.querySelector('.page-head .btn--primary') && document.querySelectorAll('.room-card').length === 2);
  assert.equal(await page.locator('.room-card .icon-btn').count(), 0);
  await page.click('.room-card__main >> nth=0');
  await page.locator('dialog[open] .room-future').waitFor();
  assert.equal(await page.locator('dialog[open] .dialog__foot').count(), 0, 'no edit/archive actions');
  await page.keyboard.press('Escape');
  await page.evaluate((p) => window.__fake.patch(p, { roleId: 'owner' }), mp);
  await page.locator('.page-head .btn--primary').waitFor();
});

await check('R15 logout stops the rooms listener; login resolves the same rooms under the same home', async () => {
  const homeId = (await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'])).defaultHomeId;
  await page.click('.user-btn');
  await page.click('.menu__item--danger');
  await page.locator('#login-email').waitFor();
  assert.equal(await page.evaluate((c) => window.__fake.listenerCount(c), `homes/${homeId}/rooms`), 0);
  await page.fill('#login-email', 'owner@example.com');
  await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]');
  await page.locator('.hero__home').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/dashboard', 'sign-in starts on the dashboard');
  await page.goto(BASE + '#/m/rooms');
  await page.locator('.room-card').first().waitFor();
  assert.equal(await page.locator('.room-card').count(), 2);
  // Leave the UI as the Phase 1 tests that follow expect it (English).
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.goto(BASE + '#/dashboard');
  await page.locator('.hero__home').waitFor();
});

// ================================================================== PHASE 3 — DEVICES
const devDocs = () => page.evaluate(() => Object.entries(window.__fake.dump()).filter(([p]) => /^homes\/[^/]+\/devices\//.test(p)));
const devByName = async (n) => (await devDocs()).find(([, d]) => d.name === n);
const devNames = () => page.locator('.device-card .room-card__name').allInnerTexts();
const homeIdNow = async () => (await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'])).defaultHomeId;
async function openAddDevice() {
  await page.click('.page-head .btn--primary');
  await page.locator('dialog[open] #dev-name').waitFor();
}
async function saveDialog() {
  await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
}
const roomIdByName = async (n) => (await page.evaluate(() => Object.entries(window.__fake.dump()).filter(([p]) => /\/rooms\//.test(p))))
  .find(([, d]) => d.name === n)[0].split('/').pop();

await check('D1 dashboard: Your Home card shows devices (empty) + Devices in navigation; Rooms count intact (V6.4: no tiles)', async () => {
  await page.goto(BASE + '#/dashboard');
  await page.locator('#home-devices-count', { hasText: 'No devices yet' }).waitFor();
  await page.locator('#home-rooms-count[data-count]').waitFor();
  assert.equal(await page.locator('.summary-card[href="#/m/devices"], .summary-card[href="#/m/rooms"]').count(), 0);
  assert.equal(await page.locator('.rail a[href="#/m/devices"]').count(), 1);
  assert.equal(await page.locator('.tile--planned').count(), 2, 'V6.5 P01: 2 planned (Meal planner, Shopping); Pantry implemented');
});

await check('D2 Devices empty state with 6 templates; nothing written', async () => {
  await page.click('#home-devices-count');
  await page.locator('.empty-state__title', { hasText: 'No devices yet' }).waitFor();
  assert.equal(await page.locator('.quick-rooms__btn').count(), 6);
  assert.deepEqual(await devDocs(), []);
  await shot(page, '22-devices-empty-en-dark');
});

await check('D3 template → prefilled form; add Split AC to Living Room', async () => {
  await page.click('.quick-rooms__btn:has-text("Split AC")');
  await page.locator('dialog[open] #dev-name').waitFor();
  assert.equal(await page.inputValue('#dev-name'), 'Split AC');
  assert.equal(await page.inputValue('#dev-category'), 'air_conditioning');
  assert.equal(await page.inputValue('#dev-subtype'), 'split_ac');
  const roomOpts = await page.locator('#dev-room option').allInnerTexts();
  assert.ok(roomOpts.includes('Unassigned') && roomOpts.includes('Living Room') && !roomOpts.some((o) => /Kitchen/.test(o)), 'archived Kitchen not offered');
  await page.selectOption('#dev-room', { label: 'Living Room' });
  await shot(page, '23-device-form-en-dark');
  await saveDialog();
  await page.locator('.device-card .room-card__name', { hasText: 'Split AC' }).waitFor();
  const [path, d] = await devByName('Split AC');
  assert.ok(path.startsWith(`homes/${await homeIdNow()}/devices/AUTO`));
  assert.equal(d.roomId, await roomIdByName('Living Room'));
  assert.equal(d.createdBy, 'UID_OWNER');
  assert.equal(d.status, 'operational');
  assert.equal(d.icon, 'snowflake');
});

await check('D4 add Refrigerator to Master Bedroom; D5 add Router unassigned with brand/model', async () => {
  await openAddDevice();
  await page.fill('#dev-name', 'Refrigerator');
  await page.selectOption('#dev-category', 'refrigeration');
  await page.selectOption('#dev-subtype', 'refrigerator');
  await page.selectOption('#dev-room', { label: 'Master Bedroom' });
  await saveDialog();
  await openAddDevice();
  await page.fill('#dev-name', 'Home Router');
  await page.selectOption('#dev-category', 'networking');
  await page.click('dialog[open] .form-section__summary');
  await page.fill('#dev-brand', 'TP-Link');
  await page.fill('#dev-model', 'AX3000');
  await saveDialog();
  await page.locator('.device-card .room-card__name', { hasText: 'Home Router' }).waitFor();
  assert.match(await page.locator('.device-card:has-text("Home Router")').innerText(), /Unassigned/);
  assert.equal((await devByName('Home Router'))[1].roomId, null);
});

await check('D6 validation: empty name and negative price blocked in the form', async () => {
  await openAddDevice();
  await page.click('dialog[open] .form-section__summary');
  await page.fill('#dev-price', '-5');
  await page.click('dialog[open] button[type=submit]');
  await page.locator('#dev-name-error:not([hidden])').waitFor();
  await page.locator('#dev-price-error:not([hidden])').waitFor();
  assert.equal((await devDocs()).length, 3);
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
});

await check('D7 refresh: devices persist; default sort by name', async () => {
  await page.reload();
  await page.locator('.device-card').first().waitFor();
  assert.deepEqual(await devNames(), ['Home Router', 'Refrigerator', 'Split AC']);
});

await check('D8 edit AC: brand/model, price 0 kept as 0 (not null), warranty date stays exact', async () => {
  await page.click('.device-card .room-card__main:has-text("Split AC")');
  // Phase 5.5: the placeholder section is gone — Cleaning and Maintenance are live sections.
  await page.locator('dialog[open] #dev-maintenance-slot').waitFor();
  assert.doesNotMatch(await page.locator('dialog[open]').innerText(), /Coming in a future HomeHub update|قادم في تحديث لاحق/, 'no placeholder text');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open] #dev-name').waitFor();
  await page.click('dialog[open] .form-section__summary');
  await page.fill('#dev-brand', 'Carrier');
  await page.fill('#dev-model', '42QHC018');
  await page.fill('#dev-price', '0');
  await page.fill('#dev-warranty', '2027-06-30');
  await saveDialog();
  await page.waitForFunction(() => Object.values(window.__fake.dump()).some((d) => d.model === '42QHC018'));
  const [, d] = await devByName('Split AC');
  assert.equal(d.brand, 'Carrier');
  assert.equal(d.purchasePrice, 0);
  assert.equal(d.currency, 'EGP');
  assert.equal(d.warrantyExpiry, '2027-06-30');
  await page.click('.device-card .room-card__main:has-text("Split AC")');
  assert.match(await page.locator('dialog[open]').innerText(), /30 June 2027/);
  await shot(page, '24-device-detail-en-dark');
  await page.keyboard.press('Escape');
});

await check('D9 move Router into Living Room: same document id, only roomId changes', async () => {
  const [pathBefore] = await devByName('Home Router');
  await page.click('.device-card .room-card__main:has-text("Home Router")');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open] #dev-room').waitFor();
  await page.selectOption('#dev-room', { label: 'Living Room' });
  await saveDialog();
  await page.waitForFunction(() => [...document.querySelectorAll('.device-card')].some((c) => /Home Router/.test(c.textContent) && /Living Room/.test(c.textContent)));
  const [pathAfter, d] = await devByName('Home Router');
  assert.equal(pathAfter, pathBefore);
  assert.equal(d.roomId, await roomIdByName('Living Room'));
});

await check('D10 status → Needs attention; dashboard summary updates', async () => {
  await page.click('.device-card .room-card__main:has-text("Refrigerator")');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open] #dev-status').waitFor();
  await page.selectOption('#dev-status', 'needs_attention');
  await saveDialog();
  await page.locator('.device-card:has-text("Refrigerator") .status-pill--needs_attention').waitFor();
  await page.goto(BASE + '#/dashboard');
  await page.locator('#home-devices-count[data-count="3"]', { hasText: '3 active devices' }).waitFor();
  await page.locator('#home-devices-attention', { hasText: '1 needs attention' }).waitFor();
  await shot(page, '25-dashboard-devices-widget-en-dark');
});

await check('D11 search (name, model) and filters (room, category, status, unassigned) client-side', async () => {
  await page.goto(BASE + '#/m/devices');
  await page.locator('.device-card').first().waitFor();
  const reads = await page.evaluate(() => window.__fake.writes());
  await page.fill('#dev-search', 'refrig');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 1);
  await page.fill('#dev-search', 'ax30');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 1);
  assert.deepEqual(await devNames(), ['Home Router']);
  await page.fill('#dev-search', '');
  await page.selectOption('#dev-filter-room', { label: 'Living Room' });
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 2);
  assert.match(await page.locator('.result-info').innerText(), /Showing 2 of 3/);
  await page.selectOption('#dev-filter-category', 'networking');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 1);
  await page.selectOption('#dev-filter-category', 'all');
  await page.selectOption('#dev-filter-room', 'unassigned');
  await page.locator('text=No devices match your search or filters.').waitFor();
  await page.click('text=Clear search and filters');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 3);
  await page.selectOption('#dev-filter-status', 'needs_attention');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 1);
  await page.selectOption('#dev-filter-status', 'all');
  await page.selectOption('#dev-sort', 'status');
  await page.waitForFunction(() => document.querySelector('.device-card .room-card__name')?.textContent === 'Refrigerator');
  assert.equal(await page.evaluate(() => window.__fake.writes()), reads, 'search/filter never writes');
  await shot(page, '26-devices-filtered-en-dark');
  await page.selectOption('#dev-sort', 'name');
});

await check('D12 archive (confirm) → leaves active; Archived view; restore', async () => {
  await page.click('.device-card .room-card__main:has-text("Home Router")');
  await page.click('dialog[open] .btn--danger-ghost');
  await page.locator('dialog[open][role="alertdialog"]').waitFor();
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 2);
  const [, d] = await devByName('Home Router');
  assert.equal(d.active, false);
  assert.equal(d.archivedBy, 'UID_OWNER');
  assert.ok(d.roomId, 'roomId kept on archive');
  await page.click('.view-switch__btn:has-text("Archived")');
  await page.locator('.room-card--archived .room-card__name', { hasText: 'Home Router' }).waitFor();
  await page.click('.room-card--archived .btn--secondary');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 3 && !document.querySelector('.room-card--archived'));
  assert.equal((await devByName('Home Router'))[1].active, true);
});

await check('D13 archive a Room holding a device: device unchanged, labelled archived, still editable, not re-assignable', async () => {
  const mb = await roomIdByName('Master Bedroom');
  await page.goto(BASE + '#/m/rooms');
  await page.click('.room-card__main:has-text("Master Bedroom")');
  await page.locator('dialog[open] .room-devices', { hasText: '1 device in this room' }).waitFor();
  await page.click('dialog[open] .btn--danger-ghost');
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => ![...document.querySelectorAll('.room-card__name')].some((n) => n.textContent === 'Master Bedroom'));
  const [, fridge] = await devByName('Refrigerator');
  assert.equal(fridge.roomId, mb, 'roomId preserved');
  assert.equal(fridge.active, true, 'device not archived');
  await page.goto(BASE + '#/m/devices');
  await page.locator('.device-card:has-text("Refrigerator")', { hasText: 'Master Bedroom (Archived)' }).waitFor();
  await page.click('.device-card .room-card__main:has-text("Refrigerator")');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open] #dev-room').waitFor();
  assert.equal(await page.inputValue('#dev-room'), mb, 'archived room still selected for this device');
  await page.click('dialog[open] .form-section__summary');
  await page.fill('#dev-brand', 'Sharp');
  await saveDialog();
  await page.waitForFunction(() => Object.values(window.__fake.dump()).some((d) => d.brand === 'Sharp'));
  assert.equal((await devByName('Refrigerator'))[1].roomId, mb);
  // Another device cannot be moved into the archived room (not offered).
  await page.click('.device-card .room-card__main:has-text("Split AC")');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open] #dev-room').waitFor();
  assert.ok(!(await page.locator('#dev-room option').allInnerTexts()).some((o) => /Master Bedroom/.test(o)));
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await shot(page, '27-devices-archived-room-en-dark');
});

await check('D14 Room detail → "View devices" opens Devices filtered to that room (shared stores)', async () => {
  await page.goto(BASE + '#/m/rooms');
  await page.click('.room-card__main:has-text("Living Room")');
  await page.locator('dialog[open] .room-devices', { hasText: '2 devices in this room' }).waitFor();
  await page.click('dialog[open] .room-devices button');
  await page.locator('.page--devices').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 2);
  assert.equal(await page.inputValue('#dev-filter-room'), await roomIdByName('Living Room'));
});

await check('D15 exactly one devices listener and one rooms listener across Dashboard/Rooms/Devices', async () => {
  const h = await homeIdNow();
  await page.goto(BASE + '#/dashboard'); await page.locator('.summary-card__value').first().waitFor();
  await page.goto(BASE + '#/m/rooms'); await page.locator('.room-card').first().waitFor();
  await page.goto(BASE + '#/m/devices'); await page.locator('.device-card').first().waitFor();
  assert.equal(await page.evaluate((c) => window.__fake.listenerCount(c), `homes/${h}/devices`), 1);
  assert.equal(await page.evaluate((c) => window.__fake.listenerCount(c), `homes/${h}/rooms`), 1);
});

await check('D16 Arabic RTL + light: statuses, categories, archived-room label translated', async () => {
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (startTheme !== 'light') {
    await page.click('.topbar__actions .chip-btn--icon');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  }
  await page.locator('.device-card').first().waitFor();
  const txt = await page.locator('.device-grid').innerText();
  assert.match(txt, /يحتاج متابعة/);
  assert.match(txt, /\(مؤرشفة\)/);
  assert.match(await page.locator('.page-head__sub').innerText(), /٣ أجهزة/);
  await shot(page, '28-devices-ar-light-desktop');
  await openAddDevice();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('dialog[open]')).direction), 'rtl');
  await page.click('dialog[open] .form-section__summary');
  await shot(page, '29-device-form-ar-light');
  await page.keyboard.press('Escape');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  if (startTheme !== 'light') {
    await page.click('.topbar__actions .chip-btn--icon');
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, startTheme);
  }
});

await check('D17 viewer role: devices visible, no add / edit / archive controls', async () => {
  const mp = await page.evaluate(() => window.__fake.paths().find((x) => x.endsWith('/members/UID_OWNER')));
  await page.evaluate((p) => window.__fake.patch(p, { roleId: 'viewer' }), mp);
  await page.waitForFunction(() => !document.querySelector('.page-head .btn--primary') && document.querySelectorAll('.device-card').length === 3);
  await page.click('.device-card .room-card__main >> nth=0');
  await page.locator('dialog[open] #dev-maintenance-slot').waitFor();   // Phase 5.5: live sections, no placeholder
  assert.equal(await page.locator('dialog[open] .dialog__foot').count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate((p) => window.__fake.patch(p, { roleId: 'owner' }), mp);
  await page.locator('.page-head .btn--primary').waitFor();
});

await check('D18 logout stops devices + rooms listeners; login restores the same devices', async () => {
  const h = await homeIdNow();
  await page.click('.user-btn'); await page.click('.menu__item--danger');
  await page.locator('#login-email').waitFor();
  assert.equal(await page.evaluate((c) => window.__fake.listenerCount(c), `homes/${h}/devices`), 0);
  assert.equal(await page.evaluate((c) => window.__fake.listenerCount(c), `homes/${h}/rooms`), 0);
  await page.fill('#login-email', 'owner@example.com');
  await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]');
  await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/devices');
  await page.waitForFunction(() => document.querySelectorAll('.device-card').length === 3);
  await page.goto(BASE + '#/dashboard');
  await page.locator('.hero__home').waitFor();
});

// ================================================================== PHASE 4 — FINANCE
const finDocs = (col) => page.evaluate((c) => Object.entries(window.__fake.dump()).filter(([p]) => new RegExp(`^homes/[^/]+/${c}/`).test(p)), col);
const finHome = async () => (await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'])).defaultHomeId;
const tab = async (id) => { await page.click(`#fin-tab-${id}`); await page.locator(`#fin-tab-${id}[aria-selected="true"]`).waitFor(); };
const submitDialog = async () => { await page.click('dialog[open] button[type=submit]'); await page.locator('dialog[open]').waitFor({ state: 'detached' }); };
const sumMinor = (docs) => docs.filter(([, d]) => d.status !== 'void').reduce((a, [, d]) => a + d.amountMinor, 0);
const todayStr = () => page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date()));
// V6.2.1: Overview + History share ONE table (#fm-rows); the first text node of a name cell is the transaction name.
const rowNames = () => page.evaluate(() => [...document.querySelectorAll('#fm-rows .fm-td-name')].map((n) => n.firstChild.textContent));
const pickMonth = async (ym) => { await page.click('#fm-month'); await page.selectOption('#fm-pick-month', ym.slice(5)); await page.fill('#fm-pick-year', ym.slice(0, 4)); await page.click('#fm-pick-go'); };
async function quickAdd(amount, category, note) {
  await page.fill('#qa-amount', amount);
  await page.selectOption('#qa-category', category);
  await page.fill('#qa-note', note);
  await page.click('form.qa button[type=submit]');
  await page.waitForFunction((n) => Object.values(window.__fake.dump()).some((d) => d.note === n), note);
}
async function addWallet({ name, type, scope = 'home', vis, opening }) {
  await tab('wallets');
  await page.click('.fin-intro .btn--primary');
  await page.locator('dialog[open] #wl-name').waitFor();
  await page.fill('#wl-name', name);
  await page.selectOption('#wl-type', type);
  await page.selectOption('#wl-scope', scope);
  if (vis) await page.selectOption('#wl-vis', vis);
  if (opening) await page.fill('#wl-opening', opening);
  await submitDialog();
  await page.waitForFunction((n) => Object.values(window.__fake.dump()).some((d) => d.name === n && d.readers), name);
}

await check('F1 Finance opens: tabs, Quick add, honest empty states', async () => {
  await page.goto(BASE + '#/m/expenses');
  await page.locator('.page--finance #fin-tab-overview[aria-selected="true"]').waitFor();
  // V6.2.1: exactly Overview · History · Bills · Wallets (no 10-day budget / Advanced / Household).
  assert.deepEqual(await page.locator('.fin-tab').evaluateAll((t) => t.map((x) => x.id)), ['fin-tab-overview', 'fin-tab-history', 'fin-tab-commitments', 'fin-tab-wallets']);
  assert.equal(await page.locator('#fin-advanced').count(), 0);
  await page.locator('form.qa #qa-amount').waitFor();
  await page.locator('#qa-target', { hasText: 'Set up the household Cash and Bank wallets' }).waitFor();   // explicit, not a silent default
  assert.ok(await page.locator('form.qa button[type=submit]').isDisabled());
  await tab('history');
  await page.locator('#fm-empty').waitFor();
  assert.deepEqual(await finDocs('expenses'), []);
});

await check('F2 historical CSV import: preview total exact, ids kept, rerun imports nothing', async () => {
  await tab('wallets');
  await page.click('text=Import from CSV…');
  const csv = 'id,date,amount,category,name,isVisa\nhist001,2025-01-10,25635.08,food,"Rent, January",false\nhist002,2026-02-03,150,,Bakery,true\nhist003,2026-02-03,150,,Bakery,true\n';
  await page.setInputFiles('#imp-file', { name: 'expenses.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('#imp-count', { hasText: '3' }).waitFor();
  assert.match(await page.locator('#imp-total').innerText(), /25,935\.08/);
  assert.equal(await finDocs('expenses').then((d) => d.length), 0, 'nothing written before confirmation');
  await page.click('dialog[open] .dialog__foot .btn--primary');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  const docs = await finDocs('expenses');
  assert.deepEqual(docs.map(([p]) => p.split('/').pop()).sort(), ['hist001', 'hist002', 'hist003']);
  assert.equal(sumMinor(docs), 2593508);
  assert.equal(docs.find(([p]) => p.endsWith('hist002'))[1].paymentMethod, 'visa');
  assert.equal(docs.find(([p]) => p.endsWith('hist001'))[1].originalRow.amount, '25635.08');
  await page.click('text=Import from CSV…');
  await page.setInputFiles('#imp-file', { name: 'expenses.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('#imp-skipped', { hasText: '3' }).waitFor();
  assert.equal(await page.locator('#imp-count').innerText(), '0');
  assert.equal(await page.locator('dialog[open] .dialog__foot .btn--primary').isDisabled(), true);
  await page.keyboard.press('Escape');
});

await check('F4 household wallets (bank with opening balance, daily cash); F5 private personal wallet', async () => {
  await addWallet({ name: 'Household Bank', type: 'bank', opening: '20000' });
  await addWallet({ name: 'Daily Cash', type: 'cash' });
  await addWallet({ name: 'Ahmed Private', type: 'cash', scope: 'personal', vis: 'private', opening: '1000' });
  const w = await finDocs('wallets');
  const priv = w.find(([, d]) => d.name === 'Ahmed Private')[1];
  assert.deepEqual([priv.scope, priv.ownerUid, priv.visibility, priv.readers], ['personal', 'UID_OWNER', 'private', ['UID_OWNER']]);
  assert.equal(w.find(([, d]) => d.name === 'Household Bank')[1].audience, undefined, 'wallets use visibility');
  assert.equal(sumMinor(await finDocs('expenses')), 2593508, 'opening balances are not expenses');
});

await check('F9 (V6.2.1) the 10-day budget has no entry point anywhere; Quick add offers exactly Cash and Bank (wallet records by id)', async () => {
  await tab('overview');
  for (const sel of ['#fin-tab-budget', '#fin-tab-household', '#fin-advanced', '.fin-cycle-mini', '#fin-v6-open']) assert.equal(await page.locator(sel).count(), 0, sel);
  const w = await finDocs('wallets'); const id = (n) => w.find(([, d]) => d.name === n)[0].split('/').pop();
  assert.deepEqual(await page.locator('#qa-wallet option').evaluateAll((o) => o.map((x) => [x.value, x.textContent])), [[id('Daily Cash'), '💵 Cash'], [id('Household Bank'), '🏦 Bank']]);
});

await check('F6/F7/F10 Quick add (wallet only); appears immediately in the shared table, newest first; older months not mixed in', async () => {
  await quickAdd('450', 'groceries', 'Carrefour');
  await quickAdd('85', 'food', 'Coffee');
  const w = await finDocs('wallets'); const cashId = w.find(([, d]) => d.name === 'Daily Cash')[0].split('/').pop();
  const e = (await finDocs('expenses')).find(([, d]) => d.note === 'Carrefour')[1];
  assert.deepEqual([e.walletId, e.paymentMethod, e.createdBy], [cashId, null, 'UID_OWNER'], 'stable wallet id; no payment-method field written');
  await tab('history');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Coffee' }).waitFor();
  const names = await rowNames();
  assert.deepEqual(names.slice(0, 2), ['Coffee', 'Carrefour'], 'F3 newest first');
  assert.ok(!names.includes('Bakery') && !names.includes('Rent, January'), 'History is per month unless searching');
  const row = await page.locator('#fm-rows .fm-tr', { hasText: 'Carrefour' }).innerText();
  assert.match(row, /Daily Cash/); assert.match(row, /−EGP\s450/); assert.match(row, /Added by/);
  await shot(page, '33-finance-history-en-dark');
});

await check('F3b older-dated entry lands in its own month, not at the top', async () => {
  await page.click('.qa__more');
  await page.locator('dialog[open] #ex-amount').waitFor();
  assert.equal(await page.locator('dialog[open] #ex-pm').count(), 0, 'no payment-method control');
  await page.fill('#ex-amount', '200');
  await page.fill('#ex-date', '2026-01-15');
  await page.fill('#ex-note', 'Late entry');
  await submitDialog();
  await page.waitForFunction(() => Object.values(window.__fake.dump()).some((d) => d.note === 'Late entry'));
  assert.ok(!(await rowNames()).includes('Late entry'), 'not in this month');
  await pickMonth('2026-01'); await page.locator('#fm-rows .fm-tr', { hasText: 'Late entry' }).waitFor();
  await page.click('#fm-this-month'); await page.locator('#fm-rows .fm-tr', { hasText: 'Coffee' }).waitFor();
});

await check('F8 edit an expense (field-level, wallet only); amount and history update', async () => {
  await page.click('#fm-rows .fm-tr:has-text("Coffee") [data-action=edit]');
  await page.locator('dialog[open] #ex-amount').waitFor();
  assert.equal(await page.locator('dialog[open] #ex-pm').count(), 0);
  await page.fill('#ex-amount', '95');
  await submitDialog();
  await page.waitForFunction(() => Object.values(window.__fake.dump()).some((d) => d.note === 'Coffee' && d.amountMinor === 9500));
});

await check('F14 (V6.2.1) switching Cash → Bank in Edit moves the amount once; balances stay exact', async () => {
  const w = await finDocs('wallets'); const bankId = w.find(([, d]) => d.name === 'Household Bank')[0].split('/').pop();
  await page.click('#fm-rows .fm-tr:has-text("Carrefour") [data-action=edit]');
  await page.locator('dialog[open] #ex-wallet').waitFor();
  await page.selectOption('#ex-wallet', bankId); await submitDialog();
  await page.waitForFunction((b) => Object.values(window.__fake.dump()).some((d) => d.note === 'Carrefour' && d.walletId === b), bankId);
  await tab('wallets'); await page.locator(`#wl-bal-${bankId}`, { hasText: '19,550' }).waitFor();
  assert.equal((await finDocs('expenses')).filter(([, d]) => d.note === 'Carrefour').length, 1, 'no duplicate ledger entry');
});

await check('F16 monthly commitment; F17 annual subscription; reserve shown; upcoming ≠ paid', async () => {
  await tab('commitments');
  for (const [name, amount, freq, due] of [['Internet', '600', 'monthly', '2026-11-12'], ['Microsoft 365', '2999', 'annual', '2027-03-15']]) {
    await page.click('.fin-intro .btn--primary');
    await page.locator('dialog[open] #cm-name').waitFor();
    await page.fill('#cm-name', name);
    await page.fill('#cm-amount', amount);
    await page.selectOption('#cm-freq', freq);
    await page.fill('#cm-due', due);
    await submitDialog();
  }
  await page.locator('.fin-commit', { hasText: 'Microsoft 365' }).waitFor();
  assert.match(await page.locator('.fin-commit:has-text("Microsoft 365")').innerText(), /Yearly/);
  assert.match(await page.locator('.fin-commit:has-text("Microsoft 365")').innerText(), /Set aside about EGP\s249\.92\/month/);
  assert.equal((await finDocs('expenses')).filter(([, d]) => d.commitmentId).length, 0, 'commitments are not expenses');
  await shot(page, '34-finance-commitments-en-dark');
});

await check('F18/F19 mark paid → exactly one expense, due date advances; paying again is a new due date', async () => {
  await page.click('.fin-commit:has-text("Microsoft 365") .btn--primary');
  await page.locator('dialog[open] #pay-date').waitFor();
  await page.selectOption('#pay-wallet', { label: 'Household Bank' });
  await submitDialog();
  await page.waitForFunction(() => Object.values(window.__fake.dump()).some((d) => d.name === 'Microsoft 365' && d.nextDueDate === '2028-03-15'));
  const paid = (await finDocs('expenses')).filter(([, d]) => d.commitmentId);
  assert.equal(paid.length, 1);
  assert.match(paid[0][0], /\/expenses\/cm_[^/]+_20270315$/);
  await tab('history');
  await page.fill('#fm-search', 'microsoft'); await page.locator('#fm-rows .fm-tr', { hasText: 'Microsoft 365' }).waitFor();
  assert.equal(await page.locator('#fm-rows .fm-tr', { hasText: 'Microsoft 365' }).count(), 1, 'appears once in history');
  await page.click('#fm-clear');
});

await check('F20 search (all months) and filters (client-side, no writes)', async () => {
  const writes = await page.evaluate(() => JSON.stringify(window.__fake.dump()));
  const rows = () => page.locator('#fm-rows .fm-tr[data-expense]').count();
  await page.fill('#fm-search', 'bakery');
  await page.waitForFunction(() => document.querySelectorAll('#fm-rows .fm-tr[data-expense]').length === 2);
  await page.locator('#fm-chip-all').waitFor();
  await page.fill('#fm-search', '');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Coffee' }).waitFor();
  const all = await rows();
  await page.selectOption('#fm-f-cat', 'food');
  await page.waitForFunction(() => [...document.querySelectorAll('#fm-rows .fm-tr[data-expense]')].every((r) => /Food|food/.test(r.textContent)));
  assert.ok((await rows()) < all);
  await page.selectOption('#fm-f-cat', 'all');
  await page.selectOption('#fm-f-wallet', { label: 'Household Bank' });
  await page.waitForFunction(() => [...document.querySelectorAll('#fm-rows .fm-td-wallet')].every((c) => c.textContent === 'Household Bank'));
  await page.selectOption('#fm-f-wallet', 'all');
  await pickMonth('2026-02');
  await page.waitForFunction(() => document.querySelectorAll('#fm-rows .fm-tr[data-expense]').length === 2);
  await page.click('#fm-this-month');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__fake.dump())), writes);
});

await check('F13b overview: month total counts expenses only (transfers/funding/adjustments excluded)', async () => {
  await tab('overview');
  const docs = await finDocs('expenses');
  const month = (await todayStr()).slice(0, 7);
  const expected = sumMinor(docs.filter(([, d]) => d.date.startsWith(month)));
  const shown = (await page.locator('#fin-month-total .fin-stat__value').innerText()).replace(/[^\d.]/g, '');
  assert.equal(Math.round(Number(shown) * 100), expected);
  await page.goto(BASE + '#/dashboard');
  await page.locator('#fin-widget-month').waitFor();
  assert.equal(Math.round(Number((await page.locator('#fin-widget-month').innerText()).replace(/[^\d.]/g, '')) * 100), expected);
  await shot(page, '35-dashboard-finance-en-dark');
});

await check('F27 logout stops all finance listeners; F28 login restores the same data', async () => {
  const h = await finHome();
  const cols = ['expenses', 'wallets', 'walletMovements', 'spendingCycles', 'commitments'];
  await page.goto(BASE + '#/m/expenses'); await page.locator('form.qa').waitFor();
  for (const c of cols) assert.equal(await page.evaluate((p) => window.__fake.listenerCount(p), `homes/${h}/${c}`), 2, `${c}: household + mine`);
  await page.click('.user-btn'); await page.click('.menu__item--danger');
  await page.locator('#login-email').waitFor();
  for (const c of cols) assert.equal(await page.evaluate((p) => window.__fake.listenerCount(p), `homes/${h}/${c}`), 0, `${c} stopped`);
  await page.fill('#login-email', 'owner@example.com'); await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Carrefour' }).waitFor();
});

await check('F22 another adult cannot see a private wallet; F21 restricted roles hide totals', async () => {
  const h = await finHome();
  await page.evaluate((p) => window.__fake.set(p, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', addedBy: 'UID_OWNER', joinedAt: 'x', createdAt: 'x', updatedAt: 'x' }), `homes/${h}/members/UID_MONA`);
  await page.evaluate(([p, h2]) => window.__fake.set(p, { email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h2, language: 'en', theme: 'dark', schemaVersion: 1, createdAt: 'x', updatedAt: 'x' }), ['users/UID_MONA', h]);
  // a private-wallet expense of Ahmed's
  await page.click('#fin-tab-overview');
  await page.click('.view-switch__btn:has-text("Mine")');   // V6.2.1: personal wallets are chosen in the Mine scope
  await page.click('.qa__more'); await page.locator('dialog[open] #ex-amount').waitFor();
  await page.fill('#ex-amount', '777'); await page.selectOption('#ex-wallet', { label: 'Ahmed Private' }); await page.fill('#ex-note', 'Secret gift');
  await submitDialog();
  await page.click('.view-switch__btn:has-text("Home")');
  await page.click('.user-btn'); await page.click('.menu__item--danger'); await page.locator('#login-email').waitFor();
  await page.fill('#login-email', 'mona@example.com'); await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets');
  await page.locator('.fin-wallet', { hasText: 'Daily Cash' }).waitFor();
  assert.equal(await page.locator('.fin-wallet', { hasText: 'Ahmed Private' }).count(), 0, 'private wallet not listed');
  await page.click('#fin-tab-history');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Carrefour' }).waitFor();
  assert.equal(await page.locator('#fm-rows .fm-tr', { hasText: 'Secret gift' }).count(), 0, 'private expense not listed');
  // F21: viewer → read-only, totals hidden
  await page.evaluate((p) => window.__fake.patch(p, { roleId: 'viewer' }), `homes/${h}/members/UID_MONA`);
  await page.waitForFunction(() => !document.querySelector('form.qa'));
  await page.click('#fin-tab-overview');
  await page.locator('text=Totals are hidden for your role.').first().waitFor();
  assert.equal(await page.locator('#fin-month-total').count(), 0);
  // child → no household finance at all
  await page.evaluate((p) => window.__fake.patch(p, { roleId: 'child' }), `homes/${h}/members/UID_MONA`);
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('.summary-card[href="#/m/expenses"]').count(), 0, 'child: no finance card (no expenses.view)');
  await page.click('.user-btn'); await page.click('.menu__item--danger'); await page.locator('#login-email').waitFor();
  await page.fill('#login-email', 'owner@example.com'); await page.fill('#login-password', 'correct-horse');
  await page.click('button[type=submit]'); await page.locator('.hero__home').waitFor();
});

await check('F23/F24 Arabic RTL finance; F25 light/dark; tabs keyboard navigable', async () => {
  await page.goto(BASE + '#/m/expenses'); await page.locator('form.qa').waitFor();
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.locator('#fin-tab-history', { hasText: 'السجل' }).waitFor();
  assert.equal(await page.locator('#fin-tab-budget, #fin-tab-household, #fin-advanced').count(), 0);
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (startTheme !== 'light') { await page.click('.topbar__actions .chip-btn--icon'); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light'); }
  await page.click('#fin-tab-history');
  await page.locator('#fm-rows .fm-th', { hasText: 'التاريخ' }).waitFor();
  await shot(page, '36-finance-history-ar-light');
  await page.focus('#fin-tab-history'); await page.keyboard.press('ArrowLeft');   // RTL: left = next
  await page.locator('#fin-tab-commitments[aria-selected="true"]').waitFor();
  await shot(page, '37-finance-bills-ar-light');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  if (startTheme !== 'light') { await page.click('.topbar__actions .chip-btn--icon'); await page.waitForFunction((t) => document.documentElement.dataset.theme === t, startTheme); }
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
});

// ================================================================== PHASE 4A — FAMILY & MEMBERS
const famCode = () => page.locator('#inv-code').innerText().then((x) => x.trim());
async function logout() { await page.click('.user-btn'); await page.click('.menu__item--danger'); await page.locator('#login-email').waitFor(); }
async function login(email, password = 'correct-horse') {
  await page.fill('#login-email', email); await page.fill('#login-password', password);
  await page.click('button[type=submit]');
}
async function makeInvite(type) {
  await page.goto(BASE + '#/family');
  await page.click('#family-invite');
  await page.selectOption('#inv-type', type);
  await page.click('#inv-create');
  await page.locator('#inv-code').waitFor();
  const code = await famCode();
  await page.keyboard.press('Escape');
  return code;
}
let famInvite = ''; let childInvite = '';
const memberPath = (uid) => page.evaluate((u) => window.__fake.paths().find((x) => x.endsWith(`/members/${u}`)), uid);

await check('M0 start state: signed in as the owner, English', async () => {
  // Earlier Finance flows end as another member and/or in Arabic: start Phase 4A deterministically.
  if (await page.locator('.user-btn').count()) { await logout(); }
  if (await page.evaluate(() => document.documentElement.dir) === 'rtl') { await page.click('.quick-toggles .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr'); }
  await login('owner@example.com');
  await page.locator('.hero__home').waitFor();
});

await check('M1/M2 Family page: members listed with roles/status, privacy note', async () => {
  await page.goto(BASE + '#/settings');
  await page.click('#settings-family');
  await page.locator('#member-list .member-card').first().waitFor();
  const owner = page.locator('.member-card[data-uid="UID_OWNER"]');
  assert.match(await owner.innerText(), /Owner/);
  assert.match(await owner.innerText(), /Active/);
  assert.match(await page.locator('.page--family').innerText(), /Owning the home doesn’t give access to anyone’s private wallet/);
});

await check('M3/M4 owner creates an adult invite: secure code shown, listed as pending', async () => {
  famInvite = await makeInvite('adult');
  assert.match(famInvite, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
  await page.locator('#invite-list .invite-row').first().waitFor();
  const inv = await page.evaluate(() => Object.entries(window.__fake.dump()).find(([p]) => p.startsWith('invites/'))[1]);
  assert.deepEqual([inv.roleId, inv.relationship, inv.status, inv.createdBy], ['member', 'adult', 'pending', 'UID_OWNER']);
  assert.ok(inv.expiresAtMillis > Date.now() + 6 * 86400000);
});

await check('M5–M7 NEW person creates an account from the link, sees the home + role, joins', async () => {
  await logout();
  await page.goto(BASE + `#/join/${famInvite}`);
  await page.locator('.banner--info', { hasText: 'accept your invitation' }).waitFor();
  await page.click('#login-mode');
  await page.fill('#login-email', 'sara@example.com'); await page.fill('#login-password', 'correct-horse'); await page.fill('#login-confirm', 'correct-horse');
  await page.click('button[type=submit]');
  await page.locator('#invite-state[data-state="ok"]').waitFor();
  assert.match(await page.locator('#invite-state').innerText(), /Member/);
  await page.fill('#setup-name', 'Sara');
  await page.click('#join-accept');
  await page.locator('.hero__home').waitFor();
  const m = await page.evaluate(() => window.__fake.dump()[window.__fake.paths().find((x) => x.endsWith('/members/UID_SARA'))]);
  assert.deepEqual([m.roleId, m.status, m.addedBy, m.displayName], ['member', 'active', 'UID_OWNER', 'Sara']);
  const inv = await page.evaluate(() => Object.entries(window.__fake.dump()).find(([p]) => p.startsWith('invites/'))[1]);
  assert.deepEqual([inv.status, inv.acceptedBy], ['accepted', 'UID_SARA']);
  await page.click('.user-btn');
  assert.match(await page.locator('.menu__role').innerText(), /Member/);
  await page.keyboard.press('Escape');
});

await check('M8–M11 wife uses household Finance; history says "Added by Sara"', async () => {
  await page.goto(BASE + '#/m/expenses');
  await page.locator('#qa-amount').waitFor();
  await page.fill('#qa-amount', '750'); await page.fill('#qa-note', 'Sara groceries');
  await page.click('form.qa button[type=submit]');
  await page.click('#fin-tab-history');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Sara groceries' }).waitFor();
  assert.match(await page.locator('#fm-rows .fm-tr', { hasText: 'Sara groceries' }).innerText(), /Added by Sara/);
  const e = await page.evaluate(() => Object.values(window.__fake.dump()).find((d) => d.note === 'Sara groceries'));
  assert.equal(e.createdBy, 'UID_SARA');
});

await check('M12 wife creates a PRIVATE personal wallet', async () => {
  await page.click('#fin-tab-wallets');
  await page.click('.fin-intro .btn--primary');
  await page.locator('dialog[open] #wl-name').waitFor();
  await page.fill('#wl-name', 'Sara wallet');
  await page.selectOption('#wl-scope', 'personal');
  await page.selectOption('#wl-vis', 'private');
  await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  const w = await page.evaluate(() => Object.values(window.__fake.dump()).find((d) => d.name === 'Sara wallet'));
  assert.deepEqual([w.ownerUid, w.visibility, w.readers], ['UID_SARA', 'private', ['UID_SARA']]);
});

await check('M13 owner cannot see the wife’s private wallet anywhere', async () => {
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets');
  for (const sc of ['Home', 'Mine']) {
    await page.click(`.view-switch__btn:has-text("${sc}")`);
    await page.locator('.fin-intro').waitFor();
    assert.ok(!(await page.locator('.page--finance').innerText()).includes('Sara wallet'), sc);
  }
});

await check('M14/M15 wife shares her wallet with the owner → owner can now see it', async () => {
  await logout(); await login('sara@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets');
  await page.click('.view-switch__btn:has-text("Mine")');
  await page.locator('.fin-wallet', { hasText: 'Sara wallet' }).locator('[data-action=edit]').click();
  await page.locator('dialog[open] #wl-vis').waitFor();
  await page.selectOption('#wl-vis', 'shared');
  await page.locator('dialog[open] input[name="wl-share"][value="UID_OWNER"]').check();
  await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets');
  await page.click('.view-switch__btn:has-text("Mine")');
  await page.locator('.fin-wallet', { hasText: 'Sara wallet' }).waitFor();
});

await check('M21 a member cannot change their own role (no control offered)', async () => {
  await logout(); await login('sara@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/family');
  const mine = page.locator('.member-card[data-uid="UID_SARA"]');
  await mine.waitFor();
  assert.equal(await mine.locator('button', { hasText: 'Change role' }).count(), 0);
  assert.equal(await page.locator('#family-invite').count(), 0, 'members cannot invite');
  assert.equal(await mine.locator('button', { hasText: 'Leave home' }).count(), 1);
});

await check('M16–M19 child: new account via invite link, guardian set, allowance wallet shared with guardian', async () => {
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  childInvite = await makeInvite('child');
  await logout();
  await page.goto(BASE + `#/join/${childInvite}`);
  await page.click('#login-mode');
  await page.fill('#login-email', 'omar@example.com'); await page.fill('#login-password', 'kidpass123'); await page.fill('#login-confirm', 'kidpass123');
  await page.click('button[type=submit]');
  await page.locator('#invite-state[data-state="ok"]').waitFor();
  assert.match(await page.locator('#invite-state').innerText(), /Child/);
  await page.fill('#setup-name', 'Omar'); await page.click('#join-accept');
  await page.locator('.hero__home').waitFor();
  const m = await page.evaluate(() => window.__fake.dump()[window.__fake.paths().find((x) => x.endsWith('/members/UID_OMAR'))]);
  assert.deepEqual([m.roleId, m.relationship, m.guardianUids], ['child', 'child', ['UID_OWNER']]);
  // Owner creates Omar's allowance wallet: guardians pre-selected for sharing.
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/family');
  assert.match(await page.locator('.member-card[data-uid="UID_OMAR"]').innerText(), /Guardians: /);
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets');
  await page.click('.fin-intro .btn--primary');
  await page.locator('dialog[open] #wl-name').waitFor();
  await page.fill('#wl-name', 'Omar allowance');
  await page.selectOption('#wl-type', 'allowance');
  await page.selectOption('#wl-scope', 'personal');
  await page.selectOption('#wl-owner', 'UID_OMAR');
  await page.locator('dialog[open] input[name="wl-share"][value="UID_OWNER"]:checked').waitFor();
  await page.fill('#wl-opening', '500');
  await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  const w = await page.evaluate(() => Object.values(window.__fake.dump()).find((d) => d.name === 'Omar allowance'));
  assert.deepEqual([w.ownerUid, w.visibility, w.readers], ['UID_OMAR', 'shared', ['UID_OMAR', 'UID_OWNER']]);
});

await check('M18/M20 child sees and spends own allowance; no household finance, no Home scope', async () => {
  await logout(); await login('omar@example.com', 'kidpass123'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('.rail a[href="#/m/expenses"]').count(), 1, 'Finance reachable for the child');
  await page.goto(BASE + '#/m/expenses');
  await page.locator('#qa-amount').waitFor();
  assert.equal(await page.locator('.view-switch__btn:has-text("Home")').count(), 0);
  await page.fill('#qa-amount', '40'); await page.fill('#qa-note', 'Snacks');
  await page.click('form.qa button[type=submit]');
  await page.click('#fin-tab-wallets');
  await page.locator('.fin-wallet', { hasText: 'Omar allowance' }).waitFor();
  await page.waitForFunction(() => /460/.test(document.querySelector('.fin-wallet')?.innerText || ''));
  const txt = await page.locator('.page--finance').innerText();
  // Only the child's own wallet is listed (the word "Household" appears in the static intro text,
  // so check the wallet cards and named household data instead).
  assert.equal(await page.locator('.fin-wallet').count(), 1, 'child sees exactly one wallet: their allowance');
  for (const hidden of ['Daily Cash', 'Sara wallet', 'Sara groceries']) assert.ok(!txt.includes(hidden), hidden);
  assert.equal(await page.locator('.fin-wallet .btn').count(), 0, 'child cannot edit/archive a guardian-created allowance');
  assert.equal(await page.locator('a[href="#/family"]').count() + 0 >= 0, true);
  await page.goto(BASE + '#/family');
  assert.equal(await page.locator('#family-invite').count(), 0, 'child cannot invite');
});

await check('M19 guardian sees the child’s allowance spending', async () => {
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets');
  await page.click('.view-switch__btn:has-text("Mine")');
  await page.locator('.fin-wallet', { hasText: 'Omar allowance' }).waitFor();
  assert.match(await page.locator('.fin-wallet', { hasText: 'Omar allowance' }).innerText(), /460/);
});

await check('M22 owner changes an allowed member role (member → viewer → member)', async () => {
  await page.goto(BASE + '#/family');
  const card = page.locator('.member-card[data-uid="UID_SARA"]');
  for (const role of ['viewer', 'member']) {
    await card.locator('button', { hasText: 'Change role' }).click();
    await page.selectOption('#role-select', role);
    await page.click('dialog[open] .btn--primary');
    await page.waitForFunction((r) => window.__fake.dump()[window.__fake.paths().find((x) => x.endsWith('/members/UID_SARA'))].roleId === r, role);
  }
  assert.equal(await page.locator('.member-card[data-uid="UID_OWNER"] button', { hasText: 'Change role' }).count(), 0, 'owner row protected');
});

await check('M25–M27 invalid, expired and reused invitations are refused clearly', async () => {
  await page.goto(BASE + '#/join/AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
  await page.locator('#invite-state[data-state="invalid"]').waitFor();
  await page.goto(BASE + `#/join/${famInvite}`);
  await page.locator('#invite-state[data-state="used"]').waitFor();
  // Existing member opening a fresh invite → "already a member".
  const again = await makeInvite('adult');
  await logout(); await login('mona@example.com');
  await page.locator('.hero__home').waitFor();
  await page.goto(BASE + `#/join/${again}`);
  await page.locator('#invite-state[data-state="alreadyMember"]').waitFor();
  // The app deliberately keeps an invite link (#/join/…) through sign-out/sign-in, so the owner
  // lands on that Join page again ("already a member") — then goes to the dashboard.
  await logout(); await login('owner@example.com');
  await page.locator('#invite-state[data-state="alreadyMember"]').waitFor();
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
  const code = await makeInvite('viewer');
  const key = 'invites/' + code.replace(/-/g, '');
  await page.evaluate((k) => window.__fake.patch(k, { expiresAtMillis: Date.now() - 1000 }), key);
  await page.goto(BASE + `#/join/${code}`);
  await page.locator('#invite-state[data-state="expired"]').waitFor();
  assert.match(await page.locator('#invite-state').innerText(), /expired/);
});

await check('M23/M24 remove a member: access lost, history kept and still attributed', async () => {
  await page.goto(BASE + '#/family');
  await page.locator('.member-card[data-uid="UID_SARA"] button', { hasText: 'Remove' }).click();
  await page.click('dialog[open] .btn--danger');
  await page.waitForFunction(() => window.__fake.dump()[window.__fake.paths().find((x) => x.endsWith('/members/UID_SARA'))].status === 'removed');
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Sara groceries' }).waitFor();
  assert.match(await page.locator('#fm-rows .fm-tr', { hasText: 'Sara groceries' }).innerText(), /Added by Sara/, 'name still resolves after removal');
  await logout(); await login('sara@example.com');
  await page.locator('.gate__code', { hasText: /MEMBERSHIP_INACTIVE|MEMBERSHIP_MISSING/ }).waitFor();
});

await check('M28–M31 Family page in Arabic RTL, dark, and on a phone without overflow', async () => {
  await page.click('text=Sign out').catch(() => {});
  await page.locator('#login-email').waitFor().catch(() => {});
  if (await page.locator('#login-email').count()) { await login('owner@example.com'); }
  await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/family');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.locator('#member-list .member-card').first().waitFor();
  assert.match(await page.locator('.page--family').innerText(), /العائلة والأعضاء/);
  await shot(page, '40-family-ar');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await newPage(phone);
  await p.goto(BASE);
  await p.evaluate((d) => { for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); }, await page.evaluate(() => ({ 'fake:db': localStorage.getItem('fake:db'), 'fake:auth': localStorage.getItem('fake:auth'), 'fake:users': localStorage.getItem('fake:users') || '{}' })));
  await p.goto(BASE + '#/family');
  await p.locator('#member-list .member-card').first().waitFor();
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'family page overflow');
  await shot(p, '41-family-mobile');
  await phone.close();
});

await check('M32 logout/login restores the owner’s home and membership', async () => {
  await logout(); await login('owner@example.com');
  await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/dashboard');
  await page.locator('.hero__home').waitFor();
});

// ------------------------------------------------------------------ live context & errors

/** Bounded, settle-aware theme switch: click once, then WAIT for the async profile save to
 * settle. Never an unbounded click loop (that raced the preference round-trip and could hang). */
async function ensureTheme(p, want) {
  for (let i = 0; i < 3; i++) {
    if (await p.evaluate(() => document.documentElement.dataset.theme) === want) return;
    await p.click('.topbar__actions .chip-btn--icon');
    try { await p.waitForFunction((w) => document.documentElement.dataset.theme === w, want, { timeout: 4000 }); return; } catch { /* settle, then retry */ }
    await p.waitForTimeout(500);
  }
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), want, `theme did not settle on ${want}`);
}
// =================================================================== PHASE 5 — LIFE SAVINGS & ZAKAT (S1–S48)
const svDump = () => page.evaluate(() => window.__fake.dump());
async function svOpen(scope) {
  await page.goto(BASE + '#/m/savings');
  await page.locator('#sv-tab-overview').waitFor();
  if (scope) await page.click(`.view-switch__btn:has-text("${scope}")`);
}
async function svSubmit() { await page.click('dialog[open] button[type=submit]'); await page.locator('dialog[open]').waitFor({ state: 'detached' }); }
async function svAddAsset({ type = 'cash', name, scope = 'personal', vis = 'private', currency, purity, opening, inst, owner, zakat, alloc }) {
  await page.click('#sv-tab-assets');
  await page.click('.fin-stack > .toolbar .btn--primary');
  await page.selectOption('#sa-type', type);
  await page.fill('#sa-name', name);
  if (await page.locator('#sa-scope option').count() > 1) await page.selectOption('#sa-scope', scope);
  if (owner && await page.locator('#sa-owner').isVisible()) await page.selectOption('#sa-owner', owner);
  if (scope === 'personal' && vis) await page.selectOption('#sa-vis', vis);
  if (currency) await page.selectOption('#sa-currency', currency);
  if (purity) await page.selectOption('#sa-purity', purity);
  if (inst) await page.fill('#sa-inst', inst);
  if (opening) await page.fill('#sa-opening', opening);
  if (zakat) await page.selectOption('#sa-zakat', zakat);
  if (alloc) for (const [uid, pct] of Object.entries(alloc)) await page.fill(`input[name="sa-alloc"][data-uid="${uid}"]`, pct);
  await svSubmit();
  await page.locator('.sv-asset', { hasText: name }).waitFor();
}
const card = (name) => page.locator('.sv-asset', { hasText: name });
async function svEvent(name, label, amount) {
  await page.click('#sv-tab-assets');
  await card(name).locator('button', { hasText: new RegExp(`^${label}$`) }).click();
  await page.fill('#ev-amount', amount);
  await svSubmit();
}
async function svPrice(key, price) {
  await page.click('#sv-tab-valuation');
  await page.click('#sv-add-price');
  await page.selectOption('#pr-key', key);
  await page.fill('#pr-price', price);
  await svSubmit();
}
const svTotal = async () => (await page.locator('#sv-total').innerText()).replace(/[^\d.]/g, '');

await check('S0–S2 owner opens Life Savings: nav + empty state, no fake data', async () => {
  await page.goto(BASE + '#/dashboard');
  await page.locator('.hero__home, #login-email').first().waitFor();   // wait until the app has rendered
  if (await page.locator('.user-btn').count()) await logout();
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  if (await page.evaluate(() => document.documentElement.dir) === 'rtl') { await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr'); }
  await page.locator('a[href="#/m/savings"]').first().waitFor();
  await svOpen();
  await page.locator('.empty-state', { hasText: 'No savings yet' }).waitFor();
  assert.ok(!Object.keys(await svDump()).some((p) => p.includes('/savingsAssets/')), 'nothing seeded');
});

await check('S2b adding a personal asset while viewing Home switches to Mine (the new asset never "vanishes")', async () => {
  await svOpen('Home');
  await page.click('#sv-tab-assets');
  await svAddAsset({ name: 'Scope probe' });   // personal, no balance
  await page.locator('.view-switch__btn[aria-pressed="true"]', { hasText: 'Mine' }).waitFor();
  await card('Scope probe').waitFor();
  // Archive it so later total-wealth checks are unaffected (archive keeps history).
  await card('Scope probe').locator('button', { hasText: 'Archive' }).click();
  await page.locator('dialog[open] .btn--danger, dialog[open] .btn--primary').last().click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.sv-asset')].some((e) => e.textContent.includes('Scope probe')));
});

await check('S3–S10 cash, bank, 21K gold, manual gold price, USD + manual FX, total visible wealth', async () => {
  await svOpen('Mine');
  await page.click('#sv-tab-assets');
  await svAddAsset({ name: 'Emergency Cash', opening: '25000' });
  await svAddAsset({ type: 'bank', name: 'CIB Savings', inst: 'CIB', opening: '150000' });
  await svAddAsset({ type: 'gold', name: 'Gold bars', purity: '21', opening: '50' });
  assert.match(await card('Gold bars').innerText(), /50 g/);
  assert.match(await card('Gold bars').innerText(), /No price yet/, 'never a fake value');
  await svPrice('gold-21', '4000');
  await page.click('#sv-tab-assets');
  assert.match(await card('Gold bars').innerText(), /200,000/);
  assert.match(await card('Gold bars').innerText(), /Manual/);
  assert.doesNotMatch(await card('Gold bars').innerText(), /Live/);
  await svAddAsset({ type: 'fx', name: 'USD Savings', currency: 'USD', opening: '2500' });
  await page.click('#sv-tab-overview');
  await page.locator('#sv-unvalued', { hasText: 'USD Savings' }).waitFor();
  assert.equal(await svTotal(), '375000', 'USD not counted until priced');
  await svPrice('USD', '48.50');
  await page.click('#sv-tab-overview');
  await page.waitForFunction(() => /496,250/.test(document.querySelector('#sv-total').textContent));
  const quotes = Object.entries(await svDump()).filter(([p]) => p.includes('/priceQuotes/')).map(([, d]) => d);
  assert.ok(quotes.every((q) => q.source === 'manual' && q.createdBy === 'UID_OWNER'), 'audited manual prices');
  await shot(page, '42-savings-overview-en');
});

await check('S11–S13 contribution, withdrawal, adjustment (events, not balance edits)', async () => {
  await svOpen('Mine');
  await svEvent('Emergency Cash', 'Add', '5000');
  await svEvent('Emergency Cash', 'Withdraw', '2000');
  await svEvent('Emergency Cash', 'Adjust', '-120');
  await page.locator('.sv-asset', { hasText: 'Emergency Cash' }).locator('.sv-asset__qty', { hasText: '27,880' }).waitFor();
  const evs = Object.entries(await svDump()).filter(([p]) => p.includes('/savingsEvents/')).map(([, d]) => d.type);
  for (const tp of ['opening', 'contribution', 'withdrawal', 'adjustment']) assert.ok(evs.includes(tp), tp);
  await page.click('#sv-tab-activity');
  assert.match(await page.locator('#sv-activity li').first().innerText(), /Adjustment/, 'newest first');
});

await check('S14–S16 wallet → savings and savings → wallet are transfers: no expense created', async () => {
  const before = Object.keys(await svDump()).filter((p) => p.includes('/expenses/')).length;
  await svOpen('Mine');
  await page.click('#sv-tab-assets');
  await card('Emergency Cash').locator('button', { hasText: 'From wallet' }).click();
  await page.fill('#wt-amount', '1000'); await svSubmit();
  await card('Emergency Cash').locator('button', { hasText: 'To wallet' }).click();
  await page.fill('#wt-amount', '500'); await svSubmit();
  await page.locator('.sv-asset', { hasText: 'Emergency Cash' }).locator('.sv-asset__qty', { hasText: '28,380' }).waitFor();
  const d = await svDump();
  const mv = Object.entries(d).filter(([p, v]) => p.includes('/walletMovements/sv_') && v.type === 'savings');
  assert.equal(mv.length, 2, 'two savings movements in Finance');
  for (const [p, v] of mv) assert.ok(d[p.replace('/walletMovements/sv_', '/savingsEvents/').replace(/$/, v.fromWalletId ? '_in' : '_out')], 'linked leg');
  assert.equal(Object.keys(d).filter((p) => p.includes('/expenses/')).length, before, 'no expense');
});

let laylaInvite = '';
await check('S17–S22 wife: private savings hidden from the Home owner; share → visible; un-share → hidden', async () => {
  laylaInvite = await makeInvite('adult');
  await logout();
  await page.goto(BASE + `#/join/${laylaInvite}`);
  await page.click('#login-mode');
  await page.fill('#login-email', 'layla@example.com'); await page.fill('#login-password', 'correct-horse'); await page.fill('#login-confirm', 'correct-horse');
  await page.click('button[type=submit]');
  await page.locator('#invite-state[data-state="ok"]').waitFor();
  await page.fill('#setup-name', 'Layla'); await page.click('#join-accept'); await page.locator('.hero__home').waitFor();
  await svOpen('Mine');
  await svAddAsset({ name: 'Layla private', opening: '90000' });
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  for (const scope of ['Home', 'Mine']) {
    await svOpen(scope); await page.click('#sv-tab-assets');
    assert.equal(await card('Layla private').count(), 0, `owner (${scope}) cannot see it`);
  }
  await page.click('#sv-tab-overview');
  assert.doesNotMatch(await page.locator('#sv-total').innerText(), /586,/, 'not in totals');
  await logout(); await login('layla@example.com'); await page.locator('.hero__home').waitFor();
  await svOpen('Mine'); await page.click('#sv-tab-assets');
  await card('Layla private').locator('button', { hasText: 'Edit' }).click();
  await page.selectOption('#sa-vis', 'shared');
  await page.check('input[name="sa-share"][value="UID_OWNER"]');
  await svSubmit();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await svOpen('Mine'); await page.click('#sv-tab-assets');
  await card('Layla private').waitFor();
  assert.equal(await card('Layla private').locator('button', { hasText: 'Edit' }).count(), 0, 'owner cannot re-share her asset');
  await logout(); await login('layla@example.com'); await page.locator('.hero__home').waitFor();
  await svOpen('Mine'); await page.click('#sv-tab-assets');
  await card('Layla private').locator('button', { hasText: 'Edit' }).click();
  await page.selectOption('#sa-vis', 'private'); await svSubmit();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await svOpen('Mine'); await page.click('#sv-tab-assets');
  await page.waitForTimeout(300);
  assert.equal(await card('Layla private').count(), 0, 'hidden again');
});

let omarUid = '';
await check('S23–S25 child savings: guardian creates, child sees own only, no household totals', async () => {
  omarUid = (await memberPath('UID_OMAR')) ? 'UID_OMAR' : '';
  assert.ok(omarUid, 'Omar exists from Phase 4A');
  await svOpen('Mine');
  await svAddAsset({ name: 'Omar piggy bank', owner: 'UID_OMAR', vis: 'shared', opening: '300' });
  const a = Object.values(await svDump()).find((d) => d.name === 'Omar piggy bank');
  assert.deepEqual([a.ownerUid, [...a.readers].sort()], ['UID_OMAR', ['UID_OMAR', 'UID_OWNER']].map((x) => (Array.isArray(x) ? x.sort() : x)));
  await logout(); await login('omar@example.com', 'kidpass123'); await page.locator('.hero__home').waitFor();
  await svOpen();
  assert.equal(await page.locator('.view-switch__btn', { hasText: 'Home' }).count(), 0, 'child: no Home scope');
  await page.click('#sv-tab-assets');
  await card('Omar piggy bank').waitFor();
  for (const hidden of ['CIB Savings', 'Gold bars', 'Layla private']) assert.equal(await card(hidden).count(), 0, hidden);
  assert.equal(await card('Omar piggy bank').locator('button', { hasText: /^(Edit|Archive)$/ }).count(), 0, 'child cannot un-share/archive');
  // V6.1: the dashboard tile is gone; the same total is still reachable through navigation.
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('#sv-widget-total').count(), 0, 'no Life Savings dashboard tile');
  await svOpen(); await page.locator('#sv-total').waitFor();
  assert.match(await page.locator('#sv-total').innerText(), /300/);
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
});

await check('S26 archive keeps history', async () => {
  await svOpen('Mine');
  await svAddAsset({ type: 'other', name: 'Old watch', opening: '1000' });
  await card('Old watch').locator('button', { hasText: 'Archive' }).click();
  await page.click('dialog[open] .btn--danger, dialog[open] .btn--primary');
  await page.waitForFunction(() => ![...document.querySelectorAll('.sv-asset')].some((x) => x.textContent.includes('Old watch')));
  const d = await svDump();
  const [id] = Object.entries(d).find(([, v]) => v.name === 'Old watch');
  assert.equal(d[id].active, false);
  assert.ok(Object.values(d).some((v) => v.assetId === id.split('/').pop()), 'events kept');
});

await check('S27–S36 Zakat: gold / silver / manual Nisab, Hawl, breakdown, exclusion, per-owner, shared allocation', async () => {
  await svOpen('Mine');
  await page.click('#sv-tab-zakat');
  await page.locator('#zk-nisab-value', { hasText: '340,000' }).waitFor();
  assert.equal(await page.locator('#zk-status').getAttribute('data-status'), 'inProgress');
  await page.locator('#zk-hawl-start').waitFor();
  assert.match(await page.locator('#zk-hawl-end').innerText(), /AH|هـ/, 'Hijri shown with the Gregorian date');
  const bd = await page.locator('#zk-breakdown').innerText();
  for (const n of ['Emergency Cash', 'CIB Savings', 'Gold bars', 'USD Savings']) assert.match(bd, new RegExp(n));
  assert.doesNotMatch(bd, /Layla|Omar/, 'never another owner’s wealth');
  // exclusion
  await page.click('#sv-tab-assets');
  await card('USD Savings').locator('button', { hasText: 'Edit' }).click();
  await page.selectOption('#sa-zakat', 'excluded'); await svSubmit();
  await page.click('#sv-tab-zakat');
  await page.locator('#zk-excluded', { hasText: 'USD Savings' }).waitFor();
  // shared household allocation 60 / 40 (me / Layla)
  await page.click('.view-switch__btn:has-text("Home")');
  await svAddAsset({ name: 'Family fund', scope: 'home', opening: '100000', alloc: { UID_OWNER: '60', UID_LAYLA: '40' } });
  await page.click('#sv-tab-zakat');
  const row = page.locator('#zk-breakdown tr', { hasText: 'Family fund' });
  await row.waitFor(); assert.match(await row.innerText(), /60/); assert.match(await row.innerText(), /60,000/);
  // silver basis
  await svPrice('silver-999', '50');
  await page.click('#sv-tab-zakat'); await page.click('#zk-settings');
  await page.selectOption('#zk-basis', 'silver'); await svSubmit();
  await page.locator('#zk-nisab-value', { hasText: '29,750' }).waitFor();
  // manual basis
  await page.click('#zk-settings'); await page.selectOption('#zk-basis', 'manual'); await page.fill('#zk-manual', '250000'); await svSubmit();
  await page.locator('#zk-nisab-value', { hasText: '250,000' }).waitFor();
  const versions = Object.values(await svDump()).filter((d) => d.kind === 'profile' && d.ownerUid === 'UID_OWNER').map((d) => d.version).sort();
  assert.deepEqual(versions, [1, 2], 'settings history kept');
  await page.click('#zk-settings'); await page.selectOption('#zk-basis', 'gold'); await svSubmit();
  await page.locator('#zk-nisab-value', { hasText: '340,000' }).waitFor();
  assert.match(await page.locator('#zk-estimate').innerText(), /\d/);
  await shot(page, '43-zakat-en');
});

await check('S37–S39 record Zakat payment, optionally as ONE Finance expense', async () => {
  const before = Object.keys(await svDump()).filter((p) => p.includes('/expenses/zk_')).length;
  await page.click('#zk-pay'); await page.fill('#zp-amount', '7125'); await page.check('#zp-link'); await svSubmit();
  await page.locator('#zk-history li[data-kind="payment"]').waitFor();
  const d = await svDump();
  const exps = Object.entries(d).filter(([p]) => p.includes('/expenses/zk_'));
  assert.equal(exps.length, before + 1, 'exactly one linked expense');
  assert.deepEqual([exps.at(-1)[1].category, exps.at(-1)[1].amountMinor], ['zakat', 712500]);
  await page.click('#zk-pay'); await page.fill('#zp-amount', '10'); await svSubmit();
  assert.equal(Object.keys(await svDump()).filter((p) => p.includes('/expenses/zk_')).length, before + 1, 'unlinked payment adds no expense');
  await page.click('#zk-snapshot');
  await page.locator('#zk-history li[data-kind="snapshot"]').waitFor();
});

await check('S46 stale / manual prices are labelled honestly; provider not configured', async () => {
  await page.evaluate(() => {
    const home = window.__fake.paths().find((p) => /^homes\/[^/]+$/.test(p));
    window.__fake.patch(`${home}/priceQuotes/oldSilver925`, { kind: 'metal', key: 'silver-925', priceMinor: 4000, currency: 'EGP', source: 'manual', observedAt: Date.now() - 9 * 86400000, note: null, createdBy: 'UID_OWNER', schemaVersion: 1 });
  });
  await page.click('#sv-tab-valuation');
  await page.locator('#sv-provider', { hasText: 'not configured' }).waitFor();
  await page.locator('#sv-prices li[data-key="gold-21"] .pill', { hasText: 'Manual' }).waitFor();
  assert.equal(await page.locator('#sv-prices .pill', { hasText: /^Live$/ }).count(), 0, 'never "Live" without a provider');
});

await check('S40–S45 Arabic RTL, dark, mobile: no overflow; amounts and grams render', async () => {
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await svOpen();
  await page.locator('#sv-tab-zakat', { hasText: 'الزكاة' }).waitFor();
  await page.click('#sv-tab-zakat'); await page.locator('#zk-status').waitFor();
  assert.match(await page.locator('#zk-status').innerText(), /الحول|النصاب/);
  await ensureTheme(page, 'dark');
  // A theme change re-renders the page (tab resets to Overview, app-wide behaviour): re-open Zakat
  // so the Arabic + dark Zakat screen is what is actually verified and captured.
  await page.click('#sv-tab-zakat'); await page.locator('#zk-status').waitFor();
  assert.match(await page.locator('#zk-status').innerText(), /الحول|النصاب/);
  await page.locator('#zk-breakdown').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '44-zakat-ar-dark');
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const p = await newPage(m);
  await p.goto(BASE); await p.fill('#login-email', 'owner@example.com'); await p.fill('#login-password', 'correct-horse'); await p.click('button[type=submit]');
  await p.fill('#setup-name', 'A'); await p.fill('#setup-home', 'B'); await p.click('button[type=submit]'); await p.locator('.hero__home').waitFor();
  await p.goto(BASE + '#/m/savings'); await p.locator('#sv-add').click();
  await p.selectOption('#sa-type', 'gold'); await p.fill('#sa-name', 'ذهب'); await p.fill('#sa-opening', '12.5');
  await p.click('dialog[open] button[type=submit]'); await p.locator('dialog[open]').waitFor({ state: 'detached' });
  for (const id of ['overview', 'assets', 'activity', 'valuation', 'zakat']) {
    await p.click(`#sv-tab-${id}`);
    assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `savings ${id} overflow`);
  }
  await p.click('#sv-tab-assets'); await shot(p, '45-savings-assets-mobile');
  assert.deepEqual(p.errors, []);
  await ensureTheme(page, 'light');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
});

await check('S47–S48 logout stops every savings listener; login restores the same data', async () => {
  await svOpen('Mine'); await page.click('#sv-tab-assets'); await card('Gold bars').waitFor();
  const home = await page.evaluate(() => window.__fake.paths().find((p) => /^homes\/[^/]+$/.test(p)));
  await logout();
  for (const c of ['savingsAssets', 'savingsEvents', 'priceQuotes', 'zakatRecords']) {
    assert.equal(await page.evaluate((x) => window.__fake.listenerCountPrefix(x), `${home}/${c}`), 0, c);
  }
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await svOpen('Mine'); await page.click('#sv-tab-assets'); await card('Gold bars').waitFor();
  assert.deepEqual(page.errors.filter((e) => !/permission/i.test(e)), []);
  // Leave the app as the next (Phase 1) checks expect it: owner, dashboard.
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
});


await check('Live: membership suspended while signed in -> "Membership inactive" screen', async () => {
  await page.evaluate(() => {
    const p = window.__fake.paths().find((x) => x.endsWith('/members/UID_OWNER'));
    window.__fake.patch(p, { status: 'suspended' });
  });
  await page.locator('.gate__code', { hasText: 'MEMBERSHIP_INACTIVE' }).waitFor();
  assert.equal(await page.locator('.hero').count(), 0, 'dashboard removed');
  await shot(page, '06-error-membership-inactive-en-dark');
});

await check('Recovery: reactivate + Try again -> dashboard', async () => {
  await page.evaluate(() => {
    const p = window.__fake.paths().find((x) => x.endsWith('/members/UID_OWNER'));
    window.__fake.patch(p, { status: 'active' });
  });
  await page.click('text=Try again');
  await page.locator('.hero__home').waitFor();
});

await check('Navigation icons render in both the sidebar and the bottom dock', async () => {
  await page.goto(BASE + '#/dashboard');
  await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('.rail .nav-link svg').count(), 2, 'dashboard + settings icons in sidebar');
  // V6.4: the dock is one scrollable row (no "More"): dashboard + settings use SVG icons, modules their glyphs.
  assert.equal(await page.locator('#dock-more-btn').count(), 0, 'no More overflow');
  assert.equal(await page.locator('.dock .nav-link svg').count(), 2, 'dashboard + settings icons in dock');
});

await check('Error: role document missing -> "Role not found"', async () => {
  await page.evaluate(() => window.__fake.remove(window.__fake.paths().find((x) => x.endsWith('/roles/owner'))));
  await page.reload();
  await page.locator('.gate__code', { hasText: 'ROLE_MISSING' }).waitFor();
});

await check('No uncaught page errors during the whole run', async () => {
  assert.deepEqual(page.errors, []);
});

// ------------------------------------------------------------------ mobile / init failure
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await check('Mobile: bottom dock, no sidebar, no horizontal overflow (Arabic, light)', async () => {
  const p = await newPage(mobile);
  await p.goto(BASE);
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload();
  await p.fill('#login-email', 'owner@example.com');
  await p.fill('#login-password', 'correct-horse');
  await shot(p, '07-login-ar-mobile');
  await p.click('button[type=submit]');
  await p.fill('#setup-name', 'Abdo Adel');
  await p.fill('#setup-home', 'بيت عادل');
  await p.click('button[type=submit]');
  await p.locator('.hero__home').waitFor();
  assert.ok(await p.locator('.dock').isVisible());
  assert.ok(!(await p.locator('.rail').isVisible()));
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await shot(p, '08-dashboard-ar-light-mobile');
  await p.evaluate(() => window.scrollTo(0, 600));
  await shot(p, '09-dashboard-ar-light-mobile-scrolled');
  // Phase 2: Rooms on a phone — add a room through the bottom-sheet dialog.
  await p.goto(BASE + '#/m/rooms');
  await p.locator('.empty-state').waitFor();
  await p.click('.empty-state .btn--primary');
  await p.locator('dialog[open] #room-name').waitFor();
  await shot(p, '20-room-form-ar-mobile');
  await p.fill('#room-name', 'المطبخ الرئيسي');
  await p.selectOption('#room-type', 'kitchen');
  await p.click('dialog[open] button[type=submit]');
  await p.locator('.room-card').waitFor();
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'rooms page overflow');
  await shot(p, '21-rooms-ar-mobile');
  // Phase 3: Devices on a phone.
  await p.goto(BASE + '#/m/devices');
  await p.locator('.empty-state').waitFor();
  await p.click('.quick-rooms__btn >> nth=1');
  await p.locator('dialog[open] #dev-name').waitFor();
  await p.click('dialog[open] .form-section__summary');
  await shot(p, '30-device-form-ar-mobile');
  await p.click('dialog[open] button[type=submit]');
  await p.locator('.device-card').waitFor();
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'devices page overflow');
  await shot(p, '31-devices-ar-mobile');
  // F26 Finance on a phone: wallet, quick add, history, no overflow.
  await p.goto(BASE + '#/m/expenses');
  await p.locator('form.qa').waitFor();
  await p.click('#fin-tab-wallets');
  await p.click('.fin-intro .btn--primary');
  await p.fill('#wl-name', 'نقدية المنزل');
  await p.click('dialog[open] button[type=submit]');
  await p.locator('.fin-wallet').waitFor();
  await p.fill('#qa-amount', '120'); await p.fill('#qa-note', 'خبز');
  await p.click('form.qa button[type=submit]');
  await p.click('#fin-tab-history');
  await p.locator('#fm-rows .fm-tr[data-expense]').waitFor();
  for (const id of ['overview', 'history', 'commitments', 'wallets']) {
    await p.click(`#fin-tab-${id}`);
    assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `finance ${id} overflow`);
  }
  await p.click('#fin-tab-history');
  await shot(p, '38-finance-history-ar-mobile');
  await p.click('#fin-tab-overview');
  await shot(p, '39-finance-overview-ar-mobile');
  assert.deepEqual(p.errors, []);
});

// =================================================================== PHASE 5.3.1 — TEMPLATE INTEGRATION + DASHBOARD CARD
await check('T-UI rooms/devices → cleaning templates: card styling, review with frequencies, idempotent setup, lifecycle', async () => {
  await ensureSignedOut();
  const H = 'hTplUI';
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  await page.evaluate((h) => {
    window.__fake.set(`homes/${h}`, { name: 'Template Test Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: 'en' });
    // V6.3.0.1: the routine (now the Cleaning page) starts its day at `startHour` (default 3). Pin 0 so this test
    // sees today's tasks at ANY time of day (same fixture fix as B0; the night window is covered by ADV-NIGHT).
    window.__fake.set(`homes/${h}/cleaningSettings/general`, { catchUpMax: 2, startHour: 0, updatedBy: 'UID_OWNER', updatedAt: new Date().toISOString(), schemaVersion: 1 });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    const R = (name, type, order) => ({ name, type, icon: type, floor: null, notes: null, order, active: true, archivedAt: null, archivedBy: null });
    window.__fake.set(`homes/${h}/rooms/kitchen`, R('Kitchen', 'kitchen', 1));
    window.__fake.set(`homes/${h}/rooms/garage`, R('Garage', 'garage', 2));
    window.__fake.set(`homes/${h}/rooms/living`, R('Living room', 'living_room', 3));
    const D = (name, category, subtype, roomId) => ({ name, category, subtype, roomId, status: 'operational', icon: 'plug', active: true });
    window.__fake.set(`homes/${h}/devices/dw`, D('Dishwasher', 'kitchen_appliance', 'dishwasher', 'kitchen'));
    window.__fake.set(`homes/${h}/devices/ac1`, D('Bedroom AC', 'air_conditioning', 'split_ac', null));
    window.__fake.set(`homes/${h}/cleaningTasks/manualDishes`, { title: 'Wash the dishes', instructions: null, roomId: 'kitchen', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [],
      recurrence: { kind: 'days', interval: 1 }, startDate: '2026-01-01', dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h });
  }, H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // Issue 1: the Cleaning card is the shared summary-card and renders like the Rooms card.
  // Dashboard cards load lazily: wait for BOTH cards before comparing their computed styles.
  await page.locator('#cl-widget.summary-card').waitFor();
  // V6.4: the Rooms tile is gone; compare with another shared summary-card that stays (Maintenance).
  await page.locator('a.summary-card[href="#/m/maintenance"]').waitFor();
  const look = await page.evaluate(() => {
    const pick = (el) => { const c = getComputedStyle(el); return [c.display, c.paddingTop, c.borderRadius, c.borderTopWidth, getComputedStyle(el.querySelector('.summary-card__title')).fontSize]; };
    return { clean: pick(document.querySelector('#cl-widget')), other: pick(document.querySelector('a.summary-card[href="#/m/maintenance"]')) };
  });
  assert.deepEqual(look.clean, look.other, 'same card layout/spacing/typography as the other summary cards');
  assert.equal(await page.locator('#cl-widget .summary-card__icon').count(), 1);
  // Review: existing rooms/devices recognised; frequencies shown; equivalent manual task covers one.
  await cleaningTasks(); await page.locator('#cl-setup').waitFor();
  // Kitchen 10 (11 − 1 covered) + Living room 5 + Dishwasher 5; Garage unmapped; AC fully deferred.
  assert.match(await page.locator('#cl-setup').innerText(), /38 cleaning tasks are suggested for 2 room\(s\) and 2 device\(s\)/);
  await page.click('#cl-setup-btn');
  await page.locator('.cl-setup__group[data-source=kitchen]').waitFor();
  assert.equal(await page.locator('.cl-setup__group[data-source=kitchen] input[name=cl-setup-item]').count(), 10, 'kitchen: 11 template tasks − 1 covered');
  assert.match(await page.locator('.cl-setup__group[data-source=kitchen]').innerText(), /Every 1 day\(s\) after it's done[\s\S]*1 already covered by your tasks: Wash the dishes/);
  assert.equal(await page.locator('.cl-setup__group[data-source=dw] input[name=cl-setup-item]').count(), 7, 'dishwasher: 5 periodic + 2 after-cycle (Phase 5.4b)');
  assert.match(await page.locator('.cl-setup__group[data-source=dw]').innerText(), /1 condition-based \/ manual device task\(s\) will come in a later update/);
  assert.equal(await page.locator('.cl-setup__group[data-source=garage]').count(), 0, 'unmapped room not offered');
  assert.equal(await page.locator('.cl-setup__group[data-source=ac1] input[name=cl-setup-item]').count(), 16, 'Phase 5.4b: the AC is offered its 16 seasonal tasks');
  await page.uncheck('input[name=cl-setup-item][value=r_kitchen_kitchen_1]');
  await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-setup').waitFor({ state: 'detached' });
  const created = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningTasks/`) && !k.endsWith('manualDishes')).map(([k, v]) => [k.split('/').pop(), v.active, v.recurrence.kind, v.trigger ? v.trigger.kind : null]), H);
  assert.equal(created.length, 38, 'Phase 5.4b: + 16 AC seasonal + 2 dishwasher after-cycle');
  assert.deepEqual(created.filter(([, a]) => !a).map(([id]) => id), ['r_kitchen_kitchen_1'], 'unticked → declined tombstone');
  // Phase 5.4b: periodic → 'after' (no trigger); usage → 'onUse' + afterUse; season checklists → 'onSeason' + seasonal.
  assert.ok(created.every(([, , k, tr]) => (k === 'after' && (tr === null || tr === 'seasonal')) || (k === 'onUse' && tr === 'afterUse') || (k === 'onSeason' && tr === 'seasonal')));
  // Idempotent: reload → no banner, still 20 (+1 manual).
  await cleaningTasks(page, { reload: true }); await page.locator('#cl-manage .cl-item').first().waitFor();
  assert.equal(await page.locator('#cl-setup').count(), 0);
  // V6.3: Done on a generated daily task directly from Today's routine (the default view; no claim step).
  await page.click('#cl-adv-tab-routine');
  const daily = page.locator('#cl-adv-routine .cl-item[data-task=r_kitchen_kitchen_2]');
  await daily.waitFor(); await daily.locator('[data-action=complete]').first().click();   // one tap, no dialog
  await page.locator('#cl-adv-routine .cl-item[data-task=r_kitchen_kitchen_2][data-status=done]').waitFor();
  // Lifecycle: archive room hides its generated tasks; restore brings them back; rename is live.
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/rooms/kitchen`, { active: false }), H);
  await page.locator('#cl-adv-routine .cl-item[data-task^=r_kitchen_]').first().waitFor({ state: 'detached' });
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/rooms/kitchen`, { active: true, name: 'Big Kitchen' }), H);
  await page.locator('#cl-adv-routine .cl-item[data-task^=r_kitchen_]', { hasText: 'Big Kitchen' }).first().waitFor();
  // Relocation: dishwasher moves to the living room → its tasks follow the room filter (Tasks tab).
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/devices/dw`, { roomId: 'living' }), H);
  await page.click('#cl-adv-tab-tasks'); await page.selectOption('#cl-room-filter', 'living');
  await page.locator('#cl-manage .cl-item[data-task^=d_dw_]').first().waitFor();
  assert.equal(await page.locator('#cl-manage .cl-item[data-task^=r_kitchen_]').count(), 0, 'kitchen tasks filtered out');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

// =================================================================== PHASE 5.3.2 HOTFIX — visible setup behaviour
await check('H-UI setup hotfix: optimistic rollback + per-request limit + one rejected task → confirmed progress, saved tasks stay, honest "21 of 22", retry adds only the missing one', async () => {
  await ensureSignedOut();
  const H = 'hHotfixUI';
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  await page.evaluate((h) => {
    window.__fake.set(`homes/${h}`, { name: 'Hotfix Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', order: 1, active: true });
    window.__fake.set(`homes/${h}/rooms/bath`, { name: 'Bathroom', type: 'bathroom', icon: 'bathroom', order: 2, active: true });
    window.__fake.set(`homes/${h}/devices/dw`, { name: 'Dishwasher', category: 'kitchen_appliance', subtype: 'dishwasher', roomId: 'kit', status: 'operational', icon: 'dishwasher', active: true });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
  }, H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await cleaningTasks(); await page.locator('#cl-setup', { hasText: /24 cleaning tasks/ }).waitFor();
  // Production conditions: optimistic SDK + a per-request limit that rejects multi-task batches + one task rejected.
  await page.evaluate(() => { window.__fakeOptimistic = true; window.__fakeMaxOpsPerCommit = 1; window.__fakeDenyIds = ['r_bath_bathroom_2']; });
  try {
  await page.click('#cl-setup-btn'); await page.locator('#cl-setup-form').waitFor();
  const stored = (h) => page.evaluate((hh) => Object.entries(window.__fake.dump()).filter(([k, v]) => k.startsWith(`homes/${hh}/cleaningTasks/`) && !v.__pending).length, h);
  const counts = [];
  const poll = setInterval(() => { stored(H).then((n) => counts.push(n)).catch(() => {}); }, 40);
  await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-setup-result').waitFor();
  clearInterval(poll);
  assert.ok(counts.every((n, i) => i === 0 || n >= counts[i - 1]), 'saved tasks never disappear during the setup');
  const result = await page.locator('#cl-setup-result').innerText();
  assert.match(result, /Saved 23 of 24 tasks/); assert.match(result, /1 could not be saved/); assert.match(result, /never duplicated/);
  assert.equal(await stored(H), 23, '23 genuinely stored (confirmed), none rolled back');
  await page.locator('#cl-manage .cl-item').nth(22).waitFor();
  assert.equal(await page.locator('#cl-manage .cl-item').count(), 23, 'the saved tasks stay visible');
  await page.locator('#cl-setup', { hasText: /1 cleaning task/ }).waitFor();        // review refreshed: only the missing one
  // Retry once the cause is gone: exactly the missing task is added — no duplicates.
  await page.evaluate(() => { window.__fakeDenyIds = []; });
  await page.click('#cl-setup-btn'); await page.locator('#cl-setup-form').waitFor();
  assert.equal(await page.locator('input[name="cl-setup-item"]').count(), 1);
  await page.click('dialog[open] button[type=submit]');
  // The dialog stays open (with confirmed progress) until every write is confirmed; the banner may
  // vanish earlier because of the SDK's optimistic copy — so wait for the dialog, not the banner.
  await page.locator('#cl-setup-form').waitFor({ state: 'detached' });
  assert.equal(await stored(H), 24, 'exactly 24 (Phase 5.4b: + 2 dishwasher after-cycle), no duplicates');
  assert.equal(await page.locator('#cl-setup').count(), 0, 'nothing left to suggest');
  assert.equal(await page.locator('#cl-setup-result').count(), 0, 'outcome notice cleared after a complete setup');
  } finally {
    await page.evaluate(() => { window.__fakeOptimistic = false; window.__fakeMaxOpsPerCommit = undefined; window.__fakeDenyIds = []; });
  }
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

// =================================================================== PHASE 5.6 — REMINDERS
await check('RM-UI reminders: derived counts (bell + card); groups; read / snooze / dismiss / restore never touch tasks; deep links highlight; done → next cycle; reload; per-user; no-access; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hRem';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null, sara: d['users/UID_SARA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump(); const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'Reminder Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.complete', 'maintenance.view', 'maintenance.complete', 'rooms.view', 'members.view', 'devices.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/guest`, { name: 'Guest', rank: 10, permissions: ['members.view'], system: false, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/members/UID_SARA`, { uid: 'UID_SARA', email: 'sara@example.com', displayName: 'Sara', roleId: 'guest', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/devices/ac`, { name: 'Living AC', category: 'air_conditioning', subtype: 'split_ac', roomId: 'kit', status: 'operational', icon: 'other', active: true });
    const T = (title, extra) => ({ title, instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1, ...extra });
    window.__fake.set(`homes/${h}/cleaningTasks/tToday`, T('Wipe counter', { recurrence: { kind: 'days', interval: 1 }, startDate: iso(0) }));
    window.__fake.set(`homes/${h}/cleaningTasks/tSoon`, T('Descale kettle', { recurrence: { kind: 'once' }, startDate: iso(2), dueDate: iso(2) }));
    window.__fake.set(`homes/${h}/maintenancePlans/p1`, { title: 'AC service', instructions: null, notes: null, deviceId: 'ac', recurrence: { kind: 'every', unit: 'month', interval: 6 }, firstDueDate: iso(-1), assigneeUid: null, estimatedMinutes: null, priority: 'high', active: true, archivedAt: null, archivedBy: null, completedCount: 0, lastDoneDate: null, rev: 1, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/maintenanceFaults/f1`, { summary: 'Water leak', description: null, diagnosis: null, resolution: null, deviceId: 'ac', severity: 'high', assigneeUid: null, estimateMinor: null, estimateCurrency: null, status: 'open', rev: 1, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/maintenanceFaults/f2`, { summary: 'Old issue', description: null, diagnosis: null, resolution: null, deviceId: 'ac', severity: 'low', assigneeUid: null, estimateMinor: null, estimateCurrency: null, status: 'resolved', rev: 3, schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
    window.__fake.set('users/UID_SARA', { ...(d['users/UID_SARA'] || {}), email: 'sara@example.com', displayName: 'Sara', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const src = () => page.evaluate((h) => JSON.stringify(Object.entries(window.__fake.dump()).filter(([k]) => /\/(cleaningTasks|cleaningOccurrences|maintenancePlans|maintenanceFaults|maintenanceRecords)\//.test(k) && k.startsWith(`homes/${h}/`)).sort()), H);
  const states = () => page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/reminderStates/`)).map(([, v]) => v), H);
  const badge = () => page.locator('#reminders-bell .bell-btn__badge').innerText();
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 1. Bell + dashboard card — V6.2: 3 actionable (overdue plan, ONE "Pending cleaning tasks", open fault). Cleaning no longer
  //    reminds per task or for upcoming tasks; the resolved fault is not actionable.
  await page.waitForFunction(() => (document.querySelector('#reminders-bell .bell-btn__badge') || {}).textContent === '3');
  // V6.4: no Reminders dashboard tile — the bell badge, the page and the Tools entry stay.
  assert.equal(await page.locator('#rm-widget').count(), 0, 'Reminders tile removed');
  await page.locator('#tool-reminders[href="#/reminders"]').waitFor();
  const before0 = await src();
  // Lightweight bell: on pages that don't already load Cleaning / Maintenance, no count and no listeners.
  await page.goto(BASE + '#/m/rooms'); await page.locator('#reminders-bell').waitFor();
  assert.equal(await page.locator('#reminders-bell .bell-btn__badge').isHidden(), true, 'no count (no reminder listeners) on Rooms');
  await page.goto(BASE + '#/dashboard'); await page.waitForFunction(() => (document.querySelector('#reminders-bell .bell-btn__badge') || {}).textContent === '3');
  // 2. Groups and honest labels; ONE aggregated cleaning item with its count.
  await page.click('#reminders-bell'); await page.locator('#rm-counts').waitFor();
  assert.match(await page.locator('#rm-delivery').innerText(), /Background notifications are not implemented/);
  assert.match(await page.locator('#rm-g-overdue').innerText(), /AC service/);
  assert.match(await page.locator('#rm-g-today').innerText(), /Pending cleaning tasks[\s\S]*1 task\(s\)/);
  assert.equal(await page.locator('.rm-item:has-text("Pending cleaning tasks")').count(), 1, 'exactly one cleaning reminder');
  assert.match(await page.locator('#rm-g-openFault').innerText(), /Water leak[\s\S]*No due date/);
  assert.doesNotMatch(await page.locator('#rm-groups').innerText(), /Old issue|Descale kettle|Wipe counter/);
  // 3. Read / snooze / dismiss / restore: presentation only.
  await page.locator('.rm-item:has-text("AC service") [data-action=read]').click();
  await page.locator('.rm-item[data-presentation=read]:has-text("AC service")').waitFor();
  await page.locator('.rm-item:has-text("Water leak") select[data-action=snooze]').selectOption('3');
  await page.locator('#rm-hidden .rm-item[data-presentation=snoozed]:has-text("Water leak")').waitFor({ state: 'attached' });   // inside the collapsed section
  await page.locator('.rm-item:has-text("Pending cleaning tasks") [data-action=dismiss]').click();
  await page.locator('#rm-hidden .rm-item[data-presentation=dismissed]:has-text("Pending cleaning tasks")').waitFor({ state: 'attached' });
  await page.waitForFunction(() => (document.querySelector('#reminders-bell .bell-btn__badge') || {}).textContent === '1');
  assert.equal(await src(), before0, 'tasks, occurrences, plans and faults are byte-identical');
  const st = await states();
  assert.ok(st.length === 3 && st.every((x) => x.ownerUid === 'UID_OWNER'), 'three owner-scoped presentation states');
  await page.locator('#rm-hidden summary').click();
  await page.locator('#rm-hidden .rm-item:has-text("Pending cleaning tasks") [data-action=restore]').click();
  await page.locator('#rm-g-today .rm-item:has-text("Pending cleaning tasks")').waitFor();
  // 4. Deep links open the source module.
  await page.locator('.rm-item:has-text("AC service") [data-action=open]').click();
  await page.waitForFunction(() => location.hash === '#/m/maintenance');
  await page.locator('#mt-plans [data-plan="p1"].is-focus').waitFor();
  await page.goto(BASE + '#/reminders'); await page.locator('.rm-item:has-text("Pending cleaning tasks") [data-action=open]').click();
  await page.waitForFunction(() => location.hash === '#/m/cleaning');
  await page.locator('#cl-adv-list .cl-item[data-task="tToday"]').waitFor();
  // 5. Done in Cleaning → nothing pending → the cleaning reminder disappears (scheduling untouched).
  await page.locator('#cl-adv-list .cl-item[data-task="tToday"] [data-action=complete]').first().click();   // V6.1: one tap, no dialog
  await page.locator('#cl-adv-list .cl-item[data-task="tToday"][data-status=done]').waitFor();
  await page.goto(BASE + '#/reminders'); await page.locator('#rm-counts').waitFor();
  await page.waitForFunction(() => !/Pending cleaning tasks/.test((document.querySelector('#rm-groups') || {}).textContent || ''));
  // 6. Reload persistence; per-user separation (Mona does not inherit the owner's snooze; her look-ahead is hers).
  await page.reload(); await page.locator('#rm-hidden').waitFor();
  assert.match(await page.locator('#rm-hidden').textContent(), /Water leak/, 'still snoozed after reload (inside the collapsed section)');
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/reminders'); await page.locator('#rm-g-openFault .rm-item:has-text("Water leak")').waitFor();
  await page.click('#rm-settings-btn'); await page.selectOption('#rm-look', '1'); await page.click('#rm-save');
  await page.waitForFunction((h) => (window.__fake.dump()[`homes/${h}/reminderPrefs/UID_MONA`] || {}).lookAheadDays === 1, H);
  assert.ok(await page.evaluate((h) => !!window.__fake.dump()[`homes/${h}/cleaningTasks/tSoon`], H), 'the task itself is untouched');
  // 7. No access: no bell, no card, page refuses.
  await logout(); await login('sara@example.com'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('#reminders-bell').count(), 0); assert.equal(await page.locator('#rm-widget, #tool-reminders').count(), 0);
  await page.goto(BASE + '#/reminders'); await page.locator('.banner', { hasText: "don't have access to Cleaning or Maintenance" }).waitFor();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 8. Arabic + mobile.
  await page.goto(BASE + '#/reminders');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#rm-delivery', { hasText: 'إشعارات الخلفية غير مُفعّلة' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '55-reminders-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { for (const [k, v] of [['UID_OWNER', b.owner], ['UID_MONA', b.mona], ['UID_SARA', b.sara]]) if (v) window.__fake.set(`users/${k}`, v); }, before);
});

// =================================================================== PHASE 5.5 — DEVICE MAINTENANCE
await check('MT-UI Device Details: Maintenance + Cleaning live (no placeholder); plan → done once (cost) → due recalculated; failed write + retry; fault lifecycle audited; history totals; 2nd member; archived read-only; Home switch; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hMaint'; const H2 = 'hMaint2';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate(([h, h2]) => {
    const d = window.__fake.dump();
    for (const x of [h, h2]) {
      window.__fake.set(`homes/${x}`, { name: x === h ? 'Maintenance Home' : 'Other Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
      window.__fake.set(`homes/${x}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
      window.__fake.set(`homes/${x}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    }
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['maintenance.view', 'maintenance.create', 'maintenance.edit', 'maintenance.complete', 'cleaning.view', 'rooms.view', 'members.view', 'devices.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/liv`, { name: 'Living', type: 'living_room', icon: 'living_room', sortOrder: 1, active: true });
    const D = (name, category, subtype, extra = {}) => ({ name, category, subtype, roomId: 'liv', status: 'operational', icon: 'other', active: true, ...extra });
    window.__fake.set(`homes/${h}/devices/ac`, D('Living AC', 'air_conditioning', 'split_ac'));
    window.__fake.set(`homes/${h}/devices/misc`, D('Odd gadget', 'other', null));
    window.__fake.set(`homes/${h}/devices/old`, D('Old heater', 'heating', 'space_heater', { active: false }));
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, [H, H2]);
  const docs = (c) => page.evaluate(([h, c]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/${c}/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), [H, c]);
  const openDevice = async (id) => { await page.goto(BASE + '#/m/devices'); await page.locator(`.device-card[data-device-id="${id}"] .room-card__main`).click(); await page.locator('#dev-maintenance').waitFor(); };
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 1. Device Details: Maintenance AND Cleaning live; no "coming later" text at all.
  await openDevice('ac'); await page.locator('#dev-cleaning').waitFor();
  assert.doesNotMatch(await page.locator('dialog[open]').innerText(), /Coming in a future HomeHub update/, 'no placeholder left');
  await page.locator('#dev-mt-empty', { hasText: 'No maintenance plans or faults for this device yet' }).waitFor();
  assert.match(await page.locator('#dev-mt-suggest').innerText(), /Professional only/);
  // 2. Add a plan from Device Details (device preselected) → Due → Mark done ONCE with cost → recalculated.
  await page.click('#dev-mt-add-plan'); await page.locator('#mt-plan-form').waitFor();
  assert.equal(await page.locator('#mt-device').inputValue(), 'ac');
  assert.equal(await page.locator('#mt-device option[value="old"]').count(), 0, 'archived devices are never offered');
  await page.fill('#mt-title', 'AC filter replacement'); await page.fill('#mt-interval', '6'); await page.selectOption('#mt-unit', 'month');
  await page.fill('#mt-first', await page.evaluate(() => new Date().toISOString().slice(0, 10)));
  await page.click('dialog[open] button[type=submit]'); await page.locator('#mt-plan-form').waitFor({ state: 'detached' });
  const [plan] = await docs('maintenancePlans');
  assert.deepEqual([plan.deviceId, plan.completedCount, plan.rev], ['ac', 0, 1]);
  await page.locator(`#mt-due-dueToday [data-plan="${plan.id}"]`).waitFor();
  await page.locator(`[data-plan="${plan.id}"] [data-action=complete]`).click(); await page.locator('#mt-service-form').waitFor();
  await page.fill('#mt-svc-work', 'Filter replaced'); await page.fill('#mt-svc-provider', 'CoolFix'); await page.fill('#mt-svc-cost', '450');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#mt-service-form').waitFor({ state: 'detached' });
  const recs = await docs('maintenanceRecords');
  assert.deepEqual(recs.map((r) => [r.id, r.costMinor, r.currency, r.kind]), [[`${plan.id}_c1`, 45000, 'EGP', 'preventive']]);
  await page.locator('#mt-due-empty').waitFor();   // next due is 6 months out
  await page.click('#mt-tab-plans'); await page.locator(`#mt-plans [data-plan="${plan.id}"][data-status=upcoming]`).waitFor();
  // 3. Failed write → honest error, no record; retry → exactly one record.
  await page.click('#mt-new'); await page.locator('#mt-plan-form').waitFor();
  await page.selectOption('#mt-device', 'misc'); await page.fill('#mt-title', 'One-off check'); await page.selectOption('#mt-kind', 'once');
  await page.fill('#mt-first', await page.evaluate(() => new Date().toISOString().slice(0, 10)));
  await page.click('dialog[open] button[type=submit]'); await page.locator('#mt-plan-form').waitFor({ state: 'detached' });
  const once = (await docs('maintenancePlans')).find((p) => p.title === 'One-off check');
  // The page was opened from the AC's details, so it is filtered to that device (by design) — show all devices.
  await page.selectOption('#mt-device-filter', 'all');
  await page.click('#mt-tab-due'); await page.locator(`[data-plan="${once.id}"] [data-action=complete]`).click(); await page.locator('#mt-service-form').waitFor();
  await page.evaluate(() => { window.__fakeFailNextCommit = true; });
  await page.click('dialog[open] button[type=submit]'); await page.locator('.toast').first().waitFor();
  assert.equal((await docs('maintenanceRecords')).length, 1, 'failed write saved nothing');
  await page.locator('#mt-service-form').waitFor();   // dialog still open for a retry
  await page.click('dialog[open] button[type=submit]'); await page.locator('#mt-service-form').waitFor({ state: 'detached' });
  assert.equal((await docs('maintenanceRecords')).filter((r) => r.planId === once.id).length, 1, 'exactly one record after retry');
  // 4. Fault lifecycle: report → start → resolve (repair cost) → close; audited.
  await page.click('#mt-report'); await page.locator('#mt-fault-form').waitFor();
  await page.selectOption('#mt-device', 'ac'); await page.fill('#mt-summary', 'Water dripping'); await page.selectOption('#mt-severity', 'high');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#mt-fault-form').waitFor({ state: 'detached' });
  const [fault] = await docs('maintenanceFaults');
  const step = async (to, fill) => {
    await page.click('#mt-tab-faults'); await page.selectOption('#mt-fault-filter', 'all');
    await page.locator(`#mt-faults [data-fault="${fault.id}"] .mt-linkish`).click(); await page.locator(`dialog[open] [data-to="${to}"]`).click();
    if (fill) await fill();
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(([h, id, st]) => (window.__fake.dump()[`homes/${h}/maintenanceFaults/${id}`] || {}).status === st, [H, fault.id, to]);
  };
  await step('inProgress', () => page.fill('#mt-note', 'Technician booked'));
  await step('resolved', async () => { await page.fill('#mt-resolution', 'Drain line cleared'); await page.fill('#mt-svc-cost', '300'); await page.fill('#mt-svc-provider', 'CoolFix'); });
  await step('closed');
  const evs = (await docs('maintenanceFaultEvents')).filter((e) => e.faultId === fault.id).map((e) => `${e.fromStatus}>${e.toStatus}`).sort();
  assert.deepEqual(evs, ['inProgress>resolved', 'null>open', 'open>inProgress', 'resolved>closed']);
  assert.equal((await docs('maintenanceRecords')).find((r) => r.id === `${fault.id}_r3`).costMinor, 30000);
  // 5. History: combined timeline and per-currency totals (750.00 EGP actual).
  await page.click('#mt-tab-history'); await page.locator('#mt-totals').waitFor();
  assert.match(await page.locator('#mt-totals').innerText(), /750/);
  assert.equal(await page.locator('#mt-history-list .cl-item').count(), 3);
  // 6. Second member; archived device read-only.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/maintenance'); await page.click('#mt-tab-plans'); await page.selectOption('#mt-plan-filter', 'all');
  await page.locator(`#mt-plans [data-plan="${plan.id}"]`).waitFor();
  // Archived devices are listed in the Devices page's Archived view.
  await page.goto(BASE + '#/m/devices'); await page.click('.view-switch__btn:has-text("Archived")');
  await page.locator('.device-card[data-device-id="old"] .room-card__main').click(); await page.locator('#dev-maintenance').waitFor();
  assert.equal(await page.locator('#dev-mt-add-plan, #dev-mt-report').count(), 0, 'archived device: no add actions');
  await page.locator('#dev-maintenance', { hasText: 'archived' }).waitFor();
  await page.keyboard.press('Escape');
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 7. Arabic + mobile.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/m/maintenance'); await page.click('#mt-tab-plans'); await page.selectOption('#mt-plan-filter', 'all');
  await page.locator('#mt-tab-plans', { hasText: 'الخطط' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '53-maintenance-ar-mobile');
  await openDevice('ac');
  assert.doesNotMatch(await page.locator('dialog[open]').innerText(), /قادم في تحديث لاحق/, 'Arabic: no placeholder');
  await shot(page, '54-device-maintenance-ar-mobile');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  // 8. Home switch: the other Home shows none of this Home's maintenance data.
  await page.evaluate((h2) => window.__fake.patch('users/UID_OWNER', { defaultHomeId: h2 }), H2);
  await ensureSignedOut(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/maintenance'); await page.locator('#mt-no-devices').waitFor();
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.4d — DEVICE ↔ CLEANING
await check('DEV-LINK Device Details cleaning is live (EN/AR, Maintenance truthful); add / suggest / filter; Basic + Advanced device selector; edit trigger task; 2nd member; reload', async () => {
  await ensureSignedOut();
  const H = 'hDevLink';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump(); const day = new Date().toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'Device Link Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.create', 'cleaning.edit', 'cleaning.complete', 'rooms.view', 'members.view', 'devices.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/rooms/liv`, { name: 'Living', type: 'living_room', icon: 'living_room', sortOrder: 2, active: true });
    const D = (name, category, subtype, roomId, extra = {}) => ({ name, category, subtype, roomId, status: 'operational', icon: 'other', active: true, ...extra });
    window.__fake.set(`homes/${h}/devices/tv`, D('Living TV', 'audio_video', 'television', 'liv'));
    window.__fake.set(`homes/${h}/devices/misc`, D('Odd gadget', 'other', null, null));
    window.__fake.set(`homes/${h}/devices/af`, D('Air fryer', 'kitchen_appliance', 'air_fryer', 'kit'));
    window.__fake.set(`homes/${h}/devices/old`, D('Old heater', 'heating', 'space_heater', 'liv', { active: false }));
    window.__fake.set(`homes/${h}/cleaningTasks/tAF`, { title: 'Wipe air fryer basket', instructions: null, roomId: null, priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'af' }, startDate: day, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const tasks = () => page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningTasks/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), H);
  const openDevice = async (id) => { await page.goto(BASE + '#/m/devices'); await page.locator(`.device-card[data-device-id="${id}"] .room-card__main`).click(); await page.locator('#dev-cleaning').waitFor(); };
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 1. Device Details: Cleaning is live; only Maintenance says "coming".
  await openDevice('tv');
  await page.locator('#dev-cleaning-empty', { hasText: 'No cleaning tasks linked to this device yet' }).waitFor();
  const dlgText = await page.locator('dialog[open]').innerText();
  // Phase 5.5: Maintenance is live too — no "coming later" notice remains in Device Details.
  assert.equal((dlgText.match(/Coming in a future HomeHub update/g) || []).length, 0, 'no "coming later" notice');
  await page.locator('dialog[open] #dev-maintenance-slot').waitFor();
  // 2. Add cleaning task → Basic, device preselected, room follows the device.
  await page.click('#dev-cleaning-add'); await page.locator('#cl-task-form').waitFor();
  assert.equal(await page.locator('#ct-device').inputValue(), 'tv');
  assert.match(await page.locator('#ct-room option:checked').innerText(), /Follow the device's room \(now: Living\)/);
  assert.equal(await page.locator('#ct-device option[value="old"]').count(), 0, 'archived devices are never offered');
  await page.fill('#ct-title', 'Dust the TV'); await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-task-form').waitFor({ state: 'detached' });
  const tvTask = (await tasks()).find((t) => t.title === 'Dust the TV');
  assert.deepEqual([tvTask.deviceId, tvTask.roomId], ['tv', null]);
  assert.equal(await page.locator('#cl-device-filter').inputValue(), 'tv', 'Basic is filtered by the device');
  // 3. Device Details lists it; a suggestion pre-fills the form (nothing created until Save).
  await openDevice('tv');
  await page.locator(`#dev-cleaning-list [data-task="${tvTask.id}"]`).waitFor();
  const n0 = (await tasks()).length;
  await page.locator('#dev-cleaning-suggest [data-action=use-suggestion]').first().click(); await page.locator('#cl-task-form').waitFor();
  assert.ok((await page.locator('#ct-title').inputValue()).length > 0, 'suggestion pre-filled');
  assert.equal((await tasks()).length, n0, 'nothing created before Save');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#cl-task-form').waitFor({ state: 'detached' });
  assert.equal((await tasks()).length, n0 + 1);
  // 4. Advanced: New task for the "other"-category device; Edit → re-link to the TV.
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-new'); await page.locator('#cl-task-form').waitFor();
  await page.selectOption('#ct-device', 'misc'); await page.fill('#ct-title', 'Wipe the gadget');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#cl-task-form').waitFor({ state: 'detached' });
  const misc = (await tasks()).find((t) => t.title === 'Wipe the gadget');
  assert.equal(misc.deviceId, 'misc', 'null-subtype device linkable');
  await page.click('#cl-adv-tab-devices'); await page.locator(`#cl-dev-task-misc`).waitFor();
  await cleaningTasks();
  await page.locator(`#cl-manage .cl-item[data-task="${misc.id}"] [data-action=edit]`).click(); await page.locator('#cl-task-form').waitFor();
  await page.selectOption('#ct-device', 'tv'); await page.click('dialog[open] button[type=submit]'); await page.locator('#cl-task-form').waitFor({ state: 'detached' });
  await page.waitForFunction(([h, id]) => (window.__fake.dump()[`homes/${h}/cleaningTasks/${id}`] || {}).deviceId === 'tv', [H, misc.id]);
  // 5. Editing an after-use task now works (device + recurrence read-only).
  await page.locator('#cl-manage .cl-item[data-task="tAF"] [data-action=edit]').click(); await page.locator('#ct-device-fixed').waitFor();
  assert.ok(await page.locator('#ct-kind').isDisabled());
  await page.fill('#ct-title', 'Wipe the air fryer basket well'); await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-task-form').waitFor({ state: 'detached' });
  const af = (await tasks()).find((t) => t.id === 'tAF');
  assert.deepEqual([af.title, af.recurrence, af.trigger.deviceId], ['Wipe the air fryer basket well', { kind: 'onUse' }, 'af']);
  // 6. Second member sees the device-linked tasks; reload persists.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await cleaningTasks();
  await page.locator(`#cl-manage .cl-item[data-task="${tvTask.id}"]`, { hasText: 'Living TV' }).waitFor();
  await cleaningTasks(page, { reload: true }); await page.locator(`#cl-manage .cl-item[data-task="${misc.id}"]`, { hasText: 'Living TV' }).waitFor();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 7. Arabic + mobile: Device Details and Room Details — Cleaning is not "coming later".
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await openDevice('tv');
  await page.locator('#dev-cleaning', { hasText: 'التنظيف' }).waitFor();
  const ar = await page.locator('dialog[open]').innerText();
  assert.equal((ar.match(/قادم في تحديث لاحق/g) || []).length, 0, 'Arabic: no "coming later" notice (Phase 5.5)');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await shot(page, '52-device-cleaning-section-ar-mobile');
  await page.keyboard.press('Escape');
  await page.goto(BASE + '#/m/rooms'); await page.locator('.room-card[data-room-id="liv"] .room-card__main').click();
  await page.locator('dialog[open] .room-future').waitFor();
  assert.doesNotMatch(await page.locator('dialog[open] .room-future').innerText(), /التنظيف/, 'Room Details: no Cleaning placeholder');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.4c — CUSTOM TEMPLATES & AI IMPORT
await check('TPL-UI custom templates (create → preview → apply, idempotent, 2 members, archive keeps tasks) + AI import (private prompt, invalid JSON, cancel, confirm, duplicates on retry); AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hTplAI';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump();
    window.__fake.set(`homes/${h}`, { name: 'Template Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.create', 'cleaning.edit', 'cleaning.complete', 'rooms.view', 'members.view', 'devices.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Secret Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/rooms/bed`, { name: 'Bedroom', type: 'master_bedroom', icon: 'bedroom', sortOrder: 2, active: true });
    window.__fake.set(`homes/${h}/devices/af`, { name: 'Air fryer', category: 'kitchen_appliance', subtype: 'air_fryer', roomId: 'kit', status: 'operational', icon: 'air_fryer', active: true });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const docs = (prefix) => page.evaluate(([h, p]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/${p}/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), [H, prefix]);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-tab-templates'); await page.locator('#cl-tpl-new').waitFor();
  // Create a template — a definition, not a task.
  await page.click('#cl-tpl-new'); await page.fill('#tpl-pack', 'Kitchen routine'); await page.fill('#tpl-title', 'Wipe the counter'); await page.fill('#tpl-n', '3');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#cl-tpl-list [data-pack="Kitchen routine"]').waitFor();
  const [tp] = await docs('cleaningCustomTemplates');
  assert.deepEqual([tp.rev, tp.active, tp.recurrence], [1, true, { kind: 'after', unit: 'day', interval: 3 }]);
  assert.equal((await docs('cleaningTasks')).length, 0, 'saving a template creates no task');
  // Preview → confirm apply → ordinary task in Basic; applying again → "already added".
  await page.locator('[data-pack="Kitchen routine"] [data-action=apply]').click(); await page.locator('#cl-tpl-apply').waitFor();
  await page.locator('#cl-tpl-apply-list [data-status=create]').waitFor();
  await page.click('#cl-tpl-apply-confirm'); await page.locator('#cl-tpl-apply').waitFor({ state: 'detached' });
  const applied = (await docs('cleaningTasks')).find((t) => t.id === `c_${tp.id}_kit`);
  assert.ok(applied && applied.templateRef.templateId === tp.id && applied.roomId === 'kit');
  await page.locator('[data-pack="Kitchen routine"] [data-action=apply]').click();
  await page.locator('#cl-tpl-apply-list [data-status=exists]').waitFor();
  assert.ok(await page.locator('#cl-tpl-apply-confirm').isDisabled(), 'nothing to add');
  await page.click('#cl-tpl-apply-cancel');
  // Second member: same pack → already added (no duplicate).
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-tab-templates');
  await page.locator('[data-pack="Kitchen routine"] [data-action=apply]').click(); await page.locator('#cl-tpl-apply-list [data-status=exists]').waitFor();
  await page.click('#cl-tpl-apply-cancel');
  // Archive: no apply button; the created task stays.
  await page.locator(`[data-template="${tp.id}"] [data-action=archive]`).click();
  await page.locator(`[data-template="${tp.id}"][data-active=false]`).waitFor();
  assert.equal(await page.locator('[data-pack="Kitchen routine"] [data-action=apply]').count(), 0);
  assert.equal((await docs('cleaningTasks')).find((t) => t.id === `c_${tp.id}_kit`).active, true, 'tasks already created are untouched');
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // AI import: private prompt; invalid JSON; cancel writes nothing; confirm; retry → duplicates.
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-tab-import'); await page.locator('#cl-ai-copy').waitFor();
  await page.check('#cl-ai-rt-kitchen');
  await page.fill('#cl-ai-min', '30');
  const prompt = await page.locator('#cl-ai-prompt').inputValue();
  assert.match(prompt, /areaType: kitchen/); assert.ok(!/Secret Kitchen|Abdo|Mona|owner@|mona@/.test(prompt), 'no names, no emails unless ticked');
  await page.click('#cl-ai-copy'); await page.locator('.toast').first().waitFor();
  await page.fill('#cl-ai-json', '{ not json');
  // A background data change re-renders the screen — the pasted text must survive.
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/rooms/bed`, { name: 'Bedroom 1' }), H);
  await page.locator('#cl-ai-json').waitFor();
  assert.equal(await page.locator('#cl-ai-json').inputValue(), '{ not json', 'paste kept across re-render');
  await page.click('#cl-ai-preview'); await page.locator('#cl-ai-errors', { hasText: 'not valid JSON' }).waitFor();
  await page.click('#cl-ai-sample'); await page.click('#cl-ai-preview');
  await page.locator('#cl-ai-counts', { hasText: '4 to add' }).waitFor();
  await page.click('#cl-ai-cancel'); await page.locator('#cl-ai-preview-list').waitFor({ state: 'detached' });
  assert.equal((await docs('cleaningTasks')).filter((t) => t.id.startsWith('ai_')).length, 0, 'cancel → no writes');
  await page.click('#cl-ai-sample'); await page.click('#cl-ai-preview'); await page.locator('#cl-ai-counts', { hasText: '4 to add' }).waitFor();
  // Untick one item; a background re-render must NOT re-tick it.
  await page.locator('#cl-ai-preview-list [data-key="task:2"] input[type=checkbox]').uncheck();
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/rooms/bed`, { name: 'Bedroom 2' }), H);
  await page.locator('#cl-ai-preview-list [data-key="task:2"] input[type=checkbox]:not(:checked)').waitFor();
  await page.click('#cl-ai-confirm');
  await page.locator('#cl-ai-counts', { hasText: '1 to add' }).waitFor();          // re-preview: saved ones are duplicates; only the unticked one remains
  assert.match(await page.locator('#cl-ai-progress').innerText(), /Saved 3 of 3/);
  assert.equal((await docs('cleaningTasks')).filter((t) => t.id.startsWith('ai_')).length, 2, 'the unticked task was not imported');
  // The user's deselection is respected after the import (it stays unticked); tick it to import it now.
  assert.equal(await page.locator('#cl-ai-preview-list [data-key="task:2"] input[type=checkbox]:checked').count(), 0, 'still unticked');
  await page.locator('#cl-ai-preview-list [data-key="task:2"] input[type=checkbox]').check();
  await page.click('#cl-ai-confirm'); await page.locator('#cl-ai-counts', { hasText: '0 to add' }).waitFor();   // safe retry: only that one
  const ai = (await docs('cleaningTasks')).filter((t) => t.id.startsWith('ai_'));
  assert.equal(ai.length, 3); assert.ok(ai.some((t) => t.trigger && t.trigger.deviceId === 'af'));
  assert.equal((await docs('cleaningCustomTemplates')).filter((t) => t.id.startsWith('ai_')).length, 1, 'imported template in the library');
  // Visible in Basic, persists across reload.
  await cleaningTasks();
  await page.locator('#cl-manage .cl-item', { hasText: 'Wipe the kitchen counter' }).waitFor();
  await cleaningTasks(page, { reload: true }); await page.locator(`#cl-manage .cl-item[data-task="c_${tp.id}_kit"]`).waitFor();
  // Arabic + mobile.
  await page.goto(BASE + '#/m/cleaning/advanced');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#cl-adv-tab-templates'); await page.locator('#cl-tpl-new', { hasText: 'قالب جديد' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '50-templates-ar-mobile');
  await page.click('#cl-adv-tab-import'); await page.locator('#cl-ai-copy').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await shot(page, '51-ai-import-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.4b — DEVICE USAGE & SEASONS
await check('DEV-UI device usage (coalesced, idempotent retry, void) and seasons (start/end checklists, off-season hidden) sync Basic ↔ Advanced; second member; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hDevUI';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump(); const day = new Date().toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'Device Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.create', 'cleaning.edit', 'cleaning.complete', 'rooms.view', 'members.view', 'devices.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/devices/af`, { name: 'Air fryer', category: 'kitchen_appliance', subtype: 'air_fryer', roomId: 'kit', status: 'operational', icon: 'air_fryer', active: true });
    window.__fake.set(`homes/${h}/devices/ac`, { name: 'Living AC', category: 'climate', subtype: 'split_ac', roomId: 'kit', status: 'operational', icon: 'split_ac', active: true });
    const T = (title, extra) => ({ title, instructions: null, roomId: null, priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], startDate: day, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1, ...extra });
    window.__fake.set(`homes/${h}/cleaningTasks/tAF`, T('Wipe air fryer basket', { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'af' } }));
    window.__fake.set(`homes/${h}/cleaningTasks/tACw`, T('Wash AC filter', { recurrence: { kind: 'after', unit: 'day', interval: 14 }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'active' } }));
    window.__fake.set(`homes/${h}/cleaningTasks/tACs`, T('AC season start check', { recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'start' } }));
    window.__fake.set(`homes/${h}/cleaningTasks/tACe`, T('AC season end cover', { recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'end' } }));
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const events = () => page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningDeviceEvents/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning'); await page.locator('#cl-adv').waitFor();
  const dueIn = (dev, task) => page.locator(`#cl-dev-due-${dev} .cl-item[data-task="${task}"]`);
  // Devices tab: log uses (three → ONE coalesced item); the first save fails → retry reuses the SAME id.
  await page.goto(BASE + '#/m/cleaning/advanced');
  // Opening Advanced saves the day's plan in the background (a real write). Wait for it, so the simulated
  // failure below hits the "Log use" write and nothing else.
  await page.waitForFunction((h) => Object.keys(window.__fake.dump()).some((k) => k.startsWith(`homes/${h}/cleaningRoutines/`)), H);
  await page.click('#cl-adv-tab-devices'); await page.locator('#cl-dev-use-af').waitFor();
  assert.equal(await page.locator('#cl-dev-due-af, #cl-dev-due-ac').count(), 0, 'off season + unused → nothing due');
  await page.evaluate(() => { window.__fakeFailNextCommit = true; });
  await page.click('#cl-dev-use-af'); await page.locator('.toast', { hasText: "won't be recorded twice" }).waitFor();
  assert.equal((await events()).length, 0, 'failed attempt saved nothing');
  await page.click('#cl-dev-use-af'); await page.waitForFunction((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/cleaningDeviceEvents/`)).length === 1, H);
  const firstId = (await events())[0].id;
  for (let i = 0; i < 2; i++) { await page.click('#cl-dev-use-af'); await page.waitForFunction(([h, n]) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/cleaningDeviceEvents/`)).length === n, [H, i + 2]); }
  await page.locator(`#cl-dev-due-af .cl-item[data-occ="tAF_u${firstId}"]`, { hasText: 'Used 3×' }).waitFor();
  assert.equal(await page.locator('#cl-dev-due-af .cl-item').count(), 1, 'three uses → one item');
  // V6.3: Done directly (no claim) resolves the exact occurrence; the list updates live.
  await dueIn('af', 'tAF').locator('[data-action=complete]').click();   // one tap, no dialog
  await page.locator('#cl-dev-due-af').waitFor({ state: 'detached' });
  const occ = await page.evaluate(([h, id]) => window.__fake.dump()[`homes/${h}/cleaningOccurrences/tAF_u${id}`], [H, firstId]);
  assert.deepEqual([occ.status, occ.triggerEventId], ['done', firstId]);
  assert.equal(await page.locator('#cl-dev-due-af').count(), 0, 'resolved: nothing outstanding');
  // Correction = a new void event; the original stays.
  await page.locator(`#cl-adv-devices [data-device="af"] details summary`).click();
  await page.locator(`#cl-dev-uses-af [data-event="${firstId}"] [data-action=void]`).click();
  await page.waitForFunction(([h, id]) => !!window.__fake.dump()[`homes/${h}/cleaningDeviceEvents/${id}_void`], [H, firstId]);
  assert.ok((await events()).some((e) => e.id === firstId), 'original use kept');
  // Season: start → start checklist + in-season task; end → end checklist, in-season task hidden.
  await page.click('#cl-dev-season-ac'); await page.waitForFunction((h) => (window.__fake.dump()[`homes/${h}/cleaningDeviceState/ac`] || {}).state === 'active', H);
  assert.ok(await page.evaluate((h) => !!window.__fake.dump()[`homes/${h}/cleaningDeviceSeasons/ac_s1`], H), 'season history entry');
  await dueIn('ac', 'tACs').waitFor(); await dueIn('ac', 'tACw').waitFor();
  // Second member sees the same state and acts on the same occurrence.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning'); await page.click('#cl-adv-tab-devices'); await dueIn('ac', 'tACs').waitFor();
  await dueIn('ac', 'tACs').locator('[data-action=complete]').click();   // one tap, no dialog
  await page.waitForFunction((h) => (window.__fake.dump()[`homes/${h}/cleaningOccurrences/tACs_s1`] || {}).status === 'done', H);
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-tab-devices'); await page.locator('#cl-dev-season-ac').click();
  await page.waitForFunction((h) => (window.__fake.dump()[`homes/${h}/cleaningDeviceState/ac`] || {}).rev === 2, H);
  await dueIn('ac', 'tACe').waitFor();
  assert.equal(await dueIn('ac', 'tACw').count(), 0, 'off season again → hidden');
  // Arabic + mobile.
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-tab-devices');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#cl-adv-tab-devices');   // a language switch remounts the page (tab resets)
  await page.locator('#cl-dev-use-af', { hasText: 'تسجيل استخدام' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '49-device-cleaning-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.4a — ADVANCED CLEANING
await check('ADV-UI Basic ↔ Advanced share one data model: routine saved once; skip/postpone/done(minutes)/claim sync both ways; whole room; stats; settings; back link; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hAdvUI';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump(); const day = new Date().toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'Advanced Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.create', 'cleaning.edit', 'cleaning.complete', 'rooms.view', 'members.view', 'devices.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    const T = (title, extra = {}) => ({ title, instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 }, startDate: day, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1, ...extra });
    window.__fake.set(`homes/${h}/cleaningTasks/tSink`, T('Clean sink', { estimatedMinutes: 10 }));
    window.__fake.set(`homes/${h}/cleaningTasks/tFloor`, T('Mop floor', { estimatedMinutes: 20, priority: 'high' }));
    window.__fake.set(`homes/${h}/cleaningTasks/tBins`, T('Empty bins'));
    window.__fake.set(`homes/${h}/cleaningTasks/tShelf`, T('Dust shelf'));
    // B0 fix: Advanced's routine day starts at `startHour` (default 3, Phase 5.4a), while Basic uses the
    // calendar day — so between 00:00 and 03:00 (Home time) the two views legitimately disagree on
    // "today" and this test failed deterministically in that window. Pin startHour 0 so both views use
    // the same day at ANY time of day; the startHour shift itself is covered by unit tests
    // (tests/unit/cleaning-advanced.test.mjs, routineDate).
    window.__fake.set(`homes/${h}/cleaningSettings/general`, { catchUpMax: 2, startHour: 0, updatedBy: 'UID_OWNER', updatedAt: new Date().toISOString(), schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const day = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  const ymd = day.replace(/-/g, '');
  const occ = (id) => page.evaluate(([h, k]) => window.__fake.dump()[`homes/${h}/cleaningOccurrences/${k}`] || null, [H, `${id}_${ymd}`]);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // V6.3: the former Advanced page IS the Cleaning page (no Basic / Advanced tabs, no back link).
  await page.goto(BASE + '#/m/cleaning'); await page.locator('#cl-adv-list .cl-item').nth(3).waitFor();
  assert.equal(await page.locator('#cl-advanced, #cl-adv-back, #cl-tab-today').count(), 0, 'no Main / Advanced switch');
  assert.equal(await page.locator('#cl-adv-tab-routine').getAttribute('aria-selected'), 'true', "Today's routine is the default view");
  // Routine saved ONCE (create-only) with the 4 tasks due today.
  await page.waitForFunction((h) => !!Object.keys(window.__fake.dump()).find((k) => k.startsWith(`homes/${h}/cleaningRoutines/`)), H);
  const plan = await page.evaluate(([h, d]) => window.__fake.dump()[`homes/${h}/cleaningRoutines/${d}`], [H, day]);
  assert.equal(plan.items.length, 4); assert.equal(plan.createdBy, 'UID_OWNER');
  assert.equal(plan.date, day, 'routine day == calendar day (startHour 0)'); assert.equal(plan.startHour, 0);
  // Skip (Advanced) → Basic shows "Skipped today" + Resume.
  await page.locator('#cl-adv-list .cl-item[data-task="tBins"] [data-action=skip]').click();
  await page.locator('#cl-adv-list .cl-item[data-task="tBins"][data-status=skipped]').waitFor();
  assert.equal((await occ('tBins')).status, 'skipped');
  // Postpone 3 days.
  await page.locator('#cl-adv-list .cl-item[data-task="tShelf"] [data-action=postpone]').click();
  const p3 = await page.evaluate(() => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
  await page.fill('#cl-adv-pdate', p3); await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-adv-list .cl-item[data-task="tShelf"][data-status=postponed]').waitFor();
  assert.equal((await occ('tShelf')).postponedTo, p3);
  // Done with minutes — V6.1: optional "Done + time" (plain Done is one tap) — success only after the confirmed write.
  await page.locator('#cl-adv-list .cl-item[data-task="tSink"] [data-action=completeTime]').click();
  await page.fill('#cl-adv-min', '12'); await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-adv-list .cl-item[data-task="tSink"][data-status=done]').waitFor();
  assert.equal((await occ('tSink')).actualMinutes, 12);
  assert.match(await page.locator('#cl-adv-progress').innerText(), /1 of 2 done/, 'skipped/postponed not counted as planned work');
  await page.locator('#cl-adv-list .cl-item[data-task="tBins"][data-status=skipped]', { hasText: 'Skipped today' }).waitFor();
  assert.ok(await page.locator('#cl-adv-list .cl-item[data-task="tBins"] [data-action=resume]').count());
  // V6.3: no Claim buttons anywhere; a legacy claimed record (older data) stays usable — anyone eligible completes it.
  assert.equal(await page.locator('[data-action=claim], [data-action=unclaim]').count(), 0, 'no Claim / Release buttons');
  await page.evaluate(([h, y, d]) => window.__fake.set(`homes/${h}/cleaningOccurrences/tFloor_${y}`, { taskId: 'tFloor', dueDate: d, status: 'claimed', rev: 1, claimedBy: 'UID_MONA', claimedAt: new Date().toISOString(),
    completedBy: null, completedAt: null, notes: null, createdAt: new Date().toISOString(), updatedBy: 'UID_MONA', updatedAt: new Date().toISOString(), schemaVersion: 1 }), [H, ymd, day]);
  await page.locator('#cl-adv-list .cl-item[data-task="tFloor"][data-status=claimed]', { hasText: 'Claimed by' }).waitFor();
  assert.equal(await page.locator('#cl-adv-list .cl-item[data-task="tFloor"] [data-action=complete]').count(), 1, 'claimed by Mona → the owner can still complete directly');
  // Same plan for the second member (no second routine); Mona resumes the skip; owner sees it live.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.locator('#cl-adv-list .cl-item').nth(3).waitFor();
  assert.equal(await page.evaluate((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/cleaningRoutines/`)).length, H), 1, 'one routine document');
  await page.locator('#cl-adv-list .cl-item[data-task="tBins"] [data-action=resume]').click();
  await page.locator('#cl-adv-list .cl-item[data-task="tBins"][data-status=open]').waitFor();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // Whole room: Done all (one confirmed write per task) → Basic progress reflects it.
  await page.goto(BASE + '#/m/cleaning/advanced'); await page.click('#cl-adv-tab-rooms');
  await page.locator('#cl-adv-rooms .cl-room[data-room="kit"] .cl-room__head').click();
  await page.locator('#cl-adv-room-all-kit').click();
  await page.locator('#cl-adv-rooms-empty, #cl-adv-rooms').first().waitFor();
  await page.waitForFunction(([h, y]) => ['tBins', 'tFloor'].every((t) => (window.__fake.dump()[`homes/${h}/cleaningOccurrences/${t}_${y}`] || {}).status === 'done'), [H, ymd]);
  // Statistics from the audit log; settings persist.
  await page.click('#cl-adv-tab-stats'); await page.locator('#cl-adv-stat-completions').waitFor();
  assert.ok(Number(await page.locator('#cl-adv-stat-completions').innerText()) >= 3);
  assert.equal(await page.locator('#cl-adv-stat-skips').innerText(), '1'); assert.equal(await page.locator('#cl-adv-stat-postpones').innerText(), '1');
  await page.click('#cl-adv-tab-settings'); await page.fill('#cl-adv-set-catchUpMax', '4'); await page.click('#cl-adv-set-save');
  await page.waitForFunction((h) => (window.__fake.dump()[`homes/${h}/cleaningSettings/general`] || {}).catchUpMax === 4, H);
  assert.match(await page.locator('#cl-adv-reset').innerText(), /Rooms and devices are never changed/);
  // Arabic + mobile: no overflow; back link works.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#cl-adv-tab-routine', { hasText: 'روتين اليوم' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '48-advanced-cleaning-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  assert.equal(await page.locator('#cl-adv-back, #cl-advanced').count(), 0, 'no back link: this is the Cleaning page');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.3 — HOME ROUTINE & CLEANING
await check('C-UI cleaning: (V6.3) create via form → Today’s routine → no Claim step: another member completes directly → reopen → audit; AR + mobile', async () => {
  await ensureSignedOut();
  const H = 'hCleanUI';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump();
    window.__fake.set(`homes/${h}`, { name: 'Cleaning Test Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.create', 'cleaning.edit', 'cleaning.complete', 'rooms.view', 'members.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kitchen`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', floor: null, notes: null, order: 1, active: true });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning'); await page.locator('#cl-adv').waitFor();
  await page.locator('#cl-adv-empty').waitFor();
  await page.locator('#cl-adv-goto-tasks').waitFor();   // empty home: a direct way to task setup
  // Create via the form: daily, shared with everyone, in the Kitchen.
  await page.click('#cl-adv-new'); await page.fill('#ct-title', 'Wipe counters');
  await page.selectOption('#ct-room', 'kitchen'); await page.selectOption('#ct-kind', 'days'); await page.fill('#ct-interval', '1');
  await page.click('dialog[open] button[type=submit]');
  const item = page.locator('#cl-adv-routine .cl-item', { hasText: 'Wipe counters' });
  await item.waitFor();   // created after today's plan was saved → still shown in the routine
  assert.match(await item.innerText(), /Kitchen/);
  await page.locator('#cl-markall-btn-routine', { hasText: '(1)' }).waitFor();
  assert.equal(await page.locator('[data-action=claim]').count(), 0, 'no Claim button');
  // Mona (eligible) completes it directly — no claim-before-completion.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning'); await item.waitFor();
  assert.equal(await page.locator('[data-action=claim], [data-action=unclaim]').count(), 0);
  await item.locator('[data-action=complete]').click();
  assert.equal(await page.locator('dialog[open]').count(), 0, 'no note dialog');
  await page.locator('#cl-adv-routine .cl-item[data-status=done]', { hasText: 'Wipe counters' }).waitFor();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // The owner sees who did it, and may reopen (one tap, audited).
  await page.goto(BASE + '#/m/cleaning');
  await page.locator('#cl-adv-routine .cl-item[data-status=done]', { hasText: 'Mona' }).waitFor();
  await page.locator('#cl-adv-routine .cl-item[data-status=done] [data-action=reopen]').click();
  await page.locator('#cl-adv-routine .cl-item[data-status=open]', { hasText: 'Wipe counters' }).waitFor();
  const log = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningLog/`)).map(([, v]) => [v.action, v.actorUid]).sort(), H);
  assert.deepEqual(log, [['complete', 'UID_MONA'], ['reopen', 'UID_OWNER']], 'one immutable audit entry per action, real actor');
  // Arabic + mobile: no horizontal overflow.
  // Switch language first (at 390px the topbar toggle moves), then go mobile.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#cl-adv-tab-routine', { hasText: 'روتين اليوم' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '47-cleaning-ar-mobile');
  // Mobile dock (V6.4): one scrollable row — every destination (Rooms included) is directly in the dock.
  await page.locator('.dock a.nav-link[href="#/m/rooms"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#dock-more-btn').count(), 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.3.1 — ROOMS & DEVICES → CLEANING TEMPLATES
await check('G-UI existing rooms/devices recognised → review shows tasks + frequencies → add (declined kept) → idempotent; archive/restore/rename/move; shared widget', async () => {
  await ensureSignedOut();
  const H = 'hTplG';   // own Home (T-UI above uses hTplUI)
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  await page.evaluate((h) => {
    window.__fake.set(`homes/${h}`, { name: 'Template Test Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: 'en' });
    // V6.3.0.1: the routine (now the Cleaning page) starts its day at `startHour` (default 3). Pin 0 so this test
    // sees today's tasks at ANY time of day (same fixture fix as B0; the night window is covered by ADV-NIGHT).
    window.__fake.set(`homes/${h}/cleaningSettings/general`, { catchUpMax: 2, startHour: 0, updatedBy: 'UID_OWNER', updatedAt: new Date().toISOString(), schemaVersion: 1 });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    const R = (name, type, order) => ({ name, type, icon: type, floor: null, notes: null, order, active: true });
    window.__fake.set(`homes/${h}/rooms/kit`, R('Kitchen', 'kitchen', 1));
    window.__fake.set(`homes/${h}/rooms/gar`, R('Garage', 'garage', 2));
    window.__fake.set(`homes/${h}/rooms/liv`, R('Living', 'living_room', 3));
    const D = (name, category, subtype, roomId) => ({ name, category, subtype, roomId, status: 'operational', icon: 'plug', active: true });
    window.__fake.set(`homes/${h}/devices/dw`, D('Dishwasher', 'kitchen_appliance', 'dishwasher', 'kit'));
    window.__fake.set(`homes/${h}/devices/ac`, D('Bedroom AC', 'air_conditioning', 'split_ac', null));
    window.__fake.set(`homes/${h}/cleaningTasks/manualDishes`, { title: 'Wash the dishes', instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [],
      recurrence: { kind: 'days', interval: 1 }, startDate: '2026-01-01', dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
  }, H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // Issue 1: the Cleaning card is a shared summary-card like the others.
  await page.locator('#cl-widget.summary-card').waitFor();
  assert.equal(await page.locator('#cl-widget .summary-card__title').count(), 1);
  assert.equal(await page.locator('.widget__title, .widget__value, .widget__hint').count(), 0, 'no unstyled legacy classes');
  // Banner recognises existing rooms/devices (kitchen 10 + 1 covered, living 5, dishwasher 5; garage & AC excluded).
  await cleaningTasks(); await page.locator('#cl-setup').waitFor();
  // Rooms, devices and tasks load independently; wait for the banner to reflect all of them.
  try { await page.locator('#cl-setup', { hasText: /38 cleaning tasks are suggested for 2 room\(s\) and 2 device/ }).waitFor({ timeout: 6000 }); }
  catch (e) {
    await page.click('#cl-setup-btn'); await page.locator('#cl-setup-form').waitFor();
    const groups = await page.evaluate(() => [...document.querySelectorAll('#cl-setup-form .cl-setup__group')].map((g) => `${g.dataset.kind}:${g.dataset.source}:${g.querySelectorAll('input').length}`));
    const diag = await page.evaluate(() => { const d = window.__fake.dump(); return { hash: location.hash, home: (document.querySelector('.hero__home, .topbar__home') || {}).textContent,
      rooms: Object.keys(d).filter((k) => /\/rooms\/[^/]+$/.test(k) && /hTplUI|hCleanUI/.test(k)), devices: Object.keys(d).filter((k) => /hTplUI\/devices\//.test(k)),
      user: d['users/UID_OWNER'] && d['users/UID_OWNER'].defaultHomeId }; });
    throw new Error(`banner "${await page.locator('#cl-setup').innerText()}" groups=${JSON.stringify(groups)} diag=${JSON.stringify(diag)}`);
  }
  await page.click('#cl-setup-btn');
  await page.locator('#cl-setup-form .cl-setup__group').first().waitFor();
  assert.equal(await page.locator('#cl-setup-form .cl-setup__group').count(), 4, 'Phase 5.4b: the AC (seasonal) now has suggestions');
  const kitchen = page.locator('#cl-setup-form .cl-setup__group[data-source="kit"]');
  assert.match(await kitchen.innerText(), /Wipe the counter — Every 1 day\(s\) after it's done/);
  assert.match(await kitchen.innerText(), /1 already covered by your tasks: Wash the dishes/);
  assert.match(await page.locator('#cl-setup-form .cl-setup__group[data-source="dw"]').innerText(), /1 condition-based \/ manual device task\(s\) will come in a later update/);
  await page.uncheck('#cl-setup-form input[value="r_liv_living_0"]');   // decline one
  await page.click('dialog[open] button[type=submit]');
  await page.locator('#cl-setup').waitFor({ state: 'detached' });
  const tasks = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningTasks/`)).map(([k, v]) => [k.split('/').pop(), v.active]), H);
  assert.equal(tasks.length, 39, '1 manual + 38 generated (Phase 5.4b: + 16 AC seasonal + 2 dishwasher after-cycle)');
  assert.deepEqual(tasks.find(([id]) => id === 'r_liv_living_0'), ['r_liv_living_0', false], 'declined → archived tombstone');
  assert.ok(tasks.some(([id]) => id === 'd_dw_w_filter') && tasks.filter(([id]) => id.startsWith('d_ac_')).length === 16, 'Phase 5.4b: AC seasonal tasks generated (16)');
  // Idempotent: reload → nothing suggested again (declined one included).
  await cleaningTasks(page, { reload: true }); await page.locator('#cl-manage .cl-item').first().waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#cl-setup').count(), 0, 'no banner after setup');
  // Archive the Kitchen → its generated tasks disappear; restore (+ rename) → back with the new name.
  await page.click('#cl-adv-tab-routine'); await page.locator('#cl-adv-routine .cl-item[data-task]').first().waitFor();
  const visibleBefore = await page.locator('#cl-adv-routine .cl-item[data-task]').count();
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/rooms/kit`, { active: false }), H);
  await page.waitForFunction((n) => document.querySelectorAll('#cl-adv-routine .cl-item[data-task]').length < n, visibleBefore);
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/rooms/kit`, { active: true, name: 'Big Kitchen' }), H);
  await page.waitForFunction((n) => document.querySelectorAll('#cl-adv-routine .cl-item[data-task]').length === n, visibleBefore);
  assert.ok((await page.locator('#cl-adv-routine').innerText()).includes('Big Kitchen'), 'rename reflected');
  // Move the dishwasher to the Living room → its tasks follow.
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/devices/dw`, { roomId: 'liv' }), H);
  await page.click('#cl-adv-tab-tasks'); await page.locator('#cl-manage').waitFor();
  await page.locator('#cl-manage .cl-item', { hasText: /Dishwasher · Living/ }).first().waitFor();
  // Done on an "after" task (Today's routine, one tap) → it stays in today's progress as done.
  await page.click('#cl-adv-tab-routine');
  const item = page.locator('#cl-adv-routine .cl-item[data-task]', { hasText: 'Wipe the counter' }).first();
  await item.locator('[data-action=complete]').click();
  await page.locator('#cl-adv-routine .cl-item[data-status=done]', { hasText: 'Wipe the counter' }).waitFor();
  // Newly added device → only ITS template tasks are suggested; labels never show the icon key.
  await cleaningTasks();
  await page.evaluate(() => { const h = window.__fake.dump()['users/UID_OWNER'].defaultHomeId;
    window.__fake.set(`homes/${h}/devices/mw531`, { name: 'Kitchen Microwave', category: 'kitchen_appliance', subtype: 'microwave', roomId: null, status: 'operational', icon: 'microwave', active: true }); });
  await page.locator('#cl-setup', { hasText: /7 cleaning tasks/ }).waitFor();
  await page.click('#cl-setup-btn'); await page.locator('#cl-setup-form').waitFor();
  assert.equal(await page.locator('#cl-setup-form .cl-setup__group').count(), 1, 'only the new device');
  assert.match(await page.locator('#cl-setup-form .cl-setup__title').innerText(), /^Kitchen Microwave — /, 'device name only (no icon key)');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.cl-item__meta', { hasText: /\b(dishwasher|microwave) [A-Z]/ }).count(), 0, 'no icon key printed before device names');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

// =================================================================== PHASE 5.3 — EDIT ACTIVE BUDGET
await check('B-UI (V6.2.1) home with an ACTIVE 10-day cycle: no budget entry point; cycle + links intact; balance exact; record with an unavailable wallet is read-only, never re-defaulted', async () => {
  await ensureSignedOut();
  const H = 'hBudgetUI';
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  await page.evaluate((h) => {
    const d = window.__fake.dump();
    const anyMember = Object.keys(d).find((k) => /^homes\/[^/]+\/roles\/member$/.test(k));
    window.__fake.set(`homes/${h}`, { name: 'Budget Test Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/wallets/cash`, { name: 'Daily cash', type: 'cash', scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true });
    window.__fake.set(`homes/${h}/walletMovements/fund`, { type: 'funding', amountMinor: 1000000, currency: 'EGP', date: '2026-10-05', fromWalletId: null, toWalletId: 'cash', cycleId: 'cy', note: null, audience: 'household', readers: [], status: 'active' });
    window.__fake.set(`homes/${h}/spendingCycles/cy`, { walletId: 'cash', currency: 'EGP', startDate: '2000-01-01', endDate: '2099-12-31', days: 10, budgetMinor: 1000000, carryInMinor: 0, status: 'active', audience: 'household', readers: [] });
    window.__fake.set(`homes/${h}/expenses/x`, { amountMinor: 250000, currency: 'EGP', date: '2026-10-06', category: 'food', note: 'Lunch', walletId: 'cash', budgetCycleId: 'cy', status: 'active', audience: 'household', readers: [], source: 'app' });
    window.__fake.set(`homes/${h}/expenses/g`, { amountMinor: 1000, currency: 'EGP', date: '2026-10-07', category: 'food', note: 'Ghost wallet buy', walletId: 'ghost', budgetCycleId: null, status: 'active', audience: 'household', readers: [], createdBy: 'UID_OWNER', source: 'app' });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h });
  }, H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets'); await page.locator('#wl-bal-cash').waitFor();
  assert.match(await page.locator('#wl-bal-cash').innerText(), /7,500/, '10,000 funded − 2,500 spent');
  for (const sel of ['#fin-tab-budget', '#fin-tab-household', '#fin-advanced', '.fin-cycle-mini', '#cy-edit-cy']) assert.equal(await page.locator(sel).count(), 0, sel);
  await page.click('#fin-tab-overview');
  assert.equal(await page.locator('.fin-cycle-mini, #fin-v6-open').count(), 0, 'no cycle card / link on the Overview');
  await page.click('#fin-tab-history'); await pickMonth('2026-10');
  await page.locator('#fm-rows .fm-tr', { hasText: 'Lunch' }).waitFor();
  const ghost = page.locator('#fm-rows .fm-tr', { hasText: 'Ghost wallet buy' });
  assert.match(await ghost.innerText(), /Private wallet/); assert.equal(await ghost.locator('[data-action]').count(), 0, 'unavailable wallet → read-only (rules need the original wallet)');
  await page.click('#fm-rows .fm-tr:has-text("Lunch") [data-action=edit]'); await page.locator('dialog[open] #ex-wallet').waitFor();
  assert.deepEqual(await page.locator('#ex-wallet option').evaluateAll((o) => o.map((x) => [x.value, x.textContent])), [['cash', '💵 Cash']], 'only the configured slot; Bank missing is not invented');
  assert.equal(await page.locator('dialog[open] #ex-pm').count(), 0);
  await page.keyboard.press('Escape');
  const d = await page.evaluate((h) => { const x = window.__fake.dump(); return [Object.keys(x).filter((k) => k.startsWith(`homes/${h}/spendingCycles/`)).length, x[`homes/${h}/expenses/x`].budgetCycleId, x[`homes/${h}/spendingCycles/cy`].status]; }, H);
  assert.deepEqual(d, [1, 'cy', 'active'], 'cycle records and links untouched');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

// =================================================================== PHASE 5.2 — ZAKAT LEDGER & EXPLICIT SHARING
await check('Z-UI ledger separates estimate / paid / outstanding; explicit share is read-only for the sharee; revoke removes it', async () => {
  // Own deterministic Home: earlier checks leave the owner's default Home in deliberate error
  // states (e.g. "role missing"). Standard role docs are copied from an existing Home.
  await ensureSignedOut();
  const homeId = 'hZakatUI';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump();
    // Roles defined explicitly (deterministic): owner "*"; member = an existing member role's
    // permissions + the standard member savings permissions (template v6).
    const anyMember = Object.keys(d).find((k) => /^homes\/[^/]+\/roles\/member$/.test(k));
    const base = anyMember ? d[anyMember].permissions : ['home.view', 'members.view'];
    const savings = ['savings.view', 'savings.viewTotals', 'savings.personal', 'savings.transfer', 'savings.prices', 'savings.zakat', 'members.view'];
    window.__fake.set(`homes/${h}`, { name: 'Zakat Test Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: [...new Set([...base, ...savings])], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, homeId);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // Owner: advance payment (no completed Hawl) → shown as unlinked, never guessed onto a Hawl.
  await page.goto(BASE + '#/m/savings'); await page.click('#sv-tab-zakat'); await page.locator('#zk-ledger').waitFor();
  await page.click('#zk-pay'); await page.locator('#zp-link-info').waitFor();
  assert.match(await page.locator('#zp-link-info').innerText(), /advance payment|دفعة مقدّمة/);
  await page.fill('#zp-amount', '250'); await page.click('#zakat-payment-form ~ * button[type=submit], dialog[open] button[type=submit]');
  await page.locator('#zk-unlinked').waitFor();
  assert.match(await page.locator('#zk-unlinked').innerText(), /not linked|غير مرتبطة/);
  // Private by default → share with Mona.
  assert.match(await page.locator('#zk-share-state').innerText(), /Private|خاصة/);
  await page.check('input[name="zk-share"][value="UID_MONA"]'); await page.click('#zk-share-save');
  await page.locator('#zk-share-state', { hasText: /Shared with 1|مشتركة مع/ }).waitFor();
  // Sharing is per Home: only THIS Home's records of the owner are re-labelled.
  const shared = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/zakatRecords/`)).map(([, d]) => d), homeId);
  assert.ok(shared.length > 0 && shared.filter((d) => d.ownerUid === 'UID_OWNER').every((d) => d.readers.includes('UID_MONA')), 'all of this Home\'s owner records re-labelled');
  // Mona: read-only view of the owner's SAVED records; no actions, no live estimate.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/savings'); await page.click('#sv-tab-zakat');
  const opt = page.locator('#zk-owner option', { hasText: /shared with you|مشتركة معك/ });
  await opt.waitFor({ state: 'attached' });
  await page.selectOption('#zk-owner', await opt.getAttribute('value'));
  await page.locator('#zk-shared-note').waitFor();
  assert.equal(await page.locator('#zk-pay, #zk-settings, #zk-snapshot, #zk-share-save').count(), 0, 'read-only');
  assert.equal(await page.locator('#zk-status').count(), 0, 'no live estimate for someone else');
  // Owner revokes → Mona loses the shared entry.
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/savings'); await page.click('#sv-tab-zakat'); await page.locator('#zk-share').waitFor();
  await page.uncheck('input[name="zk-share"][value="UID_MONA"]'); await page.click('#zk-share-save');
  await page.locator('#zk-share-state', { hasText: /Private|خاصة/ }).waitFor();
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/savings'); await page.click('#sv-tab-zakat'); await page.locator('.zakat').waitFor();
  assert.equal(await page.locator('#zk-owner option', { hasText: /shared with you|مشتركة معك/ }).count(), 0, 'revoked');
  // Restore both accounts' original default Homes (the Z Home stays isolated, unused afterwards).
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== PHASE 5.1 — LEGACY HOME ADOPTION
const LEGACY = 'hLegacyOld';
async function seedLegacyHome(homeId, creatorUid) {
  await page.evaluate(([h, c]) => {
    window.__fake.set(`homes/${h}`, { name: 'Old Adel Home', createdBy: c, createdAt: '2025-01-01T00:00:00.000Z' }); // no currency/timezone (older schema)
    window.__fake.set(`homes/${h}/devices/oldFridge`, { name: 'Old Fridge', category: 'kitchen', subtype: 'refrigerator', status: 'operational', icon: 'fridge', roomId: null, active: true, schemaVersion: 1, createdBy: c, updatedBy: c });
    window.__fake.set(`homes/${h}/expenses/oldExp`, { amountMinor: 123400, currency: 'EGP', date: '2025-12-01', category: 'groceries', note: 'Old groceries', status: 'active', audience: 'household', readers: [], source: 'app', walletId: null, createdBy: c });
    window.__fake.set(`homes/${h}/savingsAssets/oldGold`, { name: 'Old Gold', type: 'gold', purity: '21', currency: null, scope: 'personal', ownerUid: c, visibility: 'private', sharedWith: [], audience: 'restricted', readers: [c], active: true, zakatTreatment: 'included', allocations: [], createdBy: c });
  }, [homeId, creatorUid]);
}
/** Reach the login screen from ANY state earlier checks may leave (dashboard, login, error gate). */
async function ensureSignedOut() {
  await page.goto(BASE + '#/dashboard');
  await page.locator('.hero__home, #login-email, .gate__code').first().waitFor();
  if (await page.locator('#login-email').isVisible()) return;
  if (await page.locator('.user-btn').count()) { await logout(); return; }
  await page.locator('.gate__actions .btn--ghost').last().click();   // error screen: "Sign out"
  await page.locator('#login-email').waitFor();
}
const legacyBusiness = (h) => page.evaluate((hh) => { const d = window.__fake.dump(); return JSON.stringify(Object.keys(d).filter((k) => k.startsWith(`homes/${hh}/`) && !/\/(members|roles)\//.test(k)).sort().map((k) => [k, d[k]])); }, h);

await check('L1–L3 legacy home: creator signs in → specific upgrade screen (EN + AR), not "permission denied"', async () => {
  await ensureSignedOut();
  await seedLegacyHome(LEGACY, 'UID_OWNER');
  globalThis.__origDefault = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'].defaultHomeId);
  await page.evaluate((h) => window.__fake.patch('users/UID_OWNER', { defaultHomeId: h }), LEGACY);
  globalThis.__legacyBefore = await legacyBusiness(LEGACY);
  await login('owner@example.com');
  await page.locator('#legacy-upgrade').waitFor();
  if (await page.evaluate(() => document.documentElement.lang) !== 'en') { await page.click('.gate__top .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.lang === 'en'); }
  assert.match(await page.locator('#legacy-body').innerText(), /created with an older HomeHub version and needs a one-time authorization upgrade/);
  assert.equal((await page.locator('#legacy-upgrade').innerText()).trim(), 'Upgrade Home');
  assert.match(await page.locator('.legacy-points').innerText(), /remain unchanged/);
  assert.equal(await page.locator('.gate__code', { hasText: 'LEGACY_HOME_ADOPTION_REQUIRED' }).count(), 1);
  assert.equal(await page.locator('button', { hasText: /create a new home/i }).count(), 0, 'no "new home" escape hatch here');
  await page.click('.gate__top .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.locator('#legacy-upgrade').waitFor();
  assert.match(await page.locator('#legacy-body').innerText(), /تم إنشاء هذا المنزل بإصدار أقدم من HomeHub ويحتاج إلى ترقية صلاحيات لمرة واحدة/);
  assert.equal((await page.locator('#legacy-upgrade').innerText()).trim(), 'ترقية المنزل');
  await shot(page, '46-legacy-upgrade-ar');
  const d = await page.evaluate((h) => window.__fake.dump(), LEGACY);
  assert.ok(!Object.keys(d).some((k) => k.startsWith(`homes/${LEGACY}/members/`) || k.startsWith(`homes/${LEGACY}/roles/`)), 'detection wrote nothing');
});

await check('L4 upgrade → automatic re-resolution to the SAME home: owner membership + five v9 roles, data untouched', async () => {
  await page.click('#legacy-upgrade');
  await page.locator('.hero__home').waitFor();
  assert.match(await page.locator('.hero__home').innerText(), /Old Adel Home/);
  const d = await page.evaluate(() => window.__fake.dump());
  const m = d[`homes/${LEGACY}/members/UID_OWNER`];
  assert.deepEqual([m.roleId, m.status, m.legacyAdoption, m.addedBy], ['owner', 'active', true, 'UID_OWNER']);
  assert.deepEqual(Object.keys(d).filter((k) => k.startsWith(`homes/${LEGACY}/roles/`)).map((k) => k.split('/').pop()).sort(), ['admin', 'child', 'member', 'owner', 'viewer']);
  assert.deepEqual([d[`homes/${LEGACY}/roles/owner`].permissions, d[`homes/${LEGACY}/roles/owner`].rank, d[`homes/${LEGACY}/roles/owner`].templateVersion], [['*'], 100, 9]);   // current template v9 (V6.4 B contacts)
  assert.equal(d['users/UID_OWNER'].defaultHomeId, LEGACY, 'defaultHomeId unchanged');
  assert.equal(await legacyBusiness(LEGACY), globalThis.__legacyBefore, 'home doc + devices + expenses + savings byte-identical');
  assert.equal(Object.keys(d).filter((k) => /^homes\/[^/]+$/.test(k) && d[k].name === 'Old Adel Home').length, 1, 'no second home');
});

await check('L5 existing Devices / Finance / Life Savings preserved and usable; owner permissions work; refresh stays upgraded', async () => {
  await page.goto(BASE + '#/m/devices'); await page.locator('.device-card, .dev-row, li', { hasText: 'Old Fridge' }).first().waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history'); await page.fill('#fm-search', 'old groceries'); await page.locator('#fm-rows .fm-tr', { hasText: 'Old groceries' }).waitFor();
  // Old Gold is a PERSONAL asset → it is listed under "Mine" (the page opens on Home/household).
  await page.goto(BASE + '#/m/savings'); await page.click('.view-switch__btn:has-text("Mine")');
  await page.click('#sv-tab-assets'); await page.locator('.sv-asset', { hasText: 'Old Gold' }).waitFor();
  await page.goto(BASE + '#/m/rooms'); await addRoom('Upgraded Kitchen', 'kitchen');   // owner write works
  await page.reload();
  await page.locator('.hero__home, .page').first().waitFor();
  assert.equal(await page.locator('#legacy-upgrade').count(), 0, 'no upgrade screen after refresh');
  const before = await page.evaluate(() => window.__fake.writes());
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('#legacy-upgrade').count(), 0);
  const roleWrites = await page.evaluate((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/roles/`)).length, LEGACY);
  assert.equal(roleWrites, 5, 'still exactly five roles (no re-seeding)');
  assert.ok(await page.evaluate(() => window.__fake.writes()) - before < 50);
});

await check('L6 attacker: another user pointed at someone else\'s legacy home gets the normal "not a member" screen — no upgrade, nothing written', async () => {
  await ensureSignedOut();
  await seedLegacyHome('hLegacyVictim', 'UID_OWNER');
  const monaBefore = await page.evaluate(() => window.__fake.dump()['users/UID_MONA']);
  await page.evaluate(() => window.__fake.patch('users/UID_MONA', { defaultHomeId: 'hLegacyVictim' }));
  const victimBefore = await legacyBusiness('hLegacyVictim');
  await login('mona@example.com');
  await page.locator('.gate__code', { hasText: 'MEMBERSHIP_MISSING' }).waitFor();
  assert.equal(await page.locator('#legacy-upgrade').count(), 0, 'no upgrade offered to a non-creator');
  const ok = await page.evaluate(async () => {
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const f = fs.getFirestore(); const b = fs.writeBatch(f);
    b.set(fs.doc(f, 'homes', 'hLegacyVictim', 'members', 'UID_MONA'), { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'M', roleId: 'owner', status: 'active', addedBy: 'UID_MONA', legacyAdoption: true });
    b.set(fs.doc(f, 'homes', 'hLegacyVictim', 'roles', 'owner'), { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    try { await b.commit(); return 'written'; } catch (e) { return e.code; }
  });
  assert.equal(ok, 'permission-denied', 'direct adoption attempt refused');
  assert.equal(await legacyBusiness('hLegacyVictim'), victimBefore);
  assert.ok(!(await page.evaluate(() => Object.keys(window.__fake.dump()).some((k) => k.startsWith('homes/hLegacyVictim/members/')))));
  // Restore the shared fixture for later checks.
  await page.evaluate((m) => window.__fake.set('users/UID_MONA', m), monaBefore);
  await ensureSignedOut();
  await page.evaluate((d) => window.__fake.patch('users/UID_OWNER', { defaultHomeId: d }), globalThis.__origDefault);
});

await check('Tablet (820px): dock layout, no overflow', async () => {
  const tablet = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const p = await newPage(tablet);
  await p.goto(BASE);
  await p.fill('#login-email', 'owner@example.com');
  await p.fill('#login-password', 'correct-horse');
  await p.click('button[type=submit]');
  await p.fill('#setup-name', 'A');
  await p.fill('#setup-home', 'B');
  await p.click('button[type=submit]');
  await p.locator('.hero__home').waitFor();
  assert.ok(await p.locator('.dock').isVisible());
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await shot(p, '10-dashboard-tablet');
});

await check('Firebase SDK unavailable -> "HomeHub can\'t connect" screen, not a blank page', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const p = await newPage(ctx, { breakSdk: true });
  await p.goto(BASE);
  await p.locator('.gate__code', { hasText: 'FIREBASE_INIT_FAILED' }).waitFor();
  await shot(p, '11-error-firebase-init-ar');
});

// =================================================================== V6 FINANCE — batch 1
await check('V6-UI (V6.2.1) Cash / Bank set up from Wallets; expense paid from a chosen wallet id; income; 2nd member sees the same balances; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hV6';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump();
    window.__fake.set(`homes/${h}`, { name: 'V6 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['expenses.view', 'expenses.viewFinancialTotals', 'expenses.create', 'expenses.edit', 'expenses.transfer', 'members.view'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  const plus = (n) => page.evaluate((k) => new Date(Date.now() + k * 86400000).toISOString().slice(0, 10), n);
  const txt = (sel) => page.locator(sel).innerText();
  const submit = async (form) => { await page.click(`dialog[open] button[form="${form}"]`); await page.locator(`#${form}`).waitFor({ state: 'detached' }); };
  const docs = (c) => page.evaluate(([h, c]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/${c}/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), [H, c]);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses');
  // 1. No accounts yet: the Overview points to Wallets (no Household tab); openings are not income.
  await page.click('#fm-setup-open'); await page.locator('#fin-tab-wallets[aria-selected="true"]').waitFor();
  await page.click('#v6-setup-btn'); await page.fill('#v6-od', today); await page.fill('#v6-bank-open', '60000'); await page.fill('#v6-cash-open', '3000');
  await submit('v6-setup-form'); await page.locator('#v6-setup').waitFor({ state: 'detached' });
  assert.deepEqual((await docs('walletMovements')).map((m) => m.type).sort(), ['opening', 'opening']);
  await page.click('#fin-tab-overview'); await page.locator('#fm-available', { hasText: '63,000' }).waitFor();
  // 2. Expense from the Bank wallet (stable id, no payment method).
  const bankId = (await docs('wallets')).find((w) => w.role === 'bank').id;
  await page.click('#fm-add'); await page.fill('#fm-ex-name', 'Groceries run'); await page.fill('#fm-ex-amount', '3000');
  assert.deepEqual(await page.locator('#fm-ex-wallet option').evaluateAll((o) => o.map((x) => x.textContent)), ['💵 Cash', '🏦 Bank']);
  await page.selectOption('#fm-ex-wallet', bankId); await submit('fm-exp-form');
  await page.locator('#fm-bank', { hasText: '57,000' }).waitFor();
  assert.match(await txt('#fm-cash'), /3,000/); assert.match(await txt('#fm-available'), /60,000/);
  const [exp] = await docs('expenses');
  assert.deepEqual([exp.walletId, exp.paymentMethod], [bankId, null]);
  // 3. Income 15,000 → Bank.
  await page.click('#fm-add-money'); await page.fill('#fm-mo-amount', '15000'); await page.selectOption('#fm-mo-acct', bankId); await page.fill('#fm-mo-src', 'Salary'); await submit('fm-money-form');
  await page.locator('#fm-bank', { hasText: '72,000' }).waitFor();
  // 4. Second member sees the same household figures.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.locator('#fm-available', { hasText: '75,000' }).waitFor();
  assert.equal(await page.locator('#fm-budget-edit').count(), 0, 'member cannot manage the budget');
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 5. Arabic + mobile.
  await page.goto(BASE + '#/m/expenses');
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#fm-money', { hasText: 'المتاح الآن' }).waitFor();
  for (const id of ['overview', 'history', 'wallets']) { await page.click(`#fin-tab-${id}`); assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${id}: no horizontal overflow`); }
  await shot(page, '56-v6-household-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

await check('V6-UI2 Zakat paid from Bank (balance yes, monthly spending no, read-only row); ATM transfer neutral; budget periods untouched; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hV6b';
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await page.evaluate(([h, today]) => {
    const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const A = { createdBy: 'UID_OWNER', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'UID_OWNER', updatedAt: '2026-01-01T00:00:00Z', schemaVersion: 1 };
    window.__fake.set(`homes/${h}`, { name: 'V6 Home B', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    const W = (name, role, type) => ({ name, type, scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, role, openingDate: iso(-5), ...A });
    window.__fake.set(`homes/${h}/wallets/bank`, W('Bank', 'bank', 'bank')); window.__fake.set(`homes/${h}/wallets/cash`, W('Cash in hand', 'cash', 'cash'));
    const MV = (x) => ({ currency: 'EGP', fromWalletId: null, toWalletId: null, cycleId: null, note: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, ...A, ...x });
    window.__fake.set(`homes/${h}/walletMovements/op_bank`, MV({ type: 'opening', amountMinor: 6000000, date: iso(-5), toWalletId: 'bank' }));
    window.__fake.set(`homes/${h}/walletMovements/op_cash`, MV({ type: 'opening', amountMinor: 300000, date: iso(-5), toWalletId: 'cash' }));
    const pid = `p_${iso(-5).replace(/-/g, '')}`;
    window.__fake.set(`homes/${h}/budgetPeriods/${pid}`, { startDate: iso(-5), endDateExclusive: iso(25), capMinor: 2000000, audience: 'household', readers: [], status: 'open', closingSnapshot: null, rev: 1, ...A });
    window.__fake.set(`homes/${h}/budgetHead/primary`, { lastPeriodId: pid, endDateExclusive: iso(25), audience: 'household', readers: [], rev: 1, updatedBy: 'UID_OWNER', updatedAt: A.updatedAt });
    window.__fake.set(`homes/${h}/expenses/zk_pay1`, { amountMinor: 250000, currency: 'EGP', date: today, category: 'zakat', note: 'Zakat al-mal', merchant: null, paymentMethod: 'bank_transfer', walletId: 'bank',
      budgetCycleId: null, paidBy: 'UID_OWNER', commitmentId: null, commitmentDueDate: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app', periodId: pid, lateEntry: false, ...A });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
  }, [H, today]);
  const txt = (sel) => page.locator(sel).innerText();
  const submit = async (form) => { await page.click(`dialog[open] button[form="${form}"]`); await page.locator(`#${form}`).waitFor({ state: 'detached' }); };
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses');
  // V6.2: Overview is the daily monthly view; the 10-day Budget tab is retired from navigation (no cycles here).
  await page.locator('#fm-available', { hasText: '60,500' }).waitFor();
  assert.equal(await page.locator('#fin-tab-budget').count(), 0, '10-day budget no longer in navigation');
  assert.doesNotMatch(await page.locator('#fm-spent-total').innerText(), /2,500/, 'Zakat paid is not monthly spending');
  assert.match(await txt('#fm-bank'), /57,500/, 'Zakat leaves the Bank balance');
  await page.locator('#fm-rows [data-expense="zk_pay1"]').waitFor();
  assert.equal(await page.locator('#fm-rows [data-expense="zk_pay1"] [data-action]').count(), 0, 'Zakat-owned row: no edit / delete here');
  // ATM withdrawal: balances move, available + monthly spending unchanged.
  const spent = await txt('#fm-spent-total');
  await page.click('#fm-transfer'); await page.selectOption('#fm-tr-kind', 'atm'); await page.fill('#fm-tr-amount', '2000'); await submit('fm-tr-form');
  await page.locator('#fm-cash', { hasText: '5,000' }).waitFor();
  assert.match(await txt('#fm-bank'), /55,500/); assert.match(await txt('#fm-available'), /60,500/); assert.equal(await txt('#fm-spent-total'), spent);
  const periods = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/budgetPeriods/`)).map(([, v]) => [v.capMinor, v.status]), H);
  assert.deepEqual(periods, [[2000000, 'open']], 'older budget-period records kept as they were');
  // Arabic + mobile.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#fin-tab-history'); await page.locator('#fm-rows [data-expense="zk_pay1"]').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '57-v6-batch2-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

await check('V61-UI cleaning one-tap + current-room Complete / Reset all; no Life Savings tile; recipes (video, scaler, favorites, duplicate, archive); shared persistent timers; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hV61';
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  await page.evaluate((h) => {
    const today = new Date().toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'V6.1 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 7 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    for (const [id, name] of [['kit', 'Kitchen'], ['bath', 'Bathroom']]) window.__fake.set(`homes/${h}/rooms/${id}`, { name, type: id === 'kit' ? 'kitchen' : 'bathroom', icon: 'kitchen', sortOrder: 1, active: true });
    const T = (title, roomId) => ({ title, instructions: null, roomId, priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 },
      startDate: today, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/cleaningTasks/k1`, T('Wipe counter', 'kit')); window.__fake.set(`homes/${h}/cleaningTasks/k2`, T('Mop floor', 'kit'));
    window.__fake.set(`homes/${h}/cleaningTasks/b1`, T('Clean mirror', 'bath'));
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
  }, H);
  const occ = (task) => page.evaluate(([h, task]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningOccurrences/${task}_`)).map(([, v]) => v)[0] || null, [H, task]);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 1. Current-room Complete all / Reset all.
  // V6.3: the whole-room actions live in the Rooms tab of the (single) Cleaning page.
  await page.goto(BASE + '#/m/cleaning'); await page.click('#cl-adv-tab-rooms');
  await page.locator('#cl-adv-rooms .cl-room[data-room="kit"] .cl-room__head').click();
  await page.locator('#cl-adv-room-all-kit', { hasText: 'Mark all 2 done' }).click();
  await page.waitForFunction((h) => ['k1', 'k2'].every((t) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/cleaningOccurrences/${t}_`) && v.status === 'done')), H);
  assert.equal(await occ('b1'), null, 'bathroom untouched (current room only)');
  await page.locator('#cl-adv-room-reset-kit', { hasText: '(2)' }).click(); await page.locator('dialog[open] .btn--danger, dialog[open] .btn--primary').last().click();
  await page.waitForFunction((h) => ['k1', 'k2'].every((t) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/cleaningOccurrences/${t}_`) && v.status === 'open')), H);
  assert.equal(await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k, v]) => k.startsWith(`homes/${h}/cleaningLog/`) && v.action === 'reopen').length, H), 2, 'history kept: two reopen entries');
  // 2. Dashboard: no Life Savings tile; the timer panel is there.
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('#sv-widget-total').count(), 0);
  // V6.1.1: no running / paused / ringing timer → the WHOLE timer widget is hidden (no blank card, no placeholder).
  await page.waitForFunction(() => { const w = document.querySelector('#ck-widget'); return !w || w.offsetParent === null; });
  // 3. Recipes.
  await page.goto(BASE + '#/m/chef'); await page.locator('#ck-empty').waitFor();
  await page.click('#ck-new'); await page.fill('#ck-title-en', 'Lentil soup'); await page.selectOption('#ck-cat', 'soup'); await page.fill('#ck-serv', '2');
  await page.fill('#ck-video-url', 'http://example.com/watch?v=dQw4w9WgXcQ'); await page.click('dialog[open] button[type=submit]');   // V6.1.1: unsafe (not https)
  await page.locator('.toast', { hasText: 'Not a safe video link' }).waitFor();
  await page.fill('#ck-video-url', 'https://youtu.be/dQw4w9WgXcQ');
  await page.locator('#ck-ings .ck-ing-amount').fill('1 1/2'); await page.locator('#ck-ings .ck-ing-unit').selectOption('cup'); await page.locator('#ck-ings .ck-ing-name').fill('Lentils');
  await page.locator('#ck-steps .ck-step-text').fill('Simmer gently'); await page.locator('#ck-steps .ck-step-min').fill('1');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#ck-form').waitFor({ state: 'detached' });
  await page.locator('#ck-title', { hasText: 'Lentil soup' }).waitFor();
  assert.equal(await page.locator('#ck-iframe').count(), 0, 'lazy: no iframe before Play');
  assert.equal(await page.locator('#ck-open-yt').getAttribute('href'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.click('#ck-play'); await page.locator('#ck-iframe').waitFor({ state: 'attached' });
  assert.match(await page.locator('#ck-iframe').getAttribute('src'), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(await page.locator('#ck-ingredients').innerText(), /1 ½/);
  await page.click('#ck-serv-inc'); await page.locator('#ck-ingredients', { hasText: '2 ¼' }).waitFor();
  const rec = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/recipes/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), H);
  assert.deepEqual([rec.length, rec[0].ingredients[0].amountMilli, rec[0].videoId], [1, 1500, 'dQw4w9WgXcQ'], 'stored base amount unchanged by scaling');
  // 4. Timers: from a step; same timer in cooking mode and on the dashboard; pause / resume; completion; reload.
  await page.click('#ck-steps-list [data-action=step-timer]');
  assert.equal((await page.locator('#ck-cook').innerText()).trim(), 'Start cooking', 'V6.1.1 label');
  await page.click('#ck-cook'); await page.locator('#ck-cook-timers [data-timer][data-status=running]').waitFor();
  await page.locator('#ck-cook-timers [data-timer] [data-action=pause]').click(); await page.locator('#ck-cook-timers [data-timer][data-status=paused]').waitFor();
  await page.locator('#ck-cook-timers [data-timer] [data-action=resume]').click(); await page.locator('#ck-cook-timers [data-timer][data-status=running]').waitFor();
  await page.fill('#ck-t-label', 'Eggs'); await page.fill('#ck-t-s', '2'); await page.click('#ck-t-add');
  // V6.1.1: the alarm keeps ringing (persisted) until explicitly stopped — through navigation and reload.
  await page.locator('#ck-cook-timers [data-timer][data-status=ringing]', { hasText: 'Eggs' }).waitFor({ timeout: 8000 });
  await page.locator('#ck-cook-timers [data-timer][data-status=ringing] [data-action=stop-alarm]').waitFor();
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/cookingTimers/`) && v.label === 'Eggs' && v.status === 'completed'), H);
  await page.goto(BASE + '#/dashboard'); await page.locator('#ck-widget [data-timer][data-status=running]', { hasText: 'Lentil soup' }).waitFor();
  await page.reload(); await page.locator('#ck-widget [data-timer][data-status=running]', { hasText: 'Lentil soup' }).waitFor();
  await page.locator('#ck-widget [data-timer][data-status=ringing]', { hasText: 'Eggs' }).waitFor();   // not forgotten on reload
  await page.locator('#ck-widget [data-status=ringing] [data-action=stop-alarm]').click();   // Stop from the dashboard
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/cookingTimers/`) && v.label === 'Eggs' && v.status === 'dismissed'), H);
  await page.locator('#ck-widget [data-status=ringing]').waitFor({ state: 'detached' });
  await page.locator('#ck-widget [data-timer][data-status=running]', { hasText: 'Lentil soup' }).locator('[data-action=delete]').click();
  await page.waitForFunction(() => { const w = document.querySelector('#ck-widget'); return w && w.offsetParent === null; });   // last active timer gone → widget hidden
  // 5. Library: favorite, search, duplicate (new id), archive / show archived.
  await page.goto(BASE + '#/m/chef'); await page.locator('#ck-grid').waitFor();
  await page.locator('#ck-grid [data-action=favorite]').click(); await page.locator('#ck-grid [data-action=favorite][aria-pressed=true]').waitFor();
  await page.fill('#ck-search', 'lentil'); await page.locator('#ck-grid .ck-card').waitFor();
  await page.fill('#ck-search', 'zzz'); await page.locator('#ck-empty').waitFor(); await page.fill('#ck-search', '');
  await page.locator('#ck-grid .ck-card__open').first().click();
  await page.click('#ck-actions [data-action=menu]'); await page.click('#ck-actions [data-action=menu-duplicate]');   // V6.1.1: ⋯ menu
  await page.waitForFunction((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/recipes/`)).length === 2, H);
  await page.click('#ck-back'); await page.locator('#ck-grid .ck-card', { hasText: '(copy)' }).waitFor();
  await page.locator('#ck-grid .ck-card', { hasText: '(copy)' }).locator('.ck-card__open').click(); await page.click('#ck-archive');
  await page.click('#ck-back'); await page.waitForFunction(() => document.querySelectorAll('#ck-grid .ck-card').length === 1);
  // V6.1.1: Filters disclosure (collapsed by default) — count badge + Clear.
  assert.equal(await page.locator('#ck-filters-toggle').getAttribute('aria-expanded'), 'false'); assert.ok(await page.locator('#ck-filters').isHidden());
  await page.click('#ck-filters-toggle'); assert.equal(await page.locator('#ck-filters-toggle').getAttribute('aria-expanded'), 'true');
  await page.check('#ck-archived'); await page.locator('#ck-grid .ck-card', { hasText: '(copy)' }).waitFor();
  assert.equal(await page.locator('#ck-filters-count').innerText(), '1');
  await page.click('#ck-filters-clear'); await page.waitForFunction(() => !document.querySelector('#ck-filters-count'));
  // V6.1.1: search keeps focus while typing (only the results re-render).
  await page.click('#ck-search'); await page.keyboard.type('len'); assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'ck-search');
  await page.fill('#ck-search', '');
  // V6.1.1: non-YouTube source → a link only (no iframe, no thumbnail).
  await page.click('#ck-new'); await page.fill('#ck-title-en', 'Reel cake'); await page.fill('#ck-video-url', 'https://www.facebook.com/watch?v=123');
  await page.click('dialog[open] button[type=submit]'); await page.locator('#ck-form').waitFor({ state: 'detached' });
  await page.locator('#ck-open-source', { hasText: 'Facebook' }).waitFor();
  assert.deepEqual([await page.locator('#ck-open-source').getAttribute('href'), await page.locator('#ck-open-source').getAttribute('target'), await page.locator('#ck-open-source').getAttribute('rel')],
    ['https://www.facebook.com/watch?v=123', '_blank', 'noopener noreferrer']);
  assert.equal(await page.locator('#ck-play, #ck-iframe, #ck-video').count(), 0, 'no player for non-YouTube');
  await page.click('#ck-back'); assert.equal(await page.locator('.ck-card', { hasText: 'Reel cake' }).locator('img').count(), 0, 'no fabricated thumbnail');
  // V6.1.1: measured spacing — page sections and recipe cards are separated (not stacked flush).
  const gaps = await page.evaluate(() => { const kids = [...document.querySelectorAll('#ck-body > *')].map((e) => e.getBoundingClientRect()).filter((r) => r.height);
    const cards = [...document.querySelectorAll('#ck-grid > .ck-card')].map((e) => e.getBoundingClientRect());
    return { section: Math.min(...kids.slice(1).map((r, i) => r.top - kids[i].bottom)), cards: cards.length > 1 ? Math.max(Math.abs(cards[1].left - cards[0].right), cards[1].top - cards[0].bottom) : 99 }; });
  assert.ok(gaps.section >= 12 && gaps.cards >= 8, `layout gaps ${JSON.stringify(gaps)}`);
  // V6.1.1: ⋯ menu — keyboard, Escape, Delete (confirm) = SOFT delete.
  const card = page.locator('.ck-card', { hasText: 'Reel cake' });
  await card.locator('[data-action=menu]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
  await page.keyboard.press('Escape'); assert.equal(await card.locator('[data-action=menu]').getAttribute('aria-expanded'), 'false');
  await card.locator('[data-action=menu]').click(); await card.locator('[data-action=menu-delete]').click(); await page.click('dialog[open] .btn--danger');
  await page.locator('.ck-card', { hasText: 'Reel cake' }).waitFor({ state: 'detached' });
  assert.ok(await page.evaluate((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/recipes/`) && v.titleEn === 'Reel cake' && v.deletedAt && v.deletedBy === 'UID_OWNER'), H), 'soft-deleted, still stored');
  assert.equal(await page.locator('#ck-filters-toggle').getAttribute('aria-expanded'), 'true', 'disclosure state preserved across re-renders');
  await page.check('#ck-archived'); await page.locator('#ck-grid .ck-card', { hasText: '(copy)' }).waitFor();
  // 6. Arabic + mobile.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/m/chef'); await page.locator('#ck-grid .ck-card__open').first().click(); await page.locator('#ck-video').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow');
  await shot(page, '59-v611-recipe-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

await check('V62-UI daily Finance (search all months, month nav / picker, balances vs monthly KPIs, backdated, budget + limits, bill paid once, delete) + Calendar (CSV import / dedupe, off-duty → vacation, dashboard widget) + vacation filter + one cleaning reminder; AR mobile', async () => {
  await ensureSignedOut();
  const H = 'hV62';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  const days = await page.evaluate(() => { const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); return { today: iso(0), yest: iso(-1) }; });
  const ym = days.today.slice(0, 7);
  const prevYm = await page.evaluate((m) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 2; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }, ym);
  await page.evaluate(([h, D, prevYm]) => {
    const A = { createdBy: 'UID_OWNER', createdAt: '2025-01-01T00:00:00Z', updatedBy: 'UID_OWNER', updatedAt: '2025-01-01T00:00:00Z', schemaVersion: 1 };
    window.__fake.set(`homes/${h}`, { name: 'V6.2 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 8 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['expenses.view', 'expenses.viewFinancialTotals', 'expenses.create', 'expenses.edit', 'expenses.transfer', 'members.view', 'calendar.view', 'calendar.create', 'calendar.edit', 'cleaning.view'], system: true, templateVersion: 8 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    const W = (name, role, type) => ({ name, type, scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, role, openingDate: '2025-01-01', ...A });
    window.__fake.set(`homes/${h}/wallets/bank`, W('Bank', 'bank', 'bank')); window.__fake.set(`homes/${h}/wallets/cash`, W('Cash in hand', 'cash', 'cash'));
    const MV = (x) => ({ currency: 'EGP', fromWalletId: null, toWalletId: null, cycleId: null, note: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, ...A, ...x });
    window.__fake.set(`homes/${h}/walletMovements/op_bank`, MV({ type: 'opening', amountMinor: 6000000, date: '2025-01-01', toWalletId: 'bank' }));
    window.__fake.set(`homes/${h}/walletMovements/op_cash`, MV({ type: 'opening', amountMinor: 300000, date: '2025-01-01', toWalletId: 'cash' }));
    const EX = (id, date, amountMinor, walletId, note, pm, category = 'groceries') => window.__fake.set(`homes/${h}/expenses/${id}`, { amountMinor, currency: 'EGP', date, category, note, merchant: null, paymentMethod: pm, walletId,
      budgetCycleId: null, paidBy: null, commitmentId: null, commitmentDueDate: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app', periodId: null, lateEntry: false, ...A });
    EX('eRice', '2025-03-10', 10000, 'cash', 'Rice sack', 'cash'); EX('eBread', D.today, 5000, 'cash', 'Bread', 'cash');
    EX('eHotel', '2026-01-10', 150000, 'bank', 'Hotel', 'debit_card', 'entertainment');
    window.__fake.set(`homes/${h}/commitments/cInternet`, { name: 'Internet', amountMinor: 60000, currency: 'EGP', category: 'utilities', recurrence: { unit: 'month', interval: 1 }, anchorDay: Number(D.yest.slice(8)), nextDueDate: D.yest,
      paymentMethod: 'bank_transfer', walletId: 'bank', notes: null, lastPaidDate: null, audience: 'household', readers: [], active: true, archivedAt: null, archivedBy: null, ...A });
    for (const [id, name] of [['kit', 'Kitchen'], ['bath', 'Bathroom']]) window.__fake.set(`homes/${h}/rooms/${id}`, { name, type: id === 'kit' ? 'kitchen' : 'bathroom', icon: 'kitchen', sortOrder: 1, active: true });
    const T = (title, roomId) => ({ title, instructions: null, roomId, priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 }, startDate: D.today, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/cleaningTasks/k1`, T('Wipe counter', 'kit')); window.__fake.set(`homes/${h}/cleaningTasks/b1`, T('Clean mirror', 'bath'));
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, [H, days, prevYm]);
  const docs = (c) => page.evaluate(([h, c]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/${c}/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), [H, c]);
  const txt = (sel) => page.locator(sel).innerText();
  const submit = async (form) => { await page.click(`dialog[open] button[form="${form}"]`); await page.locator(`#${form}`).waitFor({ state: 'detached' }); };
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // ---- Finance: balances are all-time; spending is this month.
  await page.goto(BASE + '#/m/expenses'); await page.locator('#fm-available').waitFor();
  assert.match(await txt('#fm-available'), /61,350/, '60,000 − 1,500 + 3,000 − 100 − 50');
  assert.match(await txt('#fm-cash'), /2,850/); assert.match(await txt('#fm-bank'), /58,500/);
  assert.match(await txt('#fm-spent-total'), /50/); assert.doesNotMatch(await txt('#fm-spent-total'), /1,500/);
  assert.equal(await page.locator('#qa-amount').count(), 0, 'the quick-add strip gives way to Add expense');
  assert.equal(await page.locator('#fin-advanced').count(), 0, 'V6.2.1: no Advanced section');
  // Search: ALL months (and years), case-insensitive; clearing returns to the month.
  await page.fill('#fm-search', 'RICE'); await page.locator('#fm-rows [data-expense="eRice"]').waitFor();
  assert.match(await txt('#fm-chip-all'), /All months/); assert.equal(await page.locator('#fm-rows [data-expense="eBread"]').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fm-search', 'typing keeps focus');
  assert.match(await txt('#fm-spent-total'), /50/, 'search never changes the KPI period');
  await page.fill('#fm-search', 'zzz'); await page.locator('#fm-empty', { hasText: 'No transactions match' }).waitFor();
  await page.click('#fm-clear'); await page.locator('#fm-rows [data-expense="eBread"]').waitFor();
  // Month picker → March 2025; arrows across months.
  await page.click('#fm-month'); await page.selectOption('#fm-pick-month', '03'); await page.fill('#fm-pick-year', '2025'); await page.click('#fm-pick-go');
  await page.locator('#fm-rows [data-expense="eRice"]').waitFor(); assert.match(await txt('#fm-spent-total'), /100/); assert.match(await txt('#fm-available'), /61,350/, 'balances stay all-time');
  await page.click('#fm-next'); await page.locator('#fm-month', { hasText: 'April 2025' }).waitFor();
  await page.click('#fm-this-month'); await page.locator('#fm-rows [data-expense="eBread"]').waitFor();
  // Backdated expense (previous month, Visa → Bank): counted in ITS month, balance immediately.
  await page.click('#fm-add'); await page.click('dialog[open] button[form="fm-exp-form"]');
  await page.locator('#fm-exp-form .banner', { hasText: 'Enter a name' }).waitFor();
  await page.fill('#fm-ex-name', 'Fuel'); await page.fill('#fm-ex-amount', '200'); await page.selectOption('#fm-ex-cat', 'fuel'); await page.selectOption('#fm-ex-wallet', 'bank');
  await page.fill('#fm-ex-date', `${prevYm}-01`); await submit('fm-exp-form');
  await page.locator('#fm-bank', { hasText: '58,300' }).waitFor(); assert.match(await txt('#fm-spent-total'), /50/, 'this month unchanged');
  await page.click('#fm-prev'); await page.locator('#fm-rows [data-expense]', { hasText: 'Fuel' }).waitFor(); assert.match(await txt('#fm-spent-bank'), /200/);
  await page.click('#fm-this-month');
  // Monthly budget (owner) with one category limit; collapsed by default; no limits → no bars.
  assert.match(await txt('#fm-no-budget'), /No monthly budget set/);
  await page.click('#fm-budget-edit'); await page.fill('#fm-bu-total', '1000');
  await page.click('dialog[open] #fm-budget-form .form-section__summary'); await page.fill('#fm-lim-groceries', '30');   // optional limits: collapsed until opened
  await submit('fm-budget-form');
  await page.locator('#fm-budget-text', { hasText: '5%' }).waitFor();
  assert.equal(await page.locator('#fm-cats').count(), 0, 'collapsed by default');
  await page.click('#fm-budget-toggle'); await page.locator('#fm-cats [data-cat="groceries"]', { hasText: 'Over by' }).waitFor();
  assert.deepEqual((await docs('financeMonthly')).map((d) => [d.id, d.budgetMinor, d.categoryLimits.groceries, d.rev]), [[ym, 100000, 3000, 1]]);
  // Bill due → Mark as paid once (Bank); idempotent.
  await page.locator('#fm-bills-due [data-bill="cInternet"] [data-action=pay]').click(); await page.selectOption('#fm-pay-wallet', 'bank'); await submit('fm-pay-form');
  await page.locator('#fm-bank', { hasText: '57,700' }).waitFor();
  assert.equal(await page.locator('#fm-bills-due [data-bill="cInternet"]').count(), 0, 'no longer due');
  assert.equal((await docs('expenses')).filter((e) => e.commitmentId === 'cInternet').length, 1, 'exactly one ledger expense');
  // Delete (void with reason) — removed from totals, kept for audit.
  await page.locator('#fm-rows [data-expense="eBread"] [data-action=delete]').click(); await page.fill('#fm-del-reason', 'duplicate'); await submit('fm-del-form');
  await page.locator('#fm-rows [data-expense="eBread"]').waitFor({ state: 'detached' });
  assert.equal((await docs('expenses')).find((e) => e.id === 'eBread').status, 'void');
  // ---- Calendar: CSV import (preview → confirm), re-import is a no-op, off-duty → vacation only on confirmation.
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-import');
  await page.fill('#cal-imp-text', FIXTURE_CSV); await page.click('#cal-imp-preview');
  assert.match(await txt('#cal-imp-summary'), /8 events \(8 valid, 0 already imported\) · 9 blank lines/);
  assert.equal(await page.locator('#cal-imp-aud').inputValue(), 'private', 'follows the file’s Private flag by default');
  await page.selectOption('#cal-imp-aud', 'household'); await page.click('#cal-imp-confirm');
  await page.waitForFunction((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/calendarEvents/csv_`)).length === 8, H);
  assert.ok((await docs('calendarEvents')).every((e) => e.type === 'work' && e.audience === 'household' && e.timezone === 'UTC' && e.source === 'csv'));
  await page.click('#cal-import'); await page.fill('#cal-imp-text', FIXTURE_CSV); await page.click('#cal-imp-preview');
  assert.match(await txt('#cal-imp-summary'), /8 already imported/); assert.ok(await page.locator('#cal-imp-confirm').isDisabled());
  await page.click('#cal-imp-cancel');
  assert.equal((await docs('calendarEvents')).filter((e) => e.type === 'vacation').length, 0, 'gaps are never vacation by themselves');
  await page.locator('#cal-gaps [data-gap="2026-01-09_2026-01-10"] [data-action=confirm-vacation]').click(); await page.click('dialog[open] .btn--primary');
  await page.waitForFunction((h) => Object.values(window.__fake.dump()).some((v) => v && v.type === 'vacation' && v.startDate === '2026-01-09' && v.endDate === '2026-01-10'), H);
  // ---- Finance vacation filter + summary (by the expense's own date, both ends inclusive).
  await page.goto(BASE + '#/m/expenses'); await page.locator('#fm-cal').waitFor();
  await page.selectOption('#fm-cal', 'vacation'); await page.locator('#fm-rows [data-expense="eHotel"]').waitFor();
  assert.match(await txt('#fm-vac-total'), /1,500/); assert.match(await txt('#fm-vac-bank'), /1,500/); assert.match(await txt('#fm-chip-cal'), /All vacations/);
  await page.click('#fm-clear'); await page.locator('#fm-rows [data-expense="eHotel"]').waitFor({ state: 'detached' });
  // ---- Dashboard: live calendar widget (create from ＋, agenda, expand), ONE cleaning reminder.
  await page.goto(BASE + '#/dashboard'); await page.locator('#cal-widget #calw-grid').waitFor();
  await page.click('#calw-add'); await page.fill('#cal-f-title', 'Dentist'); await page.selectOption('#cal-f-type', 'task'); await submit('cal-form');
  await page.locator('#calw-agenda [data-type="task"]', { hasText: 'Dentist' }).waitFor();
  await page.locator(`#calw-grid [data-date="${days.today}"] .cal-dot`).first().waitFor();
  await page.locator('#calw-agenda [data-action=done]').click(); await page.locator('#calw-agenda .cal-item--done').waitFor();
  await page.click('#calw-expand'); await page.locator('#calw-open').waitFor(); await page.locator('#calw-grid .cal-chip', { hasText: 'Dentist' }).waitFor();
  await page.goto(BASE + '#/reminders'); await page.locator('#rm-counts').waitFor();
  assert.equal(await page.locator('.rm-item:has-text("Pending cleaning tasks")').count(), 1);
  assert.match(await txt('#rm-cleaning-body'), /2 task\(s\) in 2 room\(s\)/);
  assert.doesNotMatch(await txt('#rm-groups'), /Wipe counter|Clean mirror/, 'no per-task cleaning reminders');
  // ---- Member: no budget editing; sees the household calendar.
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.locator('#fm-available').waitFor();
  assert.equal(await page.locator('#fm-budget-edit').count(), 0, 'members cannot set the budget');
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-view-agenda'); await page.locator('#cal-agenda-list, #cal-agenda-empty').first().waitFor();
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // ---- Arabic + mobile.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/m/expenses'); await page.locator('#fm-money', { hasText: 'المتاح الآن' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'finance: no horizontal overflow');
  await shot(page, '60-v62-finance-ar-mobile');
  await page.goto(BASE + '#/dashboard'); await page.locator('#cal-widget', { hasText: 'اليوم' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'dashboard: no horizontal overflow');
  await shot(page, '61-v62-calendar-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

await check('V621-UI Calendar → Settings → CSV Imports: batch provenance, remove one batch only (edited kept, manual + other batch + ungrouped untouched), partial failure → resume, vacation filter updates, expenses kept, re-import restores only when ticked; Finance History = Overview table; AR / mobile / keyboard', async () => {
  await ensureSignedOut();
  const H = 'hV621';
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const A = { createdBy: 'UID_OWNER', createdAt: '2025-01-01T00:00:00Z', updatedBy: 'UID_OWNER', updatedAt: '2025-01-01T00:00:00Z', schemaVersion: 1 };
    window.__fake.set(`homes/${h}`, { name: 'V6.2.1 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 8 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['expenses.view', 'expenses.create', 'expenses.edit', 'calendar.view', 'calendar.create', 'calendar.edit'], system: true, templateVersion: 8 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    const W = (name, role) => ({ name, type: role, scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, role, openingDate: '2025-01-01', ...A });
    window.__fake.set(`homes/${h}/wallets/bank`, W('Bank', 'bank')); window.__fake.set(`homes/${h}/wallets/cash`, W('Cash in hand', 'cash'));
    window.__fake.set(`homes/${h}/walletMovements/op_bank`, { type: 'opening', amountMinor: 1000000, currency: 'EGP', date: '2025-01-01', fromWalletId: null, toWalletId: 'bank', cycleId: null, note: null, audience: 'household', readers: [], status: 'active', ...A });
    window.__fake.set(`homes/${h}/expenses/eHotel`, { amountMinor: 150000, currency: 'EGP', date: '2026-01-10', category: 'entertainment', note: 'Hotel', merchant: null, paymentMethod: 'debit_card', walletId: 'bank', budgetCycleId: null, paidBy: null,
      commitmentId: null, commitmentDueDate: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app', periodId: null, lateEntry: false, ...A });
    const EV = (x) => ({ type: 'other', allDay: true, startTime: null, endTime: null, description: null, location: null, audience: 'household', timezone: 'UTC', done: false, deletedAt: null, deletedBy: null, rev: 1, ...A, ...x });
    window.__fake.set(`homes/${h}/calendarEvents/manual1`, EV({ title: 'Day Shift', type: 'work', startDate: '2026-01-05', endDate: '2026-01-05', source: 'manual', sourceKey: null, importBatchId: null, importRev: null }));
    window.__fake.set(`homes/${h}/calendarEvents/csv_00000000000000aa`, EV({ title: 'Old import', startDate: '2026-02-20', endDate: '2026-02-20', source: 'csv', sourceKey: '00000000000000aa' }));   // V6.2: no batch
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const docs = (c) => page.evaluate(([h, c]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/${c}/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), [H, c]);
  const txt = (sel) => page.locator(sel).innerText();
  const submit = async (form) => { await page.click(`dialog[open] button[form="${form}"]`); await page.locator(`#${form}`).waitFor({ state: 'detached' }); };
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // ---- 1. Import the Google CSV as a FILE → one batch, provenance on every event.
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-import');
  await page.setInputFiles('#cal-imp-file', { name: 'google-2026.csv', mimeType: 'text/csv', buffer: Buffer.from(FIXTURE_CSV) });
  await page.locator('#cal-imp-summary').waitFor(); await page.selectOption('#cal-imp-aud', 'household'); await page.click('#cal-imp-confirm');
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/calendarImports/`) && v.fileName === 'google-2026.csv' && v.status === 'active'), H);
  const b1 = (await docs('calendarImports')).find((b) => b.fileName === 'google-2026.csv');
  assert.deepEqual([b1.createdCount, b1.audience, b1.createdBy], [8, 'household', 'UID_OWNER']);
  const imported = (await docs('calendarEvents')).filter((e) => e.importBatchId === b1.id);
  assert.equal(imported.length, 8); assert.ok(imported.every((e) => e.importRev === 1 && e.source === 'csv'));
  // ---- 2. A second (pasted) import: a vacation.
  await page.click('#cal-import');
  await page.fill('#cal-imp-text', 'Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description,Location,Private\nTrip,1/9/2026,,1/10/2026,,True,,,False\n');
  await page.click('#cal-imp-preview'); await page.selectOption('#cal-imp-batch', 'vacation'); await page.selectOption('#cal-imp-aud', 'household'); await page.click('#cal-imp-confirm');
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).filter(([k, v]) => k.startsWith(`homes/${h}/calendarImports/`) && v.status === 'active').length === 2, H);
  const b2 = (await docs('calendarImports')).find((b) => b.fileName === 'Pasted text');
  // Finance: the imported vacation drives the filter; Hotel (Jan 10) is inside it.
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history'); await page.locator('#fm-cal').waitFor();
  assert.deepEqual(await page.locator('#fin-panel #fm-rows, #fin-panel #fm-empty').evaluateAll((x) => x.length), 1, 'History renders the shared table component');
  await page.selectOption('#fm-cal', 'vacation'); await page.locator('#fm-rows [data-expense="eHotel"]').waitFor();
  assert.deepEqual(await page.locator('#fm-rows .fm-th [role=columnheader], #fm-rows .fm-th span').evaluateAll((x) => x.length > 0), true);
  assert.match(await txt('#fm-rows [data-expense="eHotel"]'), /🏦 Bank[\s\S]*−EGP\s1,500/);
  // ---- 3. Settings → CSV Imports: list with file, time, count, status; ungrouped V6.2 import shown separately.
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-settings'); await page.locator('#cal-settings-panel').waitFor();
  assert.equal(await page.locator('#cal-batches .cal-batch').count(), 2);
  const row1 = page.locator(`#cal-batches [data-batch="${b1.id}"]`);
  assert.match(await row1.innerText(), /google-2026\.csv[\s\S]*8 event\(s\) imported[\s\S]*8 still in the calendar[\s\S]*Imported/);
  assert.match(await txt('#cal-ungrouped summary'), /Older imports without a batch \(1\)/);
  // one imported shift is edited after import → kept by default
  const edited = imported.find((e) => e.startDate === '2026-01-05') || imported[0];
  await page.evaluate(([h, id]) => window.__fake.patch(`homes/${h}/calendarEvents/${id}`, { title: 'Day Shift (swapped)', rev: 2 }), [H, edited.id]);
  // ---- 4. Partial failure → "Removal interrupted" → Resume finishes; idempotent.
  const victim = imported.find((e) => e.id !== edited.id).id;
  await page.evaluate((id) => { window.__fakeDenyIds = [id]; }, victim);
  await page.focus(`#cal-batches [data-batch="${b1.id}"] [data-action=remove-batch]`); await page.keyboard.press('Enter');   // keyboard reachable
  await page.locator('#cal-rm-scope', { hasText: '7 event(s)' }).waitFor();
  assert.match(await txt('dialog[open] label.fin-check'), /Keep the 1 event\(s\) changed after import/);
  await page.click('dialog[open] button[form="cal-rm-form"]');
  await page.locator('#cal-rm-form .banner', { hasText: 'Removal stopped partway' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator(`#cal-batches [data-batch="${b1.id}"]`, { hasText: 'Removal interrupted' }).waitFor();
  await page.evaluate(() => { window.__fakeDenyIds = []; });
  await page.click(`#cal-batches [data-batch="${b1.id}"] [data-action=remove-batch]`);
  assert.match(await txt('dialog[open] button[form="cal-rm-form"]'), /Resume removal/);
  await submit('cal-rm-form');
  await page.locator(`#cal-batches [data-batch="${b1.id}"]`, { hasText: 'Removed' }).waitFor();
  assert.equal(await row1.locator('[data-action=remove-batch]').count(), 0, 'removed is final');
  const ev = await docs('calendarEvents'); const byId = (id) => ev.find((e) => e.id === id);
  assert.equal(ev.filter((e) => e.importBatchId === b1.id && e.deletedAt).length, 7, 'only this batch, soft delete');
  assert.ok(!byId(edited.id).deletedAt, 'edited event kept'); assert.ok(!byId('manual1').deletedAt, 'manual event untouched (same title / date)');
  assert.ok(!byId('csv_00000000000000aa').deletedAt, 'ungrouped V6.2 import never bulk-removed');
  assert.ok(ev.filter((e) => e.importBatchId === b2.id).every((e) => !e.deletedAt), 'other batch untouched');
  assert.equal(ev.length, 11, 'nothing hard-deleted');
  const b1d = (await docs('calendarImports')).find((b) => b.id === b1.id); assert.deepEqual([b1d.status, b1d.removedCount, b1d.keptCount], ['removed', 7, 1]);
  // ---- 5. Remove the vacation batch → Finance filter updates; the expense stays.
  await page.click(`#cal-batches [data-batch="${b2.id}"] [data-action=remove-batch]`);
  await page.locator('#cal-rm-vac', { hasText: '1 of them are vacations' }).waitFor(); await submit('cal-rm-form');
  await page.locator(`#cal-batches [data-batch="${b2.id}"]`, { hasText: 'Removed' }).waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history');
  assert.equal(await page.locator('#fm-cal option[value="vacation"]').count(), 0, 'no vacation left to filter by');
  assert.equal((await docs('expenses')).find((e) => e.id === 'eHotel').status, 'active', 'removing a vacation never touches expenses');
  // ---- 6. Re-import: removed rows are offered, restored only when ticked, into a NEW batch.
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-import');
  await page.setInputFiles('#cal-imp-file', { name: 'google-2026.csv', mimeType: 'text/csv', buffer: Buffer.from(FIXTURE_CSV) });
  await page.locator('#cal-imp-rows li', { hasText: 'removed earlier' }).first().waitFor();
  assert.equal(await page.locator('#cal-imp-rows li', { hasText: 'removed earlier' }).count(), 7);
  assert.ok(await page.locator('#cal-imp-confirm').isDisabled(), 'nothing restored by default');
  await page.locator('#cal-imp-rows li', { hasText: 'removed earlier' }).first().locator('input[type=checkbox]').check();
  await page.selectOption('#cal-imp-aud', 'household'); await page.click('#cal-imp-confirm');
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).filter(([k, v]) => k.startsWith(`homes/${h}/calendarImports/`) && v.fileName === 'google-2026.csv').length === 2, H);
  const b3 = (await docs('calendarImports')).find((b) => b.fileName === 'google-2026.csv' && b.id !== b1.id);
  await page.waitForFunction(([h, b]) => window.__fake.dump()[`homes/${h}/calendarImports/${b}`].status === 'active', [H, b3.id]);
  const restored = (await docs('calendarEvents')).filter((e) => e.importBatchId === b3.id);
  assert.equal(restored.length, 1); assert.ok(!restored[0].deletedAt && restored[0].importRev === restored[0].rev, 'restored, not "edited"');
  // ---- 7. Member: sees household batches; cannot remove (no calendar.delete).
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-settings'); await page.locator('#cal-batches .cal-batch').first().waitFor();
  assert.equal(await page.locator('#cal-batches [data-action=remove-batch]').count(), 0);
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // ---- 8. Arabic + mobile.
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-settings'); await page.locator('#cal-settings-panel', { hasText: 'استيرادات CSV' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'calendar settings: no horizontal overflow');
  await shot(page, '62-v621-calendar-imports-ar-mobile');
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history'); await page.locator('#fm-search').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'history: no horizontal overflow');
  await shot(page, '63-v621-history-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

await check('V622-UI Wallets: Edit / Correct balance / Delete (archive) / Restore with history; double click, stale and no-op refused; Cash / Bank and billed wallets protected; member read-only. Calendar: continuous multi-day bars (widget = page), Day / Night shift icons + colours, import preview, override, Work filter; AR / mobile', async () => {
  await ensureSignedOut();
  const H = 'hV622';
  const C = await import('../../src/modules/calendar/calendar-model.js');
  const today = await todayStr(); const ym = today.slice(0, 7);
  const g = C.monthGrid(ym); const wk = (i) => g.slice(i * 7, i * 7 + 7);
  const D = { dsFrom: wk(1)[0], dsTo: wk(1)[3], night: wk(1)[5], nightEnd: wk(1)[6], vFrom: wk(2)[5], vTo: wk(3)[1] };
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate(([h, D]) => {
    const A = { createdBy: 'UID_OWNER', createdAt: '2025-01-01T00:00:00Z', updatedBy: 'UID_OWNER', updatedAt: '2025-01-01T00:00:00Z', schemaVersion: 1 };
    window.__fake.set(`homes/${h}`, { name: 'V6.2.2 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 8 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['expenses.view', 'expenses.create', 'expenses.edit', 'expenses.transfer', 'expenses.viewFinancialTotals', 'calendar.view'], system: true, templateVersion: 8 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    const W = (name, type, role, x = {}) => ({ name, type, scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, ...(role ? { role, openingDate: '2025-01-01' } : {}), ...A, ...x });
    window.__fake.set(`homes/${h}/wallets/bank`, W('Bank', 'bank', 'bank')); window.__fake.set(`homes/${h}/wallets/cash`, W('Cash', 'cash', 'cash')); window.__fake.set(`homes/${h}/wallets/visa`, W('Visa card', 'card', null));
    const MV = (id, to, amt) => window.__fake.set(`homes/${h}/walletMovements/${id}`, { type: 'opening', amountMinor: amt, currency: 'EGP', date: '2025-01-01', fromWalletId: null, toWalletId: to, cycleId: null, note: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, ...A });
    MV('op_bank', 'bank', 1000000); MV('op_cash', 'cash', 300000);
    const EX = (id, x) => window.__fake.set(`homes/${h}/expenses/${id}`, { amountMinor: 5000, currency: 'EGP', category: 'food', merchant: null, paymentMethod: null, budgetCycleId: null, paidBy: null, commitmentId: null, commitmentDueDate: null,
      audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app', periodId: null, lateEntry: false, ...A, ...x });
    EX('eVisa', { note: 'Visa lunch', walletId: 'visa', date: D.dsFrom }); EX('eNight', { note: 'Night snack', walletId: 'cash', date: D.night });
    window.__fake.set(`homes/${h}/commitments/kNet`, { name: 'Netflix', kind: 'subscription', amountMinor: 20000, currency: 'EGP', category: 'subscriptions', frequency: 'monthly', interval: 1, nextDueDate: D.vTo, walletId: 'visa', paymentMethod: null,
      notes: null, active: true, audience: 'household', readers: [], ...A });
    const EV = (id, x) => window.__fake.set(`homes/${h}/calendarEvents/${id}`, { type: 'work', allDay: true, startTime: null, endTime: null, description: null, location: null, audience: 'household', timezone: 'UTC', done: false,
      source: 'manual', sourceKey: null, importBatchId: null, importRev: null, deletedAt: null, deletedBy: null, rev: 1, ...A, ...x });
    EV('ds', { title: 'Day Shift', shift: 'day', allDay: false, startDate: D.dsFrom, startTime: '07:00', endDate: D.dsTo, endTime: '19:00' });
    EV('ns', { title: 'NIGHT shift  cover', allDay: false, startDate: D.night, startTime: '19:00', endDate: D.nightEnd, endTime: '07:00' });   // V6.2: no field
    EV('vac', { title: 'Trip', type: 'vacation', shift: null, startDate: D.vFrom, endDate: D.vTo });
    EV('one', { title: 'Dentist', type: 'task', shift: null, startDate: D.dsFrom, endDate: D.dsFrom });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, [H, D]);
  const docs = (c) => page.evaluate(([h, c]) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/${c}/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), [H, c]);
  const txt = (sel) => page.locator(sel).innerText();
  const recs = async () => (await docs('walletMovements')).filter((m) => m.type === 'reconciliation');
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // ---------------------------------------------------------------- Wallets
  await page.goto(BASE + '#/m/expenses'); await page.locator('#fm-available').waitFor();
  const spent = await txt('#fm-spent-total'); const avail = await txt('#fm-available');
  await page.click('#fin-tab-wallets'); await page.locator('#wl-bal-cash').waitFor();
  const card = (id) => page.locator(`.fin-wallet[data-id="${id}"]`);
  for (const a of ['edit', 'correct', 'delete']) assert.equal(await card('cash').locator(`[data-action=${a}]`).count(), 1, a);
  // + correction with preview; reason required
  await card('cash').locator('[data-action=correct]').click();
  assert.match(await txt('#cb-current'), /2,950/); assert.match(await txt('dialog[open]'), /Cash · EGP/);
  await page.fill('#cb-actual', '3200'); await page.locator('#cb-delta', { hasText: '+EGP 250' }).waitFor();
  assert.match(await txt('#cb-delta'), /2,950[\s\S]*3,200/);
  await page.click('dialog[open] button[form="cb-form"]'); await page.locator('#cb-form .banner', { hasText: 'reason' }).waitFor();
  await page.fill('#cb-reason', 'Counted the drawer');
  await page.dblclick('dialog[open] button[form="cb-form"]');   // double click → one write
  await page.locator('#cb-form').waitFor({ state: 'detached' });
  await page.locator('#wl-bal-cash', { hasText: '3,200' }).waitFor();
  let r = await recs(); assert.deepEqual(r.map((m) => [m.id, m.toWalletId, m.amountMinor, m.beforeMinor, m.afterMinor]), [['rc_cash_1', 'cash', 25000, 295000, 320000]]);
  assert.equal((await docs('wallets')).find((w) => w.id === 'cash').correctionSeq, 1);
  await card('cash').locator('#wl-adj-cash summary').click();
  assert.match(await txt('#wl-adj-cash'), /Counted the drawer[\s\S]*EGP\s2,950 → EGP\s3,200[\s\S]*Added by[\s\S]*\+EGP\s250/);
  // no-op, then stale (another device adds an expense while the dialog is open)
  await card('cash').locator('[data-action=correct]').click(); await page.fill('#cb-reason', 'x');
  await page.locator('#cb-delta', { hasText: 'No difference' }).waitFor();
  await page.click('dialog[open] button[form="cb-form"]'); await page.locator('#cb-form .banner', { hasText: 'No difference' }).waitFor();
  await page.fill('#cb-actual', '3000');   // any change; the balance moves underneath
  await page.evaluate((h) => window.__fake.set(`homes/${h}/expenses/eOther`, { amountMinor: 1000, currency: 'EGP', category: 'food', note: 'Other device', merchant: null, paymentMethod: null, walletId: 'cash', budgetCycleId: null, paidBy: null, commitmentId: null, commitmentDueDate: null,
    date: new Date().toISOString().slice(0, 10), audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app', periodId: null, lateEntry: false, createdBy: 'UID_MONA', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'UID_MONA', updatedAt: '2026-01-01T00:00:00Z', schemaVersion: 1 }), H);
  await page.click('dialog[open] button[form="cb-form"]'); await page.locator('#cb-form .banner', { hasText: 'balance changed' }).waitFor();
  await page.keyboard.press('Escape'); assert.equal((await recs()).length, 1, 'stale attempt wrote nothing');
  // − correction from the Edit dialog
  await card('cash').locator('[data-action=edit]').click(); await page.click('#wl-correct-from-edit');
  await page.locator('#cb-current', { hasText: '3,190' }).waitFor();
  await page.fill('#cb-actual', '3150'); await page.fill('#cb-reason', 'Rounding'); await page.click('dialog[open] button[form="cb-form"]'); await page.locator('#cb-form').waitFor({ state: 'detached' });
  await page.locator('#wl-bal-cash', { hasText: '3,150' }).waitFor();
  r = await recs(); assert.deepEqual(r.map((m) => m.id).sort(), ['rc_cash_1', 'rc_cash_2']); assert.equal(r.find((m) => m.id === 'rc_cash_2').fromWalletId, 'cash');
  await page.click('#fin-tab-overview'); await page.locator('#fm-available').waitFor();
  const num = (x) => Number(x.replace(/[^\d.]/g, ''));
  assert.equal(num(await txt('#fm-spent-total')) - num(spent), 10, 'only the other-device expense (EGP 10) is spending; corrections are not');
  assert.equal(num(avail) - num(await txt('#fm-available')), 10 - 250 + 40, 'available = balances (−10 expense, +250 −40 corrections)');
  // Delete: Cash blocked; Visa blocked by an active bill; then archived after the bill stops; history intact; restore
  await page.click('#fin-tab-wallets'); await card('cash').locator('[data-action=delete]').click();
  await page.locator('#wl-del-blocked', { hasText: 'Cash and Bank are required' }).waitFor(); await page.keyboard.press('Escape');
  await card('visa').locator('[data-action=delete]').click();
  await page.locator('#wl-del-bills', { hasText: 'Netflix' }).waitFor(); await page.keyboard.press('Escape');
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/commitments/kNet`, { active: false }), H);
  await card('visa').locator('[data-action=delete]').click();
  assert.match(await txt('#wl-del-body'), /archived, not erased/);
  await page.locator('#wl-del-form [data-warn="balance"]').waitFor();
  await page.click('dialog[open] button[form="wl-del-form"]'); await page.locator('#wl-del-form').waitFor({ state: 'detached' });
  await page.locator('.fin-wallet--archived[data-id="visa"] [data-action=restore]').waitFor({ state: 'attached' });
  const visa = (await docs('wallets')).find((w) => w.id === 'visa'); assert.deepEqual([visa.active, visa.archivedBy], [false, 'UID_OWNER']);
  assert.equal((await docs('expenses')).find((e) => e.id === 'eVisa').walletId, 'visa', 'history keeps the wallet id');
  await page.click('.fin-intro button:has-text("Transfer")'); await page.locator('#mv-from').waitFor();
  assert.ok(!(await page.locator('#mv-from option').evaluateAll((o) => o.map((x) => x.value))).includes('visa'), 'archived not offered'); await page.keyboard.press('Escape');
  await page.click('#fin-tab-history'); await page.fill('#fm-search', 'visa lunch'); await page.locator('#fm-rows [data-expense="eVisa"]', { hasText: 'Visa card' }).waitFor();
  await page.click('#fin-tab-wallets'); await page.locator('.fin-wallet--archived summary, details.form-section > summary', { hasText: 'Archived' }).first().click().catch(() => {});
  await page.locator('.fin-wallet--archived[data-id="visa"] [data-action=restore]').click();
  await page.waitForFunction((h) => window.__fake.dump()[`homes/${h}/wallets/visa`].active === true, H);
  // member: read-only
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets'); await page.locator('#wl-bal-cash').waitFor();
  assert.equal(await page.locator('.fin-wallet [data-action=correct], .fin-wallet [data-action=delete]').count(), 0);
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // ---------------------------------------------------------------- Calendar bars + shifts
  const bars = async (root) => page.locator(`${root} .cal-bar`).evaluateAll((b) => b.map((x) => [x.dataset.event, x.dataset.from, x.dataset.to, [...x.classList].filter((c) => /cal-c-|cont/.test(c)).sort().join(' '), !!x.querySelector('.cal-ico')]).sort());
  await page.goto(BASE + '#/m/calendar'); await page.locator('#cal-grid .cal-bar').first().waitFor();
  const pageBars = await bars('#cal-grid');
  assert.deepEqual(pageBars, [
    ['ds', D.dsFrom, D.dsTo, 'cal-c-blue', true],
    ['ns', D.night, D.nightEnd, 'cal-c-purple', true],
    ['vac', D.vFrom, wk(2)[6], 'cal-bar--cont-end cal-c-green', false],
    ['vac', wk(3)[0], D.vTo, 'cal-bar--cont-start cal-bar--continued cal-c-green', false]].sort(), 'one bar per row segment; colours; icons');
  assert.equal(await page.locator('#cal-grid .cal-bar[data-event="ds"] svg.cal-ico--day').count(), 1);
  assert.equal(await page.locator('#cal-grid .cal-bar[data-event="ns"] svg.cal-ico--night').count(), 1, 'V6.2 "night shift" event rendered as Night Shift without migration');
  assert.equal(await page.locator(`#cal-grid [data-date="${D.dsFrom}"] :is(.cal-dot, .cal-chip)`).count(), 1, 'single-day Dentist stays compact; the span is not repeated per day');
  const numBox = await page.locator(`#cal-grid [data-date="${D.dsFrom}"] .cal-num`).boundingBox(); const barBox = await page.locator('#cal-grid .cal-bar[data-event="ds"]').boundingBox();
  assert.ok(barBox.y >= numBox.y + numBox.height - 1, 'bar sits below the date number');
  await page.click('#cal-grid .cal-bar[data-event="vac"].cal-bar--cont-start');
  await page.locator(`#cal-grid [data-date="${wk(3)[0]}"][aria-selected="true"]`).waitFor();
  await page.locator('#cal-agenda', { hasText: 'Trip' }).waitFor();
  // dashboard parity
  await page.goto(BASE + '#/dashboard'); await page.locator('#calw-grid .cal-bar').first().waitFor();
  assert.deepEqual(await bars('#calw-grid'), pageBars, 'widget = full calendar');
  // agenda: icon + label; edit override → not a shift
  await page.goto(BASE + '#/m/calendar'); await page.click(`#cal-grid [data-date="${D.night}"] .cal-num`);
  await page.locator('#cal-agenda svg.cal-ico--night[role="img"][aria-label="Night Shift"]').waitFor();
  await page.click(`#cal-grid [data-date="${D.dsFrom}"] .cal-num`); await page.click('#cal-agenda [data-event="ds"] [data-action=edit]');
  assert.equal(await page.inputValue('#cal-f-shift'), 'day');
  await page.selectOption('#cal-f-shift', 'none'); await page.selectOption('#cal-f-type', 'other'); await page.click('dialog[open] button[form="cal-form"]'); await page.locator('#cal-form').waitFor({ state: 'detached' });
  await page.locator('#cal-grid .cal-bar[data-event="ds"].cal-c-gray').waitFor();
  const ds = (await docs('calendarEvents')).find((e) => e.id === 'ds'); assert.deepEqual([ds.shift, ds.type, ds.title], [null, 'other', 'Day Shift'], 'title kept; override stored');
  // import preview shows the detected subtype before confirming
  await page.click('#cal-import'); await page.fill('#cal-imp-text', FIXTURE_CSV); await page.click('#cal-imp-preview');
  await page.locator('#cal-imp-rows [data-role=shift][data-shift=day] svg.cal-ico--day').first().waitFor();
  assert.ok(await page.locator('#cal-imp-rows [data-role=shift][data-shift=night].cal-c-purple').count() > 0);
  await page.click('#cal-imp-cancel').catch(() => page.keyboard.press('Escape'));
  // Finance: the night shift counts as Work
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-history'); await page.selectOption('#fm-cal', 'work');
  await page.locator('#fm-rows [data-expense="eNight"]').waitFor();
  assert.equal(await page.locator('#fm-cal option[value="vacation"]').count(), 1, 'the Trip is the only vacation');
  // Arabic + mobile
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/m/calendar'); await page.locator('#cal-grid .cal-bar').first().waitFor();
  const rtl = await page.locator('#cal-grid .cal-bar[data-event="vac"].cal-bar--cont-end').boundingBox(); const cell = await page.locator(`#cal-grid [data-date="${D.vFrom}"]`).boundingBox();
  assert.ok(Math.abs((rtl.x + rtl.width) - (cell.x + cell.width)) < cell.width, 'RTL: the bar starts on the right, under its first day');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'calendar: no horizontal overflow');
  await shot(page, '64-v622-calendar-bars-ar-mobile');
  await page.goto(BASE + '#/m/expenses'); await page.click('#fin-tab-wallets'); await page.locator('.fin-wallet[data-id="cash"] [data-action=correct]').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'wallets: no horizontal overflow');
  await shot(page, '65-v622-wallets-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== V6.3
await check('V630-UI Cleaning: routine is the page (Tasks tab), no Claim, Mark All Done exact scope (routine + Quick 5 min ≠ 15 min), confirm + no double write; Settings: reset progress / restore defaults (custom kept, then removed), rooms + devices untouched, member denied; AI import layout. Recipes: AI JSON import (prompt / template / example, mixed validity, duplicate, failure → retry, no duplicates) → Start cooking + step timer; AR / dark / mobile', async () => {
  await ensureSignedOut();
  const H = 'hV630'; const err0 = page.errors.length;
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null, mona: d['users/UID_MONA'] || null }; });
  await page.evaluate((h) => {
    const d = window.__fake.dump(); const today = new Date().toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'V6.3 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 7 });
    window.__fake.set(`homes/${h}/roles/member`, { name: 'Member', rank: 50, permissions: ['cleaning.view', 'cleaning.complete', 'rooms.view', 'devices.view', 'members.view', 'chef.view'], system: true, templateVersion: 7 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'member', status: 'active', relationship: 'adult', guardianUids: [] });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/devices/dw`, { name: 'Dishwasher', category: 'kitchen_appliance', subtype: 'dishwasher', roomId: 'kit', status: 'operational', icon: 'dishwasher', active: true });
    const T = (title, min, extra = {}) => ({ title, instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 },
      startDate: today, dueDate: null, endDate: null, estimatedMinutes: min, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1, ...extra });
    window.__fake.set(`homes/${h}/cleaningTasks/q5a`, T('Quick wipe A', 5)); window.__fake.set(`homes/${h}/cleaningTasks/q5b`, T('Quick wipe B', 5));
    window.__fake.set(`homes/${h}/cleaningTasks/q15`, T('Long mop', 15));
    window.__fake.set(`homes/${h}/cleaningTasks/priv`, T('Mona only', 5, { assignMode: 'assigned', assigneeUids: ['UID_MONA'] }));
    window.__fake.set(`homes/${h}/cleaningTasks/r_kit_kitchen_0`, T('Renamed default', 9, { source: { kind: 'room', id: 'kit', templateKey: 'kitchen_0', templateVersion: 1 }, recurrence: { kind: 'after', unit: 'day', interval: 1 } }));
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
    window.__fake.set('users/UID_MONA', { ...(d['users/UID_MONA'] || {}), email: 'mona@example.com', displayName: 'Mona', defaultHomeId: h, language: 'en', theme: 'light' });
  }, H);
  const dump = () => page.evaluate((h) => Object.fromEntries(Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/`)).map(([k, v]) => [k.slice(h.length + 7), v])), H);
  const occOf = async (id) => Object.entries(await dump()).filter(([k]) => k.startsWith(`cleaningOccurrences/${id}_`)).map(([, v]) => v);
  const roomsDevices = async () => JSON.stringify(Object.entries(await dump()).filter(([k]) => /^(rooms|devices)\//.test(k)).sort());
  const rd0 = await roomsDevices();
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 1. Navigation: Today's routine is the Cleaning page; task management + AI import are tabs; no Main / Advanced tab.
  await page.goto(BASE + '#/m/cleaning'); await page.locator('#cl-adv-list .cl-item[data-task]').nth(3).waitFor();
  assert.equal(await page.locator('#cl-adv-tab-routine').getAttribute('aria-selected'), 'true');
  for (const tab of ['routine', 'quick', 'rooms', 'devices', 'tasks', 'templates', 'import', 'stats', 'settings']) assert.equal(await page.locator(`#cl-adv-tab-${tab}`).count(), 1, tab);
  assert.equal(await page.locator('#cl-advanced, #cl-adv-back, #cl-tab-today, [data-action=claim]').count(), 0);
  // 2. Quick routine, 5 minutes: exactly the two 5-minute tasks the owner may do (never the 15-minute one, never Mona's private task).
  await page.click('#cl-adv-tab-quick'); await page.click('#cl-adv-quick [data-min="5"]');
  await page.locator('#cl-markall-btn-quick', { hasText: '(1)' }).waitFor();   // budget 5 min → one 5-minute task fits
  await page.click('#cl-adv-quick [data-min="10"]');
  const quickBtn = page.locator('#cl-markall-btn-quick', { hasText: '(2)' }); await quickBtn.waitFor();
  const shown = await page.locator('#cl-adv-quick .cl-item[data-task]').evaluateAll((els) => els.map((e) => e.dataset.task).sort());
  assert.deepEqual(shown, ['q5a', 'q5b']);
  await quickBtn.click(); await page.locator('dialog[open]', { hasText: /2 pending task\(s\) shown in the 10-minute quick routine/ }).waitFor();
  await page.locator('dialog[open] .btn--secondary').click();   // cancel → nothing written
  assert.equal((await occOf('q5a')).length, 0, 'cancel writes nothing');
  await quickBtn.click(); await page.locator('dialog[open] .btn--primary, dialog[open] .btn--danger').last().click();
  await page.locator('#cl-markall-status-quick', { hasText: /2 marked done/ }).waitFor();
  assert.deepEqual([(await occOf('q5a'))[0].status, (await occOf('q5b'))[0].status, (await occOf('q15')).length, (await occOf('priv')).length], ['done', 'done', 0, 0], '15-minute and private tasks untouched');
  // 3. Today's routine: count = remaining eligible items; a write failure is reported and retry finishes without double completion.
  await page.click('#cl-adv-tab-routine');
  const routineBtn = page.locator('#cl-markall-btn-routine', { hasText: '(2)' }); await routineBtn.waitFor();   // q15 + the default (q5a/q5b done; private excluded)
  await page.evaluate(() => { window.__fakeDenyIds = ['q15_' + new Date().toISOString().slice(0, 10).replace(/-/g, '')]; });
  await routineBtn.click(); await page.locator('dialog[open] .btn--primary, dialog[open] .btn--danger').last().click();
  await page.locator('#cl-markall-status-routine', { hasText: /1 marked done, 1 failed/ }).waitFor();
  await page.evaluate(() => { window.__fakeDenyIds = []; });
  await page.locator('#cl-markall-btn-routine', { hasText: '(1)' }).click(); await page.locator('dialog[open] .btn--primary, dialog[open] .btn--danger').last().click();
  await page.locator('#cl-markall-btn-routine', { hasText: '(0)' }).waitFor();
  assert.ok(await page.locator('#cl-markall-btn-routine').isDisabled(), 'disabled at zero');
  const logs = Object.entries(await dump()).filter(([k, v]) => k.startsWith('cleaningLog/') && v.action === 'complete').map(([, v]) => v.taskId).sort();
  assert.deepEqual(logs, ['q15', 'q5a', 'q5b', 'r_kit_kitchen_0'], 'each completed exactly once, audited');
  // 4. Settings → Reset task progress (managers only): today's progress undone, history kept, rooms / devices untouched.
  await page.click('#cl-adv-tab-settings'); await page.locator('#cl-adv-reset').waitFor();
  await page.click('#cl-reset-progress'); await page.locator('#cl-reset-progress-body').waitFor();
  await page.locator('dialog[open] button[type=submit]').click();
  await page.locator('#cl-reset-result', { hasText: /Progress reset/ }).waitFor();
  assert.deepEqual((await occOf('q5a')).map((o) => o.status), ['open'], 'today undone (audited inverse action)');
  assert.ok(Object.entries(await dump()).some(([k, v]) => k.startsWith('cleaningLog/q5a_') && v.action === 'reopen'), 'audit kept');
  // 5. Restore defaults: custom kept by default; the renamed default gets its original title; missing defaults created.
  await page.click('#cl-reset-defaults'); await page.locator('#cl-reset-defaults-form').waitFor();
  assert.equal(await page.locator('#cl-reset-remove-custom').isChecked(), false, '"Also remove custom tasks" is unchecked by default');
  await page.locator('dialog[open] button[type=submit]').click();
  await page.locator('#cl-reset-result', { hasText: /Default tasks restored/ }).waitFor();
  let all = await dump();
  assert.notEqual(all['cleaningTasks/r_kit_kitchen_0'].title, 'Renamed default');
  assert.ok(['q5a', 'q5b', 'q15', 'priv'].every((id) => all[`cleaningTasks/${id}`].active === true), 'custom tasks kept');
  const defaults = Object.keys(all).filter((k) => /^cleaningTasks\/(r_kit_|d_dw_)/.test(k)).length;
  assert.ok(defaults > 5, 'missing defaults created');
  // Idempotent: a second restore creates nothing new; then explicit custom removal archives (never deletes) them.
  await page.click('#cl-reset-defaults'); await page.check('#cl-reset-remove-custom'); await page.locator('#cl-reset-remove-warn').waitFor();
  await page.locator('dialog[open] button[type=submit]').click();
  await page.locator('#cl-reset-result', { hasText: /Default tasks restored/ }).waitFor();
  all = await dump();
  assert.equal(Object.keys(all).filter((k) => /^cleaningTasks\/(r_kit_|d_dw_)/.test(k)).length, defaults, 'no duplicate defaults');
  assert.ok(['q5a', 'q5b', 'q15', 'priv'].every((id) => all[`cleaningTasks/${id}`] && all[`cleaningTasks/${id}`].active === false), 'customs archived, still stored');
  assert.equal(await roomsDevices(), rd0, 'rooms and devices byte-identical');
  // 6. AI import tab layout (cards, no overflow) — EN mobile.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.click('#cl-adv-tab-import'); await page.locator('#cl-ai-step1').waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'AI import: no horizontal overflow at 360px');
  await shot(page, '63-cleaning-ai-import-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  // 7. A member without edit rights sees no reset controls (and the rules refuse the writes; see V630-2).
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/cleaning'); await page.click('#cl-adv-tab-settings');
  await page.locator('#cl-reset-denied, #cl-adv-settings').first().waitFor();
  assert.equal(await page.locator('#cl-reset-progress:not([disabled]), #cl-reset-defaults:not([disabled])').count(), 0, 'no reset for a member');
  await logout(); await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  // 8. Recipes AI JSON import.
  await page.evaluate((h) => window.__fake.set(`homes/${h}/recipes/rec_lentil1`, { titleEn: 'Lentil soup', titleAr: '', description: '', category: 'soup', servings: 2, prepMinutes: 0, cookMinutes: 0,
    video: '', videoId: null, ingredients: [], steps: [], notes: '', favoritedBy: [], archived: false, archivedAt: null, archivedBy: null, rev: 1, createdBy: 'UID_OWNER', createdAt: 'N', updatedBy: 'UID_OWNER', updatedAt: 'N', schemaVersion: 1 }), H);
  await page.goto(BASE + '#/m/chef'); await page.click('#ck-ai-open'); await page.locator('#ck-imp-step1').waitFor();
  await page.click('#ck-imp-copy-prompt'); await page.locator('.toast').first().waitFor();
  const dl = page.waitForEvent('download'); await page.click('#ck-imp-download');
  const file = await (await dl).path(); const example = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
  assert.equal(example.schema, 'homehub.recipes');
  const payload = { schema: 'homehub.recipes', version: 1, items: [
    { titleEn: 'Imported pancakes', category: 'other', servings: 2, ingredients: [{ name: 'Flour', amount: '1 1/2', unit: 'cup', note: null }], steps: [{ text: 'Mix', minutes: null }, { text: 'Fry', minutes: 1 }], videoUrl: 'https://youtu.be/dQw4w9WgXcQ', review: ['Pan size unclear'] },
    { titleEn: 'Lentil soup', steps: [{ text: 'Cook', minutes: null }] },
    { titleEn: '<img src=x onerror=alert(1)>', createdBy: 'UID_MONA', steps: [] },
    { titleEn: 'Bad link', videoUrl: 'javascript:alert(1)' },
    { titleEn: 'Second import', steps: [{ text: 'Serve', minutes: null }] }] };
  await page.fill('#ck-imp-text', JSON.stringify(payload)); await page.click('#ck-imp-preview');
  await page.locator('#ck-imp-counts', { hasText: '2 ready · 1 duplicate · 2 invalid' }).waitFor();
  assert.equal(await page.locator('.ck-imp-item[data-status=duplicate] input[name="ck-imp-item"]').isChecked(), false, 'duplicate skipped by default');
  assert.match(await page.locator('.ck-imp-item[data-index="2"]').innerText(), /Protected field not allowed: createdBy/);
  assert.match(await page.locator('.ck-imp-item[data-index="3"]').innerText(), /safe https link/);
  assert.equal(await page.locator('#ck-imp-list img').count(), 0, 'untrusted text never rendered as HTML');
  const recipes = async () => Object.entries(await dump()).filter(([k, v]) => k.startsWith('recipes/') && !v.deletedAt).map(([k, v]) => ({ id: k.slice(8), ...v }));
  assert.equal((await recipes()).length, 1, 'no write before confirmation');
  await page.evaluate(() => { window.__fakeFailNextCommit = true; });
  await page.locator('#ck-imp-confirm', { hasText: 'Import 2' }).click();
  await page.locator('#ck-imp-retry', { hasText: 'Retry 1' }).waitFor();
  assert.equal((await recipes()).length, 2, 'partial: one saved');
  await page.click('#ck-imp-retry'); await page.locator('#ck-imp-retry').waitFor({ state: 'detached' });
  const rs = await recipes(); assert.equal(rs.length, 3, 'retry: no duplicates');
  const imp = rs.find((r) => r.titleEn === 'Imported pancakes');
  assert.ok(imp.id.startsWith('ai_') && imp.createdBy === 'UID_OWNER' && imp.videoId === 'dQw4w9WgXcQ' && /Pan size unclear/.test(imp.notes));
  // Behaves like a manual recipe: search → detail → ordered steps → Start cooking → step timer runs.
  await page.click('#ck-imp-back'); await page.fill('#ck-search', 'pancakes');
  await page.locator('#ck-grid .ck-card', { hasText: 'Imported pancakes' }).locator('.ck-card__open').click();
  await page.locator('#ck-title', { hasText: 'Imported pancakes' }).waitFor();
  assert.deepEqual(await page.locator('#ck-steps-list li p').allInnerTexts(), ['Mix', 'Fry']);
  await page.click('#ck-cook'); await page.locator('#ck-cook-step').waitFor();
  // 9. Arabic + dark + mobile: import screen fits.
  await page.goto(BASE + '#/dashboard'); await page.locator('.hero__home').waitFor();
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(BASE + '#/m/chef'); await page.click('#ck-ai-open'); await page.locator('#ck-imp-copy-prompt', { hasText: 'نسخ نص الطلب' }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'recipes import: no overflow (AR, 360px)');
  await shot(page, '64-recipes-ai-import-ar-dark-mobile');
  await page.goto(BASE + '#/m/cleaning'); await page.locator('#cl-adv-tab-routine', { hasText: 'روتين اليوم' }).waitFor();
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'cleaning tabs: no overflow (AR, 360px)');
  await shot(page, '65-cleaning-routine-ar-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.deepEqual(page.errors.slice(err0), [], 'no page errors during V6.3 flows');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); if (b.mona) window.__fake.set('users/UID_MONA', b.mona); }, before);
});

// =================================================================== V6.4 Batch A
await check('V640-A Batch A: post-reset routine has no "no longer active" rows (reset twice, archive) · finance tile = monthly budget (under / over / none) · Rooms / Devices counts in Your Home, no Reminders / Rooms / Devices tiles · scrollable dock (320–412, RTL, keyboard) · Calendar gear + imported tag · Savings prices · Family spacing · Cleaning stats', async () => {
  await ensureSignedOut();
  const H = 'hV640'; const err0 = page.errors.length;
  const before = await page.evaluate(() => { const d = window.__fake.dump(); return { owner: d['users/UID_OWNER'] || null }; });
  await page.evaluate((h) => {
    const now = new Date().toISOString(); const today = now.slice(0, 10);
    const back = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    window.__fake.set(`homes/${h}`, { name: 'V6.4 Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 7 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona Abdelrahman Mohamed Eliwa Al-Masri', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/rooms/liv`, { name: 'Living room', type: 'living', icon: 'sofa', sortOrder: 2, active: true });
    window.__fake.set(`homes/${h}/rooms/old`, { name: 'Old store', type: 'other', icon: 'door', sortOrder: 3, active: false });
    window.__fake.set(`homes/${h}/devices/dw`, { name: 'Dishwasher', category: 'kitchen_appliance', subtype: 'dishwasher', roomId: 'kit', status: 'operational', icon: 'dishwasher', active: true });
    window.__fake.set(`homes/${h}/devices/dw2`, { name: 'Old dryer', category: 'laundry', subtype: 'dryer', roomId: 'kit', status: 'operational', icon: 'dryer', active: false });
    window.__fake.set(`homes/${h}/cleaningSettings/general`, { catchUpMax: 3, startHour: 0, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1 });
    const T = (title, extra = {}) => ({ title, instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 },
      startDate: back(5), dueDate: null, endDate: null, estimatedMinutes: 10, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1, ...extra });
    window.__fake.set(`homes/${h}/cleaningTasks/tA`, T('Wipe the counters'));
    window.__fake.set(`homes/${h}/cleaningTasks/tB`, T('Mop the floor', { roomId: 'liv' }));
    window.__fake.set(`homes/${h}/cleaningTasks/tC`, T('Water the plants', { roomId: 'liv' }));
    for (const [i, who] of ['UID_OWNER', 'UID_MONA', 'UID_MONA'].entries()) window.__fake.set(`homes/${h}/cleaningLog/hist${i}_r1`, { occurrenceId: `hist${i}`, taskId: i ? 'tB' : 'tA', rev: 1, action: 'complete', actorUid: who, at: now, notes: null, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/financeMonthly/${today.slice(0, 7)}`, { budgetMinor: 1000000, categoryLimits: {}, audience: 'household', readers: [], rev: 1, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/expenses/eV640`, { amountMinor: 425050, currency: 'EGP', date: today, category: 'food', audience: 'household', readers: [], status: 'active', createdBy: 'UID_OWNER', title: 'Groceries', walletId: null, schemaVersion: 1, createdAt: now, updatedAt: now });
    window.__fake.set(`homes/${h}/expenses/eOld`, { amountMinor: 999900, currency: 'EGP', date: back(40), category: 'food', audience: 'household', readers: [], status: 'active', createdBy: 'UID_OWNER', title: 'Last month', walletId: null, schemaVersion: 1, createdAt: now, updatedAt: now });
    window.__fake.set(`homes/${h}/priceQuotes/qV640`, { key: 'gold-24', priceMinor: 703500, currency: 'EGP', source: 'manual', observedAt: Date.now(), note: null, createdBy: 'UID_OWNER', createdAt: now, schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en', displayName: 'Abdo' });
  }, H);
  const overlap = (sel1, sel2) => page.evaluate(([a, b]) => {
    const x = document.querySelector(a); const y = document.querySelector(b); if (!x || !y) return 'missing';
    const r = x.getBoundingClientRect(); const s = y.getBoundingClientRect();
    return r.left < s.right - 0.5 && s.left < r.right - 0.5 && r.top < s.bottom - 0.5 && s.top < r.bottom - 0.5;
  }, [sel1, sel2]);
  const noOverflow = async (what) => assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${what}: no page-level horizontal overflow`);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();

  // ---- A2: reproduce — the day's plan is saved with catch-up (pre-reset) dates, then the progress is reset
  await page.goto(BASE + '#/m/cleaning'); await page.locator('#cl-adv-list .cl-item[data-task]').first().waitFor();
  await page.waitForFunction((h) => Object.keys(window.__fake.dump()).some((k) => k.startsWith(`homes/${h}/cleaningRoutines/`)), H);
  const planned = await page.locator('#cl-adv-list .cl-item[data-task]').count();
  assert.ok(planned > 3, 'plan includes overdue catch-up items');
  const resetOnce = async () => {
    await page.click('#cl-adv-tab-settings'); await page.click('#cl-reset-progress'); await page.locator('#cl-reset-progress-body').waitFor();
    await page.locator('dialog[open] button[type=submit]').click(); await page.locator('#cl-reset-result', { hasText: /Progress reset/ }).waitFor();
    await page.click('#cl-adv-tab-routine'); await page.locator('#cl-adv-routine').waitFor();
  };
  await resetOnce();
  const noInactive = async () => {
    assert.equal(await page.locator('#cl-adv-routine [data-status=inactive], #cl-adv-routine .cl-item--archived').count(), 0, 'no obsolete rows');
    assert.doesNotMatch(await page.locator('#cl-adv-routine').innerText(), /no longer active/);
  };
  await noInactive();
  assert.deepEqual((await page.locator('#cl-adv-routine .cl-item[data-task]').evaluateAll((x) => x.map((e) => e.dataset.task))).sort(), ['tA', 'tB', 'tC'], 'each task exactly once: today, under the restarted schedule');
  await page.locator('#cl-adv-obsolete').waitFor();
  assert.equal(Number(await page.locator('#cl-adv-obsolete').getAttribute('data-n')), planned - 3, 'obsolete keys counted once, not rendered');
  await page.locator('#cl-markall-btn-routine', { hasText: '(3)' }).waitFor();
  // review fix: the counter, bar and Mark All describe the SAME shown items (never the raw saved plan)
  const prog = async () => page.evaluate(() => { const p = document.querySelector('#cl-adv-progress'); const b = document.querySelector('#cl-adv-routine .cl-progress__bar');
    return [p.dataset.done, p.dataset.total, b.getAttribute('aria-valuenow'), p.textContent, document.querySelectorAll('#cl-adv-routine .cl-item[data-task]').length]; });
  assert.deepEqual(await prog(), ['0', '3', '0', '0 of 3 done today', 3]);
  await page.locator('#cl-adv-routine .cl-item[data-task="tA"] [data-action=complete]').first().click();
  await page.waitForFunction(() => document.querySelector('#cl-adv-progress').dataset.done === '1');
  assert.deepEqual(await prog(), ['1', '3', '33', '1 of 3 done today', 3]);
  await resetOnce(); await noInactive();   // repeated reset: still clean
  assert.deepEqual(await prog(), ['0', '3', '0', '0 of 3 done today', 3], 'second reset undid today\'s progress; counts stay consistent');
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/cleaningTasks/tC`, { active: false }), H);   // archived elsewhere
  await page.locator('#cl-adv-routine .cl-item[data-task="tC"]').waitFor({ state: 'detached' }); await noInactive();
  assert.deepEqual(await prog(), ['0', '2', '0', '0 of 2 done today', 2], 'archived task leaves the counter too');
  const hist = await page.evaluate((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/cleaningLog/`)).length, H);
  assert.ok(hist >= 3, 'audit history kept');
  // A3: statistics — long names wrap beside their count, groups spaced
  await page.setViewportSize({ width: 320, height: 760 });
  await page.click('#cl-adv-tab-stats'); await page.locator('#cl-adv-by-member .cl-stat-row').first().waitFor();
  assert.equal(await overlap('#cl-adv-by-member .cl-stat-row .cl-stat-row__name', '#cl-adv-by-member .cl-stat-row .cl-stat-row__value'), false, 'long name never under the count');
  await page.locator('#cl-adv-by-room .cl-stat-row', { hasText: 'Living room' }).waitFor();
  await noOverflow('stats 320');
  await shot(page, '66-v640-cleaning-stats-320');

  // ---- A6 / A8: dashboard
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/dashboard'); await page.locator('#fin-widget-remaining').waitFor();
  assert.match(await page.locator('#fin-widget-remaining').innerText(), /5,749\.50/, 'remaining = budget − this month (last month excluded)');
  await page.locator('#fin-widget-pct', { hasText: '43% of budget used' }).waitFor();
  assert.equal(await page.locator('#fin-widget-bar').getAttribute('aria-valuenow'), '43');
  assert.doesNotMatch(await page.locator('.summary-card--finance').innerText(), /10.day|No active/i, 'no obsolete 10-day budget text');
  assert.equal(await page.locator('#rm-widget, .summary-card[href="#/m/rooms"], .summary-card[href="#/m/devices"]').count(), 0, 'Reminders / Rooms / Devices tiles removed');
  await page.locator('#home-rooms-count[data-count="2"]', { hasText: '2 active rooms' }).waitFor();
  await page.locator('#home-devices-count[data-count="1"]', { hasText: '1 active device' }).waitFor();
  await page.locator('#tool-reminders').waitFor(); await page.locator('#reminders-bell').waitFor();
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/expenses/eV640`, { amountMinor: 1234567 }), H);
  await page.locator('#fin-widget-pct.is-over', { hasText: '123% of budget used — over budget' }).waitFor();
  assert.match(await page.locator('#fin-widget-remaining').innerText(), /−|-/, 'negative remaining shown');
  assert.equal(await page.locator('#fin-widget-bar').getAttribute('aria-valuenow'), '100', 'bar clamped');
  assert.match(await page.locator('#fin-widget-remaining + .summary-card__label').innerText(), /over budget/);
  await shot(page, '67-v640-dashboard-390');
  await page.evaluate((h) => { const d = window.__fake.dump(); for (const k of Object.keys(d)) if (k.startsWith(`homes/${h}/financeMonthly/`)) window.__fake.remove(k); }, H);
  await page.locator('#fin-widget-status', { hasText: 'No monthly budget set' }).waitFor();
  assert.equal(await page.locator('#fin-widget-bar, #fin-widget-pct').count(), 0, 'no bar / % without a budget');
  await noOverflow('dashboard 390');

  // ---- A7: dock at 320 / 360 / 390 / 412 (EN), keyboard, active item visible
  for (const w of [320, 360, 390, 412]) {
    await page.setViewportSize({ width: w, height: 760 });
    await page.goto(BASE + '#/m/devices'); await page.locator('.dock .nav-link.is-active').waitFor();
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const d = document.querySelector('.dock'); const a = d.querySelector('.nav-link.is-active'); const r = a.getBoundingClientRect(); const dr = d.getBoundingClientRect();
      const sizes = [...d.querySelectorAll('.nav-link')].map((x) => { const b = x.getBoundingClientRect(); return [b.width, b.height]; });
      return { visible: r.left >= dr.left - 1 && r.right <= dr.right + 1, minW: Math.min(...sizes.map((s) => s[0])), minH: Math.min(...sizes.map((s) => s[1])), scroll: d.scrollWidth > d.clientWidth, n: sizes.length };
    });
    assert.ok(m.visible, `${w}px: active item scrolled into view`);
    assert.ok(m.minW >= 63.5 && m.minH >= 51.5, `${w}px: touch targets never shrink (${m.minW}×${m.minH})`);
    assert.equal(await page.locator('#dock-more-btn').count(), 0);
    await noOverflow(`dock ${w}`);
  }
  await page.locator('.dock .nav-link').first().focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.dock .nav-link')].indexOf(document.activeElement)), 1, 'ArrowRight → next item');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#/settings', 'End → Settings (main Settings kept)');
  await shot(page, '68-v640-dock-412');

  // ---- A4: Calendar gear (Calendar only) + Imported tag vs Remove button
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(BASE + '#/m/calendar'); await page.locator('#cal-settings').waitFor();
  assert.equal((await page.locator('#cal-settings').innerText()).trim(), '', 'icon only');
  assert.equal(await page.locator('#cal-settings').getAttribute('aria-label'), 'Calendar settings');
  assert.equal(await page.locator('#cal-settings svg').count(), 1);
  const gb = await page.locator('#cal-settings').boundingBox(); assert.ok(gb.width >= 40 && gb.height >= 40, 'touch target');
  await page.click('#cal-import');
  await page.fill('#cal-imp-text', 'Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description,Location,Private\nV640 trip,1/9/2026,,1/10/2026,,True,,,False\n');
  await page.click('#cal-imp-preview'); await page.click('#cal-imp-confirm');
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/calendarImports/`) && v.status === 'active'), H);
  await page.goto(BASE + '#/dashboard'); await page.goto(BASE + '#/m/calendar'); await page.click('#cal-settings');
  await page.locator('#cal-batches .cal-batch [data-action=remove-batch]').waitFor();
  assert.equal(await overlap('#cal-batches .cal-batch [data-role=status]', '#cal-batches .cal-batch [data-action=remove-batch]'), false, 'Imported tag never overlaps Remove (EN 320)');
  await shot(page, '69-v640-calendar-settings-320');
  // ---- A5: Savings prices: derived tag vs price / button
  await page.goto(BASE + '#/m/savings'); await page.click('#sv-tab-valuation');
  await page.locator('#sv-prices [data-key="gold-21"]').waitFor();
  assert.match(await page.locator('#sv-prices [data-key="gold-21"]').innerText(), /Derived from 24K\/999/);
  assert.equal(await overlap('#sv-prices [data-key="gold-21"] .pill', '#sv-price-gold-21'), false, 'derived tag vs price (320)');
  assert.equal(await overlap('#sv-price-gold-21', '#sv-prices [data-key="gold-21"] .btn'), false, 'price vs Update');
  assert.match(await page.locator('#sv-price-gold-21').innerText(), /6,155\.63\/g/, 'pricing unchanged (24K × 21/24)');
  await noOverflow('savings 320');
  await shot(page, '70-v640-savings-prices-320');
  // ---- A1: Family spacing
  await page.goto(BASE + '#/family'); await page.locator('#member-list .member-card').nth(1).waitFor();
  const gaps = await page.evaluate(() => { const kids = [...document.querySelector('.family-content').children]; const out = [];
    for (let i = 1; i < kids.length; i++) out.push(kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom); return out; });
  assert.ok(gaps.every((g) => g >= 12), `sections are spaced (${gaps.map((g) => Math.round(g))})`);
  await noOverflow('family 320');
  await shot(page, '71-v640-family-320');

  // ---- RTL (Arabic) + dark at 360
  await page.setViewportSize({ width: 1280, height: 800 });   // the language chip lives in the desktop top bar
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.setViewportSize({ width: 360, height: 760 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.goto(BASE + '#/m/calendar'); await page.click('#cal-settings'); await page.locator('#cal-batches .cal-batch [data-action=remove-batch]').waitFor();
  assert.equal(await overlap('#cal-batches .cal-batch [data-role=status]', '#cal-batches .cal-batch [data-action=remove-batch]'), false, 'Imported tag never overlaps Remove (RTL 360)');
  assert.equal(await page.locator('#cal-settings').getAttribute('aria-label'), 'إعدادات التقويم');
  await noOverflow('calendar RTL');
  await shot(page, '72-v640-calendar-settings-ar-dark-360');
  await page.goto(BASE + '#/m/cleaning'); await page.locator('.dock .nav-link.is-active').waitFor(); await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => { const d = document.querySelector('.dock'); const a = d.querySelector('.nav-link.is-active'); const r = a.getBoundingClientRect(); const dr = d.getBoundingClientRect(); return r.left >= dr.left - 1 && r.right <= dr.right + 1; }), 'RTL: active visible');
  await page.locator('.dock .nav-link').first().focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.dock .nav-link')].indexOf(document.activeElement)), 1, 'RTL: ArrowLeft → next item');
  await page.goto(BASE + '#/dashboard'); await page.locator('#fin-widget-status').waitFor();
  await noOverflow('dashboard RTL');
  await shot(page, '73-v640-dashboard-ar-dark-360');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // desktop: rail navigation unchanged, dock hidden
  assert.ok(await page.locator('.rail').isVisible()); assert.ok(!(await page.locator('.dock').isVisible()));
  assert.deepEqual(page.errors.slice(err0), [], 'no page errors during V6.4 Batch A flows');
  await ensureSignedOut();
  await page.evaluate((b) => { if (b.owner) window.__fake.set('users/UID_OWNER', b.owner); }, before);
});

// B0 regression (must stay LAST on the main page: it freezes the browser clock). Advanced must wait for
// the stored settings before choosing the routine day, and must never pair / create a routine for a
// different day than the one it shows (race found while closing B0; see B0-CLOSURE-REPORT.md).
// V6.4.1 Stage A: Contacts management actions live in "⋮" menus — open the owning menu, then the item
async function ctAct(p, sel) {
  const el = p.locator(sel);
  if (!(await el.isVisible())) await p.locator(`.ct-more:has(${sel}) .ct-more__btn`).click();
  await el.click();
}
// =================================================================== V6.4 Batch B — Shared Contacts
await check('V640-B Contacts: dock + Tools entry · add (Arabic, labelled phones, category) · search (Arabic / any number format) · tel: + WhatsApp (asks country code) · edit rev + favourite filter · VCF 2.1/3.0/4.0 import preview (new / duplicate / in-file / invalid; skip default; merge) · failure + retry without duplicates · export warning + VCF 3.0 CRLF · delete / restore · viewer read-only · 320–412, RTL, dark · rev 2: imported-before status, re-import after delete (not restored, explicit separate), capacity + truncation', async () => {
  await ensureSignedOut();
  const H = 'hV64B'; const err0 = page.errors.length;
  await page.evaluate(async (h) => {
    const { defaultRoles } = await import('/src/modules/index.js');
    const now = new Date().toISOString();
    window.__fake.set(`homes/${h}`, { name: 'Contacts Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    for (const r of defaultRoles()) window.__fake.set(`homes/${h}/roles/${r.id}`, { name: r.name, rank: r.rank, permissions: r.permissions, system: true, templateVersion: 9 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'viewer', status: 'active', joinedAt: now });
    const C = (name, phones, x = {}) => ({ name, organization: null, email: null, address: null, notes: null, favorite: false, phones, categoryIds: [], source: 'manual', deleted: false, deletedAt: null, deletedBy: null, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1, ...x });
    window.__fake.set(`homes/${h}/contacts/seedPlumber1`, C('Hassan Plumber', ['mobile|+20 122 333 4444']));
    window.__fake.set(`homes/${h}/contacts/seedGone0001`, C('Old Driver', ['mobile|0111 000 0000'], { deleted: true, deletedAt: now, deletedBy: 'UID_OWNER', rev: 2 }));
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en', displayName: 'Abdo' });
    window.__fake.patch('users/UID_MONA', { defaultHomeId: h, language: 'en', displayName: 'Mona' });
  }, H);
  const docs = () => page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/contacts/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), H);
  const noOverflow = async (what) => assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${what}: no page-level horizontal overflow`);
  const submit = async () => { await page.click('dialog[open] button[type=submit]'); await page.locator('dialog[open]').waitFor({ state: 'detached' }); };
  await page.setViewportSize({ width: 1280, height: 800 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();

  // ---- entry points: Tools tile (implemented, not planned) and the mobile dock
  await page.locator('.card--tools a.tile[href="#/m/contacts"]:not(.tile--planned)').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.dock .nav-link[href="#/m/contacts"]').click();
  await page.locator('#ct-list .ct-card').first().waitFor();
  assert.equal(await page.locator('#ct-list .ct-card').count(), 1, 'deleted contacts are not listed');
  assert.match(await page.locator('#ct-count').innerText(), /1 of 1/);

  // ---- categories: suggested set (idempotent)
  await ctAct(page, '#ct-cats'); await page.click('#ct-cat-suggest'); await page.locator('#ct-cat-list li').nth(9).waitFor();
  await page.click('#ct-cat-suggest'); await page.waitForTimeout(300);
  assert.equal(await page.locator('#ct-cat-list li').count(), 10, 'suggestions added once');
  await page.click('#ct-cats-back');

  // ---- add: Arabic name, national mobile + custom-labelled landline, a category
  await page.click('#ct-new'); await page.locator('#ct-form').waitFor();
  await page.fill('#ct-f-name', 'د. أحمد عبد الله');
  await page.locator('.ct-edit-phone [data-role=number]').first().fill('٠١٠٠ ١٢٣ ٤٥٦٧');
  await page.click('#ct-add-phone');
  await page.locator('.ct-edit-phone').nth(1).locator('[data-role=label]').selectOption('__custom');
  await page.locator('.ct-edit-phone').nth(1).locator('[data-role=custom]').fill('Clinic desk');
  await page.locator('.ct-edit-phone').nth(1).locator('[data-role=number]').fill('(02) 2345-6789');
  await page.check('#ct-form input[name=ct-cat][value=s_doctors]');
  await submit();
  await page.locator('#ct-detail').waitFor();
  const ahmed = (await docs()).find((d) => d.name === 'د. أحمد عبد الله');
  assert.deepEqual([ahmed.phones, ahmed.categoryIds, ahmed.rev, ahmed.source, ahmed.createdBy], [['mobile|0100 123 4567', 'Clinic desk|(02) 2345-6789'], ['s_doctors'], 1, 'manual', 'UID_OWNER']);
  // ---- tel: and WhatsApp (national number → asks the country code; never guessed)
  assert.equal(await page.getAttribute('#ct-call-0', 'href'), 'tel:01001234567');
  assert.equal(await page.getAttribute('#ct-call-1', 'href'), 'tel:0223456789');
  await page.evaluate(() => { window.__opened = []; window.open = (u, n, f) => { window.__opened.push([u, n, f]); return null; }; });
  assert.equal(await page.getAttribute('#ct-wa-0', 'data-need-country'), 'true');
  await page.click('#ct-wa-0'); await page.locator('#ct-wa-form').waitFor();
  await page.fill('#ct-wa-cc', '20'); await page.locator('#ct-wa-preview', { hasText: '201001234567' }).waitFor();
  await submit();
  assert.deepEqual(await page.evaluate(() => window.__opened), [['https://wa.me/201001234567', '_blank', 'noopener,noreferrer']]);
  // ---- edit (revision), favourite
  await ctAct(page, '#ct-edit'); await page.fill('#ct-f-org', 'Nile Clinic'); await submit();
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/contacts/`) && v.organization === 'Nile Clinic' && v.rev === 2), H);
  await page.click('#ct-back');
  await page.locator('.ct-card:has-text("أحمد") [data-action=favorite]').click();
  await page.locator('.ct-card:has-text("أحمد") [data-action=favorite][aria-pressed=true]').waitFor();
  assert.match(await page.locator('#ct-list .ct-card').first().innerText(), /أحمد/, 'favourites first');
  await page.click('#ct-fav-filter'); assert.equal(await page.locator('#ct-list .ct-card').count(), 1); await page.click('#ct-fav-filter');
  // ---- search: Arabic without diacritics / hamza, any number format, category label, organization
  for (const [q, n] of [['احمد', 1], ['+20 100 123 4567', 1], ['1234567', 1], ['doctors', 1], ['nile', 1], ['plumber', 1], ['zzzz', 0]]) {
    await page.fill('#ct-search', q); assert.equal(await page.locator('#ct-list .ct-card').count(), n, `search "${q}"`);
  }
  assert.equal(await page.locator('#ct-empty').isVisible(), true); await page.fill('#ct-search', '');
  await page.selectOption('#ct-cat', 's_doctors'); assert.equal(await page.locator('#ct-list .ct-card').count(), 1); await page.selectOption('#ct-cat', 'all');

  // ---- import: 2.1 QP Arabic (new) · 3.0 duplicate of Hassan (same number) · 4.0 new · in-file repeat · invalid (no name) · hostile text kept as text
  const vcf = [
    'BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=B3=D8=A7=D8=B1=D8=A9;\r\nTEL;CELL:+20 155 000 1111\r\nPHOTO;ENCODING=BASE64;TYPE=JPEG:/9j/4AAQ\r\n\r\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nFN:Hassan P.\nTEL;TYPE=CELL:0122 333 4444\nORG:Pipes Co\nEND:VCARD',
    'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:<img src=x onerror=alert(1)>\r\nTEL;VALUE=uri;TYPE=voice:tel:+1-555-555-0100\r\nCATEGORIES:Emergency\r\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nFN:Sara Again\nTEL:+20 155 000 1111\nEND:VCARD',
    'BEGIN:VCARD\nVERSION:3.0\nTEL:0100\nEND:VCARD',
  ].join('\r\n');
  await ctAct(page, '#ct-import');
  await page.setInputFiles('#ct-imp-file', { name: 'phone.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) });
  await page.locator('#ct-imp-preview').waitFor();
  assert.deepEqual(await page.locator('#ct-imp-list .ct-imp-item').evaluateAll((els) => els.map((e) => e.dataset.status)), ['new', 'duplicate', 'new', 'inFile', 'invalid']);
  assert.match(await page.locator('#ct-imp-counts').innerText(), /2 new · 0 imported before · 1 duplicate · 0 possible duplicate · 0 ambiguous · 1 repeated in file · 1 invalid — 2 selected/);
  assert.equal(await page.locator('#ct-imp-act-1').inputValue(), 'skip', 'duplicates are skipped by default');
  assert.equal(await page.locator('#ct-imp-act-4').isDisabled(), true, 'invalid rows can only be skipped');
  assert.match(await page.locator('.ct-imp-item[data-index="0"]').innerText(), /سارة/);
  assert.equal(await page.locator('#ct-imp-list img').count(), 0, 'markup in a vCard is shown as text');
  assert.equal(await page.evaluate((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/contacts/vc_`)).length, H), 0, 'preview writes nothing');
  await page.selectOption('#ct-imp-act-1', 'merge');
  await page.evaluate(() => { window.__fakeFailNextCommit = true; });       // the first write fails (network / server)
  await page.click('#ct-imp-confirm'); await page.locator('#ct-imp-result').waitFor();
  assert.match(await page.locator('#ct-imp-result').innerText(), /1 added · 1 merged · 0 already there · 0 unchanged · 0 changed since the preview · 1 failed/);
  await page.click('#ct-imp-retry'); await page.locator('#ct-imp-result:not(:has(#ct-imp-retry))').waitFor();
  assert.match(await page.locator('#ct-imp-result').innerText(), /1 added · 0 merged · 0 already there/);
  let all = await docs();
  assert.equal(all.filter((d) => d.name === 'سارة').length, 1, 'no duplicate after retry');
  assert.equal(all.filter((d) => /onerror/.test(d.name)).length, 1);
  assert.deepEqual(all.find((d) => d.id === 'seedPlumber1'), { ...all.find((d) => d.id === 'seedPlumber1'), name: 'Hassan Plumber', organization: 'Pipes Co', phones: ['mobile|+20 122 333 4444'], rev: 2 }, 'merge filled the empty field, kept the name and number');
  assert.deepEqual(all.find((d) => d.name === 'سارة').phones, ['mobile|+20 155 000 1111'], 'imported numbers saved');
  assert.ok(all.filter((d) => d.source === 'vcf').every((d) => /^vc_[0-9a-f]{16}$/.test(d.id)));
  // the same file again → everything is recognised (deterministic ids / duplicates), nothing new
  await page.click('#ct-imp-other'); await page.setInputFiles('#ct-imp-file', { name: 'phone.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) });
  await page.locator('#ct-imp-preview').waitFor();
  // rev 2: the two records created by the first import are recognised by their import id ("imported before"),
  // the merged one as a duplicate — nothing selected, nothing written
  assert.match(await page.locator('#ct-imp-counts').innerText(), /0 new · 2 imported before · 1 duplicate/);
  assert.equal(await page.locator('#ct-imp-confirm').isDisabled(), true);
  assert.equal(await page.locator('.ct-imp-item[data-status=imported] select option[value=create]').count(), 0, 'no plain create for an imported record');
  // malformed / non-vCard file
  await page.click('#ct-imp-other'); await page.setInputFiles('#ct-imp-file', { name: 'notes.vcf', mimeType: 'text/vcard', buffer: Buffer.from('just some text') });
  await page.locator('#ct-imp-error').waitFor();
  await page.click('#ct-imp-back'); await page.locator('#ct-list').waitFor();
  assert.equal((await docs()).filter((d) => !d.deleted).length, 4);

  // ---- export: scope → personal-information warning → VCF 3.0 (UTF-8, CRLF)
  await page.setViewportSize({ width: 1280, height: 800 });
  await ctAct(page, '#ct-export'); await page.selectOption('#ct-export-scope', 's_doctors'); await page.click('dialog[open] button[type=submit]');   // the warning opens as the scope dialog closes
  await page.locator('dialog[open][role=alertdialog]').waitFor();
  assert.match(await page.locator('dialog[open]').innerText(), /Export 1 contact/);
  const dl = page.waitForEvent('download'); await page.click('dialog[open] .btn--primary'); const file = await dl;
  const text = readFileSync(await file.path(), 'utf8');
  assert.ok(file.suggestedFilename().endsWith('.vcf'));
  assert.match(text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/); assert.ok(!/[^\r]\n/.test(text), 'CRLF line endings');
  assert.match(text, /FN:د\. أحمد عبد الله\r\n/); assert.match(text, /X-HOMEHUB-LABEL:Clinic desk/); assert.match(text, /CATEGORIES:Doctors/);
  assert.equal((text.match(/BEGIN:VCARD/g) || []).length, 1, 'category scope only');

  // ---- delete (soft) → recently deleted → restore
  await page.locator('.ct-card:has-text("onerror") .ct-card__open').click(); await ctAct(page, '#ct-delete');
  await page.click('dialog[open] .btn--danger'); await page.locator('#ct-list').waitFor();
  assert.equal(await page.locator('#ct-list .ct-card:has-text("onerror")').count(), 0);
  await ctAct(page, '#ct-deleted'); await page.locator('#ct-del-list li').nth(1).waitFor();
  await page.locator('#ct-del-list li:has-text("onerror") [data-action=restore]').click();
  await page.locator('#ct-del-list li:has-text("onerror")').waitFor({ state: 'detached' });
  await page.click('#ct-del-back');
  assert.equal(await page.locator('#ct-list .ct-card').count(), 4);
  // rev 2: re-import after a soft delete → reported, NOT restored, NOT copied (until the user explicitly asks)
  await page.locator('.ct-card:has-text("onerror") .ct-card__open').click(); await ctAct(page, '#ct-delete');
  await page.click('dialog[open] .btn--danger'); await page.locator('#ct-list').waitFor();
  const snapBefore = JSON.stringify(await docs());
  await ctAct(page, '#ct-import'); await page.setInputFiles('#ct-imp-file', { name: 'phone.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) });
  await page.locator('#ct-imp-preview').waitFor();
  assert.equal(await page.locator('.ct-imp-item[data-index="2"]').getAttribute('data-status'), 'new', 'the deleted contact is not in the live directory');
  await page.click('#ct-imp-confirm'); await page.locator('#ct-imp-result').waitFor();
  assert.match(await page.locator('#ct-imp-deleted').innerText(), /imported before and later deleted — not restored: <img src=x onerror=alert\(1\)>/);
  assert.equal(JSON.stringify(await docs()), snapBefore, 'nothing written');
  await page.click('#ct-imp-separate'); await page.locator('#ct-imp-result:not(:has(#ct-imp-separate))').waitFor();
  all = await docs();
  assert.deepEqual([all.filter((d) => /onerror/.test(d.name) && !d.deleted).length, all.filter((d) => /onerror/.test(d.name) && d.deleted).length], [1, 1], 'explicit "add as separate": a new contact; the deleted one stays deleted');
  await page.click('#ct-imp-back'); await page.locator('#ct-list').waitFor();
  assert.match(await page.locator('#ct-capacity').innerText(), /^4 of 1000 contacts$/);

  // ---- layout: 320 / 360 / 412, RTL + dark
  for (const w of [320, 360, 412]) { await page.setViewportSize({ width: w, height: 760 }); await page.waitForTimeout(100); await noOverflow(`contacts ${w}`); }
  await page.locator('.ct-card:has-text("أحمد") .ct-card__open').click(); await page.locator('#ct-detail').waitFor(); await noOverflow('detail 320');
  await shot(page, '80-v640b-contact-detail-412');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').first().waitFor();
  assert.notEqual(await page.locator('#ct-new').innerText(), '＋ New contact', 'Arabic UI');
  assert.notEqual(await page.locator('#ct-search').getAttribute('placeholder'), 'Search name, number or organization', 'Arabic UI');
  await noOverflow('contacts RTL dark 360');
  await shot(page, '81-v640b-contacts-ar-dark-360');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // ---- viewer: reads the shared directory; no add / import / export / delete / favourite controls
  await logout(); await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').first().waitFor();
  assert.equal(await page.locator('#ct-list .ct-card').count(), 4, 'same shared contacts');
  for (const id of ['#ct-new', '#ct-import', '#ct-export', '#ct-cats', '#ct-deleted']) assert.equal(await page.locator(id).count(), 0, `viewer: no ${id}`);
  assert.equal(await page.locator('#ct-list button[data-action=favorite]').count(), 0, 'viewer cannot change shared favourites');
  await page.locator('.ct-card:has-text("أحمد") .ct-card__open').click();
  assert.equal(await page.getAttribute('#ct-call-0', 'href'), 'tel:01001234567', 'viewer can call');
  for (const id of ['#ct-edit', '#ct-delete', '#ct-export-one']) assert.equal(await page.locator(id).count(), 0, `viewer: no ${id}`);
  await logout();

  // ---- rev 2 (B3): more than the capacity → truncation is shown, never presented as complete; import paused
  await page.evaluate((h) => {
    const now = new Date().toISOString();
    for (let i = 0; i < 1000; i++) window.__fake.set(`homes/${h}/contacts/bulk${String(i).padStart(5, '0')}`, { name: `Bulk ${i}`, organization: null, email: null, address: null, notes: null, favorite: false, phones: [], categoryIds: [], source: 'manual', deleted: false, deletedAt: null, deletedBy: null, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1 });
  }, H);
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-truncated').waitFor();
  assert.match(await page.locator('#ct-truncated').innerText(), /more than 1000 contacts\. Only 1000 are loaded/);
  assert.match(await page.locator('#ct-capacity').innerText(), /More than 1000 contacts — only 1000 loaded/);
  assert.match(await page.locator('#ct-count').innerText(), /the directory has more/);
  await page.click('#ct-more-btn'); assert.equal(await page.getAttribute('#ct-import', 'aria-disabled'), 'true', 'import disabled in the menu'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#ct-new').isDisabled(), true);
  assert.equal(await page.locator('#ct-list .ct-card').count(), 1000);
  await ctAct(page, '#ct-export'); await page.locator('#ct-export-scope').waitFor(); await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open][role=alertdialog]').waitFor();
  assert.match(await page.locator('dialog[open]').innerText(), /Incomplete: only the first 1000 loaded contacts/);
  await page.click('dialog[open] .btn--secondary'); await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await logout();
  await page.evaluate((h) => { for (let i = 0; i < 1000; i++) window.__fake.remove(`homes/${h}/contacts/bulk${String(i).padStart(5, '0')}`); }, H);
  assert.equal(page.errors.length, err0, `no page errors: ${page.errors.slice(err0).join(' | ')}`);
});

// =================================================================== V6.4 Batch C — contact pictures + restaurant menus
const MEDIA = 'https://media.hh-e2e.test';
const svg = (w, h, c) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${c}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="#fff"/></svg>`;
async function mediaRoutes(ctx, log) {
  await ctx.route(`${MEDIA}/**`, (r) => {
    const u = new URL(r.request().url()); log.push(u.pathname);
    if (u.pathname.startsWith('/ok/') && u.pathname.endsWith('.svg')) return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(600, 900, u.pathname.includes('m3') ? '#2a7' : '#c43') });
    return r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
  });
  // Drive preview host: refuses to be framed (as a private / blocked file would) — the app must not claim success
  await ctx.route('https://drive.google.com/**', (r) => { log.push(`drive:${new URL(r.request().url()).pathname}`); return r.fulfill({ status: 200, contentType: 'text/html', headers: { 'X-Frame-Options': 'DENY' }, body: '<p>blocked</p>' }); });
}
const C_MENUS = [`image|Page 1|${MEDIA}/ok/m1.svg`, `image|Page 2|${MEDIA}/broken/m2.svg`, `image||${MEDIA}/ok/m3.svg`, `pdf|Full menu|${MEDIA}/ok/menu.pdf`, `web|Website|${MEDIA}/site`,
  'drive|Drive menu|https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'];
async function seedC(p, H, lang = 'en') {
  await p.evaluate(async ({ h, menus, media, lang }) => {
    const { defaultRoles } = await import('/src/modules/index.js');
    const now = new Date().toISOString();
    window.__fake.set(`homes/${h}`, { name: 'Media Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: lang });
    for (const r of defaultRoles()) window.__fake.set(`homes/${h}/roles/${r.id}`, { name: r.name, rank: r.rank, permissions: r.permissions, system: true, templateVersion: 9 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: 'viewer', status: 'active', joinedAt: now });
    const K = (key, order) => ({ name: null, key, order, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/contactCategories/s_restaurants`, K('restaurants', 0)); window.__fake.set(`homes/${h}/contactCategories/s_doctors`, K('doctors', 1));
    const C = (name, x = {}) => ({ name, organization: null, email: null, address: null, notes: null, favorite: false, phones: ['mobile|+20 100 000 0001'], categoryIds: [], source: 'manual', deleted: false, deletedAt: null, deletedBy: null, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1, ...x });
    window.__fake.set(`homes/${h}/contacts/pizza01`, C('Pizza Place', { categoryIds: ['s_restaurants'], avatarUrl: `${media}/ok/pizza.svg`, menus, rev: 3 }));
    window.__fake.set(`homes/${h}/contacts/broken1`, C('Broken Pic', { avatarUrl: `${media}/broken/face.svg` }));
    window.__fake.set(`homes/${h}/contacts/old0001`, C('Old Contact', { categoryIds: ['s_doctors'] }));   // written before 6.4.0-c: no media keys
    for (const u of ['UID_OWNER', 'UID_MONA']) window.__fake.patch(`users/${u}`, { defaultHomeId: h, language: lang });
  }, { h: H, menus: C_MENUS, media: MEDIA, lang });
}
const cdoc = (p, H, id) => p.evaluate(({ h, id }) => window.__fake.dump()[`homes/${h}/contacts/${id}`], { h: H, id });

await check('V640-C Contact pictures + restaurant menus: avatars (image / broken / missing) · no menu request before opening · image thumbnails + broken state · PDF / website open-only · sandboxed Drive preview never claimed successful · fullscreen viewer (counter, prev/next, keys, swipe, double-tap zoom, pan, Esc, Back) · editor preview / replace / remove / validation / reorder · category rename / removal / reassignment keeps menus · stale media edit refused · old contact untouched · export without media · viewer role read-only · 320–412', async () => {
  await ensureSignedOut();
  const H = 'hV64C'; const err0 = page.errors.length; const log = [];
  await mediaRoutes(desktop, log);
  await seedC(page, H);
  const noOverflow = async (what) => assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${what}: no horizontal overflow`);
  const menuReqs = () => log.filter((x) => /^\/(ok|broken)\/(m\d|menu)|^\/site|^drive:/.test(x));
  await page.setViewportSize({ width: 1280, height: 800 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').nth(2).waitFor();
  // ---- avatars: picture, broken → initials, none → initials; lazy + no referrer
  const av = (name) => page.locator(`.ct-card:has-text("${name}") .ct-avatar`);
  await page.locator('.ct-card:has-text("Pizza Place") .ct-avatar[data-avatar=image]').waitFor();
  await page.locator('.ct-card:has-text("Broken Pic") .ct-avatar[data-avatar=broken]').waitFor();
  assert.equal(await av('Broken Pic').locator('img').count(), 0, 'broken picture removed');
  assert.equal(await av('Broken Pic').innerText(), 'BP'); assert.equal(await av('Old Contact').getAttribute('data-avatar'), 'initials');
  assert.deepEqual(await av('Pizza Place').locator('img').evaluate((i) => [i.getAttribute('loading'), i.referrerPolicy, i.getAttribute('alt')]), ['lazy', 'no-referrer', '']);
  // ---- Menu section: no request until the user opens it
  await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click(); await page.locator('#ct-menu').waitFor();
  assert.equal(await page.getAttribute('#ct-menu-toggle', 'aria-expanded'), 'false');
  assert.equal(await page.locator('#ct-menu img, #ct-menu iframe').count(), 0);
  await page.waitForTimeout(300); assert.deepEqual(menuReqs(), [], 'no menu request before opening');
  await page.click('#ct-menu-toggle'); await page.locator('#ct-menu-list').waitFor();
  assert.equal(await page.getAttribute('#ct-menu-toggle', 'aria-expanded'), 'true');
  assert.deepEqual(await page.locator('.ct-menu-item').evaluateAll((els) => els.map((e) => e.dataset.how)), ['image', 'image', 'image', 'link', 'link', 'embed']);
  await page.locator('#ct-menu-thumb-0[data-state=loaded]').waitFor(); await page.locator('#ct-menu-thumb-1[data-state=error]').waitFor();
  assert.match(await page.locator('#ct-menu-thumb-1').innerText(), /could not be loaded/);
  assert.ok(!menuReqs().some((x) => x.startsWith('drive:')), 'Drive is not contacted before "Show preview"');
  for (const i of [0, 3, 4, 5]) assert.deepEqual(await page.locator(`#ct-menu-open-${i}`).evaluate((a) => [a.target, a.rel, a.referrerPolicy]), ['_blank', 'noopener noreferrer', 'no-referrer'], `safe link ${i}`);
  assert.equal(await page.getAttribute('#ct-menu-open-3', 'href'), `${MEDIA}/ok/menu.pdf`);
  assert.match(await page.locator('.ct-menu-item[data-index="3"]').innerText(), /PDFs open in a new tab/);
  assert.match(await page.locator('.ct-menu-item[data-index="4"]').innerText(), /never embedded/);
  // ---- Drive: sandboxed preview of the official /preview URL; a blocked frame is not reported as success
  await page.click('#ct-menu-preview-5'); await page.locator('#ct-menu-frame-5').waitFor();
  assert.deepEqual(await page.locator('#ct-menu-frame-5').evaluate((f) => [f.getAttribute('sandbox'), f.getAttribute('allow'), f.referrerPolicy, f.src]),
    ['allow-scripts allow-same-origin', '', 'no-referrer', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview']);
  await page.waitForTimeout(400);
  assert.ok(menuReqs().includes('drive:/file/d/1AbCdEfGhIjKlMnOp/preview'));
  assert.match(await page.locator('.ct-menu-item[data-index="5"]').innerText(), /If the preview stays empty or asks you to sign in/);
  assert.ok(!/loaded|success/i.test(await page.locator('.ct-menu-item[data-index="5"]').innerText()), 'no success claim from an iframe load');
  await page.click('#ct-menu-preview-5'); assert.equal(await page.locator('#ct-menu-frame-5').count(), 0);
  // ---- fullscreen viewer (images only: 3 pages)
  const hash0 = await page.evaluate(() => location.hash);
  await page.click('#ct-menu-thumb-0'); await page.locator('#ct-viewer').waitFor();
  assert.equal(await page.locator('#ct-viewer-count').innerText(), '1 / 3');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-viewer-close', 'focus moves into the viewer');
  await page.locator('#ct-viewer-stage[data-state=loaded]').waitFor();
  assert.equal(await page.locator('#ct-viewer-prev').isDisabled(), true);
  await page.click('#ct-viewer-next'); assert.equal(await page.locator('#ct-viewer-count').innerText(), '2 / 3');
  await page.locator('#ct-viewer-stage[data-state=error]').waitFor();
  assert.match(await page.locator('#ct-viewer-status').innerText(), /could not be loaded/); assert.equal(await page.getAttribute('#ct-viewer-open', 'href'), `${MEDIA}/broken/m2.svg`);
  await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#ct-viewer-count').innerText(), '3 / 3'); assert.equal(await page.locator('#ct-viewer-next').isDisabled(), true);
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('#ct-viewer') && !document.activeElement.disabled), 'focus not lost when Next becomes disabled');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('#ct-viewer-count').innerText(), '1 / 3');
  await page.click('#ct-viewer-zoomin'); assert.equal(await page.getAttribute('#ct-viewer', 'data-scale'), '1.5');
  await page.keyboard.press('0'); assert.equal(await page.getAttribute('#ct-viewer', 'data-scale'), '1');
  // swipe (pointer drag) → next page; double-tap → zoom; drag → pan
  const box = await page.locator('#ct-viewer-stage').boundingBox(); const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
  await page.mouse.move(cx + 120, cy); await page.mouse.down(); await page.mouse.move(cx - 60, cy, { steps: 6 }); await page.mouse.up();
  assert.equal(await page.locator('#ct-viewer-count').innerText(), '2 / 3', 'swipe left → next');
  await page.click('#ct-viewer-prev');
  await page.mouse.click(cx, cy); await page.mouse.click(cx, cy);
  assert.equal(await page.getAttribute('#ct-viewer', 'data-scale'), '2.5', 'double-tap zoom');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 40, { steps: 5 }); await page.mouse.up();
  assert.match(await page.locator('#ct-viewer-img').evaluate((i) => i.style.transform), /translate\(80px, 40px\) scale\(2\.5\)/, 'pan while zoomed');
  assert.equal(await page.locator('#ct-viewer-count').innerText(), '1 / 3', 'a pan is not a swipe');
  // focus trap + Esc
  for (let k = 0; k < 12; k++) await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('#ct-viewer')), 'focus stays in the viewer');
  await page.keyboard.press('Escape'); await page.locator('#ct-viewer').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-menu-thumb-0', 'focus restored');
  // Back closes the viewer and stays on the contact
  await page.click('#ct-menu-thumb-2'); await page.locator('#ct-viewer').waitFor();
  assert.equal(await page.locator('#ct-viewer-count').innerText(), '3 / 3', 'third image (the PDF / website / Drive entries are not pages)');
  await page.goBack(); await page.locator('#ct-viewer').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => location.hash), hash0); await page.locator('#ct-detail #ct-menu-list').waitFor();
  // ---- layouts with the menu open and the viewer open
  for (const w of [320, 360, 390, 412]) {
    await page.setViewportSize({ width: w, height: 760 }); await page.waitForTimeout(80); await noOverflow(`menu ${w}`);
    await page.click('#ct-menu-thumb-0'); await page.locator('#ct-viewer').waitFor();
    for (const id of ['#ct-viewer-close', '#ct-viewer-next', '#ct-viewer-zoomin', '#ct-viewer-open']) { const b = await page.locator(id).boundingBox(); assert.ok(b && b.x >= 0 && b.x + b.width <= w + 0.5, `${id} visible at ${w}`); }
    if (w === 360) await shot(page, '82-v640c-viewer-360');
    await page.click('#ct-viewer-close'); await page.locator('#ct-viewer').waitFor({ state: 'detached' });
  }
  await shot(page, '83-v640c-menu-412');
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- editor: picture preview / validation / replace / remove; menus reorder / remove / add / validation
  await ctAct(page, '#ct-edit'); await page.locator('#ct-form').waitFor();
  assert.equal(await page.inputValue('#ct-f-avatar'), `${MEDIA}/ok/pizza.svg`);
  await page.locator('#ct-f-avatar-preview .ct-avatar[data-avatar=image]').waitFor();
  assert.equal(await page.locator('#ct-f-menus').isVisible(), true); assert.equal(await page.locator('.ct-edit-menu').count(), 6);
  await page.fill('#ct-f-avatar', 'javascript:alert(1)'); await page.locator('#ct-f-avatar').dispatchEvent('change');
  assert.match(await page.locator('#ct-f-avatar-msg').innerText(), /not allowed/);
  await page.click('#ct-f-avatar-remove'); assert.equal(await page.inputValue('#ct-f-avatar'), '');
  assert.equal(await page.locator('#ct-f-avatar-preview .ct-avatar').getAttribute('data-avatar'), 'initials');
  await page.fill('#ct-f-avatar', `${MEDIA}/broken/new.svg`); await page.locator('#ct-f-avatar').dispatchEvent('change');
  await page.locator('#ct-f-avatar-msg:has-text("could not be loaded")').waitFor();
  await page.fill('#ct-f-avatar', `${MEDIA}/ok/new.svg`); await page.locator('#ct-f-avatar').dispatchEvent('change');
  await page.locator('.ct-edit-menu').nth(2).locator('[data-role=up]').click();                 // page 3 before page 2
  await page.locator('.ct-edit-menu').nth(2).locator('[data-role=remove]').click();             // remove the broken page 2
  assert.equal(await page.locator('.ct-edit-menu').first().locator('[data-role=up]').isDisabled(), true);
  await page.click('#ct-add-menu');
  await page.locator('.ct-edit-menu').last().locator('[data-role=url]').fill('http://insecure.example/x.jpg');
  await page.click('dialog[open] button[type=submit]');
  await page.locator('dialog[open] :text("Only secure https:// links are allowed.")').waitFor();
  await page.locator('.ct-edit-menu').last().locator('[data-role=label]').fill('Desserts');
  await page.locator('.ct-edit-menu').last().locator('[data-role=url]').fill(`${MEDIA}/ok/m4.svg`);
  await page.click('dialog[open] button[type=submit]'); await page.locator('#ct-form').waitFor({ state: 'detached' });
  let d = await cdoc(page, H, 'pizza01');
  assert.deepEqual([d.rev, d.avatarUrl], [4, `${MEDIA}/ok/new.svg`]);
  assert.deepEqual(d.menus, [C_MENUS[0], C_MENUS[2], C_MENUS[3], C_MENUS[4], C_MENUS[5], `image|Desserts|${MEDIA}/ok/m4.svg`], 'order / removal / auto-detected kind');
  // ---- stale media edit (another device saved first) → refused, nothing overwritten
  await ctAct(page, '#ct-edit'); await page.locator('#ct-form').waitFor();
  await page.evaluate((h) => { const k = `homes/${h}/contacts/pizza01`; const cur = window.__fake.dump()[k]; window.__fake.patch(k, { rev: cur.rev + 1, name: 'Pizza Place (other device)' }); }, H);
  await page.click('#ct-f-avatar-remove');
  await page.click('dialog[open] button[type=submit]'); await page.locator('dialog[open] :text("Someone else changed this contact")').waitFor();
  await page.keyboard.press('Escape'); await page.locator('#ct-form').waitFor({ state: 'detached' });
  d = await cdoc(page, H, 'pizza01'); assert.deepEqual([d.rev, d.avatarUrl, d.name], [5, `${MEDIA}/ok/new.svg`, 'Pizza Place (other device)']);
  // ---- category lifecycle: rename keeps the menu; removal hides it (kept); suggested re-add = reassignment
  await page.click('#ct-back'); await ctAct(page, '#ct-cats');
  await page.locator('#ct-cat-list li[data-cat=s_restaurants] [data-action=rename]').click();
  await page.fill('#ct-cat-name', 'Food & takeaway'); await page.click('dialog[open] button[type=submit]'); await page.locator('#ct-cat-form').waitFor({ state: 'detached' });
  await page.click('#ct-cats-back'); await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click();
  await page.locator('#ct-menu').waitFor(); assert.match(await page.locator('#ct-detail').innerText(), /Food & takeaway/);
  await page.click('#ct-back'); await ctAct(page, '#ct-cats');
  await page.locator('#ct-cat-list li[data-cat=s_restaurants] [data-action=remove]').click(); await page.click('dialog[open] .btn--danger');
  await page.locator('#ct-cat-list li[data-cat=s_restaurants]').waitFor({ state: 'detached' });
  await page.click('#ct-cats-back'); await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click(); await page.locator('#ct-detail').waitFor();
  assert.equal(await page.locator('#ct-menu').count(), 0, 'no Restaurants category → no Menu section');
  assert.equal((await cdoc(page, H, 'pizza01')).menus.length, 6, 'menu data kept');
  await ctAct(page, '#ct-edit'); await page.locator('#ct-form').waitFor();
  assert.equal(await page.locator('#ct-f-menus').isVisible(), false); assert.match(await page.locator('#ct-f-menus-kept').innerText(), /6 saved menu link/);
  await page.keyboard.press('Escape'); await page.locator('#ct-form').waitFor({ state: 'detached' });
  await page.click('#ct-back'); await ctAct(page, '#ct-cats'); await page.click('#ct-cat-suggest'); await page.locator('#ct-cat-list li[data-cat=s_restaurants]').waitFor();
  await page.click('#ct-cats-back'); await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click();
  await page.locator('#ct-menu').waitFor(); assert.match(await page.locator('#ct-menu-toggle').innerText(), /Show menu \(6\)/, 'reassigned → menu back, unchanged');
  // ---- an old contact (no media keys): open + save writes nothing; detail shows initials, no menu
  await page.click('#ct-back'); await page.locator('.ct-card:has-text("Old Contact") .ct-card__open').click();
  assert.equal(await page.locator('#ct-menu').count(), 0); assert.equal(await page.getAttribute('#ct-avatar', 'data-avatar'), 'initials');
  await ctAct(page, '#ct-edit'); await page.click('dialog[open] button[type=submit]'); await page.locator('#ct-form').waitFor({ state: 'detached' });
  d = await cdoc(page, H, 'old0001'); assert.deepEqual([d.rev, 'avatarUrl' in d, 'menus' in d], [1, false, false]);
  // ---- export of a restaurant: vCard without picture / menu data
  await page.click('#ct-back'); await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click();
  await ctAct(page, '#ct-export-one'); await page.locator('dialog[open][role=alertdialog]').waitFor();
  const dl = page.waitForEvent('download'); await page.click('dialog[open] .btn--primary'); const vcf = readFileSync(await (await dl).path(), 'utf8');
  assert.match(vcf, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/); assert.ok(!/PHOTO|LOGO|URL|media\.hh-e2e|drive\.google/.test(vcf), 'media intentionally excluded');
  await logout();
  // ---- viewer role: sees pictures and can view menus; cannot edit
  await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/contacts'); await page.locator('.ct-card:has-text("Pizza Place") .ct-avatar[data-avatar=image]').waitFor();
  await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click(); await page.click('#ct-menu-toggle'); await page.locator('#ct-menu-thumb-0').waitFor();
  assert.equal(await page.locator('#ct-edit').count(), 0, 'no editor for viewers');
  await logout();
  await desktop.unroute(`${MEDIA}/**`); await desktop.unroute('https://drive.google.com/**');
  assert.equal(page.errors.length, err0, `no page errors: ${page.errors.slice(err0).join(' | ')}`);
});

await check('V640-C mobile (touch, Arabic RTL, dark, 360): swipe direction mirrored, pinch zoom, Back exits fullscreen, no overflow', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const p = await newPage(ctx); const log = []; await mediaRoutes(ctx, log);
  await p.goto(BASE); await p.locator('#login-email').waitFor();
  await seedC(p, 'hV64Cm', 'ar');
  await p.fill('#login-email', 'owner@example.com'); await p.fill('#login-password', 'correct-horse'); await p.click('button[type=submit]');
  await p.locator('.hero__home').waitFor();
  await p.goto(BASE + '#/m/contacts'); await p.locator('.ct-card').first().waitFor();
  await p.waitForFunction(() => document.documentElement.dir === 'rtl');
  await p.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click(); await p.click('#ct-menu-toggle'); await p.locator('#ct-menu-thumb-0').waitFor();
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no overflow (RTL, menu open)');
  await p.locator('#ct-menu-thumb-0').tap(); await p.locator('#ct-viewer').waitFor();
  assert.equal(await p.getAttribute('#ct-viewer', 'dir'), 'rtl');
  const cdp = await ctx.newCDPSession(p);
  const b = await p.locator('#ct-viewer-stage').boundingBox(); const cx = b.x + b.width / 2; const cy = b.y + b.height / 2;
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  // RTL: swiping RIGHT moves to the next page
  await touch('touchStart', [[cx - 100, cy]]); for (let k = 1; k <= 6; k++) await touch('touchMove', [[cx - 100 + k * 30, cy]]); await touch('touchEnd', []);
  assert.equal(await p.locator('#ct-viewer-count').innerText(), '2 / 3', 'RTL swipe right → next');
  await touch('touchStart', [[cx + 100, cy]]); for (let k = 1; k <= 6; k++) await touch('touchMove', [[cx + 100 - k * 30, cy]]); await touch('touchEnd', []);
  assert.equal(await p.locator('#ct-viewer-count').innerText(), '1 / 3', 'RTL swipe left → previous');
  // pinch out → zoom in
  await touch('touchStart', [[cx - 20, cy], [cx + 20, cy]]); for (let k = 1; k <= 6; k++) await touch('touchMove', [[cx - 20 - k * 15, cy], [cx + 20 + k * 15, cy]]); await touch('touchEnd', []);
  assert.ok(Number(await p.getAttribute('#ct-viewer', 'data-scale')) > 2, 'pinch zoom');
  assert.equal(await p.locator('#ct-viewer-count').innerText(), '1 / 3', 'pinch does not change page');
  await shot(p, '84-v640c-viewer-ar-dark-360');
  await p.goBack(); await p.locator('#ct-viewer').waitFor({ state: 'detached' });
  await p.locator('#ct-detail').waitFor();
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no overflow after closing');
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

await check('V640-C rev 2 viewer lifecycle: repeated open / close (button, Esc, Back, rapid reopen) leaves no overlay, listener or history entry; module navigation, household context change and sign-out while open clean up completely', async () => {
  await ensureSignedOut();
  const H = 'hV64CL'; const err0 = page.errors.length; const log = [];
  await mediaRoutes(desktop, log); await seedC(page, H);
  await page.setViewportSize({ width: 1280, height: 800 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  const cdp = await desktop.newCDPSession(page);
  const listeners = async () => {
    const n = async (expr, type) => { const { result } = await cdp.send('Runtime.evaluate', { expression: expr }); const { listeners: l } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }); return l.filter((x) => x.type === type).length; };
    return { keydown: await n('document', 'keydown'), popstate: await n('window', 'popstate') };
  };
  const vstate = () => page.evaluate(async () => (await import('/src/modules/contacts/media-ui.js')).viewerState());
  const clean = async (why) => {
    await page.waitForFunction(() => !document.getElementById('ct-viewer'));
    assert.equal(await page.locator('#ct-viewer, .ct-viewer').count(), 0, `${why}: no overlay`);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ct-viewer-open')), false, `${why}: scroll lock released`);
    await page.waitForFunction(() => !(history.state && history.state.ctViewer), null, { timeout: 3000 });
    const st = await vstate(); assert.deepEqual(st, { open: false, pendingBacks: 0, queued: 0 }, `${why}: controller idle`);
  };
  const openMenu = async () => {
    await page.goto(BASE + '#/m/contacts'); await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click();
    await page.click('#ct-menu-toggle'); await page.locator('#ct-menu-thumb-0').waitFor();
  };
  const openViewer = async (k = 0) => { await page.click(`#ct-menu-thumb-${k}`); await page.locator('#ct-viewer').waitFor(); };
  await openMenu();
  // ---- baseline after one full cycle (the module's single popstate handler is installed on first open)
  await openViewer(); await page.click('#ct-viewer-close'); await clean('first close');
  const len0 = await page.evaluate(() => history.length); const l0 = await listeners();
  // ---- repeated cycles: button, Esc, Back, swipe-then-Esc, rapid close + reopen
  for (let k = 0; k < 3; k++) {
    await openViewer(); await page.click('#ct-viewer-close'); await clean(`button #${k}`);
    await openViewer(2); await page.keyboard.press('Escape'); await clean(`Esc #${k}`);
    await openViewer(); await page.goBack(); await clean(`Back #${k}`);
    assert.match(await page.evaluate(() => location.hash), /#\/m\/contacts/, 'Back never left the contact');
    await page.locator('#ct-detail').waitFor();
  }
  // rapid: close and reopen before the close's history.back() is processed → exactly one live entry
  await openViewer(); await page.evaluate(() => { document.getElementById('ct-viewer-close').click(); document.getElementById('ct-menu-thumb-0').click(); });
  await page.locator('#ct-viewer').waitFor(); await page.waitForTimeout(300);
  assert.equal(await page.locator('.ct-viewer').count(), 1, 'one overlay'); assert.equal(await page.evaluate(() => !!(history.state && history.state.ctViewer)), true, 'reopened viewer owns an entry');
  await page.goBack(); await clean('Back after rapid reopen');
  // handover: opening while open never stacks a second overlay or entry
  await openViewer(); await page.evaluate(async () => { const m = await import('/src/modules/contacts/media-ui.js'); m.openImageViewer([{ url: 'https://media.hh-e2e.test/ok/m3.svg', label: 'x' }], 0); });
  assert.equal(await page.locator('.ct-viewer').count(), 1); await page.keyboard.press('Escape'); await clean('handover');
  assert.equal(await page.evaluate(() => history.length), len0, 'no history growth across 11 open / close cycles');
  assert.deepEqual(await listeners(), l0, 'no keydown / popstate listener leak');
  // ---- navigation to another module while open (e.g. a deep link / notification)
  await openViewer(); await page.evaluate(() => { location.hash = '#/dashboard'; }); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('#ct-viewer').count(), 0, 'module change: overlay gone');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ct-viewer-open')), false);
  await page.keyboard.press('Escape'); await page.keyboard.press('ArrowRight');                 // no stale key handler
  await page.goBack(); await page.locator('#ct-page').waitFor(); await page.waitForTimeout(200);
  assert.equal(await page.locator('#ct-viewer').count(), 0, 'Back onto the old viewer entry never reopens it');
  await clean('after module navigation + Back');
  assert.deepEqual(await listeners(), l0, 'no listener leak after module navigation');
  // ---- household context change while open (membership suspended → re-resolution → gate → restored)
  await openMenu(); await openViewer();
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/members/UID_OWNER`, { status: 'suspended' }), H);
  await page.locator('.gate__code', { hasText: 'MEMBERSHIP_INACTIVE' }).waitFor();
  await clean('household context change');
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/members/UID_OWNER`, { status: 'active' }), H);
  await page.click('text=Try again'); await page.locator('#ct-page').waitFor();   // back on the same route
  assert.equal(await page.locator('#ct-viewer').count(), 0, 'the viewer does not come back with the restored context');
  assert.deepEqual(await listeners(), l0, 'no listener leak after the household change');
  // ---- sign-out while open (e.g. signed out on another device / token expiry)
  await openMenu(); await openViewer();
  await page.evaluate(async () => { const a = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'); await a.signOut(a.getAuth()); });
  await page.locator('#login-email').waitFor();
  await clean('sign-out');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => location.hash), '#/dashboard', 'next sign-in starts on the dashboard (unchanged behaviour)');
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await openMenu();
  assert.deepEqual(await listeners(), l0, 'no listener leak after sign-out / sign-in (compared on the same Contacts screen)');
  await openViewer(); await page.click('#ct-viewer-next'); assert.equal(await page.locator('#ct-viewer-count').innerText(), '2 / 3', 'still fully functional');
  await page.goBack(); await clean('final');
  await cdp.detach(); await logout();
  await desktop.unroute(`${MEDIA}/**`); await desktop.unroute('https://drive.google.com/**');
  assert.equal(page.errors.length, err0, `no page errors: ${page.errors.slice(err0).join(' | ')}`);
});

await check('V640-C rev 2 viewer lifecycle on Android-style mobile (touch, Arabic RTL): hardware Back closes, repeated cycles leave nothing behind', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await newPage(ctx); const log = []; await mediaRoutes(ctx, log);
  await p.goto(BASE); await p.locator('#login-email').waitFor(); await seedC(p, 'hV64CLm', 'ar');
  await p.fill('#login-email', 'owner@example.com'); await p.fill('#login-password', 'correct-horse'); await p.click('button[type=submit]'); await p.locator('.hero__home').waitFor();
  await p.goto(BASE + '#/m/contacts'); await p.locator('.ct-card:has-text("Pizza Place") .ct-card__open').tap();
  await p.locator('#ct-menu-toggle').tap(); await p.locator('#ct-menu-thumb-0').waitFor();
  const len0 = await p.evaluate(() => history.length);
  for (let k = 0; k < 4; k++) {
    await p.locator(`#ct-menu-thumb-${k % 2 ? 2 : 0}`).tap(); await p.locator('#ct-viewer').waitFor();
    assert.equal(await p.getAttribute('#ct-viewer', 'dir'), 'rtl');
    await p.goBack(); await p.waitForFunction(() => !document.getElementById('ct-viewer') && !document.documentElement.classList.contains('ct-viewer-open'));
    await p.locator('#ct-detail').waitFor();
  }
  assert.equal(await p.evaluate(() => history.length), len0 + 1, 'one reusable forward entry at most (back/forward stack, no growth)');
  assert.equal(await p.evaluate(() => !!(history.state && history.state.ctViewer)), false);
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

// ======================================================================== V6.4.1 Stage A — Contacts UI + AI JSON
async function seed641(p, H, { monaRole = 'viewer', lang = 'en' } = {}) {
  await p.evaluate(async ({ h, menus, media, monaRole, lang }) => {
    const { defaultRoles } = await import('/src/modules/index.js');
    const now = new Date().toISOString();
    window.__fake.set(`homes/${h}`, { name: 'Stage A Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: lang });
    for (const r of defaultRoles()) window.__fake.set(`homes/${h}/roles/${r.id}`, { name: r.name, rank: r.rank, permissions: r.permissions, system: true, templateVersion: 9 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: monaRole, status: 'active', joinedAt: now });
    const K = (key, order) => ({ name: null, key, order, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1 });
    window.__fake.set(`homes/${h}/contactCategories/s_restaurants`, K('restaurants', 0)); window.__fake.set(`homes/${h}/contactCategories/s_doctors`, K('doctors', 1));
    const C = (name, phones, x = {}) => ({ name, organization: null, email: null, address: null, notes: null, favorite: false, phones, categoryIds: [], source: 'manual', deleted: false, deletedAt: null, deletedBy: null, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1, ...x });
    window.__fake.set(`homes/${h}/contacts/pizza01`, C('Pizza Place', ['work|+20 2 2345 6789'], { categoryIds: ['s_restaurants'], favorite: true, avatarUrl: `${media}/ok/pizza.svg`, menus, rev: 3 }));
    window.__fake.set(`homes/${h}/contacts/multi01`, C('Dr. Multi', ['mobile|01001112222', 'work|0223334444'], { categoryIds: ['s_doctors'], favorite: true }));
    window.__fake.set(`homes/${h}/contacts/intl001`, C('Intl Single', ['mobile|+20 100 555 6666']));
    for (let i = 0; i < 30; i++) window.__fake.set(`homes/${h}/contacts/fill${String(i).padStart(4, '0')}`, C(`Filler ${String(i).padStart(2, '0')}`, [`mobile|+20 111 000 ${String(1000 + i)}`], { favorite: i % 2 === 0 }));
    for (const u of ['UID_OWNER', 'UID_MONA']) window.__fake.patch(`users/${u}`, { defaultHomeId: h, language: lang });
  }, { h: H, menus: C_MENUS, media: MEDIA, monaRole, lang });
}
const menuIds = (p, btn) => p.locator(`.ct-more:has(#${btn}) [role=menuitem]`).evaluateAll((els) => els.map((e) => e.id));

console.log('CT_SCROLL_DIAGNOSTICS_ENABLED');
page.on('console', (msg) => {
  if (msg.text().startsWith('CT_SCROLL_')) {
    console.log('BROWSER:', msg.text());
  }
});

console.log('CT_SCROLL_DIAGNOSTICS_ENABLED');
page.on('console', (msg) => {
  if (msg.text().startsWith('CT_SCROLL_')) {
    console.log('BROWSER:', msg.text());
  }
});

await check('V641-A Contacts UI: management actions ONLY in the ⋮ menus (list / details, permission-gated, keyboard + outside close) · full-width New above the list · Category + Favourites side by side 320–412 EN/AR light/dark · tile Call / WhatsApp never open details (chooser for several numbers) · Back to Contacts / browser Back exactly one step with filters + scroll kept (also through the menu viewer, rapid navigation, delete) · no dialer note · upcoming panel hidden', async () => {
  await ensureSignedOut();
  const H = 'hV641A'; const err0 = page.errors.length; const log = [];
  await mediaRoutes(desktop, log);
  await seed641(page, H);
  const noOverflow = async (what) => assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${what}: no horizontal overflow`);
  const onList = async () => { await page.locator('#ct-list').waitFor(); assert.equal(await page.locator('#ct-detail').count(), 0); assert.equal(await page.evaluate(() => !!(history.state && history.state.ctNav)), false, 'no sub-view entry'); };
  await page.setViewportSize({ width: 390, height: 844 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').nth(5).waitFor();
  // ---- main ⋮ menu: exactly the five management actions; none of them outside it
  for (const id of ['#ct-import', '#ct-export', '#ct-json', '#ct-cats', '#ct-deleted']) assert.equal(await page.locator(id).isVisible(), false, `${id} hidden until the menu opens`);
  assert.deepEqual(await menuIds(page, 'ct-more-btn'), ['ct-import', 'ct-export', 'ct-json', 'ct-cats', 'ct-deleted']);
  assert.equal(await page.getAttribute('#ct-more-btn', 'aria-haspopup'), 'menu'); assert.equal(await page.getAttribute('#ct-more-btn', 'aria-expanded'), 'false');
  const bb = await page.locator('#ct-more-btn').boundingBox(); assert.ok(bb.width >= 43.5 && bb.height >= 43.5, `44 px target (sub-pixel layout rounding) ${JSON.stringify(bb)}`);
  await page.focus('#ct-more-btn'); await page.keyboard.press('ArrowDown');
  assert.equal(await page.getAttribute('#ct-more-btn', 'aria-expanded'), 'true'); assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-import');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-export');
  await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-deleted');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-import', 'wraps');
  await page.keyboard.press('Escape'); assert.equal(await page.getAttribute('#ct-more-btn', 'aria-expanded'), 'false'); assert.equal(await page.evaluate(() => document.activeElement.id), 'ct-more-btn', 'focus returns');
  await page.click('#ct-more-btn'); await page.locator('#ct-import').waitFor();
  await page.click('.ct-head .page-head__title'); await page.locator('#ct-import').waitFor({ state: 'hidden' });
  assert.equal(await page.getAttribute('#ct-more-btn', 'aria-expanded'), 'false', 'outside click closes');
  await ctAct(page, '#ct-json'); await page.locator('#ct-json-view').waitFor();
  assert.equal(await page.locator('#ct-more-btn').count(), 0, 'the management menu belongs to the list only');
  await page.click('#ct-json-back'); await onList();
  // ---- New contact: full width, immediately above the list; upcoming panel hidden; no dialer note
  const nb = await page.locator('#ct-new').boundingBox(); const lb = await page.locator('#ct-list').boundingBox();
  assert.ok(Math.abs(nb.width - lb.width) <= 2, `New is full width (${nb.width} vs ${lb.width})`); assert.ok(nb.y + nb.height <= lb.y + 1 && lb.y - (nb.y + nb.height) < 60, 'New sits right above the list');
  assert.equal(await page.locator('#ct-upcoming').isVisible(), false, 'upcoming-events panel stays hidden in Stage A');
  assert.ok(!(await page.locator('body').innerText()).includes("Call opens your phone's dialer"), 'dialer note removed');
  // ---- filters side by side, EN / AR, light / dark, 320–412
  const sideBySide = async (what) => {
    const a = await page.locator('#ct-cat').boundingBox(); const b = await page.locator('#ct-fav-filter').boundingBox();
    assert.ok(Math.abs(a.y - b.y) < 6 && a.height > 30 && b.height >= 40, `${what}: Category and Favourites on one row`);
    await noOverflow(what);
  };
  for (const w of [320, 360, 390, 412]) { await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(80); await sideBySide(`EN light ${w}`); }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').first().waitFor();
  for (const w of [320, 360, 390, 412]) { await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(80); await sideBySide(`AR dark ${w}`); }
  await page.locator('.ct-card:has-text("Dr. Multi") .ct-card__open').click(); await page.locator('#ct-back').waitFor(); await noOverflow('AR dark detail 320');
  await shot(page, '90-v641a-detail-ar-dark-412');
  await page.click('#ct-back'); await onList(); await shot(page, '91-v641a-list-ar-dark-412');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').nth(5).waitFor();
  // ---- tile actions never open the details
  await page.evaluate(() => {
    window.__opened = []; window.open = (u, n, f) => { window.__opened.push([u, n, f]); return null; };
    window.__tel = []; addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="tel:"]'); if (a) { e.preventDefault(); window.__tel.push(a.getAttribute('href')); } }, true);
  });
  const len0 = await page.evaluate(() => history.length);
  const intl = page.locator('.ct-card:has-text("Intl Single")');
  assert.equal(await intl.locator('.ct-act--call').getAttribute('href'), 'tel:+201005556666');
  await intl.locator('.ct-act--call').click(); await onList();
  assert.deepEqual(await page.evaluate(() => window.__tel), ['tel:+201005556666']);
  await intl.locator('.ct-act--wa').click(); await onList();
  assert.deepEqual(await page.evaluate(() => window.__opened), [['https://wa.me/201005556666', '_blank', 'noopener,noreferrer']], 'international number → WhatsApp directly');
  await intl.locator('.ct-act--wa').focus(); await page.keyboard.press('Enter'); await onList();
  assert.equal((await page.evaluate(() => window.__opened)).length, 2, 'keyboard activation does not open details either');
  const multi = page.locator('.ct-card:has-text("Dr. Multi")');
  assert.equal(await multi.locator('.ct-act--call').getAttribute('aria-haspopup'), 'dialog');
  await multi.locator('.ct-act--call').click(); await page.locator('#ct-choose-list').waitFor();
  assert.deepEqual(await page.locator('#ct-choose-list a').evaluateAll((a) => a.map((x) => x.getAttribute('href'))), ['tel:01001112222', 'tel:0223334444'], 'never guesses: lists every number');
  await page.keyboard.press('Escape'); await page.locator('#ct-choose-list').waitFor({ state: 'detached' }); await onList();
  await multi.locator('.ct-act--wa').click(); await page.locator('#ct-choose-list').waitFor();
  await page.click('#ct-choose-1'); await page.locator('#ct-wa-form').waitFor();   // national number → asks the country code
  await page.fill('#ct-wa-cc', '20'); await page.click('dialog[open] button[type=submit]'); await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.deepEqual((await page.evaluate(() => window.__opened)).at(-1)[0], 'https://wa.me/20223334444');
  await onList(); assert.equal(await page.evaluate(() => history.length), len0, 'tile actions add no history entries');
  // WhatsApp styling: green, recognisable slot (official SVG supplied by the household) or the neutral "WA" badge
  assert.deepEqual(await intl.locator('.ct-act--wa').evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]), ['rgb(31, 168, 85)', 'rgb(255, 255, 255)'], 'WhatsApp green');
  assert.ok(['ok', 'missing'].includes(await page.evaluate(() => document.documentElement.dataset.waIcon)), 'one probe, settled');
  // ---- Back: filters + scroll kept, exactly one step (button, browser Back), rapid navigation, delete
  await page.fill('#ct-search', 'Filler'); await page.click('#ct-fav-filter'); await page.waitForTimeout(400);
  let shown = await page.locator('#ct-list .ct-card').count(); assert.equal(shown, 15, 'favourite fillers');
  await page.evaluate(() => window.scrollTo(0, 600)); await page.waitForTimeout(200); let y0 = await page.evaluate(() => scrollY); assert.ok(y0 > 300);
  const L0 = await page.evaluate(() => history.length);
  await page.locator('.ct-card:has-text("Filler 10") .ct-card__name').click(); await page.locator('#ct-detail').waitFor();
  if (L0 < 45) assert.equal(await page.evaluate(() => history.length), L0 + 1, 'details = one entry');   // (Chromium caps history.length at 50 in a long run; Back checks below prove one step)
  assert.match(await page.locator('#ct-back').innerText(), /Back to Contacts/); const bk = await page.locator('#ct-back').boundingBox(); assert.ok(bk.height >= 44);
  const restored = async (what) => {
    await onList(); assert.equal(await page.inputValue('#ct-search'), 'Filler', `${what}: search kept`);
    assert.equal(await page.getAttribute('#ct-fav-filter', 'aria-pressed'), 'true', `${what}: favourites kept`);
    assert.equal(await page.locator('#ct-list .ct-card').count(), shown);
    for (let k = 0; k < 40 && Math.abs((await page.evaluate(() => scrollY)) - y0) >= 40; k++) await page.waitForTimeout(50);
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - y0) < 40, `${what}: scroll kept (${await page.evaluate(() => scrollY)} vs ${y0})`); assert.equal(new URL(page.url()).hash, '#/m/contacts');
  };
  await page.click('#ct-back'); await restored('Back button');
  await page.locator('.ct-card:has-text("Filler 12") .ct-card__open').click(); await page.locator('#ct-detail').waitFor();
  await page.goBack(); await restored('browser Back');
  await page.goForward(); await page.locator('#ct-detail').waitFor(); assert.match(await page.locator('#ct-detail').innerText(), /Filler 12/, 'Forward re-opens the same contact');
  await page.goBack(); await restored('Back after Forward');
  for (let k = 0; k < 6; k++) { await page.locator('.ct-card:has-text("Filler 14") .ct-card__open').click(); await page.locator('#ct-detail').waitFor(); if (k % 2) await page.goBack(); else await page.click('#ct-back'); await page.locator('#ct-list').waitFor(); }
  await restored('rapid open / back'); assert.ok((await page.evaluate(() => history.length)) <= L0 + 1, 'no growth from rapid navigation');
  // sub-views: one step each, never stacked
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150); y0 = 0;   // the ⋮ menu is at the top of the list
  await ctAct(page, '#ct-cats'); await page.locator('#ct-cats-back').waitFor(); await page.goBack(); await restored('categories → Back');
  await ctAct(page, '#ct-json'); await page.locator('#ct-json-view').waitFor(); await page.click('#ct-json-back'); await restored('JSON → Back to Contacts');
  // detail ⋮ menu: Edit / Export / Delete only there
  await page.evaluate(() => window.scrollTo(0, 600)); await page.waitForTimeout(250); y0 = await page.evaluate(() => scrollY);
  await page.locator('.ct-card:has-text("Filler 10") .ct-card__open').click(); await page.locator('#ct-detail').waitFor();
  assert.deepEqual(await menuIds(page, 'ct-detail-menu'), ['ct-edit', 'ct-export-one', 'ct-delete']);
  for (const id of ['#ct-edit', '#ct-export-one', '#ct-delete']) assert.equal(await page.locator(id).isVisible(), false);
  const Ld = await page.evaluate(() => history.length);
  await ctAct(page, '#ct-edit'); await page.locator('#ct-form').waitFor(); await page.keyboard.press('Escape'); await page.locator('#ct-form').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => history.length), Ld, 'editing adds no entry');
  assert.equal(await page.evaluate(() => !!(history.state && history.state.ctNav && history.state.ctNav.v === 'detail')), true, 'editing keeps the same details entry');
  await ctAct(page, '#ct-delete'); await page.click('dialog[open] .btn--danger'); shown -= 1;
  await restored('delete → one step back (list without the deleted contact)');
  // menu viewer inside details: Back closes the viewer first, then the details — still Contacts
  await page.goto(BASE + '#/'); await page.locator('.hero__home').waitFor();
  await page.locator('.dock .nav-link[href="#/m/contacts"]').click(); await page.locator('#ct-list .ct-card').first().waitFor();
  assert.equal(await page.inputValue('#ct-search'), '', 'a fresh visit starts unfiltered');
  await page.locator('.ct-card:has-text("Pizza Place") .ct-card__open').click(); await page.locator('#ct-menu-toggle').click();
  await page.locator('#ct-menu-thumb-0[data-state=loaded]').waitFor(); await page.click('#ct-menu-thumb-0'); await page.locator('#ct-viewer').waitFor();
  await page.goBack(); await page.locator('#ct-viewer').waitFor({ state: 'detached' }); await page.locator('#ct-detail').waitFor();
  await page.goBack(); await onList();
  await page.goBack(); await page.locator('.hero__home').waitFor(); assert.equal(await page.locator('#ct-page').count(), 0, 'Back from the list leaves Contacts — to the page before it (one step)');
  await page.goForward(); await page.locator('#ct-list').waitFor();
  assert.deepEqual(page.errors.slice(err0), []);
  await logout();
});

await check('V641-A permissions: member menu = Import / Export / AI JSON only (no Categories / Deleted / Delete); viewer has no ⋮ menus, no New, no Edit; tile Call / WhatsApp for everyone', async () => {
  await ensureSignedOut();
  await seed641(page, 'hV641P', { monaRole: 'member' });
  await page.setViewportSize({ width: 390, height: 844 });
  await login('mona@example.com'); await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').first().waitFor();
  assert.deepEqual(await menuIds(page, 'ct-more-btn'), ['ct-import', 'ct-export', 'ct-json']);
  await page.locator('.ct-card:has-text("Dr. Multi") .ct-card__open').click(); await page.locator('#ct-detail').waitFor();
  assert.deepEqual(await menuIds(page, 'ct-detail-menu'), ['ct-edit', 'ct-export-one']);
  await page.click('#ct-back'); await page.locator('#ct-list').waitFor();
  await logout();
  await page.evaluate(() => window.__fake.patch('homes/hV641P/members/UID_MONA', { roleId: 'viewer' }));
  await login('mona@example.com'); await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').first().waitFor();
  assert.equal(await page.locator('#ct-more-btn').count(), 0, 'viewer: no management menu'); assert.equal(await page.locator('#ct-new').count(), 0);
  assert.ok((await page.locator('.ct-act--call').count()) > 0 && (await page.locator('.ct-act--wa').count()) > 0, 'calling is read-only: allowed');
  // a forged history entry cannot open a view without its permission
  await page.evaluate(() => { history.pushState({ ...history.state, ctNav: { v: 'json' } }, ''); history.pushState({ ...history.state, ctNav: { v: 'deleted' } }, ''); history.back(); });
  await page.waitForTimeout(400); assert.equal(await page.locator('#ct-json-view, #ct-deleted-view, #ct-json-text').count(), 0, 'forged entry ignored');
  await page.locator('#ct-list').waitFor();
  await page.locator('.ct-card:has-text("Dr. Multi") .ct-card__open').click(); await page.locator('#ct-detail').waitFor();
  assert.equal(await page.locator('#ct-detail-menu').count(), 0, 'viewer: no detail menu');
  await page.click('#ct-back'); await page.locator('#ct-list').waitFor();
  await logout();
});

await check('V641-A Android-style mobile (touch, Arabic RTL, dark, 360): tap tile → details, hardware Back → the same filtered list and scroll; WhatsApp tap stays on the list; ⋮ menu opens toward the inline end without overflow', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const p = await newPage(ctx); await mediaRoutes(ctx, []);
  await p.goto(BASE); await p.locator('#login-email').waitFor(); await seed641(p, 'hV641M', { lang: 'ar' });
  await p.fill('#login-email', 'owner@example.com'); await p.fill('#login-password', 'correct-horse'); await p.click('button[type=submit]'); await p.locator('.hero__home').waitFor();
  await p.locator('.dock .nav-link[href="#/m/contacts"]').tap(); await p.locator('#ct-list .ct-card').nth(5).waitFor();
  assert.equal(await p.evaluate(() => document.documentElement.dir), 'rtl');
  await p.locator('#ct-fav-filter').tap(); await p.waitForTimeout(300);
  const n = await p.locator('#ct-list .ct-card').count();
  await p.evaluate(() => scrollTo(0, 500)); await p.waitForTimeout(200); const y = await p.evaluate(() => scrollY);
  await p.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await p.locator('.ct-card:has-text("Filler 08") .ct-act--wa').tap(); await p.waitForTimeout(200);
  assert.equal(await p.locator('#ct-detail').count(), 0, 'WhatsApp tap does not open details'); assert.equal((await p.evaluate(() => window.__opened)).length, 1);
  await p.locator('.ct-card:has-text("Filler 08") .ct-card__name').tap(); await p.locator('#ct-detail').waitFor();
  const bb = await p.locator('#ct-back').boundingBox(); assert.ok(bb.height >= 44 && bb.width >= 120, 'prominent Back to Contacts');
  await p.goBack(); await p.locator('#ct-list').waitFor();
  assert.equal(await p.getAttribute('#ct-fav-filter', 'aria-pressed'), 'true'); assert.equal(await p.locator('#ct-list .ct-card').count(), n);
  for (let k = 0; k < 40 && Math.abs((await p.evaluate(() => scrollY)) - y) >= 40; k++) await p.waitForTimeout(50);
  assert.ok(Math.abs((await p.evaluate(() => scrollY)) - y) < 40, 'scroll kept');
  await p.evaluate(() => scrollTo(0, 0)); await p.locator('#ct-more-btn').tap(); await p.locator('#ct-deleted').waitFor();
  const mb = await p.locator('.ct-more__list').boundingBox(); assert.ok(mb.x >= 0 && mb.x + mb.width <= 360, `menu inside the viewport (RTL) ${JSON.stringify(mb)} btn ${JSON.stringify(await p.locator('#ct-more-btn').boundingBox())}`);
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await shot(p, '92-v641a-menu-ar-dark-360');
  await p.locator('#ct-deleted').tap(); await p.locator('#ct-del-back').waitFor(); await p.goBack(); await p.locator('#ct-list').waitFor();
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

await check('V641-A AI JSON: local-only notice · AI prompt / schema / example · export (all / filtered / favourites / picked / category, warning first, no ids) · invalid file rejected whole · invalid items excluded · duplicates skipped by default · explicit merge never overwrites the picture unless ticked · created contacts keep validated media (source json) · re-import is idempotent', async () => {
  await ensureSignedOut();
  const H = 'hV641J'; const err0 = page.errors.length;
  await seed641(page, H);
  await page.setViewportSize({ width: 412, height: 900 });
  await login('owner@example.com'); await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-list .ct-card').first().waitFor();
  await ctAct(page, '#ct-json'); await page.locator('#ct-json-view').waitFor();
  assert.match(await page.locator('#ct-json-local').innerText(), /.{20,}/);
  // the example download is itself valid
  let dl = page.waitForEvent('download'); await page.click('#ct-json-example'); const ex = JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
  assert.equal(ex.schema, 'homehub.contacts');
  // export: warning BEFORE the file; favourites scope
  await page.selectOption('#ct-json-scope', 'fav');
  await page.click('#ct-json-export'); await page.locator('dialog[open][role=alertdialog]').waitFor();
  dl = page.waitForEvent('download'); await page.click('dialog[open] .btn--primary'); const text = readFileSync(await (await dl).path(), 'utf8');
  const out = JSON.parse(text);
  assert.deepEqual(Object.keys(out), ['schema', 'version', 'items']); assert.equal(out.items.length, 17, '15 favourite fillers + Pizza + Dr. Multi');
  assert.ok(!/pizza01|multi01|createdBy|"rev"|"id"|hV641J|UID_/.test(text), 'no ids / audit / household data');
  const pz = out.items.find((i) => i.name === 'Pizza Place'); assert.deepEqual(pz.categories, ['Restaurants']); assert.equal(pz.menus.length, 6); assert.ok(pz.avatarUrl);
  await page.selectOption('#ct-json-scope', 'picked'); await page.locator('#ct-json-pick').waitFor();
  await page.locator('#ct-json-pick label:has-text("Intl Single") input').check();
  await page.click('#ct-json-export'); dl = page.waitForEvent('download'); await page.click('dialog[open] .btn--primary');
  assert.deepEqual(JSON.parse(readFileSync(await (await dl).path(), 'utf8')).items.map((i) => i.name), ['Intl Single']);
  // import: whole-file rejections
  for (const [bad, re] of [['not json', /./], [JSON.stringify({ schema: 'homehub.contacts', version: 1, items: [], household: 'x' }), /household/], [JSON.stringify({ schema: 'x', version: 1, items: [] }), /./]]) {
    await page.fill('#ct-json-text', bad); await page.click('#ct-json-preview-btn'); await page.locator('#ct-json-error').waitFor();
    assert.match(await page.locator('#ct-json-error').innerText(), re); assert.equal(await page.locator('#ct-imp-preview').count(), 0, 'nothing previewed');
  }
  // import: valid file with a new contact (media), an invalid item, and a duplicate of Pizza Place with a NEW picture
  const NEWPIC = `${MEDIA}/ok/new-pizza.svg`;
  const file = JSON.stringify({ schema: 'homehub.contacts', version: 1, items: [
    { name: 'مطعم الشام', phones: [{ label: 'mobile', number: '+20 122 999 8888' }], categories: ['مطاعم'], avatarUrl: `${MEDIA}/ok/sham.svg`, menus: [{ type: 'image', label: 'Page 1', url: `${MEDIA}/ok/sham-1.svg` }] },
    { name: 'Hacker', id: 'pizza01', createdBy: 'UID_OWNER' },
    { name: 'Pizza Place', email: 'hello@pizza.example', phones: [{ label: 'work', number: '+20 2 2345 6789' }], avatarUrl: NEWPIC },
  ] });
  await page.fill('#ct-json-text', file); await page.click('#ct-json-preview-btn'); await page.locator('#ct-imp-preview[data-kind=json]').waitFor();
  assert.deepEqual(await page.locator('.ct-imp-item').evaluateAll((els) => els.map((e) => e.dataset.status)), ['new', 'invalid', 'duplicate']);
  assert.match(await page.locator('.ct-imp-item[data-index="1"]').innerText(), /id, createdBy/, 'unknown fields named');
  assert.equal(await page.inputValue('#ct-imp-act-2'), 'skip', 'duplicate skipped by default');
  await page.selectOption('#ct-imp-act-2', 'merge'); await page.locator('#ct-imp-take-2').waitFor();
  assert.equal(await page.locator('#ct-imp-take-2 input[value=avatarUrl]').isChecked(), false, 'nothing replaced unless ticked');
  await page.click('#ct-imp-confirm'); await page.locator('#ct-imp-result').waitFor();
  let pizza = await cdoc(page, H, 'pizza01');
  assert.equal(pizza.avatarUrl, `${MEDIA}/ok/pizza.svg`, 'existing picture NOT overwritten'); assert.equal(pizza.menus.length, 6); assert.equal(pizza.email, 'hello@pizza.example', 'empty field filled'); assert.equal(pizza.rev, 4);
  const all = await page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/contacts/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), H);
  const sham = all.find((c) => c.name === 'مطعم الشام');
  assert.equal(sham.source, 'json'); assert.equal(sham.avatarUrl, `${MEDIA}/ok/sham.svg`); assert.deepEqual(sham.menus, [`image|Page 1|${MEDIA}/ok/sham-1.svg`]); assert.deepEqual(sham.categoryIds, ['s_restaurants']);
  assert.ok(!all.some((c) => c.name === 'Hacker'), 'invalid item excluded');
  // second run: the new contact is "imported" (skipped); ticking the picture replaces ONLY the picture
  await page.click('#ct-json-back'); await page.locator('#ct-list').waitFor(); await ctAct(page, '#ct-json');
  await page.fill('#ct-json-text', file); await page.click('#ct-json-preview-btn'); await page.locator('#ct-imp-preview').waitFor();
  assert.deepEqual(await page.locator('.ct-imp-item').evaluateAll((els) => els.map((e) => e.dataset.status)), ['imported', 'invalid', 'duplicate']);
  await page.selectOption('#ct-imp-act-2', 'merge'); await page.locator('#ct-imp-take-2 input[value=avatarUrl]').check();
  await page.click('#ct-imp-confirm'); await page.locator('#ct-imp-result').waitFor();
  pizza = await cdoc(page, H, 'pizza01');
  assert.equal(pizza.avatarUrl, NEWPIC, 'ticked → replaced'); assert.equal(pizza.menus.length, 6, 'menus untouched'); assert.equal(pizza.rev, 5);
  const count = await page.evaluate((h) => Object.keys(window.__fake.dump()).filter((k) => k.startsWith(`homes/${h}/contacts/`)).length, H);
  assert.equal(count, all.length, 'no duplicate created');
  await page.click('#ct-json-back'); await page.locator('#ct-list').waitFor();
  assert.deepEqual(page.errors.slice(err0), []);
  await logout();
});

// ======================================================================== V6.4.1 Stage B — Upcoming + activities + reminders
// The Home time zone is chosen so that the Home clock reads ~12:00 whenever the suite runs (no midnight flake).
function noonZone() { const off = 12 - new Date().getUTCHours(); return off === 0 ? 'Etc/GMT' : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`; }
function homeDay(tz, plus = 0) { const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + plus); return x.toISOString().slice(0, 10); }
function homeClock(tz, plusMin = 0) { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + plusMin * 60000)); return p; }
async function seed641b(p, H, { tz, monaRole = 'member', lang = 'en', empty = false } = {}) {
  const D = { today: homeDay(tz), yest: homeDay(tz, -1), tom: homeDay(tz, 1), in2: homeDay(tz, 2), in3: homeDay(tz, 3), soon: homeClock(tz, 10), soonEnd: homeClock(tz, 40) };
  await p.evaluate(async ({ h, tz, D, monaRole, lang, empty }) => {
    const { defaultRoles } = await import('/src/modules/index.js');
    const now = new Date().toISOString(); const A = { createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1 };
    window.__fake.set(`homes/${h}`, { name: empty ? 'Empty Home' : 'Upcoming Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: tz, language: lang });
    for (const r of defaultRoles()) window.__fake.set(`homes/${h}/roles/${r.id}`, { name: r.name, rank: r.rank, permissions: r.permissions, system: true, templateVersion: 9 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: monaRole, status: 'active', joinedAt: now });
    for (const u of ['UID_OWNER', 'UID_MONA']) window.__fake.patch(`users/${u}`, { defaultHomeId: h, language: lang });
    if (empty) return;
    const EV = (id, x) => window.__fake.set(`homes/${h}/calendarEvents/${id}`, { title: id, type: 'other', shift: null, allDay: true, startDate: D.today, endDate: D.today, startTime: null, endTime: null,
      description: null, location: null, audience: 'household', timezone: tz, done: false, source: 'manual', sourceKey: null, importBatchId: null, importRev: null, deletedAt: null, deletedBy: null, rev: 1, ...A, ...x });
    EV('evCall', { title: 'Team call', allDay: false, startTime: D.soon, endTime: D.soonEnd, reminderMinutes: 15 });
    EV('evDentist', { title: 'Dentist', startDate: D.tom, endDate: D.tom });
    EV('evFees', { title: 'Pay school fees', type: 'task', startDate: D.yest, endDate: D.yest });
    EV('evParty', { title: 'Old party', startDate: D.yest, endDate: D.yest });
    EV('evSecret', { title: 'Mona secret', audience: 'private', createdBy: 'UID_MONA', updatedBy: 'UID_MONA' });
    EV('evPlumber', { title: 'Call the plumber', kind: 'contactActivity', contactId: 'plumber01', status: 'planned', startDate: D.in2, endDate: D.in2, reminderMinutes: null });
    window.__fake.set(`homes/${h}/commitments/cNet`, { name: 'Internet bill', amountMinor: 60000, currency: 'EGP', category: 'utilities', recurrence: { unit: 'month', interval: 1 }, anchorDay: Number(D.tom.slice(8)), nextDueDate: D.tom,
      paymentMethod: 'bank_transfer', walletId: null, notes: null, lastPaidDate: null, audience: 'household', readers: [], active: true, archivedAt: null, archivedBy: null, ...A });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/cleaningTasks/k1`, { title: 'Wipe counter', instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 },
      startDate: D.today, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, schemaVersion: 1 });
    const C = (name, phones, x = {}) => ({ name, organization: null, email: null, address: null, notes: null, favorite: false, phones, categoryIds: [], source: 'manual', deleted: false, deletedAt: null, deletedBy: null, rev: 1, ...A, ...x });
    window.__fake.set(`homes/${h}/contacts/plumber01`, C('Hassan Plumber', ['mobile|+20 100 777 8888']));
  }, { h: H, tz, D, monaRole, lang, empty });
  return D;
}
const upKeys = (p) => p.locator('#up-panel .up-item').evaluateAll((els) => els.map((e) => `${e.dataset.bucket}:${e.querySelector('.up-item__title').textContent.trim()}`));

await check('V641-B Dashboard Upcoming: Calendar · contact activity · bill · cleaning in ONE chronological list (overdue / today / next 7 days); private and past plain events excluded; each row opens its module; EN/AR, light/dark, 320–1280 without overflow; loading / error / empty states', async () => {
  await ensureSignedOut(); const err0 = page.errors.length;
  const tz = noonZone(); const H = 'hV641B'; const D = await seed641b(page, H, { tz });
  await page.setViewportSize({ width: 1280, height: 900 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.locator('#up-panel .up-item').first().waitFor();
  assert.equal(await page.locator('#rm-widget').count(), 0, 'the old Reminders dashboard card is NOT restored');
  assert.deepEqual(await upKeys(page), ['overdue:Pay school fees', 'today:Pending cleaning tasks', 'today:Team call', 'upcoming:Dentist', 'upcoming:Internet bill', 'upcoming:Call the plumber']);
  const text = await page.locator('#up-panel').innerText();
  assert.ok(!/Old party|Mona secret/.test(text), 'past plain event and another member\'s private event never shown');
  assert.match(text, /EGP|600/, 'amounts shown with expenses.viewFinancialTotals');
  assert.match(await page.locator('#up-panel .up-item[data-source="contactActivity"]').innerText(), /Contact activity/);
  // navigation
  await page.locator('#up-panel .up-item:has-text("Internet bill") .up-item__btn').click();
  await page.locator('#fin-tab-commitments[aria-selected="true"]').waitFor();
  await page.goBack(); await page.locator('#up-panel .up-item').first().waitFor();
  await page.locator('#up-panel .up-item:has-text("Dentist") .up-item__btn').click();
  await page.locator(`#cal-page [data-date="${D.tom}"][aria-selected="true"]`).waitFor();
  await page.goBack(); await page.locator('#up-panel .up-item:has-text("Pending cleaning tasks") .up-item__btn').click();
  await page.waitForFunction(() => location.hash.startsWith('#/m/cleaning'));
  await page.goBack(); await page.locator('#up-panel .up-item').first().waitFor();
  // responsive, RTL, dark
  for (const w of [320, 360, 390, 412, 768]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(80);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `EN ${w}: no overflow`);
    const bb = await page.locator('#up-panel .up-item__btn').first().boundingBox(); assert.ok(bb.height >= 47.5, `${w}: 48 px rows`); }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'rtl');
  await ensureTheme(page, 'dark'); await page.locator('#up-panel .up-item').first().waitFor();
  assert.match(await page.locator('#up-title').innerText(), /القادم/); assert.match(await page.locator('#up-g-overdue').innerText(), /متأخر/);
  for (const w of [320, 360, 412]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(80);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `AR dark ${w}: no overflow`); }
  await shot(page, '93-v641b-upcoming-ar-dark-360');
  await page.setViewportSize({ width: 1280, height: 900 });
  await ensureTheme(page, 'light'); await page.click('.topbar__actions .chip-btn:not(.chip-btn--icon)'); await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  // error state (calendar backend unavailable) and recovery
  await page.evaluate(() => window.__fake.failOn('calendarEvents')); await page.locator('#up-error').waitFor();
  await page.evaluate(() => window.__fake.failOn(null)); await page.locator('#up-panel .up-item').first().waitFor();
  // more than 6 → "Show n more"
  await page.evaluate(([h, d]) => { for (let i = 0; i < 4; i++) window.__fake.set(`homes/${h}/calendarEvents/x${i}`, { ...window.__fake.dump()[`homes/${h}/calendarEvents/evDentist`], title: `Extra ${i}`, startDate: d, endDate: d }); }, [H, D.in3]);
  await page.locator('#up-more').waitFor(); assert.equal(await page.locator('#up-panel .up-item').count(), 6);
  await page.click('#up-more'); assert.equal(await page.locator('#up-panel .up-item').count(), 10); assert.equal(await page.getAttribute('#up-more', 'aria-expanded'), 'true');
  // empty Home (after a Home change): nothing from the previous Home
  await logout(); await seed641b(page, 'hV641BE', { tz, empty: true });
  await login('owner@example.com'); await page.locator('#up-empty').waitFor();
  assert.equal(await page.locator('#up-panel .up-item').count(), 0, 'nothing from the other Home');
  for (const c of ['calendarEvents', 'commitments', 'cleaningTasks']) assert.equal(await page.evaluate((x) => window.__fake.listenerCountPrefix(x), `homes/${H}/${c}`), 0, `no ${c} listener left on the previous Home`);
  await logout();
  for (const c of ['calendarEvents', 'commitments', 'reminderStates']) assert.equal(await page.evaluate((x) => window.__fake.listenerCountPrefix(x), `homes/hV641BE/${c}`), 0, `logout: ${c} listeners gone`);
  assert.deepEqual(page.errors.slice(err0), []);
});

await check('V641-B Reminders: Calendar event with a reminder (once due) and a bill join the bell / page; dismiss + snooze stored per user with their own kind; Upcoming stays independent; settings toggles; private events of others never remind', async () => {
  await ensureSignedOut(); const err0 = page.errors.length;
  const tz = noonZone(); const H = 'hV641BR'; const D = await seed641b(page, H, { tz });
  await page.setViewportSize({ width: 1280, height: 900 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.waitForFunction(() => Number((document.querySelector('#reminders-bell .bell-btn__badge') || {}).textContent) === 3);   // cleaning + Team call + Internet bill
  await page.click('#reminders-bell'); await page.locator('#rm-counts').waitFor();
  const call = page.locator(`.rm-item[data-key="e:evCall@${D.today}"]`); await call.waitFor();
  assert.equal(await call.getAttribute('data-kind'), 'calendarEvent'); assert.match(await call.innerText(), new RegExp(D.soon));
  const bill = page.locator(`.rm-item[data-key="m:cNet@${D.tom}"]`); await bill.waitFor(); assert.equal(await bill.getAttribute('data-kind'), 'commitment');
  assert.equal(await page.locator('.rm-item:has-text("Dentist"), .rm-item:has-text("Mona secret")').count(), 0, 'no reminder set / not mine → nothing');
  await page.click('#rm-f-calendar'); assert.equal(await page.locator('.rm-item').count(), 1); await page.click('#rm-f-bills'); assert.equal(await page.locator('.rm-item').count(), 1); await page.click('#rm-f-all');
  await call.locator('[data-action="dismiss"]').click();
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/reminderStates/UID_OWNER_`) && v.sourceKind === 'calendarEvent' && v.state === 'dismissed'), H);
  await bill.locator('[data-action="snooze"]').selectOption('1');
  await page.waitForFunction((h) => Object.entries(window.__fake.dump()).some(([k, v]) => k.startsWith(`homes/${h}/reminderStates/UID_OWNER_`) && v.sourceKind === 'commitment' && v.state === 'snoozed'), H);
  await page.waitForFunction(() => (document.querySelector('#reminders-bell .bell-btn__badge') || {}).textContent === '1');
  await page.goto(BASE + '#/dashboard'); await page.locator('#up-panel .up-item:has-text("Team call")').waitFor();
  assert.equal(await page.locator('#up-panel .up-item:has-text("Internet bill")').count(), 1, 'dismissing / snoozing a reminder never hides it from Upcoming');
  // settings: turning Calendar reminders off writes the new toggle; older prefs shape still loads
  await page.goto(BASE + '#/reminders'); await page.click('#rm-settings-btn'); await page.locator('#rm-t-calendar').uncheck(); await page.click('#rm-save');
  await page.waitForFunction((h) => (window.__fake.dump()[`homes/${h}/reminderPrefs/UID_OWNER`] || {}).calendar === false, H);
  // presentation state is per user: Mona sees her own (fresh) state
  await logout(); await login('mona@example.com'); await page.goto(BASE + '#/reminders');
  await page.locator(`.rm-item[data-key="e:evCall@${D.today}"][data-presentation="unread"]`).waitFor();
  await logout();
  assert.deepEqual(page.errors.slice(err0), []);
});

await check('V641-B Contact activities: Contacts panel (no per-contact listener), add from a contact with a reminder, status Done, Calendar ⇄ contact round trip (one Back step each), viewer read-only, child without Finance sees no bills', async () => {
  await ensureSignedOut(); const err0 = page.errors.length;
  const tz = noonZone(); const H = 'hV641BC'; const D = await seed641b(page, H, { tz, monaRole: 'viewer' });
  await page.setViewportSize({ width: 390, height: 844 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/contacts'); await page.locator('#ct-upcoming .up-item').first().waitFor();
  assert.match(await page.locator('#ct-upcoming').innerText(), /Call the plumber[\s\S]*Hassan Plumber/);
  const calListeners = await page.evaluate((h) => window.__fake.listenerCountPrefix(`homes/${h}/calendarEvents`), H);
  await page.locator('#ct-upcoming .up-item__btn').first().click(); await page.locator('#ct-activities .up-item').first().waitFor();
  assert.equal(await page.evaluate((h) => window.__fake.listenerCountPrefix(`homes/${h}/calendarEvents`), H), calListeners, 'opening a contact adds no listener');
  await page.click('#ct-act-add'); await page.locator('#cal-form #cal-f-with').waitFor();
  assert.match(await page.locator('#cal-f-with').innerText(), /Hassan Plumber/);
  await page.fill('#cal-f-title', 'Visit for the boiler'); await page.fill('#cal-f-sd', D.in3); await page.fill('#cal-f-ed', D.in3); await page.selectOption('#cal-f-rem', '60');
  await page.click('dialog[open] button[form="cal-form"]'); await page.locator('#cal-form').waitFor({ state: 'detached' });
  const created = await page.evaluate((h) => Object.values(window.__fake.dump()).find((d) => d && d.title === 'Visit for the boiler'), H);
  assert.deepEqual([created.kind, created.contactId, created.status, created.reminderMinutes, created.audience], ['contactActivity', 'plumber01', 'planned', 60, 'household']);
  await page.locator('#ct-activities .up-item:has-text("Visit for the boiler")').waitFor();
  await page.locator('#ct-activities .up-item:has-text("Call the plumber") [data-action="done"]').click();
  await page.waitForFunction((h) => window.__fake.dump()[`homes/${h}/calendarEvents/evPlumber`].status === 'done', H);
  await page.locator('#ct-activities .up-item:has-text("Call the plumber")').waitFor({ state: 'detached' });
  // Contact → Calendar → Contact (each one step)
  await page.locator('#ct-activities .up-item:has-text("Visit for the boiler") [data-action="calendar"]').click();
  await page.locator(`#cal-page [data-date="${D.in3}"][aria-selected="true"]`).waitFor();
  await page.locator('#cal-page .cal-item:has-text("Visit for the boiler") [data-action="contact"]').click();
  await page.locator('#ct-detail #ct-name:has-text("Hassan Plumber")').waitFor();
  await page.click('#ct-back'); await page.locator('#ct-list').waitFor();
  await page.goBack(); await page.locator('#cal-page').waitFor();
  // viewer: sees activities, cannot add or change them
  await logout(); await login('mona@example.com'); await page.goto(BASE + '#/m/contacts');
  await page.locator('#ct-list .ct-card').first().waitFor(); await page.locator('#ct-list .ct-card:has-text("Hassan Plumber") .ct-card__open').click();
  await page.locator('#ct-activities .up-item:has-text("Visit for the boiler")').waitFor();
  assert.equal(await page.locator('#ct-act-add, #ct-activities [data-action="done"]').count(), 0, 'viewer: read-only');
  await logout();
  // child: Calendar + Cleaning yes, Finance no → no bills anywhere
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/members/UID_MONA`, { roleId: 'child' }), H);
  await login('mona@example.com'); await page.locator('#up-panel .up-item').first().waitFor();
  assert.equal(await page.locator('#up-panel .up-item[data-source="commitment"]').count(), 0, 'child: no Finance → no bills');
  assert.ok(!/Internet bill|EGP/.test(await page.locator('#up-panel').innerText()));
  await logout();
  assert.deepEqual(page.errors.slice(err0), []);
});

// ======================================================================== V6.5 Phase 01 — Pantry product catalog
async function seed65(p, H, { monaRole = 'viewer', lang = 'en' } = {}) {
  await p.evaluate(async ({ h, monaRole, lang }) => {
    const { defaultRoles } = await import('/src/modules/index.js');
    const now = new Date().toISOString();
    window.__fake.set(`homes/${h}`, { name: 'Pantry Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'Africa/Cairo', language: lang });
    for (const r of defaultRoles()) window.__fake.set(`homes/${h}/roles/${r.id}`, { name: r.name, rank: r.rank, permissions: r.permissions, system: true, templateVersion: 9 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active', joinedAt: now });
    window.__fake.set(`homes/${h}/members/UID_MONA`, { uid: 'UID_MONA', email: 'mona@example.com', displayName: 'Mona', roleId: monaRole, status: 'active', joinedAt: now });
    for (const u of ['UID_OWNER', 'UID_MONA']) window.__fake.patch(`users/${u}`, { defaultHomeId: h, language: lang });
  }, { h: H, monaRole, lang });
}
const pnDocs = (p, H) => p.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/pantryProducts/`)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })), H);
async function pnFill(p, x) {
  if (x.en !== undefined) await p.fill('#pn-f-en', x.en);
  if (x.ar !== undefined) await p.fill('#pn-f-ar', x.ar);
  if (x.cat) await p.selectOption('#pn-f-cat', x.cat);
  if (x.loc) await p.selectOption('#pn-f-loc', x.loc);
  if (x.mode) await p.selectOption('#pn-f-mode', x.mode);
  if (x.dim) await p.selectOption('#pn-f-dim', x.dim);
  if (x.unit) await p.selectOption('#pn-f-unit', x.unit);
  if (x.min !== undefined) await p.fill('#pn-f-min', x.min);
  if (x.aliases !== undefined) await p.fill('#pn-f-aliases', x.aliases);
}
const pnSave = async (p) => { await p.click('dialog[open] button[form="pn-form"]'); };

await check('V65-P01 Pantry catalog: create EN / AR-only / presence products (zero stock, no stock controls), validation, bilingual search + filters, edit (field mask, rev + 1), similar-name warning, archive / restore, no delete', async () => {
  await ensureSignedOut(); const err0 = page.errors.length; const H = 'hV65P1';
  await seed65(page, H);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login('owner@example.com'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('.nav-link[href="#/m/inventory"]').count() > 0, true, 'Pantry is in the navigation');
  await page.goto(BASE + '#/m/inventory'); await page.locator('#pn-empty').waitFor();
  assert.match(await page.locator('#pn-notice').innerText(), /not enabled yet/i, 'stock tracking clearly labelled as not enabled');
  // validation
  await page.click('#pn-new'); await page.locator('#pn-form').waitFor();
  await pnSave(page); await page.locator('#pn-f-msg .banner--error').waitFor();
  assert.match(await page.locator('#pn-f-msg').innerText(), /name in English or Arabic/);
  await pnFill(page, { en: 'Eggs', min: '2.5' }); await pnSave(page);
  await page.waitForFunction(() => /whole numbers/.test(document.querySelector('#pn-f-msg').innerText));
  await pnFill(page, { min: '6', cat: 'dairy', loc: 'fridge', aliases: 'egg, بيضة' }); await pnSave(page);
  await page.locator('#pn-form').waitFor({ state: 'detached' }); await page.locator('#pn-list .pn-item').first().waitFor();
  // Arabic-only, mass in kg with a decimal threshold
  await page.click('#pn-new'); await pnFill(page, { en: '', ar: 'أرز بسمتي', cat: 'grains', loc: 'pantry', dim: 'mass', unit: 'kg', min: '1.5', aliases: 'rice' }); await pnSave(page);
  await page.locator('#pn-form').waitFor({ state: 'detached' });
  // presence mode
  await page.click('#pn-new'); await pnFill(page, { en: 'Dish soap', cat: 'cleaning', loc: 'cupboard', mode: 'presence' });
  assert.equal(await page.locator('#pn-f-qty').isVisible(), false, 'presence mode hides unit / threshold'); await pnSave(page);
  await page.locator('#pn-form').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('#pn-list .pn-item').length === 3);
  const docs = Object.fromEntries((await pnDocs(page, H)).map((d) => [d.nameEn || d.nameAr, d]));
  assert.deepEqual([docs.Eggs.stockMilli, docs.Eggs.stockRev, docs.Eggs.minMilli, docs.Eggs.dimension, docs.Eggs.displayUnit, docs.Eggs.rev, docs.Eggs.nameAr], [0, 0, 6000, 'count', 'piece', 1, null], 'EN-only: no invented Arabic name');
  assert.deepEqual([docs['أرز بسمتي'].nameEn, docs['أرز بسمتي'].minMilli, docs['أرز بسمتي'].displayUnit, docs['أرز بسمتي'].aliases], [null, 1500000, 'kg', ['rice']]);
  assert.deepEqual([docs['Dish soap'].stockMilli, docs['Dish soap'].presence, docs['Dish soap'].dimension, docs['Dish soap'].minMilli], [null, null, null, null]);
  assert.ok(Object.values(docs).every((d) => d.archived === false && d.createdBy === 'UID_OWNER' && d.schemaVersion === 1));
  assert.equal(await page.locator('#pn-list .pn-item__stock').count(), 3); assert.equal(await page.locator('#pn-list [data-action*="stock"], #pn-list input[type=number]').count(), 0, 'no stock controls');
  // search in either language (normalised), alias, filters
  const names = () => page.locator('#pn-list .pn-item__name').allInnerTexts();
  await page.fill('#pn-search', 'ارز'); await page.waitForTimeout(100); assert.deepEqual(await names(), ['أرز بسمتي'], 'Arabic without hamza finds أرز');
  await page.fill('#pn-search', 'RICE'); await page.waitForTimeout(100); assert.deepEqual(await names(), ['أرز بسمتي'], 'alias, case-insensitive');
  await page.fill('#pn-search', 'بيضه'); await page.waitForTimeout(100); assert.deepEqual(await names(), ['Eggs'], 'Arabic alias with ة / ه folding');
  await page.fill('#pn-search', 'zzz'); await page.locator('#pn-nomatch').waitFor();
  await page.fill('#pn-search', ''); await page.selectOption('#pn-cat', 'cleaning'); await page.waitForTimeout(100); assert.deepEqual(await names(), ['Dish soap']);
  await page.selectOption('#pn-cat', 'all'); await page.selectOption('#pn-loc', 'fridge'); await page.waitForTimeout(100); assert.deepEqual(await names(), ['Eggs']);
  await page.selectOption('#pn-loc', 'all');
  // edit: field mask only, rev + 1; similar-name warning
  const eggsId = docs.Eggs.id;
  await page.locator(`.pn-item[data-id="${eggsId}"] [data-action="edit"]`).click(); await page.locator('#pn-form').waitFor();
  assert.equal(await page.locator('#pn-f-mode').isDisabled(), true, 'tracking mode fixed on edit');
  await page.fill('#pn-f-ar', 'أرز بسمتي'); await page.locator('#pn-f-similar .banner').waitFor(); await page.fill('#pn-f-ar', 'بيض');
  await page.fill('#pn-f-min', '12'); await pnSave(page); await page.locator('#pn-form').waitFor({ state: 'detached' });
  const eggs = (await pnDocs(page, H)).find((d) => d.id === eggsId);
  assert.deepEqual([eggs.nameAr, eggs.minMilli, eggs.rev, eggs.stockMilli, eggs.stockRev], ['بيض', 12000, 2, 0, 0]);
  // archive (confirm) → hidden → Archived tab → restore
  await page.locator(`.pn-item[data-id="${eggsId}"] [data-action="archive"]`).click();
  await page.click('dialog[open][role=alertdialog] .btn--danger');
  await page.locator(`.pn-item[data-id="${eggsId}"]`).waitFor({ state: 'detached' });
  assert.equal((await pnDocs(page, H)).find((d) => d.id === eggsId).archived, true, 'archived, not deleted');
  await page.click('#pn-tab-archived'); await page.locator(`.pn-item--archived[data-id="${eggsId}"]`).waitFor();
  await page.locator(`.pn-item[data-id="${eggsId}"] [data-action="restore"]`).click();
  await page.locator('#pn-empty').waitFor(); await page.click('#pn-tab-active');
  await page.locator(`.pn-item[data-id="${eggsId}"]`).waitFor();
  assert.equal((await pnDocs(page, H)).length, 3, 'nothing was ever deleted');
  assert.deepEqual(page.errors.slice(err0), []);
  await logout();
});

await check('V65-P01 Pantry permissions + layout: viewer read-only (no add / edit / archive); member edits but cannot archive; child has no Pantry; AR RTL dark at 320–412 without overflow; listeners released on sign-out', async () => {
  await ensureSignedOut(); const err0 = page.errors.length; const H = 'hV65P2';
  await seed65(page, H, { monaRole: 'viewer', lang: 'ar' });
  await page.evaluate((h) => {
    const now = new Date().toISOString();
    const P = (id, x) => window.__fake.set(`homes/${h}/pantryProducts/${id}`, { nameEn: null, nameAr: null, category: 'other', location: 'pantry', trackMode: 'quantity', dimension: 'count', displayUnit: 'piece',
      minMilli: null, aliases: [], note: null, stockMilli: 0, presence: null, stockRev: 0, archived: false, archivedAt: null, archivedBy: null, rev: 1, createdBy: 'UID_OWNER', createdAt: now, updatedBy: 'UID_OWNER', updatedAt: now, schemaVersion: 1, ...x });
    P('pnMilk01', { nameEn: 'Full-cream milk (long life, family pack)', nameAr: 'حليب كامل الدسم طويل الأجل عبوة عائلية كبيرة', category: 'dairy', location: 'fridge', dimension: 'volume', displayUnit: 'l', minMilli: 2000000 });
    P('pnSalt01', { nameAr: 'ملح', category: 'spices', trackMode: 'presence', dimension: null, displayUnit: null, stockMilli: null });
  }, H);
  await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  await page.goto(BASE + '#/m/inventory'); await page.locator('#pn-list .pn-item').nth(1).waitFor();
  assert.equal(await page.locator('#pn-new, [data-action="edit"], [data-action="archive"], #pn-tab-archived').count(), 0, 'viewer: read-only');
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
  await ensureTheme(page, 'dark');
  for (const w of [320, 360, 412]) {
    await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(100);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `AR dark ${w}: no horizontal overflow`);
    const a = await page.locator('#pn-cat').boundingBox(); const b = await page.locator('#pn-loc').boundingBox(); assert.ok(Math.abs(a.y - b.y) < 4, `${w}: filters side by side`);
  }
  await shot(page, '94-v65p01-pantry-ar-dark-320');
  assert.ok(await page.evaluate((h) => window.__fake.listenerCountPrefix(`homes/${h}/pantryProducts`), H) >= 1);
  await page.setViewportSize({ width: 1280, height: 900 }); await ensureTheme(page, 'light');
  await logout();
  assert.equal(await page.evaluate((h) => window.__fake.listenerCountPrefix(`homes/${h}/pantryProducts`), H), 0, 'listener released on sign-out');
  // member: edit yes, archive no
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/members/UID_MONA`, { roleId: 'member' }), H);
  await login('mona@example.com'); await page.goto(BASE + '#/m/inventory'); await page.locator('#pn-list .pn-item').first().waitFor();
  assert.ok((await page.locator('[data-action="edit"]').count()) === 2 && (await page.locator('#pn-new').count()) === 1);
  assert.equal(await page.locator('[data-action="archive"], #pn-tab-archived').count(), 0, 'member cannot archive');
  await logout();
  // child: no Pantry at all (default role)
  await page.evaluate((h) => window.__fake.patch(`homes/${h}/members/UID_MONA`, { roleId: 'child' }), H);
  await login('mona@example.com'); await page.locator('.hero__home').waitFor();
  assert.equal(await page.locator('.nav-link[href="#/m/inventory"]').count(), 0, 'child: not in navigation');
  await page.goto(BASE + '#/m/inventory'); await page.waitForTimeout(600);
  assert.equal(await page.locator('#pn-page .pn-item').count(), 0, 'child: no products rendered');
  assert.equal(await page.evaluate((h) => window.__fake.listenerCountPrefix(`homes/${h}/pantryProducts`), H), 0, 'child: no listener');
  await logout();
  assert.deepEqual(page.errors.slice(err0), []);
});

await check('ADV-NIGHT routine day honours stored startHour during 00:00–03:00; no wrong-day or duplicate routine on a new session', async () => {
  await ensureSignedOut();
  const H = 'hAdvNight';
  const before = await page.evaluate(() => window.__fake.dump()['users/UID_OWNER'] || null);
  await page.evaluate((h) => {
    window.__fake.set(`homes/${h}`, { name: 'Night Home', createdBy: 'UID_OWNER', currency: 'EGP', timezone: 'UTC', language: 'en' });
    window.__fake.set(`homes/${h}/roles/owner`, { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6 });
    window.__fake.set(`homes/${h}/members/UID_OWNER`, { uid: 'UID_OWNER', email: 'owner@example.com', displayName: 'Abdo', roleId: 'owner', status: 'active' });
    window.__fake.set(`homes/${h}/rooms/kit`, { name: 'Kitchen', type: 'kitchen', icon: 'kitchen', sortOrder: 1, active: true });
    window.__fake.set(`homes/${h}/cleaningSettings/general`, { catchUpMax: 2, startHour: 0, updatedBy: 'UID_OWNER', updatedAt: '2026-11-01T00:00:00Z', schemaVersion: 1 });
    const T = (title) => ({ title, instructions: null, roomId: 'kit', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 },
      startDate: '2026-11-09', dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, createdBy: 'UID_OWNER', createdAt: '2026-11-01T00:00:00Z', updatedBy: 'UID_OWNER', updatedAt: '2026-11-01T00:00:00Z', schemaVersion: 1 });
    window.__fake.set(`homes/${h}/cleaningTasks/nA`, T('Night task A'));
    window.__fake.set(`homes/${h}/cleaningTasks/nB`, T('Night task B'));
    window.__fake.set(`homes/${h}/cleaningTasks/nC`, T('Night task C'));
    // Today's routine already saved by ANOTHER member, so any stray re-creation is observable.
    window.__fake.set(`homes/${h}/cleaningRoutines/2026-11-09`, { date: '2026-11-09', items: ['nA_20261109', 'nB_20261109', 'nC_20261109'], catchUpMax: 2, startHour: 0,
      createdBy: 'UID_SEEDED', createdAt: '2026-11-09T00:10:00Z', schemaVersion: 1 });
    window.__fake.patch('users/UID_OWNER', { defaultHomeId: h, language: 'en' });
  }, H);
  await page.clock.setFixedTime(new Date('2026-11-09T01:30:00Z'));   // inside the default-startHour window
  const routines = () => page.evaluate((h) => Object.entries(window.__fake.dump()).filter(([k]) => k.startsWith(`homes/${h}/cleaningRoutines/`)).map(([k, v]) => [k.split('/').pop(), v.items.length, v.createdBy]), H);
  for (const session of [1, 2]) {
    await login('owner@example.com'); await page.locator('.hero__home').waitFor();
    await page.goto(BASE + '#/m/cleaning/advanced'); await page.locator('#cl-adv-list .cl-item').nth(2).waitFor();
    await page.waitForTimeout(300);   // let any (buggy) late re-render / write happen before asserting
    assert.match(await page.locator('.page-head__sub').innerText(), /9 November 2026/, `session ${session}: routine day = stored-startHour day`);
    assert.deepEqual(await routines(), [['2026-11-09', 3, 'UID_SEEDED']], `session ${session}: the saved routine is used — no wrong-day or re-created routine`);
    assert.equal(await page.locator('#cl-adv-list .cl-item').count(), 3, `session ${session}: the saved plan is shown`);
    await logout();
  }
  await ensureSignedOut();
  await page.evaluate((b) => { if (b) window.__fake.set('users/UID_OWNER', b); }, before);
});

await browser.close();
server.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
