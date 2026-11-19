// V6.3 installed-PWA checks: manifest linkage / id / display / start_url / scope / icons, a service
// worker that never caches app code (no stranded installs), and hosting that serves all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const pngSize = (p) => { const b = readFileSync(new URL(`../../${p}`, import.meta.url)); assert.equal(b.toString('latin1', 1, 4), 'PNG', `${p} is a PNG`); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('PWA: index links the manifest, an apple-touch icon and the SW registration script', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /rel="apple-touch-icon" href="\/assets\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /<script src="src\/pwa\.js" defer><\/script>/);
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
});

test('PWA: manifest = standalone, same-origin id / start_url inside scope, installable icons', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(!('display_override' in m) || !m.display_override.includes('fullscreen'), 'never forces fullscreen');
  assert.equal(m.id, '/'); assert.equal(m.scope, '/');
  assert.ok(m.start_url.startsWith('/'), 'start_url is same-origin'); assert.ok(m.start_url.startsWith(m.scope), 'start_url inside scope');
  assert.ok(m.name && m.short_name && m.short_name.length <= 12);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i); assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  for (const need of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
    assert.ok(m.icons.some((i) => i.sizes === need[0] && i.purpose === need[1] && i.type === 'image/png'), `icon ${need}`);
  }
  for (const i of m.icons) {
    assert.ok(existsSync(new URL(`../..${i.src}`, import.meta.url)), `${i.src} exists`);
    assert.deepEqual(pngSize(i.src.slice(1)), i.sizes.split('x').map(Number), `${i.src} real size`);
  }
});

test('PWA: service worker is network-only (no cache of app code), navigation-only, root scope', () => {
  const sw = read('sw.js');
  assert.doesNotMatch(sw, /caches\.open|cache\.put|cache\.add|addAll\(/, 'never stores responses');
  assert.match(sw, /caches\.delete/, 'clears leftovers on activate');
  // V6.3.0.1: only HomeHub-owned caches are ever deleted
  assert.match(sw, /const OWN_CACHE_PREFIX = 'homehub-';/);
  assert.match(sw, /keys\.filter\(\(k\) => k\.startsWith\(OWN_CACHE_PREFIX\)\)\.map\(\(k\) => caches\.delete\(k\)\)/);
  assert.doesNotMatch(sw, /keys\.map\(\(k\) => caches\.delete/, 'never deletes every cache on the origin');
  assert.match(sw, /skipWaiting\(\)/); assert.match(sw, /clients\.claim\(\)/);
  assert.match(sw, /req\.mode !== 'navigate'/, 'only same-origin navigations are handled');
  assert.match(sw, /origin !== self\.location\.origin/);
  const reg = read('src/pwa.js');
  assert.match(reg, /register\('\/sw\.js', \{ scope: '\/' \}\)/);
  assert.match(reg, /navigator\.webdriver/);
  assert.doesNotMatch(reg + read('src/main.js'), /requestFullscreen/, 'no JS fullscreen');
});

test('PWA: hosting serves manifest / SW / icons fresh; no redirects or rewrites that leave scope', () => {
  const fb = JSON.parse(read('firebase.json')).hosting;
  const ign = fb.ignore.join(' ');
  for (const p of ['manifest', 'sw.js', 'icons', 'webmanifest']) assert.ok(!ign.includes(p), `${p} not ignored`);
  assert.ok(!fb.redirects, 'no redirects'); assert.ok(!fb.rewrites || fb.rewrites.every((r) => !r.destination || r.destination.startsWith('/')));
  const hdr = (src) => (fb.headers.find((x) => x.source === src) || { headers: [] }).headers;
  assert.ok(hdr('/sw.js').some((x) => x.key === 'Cache-Control' && x.value === 'no-cache'));
  assert.ok(hdr('/manifest.webmanifest').some((x) => x.key === 'Content-Type' && x.value === 'application/manifest+json'));
  assert.ok(fb.headers.some((x) => x.source === '**/*.@(js|css)' && x.headers.some((h) => h.value === 'no-cache')), 'app code always revalidated');
});
