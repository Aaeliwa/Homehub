/**
 * Map every "maximum of 1000 expressions" message in a Firestore-emulator test log to the rule and
 * test that produced it (Phase 5.1.3).
 *   node tools/rules-limits.mjs <emulator-output.txt> [rules=firestore.rules]
 * The rules file must be the one the log was produced with (line numbers).
 * For each hit: rules line → match path + allow statement; the test; whether that test PASSED.
 * In a passing test, a limit hit can only belong to a request the test expected to be DENIED, and
 * it means that request was denied because evaluation stopped, NOT necessarily for the intended
 * reason. Review those branches (they could mask a rule that would wrongly allow).
 */
import { readFileSync } from 'node:fs';
const [, , logPath, rulesPath = 'firestore.rules'] = process.argv;
if (!logPath) { console.error('usage: node tools/rules-limits.mjs <emulator-output.txt> [rules]'); process.exit(2); }
const log = readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
const rules = readFileSync(rulesPath, 'utf8').split('\n');

// Innermost match path + allow statement for a rules line (brace matching ignores strings/comments).
const text = rules.join('\n');
const clean = text.split('\n').map((l) => l.replace(/\/\/.*$/, (c) => ' '.repeat(c.length))).join('\n');
function blockEnd(src, open) {
  let d = 0; let q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) return i; }
  }
  return src.length;
}
const blocks = [...clean.matchAll(/match\s+(\S+)\s+\{/g)].map((m) => { const open = m.index + m[0].length - 1; return { seg: m[1], start: open, end: blockEnd(clean, open) }; });
const lineStart = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStart.push(i + 1);
function locate(line) {
  const pos = lineStart[line - 1] ?? 0;
  const path = blocks.filter((b) => b.start < pos && b.end > pos).sort((a, b) => a.start - b.start).map((b) => b.seg).join('');
  let allow = '';
  for (let i = line - 1; i >= 0; i--) { const m = /allow\s+([\w,\s]+?)\s*:/.exec(rules[i]); if (m) { allow = m[1].trim(); break; } }
  return { path: path.replace('/databases/{database}/documents', '') || '?', allow };
}

const hits = []; let pending = [];
for (const l of log) {
  for (const m of l.matchAll(/maximum of 1000 expressions to evaluate has been reached\.? for '(\w+)' @ L(\d+)/g)) pending.push({ op: m[1], line: Number(m[2]) });
  const t = /^\s*(✔|✖)\s+(.*?)\s+\(\d/.exec(l);
  if (t) { for (const p of pending) hits.push({ ...p, test: t[2], passed: t[1] === '✔' }); pending = []; }
}
const groups = new Map();
for (const h of hits) {
  const k = `${h.line}|${h.op}`;
  if (!groups.has(k)) groups.set(k, { ...h, ...locate(h.line), count: 0, tests: new Map() });
  const g = groups.get(k); g.count++; g.tests.set(h.test, h.passed);
}
console.log(`# 1000-expression limit hits: ${hits.length} in ${groups.size} rule location(s)\n`);
console.log('| Rules line | Path | allow | Op | Hits | Tests (✔ passed = request was expected to be denied) |');
console.log('|---|---|---|---|---|---|');
for (const g of [...groups.values()].sort((a, b) => b.count - a.count)) {
  console.log(`| L${g.line} | \`${g.path}\` | ${g.allow} | ${g.op} | ${g.count} | ${[...g.tests].map(([t, p]) => `${p ? '✔' : '✖'} ${t.slice(0, 70)}`).join('<br>')} |`);
}
const inFailing = hits.filter((h) => !h.passed).length;
console.log(`\nHits inside FAILING tests: ${inFailing}${inFailing ? '  ← investigate first: a limit hit may be the cause of the failure' : ''}`);
